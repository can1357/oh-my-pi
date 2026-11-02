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

	it("resolves a missing path through its deepest existing ancestor only when asked", () => {
		const temp = fs.mkdtempSync(path.join(os.tmpdir(), "omp-through-missing-"));
		try {
			const real = path.join(temp, "real");
			const link = path.join(temp, "link");
			fs.mkdirSync(real);
			try {
				fs.symlinkSync(real, link, "junction");
			} catch {
				return; // Symlinks unavailable on this host.
			}
			const missing = path.join(link, "sub", "new.ts");
			expect(resolveEquivalentPath(missing)).toBe(missing);
			expect(resolveEquivalentPath(missing, { throughMissing: true })).toBe(
				path.join(fs.realpathSync(real), "sub", "new.ts"),
			);
		} finally {
			fs.rmSync(temp, { recursive: true, force: true });
		}
	});
});
