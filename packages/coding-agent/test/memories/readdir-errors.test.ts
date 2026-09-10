// Follow-up to #11476 (PR #11554): a failed child scan is unknown, not empty.
// pruneEmptyDirectories must never remove a subtree it could not re-read:
// a transient non-ENOENT failure (EMFILE, I/O error) must skip deletion.
import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { pruneEmptyDirectories } from "@oh-my-pi/pi-coding-agent/memories";
import { removeSyncWithRetries } from "@oh-my-pi/pi-utils";

describe("pruneEmptyDirectories child-scan failure", () => {
	let tempDir!: string;
	let child!: string;

	beforeEach(() => {
		tempDir = fsSync.mkdtempSync(path.join(os.tmpdir(), "pi-prune-sentinel-"));
		child = path.join(tempDir, "child");
		fsSync.mkdirSync(child, { recursive: true });
		fsSync.writeFileSync(path.join(child, "keep.txt"), "populated");
	});

	afterEach(() => {
		vi.restoreAllMocks();
		removeSyncWithRetries(tempDir);
	});

	test("a failed child re-read keeps the populated subtree and never removes it", async () => {
		const realReaddir = fs.readdir.bind(fs);
		let childReads = 0;
		let injected = false;
		vi.spyOn(fs, "readdir").mockImplementation(
			(async (target: fsSync.PathLike, options?: object) => {
				// Fail only the post-prune re-read (the second read of the child):
				// the recursion's own entry read must succeed so the injected
				// failure lands exactly where the deletion decision is made.
				if (target === child && ++childReads === 2) {
					injected = true;
					throw Object.assign(new Error("injected child scan failure"), { code: "EMFILE" });
				}
				return realReaddir(target as string, options as { withFileTypes: true });
			}) as typeof fs.readdir,
		);
		const realRm = fs.rm.bind(fs);
		const removed: string[] = [];
		vi.spyOn(fs, "rm").mockImplementation(async (target, options) => {
			removed.push(String(target));
			return realRm(target, options);
		});

		await pruneEmptyDirectories(tempDir);

		expect(injected).toBe(true);
		expect(removed).not.toContain(child);
		expect(fsSync.existsSync(path.join(child, "keep.txt"))).toBe(true);
	});

	test("a positively-empty child is still pruned", async () => {
		fsSync.rmSync(path.join(child, "keep.txt"));
		await pruneEmptyDirectories(tempDir);
		expect(fsSync.existsSync(child)).toBe(false);
	});
});
