import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createGrepTool } from "@oh-my-pi/pi-coding-agent/extensibility/legacy-pi-coding-agent-shim";

describe("legacy grep file and directory globs", () => {
	it("searches an explicit file even when a glob is supplied", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-legacy-grep-"));
		try {
			await Bun.write(path.join(cwd, "sample.txt"), "alpha\nbeta\n");
			const grep = createGrepTool(cwd);
			const result = await grep.execute("grep-file", {
				pattern: "beta",
				path: "sample.txt",
				glob: "sample.txt",
			});
			expect(result.details.files).toEqual(["sample.txt"]);
			expect(result.details.matchCount).toBe(1);
			const differentGlob = await grep.execute("grep-file", {
				pattern: "beta",
				path: "sample.txt",
				glob: "other.txt",
			});
			expect(differentGlob.details.files).toEqual(["sample.txt"]);
		} finally {
			await fs.rm(cwd, { recursive: true, force: true });
		}
	});

	it("still scopes a directory to its glob", async () => {
		const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "omp-legacy-grep-"));
		try {
			await Bun.write(path.join(cwd, "sample.txt"), "beta\n");
			await Bun.write(path.join(cwd, "other.txt"), "beta\n");
			const result = await createGrepTool(cwd).execute("grep-dir", {
				pattern: "beta",
				path: ".",
				glob: "sample.txt",
			});
			expect(result.details.files).toEqual(["sample.txt"]);
		} finally {
			await fs.rm(cwd, { recursive: true, force: true });
		}
	});
});
