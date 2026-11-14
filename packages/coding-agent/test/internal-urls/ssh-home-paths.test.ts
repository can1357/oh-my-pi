import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as capability from "../../src/capability";
import type { SSHHost } from "../../src/capability/ssh";
import type { CapabilityResult } from "../../src/capability/types";
import { parseInternalUrl } from "../../src/internal-urls/parse";
import { InternalUrlRouter } from "../../src/internal-urls/router";
import { SshProtocolHandler } from "../../src/internal-urls/ssh-protocol";
import { InternalUrlFilesystem } from "../../src/internal-urls/url-filesystem";
import type { SSHConnectionTarget } from "../../src/ssh/connection-manager";
import * as fileTransfer from "../../src/ssh/file-transfer";
import { fakeSshTransport } from "../helpers/fake-ssh-transport";

function mockHosts(): void {
	vi.spyOn(capability, "loadCapability").mockResolvedValue({
		items: [],
		all: [],
		warnings: [],
		providers: [],
	} as CapabilityResult<unknown>);
}

// The fake remote is the local filesystem behind a POSIX shell.
describe.skipIf(process.platform === "win32")("ssh:// remote-account HOME paths", () => {
	let fixture: string;
	let home: string;
	let host: string;
	const handler = new SshProtocolHandler();

	beforeEach(async () => {
		fixture = await fs.mkdtemp(path.join(os.tmpdir(), "ssh-home-"));
		home = path.join(fixture, "remote account's home");
		await fs.mkdir(home);
		host = `fixture-${crypto.randomUUID()}`;
		mockHosts();
		InternalUrlRouter.resetForTests();
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		InternalUrlRouter.resetForTests();
		await fs.rm(fixture, { recursive: true, force: true });
	});

	it("reads, writes and lists below the remote HOME rather than the local HOME or /~/", async () => {
		const transport = fakeSshTransport(() => home);
		await Bun.write(path.join(home, "sentinel.txt"), "remote sentinel\n");
		expect(home).not.toBe(os.homedir());

		const resource = await handler.resolve(parseInternalUrl(`ssh://${host}/~/sentinel.txt`));
		expect(resource.content).toBe("remote sentinel\n");
		expect(resource.url).toBe(`ssh://${host}/~/sentinel.txt`);
		await handler.write(parseInternalUrl(`ssh://${host}/~/new.txt`), "written remotely\n");
		expect(await Bun.file(path.join(home, "new.txt")).text()).toBe("written remotely\n");
		const directory = await handler.resolve(parseInternalUrl(`ssh://${host}/~`));
		expect(directory.isDirectory).toBe(true);
		expect(directory.content).toContain("sentinel.txt");
		expect(directory.content).toContain("new.txt");
		// Read/stat/write/list reuse one successful HOME lookup for this account.
		expect(transport.commands.filter(({ command }) => command.includes("$HOME"))).toHaveLength(1);
	});

	it("keeps percent-decoded metacharacters literal and preserves remote path traversal semantics", async () => {
		fakeSshTransport(() => home);
		const filename = "space #?% ' $(touch INJECTED);.txt";
		await Bun.write(path.join(home, filename), "literal filename\n");
		const resource = await handler.resolve(parseInternalUrl(`ssh://${host}/~/${encodeURIComponent(filename)}`));
		expect(resource.content).toBe("literal filename\n");
		expect(await Bun.file(path.join(home, "INJECTED")).exists()).toBe(false);
		await Bun.write(path.join(fixture, "parent.txt"), "parent sentinel\n");
		expect((await handler.resolve(parseInternalUrl(`ssh://${host}/~/../parent.txt`))).content).toBe(
			"parent sentinel\n",
		);
	});

	it("keeps HOME-relative parent segments on the remote host during filesystem stat and read", async () => {
		fakeSshTransport(() => home);
		await Bun.write(path.join(fixture, "parent.txt"), "remote parent\n");
		const filesystem = new InternalUrlFilesystem({ context: {}, tier: "exec" });
		const url = `ssh://${host}/~/../parent.txt`;
		expect(await filesystem.stat(url)).toMatchObject({ type: "file", size: 14 });
		expect(new TextDecoder().decode(await filesystem.readPrefix(url, 100))).toBe("remote parent\n");
	});

	it("joins root HOME without introducing a double-slash root", async () => {
		fakeSshTransport(() => "/");
		const read = vi.spyOn(fileTransfer, "readRemoteFile").mockResolvedValue({
			bytes: new TextEncoder().encode("root home\n"),
			truncated: false,
		});
		vi.spyOn(fileTransfer, "statRemotePath").mockResolvedValue("file");
		await handler.resolve(parseInternalUrl(`ssh://${host}/~/sentinel.txt`));
		expect(read.mock.calls[0]?.[1]).toBe("/sentinel.txt");
	});

	it("does not expand an encoded tilde, an encoded separator or an absolute remote path", async () => {
		const transport = fakeSshTransport(() => home);
		vi.spyOn(fileTransfer, "statRemotePath").mockResolvedValue("file");
		const read = vi.spyOn(fileTransfer, "readRemoteFile").mockResolvedValue({
			bytes: new TextEncoder().encode("literal\n"),
			truncated: false,
		});
		for (const suffix of ["/%7E/sentinel.txt", "/~%2Fsentinel.txt", `${fixture}/absolute.txt`]) {
			await handler.resolve(parseInternalUrl(`ssh://${host}${suffix}`));
		}
		expect(read.mock.calls.map(call => call[1])).toEqual([
			"/~/sentinel.txt",
			"/~/sentinel.txt",
			`${fixture}/absolute.txt`,
		]);
		expect(transport.commands).toHaveLength(0);
	});

	it("rejects named-user home expansion without running a remote command", async () => {
		const transport = fakeSshTransport(() => home);
		await expect(handler.resolve(parseInternalUrl(`ssh://${host}/~other/file`))).rejects.toThrow(/~user|named.user/i);
		await expect(handler.write(parseInternalUrl(`ssh://${host}/~other/file`), "x")).rejects.toThrow(
			/~user|named.user/i,
		);
		expect(transport.commands).toHaveLength(0);
	});

	it("separates HOME cache entries by account, host and port", async () => {
		const homes = new Map<string, string>();
		const homeFor = (target: SSHConnectionTarget) => {
			const key = `${target.username}@${target.host}:${target.port}`;
			const value = homes.get(key);
			if (!value) throw new Error(`Unexpected fixture target: ${key}`);
			return value;
		};
		const transport = fakeSshTransport(homeFor);
		for (const [index, authority] of [
			`alice@${host}`,
			`bob@${host}`,
			`alice@${host}:2222`,
			`alice@other-${host}`,
		].entries()) {
			const accountHome = path.join(fixture, `account-${index}`);
			await Bun.write(path.join(accountHome, "sentinel.txt"), `account ${index}\n`);
			const parsed = parseInternalUrl(`ssh://${authority}/~/sentinel.txt`);
			homes.set(`${parsed.username}@${parsed.hostname}:${parsed.port || "undefined"}`, accountHome);
			expect((await handler.resolve(parsed)).content).toBe(`account ${index}\n`);
		}
		expect(transport.commands.filter(({ command }) => command.includes("$HOME"))).toHaveLength(4);
	});

	it("does not reuse HOME when a configured alias changes its account or host", async () => {
		let accountHome = path.join(fixture, "first");
		const transport = fakeSshTransport(() => accountHome);
		const hosts = vi.spyOn(capability, "loadCapability");
		for (const [index, username, hostname] of [
			[0, "alice", "one"],
			[1, "bob", "one"],
			[2, "bob", "two"],
		] as const) {
			accountHome = path.join(fixture, `configured-${index}`);
			await Bun.write(path.join(accountHome, "sentinel.txt"), `configured ${index}\n`);
			const configured: SSHHost = {
				name: host,
				host: hostname,
				username,
				_source: { provider: "ssh-json", providerName: "SSH Config", path: "/tmp/ssh.json", level: "user" },
			};
			hosts.mockResolvedValue({
				items: [configured],
				all: [],
				warnings: [],
				providers: [],
			} as CapabilityResult<unknown>);
			expect((await handler.resolve(parseInternalUrl(`ssh://${host}/~/sentinel.txt`))).content).toBe(
				`configured ${index}\n`,
			);
		}
		expect(transport.commands.filter(({ command }) => command.includes("$HOME"))).toHaveLength(3);
	});

	it("never caches a failed HOME lookup and propagates transport failure", async () => {
		let remoteHome = "not-an-absolute-home";
		fakeSshTransport(() => remoteHome);
		await expect(handler.resolve(parseInternalUrl(`ssh://${host}/~/sentinel.txt`))).rejects.toThrow(/HOME/);
		remoteHome = home;
		await Bun.write(path.join(home, "sentinel.txt"), "recovered\n");
		expect((await handler.resolve(parseInternalUrl(`ssh://${host}/~/sentinel.txt`))).content).toBe("recovered\n");
	});
});
