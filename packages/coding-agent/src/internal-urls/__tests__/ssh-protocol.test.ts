import { afterEach, describe, expect, it, vi } from "bun:test";
import * as capability from "../../capability";
import type { SSHHost } from "../../capability/ssh";
import type { CapabilityResult, SourceMeta } from "../../capability/types";
import * as fileTransfer from "../../ssh/file-transfer";
import { parseInternalUrl } from "../parse";
import { SshProtocolHandler } from "../ssh-protocol";

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
}

function mockReadBytes(text: string, truncated = false) {
	vi.spyOn(fileTransfer, "statRemotePath").mockResolvedValue("file");
	return vi
		.spyOn(fileTransfer, "readRemoteFile")
		.mockResolvedValue({ bytes: new TextEncoder().encode(text), truncated });
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
		await expect(handler.resolve(parseInternalUrl("ssh://icaro/bin/true"))).rejects.toThrow(/binary or non-UTF-8/);
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

	it("rejects a remote special file (FIFO/device) without reading it", async () => {
		mockHosts();
		vi.spyOn(fileTransfer, "statRemotePath").mockResolvedValue("other");
		const readSpy = vi
			.spyOn(fileTransfer, "readRemoteFile")
			.mockResolvedValue({ bytes: new Uint8Array(), truncated: false });
		await expect(handler.resolve(parseInternalUrl("ssh://icaro/dev/zero"))).rejects.toThrow(/not a regular file/);
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
