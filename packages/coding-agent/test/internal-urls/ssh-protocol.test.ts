import { afterEach, describe, expect, it, vi } from "bun:test";
import { ptree } from "@oh-my-pi/pi-utils";
import * as capability from "../../src/capability";
import type { SSHHost } from "../../src/capability/ssh";
import type { CapabilityResult, SourceMeta } from "../../src/capability/types";
import { parseInternalUrl } from "../../src/internal-urls/parse";
import { SSH_TEXT_MAX_BYTES, SshProtocolHandler } from "../../src/internal-urls/ssh-protocol";
import * as connectionManager from "../../src/ssh/connection-manager";
import * as fileTransfer from "../../src/ssh/file-transfer";

const SOURCE: SourceMeta = {
	provider: "ssh-json",
	providerName: "SSH Config",
	path: "/test/ssh.json",
	level: "user",
};

function mockHosts(hosts: SSHHost[] = []): void {
	const result: CapabilityResult<SSHHost> = {
		items: hosts,
		all: hosts,
		warnings: [],
		providers: hosts.length ? ["ssh-json"] : [],
	};
	vi.spyOn(capability, "loadCapability").mockResolvedValue(result as CapabilityResult<unknown>);
	// Default the host-info to a POSIX transfer channel so `resolveWindowsResource`
	// short-circuits (undefined) and the classic stat/read path is exercised;
	// windows cases call mockWindowsHost() AFTER mockHosts() to override.
	vi.spyOn(connectionManager, "ensureConnection").mockResolvedValue(undefined);
	vi.spyOn(connectionManager, "ensureHostInfo").mockResolvedValue({
		version: 5,
		os: "linux",
		shell: "bash",
		transferShell: "bash",
		compatEnabled: false,
	});
}

function mockReadBytes(text: string, truncated = false) {
	vi.spyOn(fileTransfer, "statRemotePath").mockResolvedValue("file");
	return vi
		.spyOn(fileTransfer, "readRemoteFile")
		.mockResolvedValue({ bytes: new TextEncoder().encode(text), truncated });
}

/** Mock a Windows remote whose verified transfer channel is PowerShell. */
function mockWindowsHost() {
	vi.spyOn(connectionManager, "ensureConnection").mockResolvedValue(undefined);
	vi.spyOn(connectionManager, "ensureHostInfo").mockResolvedValue({
		version: 5,
		os: "windows",
		shell: "powershell",
		transferShell: "powershell",
		compatEnabled: false,
	});
}

/** Fake `ptree.spawn` returning scripted stdout bytes per call, in order. */
function mockScriptedSpawn(outputs: Uint8Array[]) {
	let call = 0;
	return vi.spyOn(ptree, "spawn").mockImplementation((() => {
		const bytes = outputs[call++] ?? outputs.at(-1) ?? new Uint8Array();
		return {
			bytes: async () => bytes,
			exitedCleanly: Promise.resolve(),
			[Symbol.dispose]: () => {},
		};
	}) as unknown as typeof ptree.spawn);
}

describe("SshProtocolHandler", () => {
	const handler = new SshProtocolHandler();

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("resolves a remote text file byte-exact with no sourcePath", async () => {
		mockHosts();
		mockReadBytes("127.0.0.1 a\n");
		const resource = await handler.resolve(parseInternalUrl("ssh://icaro/etc/hosts"));
		expect(resource.content).toBe("127.0.0.1 a\n");
		expect(resource.contentType).toBe("text/plain");
		// No sourcePath keeps search on the virtual-resource path (stays `ssh://…`).
		expect(resource.sourcePath).toBeUndefined();
	});

	it("derives contentType from the file extension", async () => {
		mockHosts();
		mockReadBytes("# title\n");
		expect((await handler.resolve(parseInternalUrl("ssh://icaro/tmp/readme.md"))).contentType).toBe("text/markdown");
		mockReadBytes("{}\n");
		expect((await handler.resolve(parseInternalUrl("ssh://icaro/tmp/data.json"))).contentType).toBe(
			"application/json",
		);
	});

	it("rejects user/port overrides on a configured host", async () => {
		mockHosts([{ _source: SOURCE, name: "icaro", host: "10.0.0.1" }]);
		mockReadBytes("x");
		await expect(handler.resolve(parseInternalUrl("ssh://user@icaro:22/x"))).rejects.toThrow(/user\/port overrides/);
	});

	it("treats an unconfigured authority as an opaque OpenSSH destination", async () => {
		mockHosts();
		const spy = mockReadBytes("data\n");
		await handler.resolve(parseInternalUrl("ssh://bob@h1:2222/x"));
		expect(spy.mock.calls[0]?.[0]).toMatchObject({ name: "bob@h1:2222", host: "h1", username: "bob", port: 2222 });
	});

	it("matches a configured reserved-char host via its percent-encoded name", async () => {
		mockHosts([{ _source: SOURCE, name: "alice@prod", host: "10.0.0.9", username: "alice" }]);
		const spy = mockReadBytes("ok\n");
		await handler.resolve(parseInternalUrl("ssh://alice%40prod/etc/hostname"));
		// Encoded `%40` authority decodes to the alias name → uses the alias's host/user.
		expect(spy.mock.calls[0]?.[0]).toMatchObject({ name: "alice@prod", host: "10.0.0.9", username: "alice" });
	});

	it("treats a literal user@host as opaque, not the encoded alias", async () => {
		mockHosts([{ _source: SOURCE, name: "alice@prod", host: "10.0.0.9", username: "alice" }]);
		const spy = mockReadBytes("ok\n");
		// Literal `@`: username=alice, bare host=prod (unconfigured) → opaque, NOT the alias's 10.0.0.9.
		await handler.resolve(parseInternalUrl("ssh://alice@prod/etc/hostname"));
		expect(spy.mock.calls[0]?.[0]).toMatchObject({ name: "alice@prod", host: "prod", username: "alice" });
	});

	it("lists the remote root directory for ssh://host/", async () => {
		mockHosts();
		vi.spyOn(fileTransfer, "readRemoteFile").mockRejectedValue(new Error("Is a directory"));
		vi.spyOn(fileTransfer, "statRemotePath").mockResolvedValue("directory");
		const listSpy = vi.spyOn(fileTransfer, "listRemoteDir").mockResolvedValue([{ name: "etc", isDirectory: true }]);
		const res = await handler.resolve(parseInternalUrl("ssh://icaro/"));
		expect(res.isDirectory).toBe(true);
		expect(res.content).toBe("etc/");
		expect(listSpy.mock.calls[0]?.[1]).toBe("/");
	});

	it("rejects a binary / non-UTF-8 file instead of returning a resource", async () => {
		mockHosts();
		vi.spyOn(fileTransfer, "statRemotePath").mockResolvedValue("file");
		vi.spyOn(fileTransfer, "readRemoteFile").mockResolvedValue({
			bytes: new Uint8Array([0x7f, 0x45, 0x4c, 0x46, 0x00, 0x01]),
			truncated: false,
		});
		await expect(handler.resolve(parseInternalUrl("ssh://icaro/bin/true"))).rejects.toThrow(
			/binary or non-UTF-8.*use `bash` with a remote SSH command or an `sshfs` mount/,
		);
	});

	it("rejects a file whose first invalid byte falls past the old 8 KiB sniff window", async () => {
		mockHosts();
		vi.spyOn(fileTransfer, "statRemotePath").mockResolvedValue("file");
		const bytes = new Uint8Array(9001);
		bytes.fill(0x61); // 9000 'a' bytes — valid UTF-8 within the former 8 KiB window
		bytes[9000] = 0xff; // lone invalid UTF-8 byte the old prefix sniff never inspected
		vi.spyOn(fileTransfer, "readRemoteFile").mockResolvedValue({ bytes, truncated: false });
		await expect(handler.resolve(parseInternalUrl("ssh://icaro/var/log/app.log"))).rejects.toThrow(
			/binary or non-UTF-8/,
		);
	});

	it("rejects a file that exceeds the size cap", async () => {
		mockHosts();
		vi.spyOn(fileTransfer, "statRemotePath").mockResolvedValue("file");
		vi.spyOn(fileTransfer, "readRemoteFile").mockResolvedValue({
			bytes: new TextEncoder().encode("partial"),
			truncated: true,
		});
		await expect(handler.resolve(parseInternalUrl("ssh://icaro/big.log"))).rejects.toThrow(/exceeds the 1 MiB limit/);
	});

	it("writes content byte-exact through writeRemoteFile", async () => {
		mockHosts();
		const spy = vi.spyOn(fileTransfer, "writeRemoteFile").mockResolvedValue(undefined);
		await handler.write(parseInternalUrl("ssh://icaro/tmp/x"), "hi\n\t!\n");
		expect(spy).toHaveBeenCalledTimes(1);
		expect(spy.mock.calls[0]?.[2]).toEqual(new TextEncoder().encode("hi\n\t!\n"));
	});

	it("lists a remote directory when the path is not a readable file", async () => {
		mockHosts();
		vi.spyOn(fileTransfer, "readRemoteFile").mockRejectedValue(
			new Error("head: error reading '/etc': Is a directory"),
		);
		vi.spyOn(fileTransfer, "statRemotePath").mockResolvedValue("directory");
		const listSpy = vi.spyOn(fileTransfer, "listRemoteDir").mockResolvedValue([
			{ name: "conf.d", isDirectory: true },
			{ name: "hosts", isDirectory: false },
		]);
		const res = await handler.resolve(parseInternalUrl("ssh://icaro/etc"));
		expect(res.isDirectory).toBe(true);
		expect(res.immutable).toBe(true);
		expect(res.sourcePath).toBeUndefined();
		expect(res.content).toBe("conf.d/\nhosts");
		// read fail → stat → list must target the same remote path, not a peeled/normalized variant.
		expect(listSpy.mock.calls[0]?.[1]).toBe("/etc");
	});

	it("renders an empty remote directory", async () => {
		mockHosts();
		vi.spyOn(fileTransfer, "readRemoteFile").mockRejectedValue(new Error("Is a directory"));
		vi.spyOn(fileTransfer, "statRemotePath").mockResolvedValue("directory");
		vi.spyOn(fileTransfer, "listRemoteDir").mockResolvedValue([]);
		const res = await handler.resolve(parseInternalUrl("ssh://icaro/empty"));
		expect(res.content).toBe("(empty directory)");
		expect(res.isDirectory).toBe(true);
	});

	it("rethrows the original read error when the path is missing, not a directory", async () => {
		mockHosts();
		vi.spyOn(fileTransfer, "readRemoteFile").mockRejectedValue(
			new Error("head: cannot open '/nope': No such file or directory"),
		);
		vi.spyOn(fileTransfer, "statRemotePath").mockResolvedValue("missing");
		await expect(handler.resolve(parseInternalUrl("ssh://icaro/nope"))).rejects.toThrow(/No such file or directory/);
	});

	it("rethrows a Windows STAT protocol error instead of degrading into the read's file content", async () => {
		mockHosts(); // unconfigured `winbox` → opaque OpenSSH target
		mockWindowsHost();
		const spawnSpy = mockScriptedSpawn([
			// Malformed STAT frame (body out of enum)…
			new TextEncoder().encode("PI_XFER_BEGIN|STAT|0\r\nflying\r\nPI_XFER_END|STAT\r\n"),
			// …followed by a perfectly valid B64 read frame — it must never be returned.
			new TextEncoder().encode(
				`PI_XFER_BEGIN|B64|c\r\n${Buffer.from("file content").toString("base64")}\r\nPI_XFER_END|B64\r\n`,
			),
		]);
		const resolved = handler.resolve(parseInternalUrl("ssh://winbox/C:/x"));
		await expect(resolved).rejects.toBeInstanceOf(fileTransfer.WindowsTransferProtocolError);
		await expect(resolved).rejects.toThrow(/Windows transfer protocol error.*STAT/s);
		// The malformed frame must not degrade into a read result: exactly one
		// spawn (the stat), never the scripted read.
		expect(spawnSpy).toHaveBeenCalledTimes(1);
	});

	it("windows hosts resolve a directory in ONE ssh spawn (merged stat+list roundtrip)", async () => {
		mockHosts(); // unconfigured `winbox` → opaque OpenSSH target
		mockWindowsHost();
		const spawnSpy = mockScriptedSpawn([
			new TextEncoder().encode(
				[
					"PI_XFER_BEGIN|LIST|2",
					Buffer.from("sub/").toString("base64"),
					Buffer.from("a.txt").toString("base64"),
					"PI_XFER_END|LIST",
					"",
				].join("\r\n"),
			),
		]);
		const resource = await handler.resolve(parseInternalUrl("ssh://winbox/C:/dir"));
		expect(resource.isDirectory).toBe(true);
		// The listing is returned by the same single spawn — no second roundtrip.
		expect(spawnSpy).toHaveBeenCalledTimes(1);
		const decoded = Buffer.from(
			String(spawnSpy.mock.calls[0]?.[0]?.at(-1)).split(" ").at(-1) ?? "",
			"base64",
		).toString("utf16le");
		expect(decoded).toContain("'C:\\dir'");
	});

	it("windows hosts resolve a file in ONE ssh spawn (merged stat+read roundtrip)", async () => {
		mockHosts();
		mockWindowsHost();
		const payload = "file bytes here";
		const spawnSpy = mockScriptedSpawn([
			new TextEncoder().encode(
				`PI_XFER_BEGIN|B64|${payload.length.toString(16)}\r\n${Buffer.from(payload).toString("base64")}\r\nPI_XFER_END|B64\r\n`,
			),
		]);
		const resource = await handler.resolve(parseInternalUrl("ssh://winbox/C:/dir/a.txt"));
		expect(resource.content).toBe(payload);
		expect(spawnSpy).toHaveBeenCalledTimes(1);
	});

	it("windows merged roundtrip reports a missing path without a second spawn", async () => {
		mockHosts();
		mockWindowsHost();
		const spawnSpy = mockScriptedSpawn([
			new TextEncoder().encode("PI_XFER_BEGIN|STAT|0\r\nmissing\r\nPI_XFER_END|STAT\r\n"),
		]);
		await expect(handler.resolve(parseInternalUrl("ssh://winbox/C:/nope"))).rejects.toThrow(/No such file|missing/i);
		expect(spawnSpy).toHaveBeenCalledTimes(1);
	});

	it("windows merged roundtrip rejects an over-limit file with the 1 MiB error", async () => {
		mockHosts();
		mockWindowsHost();
		// 1 MiB + 1 bytes: the script's read window (maxBytes + 1) detects it.
		const big = Buffer.alloc(SSH_TEXT_MAX_BYTES + 1, 0x61);
		mockScriptedSpawn([
			new TextEncoder().encode(
				`PI_XFER_BEGIN|B64|${big.length.toString(16)}\r\n${big.toString("base64")}\r\nPI_XFER_END|B64\r\n`,
			),
		]);
		await expect(handler.resolve(parseInternalUrl("ssh://winbox/C:/big.txt"))).rejects.toThrow(
			/exceeds the 1 MiB limit/,
		);
	});

	it("windows merged roundtrip rejects a STAT frame claiming file/directory (frame corruption)", async () => {
		mockHosts();
		mockWindowsHost();
		mockScriptedSpawn([new TextEncoder().encode("PI_XFER_BEGIN|STAT|0\r\nfile\r\nPI_XFER_END|STAT\r\n")]);
		await expect(handler.resolve(parseInternalUrl("ssh://winbox/C:/x"))).rejects.toThrow(
			/protocol error.*STAT frame reports file/is,
		);
	});

	it("a cached POSIX host skips the merged Windows resolver entirely", async () => {
		// The merged attempt is gated on cached host info: a known-POSIX host
		// must not pay an extra resolveTransfer/ensureConnection roundtrip
		// (an extra `ssh -O check` spawn on ControlMaster-capable clients)
		// just to learn the resolver would return undefined.
		mockHosts();
		vi.spyOn(connectionManager, "getCachedHostInfoSync").mockReturnValue({
			version: 5,
			os: "linux",
			shell: "bash",
			transferShell: "bash",
			compatEnabled: false,
		});
		const mergedSpy = vi.spyOn(fileTransfer, "resolveWindowsResource").mockResolvedValue(undefined);
		mockReadBytes("posix bytes\n");
		const resource = await handler.resolve(parseInternalUrl("ssh://icaro/etc/hosts"));
		expect(resource.content).toBe("posix bytes\n");
		expect(mergedSpy).not.toHaveBeenCalled();
	});

	it("falls through a transport stat failure so the read surfaces its remote stderr", async () => {
		mockHosts();
		vi.spyOn(fileTransfer, "statRemotePath").mockRejectedValue(new Error("ssh: connect to host icaro: timed out"));
		const readSpy = vi
			.spyOn(fileTransfer, "readRemoteFile")
			.mockRejectedValue(new Error("head: cannot open '/x': No such file or directory"));
		await expect(handler.resolve(parseInternalUrl("ssh://icaro/x"))).rejects.toThrow(/No such file or directory/);
		expect(readSpy).toHaveBeenCalledTimes(1);
	});

	it("rejects a remote special file (FIFO/device) without reading it", async () => {
		mockHosts();
		vi.spyOn(fileTransfer, "statRemotePath").mockResolvedValue("other");
		const readSpy = vi
			.spyOn(fileTransfer, "readRemoteFile")
			.mockResolvedValue({ bytes: new Uint8Array(), truncated: false });
		await expect(handler.resolve(parseInternalUrl("ssh://icaro/dev/zero"))).rejects.toThrow(
			/not a regular file.*use `bash` with a remote SSH command/,
		);
		expect(readSpy).not.toHaveBeenCalled();
	});

	it("autocompletes configured hosts and threads cwd to the capability load", async () => {
		const spy = vi.spyOn(capability, "loadCapability").mockResolvedValue({
			items: [
				{ name: "web1", host: "10.0.0.1", username: "deploy", _source: SOURCE },
				{ name: "db", host: "db.internal", _source: SOURCE },
			],
			all: [],
			warnings: [],
			providers: [],
		} as CapabilityResult<SSHHost>);
		const candidates = await handler.complete("", { cwd: "/tmp/proj" });
		expect(candidates.map(c => c.value).sort()).toEqual(["db", "web1"]);
		expect(candidates.find(c => c.value === "web1")?.description).toContain("deploy@10.0.0.1");
		expect(spy.mock.calls[0]?.[1]).toEqual({ cwd: "/tmp/proj" });
	});

	it("lists configured hosts for a bare ssh:// read using the context cwd", async () => {
		const spy = vi.spyOn(capability, "loadCapability").mockResolvedValue({
			items: [{ name: "web1", host: "10.0.0.1", _source: SOURCE }],
			all: [],
			warnings: [],
			providers: [],
		} as CapabilityResult<SSHHost>);
		const res = await handler.resolve(parseInternalUrl("ssh://"), { cwd: "/tmp/proj" });
		expect(res.immutable).toBe(true);
		expect(res.sourcePath).toBeUndefined();
		expect(res.content).toContain("[web1](ssh://web1/)");
		expect(spy.mock.calls[0]?.[1]).toEqual({ cwd: "/tmp/proj" });
	});

	it("shows a helpful message when no hosts are configured", async () => {
		mockHosts([]);
		const res = await handler.resolve(parseInternalUrl("ssh://"));
		expect(res.content).toMatch(/No SSH hosts are configured/);
	});

	it("rejects a host-less ssh:// URL that carries a path", async () => {
		mockHosts();
		await expect(handler.resolve(parseInternalUrl("ssh:///etc/hosts"))).rejects.toThrow(/requires a host/);
	});

	it("rejects an explicit ssh:// port 0 before connecting", async () => {
		mockHosts();
		await expect(handler.resolve(parseInternalUrl("ssh://icaro:0/etc/hostname"))).rejects.toThrow(/port 0/);
	});

	it("strips IPv6 URL brackets before building the ssh target", async () => {
		mockHosts();
		const spy = mockReadBytes("ok\n");
		await handler.resolve(parseInternalUrl("ssh://[::1]/etc/hostname"));
		expect(spy.mock.calls[0]?.[0]?.host).toBe("::1");
	});

	it("matches a configured bracketed-colon alias instead of stripping it as IPv6", async () => {
		mockHosts([{ name: "[prod:2222]", host: "prod.internal", _source: SOURCE }]);
		const spy = mockReadBytes("ok\n");
		await handler.resolve(parseInternalUrl("ssh://%5Bprod%3A2222%5D/etc/hostname"));
		expect(spy.mock.calls[0]?.[0]?.host).toBe("prod.internal");
	});

	it("rejects a malformed or out-of-range ssh:// port before connecting", async () => {
		mockHosts();
		await expect(handler.resolve(parseInternalUrl("ssh://prod:abc/etc"))).rejects.toThrow(/invalid host or port/);
		await expect(handler.resolve(parseInternalUrl("ssh://prod:65536/etc"))).rejects.toThrow(/invalid host or port/);
	});

	it("rejects an empty ssh:// port before connecting", async () => {
		mockHosts();
		await expect(handler.resolve(parseInternalUrl("ssh://prod:/etc/hosts"))).rejects.toThrow(/empty port/);
		await expect(handler.resolve(parseInternalUrl("ssh://user@prod:/etc/hosts"))).rejects.toThrow(/empty port/);
		await expect(handler.resolve(parseInternalUrl("ssh://[::1]:/etc/hosts"))).rejects.toThrow(/empty port/);
		await expect(handler.resolve(parseInternalUrl("ssh://prod%2Dblue:/etc/hosts"))).rejects.toThrow(/empty port/);
		await expect(handler.resolve(parseInternalUrl("ssh://u%2Dname@prod:/etc/hosts"))).rejects.toThrow(/empty port/);
	});

	it("rejects ssh:// password and empty-username userinfo before matching a host", async () => {
		mockHosts([{ name: "prod", host: "10.0.0.5", _source: SOURCE }]);
		await expect(handler.resolve(parseInternalUrl("ssh://user:pass@prod/etc/hosts"))).rejects.toThrow(/password/);
		await expect(handler.resolve(parseInternalUrl("ssh://:pw@prod/etc/hosts"))).rejects.toThrow(/password/);
		await expect(handler.resolve(parseInternalUrl("ssh://@prod/etc/hosts"))).rejects.toThrow(/empty username/);
		await expect(handler.resolve(parseInternalUrl("ssh://@prod:22/etc/hosts"))).rejects.toThrow(/empty username/);
		await expect(handler.resolve(parseInternalUrl("ssh://user:@prod/etc/hosts"))).rejects.toThrow(
			/malformed authority/,
		);
		await expect(handler.resolve(parseInternalUrl("ssh://:@prod/etc/hosts"))).rejects.toThrow(/malformed authority/);
		await expect(handler.resolve(parseInternalUrl("ssh://prod%ZZ/etc/hosts"))).rejects.toThrow(/percent-escape/i);
		await expect(handler.resolve(parseInternalUrl("ssh://user%ZZ@prod/etc/hosts"))).rejects.toThrow(
			/percent-escape/i,
		);
	});

	it("matches a configured colon-suffixed alias via %3A instead of treating it as an empty port", async () => {
		mockHosts([{ name: "prod:", host: "prod.internal", _source: SOURCE }]);
		const spy = mockReadBytes("ok\n");
		await handler.resolve(parseInternalUrl("ssh://prod%3A/etc/hostname"));
		expect(spy.mock.calls[0]?.[0]?.host).toBe("prod.internal");
	});

	it("decodes the percent-encoded username and host of an override target", async () => {
		mockHosts();
		const spy = mockReadBytes("ok\n");
		await handler.resolve(parseInternalUrl("ssh://user%40corp@prod%2Dblue/etc/hostname"));
		const target = spy.mock.calls[0]?.[0];
		expect(target?.username).toBe("user@corp");
		expect(target?.host).toBe("prod-blue");
		expect(target?.name).toBe("user@corp@prod-blue");
	});

	it("rejects a user/port override on an encoded configured alias", async () => {
		mockHosts([{ name: "alice@prod", host: "alice.prod.internal", _source: SOURCE }]);
		await expect(handler.resolve(parseInternalUrl("ssh://bob@alice%40prod/tmp/x"))).rejects.toThrow(
			/user\/port overrides/,
		);
		await expect(handler.resolve(parseInternalUrl("ssh://alice%40prod:22/tmp/x"))).rejects.toThrow(
			/user\/port overrides/,
		);
	});

	it("skips the remote directory listing when skipDirectoryListing is set", async () => {
		mockHosts();
		vi.spyOn(fileTransfer, "readRemoteFile").mockRejectedValue(new Error("Is a directory"));
		vi.spyOn(fileTransfer, "statRemotePath").mockResolvedValue("directory");
		const listSpy = vi.spyOn(fileTransfer, "listRemoteDir").mockResolvedValue([]);

		const res = await handler.resolve(parseInternalUrl("ssh://h/etc"), { skipDirectoryListing: true });
		expect(res.isDirectory).toBe(true);
		expect(listSpy).not.toHaveBeenCalled();

		await handler.resolve(parseInternalUrl("ssh://h/etc"));
		expect(listSpy).toHaveBeenCalledTimes(1);
	});

	it("rejects ssh:// URL queries and fragments instead of operating on the truncated path", async () => {
		mockHosts();
		// `?`/`#` are URL delimiters, so the query/fragment is stripped from the path;
		// `ssh://h/tmp/a?draft` would otherwise read/write `/tmp/a`, the wrong file.
		await expect(handler.resolve(parseInternalUrl("ssh://h/tmp/a?draft"))).rejects.toThrow(/quer/i);
		await expect(handler.resolve(parseInternalUrl("ssh://h/tmp/a#draft"))).rejects.toThrow(/fragment/i);
		// A literal `?` in a filename must be percent-encoded (`%3F`) and is then accepted.
		const spy = mockReadBytes("ok\n");
		await handler.resolve(parseInternalUrl("ssh://h/tmp/a%3Fdraft"));
		expect(spy.mock.calls[0]?.[1]).toBe("/tmp/a?draft");
	});
});
