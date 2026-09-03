import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	ApplyPatchError,
	applyCodexPatch,
	applyPatch,
	EditTool,
	ParseError,
	parseApplyPatch,
	parseDiffHunks,
	seekSequence,
} from "@oh-my-pi/pi-coding-agent/edit";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { removeSyncWithRetries } from "@oh-my-pi/pi-utils";

// ═══════════════════════════════════════════════════════════════════════════
// Test-local adapters over the production Codex envelope API.
// (Kept as thin shims so the pre-existing tests keep their original shape;
// the production API returns PatchInput[] directly.)
// ═══════════════════════════════════════════════════════════════════════════

type LegacyHunk =
	| { type: "add"; path: string; contents: string }
	| { type: "delete"; path: string }
	| { type: "update"; path: string; movePath?: string; diffBody: string };

interface LegacyParseResult {
	hunks: LegacyHunk[];
}

function parseLegacyPatch(patch: string): LegacyParseResult {
	const hunks = parseApplyPatch(patch).map((h): LegacyHunk => {
		if (h.op === "create") return { type: "add", path: h.path, contents: h.diff ?? "" };
		if (h.op === "delete") return { type: "delete", path: h.path };
		return { type: "update", path: h.path, movePath: h.rename, diffBody: h.diff ?? "" };
	});
	return { hunks };
}

async function applyLegacyPatch(patch: string, options: { cwd: string }) {
	await applyCodexPatch(patch, options);
}

// ═══════════════════════════════════════════════════════════════════════════
// seek-sequence tests (port of seek_sequence.rs tests)
// ═══════════════════════════════════════════════════════════════════════════

describe("seekSequence", () => {
	test("exact match finds sequence", () => {
		const lines = ["foo", "bar", "baz"];
		const pattern = ["bar", "baz"];
		expect(seekSequence(lines, pattern, 0, false).index).toBe(1);
	});

	test("rstrip match ignores trailing whitespace", () => {
		const lines = ["foo   ", "bar\t\t"];
		const pattern = ["foo", "bar"];
		expect(seekSequence(lines, pattern, 0, false).index).toBe(0);
	});

	test("trim match ignores leading and trailing whitespace", () => {
		const lines = ["    foo   ", "   bar\t"];
		const pattern = ["foo", "bar"];
		expect(seekSequence(lines, pattern, 0, false).index).toBe(0);
	});

	test("pattern longer than input returns undefined", () => {
		const lines = ["just one line"];
		const pattern = ["too", "many", "lines"];
		expect(seekSequence(lines, pattern, 0, false).index).toBeUndefined();
	});

	test("empty pattern returns start", () => {
		const lines = ["foo", "bar"];
		expect(seekSequence(lines, [], 0, false).index).toBe(0);
		expect(seekSequence(lines, [], 5, false).index).toBe(5);
	});

	test("eof mode prefers end of file", () => {
		const lines = ["a", "b", "c", "d", "e"];
		const pattern = ["d", "e"];
		expect(seekSequence(lines, pattern, 0, true).index).toBe(3);
	});

	test("unicode normalization matches dashes", () => {
		const lines = ["import asyncio  # local import \u2013 avoids top\u2011level dep"];
		const pattern = ["import asyncio  # local import - avoids top-level dep"];
		expect(seekSequence(lines, pattern, 0, false).index).toBe(0);
	});

	test("fuzzy match finds sequence with minor differences", () => {
		const lines = ["function greet() {", '  console.log("Hello!");', "}"];
		const pattern = ["function greet() {", '  console.log("Hello!")  ', "}"];
		const result = seekSequence(lines, pattern, 0, false);
		expect(result.index).toBe(0);
		expect(result.confidence).toBeGreaterThanOrEqual(0.92);
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// Legacy parser tests (for fixture compatibility)
// ═══════════════════════════════════════════════════════════════════════════

describe("parseLegacyPatch", () => {
	const wrapPatch = (body: string) => `*** Begin Patch\n${body}\n*** End Patch`;

	test("rejects invalid first line", () => {
		expect(() => parseLegacyPatch("bad")).toThrow(ParseError);
	});

	test("rejects missing end marker", () => {
		expect(() => parseLegacyPatch("*** Begin Patch\nbad")).toThrow(ParseError);
	});

	test("parses add file with whitespace-padded markers", () => {
		const patch = "*** Begin Patch \n*** Add File: foo\n+hi\n *** End Patch";
		const result = parseLegacyPatch(patch);
		expect(result.hunks).toEqual([{ type: "add", path: "foo", contents: "hi\n" }]);
	});

	test("rejects empty update file hunk", () => {
		const patch = wrapPatch("*** Update File: test.py");
		expect(() => parseLegacyPatch(patch)).toThrow(ParseError);
	});

	test("parses empty patch", () => {
		const patch = wrapPatch("");
		const result = parseLegacyPatch(patch);
		expect(result.hunks).toEqual([]);
	});

	test("parses full patch with all operations", () => {
		const patch = wrapPatch(
			"*** Add File: path/add.py\n" +
				"+abc\n" +
				"+def\n" +
				"*** Delete File: path/delete.py\n" +
				"*** Update File: path/update.py\n" +
				"*** Move to: path/update2.py\n" +
				"@@ def f():\n" +
				"-    pass\n" +
				"+    return 123",
		);
		const result = parseLegacyPatch(patch);

		expect(result.hunks).toHaveLength(3);
		expect(result.hunks[0]).toEqual({ type: "add", path: "path/add.py", contents: "abc\ndef\n" });
		expect(result.hunks[1]).toEqual({ type: "delete", path: "path/delete.py" });
		expect(result.hunks[2]).toMatchObject({
			type: "update",
			path: "path/update.py",
			movePath: "path/update2.py",
		});
	});

	test("parses heredoc wrapped patch", () => {
		const patchText = "*** Begin Patch\n*** Add File: test.txt\n+hello\n*** End Patch";
		const heredocPatch = `<<'EOF'\n${patchText}\nEOF\n`;
		const result = parseLegacyPatch(heredocPatch);
		expect(result.hunks).toHaveLength(1);
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// parseDiffHunks tests
// ═══════════════════════════════════════════════════════════════════════════

describe("parseDiffHunks", () => {
	test("parses simple hunk", () => {
		const diff = "@@ def f():\n-    pass\n+    return 123";
		const chunks = parseDiffHunks(diff);
		expect(chunks).toHaveLength(1);
		expect(chunks[0].changeContext).toBe("def f():");
		expect(chunks[0].oldLines).toEqual(["    pass"]);
		expect(chunks[0].newLines).toEqual(["    return 123"]);
	});

	test("parses multiple hunks", () => {
		const diff = "@@\n-bar\n+BAR\n@@\n-qux\n+QUX";
		const chunks = parseDiffHunks(diff);
		expect(chunks).toHaveLength(2);
	});

	test("parses context lines", () => {
		const diff = "@@\n foo\n-bar\n+baz\n qux";
		const chunks = parseDiffHunks(diff);
		expect(chunks[0].oldLines).toEqual(["foo", "bar", "qux"]);
		expect(chunks[0].newLines).toEqual(["foo", "baz", "qux"]);
	});

	test("handles empty @@ marker", () => {
		const diff = "@@\n+new line";
		const chunks = parseDiffHunks(diff);
		expect(chunks[0].changeContext).toBeUndefined();
	});

	test("handles end of file marker", () => {
		const diff = "@@\n+line\n*** End of File";
		const chunks = parseDiffHunks(diff);
		expect(chunks[0].isEndOfFile).toBe(true);
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// Fixture-based scenario tests
// ═══════════════════════════════════════════════════════════════════════════

describe("apply-patch scenarios", () => {
	const fixturesDir = path.join(import.meta.dir, "../fixtures/apply-patch/scenarios");
	let tempDir: string;

	beforeEach(() => {
		tempDir = path.join(os.tmpdir(), `apply-patch-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		fs.mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		try {
			removeSyncWithRetries(tempDir);
		} catch {
			// Ignore cleanup errors
		}
	});

	async function snapshotDir(dir: string): Promise<Map<string, string | "dir">> {
		const entries = new Map<string, string | "dir">();
		if (!fs.readdirSync(dir, { withFileTypes: true }).length) {
			return entries;
		}

		async function walk(currentDir: string, relativePath: string) {
			for (const entry of fs.readdirSync(currentDir, { withFileTypes: true })) {
				const fullPath = path.join(currentDir, entry.name);
				const relPath = relativePath ? `${relativePath}/${entry.name}` : entry.name;

				if (entry.isDirectory()) {
					entries.set(relPath, "dir");
					await walk(fullPath, relPath);
				} else if (entry.isFile()) {
					entries.set(relPath, await Bun.file(fullPath).text());
				}
			}
		}

		await walk(dir, "");
		return entries;
	}

	function copyDirRecursive(src: string, dst: string) {
		fs.cpSync(src, dst, { recursive: true });
	}

	// Get all scenario directories
	const scenarioDirs = fs
		.readdirSync(fixturesDir, { withFileTypes: true })
		.filter(d => d.isDirectory())
		.map(d => d.name)
		.sort();

	for (const scenarioName of scenarioDirs) {
		test(scenarioName, async () => {
			const scenarioDir = path.join(fixturesDir, scenarioName);

			// Copy input files to temp directory
			const inputDir = path.join(scenarioDir, "input");
			try {
				copyDirRecursive(inputDir, tempDir);
			} catch {
				// No input directory is fine (e.g., for add-only scenarios)
			}

			// Read the patch
			const patchPath = path.join(scenarioDir, "patch.txt");
			const patch = await Bun.file(patchPath).text();

			// Apply the patch using legacy parser (catching errors for rejection tests)
			try {
				await applyLegacyPatch(patch, { cwd: tempDir });
			} catch {
				// Expected for rejection tests
			}

			// Compare final state to expected
			const expectedDir = path.join(scenarioDir, "expected");
			const expectedSnapshot = await snapshotDir(expectedDir);
			const actualSnapshot = await snapshotDir(tempDir);

			expect(actualSnapshot).toEqual(expectedSnapshot);
		});
	}
});

// ═══════════════════════════════════════════════════════════════════════════
// Unit tests for applyPatch (new format)
// ═══════════════════════════════════════════════════════════════════════════

describe("applyPatch", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = path.join(os.tmpdir(), `apply-patch-unit-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		fs.mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		try {
			removeSyncWithRetries(tempDir);
		} catch {
			// Ignore cleanup errors
		}
	});

	test("create file", async () => {
		await applyPatch({ path: "add.txt", op: "create", diff: "ab\ncd" }, { cwd: tempDir });

		expect(await Bun.file(path.join(tempDir, "add.txt")).text()).toBe("ab\ncd\n");
	});

	test("create with allowCreateOverwrite replaces an existing file (JSON patch contract)", async () => {
		const target = path.join(tempDir, "exists.txt");
		await Bun.write(target, "original\n");

		await applyPatch(
			{ path: "exists.txt", op: "create", diff: "replacement\n" },
			{ cwd: tempDir, allowCreateOverwrite: true },
		);

		expect(await Bun.file(target).text()).toBe("replacement\n");
	});

	test("delete file", async () => {
		const filePath = path.join(tempDir, "del.txt");
		await Bun.write(filePath, "x");

		await applyPatch({ path: "del.txt", op: "delete" }, { cwd: tempDir });

		expect(fs.existsSync(filePath)).toBe(false);
	});

	test("update file", async () => {
		const filePath = path.join(tempDir, "update.txt");
		await Bun.write(filePath, "foo\nbar\n");

		await applyPatch({ path: "update.txt", op: "update", diff: "@@\n foo\n-bar\n+baz" }, { cwd: tempDir });

		expect(await Bun.file(filePath).text()).toBe("foo\nbaz\n");
	});

	test("update with move", async () => {
		const srcPath = path.join(tempDir, "src.txt");
		await Bun.write(srcPath, "line\n");

		const result = await applyPatch(
			{ path: "src.txt", op: "update", rename: "dst.txt", diff: "@@\n-line\n+line2" },
			{ cwd: tempDir },
		);

		expect(result.change.newPath).toBe(path.join(tempDir, "dst.txt"));
		expect(fs.existsSync(srcPath)).toBe(false);
		expect(await Bun.file(path.join(tempDir, "dst.txt")).text()).toBe("line2\n");
	});

	test("multiple hunks in single update", async () => {
		const filePath = path.join(tempDir, "multi.txt");
		await Bun.write(filePath, "foo\nbar\nbaz\nqux\n");

		await applyPatch({ path: "multi.txt", op: "update", diff: "@@\n-bar\n+BAR\n@@\n-qux\n+QUX" }, { cwd: tempDir });

		expect(await Bun.file(filePath).text()).toBe("foo\nBAR\nbaz\nQUX\n");
	});

	test("@@ scope and first context line can be identical", async () => {
		const filePath = path.join(tempDir, "scope.txt");
		await Bun.write(filePath, "## [Unreleased]\n\n### Changed\n\n- Old entry\n");

		await applyPatch(
			{
				path: "scope.txt",
				op: "update",
				diff: "@@ ## [Unreleased]\n ## [Unreleased]\n \n+### Added\n+\n+- New feature\n+\n ### Changed",
			},
			{ cwd: tempDir },
		);

		expect(await Bun.file(filePath).text()).toBe(
			"## [Unreleased]\n\n### Added\n\n- New feature\n\n### Changed\n\n- Old entry\n",
		);
	});

	test("unicode dash matching", async () => {
		const filePath = path.join(tempDir, "unicode.py");
		await Bun.write(filePath, "import asyncio  # local import \u2013 avoids top\u2011level dep\n");

		await applyPatch(
			{
				path: "unicode.py",
				op: "update",
				diff: "@@\n-import asyncio  # local import - avoids top-level dep\n+import asyncio  # HELLO",
			},
			{ cwd: tempDir },
		);

		expect(await Bun.file(filePath).text()).toBe("import asyncio  # HELLO\n");
	});

	test("dry run does not modify files", async () => {
		const filePath = path.join(tempDir, "dryrun.txt");
		await Bun.write(filePath, "original\n");

		const result = await applyPatch(
			{ path: "dryrun.txt", op: "update", diff: "@@\n-original\n+modified" },
			{ cwd: tempDir, dryRun: true },
		);

		expect(result.change.newContent).toBe("modified\n");
		expect(await Bun.file(filePath).text()).toBe("original\n");
	});

	test("missing file for update fails", async () => {
		await expect(
			applyPatch({ path: "nonexistent.txt", op: "update", diff: "@@\n-foo\n+bar" }, { cwd: tempDir }),
		).rejects.toThrow(ApplyPatchError);
	});

	test("update without diff fails", async () => {
		const filePath = path.join(tempDir, "nodiff.txt");
		await Bun.write(filePath, "content\n");

		await expect(applyPatch({ path: "nodiff.txt", op: "update" }, { cwd: tempDir })).rejects.toThrow("requires diff");
	});

	test("creates parent directories for create", async () => {
		await applyPatch({ path: "nested/deep/file.txt", op: "create", diff: "content" }, { cwd: tempDir });

		const filePath = path.join(tempDir, "nested/deep/file.txt");
		expect(await Bun.file(filePath).text()).toBe("content\n");
	});

	test("creates parent directories for move", async () => {
		const srcPath = path.join(tempDir, "src.txt");
		await Bun.write(srcPath, "line\n");

		await applyPatch(
			{ path: "src.txt", op: "update", rename: "nested/deep/dst.txt", diff: "@@\n-line\n+newline" },
			{ cwd: tempDir },
		);

		const dstPath = path.join(tempDir, "nested/deep/dst.txt");
		expect(await Bun.file(dstPath).text()).toBe("newline\n");
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// Simple replace mode tests (character-based fuzzy matching)
// ═══════════════════════════════════════════════════════════════════════════

describe("simple replace mode", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = path.join(os.tmpdir(), `simple-replace-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		fs.mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		try {
			removeSyncWithRetries(tempDir);
		} catch {
			// Ignore cleanup errors
		}
	});

	test("simple -/+ only diff uses character-based fuzzy matching", async () => {
		const filePath = path.join(tempDir, "fuzzy.txt");
		// File has smart quotes, diff uses ASCII quotes
		await Bun.write(filePath, 'console.log("Hello");\n');

		await applyPatch(
			{
				path: "fuzzy.txt",
				op: "update",
				// No @@ marker, just -/+ lines
				diff: '-console.log("Hello");\n+console.log("World");',
			},
			{ cwd: tempDir },
		);

		expect(await Bun.file(filePath).text()).toBe('console.log("World");\n');
	});

	test("simple diff adjusts indentation to match actual content", async () => {
		const filePath = path.join(tempDir, "indent.ts");
		// File content is indented with 4 spaces
		await Bun.write(filePath, "function test() {\n    const x = 1;\n    return x;\n}\n");

		await applyPatch(
			{
				path: "indent.ts",
				op: "update",
				// Diff uses 0 indentation, should be adjusted to 4 spaces
				diff: "-const x = 1;\n+const x = 42;",
			},
			{ cwd: tempDir },
		);

		expect(await Bun.file(filePath).text()).toBe("function test() {\n    const x = 42;\n    return x;\n}\n");
	});

	test("diff with context lines falls back to line-based matching", async () => {
		const filePath = path.join(tempDir, "context.txt");
		// Create a file with repeated patterns that need context to disambiguate
		await Bun.write(filePath, "header\nfoo\nbar\nmiddle\nfoo\nbaz\nfooter\n");

		// Use context line to target the second "foo"
		await applyPatch(
			{
				path: "context.txt",
				op: "update",
				diff: "@@\n middle\n-foo\n+FOO",
			},
			{ cwd: tempDir },
		);

		// Only the second "foo" should be changed
		expect(await Bun.file(filePath).text()).toBe("header\nfoo\nbar\nmiddle\nFOO\nbaz\nfooter\n");
	});

	test("multiple chunks use line-based matching", async () => {
		const filePath = path.join(tempDir, "multi.txt");
		await Bun.write(filePath, "aaa\nbbb\nccc\nddd\n");

		// Multiple chunks in a single diff
		await applyPatch(
			{
				path: "multi.txt",
				op: "update",
				diff: "@@\n-bbb\n+BBB\n@@\n-ddd\n+DDD",
			},
			{ cwd: tempDir },
		);

		expect(await Bun.file(filePath).text()).toBe("aaa\nBBB\nccc\nDDD\n");
	});

	test("simple diff with @@ context uses line-based matching", async () => {
		const filePath = path.join(tempDir, "scoped.txt");
		await Bun.write(filePath, "class Foo {\n  method() {\n    return 1;\n  }\n}\n");

		// Even without context lines, @@ marker triggers line-based mode
		await applyPatch(
			{
				path: "scoped.txt",
				op: "update",
				diff: "@@ class Foo {\n-    return 1;\n+    return 42;",
			},
			{ cwd: tempDir },
		);

		expect(await Bun.file(filePath).text()).toBe("class Foo {\n  method() {\n    return 42;\n  }\n}\n");
	});

	test("simple diff rejects multiple occurrences", async () => {
		const filePath = path.join(tempDir, "dupe.txt");
		await Bun.write(filePath, "foo\nbar\nfoo\n");

		await expect(
			applyPatch(
				{
					path: "dupe.txt",
					op: "update",
					diff: "-foo\n+FOO",
				},
				{ cwd: tempDir },
			),
		).rejects.toThrow(/2 occurrences/);
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// Production Codex envelope API — spec §10 edge-case coverage
// ═══════════════════════════════════════════════════════════════════════════

describe("parseApplyPatch (production)", () => {
	const wrap = (body: string) => `*** Begin Patch\n${body}\n*** End Patch`;

	test("returns PatchInput[] shape directly", () => {
		const result = parseApplyPatch(wrap("*** Add File: foo.txt\n+hi"));
		expect(result).toEqual([{ path: "foo.txt", op: "create", diff: "hi\n" }]);
	});

	test("maps update with rename to op=update + rename field", () => {
		const result = parseApplyPatch(wrap("*** Update File: a.py\n*** Move to: b.py\n@@\n-old\n+new"));
		expect(result[0]).toMatchObject({ path: "a.py", op: "update", rename: "b.py" });
		expect(result[0].diff).toContain("-old");
	});

	test("zero-hunk patch returns empty array", () => {
		expect(parseApplyPatch(wrap(""))).toEqual([]);
	});

	test("heredoc wrapper with double quotes is stripped", () => {
		const inner = wrap("*** Add File: x.txt\n+content");
		const wrapped = `<<"EOF"\n${inner}\nEOF`;
		const result = parseApplyPatch(wrapped);
		expect(result).toHaveLength(1);
		expect(result[0].op).toBe("create");
	});

	test("heredoc wrapper with bare EOF is stripped", () => {
		const inner = wrap("*** Add File: x.txt\n+content");
		const wrapped = `<<EOF\n${inner}\nEOF`;
		expect(parseApplyPatch(wrapped)).toHaveLength(1);
	});

	test("mismatched heredoc quotes are not stripped", () => {
		const inner = wrap("*** Add File: x.txt\n+content");
		// `<<"EOF'` — opener has mismatched quotes; parser should not strip it,
		// so the begin-patch check fails.
		const bad = `<<"EOF'\n${inner}\nEOF`;
		expect(() => parseApplyPatch(bad)).toThrow(ParseError);
	});

	test("unknown file directive is rejected with spec message", () => {
		expect(() => parseApplyPatch(wrap("*** Rename File: a"))).toThrow(/is not a valid hunk header/);
	});

	test("preserves *** End of File marker inside update body", () => {
		const result = parseApplyPatch(wrap("*** Update File: a.py\n@@\n-x\n+y\n*** End of File"));
		expect(result[0].diff).toContain("*** End of File");
	});
});

describe("applyCodexPatch (production)", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = path.join(os.tmpdir(), `codex-patch-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		fs.mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		try {
			removeSyncWithRetries(tempDir);
		} catch {
			// ignore
		}
	});

	test("zero-hunk patch throws 'No files were modified.'", async () => {
		await expect(applyCodexPatch("*** Begin Patch\n*** End Patch", { cwd: tempDir })).rejects.toThrow(
			"No files were modified.",
		);
	});

	test("multi-op patch (add + update + delete) applies in order", async () => {
		await Bun.write(path.join(tempDir, "old.txt"), "to delete\n");
		await Bun.write(path.join(tempDir, "keep.txt"), "hello\n");

		const patch = [
			"*** Begin Patch",
			"*** Add File: new.txt",
			"+brand new",
			"*** Update File: keep.txt",
			"@@",
			"-hello",
			"+HELLO",
			"*** Delete File: old.txt",
			"*** End Patch",
		].join("\n");

		const result = await applyCodexPatch(patch, { cwd: tempDir });

		expect(result.affected.added).toEqual(["new.txt"]);
		expect(result.affected.modified).toEqual(["keep.txt"]);
		expect(result.affected.deleted).toEqual(["old.txt"]);

		expect(await Bun.file(path.join(tempDir, "new.txt")).text()).toBe("brand new\n");
		expect(await Bun.file(path.join(tempDir, "keep.txt")).text()).toBe("HELLO\n");
		expect(fs.existsSync(path.join(tempDir, "old.txt"))).toBe(false);
	});

	test("rename reports modified under original path (spec §9.1)", async () => {
		await Bun.write(path.join(tempDir, "src.txt"), "body\n");

		const patch = [
			"*** Begin Patch",
			"*** Update File: src.txt",
			"*** Move to: dst.txt",
			"@@",
			"-body",
			"+body2",
			"*** End Patch",
		].join("\n");

		const result = await applyCodexPatch(patch, { cwd: tempDir });

		expect(result.affected.modified).toEqual(["src.txt"]);
		expect(result.affected.added).toEqual([]);
		expect(result.affected.deleted).toEqual([]);
		expect(fs.existsSync(path.join(tempDir, "src.txt"))).toBe(false);
		expect(await Bun.file(path.join(tempDir, "dst.txt")).text()).toBe("body2\n");
	});

	test("partial success: earlier ops stay applied when a later op fails", async () => {
		await Bun.write(path.join(tempDir, "first.txt"), "a\n");

		const patch = [
			"*** Begin Patch",
			"*** Update File: first.txt",
			"@@",
			"-a",
			"+A",
			"*** Update File: missing.txt",
			"@@",
			"-x",
			"+y",
			"*** End Patch",
		].join("\n");

		await expect(applyCodexPatch(patch, { cwd: tempDir })).rejects.toThrow();

		// First op should have landed before the failure.
		expect(await Bun.file(path.join(tempDir, "first.txt")).text()).toBe("A\n");
	});

	// #4074-A: Add File / Move to must not silently overwrite pre-existing
	// destinations. The apply_patch grammar documents these as create/rename
	// with no overwrite affordance (see prompts/tools/apply-patch.md), and
	// the fs-level `applyPatch`, the envelope-level `applyCodexPatch`, and
	// their shared `applyNormalizedPatch` implementation share the guard.
	test("applyPatch create refuses to overwrite an existing file", async () => {
		const target = path.join(tempDir, "exists.txt");
		await Bun.write(target, "original\n");

		await expect(
			applyPatch({ path: "exists.txt", op: "create", diff: "replacement\n" }, { cwd: tempDir }),
		).rejects.toBeInstanceOf(ApplyPatchError);
		// Pre-existing content must remain byte-identical.
		expect(await Bun.file(target).text()).toBe("original\n");
	});

	test("applyPatch rename refuses to overwrite an existing destination", async () => {
		const src = path.join(tempDir, "src.txt");
		const dst = path.join(tempDir, "dst.txt");
		await Bun.write(src, "source\n");
		await Bun.write(dst, "destination\n");

		await expect(
			applyPatch(
				{ path: "src.txt", op: "update", rename: "dst.txt", diff: "@@\n-source\n+source2" },
				{ cwd: tempDir },
			),
		).rejects.toBeInstanceOf(ApplyPatchError);
		// Both source and destination must remain byte-identical.
		expect(await Bun.file(src).text()).toBe("source\n");
		expect(await Bun.file(dst).text()).toBe("destination\n");
	});

	test("applyCodexPatch *** Add File over existing file rejects and preserves content", async () => {
		const target = path.join(tempDir, "hello.txt");
		await Bun.write(target, "kept\n");

		const patch = ["*** Begin Patch", "*** Add File: hello.txt", "+overwritten", "*** End Patch"].join("\n");

		await expect(applyCodexPatch(patch, { cwd: tempDir })).rejects.toBeInstanceOf(ApplyPatchError);
		expect(await Bun.file(target).text()).toBe("kept\n");
	});

	test("applyCodexPatch *** Move to over existing destination rejects and preserves both files", async () => {
		const src = path.join(tempDir, "src.txt");
		const dst = path.join(tempDir, "dst.txt");
		await Bun.write(src, "hello\n");
		await Bun.write(dst, "will-be-preserved\n");

		const patch = [
			"*** Begin Patch",
			"*** Update File: src.txt",
			"*** Move to: dst.txt",
			"@@",
			"-hello",
			"+HELLO",
			"*** End Patch",
		].join("\n");

		await expect(applyCodexPatch(patch, { cwd: tempDir })).rejects.toBeInstanceOf(ApplyPatchError);
		expect(await Bun.file(src).text()).toBe("hello\n");
		expect(await Bun.file(dst).text()).toBe("will-be-preserved\n");
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// EditTool mode split: JSON `patch` create-as-overwrite vs envelope Add File
// ═══════════════════════════════════════════════════════════════════════════

describe("EditTool create-over-existing mode split", () => {
	let tempDir: string;

	function makeSession(cwd: string, editMode: "patch" | "apply_patch"): ToolSession {
		return {
			cwd,
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			enableLsp: false,
			settings: Settings.isolated({ "edit.mode": editMode }),
			getArtifactsDir: () => null,
			getSessionId: () => null,
			getPlanModeState: () => undefined,
		} as unknown as ToolSession;
	}

	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "omp-apply-patch-overwrite-"));
		await Settings.init({ inMemory: true, cwd: tempDir });
	});

	afterEach(() => {
		resetSettingsForTest();
		try {
			removeSyncWithRetries(tempDir);
		} catch {
			// Ignore cleanup errors
		}
	});

	// prompts/tools/patch.md sanctions full-file overwrite via `op: "create"`
	// (the JSON grammar has no `*** Update File`), so the envelope-only
	// clobber guard must not fire in JSON patch mode.
	test("JSON patch mode: op create over an existing file is a full-file overwrite", async () => {
		const target = path.join(tempDir, "exists.txt");
		await Bun.write(target, "original\n");
		const tool = new EditTool(makeSession(tempDir, "patch"));

		const result = await tool.execute("json-create-overwrite", {
			path: "exists.txt",
			edits: [{ op: "create", diff: "replacement\n" }],
		});

		expect(result.isError).toBeUndefined();
		expect(await Bun.file(target).text()).toBe("replacement\n");
	});

	test("apply_patch mode: *** Add File over an existing file still rejects", async () => {
		const target = path.join(tempDir, "exists.txt");
		await Bun.write(target, "original\n");
		const tool = new EditTool(makeSession(tempDir, "apply_patch"));

		const patch = ["*** Begin Patch", "*** Add File: exists.txt", "+replacement", "*** End Patch", ""].join("\n");

		await expect(tool.execute("envelope-create-reject", { input: patch })).rejects.toThrow(/already exists/);
		expect(await Bun.file(target).text()).toBe("original\n");
	});
});
