import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveEquivalentPath } from "@oh-my-pi/pi-utils/dirs";

describe("issue #935 path equivalence", () => {
	it("falls back to the lexical path when there is nothing on disk to resolve", () => {
		const missing = path.join(os.tmpdir(), `omp-absent-${process.pid}-${Date.now()}`, "project");

		expect(resolveEquivalentPath(missing)).toBe(missing);
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
