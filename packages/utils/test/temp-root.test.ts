import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getTempRoot, TempDir } from "@oh-my-pi/pi-utils/temp";

const scratch: string[] = [];
const originalTmpdir = process.env.TMPDIR;

afterEach(() => {
	if (originalTmpdir === undefined) delete process.env.TMPDIR;
	else process.env.TMPDIR = originalTmpdir;
	for (const dir of scratch.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

/** A temporary directory that stands in for the OS temp dir, so the root can be swapped. */
function scratchTempDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-temp-root-"));
	scratch.push(dir);
	return dir;
}

describe("the owned temp root", () => {
	it("is one directory per user, private to that user", () => {
		const root = getTempRoot();
		const stats = fs.lstatSync(root);
		expect(stats.isDirectory()).toBe(true);
		expect(path.dirname(root)).toBe(os.tmpdir());
		const uid = process.getuid?.();
		if (uid !== undefined) {
			expect(stats.uid).toBe(uid);
			expect(root.endsWith(`omp-${uid}`)).toBe(true);
			// Nobody else can list or read what omp leaves there.
			expect(stats.mode & 0o077).toBe(0);
		}
	});

	it("puts an @-prefixed TempDir below the root instead of beside it", async () => {
		await using dir = await TempDir.create("@omp-temp-root-test-");
		expect(path.resolve(dir.path()).startsWith(`${path.resolve(getTempRoot())}${path.sep}`)).toBe(true);
	});

	it("refuses a root that is a symlink someone else planted", () => {
		const tmp = scratchTempDir();
		const elsewhere = scratchTempDir();
		const uid = process.getuid?.();
		const leaf = uid === undefined ? "omp" : `omp-${uid}`;
		fs.symlinkSync(elsewhere, path.join(tmp, leaf));
		process.env.TMPDIR = tmp;

		expect(() => getTempRoot()).toThrow(/not a directory/);
	});

	it("tightens an existing root that others can read", () => {
		const tmp = scratchTempDir();
		const uid = process.getuid?.();
		const leaf = uid === undefined ? "omp" : `omp-${uid}`;
		const root = path.join(tmp, leaf);
		fs.mkdirSync(root, { recursive: true });
		fs.chmodSync(root, 0o755);
		process.env.TMPDIR = tmp;

		expect(getTempRoot()).toBe(root);
		expect(fs.lstatSync(root).mode & 0o077).toBe(0);
	});
});
