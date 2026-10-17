import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveEquivalentPath } from "@oh-my-pi/pi-utils/dirs";

describe("issue #935 path equivalence", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("falls back to the lexical project path when realpath fails", () => {
		const inputPath = path.resolve("/sessions/link-project");
		const realpathSpy = vi.spyOn(fs, "realpathSync").mockImplementation((() => {
			const error = new Error("ENOENT: no such file or directory, realpath");
			(error as NodeJS.ErrnoException).code = "ENOENT";
			throw error;
		}) as unknown as typeof fs.realpathSync);

		expect(resolveEquivalentPath(inputPath)).toBe(inputPath);
		expect(realpathSpy).toHaveBeenCalledWith(inputPath);
	});

	it("resolves a symlinked ancestor for a path that does not exist yet", () => {
		const temp = fs.mkdtempSync(path.join(os.tmpdir(), "omp-symlink-parent-"));
		try {
			const real = path.join(temp, "real");
			const link = path.join(temp, "link");
			fs.mkdirSync(real);
			try {
				fs.symlinkSync(real, link, "junction");
			} catch {
				// Creating the link may need privileges; there is nothing to assert without one.
				return;
			}
			// The target does not exist yet, so the key has to resolve the symlinked parent itself.
			expect(resolveEquivalentPath(path.join(link, "new.ts"))).toBe(
				resolveEquivalentPath(path.join(real, "new.ts")),
			);
			fs.writeFileSync(path.join(real, "new.ts"), "x");
			// Once the file exists, both spellings still agree.
			expect(resolveEquivalentPath(path.join(link, "new.ts"))).toBe(
				resolveEquivalentPath(path.join(real, "new.ts")),
			);
		} finally {
			fs.rmSync(temp, { recursive: true, force: true });
		}
	});
});
