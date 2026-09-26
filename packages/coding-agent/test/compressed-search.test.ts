import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { executeBash } from "../src/exec/bash-executor";

/**
 * `rg -z` decompresses through an external child, and the placement change had to
 * rebuild that child from grep-cli's public API so the hook can prepare it before
 * the spawn. Nothing else covers that rewrite, so this asserts the observable end
 * state: the decompressor runs and its stdout is what gets searched.
 */
describe("compressed search", () => {
	it("finds a match inside a gzipped file", async () => {
		const cwd = mkdtempSync(path.join(os.tmpdir(), "omp-rg-z-"));
		try {
			const needle = "placement-needle-9f2c";
			writeFileSync(path.join(cwd, "data.txt.gz"), Bun.gzipSync(Buffer.from(`alpha\n${needle}\nomega\n`)));
			const result = await executeBash(`rg -z ${needle} data.txt.gz`, { cwd, timeout: 30_000 });
			expect(result.exitCode).toBe(0);
			expect(result.output).toContain(needle);
		} finally {
			rmSync(cwd, { recursive: true, force: true });
		}
	});
});
