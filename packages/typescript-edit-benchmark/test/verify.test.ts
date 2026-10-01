import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { verifyExpectedFiles } from "@oh-my-pi/typescript-edit-benchmark/verify";

async function createTempDirs(): Promise<{
	root: string;
	expectedDir: string;
	actualDir: string;
	cleanup: () => Promise<void>;
}> {
	const tempDir = await TempDir.create("@reach-benchmark-verify-");
	const expectedDir = tempDir.join("expected");
	const actualDir = tempDir.join("actual");
	await fs.mkdir(expectedDir, { recursive: true });
	await fs.mkdir(actualDir, { recursive: true });
	return {
		root: tempDir.absolute(),
		expectedDir,
		actualDir,
		cleanup: async () => {
			await tempDir.remove();
		},
	};
}

describe("verifyExpectedFiles", () => {
	it("reports missing files", async () => {
		const { expectedDir, actualDir, cleanup } = await createTempDirs();
		try {
			await Bun.write(path.join(expectedDir, "index.ts"), "export const value = 1;\n");

			const result = await verifyExpectedFiles(expectedDir, actualDir);

			expect(result.success).toBe(false);
			expect(result.error).toContain("Missing files: index.ts");
		} finally {
			await cleanup();
		}
	});

	it("reports unexpected files", async () => {
		const { expectedDir, actualDir, cleanup } = await createTempDirs();
		try {
			await Bun.write(path.join(expectedDir, "index.ts"), "export const value = 1;\n");
			await Bun.write(path.join(actualDir, "index.ts"), "export const value = 1;\n");
			await Bun.write(path.join(actualDir, "extra.ts"), "export const extra = true;\n");

			const result = await verifyExpectedFiles(expectedDir, actualDir);

			expect(result.success).toBe(false);
			expect(result.error).toContain("Unexpected files: extra.ts");
		} finally {
			await cleanup();
		}
	});

	it("fails with diff output when formatted content differs", async () => {
		const { expectedDir, actualDir, cleanup } = await createTempDirs();
		try {
			await Bun.write(path.join(expectedDir, "index.ts"), "const value = 1;\n");
			await Bun.write(path.join(actualDir, "index.ts"), "const value = 2;\n");

			const result = await verifyExpectedFiles(expectedDir, actualDir);

			expect(result.success).toBe(false);
			expect(result.diff).toContain("-const value = 1;");
			expect(result.diff).toContain("+const value = 2;");
			expect(result.diffStats?.linesChanged).toBeGreaterThan(0);
			expect(result.diffStats?.charsChanged).toBeGreaterThan(0);
		} finally {
			await cleanup();
		}
	});

	it("succeeds when formatted content matches despite whitespace differences", async () => {
		const { expectedDir, actualDir, cleanup } = await createTempDirs();
		try {
			const expected = "function test() {\n  return 1;\n}\n";
			const actual = "function test(){\nreturn 1;\n}\n";
			await Bun.write(path.join(expectedDir, "index.ts"), expected);
			await Bun.write(path.join(actualDir, "index.ts"), actual);

			const result = await verifyExpectedFiles(expectedDir, actualDir);
			const actualAfter = await Bun.file(path.join(actualDir, "index.ts")).text();

			expect(result.success).toBe(true);
			expect(result.formattedEquivalent).toBe(true);
			expect(actualAfter).toBe(actual);
		} finally {
			await cleanup();
		}
	});

	it("succeeds when a code file differs only by a stray seam blank line", async () => {
		const { expectedDir, actualDir, cleanup } = await createTempDirs();
		try {
			// A block move that leaves one extra blank line where the block was
			// deleted must not fail verification (prettier preserves single
			// blank lines, so formatting alone cannot repair this).
			const expected = "function a() {\n  return 1;\n}\nfunction b() {\n  return 2;\n}\n";
			const actual = "function a() {\n  return 1;\n}\n\nfunction b() {\n  return 2;\n}\n";
			await Bun.write(path.join(expectedDir, "index.ts"), expected);
			await Bun.write(path.join(actualDir, "index.ts"), actual);

			const result = await verifyExpectedFiles(expectedDir, actualDir);

			expect(result.success).toBe(true);
			expect(result.formattedEquivalent).toBe(true);
		} finally {
			await cleanup();
		}
	});

	it("keeps blank lines significant for markdown files", async () => {
		const { expectedDir, actualDir, cleanup } = await createTempDirs();
		try {
			// One paragraph vs two: a real markdown content difference.
			await Bun.write(path.join(expectedDir, "README.md"), "alpha\nbeta\n");
			await Bun.write(path.join(actualDir, "README.md"), "alpha\n\nbeta\n");

			const result = await verifyExpectedFiles(expectedDir, actualDir);

			expect(result.success).toBe(false);
		} finally {
			await cleanup();
		}
	});

	it("normalizes line endings before comparison", async () => {
		const { expectedDir, actualDir, cleanup } = await createTempDirs();
		try {
			await Bun.write(path.join(expectedDir, "index.ts"), "export const value = 1;\r\n");
			await Bun.write(path.join(actualDir, "index.ts"), "export const value = 1;\n");

			const result = await verifyExpectedFiles(expectedDir, actualDir);

			expect(result.success).toBe(true);
		} finally {
			await cleanup();
		}
	});

	it("preserves expected whitespace on non-formatted files when differences are whitespace-only", async () => {
		const { expectedDir, actualDir, cleanup } = await createTempDirs();
		try {
			await Bun.write(path.join(expectedDir, "notes.txt"), "alpha  beta\ngamma\n");
			await Bun.write(path.join(actualDir, "notes.txt"), "alpha beta\ngamma\n");

			const result = await verifyExpectedFiles(expectedDir, actualDir);

			expect(result.success).toBe(true);
		} finally {
			await cleanup();
		}
	});

	it("normalizes indent-only diffs even when earlier insertions shift line indices", async () => {
		const { expectedDir, actualDir, cleanup } = await createTempDirs();
		try {
			// Force prettier to bail (intentional syntax error: unbalanced brace) so the
			// verifier falls back to the whitespace-restore pass on raw content.
			const expected = [
				"function broken(",
				"  // missing close paren on purpose",
				"  return {",
				"      a: 1,",
				"      b: 2,",
				"  };",
				"}",
				"",
			].join("\n");
			const actual = [
				"function broken(",
				"  // missing close paren on purpose",
				"  const inserted = true;",
				"  return {",
				"    a: 1,",
				"    b: 2,",
				"  };",
				"}",
				"",
			].join("\n");
			await Bun.write(path.join(expectedDir, "index.ts"), expected);
			await Bun.write(path.join(actualDir, "index.ts"), actual);

			const result = await verifyExpectedFiles(expectedDir, actualDir);

			// The only real change should be the inserted const; the body's indent
			// drift must not be reported as added/removed lines.
			expect(result.success).toBe(false);
			const diff = result.diff ?? "";
			const changeLines = diff.split("\n").filter(line => line.startsWith("+") || line.startsWith("-"));
			expect(changeLines.some(line => line.includes("const inserted"))).toBe(true);
			expect(changeLines.some(line => line.includes("a:"))).toBe(false);
			expect(changeLines.some(line => line.includes("b:"))).toBe(false);
		} finally {
			await cleanup();
		}
	});
});
