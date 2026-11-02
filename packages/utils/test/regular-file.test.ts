import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { TempDir } from "../src/temp";
import {
	NotARegularFile,
	openRegularFile,
	openRegularFileSync,
	readOptionalFileText,
	readRegularFileText,
	regularFileExists,
	regularFileExistsSync,
	withoutByteOrderMark,
} from "../src/regular-file";

// The helper is the one chokepoint every user-named file read goes through: it looks at the
// name first and opens nothing but a regular file. A FIFO at the name is refused by the look,
// so a writer waiting in its own open — which is how a mount that serves a file through a pipe
// waits for a reader — is never woken. These tests prove that directly, in-process, without a
// child command.
const WAKE_GRACE_MS = 1_000;

let tempDir: TempDir;

beforeEach(() => {
	tempDir = TempDir.createSync("@omp-regular-file-");
});

afterEach(() => {
	tempDir.removeSync();
});

function mkfifo(target: string): void {
	const made = Bun.spawnSync(["mkfifo", target]);
	if (made.exitCode !== 0) throw new Error(made.stderr.toString());
}

/** A FIFO at `target`, and a writer waiting in its own `open()` for a reader; `woken` tells whether one came. */
function writerWaitingInOpen(target: string): { woken(): Promise<boolean>; stop(): void } {
	mkfifo(target);
	const mark = `${target}.woken`;
	const writer = Bun.spawn(["sh", "-c", 'exec 3>"$0"; : > "$1"; exec sleep 60', target, mark], {
		stdout: "ignore",
		stderr: "ignore",
	});
	return {
		async woken() {
			// A real timer: the writer is another process. A woken writer marks at once.
			for (const started = Date.now(); Date.now() - started < WAKE_GRACE_MS; await Bun.sleep(20)) {
				if (fs.existsSync(mark)) return true;
			}
			return fs.existsSync(mark);
		},
		stop() {
			writer.kill("SIGKILL");
		},
	};
}

describe.skipIf(process.platform === "win32")("the helper opens nothing but a regular file", () => {
	it("a regular file opens and reads", async () => {
		const at = path.join(tempDir.path(), "regular.txt");
		fs.writeFileSync(at, "hello\n");

		expect(await regularFileExists(at)).toBe(true);
		expect(regularFileExistsSync(at)).toBe(true);
		const handle = await openRegularFile(at);
		expect(handle).toBeDefined();
		await handle?.close();
		const fd = openRegularFileSync(at);
		expect(fd).toBeDefined();
		if (fd !== undefined) fs.closeSync(fd);
		expect(await readRegularFileText(at)).toBe("hello\n");
	});

	it("nothing at the name is absent, not an error", async () => {
		const at = path.join(tempDir.path(), "missing.txt");

		expect(await regularFileExists(at)).toBe(false);
		expect(regularFileExistsSync(at)).toBe(false);
		expect(await openRegularFile(at)).toBeUndefined();
		expect(openRegularFileSync(at)).toBeUndefined();
		expect(await readRegularFileText(at)).toBeUndefined();
	});

	it("a FIFO is refused by the look at the name, and its waiting writer is never woken", async () => {
		const at = path.join(tempDir.path(), "pipe");
		const writer = writerWaitingInOpen(at);
		try {
			await expect(regularFileExists(at)).rejects.toBeInstanceOf(NotARegularFile);
			expect(() => regularFileExistsSync(at)).toThrow(NotARegularFile);
			await expect(openRegularFile(at)).rejects.toBeInstanceOf(NotARegularFile);
			expect(() => openRegularFileSync(at)).toThrow(NotARegularFile);
			await expect(readRegularFileText(at)).rejects.toBeInstanceOf(NotARegularFile);
			// readOptionalFileText swallows the refusal and reports it; it must not open the pipe either.
			expect(await readOptionalFileText(at)).toBeUndefined();

			expect(await writer.woken()).toBe(false);
		} finally {
			writer.stop();
		}
	});

	it("the message of a refused FIFO names the file and its kind", async () => {
		const at = path.join(tempDir.path(), "pipe");
		mkfifo(at);
		try {
			regularFileExistsSync(at);
			throw new Error("expected a refusal");
		} catch (error) {
			expect(error).toBeInstanceOf(NotARegularFile);
			const refusal = error as NotARegularFile;
			expect(refusal.file).toBe(at);
			expect(refusal.kind).toBe("a FIFO");
			expect(refusal.message).toContain(at);
			expect(refusal.message).toContain("a FIFO");
		}
	});

	it("a directory at the name is refused too", () => {
		const at = path.join(tempDir.path(), "dir");
		fs.mkdirSync(at);
		expect(() => regularFileExistsSync(at)).toThrow(NotARegularFile);
		expect(() => openRegularFileSync(at)).toThrow(NotARegularFile);
	});
});

describe("withoutByteOrderMark drops one leading mark and nothing else", () => {
	it("drops a single leading U+FEFF", () => {
		expect(withoutByteOrderMark("\uFEFF{}")).toBe("{}");
	});

	it("leaves text without a mark, and an interior mark, unchanged", () => {
		expect(withoutByteOrderMark("{}")).toBe("{}");
		expect(withoutByteOrderMark("a\uFEFFb")).toBe("a\uFEFFb");
		expect(withoutByteOrderMark("\uFEFF\uFEFFx")).toBe("\uFEFFx");
		expect(withoutByteOrderMark("")).toBe("");
	});

	it("a text reader keeps a byte-order mark (node semantics); the caller drops it to match Bun.file().text()", async () => {
		const at = path.join(tempDir.path(), "bom.json");
		fs.writeFileSync(at, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('{"a":1}')]));

		const kept = await readRegularFileText(at);
		expect(kept?.charCodeAt(0)).toBe(0xfeff);
		expect(() => JSON.parse(kept ?? "")).toThrow();
		expect(JSON.parse(withoutByteOrderMark(kept ?? ""))).toEqual({ a: 1 });
	});
});
