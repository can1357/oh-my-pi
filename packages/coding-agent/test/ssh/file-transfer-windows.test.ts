import { afterEach, describe, expect, it, vi } from "bun:test";
import { ptree } from "@oh-my-pi/pi-utils";
import type { SSHConnectionTarget } from "../../src/ssh/connection-manager";
import * as connectionManager from "../../src/ssh/connection-manager";
import {
	buildWindowsReadScript,
	listRemoteDir,
	normalizeWindowsRemotePath,
	readRemoteFile,
	statRemotePath,
	writeRemoteFile,
} from "../../src/ssh/file-transfer";

const target: SSHConnectionTarget = { name: "winbox", host: "winbox" };

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

interface SpawnRecord {
	argv: string[];
	stdin?: Uint8Array;
}

/** Fake `ptree.spawn`: records argv/stdin, returns scripted stdout bytes. */
function mockSshSpawn(stdout: (record: SpawnRecord) => Uint8Array) {
	const records: SpawnRecord[] = [];
	vi.spyOn(ptree, "spawn").mockImplementation(((argv: string[], opts?: { stdin?: Uint8Array }) => {
		const record = { argv, stdin: opts?.stdin };
		records.push(record);
		const bytes = stdout(record);
		return {
			bytes: async () => bytes,
			exitedCleanly: Promise.resolve(),
			[Symbol.dispose]: () => {},
		};
	}) as unknown as typeof ptree.spawn);
	return records;
}

function decodeScript(command: string): string {
	const b64 = command.split(" ").at(-1) ?? "";
	return Buffer.from(b64, "base64").toString("utf16le");
}

describe("normalizeWindowsRemotePath", () => {
	it("strips the leading slash before a drive letter and flips separators", () => {
		expect(normalizeWindowsRemotePath("/C:/x/y.txt")).toBe("C:\\x\\y.txt");
	});
	it("accepts a bare drive path", () => {
		expect(normalizeWindowsRemotePath("C:/x")).toBe("C:\\x");
	});
	it("maps a double-slash authority to a UNC path", () => {
		expect(normalizeWindowsRemotePath("//server/share/dir")).toBe("\\\\server\\share\\dir");
	});
	it("rejects a UNC authority with an empty share segment", () => {
		expect(() => normalizeWindowsRemotePath("//server/")).toThrow(/drive path.*UNC/s);
	});
	it("rejects a UNC path with an empty share segment before more separators", () => {
		expect(() => normalizeWindowsRemotePath("//server//path")).toThrow(/drive path.*UNC/s);
	});
	it("rejects forms with neither drive nor UNC root", async () => {
		expect(() => normalizeWindowsRemotePath("/tmp/no-drive")).toThrow(/drive path.*UNC/s);
	});
	it("rejects an alternate data stream on a drive path", () => {
		expect(() => normalizeWindowsRemotePath("/C:/file.txt:stream")).toThrow(/alternate data stream/s);
	});
	it("rejects a colon in a UNC component", () => {
		expect(() => normalizeWindowsRemotePath("//server/share/f:s")).toThrow(/alternate data stream/s);
	});
	it("rejects Win32 device-namespace authorities and the pipe share", () => {
		expect(() => normalizeWindowsRemotePath("//./pipe/foo")).toThrow(/device-namespace/s);
		expect(() => normalizeWindowsRemotePath("//?/GLOBALROOT/x")).toThrow(/device-namespace/s);
		// Named-pipe UNC syntax: `pipe` is the share under a real server.
		expect(() => normalizeWindowsRemotePath("//localhost/pipe/foo")).toThrow(/device-namespace/s);
		expect(() => normalizeWindowsRemotePath("//server/pipe/foo")).toThrow(/device-namespace/s);
	});
});

describe("windows transfer dispatch", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("reads through the powershell channel: validates the frame and decodes byte-exact", async () => {
		mockWindowsHost();
		const payload = new Uint8Array([0, 1, 255, 10, 13, 65]);
		const records = mockSshSpawn(() =>
			new TextEncoder().encode(
				`PI_XFER_BEGIN|B64|6\r\n${Buffer.from(payload).toString("base64")}\r\nPI_XFER_END|B64\r\n`,
			),
		);
		const result = await readRemoteFile(target, "/C:/dir file/bin.dat", { maxBytes: 1024 });
		expect(Buffer.from(result.bytes).equals(Buffer.from(payload))).toBe(true);
		expect(result.truncated).toBe(false);
		const command = records[0].argv.at(-1) ?? "";
		expect(command.startsWith("powershell -NoProfile -NonInteractive -EncodedCommand ")).toBe(true);
		// Wire contract: the remote receives the normalized literal path.
		expect(decodeScript(command)).toContain("'C:\\dir file\\bin.dat'");
	});

	it("writes base64 on stdin and targets the normalized destination", async () => {
		mockWindowsHost();
		const content = new Uint8Array([1, 2, 3, 254]);
		const records = mockSshSpawn(() => new Uint8Array(0));
		await writeRemoteFile(target, "/C:/out dir/f.txt", content, {});
		const command = records[0].argv.at(-1) ?? "";
		expect(decodeScript(command)).toContain("'C:\\out dir\\f.txt'");
		// stdin carries the base64 text the remote script decodes.
		const stdinText = new TextDecoder().decode(records[0].stdin ?? new Uint8Array(0));
		expect(Buffer.from(stdinText, "base64").equals(Buffer.from(content))).toBe(true);
	});

	it("maps framed stat output and lists framed entries dirs-first with non-ASCII names", async () => {
		mockWindowsHost();
		mockSshSpawn(() => new TextEncoder().encode("PI_XFER_BEGIN|STAT|0\r\ndirectory\r\nPI_XFER_END|STAT\r\n"));
		await expect(statRemotePath(target, "/C:/x")).resolves.toBe("directory");
		vi.restoreAllMocks();

		mockWindowsHost();
		const b64 = (s: string) => Buffer.from(s).toString("base64");
		mockSshSpawn(() =>
			new TextEncoder().encode(
				[
					"PI_XFER_BEGIN|LIST|4",
					b64("b.txt"),
					b64("sub/"),
					b64("中文.txt"),
					b64(".hidden"),
					"PI_XFER_END|LIST",
					"",
				].join("\r\n"),
			),
		);
		const entries = await listRemoteDir(target, "/C:/x");
		// Order contract: dirs first, then by name through the same
		// ambient-locale comparator the implementation mirrors from
		// buildDirectoryResource — derive the expectation with it so the
		// assertion holds under any host collation (zh-CN sorts CJK before
		// Latin, en after).
		const expected = ["sub/", ".hidden", "b.txt", "中文.txt"]
			.map(s => ({ name: s.replace(/\/$/, ""), isDirectory: s.endsWith("/") }))
			.sort((a, b) => Number(b.isDirectory) - Number(a.isDirectory) || a.name.localeCompare(b.name))
			.map(e => `${e.name}${e.isDirectory ? "/" : ""}`);
		expect(entries.map(e => `${e.name}${e.isDirectory ? "/" : ""}`)).toEqual(expected);
	});

	it("refuses a windows host with no powershell transferShell", async () => {
		vi.spyOn(connectionManager, "ensureConnection").mockResolvedValue(undefined);
		vi.spyOn(connectionManager, "ensureHostInfo").mockResolvedValue({
			version: 5,
			os: "windows",
			shell: "cmd",
			compatEnabled: false,
		});
		await expect(readRemoteFile(target, "/C:/x", { maxBytes: 16 })).rejects.toThrow(
			/Windows host.*powershell\/pwsh.*remote SSH command/s,
		);
	});
	it("refuses a non-windows host whose cached transferShell was hand-corrupted to powershell", async () => {
		vi.spyOn(connectionManager, "ensureConnection").mockResolvedValue(undefined);
		vi.spyOn(connectionManager, "ensureHostInfo").mockResolvedValue({
			version: 5,
			os: "linux",
			shell: "bash",
			transferShell: "powershell",
			compatEnabled: false,
		});
		// Probing never records a Windows shell for a non-Windows host, so this
		// state only arises from a hand-corrupted cache — still no verified
		// POSIX shell, and never a powershell channel on a non-Windows os.
		await expect(readRemoteFile(target, "/tmp/x", { maxBytes: 16 })).rejects.toThrow(/no verified POSIX shell/);
	});

	it("writes through the file-symlink replace path: dispatch succeeds and the script replaces the link deterministically", async () => {
		mockWindowsHost();
		const records = mockSshSpawn(() => new Uint8Array(0));
		await writeRemoteFile(target, "/C:/out dir/link.bin", new Uint8Array([9, 9, 9]), {});
		const script = decodeScript(records[0].argv.at(-1) ?? "");
		// Commit contract (spec 3a15ffff62): the reparse-point branch is
		// examined FIRST — a junction/directory-symlink is refused there like
		// POSIX `-d` — and a non-directory reparse point (file symlink or
		// dangling link) is replaced deterministically: Remove-Item the link
		// itself, THEN Move-Item, so the write can never land through the link
		// target. Ordering assertions pin the branch set; the awaited call
		// above proves the dispatch still completes end-to-end.
		const reparseIdx = script.indexOf("ReparsePoint");
		const refuseIdx = script.indexOf("ssh://: destination is a directory");
		const removeIdx = script.indexOf("Remove-Item -LiteralPath $d -Force");
		const moveIdx = script.indexOf("Move-Item -LiteralPath $t -Destination $d -Force");
		expect(reparseIdx).toBeGreaterThan(-1);
		expect(reparseIdx).toBeLessThan(refuseIdx);
		expect(removeIdx).toBeGreaterThan(-1);
		expect(removeIdx).toBeLessThan(moveIdx);
	});
});

describe("windows transfer frame validation (malformed third-party output)", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("rejects read output with no frame at all (marker-scanning is gone)", async () => {
		mockWindowsHost();
		const payload = new Uint8Array([1, 2, 3]);
		mockSshSpawn(() => new TextEncoder().encode(`${Buffer.from(payload).toString("base64")}\r\n`));
		await expect(readRemoteFile(target, "/C:/x", { maxBytes: 16 })).rejects.toThrow(/protocol|frame/is);
	});

	it("rejects read output with a truncated frame (missing END)", async () => {
		mockWindowsHost();
		mockSshSpawn(() => new TextEncoder().encode("PI_XFER_BEGIN|B64|3\r\nAAAA\r\n"));
		await expect(readRemoteFile(target, "/C:/x", { maxBytes: 16 })).rejects.toThrow(/protocol.*END/is);
	});

	it("rejects read output whose base64 body is not strict base64", async () => {
		mockWindowsHost();
		mockSshSpawn(() => new TextEncoder().encode("PI_XFER_BEGIN|B64|3\r\nAA!A\r\nPI_XFER_END|B64\r\n"));
		await expect(readRemoteFile(target, "/C:/x", { maxBytes: 16 })).rejects.toThrow(/protocol.*base64/is);
	});

	it("rejects read output whose header byte count disagrees with the payload", async () => {
		mockWindowsHost();
		mockSshSpawn(() => new TextEncoder().encode("PI_XFER_BEGIN|B64|9\r\nAAAA\r\nPI_XFER_END|B64\r\n"));
		await expect(readRemoteFile(target, "/C:/x", { maxBytes: 16 })).rejects.toThrow(/protocol.*header/is);
	});

	it("rejects stat output with an out-of-enum body instead of mapping it to missing", async () => {
		mockWindowsHost();
		mockSshSpawn(() => new TextEncoder().encode("PI_XFER_BEGIN|STAT|0\r\nflying\r\nPI_XFER_END|STAT\r\n"));
		await expect(statRemotePath(target, "/C:/x")).rejects.toThrow(/protocol.*STAT/is);
	});

	it("rejects a listing whose header count disagrees with the body line count", async () => {
		mockWindowsHost();
		mockSshSpawn(() => new TextEncoder().encode("PI_XFER_BEGIN|LIST|2\r\nQUFBQQ==\r\nPI_XFER_END|LIST\r\n"));
		await expect(listRemoteDir(target, "/C:/x")).rejects.toThrow(/protocol.*LIST/is);
	});
	it("rejects a listing entry that is valid strict base64 but not valid UTF-8", async () => {
		mockWindowsHost();
		// `/w==` passes STRICT_B64_RE and decodes to the single byte 0xff —
		// invalid UTF-8 that a lenient decoder would silently turn into U+FFFD.
		mockSshSpawn(() => new TextEncoder().encode("PI_XFER_BEGIN|LIST|1\r\n/w==\r\nPI_XFER_END|LIST\r\n"));
		await expect(listRemoteDir(target, "/C:/x")).rejects.toThrow(/protocol.*UTF-8/is);
	});

	it("ignores banner noise outside the frame but still validates the frame itself", async () => {
		mockWindowsHost();
		const payload = new Uint8Array([9, 8, 7]);
		mockSshSpawn(() =>
			new TextEncoder().encode(
				`Welcome to WinSSH 9.9\r\nPI_XFER_BEGIN|B64|3\r\n${Buffer.from(payload).toString("base64")}\r\nPI_XFER_END|B64\r\nbye\r\n`,
			),
		);
		const result = await readRemoteFile(target, "/C:/x", { maxBytes: 16 });
		expect(Buffer.from(result.bytes).equals(Buffer.from(payload))).toBe(true);
	});
	it("rejects a stray PI_XFER_BEGIN after the frame instead of treating it as banner noise", async () => {
		mockWindowsHost();
		const payload = new Uint8Array([4, 5, 6]);
		mockSshSpawn(() =>
			new TextEncoder().encode(
				`PI_XFER_BEGIN|B64|3\r\n${Buffer.from(payload).toString("base64")}\r\nPI_XFER_END|B64\r\nPI_XFER_BEGIN|B64|3\r\n`,
			),
		);
		await expect(readRemoteFile(target, "/C:/x", { maxBytes: 16 })).rejects.toThrow(/protocol.*stray/is);
	});

	it("rejects a BEGIN header with junk after the hex count", async () => {
		mockWindowsHost();
		mockSshSpawn(() => new TextEncoder().encode("PI_XFER_BEGIN|B64|3junk\r\nAAAA\r\nPI_XFER_END|B64\r\n"));
		await expect(readRemoteFile(target, "/C:/x", { maxBytes: 16 })).rejects.toThrow(/protocol.*BEGIN/is);
	});

	it("rejects a BEGIN header with an extra pipe field", async () => {
		mockWindowsHost();
		mockSshSpawn(() => new TextEncoder().encode("PI_XFER_BEGIN|LIST|1|extra\r\nQUFBQQ==\r\nPI_XFER_END|LIST\r\n"));
		await expect(listRemoteDir(target, "/C:/x")).rejects.toThrow(/protocol.*BEGIN/is);
	});
});

describe("buildWindowsReadScript", () => {
	it("bounds the read to maxBytes bytes and emits the frame markers", () => {
		const script = buildWindowsReadScript("C:\\f", 1025);
		expect(script).toContain("$toRead = 1025");
		expect(script).toContain("PI_XFER_BEGIN|B64|");
		expect(script).toContain("PI_XFER_END|B64");
	});
});
