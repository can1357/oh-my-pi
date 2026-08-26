import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as syncFs from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { ptree, removeWithRetries } from "@oh-my-pi/pi-utils";
import type { SSHConnectionTarget } from "../../src/ssh/connection-manager";
import * as connectionManager from "../../src/ssh/connection-manager";
import {
	listRemoteDir,
	readRemoteFile,
	resolveWindowsResource,
	statRemotePath,
	writeRemoteFile,
} from "../../src/ssh/file-transfer";

// CI runners are Linux: the whole suite skips there. On Windows dev machines
// (and any future Windows CI) it executes the REAL generated scripts through
// the REAL powershell.exe — the only layer that can catch PS 5.1 parse
// errors, encoding bugs, and stream semantics.
describe.skipIf(process.platform !== "win32")("windows transfer real execution", () => {
	const target: SSHConnectionTarget = { name: "winexec", host: "winexec.invalid" };
	let dir = "";
	let dirUrl = "";

	// Symlink privilege probe: creating symlinks on Windows needs admin or
	// Developer Mode, so probe once (synchronously, at registration time —
	// `it.skipIf` is evaluated when `it()` runs) and gate the symlink-dependent
	// tests on the result instead of failing. Hardlinks (fs.link) need no
	// privilege and stay unconditional.
	let symlinkSkipReason = "";
	{
		const probeDir = syncFs.mkdtempSync(path.join(os.tmpdir(), "omp-symlink-probe-"));
		try {
			syncFs.symlinkSync(path.join(probeDir, "target"), path.join(probeDir, "link"));
		} catch (err) {
			symlinkSkipReason = `fs.symlink unavailable (${
				(err as NodeJS.ErrnoException).code ?? String(err)
			}) — symlink creation requires admin or Developer Mode`;
			console.error(`[file-transfer-powershell.exec] skipping symlink tests: ${symlinkSkipReason}`);
		} finally {
			syncFs.rmSync(probeDir, { recursive: true, force: true });
		}
	}

	beforeEach(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-ssh-winexec-"));
		dirUrl = dir.replace(/\\/g, "/");
		vi.spyOn(connectionManager, "ensureConnection").mockResolvedValue(undefined);
		vi.spyOn(connectionManager, "ensureHostInfo").mockResolvedValue({
			version: 5,
			os: "windows",
			shell: "powershell",
			transferShell: "powershell",
			compatEnabled: false,
		});
		// Fake ssh: run the captured remote command locally via powershell.exe.
		vi.spyOn(ptree, "spawn").mockImplementation(((argv: string[], opts?: { stdin?: Uint8Array }) => {
			const command = String(argv.at(-1) ?? "");
			const proc = Bun.spawnSync(command.split(" "), {
				stdin: opts?.stdin ? Buffer.from(opts.stdin) : undefined,
				stdout: "pipe",
				stderr: "pipe",
			});
			const stdout = new Uint8Array(proc.stdout);
			const stderrText = new TextDecoder().decode(proc.stderr);
			return {
				bytes: async () => stdout,
				exitedCleanly:
					proc.exitCode === 0
						? Promise.resolve()
						: Promise.reject(new Error(`remote exited ${proc.exitCode}: ${stderrText}`)),
				[Symbol.dispose]: () => {},
			};
		}) as unknown as typeof ptree.spawn);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		if (dir) await removeWithRetries(dir);
	});

	it("write→read round-trips binary bytes exactly (NUL/0xFF/CRLF torture)", async () => {
		const content = new Uint8Array(1024);
		for (let i = 0; i < content.length; i++) content[i] = (i * 7 + 13) & 0xff;
		content.set([0, 255, 13, 10, 0, 10, 13], 500);
		await writeRemoteFile(target, `${dirUrl}/bin.dat`, content, {});
		expect((await fs.readFile(path.join(dir, "bin.dat"))).equals(Buffer.from(content))).toBe(true);
		const back = await readRemoteFile(target, `${dirUrl}/bin.dat`, { maxBytes: 4096 });
		expect(Buffer.from(back.bytes).equals(Buffer.from(content))).toBe(true);
	});

	it("rewrites an existing regular file in place, preserving hardlinks", async () => {
		const file = path.join(dir, "f.txt");
		const link = path.join(dir, "hard.txt");
		await Bun.write(file, "old");
		await fs.link(file, link);
		await writeRemoteFile(target, `${dirUrl}/f.txt`, new TextEncoder().encode("brand new"), {});
		// The hardlink still resolves to the same NTFS object: content updated
		// through BOTH names (rename-based replace would have orphaned `link`).
		expect(await Bun.file(link).text()).toBe("brand new");
	});

	it("refuses a directory destination", async () => {
		await expect(writeRemoteFile(target, `${dirUrl}/`, new Uint8Array([1]), {})).rejects.toThrow(/trailing/);
		await expect(writeRemoteFile(target, dirUrl, new Uint8Array([1]), {})).rejects.toThrow(/directory/s);
	});

	it.skipIf(!!symlinkSkipReason)("replaces a dangling symlink instead of writing through it", async () => {
		const link = path.join(dir, "dangling.lnk");
		await fs.symlink(path.join(dir, "does-not-exist"), link);
		await writeRemoteFile(target, `${dirUrl}/dangling.lnk`, new TextEncoder().encode("solid"), {});
		const st = await fs.lstat(link);
		expect(st.isSymbolicLink()).toBe(false);
		expect(await Bun.file(link).text()).toBe("solid");
	});

	it.skipIf(!!symlinkSkipReason)(
		"replaces a file symlink to an existing target, leaving the target untouched",
		async () => {
			const victim = path.join(dir, "victim.txt");
			const link = path.join(dir, "alias.lnk");
			await Bun.write(victim, "precious");
			await fs.symlink(victim, link);
			await writeRemoteFile(target, `${dirUrl}/alias.lnk`, new TextEncoder().encode("replacement"), {});
			// The link itself is replaced by a regular file…
			const st = await fs.lstat(link);
			expect(st.isSymbolicLink()).toBe(false);
			expect(st.isFile()).toBe(true);
			expect(await Bun.file(link).text()).toBe("replacement");
			// …and the write never landed through the link into the target.
			expect(await Bun.file(victim).text()).toBe("precious");
		},
	);

	it("stats file/directory/missing", async () => {
		await Bun.write(path.join(dir, "s.txt"), "x");
		await expect(statRemotePath(target, `${dirUrl}/s.txt`)).resolves.toBe("file");
		await expect(statRemotePath(target, dirUrl)).resolves.toBe("directory");
		await expect(statRemotePath(target, `${dirUrl}/nope`)).resolves.toBe("missing");
	});

	it("surfaces lookup failures instead of classifying them as missing", async () => {
		// An unreachable drive is the deterministic access-failure class: the
		// lookup must exit nonzero and reject — never classify 'missing', which
		// would masquerade as "No such file or directory". ACL denials and
		// unavailable UNC shares take the same path.
		const unused = [..."ZYXWVUTSRQPONMLKJIHGFEDBA"].find(letter => !syncFs.existsSync(`${letter}:\\`));
		if (!unused) return; // every drive letter is mounted — nothing to exercise
		await expect(statRemotePath(target, `${unused}:/nowhere`)).rejects.toThrow(/exited 1/);
		await expect(resolveWindowsResource(target, `${unused}:/nowhere`, { maxBytes: 16 })).rejects.toThrow(/exited 1/);
	});

	it("lists entries dirs-first with UTF-8 names and trailing-slash markers", async () => {
		await fs.mkdir(path.join(dir, "sub"));
		await Bun.write(path.join(dir, "中文.txt"), "x");
		await Bun.write(path.join(dir, "b.txt"), "x");
		const entries = await listRemoteDir(target, dirUrl);
		// Dirs-first grouping, the exact name set, and UTF-8 name bytes are the
		// portable contract. The cross-script NAME order follows the machine's
		// default locale (zh-CN collation sorts Han before Latin, en-US after)
		// — the same localeCompare collation the local directory-resource
		// listing uses, which this mirrors. Compute the expected order with
		// that documented comparator rather than hard-coding one locale's.
		const expected = ["sub", "b.txt", "中文.txt"]
			.map(name => ({ name, isDirectory: name === "sub" }))
			.sort((a, b) => Number(b.isDirectory) - Number(a.isDirectory) || a.name.localeCompare(b.name))
			.map(e => `${e.name}${e.isDirectory ? "/" : ""}`);
		expect(entries.map(e => `${e.name}${e.isDirectory ? "/" : ""}`)).toEqual(expected);
	});

	it("refuses a junction destination (reparse point to a directory)", async () => {
		const sub = path.join(dir, "junction-target");
		await fs.mkdir(sub);
		const junction = path.join(dir, "junction");
		// Junctions need no symlink privilege, so the reparse-point refusal
		// branch runs for real even where the fs.symlink probe failed.
		const proc = Bun.spawnSync(["cmd", "/c", "mklink", "/J", junction, sub]);
		expect(proc.exitCode).toBe(0);
		await expect(writeRemoteFile(target, `${dirUrl}/junction`, new TextEncoder().encode("x"), {})).rejects.toThrow(
			/directory/,
		);
		// The junction still resolves to the untouched target directory.
		expect((await fs.stat(junction)).isDirectory()).toBe(true);
	});

	it("reports truncation beyond maxBytes", async () => {
		const file = path.join(dir, "big.bin");
		await Bun.write(file, new Uint8Array(100));
		const result = await readRemoteFile(target, `${dirUrl}/big.bin`, { maxBytes: 50 });
		expect(result.bytes.length).toBe(50);
		expect(result.truncated).toBe(true);
	});

	it("merged resolve reads exactly maxBytes without truncation at the cap", async () => {
		const file = path.join(dir, "exact.bin");
		await Bun.write(file, Buffer.alloc(50, 0x41));
		const result = await resolveWindowsResource(target, `${dirUrl}/exact.bin`, { maxBytes: 50 });
		expect(result?.kind).toBe("file");
		expect(result?.bytes?.length).toBe(50);
		expect(result?.truncated).toBe(false);
	});

	it("merged resolve flags truncation at maxBytes + 1", async () => {
		const file = path.join(dir, "over.bin");
		await Bun.write(file, Buffer.alloc(51, 0x42));
		const result = await resolveWindowsResource(target, `${dirUrl}/over.bin`, { maxBytes: 50 });
		expect(result?.kind).toBe("file");
		expect(result?.bytes?.length).toBe(50);
		expect(result?.truncated).toBe(true);
	});
});
