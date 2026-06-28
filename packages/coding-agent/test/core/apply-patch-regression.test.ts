/**
 * Regression tests for apply-patch behaviors.
 *
 * These tests verify that the edit/ module correctly implements features
 * that were identified as missing or regressed in other implementations.
 * Each test corresponds to a specific scenario from patchv2/TODO.md.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { applyPatch, findContextLine, seekSequence } from "@pk-nerdsaver-ai/pi-coding-agent/edit";
import { removeSyncWithRetries } from "@pk-nerdsaver-ai/pi-utils";

describe("regression: indentation adjustment for line-based replacements (2B)", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = path.join(os.tmpdir(), `regression-2b-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		fs.mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		removeSyncWithRetries(tempDir);
	});

	test("line-based patch adjusts indentation when fuzzy matching at different indent level", async () => {
		const filePath = path.join(tempDir, "indent.ts");
		// File has 4-space indentation
		await Bun.write(
			filePath,
			`class Example {
    constructor() {
        this.value = 1;
        this.name = "test";
    }
}
`,
		);

		// Patch uses 0 indentation - should be adjusted to match the 8-space indent in file
		await applyPatch(
			{
				path: "indent.ts",
				op: "update",
				diff: `@@ constructor() {
-this.value = 1;
-this.name = "test";
+this.value = 42;
+this.name = "updated";`,
			},
			{ cwd: tempDir },
		);

		const result = await Bun.file(filePath).text();
		expect(result).toContain("        this.value = 42;");
		expect(result).toContain('        this.name = "updated";');
	});

	test("multi-hunk patch adjusts indentation independently per hunk", async () => {
		const filePath = path.join(tempDir, "multi-indent.ts");
		await Bun.write(
			filePath,
			`function outer() {
  function inner1() {
    return 1;
  }
  function inner2() {
      return 2;
  }
}
`,
		);

		// Different indentation levels in file - each hunk should adjust independently
		await applyPatch(
			{
				path: "multi-indent.ts",
				op: "update",
				diff: `@@ function inner1() {
-return 1;
+return 10;
@@ function inner2() {
-return 2;
+return 20;`,
			},
			{ cwd: tempDir },
		);

		const result = await Bun.file(filePath).text();
		expect(result).toContain("    return 10;"); // 4 spaces for inner1
		expect(result).toContain("      return 20;"); // 6 spaces for inner2
	});
});

describe("regression: ambiguity detection for context-less hunks (2C)", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = path.join(os.tmpdir(), `regression-2c-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		fs.mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		removeSyncWithRetries(tempDir);
	});

	test("single-hunk simple diff rejects multiple occurrences", async () => {
		const filePath = path.join(tempDir, "dupe.txt");
		await Bun.write(filePath, "foo\nbar\nfoo\nbaz\n");

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

	test("multi-hunk context-less diff rejects ambiguous patterns", async () => {
		const filePath = path.join(tempDir, "multi-dupe.txt");
		// Each pattern appears twice
		await Bun.write(filePath, "aaa\nbbb\naaa\nccc\nbbb\nddd\n");

		// First hunk for "aaa" is ambiguous (appears at lines 1 and 3)
		await expect(
			applyPatch(
				{
					path: "multi-dupe.txt",
					op: "update",
					diff: "@@\n-aaa\n+AAA\n@@\n-ccc\n+CCC",
				},
				{ cwd: tempDir },
			),
		).rejects.toThrow(/2 occurrences/);
	});

	test("context lines disambiguate otherwise ambiguous patterns", async () => {
		const filePath = path.join(tempDir, "context-disambig.txt");
		await Bun.write(filePath, "header\nfoo\nbar\nmiddle\nfoo\nbaz\nfooter\n");

		// Context line "middle" disambiguates which "foo" to change
		await applyPatch(
			{
				path: "context-disambig.txt",
				op: "update",
				diff: "@@\n middle\n-foo\n+FOO",
			},
			{ cwd: tempDir },
		);

		expect(await Bun.file(filePath).text()).toBe("header\nfoo\nbar\nmiddle\nFOO\nbaz\nfooter\n");
	});
});

describe("regression: context search uses line hints (2D)", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = path.join(os.tmpdir(), `regression-2d-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		fs.mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		removeSyncWithRetries(tempDir);
	});

	test("unified diff line numbers help locate correct position", async () => {
		const filePath = path.join(tempDir, "hints.txt");
		// File with repeated function definitions
		await Bun.write(
			filePath,
			`function process() {
    return 1;
}

function process() {
    return 2;
}

function process() {
    return 3;
}
`,
		);

		// Use unified diff format with line hint to target the second process()
		await applyPatch(
			{
				path: "hints.txt",
				op: "update",
				diff: `@@ -5,3 +5,3 @@ function process() {
 function process() {
-    return 2;
+    return 200;
 }`,
			},
			{ cwd: tempDir },
		);

		const result = await Bun.file(filePath).text();
		expect(result).toContain("return 1;"); // First unchanged
		expect(result).toContain("return 200;"); // Second changed
		expect(result).toContain("return 3;"); // Third unchanged
	});

	test("line hint overrides context-only search when appropriate", async () => {
		const filePath = path.join(tempDir, "hint-priority.txt");
		await Bun.write(
			filePath,
			`# Section A
def helper():
    pass

# Section B
def helper():
    pass
`,
		);

		// Line hint points to Section B's helper (line 6)
		await applyPatch(
			{
				path: "hint-priority.txt",
				op: "update",
				diff: `@@ -6,2 +6,2 @@ def helper():
 def helper():
-    pass
+    return True`,
			},
			{ cwd: tempDir },
		);

		const result = await Bun.file(filePath).text();
		const lines = result.split("\n");
		expect(lines[2]).toBe("    pass"); // Section A unchanged
		expect(lines[6]).toBe("    return True"); // Section B changed
	});
});

describe("regression: insertion uses newStartLine fallback (2E)", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = path.join(os.tmpdir(), `regression-2e-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		fs.mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		removeSyncWithRetries(tempDir);
	});

	test("pure addition with context uses context to find insertion point", async () => {
		const filePath = path.join(tempDir, "insert.txt");
		await Bun.write(filePath, "line1\nline2\nline3\n");

		// Insert after line1 using context
		await applyPatch(
			{
				path: "insert.txt",
				op: "update",
				diff: `@@
 line1
+inserted`,
			},
			{ cwd: tempDir },
		);

		expect(await Bun.file(filePath).text()).toBe("line1\ninserted\nline2\nline3\n");
	});

	test("pure addition with line hint inserts at correct position", async () => {
		const filePath = path.join(tempDir, "insert-hint.txt");
		await Bun.write(filePath, "aaa\nbbb\nccc\n");

		// Use unified diff format line hints to insert at specific location
		await applyPatch(
			{
				path: "insert-hint.txt",
				op: "update",
				diff: `@@ -2,1 +2,2 @@
 bbb
+inserted after bbb`,
			},
			{ cwd: tempDir },
		);

		expect(await Bun.file(filePath).text()).toBe("aaa\nbbb\ninserted after bbb\nccc\n");
	});

	test("insertion at end of file works correctly", async () => {
		const filePath = path.join(tempDir, "append.txt");
		await Bun.write(filePath, "first\nsecond\n");

		await applyPatch(
			{
				path: "append.txt",
				op: "update",
				diff: `@@
+appended line
*** End of File`,
			},
			{ cwd: tempDir },
		);

		expect(await Bun.file(filePath).text()).toBe("first\nsecond\nappended line\n");
	});
});

describe("regression: seekSequence character-based fallback (2F)", () => {
	test("seekSequence falls back to character-based matching when line-based fails", () => {
		// Lines with subtle differences that line-based fuzzy matching might miss
		const lines = [
			"function calculateTotal(items) {",
			"  let sum = 0;",
			"  for (const item of items) {",
			"    sum += item.price * item.quantity;",
			"  }",
			"  return sum;",
			"}",
		];

		// Pattern has minor differences: extra space, different quote style
		const pattern = [
			"  for (const item of items)  {", // extra space before {
			"    sum += item.price*item.quantity;", // no spaces around *
		];

		const result = seekSequence(lines, pattern, 0, false);
		expect(result.index).toBe(2);
		expect(result.confidence).toBeGreaterThan(0.9);
	});

	test("seekSequence handles normalized unicode matching", () => {
		const lines = ['const message = "Hello – World";', "console.log(message);"];

		// Pattern uses ASCII dash instead of en-dash
		const pattern = ['const message = "Hello - World";'];

		const result = seekSequence(lines, pattern, 0, false);
		expect(result.index).toBe(0);
	});

	test("seekSequence finds pattern with whitespace differences", () => {
		const lines = ["  function   foo()  {", "    return   42;", "  }"];

		// Pattern has normalized whitespace
		const pattern = ["function foo() {", "return 42;"];

		const result = seekSequence(lines, pattern, 0, false);
		expect(result.index).toBe(0);
	});
});

describe("regression: findContextLine progressive matching (2D related)", () => {
	test("finds exact context line", () => {
		const lines = ["function foo() {", "  return 1;", "}"];
		const result = findContextLine(lines, "function foo() {", 0);
		expect(result.index).toBe(0);
		expect(result.confidence).toBe(1.0);
	});

	test("finds context line with whitespace differences", () => {
		const lines = ["  function foo()  {", "  return 1;", "}"];
		const result = findContextLine(lines, "function foo() {", 0);
		expect(result.index).toBe(0);
		expect(result.confidence).toBeGreaterThan(0.9);
	});

	test("finds context line with unicode normalization", () => {
		const lines = ['const msg = "Hello – World";', "return msg;"];
		// ASCII dash in pattern, en-dash in content
		const result = findContextLine(lines, 'const msg = "Hello - World";', 0);
		expect(result.index).toBe(0);
	});

	test("finds context line as prefix match", () => {
		const lines = ["function calculateTotalWithTax(items, taxRate) {", "  return 0;", "}"];
		// Partial function name matches as prefix
		const result = findContextLine(lines, "function calculateTotalWithTax(items", 0);
		expect(result.index).toBe(0);
		expect(result.confidence).toBeGreaterThan(0.9);
	});

	test("finds context line as substring match", () => {
		// Substring must be at least 6 chars and 30% of line length
		const lines = ["// comment: calculateTotal here", "function foo() {}"];
		const result = findContextLine(lines, "calculateTotal", 0);
		expect(result.index).toBe(0);
		expect(result.confidence).toBeGreaterThan(0.9);
	});

	test("falls back to fuzzy match for similar lines", () => {
		const lines = ["functoin calclateTotal(itms) {", "  return 0;", "}"];
		// Typos in content, correct in pattern
		const result = findContextLine(lines, "function calculateTotal(items) {", 0);
		expect(result.index).toBe(0);
		expect(result.confidence).toBeGreaterThan(0.8);
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// Plan: Make `@@` Context Matching Robust - Expected Behaviors
// These tests document expected behaviors from the plan. Some may fail if
// the feature is not yet implemented.
// ═══════════════════════════════════════════════════════════════════════════

describe("plan: partial line matching for @@ context", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = path.join(os.tmpdir(), `plan-partial-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		fs.mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		removeSyncWithRetries(tempDir);
	});

	test("@@ context matches when actual line contains it as substring", async () => {
		const filePath = path.join(tempDir, "imports.ts");
		// Actual line has more content than the @@ context
		await Bun.write(
			filePath,
			'import { mkdirSync, unlinkSync } from "node:fs";\n\nfunction cleanup() {\n  unlinkSync("temp");\n}\n',
		);

		// @@ context is a partial match (substring of actual line)
		await applyPatch(
			{
				path: "imports.ts",
				op: "update",
				diff: `@@ import { mkdirSync, unlinkSync }

 function cleanup() {
-  unlinkSync("temp");
+  rmSync("temp", { recursive: true });`,
			},
			{ cwd: tempDir },
		);

		const result = await Bun.file(filePath).text();
		expect(result).toContain('rmSync("temp", { recursive: true });');
	});

	test("@@ context matches function signature even with trailing content", async () => {
		const filePath = path.join(tempDir, "funcs.ts");
		await Bun.write(
			filePath,
			`function processItems(items: Item[], options?: Options): Result {
  return items.map(i => i.value);
}
`,
		);

		// @@ has partial function signature
		await applyPatch(
			{
				path: "funcs.ts",
				op: "update",
				diff: `@@ function processItems(items
-  return items.map(i => i.value);
+  return items.filter(i => i.valid).map(i => i.value);`,
			},
			{ cwd: tempDir },
		);

		expect(await Bun.file(filePath).text()).toContain("filter(i => i.valid)");
	});
});

describe("plan: unified diff format line numbers", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = path.join(os.tmpdir(), `plan-unified-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		fs.mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		removeSyncWithRetries(tempDir);
	});

	test("@@ -10,6 +10,7 @@ is parsed as line numbers not literal text", async () => {
		const filePath = path.join(tempDir, "lines.txt");
		// Create file with 15 lines
		const lines = Array.from({ length: 15 }, (_, i) => `line ${i + 1}`);
		await Bun.write(filePath, `${lines.join("\n")}\n`);

		// Use unified diff format to target line 10
		await applyPatch(
			{
				path: "lines.txt",
				op: "update",
				diff: `@@ -10,3 +10,3 @@
 line 10
-line 11
+LINE ELEVEN
 line 12`,
			},
			{ cwd: tempDir },
		);

		const result = await Bun.file(filePath).text();
		expect(result).toContain("LINE ELEVEN");
		expect(result).toContain("line 10"); // unchanged
		expect(result).toContain("line 12"); // unchanged
	});

	test("unified diff line numbers take precedence over context search", async () => {
		const filePath = path.join(tempDir, "repeat.txt");
		// Same pattern appears at lines 3 and 8
		await Bun.write(
			filePath,
			`header
line 2
target line
line 4
line 5
line 6
line 7
target line
line 9
`,
		);

		// Line hint says line 8, should change second "target line"
		await applyPatch(
			{
				path: "repeat.txt",
				op: "update",
				diff: `@@ -8,1 +8,1 @@
-target line
+MODIFIED TARGET`,
			},
			{ cwd: tempDir },
		);

		const result = await Bun.file(filePath).text();
		const lines = result.split("\n");
		expect(lines[2]).toBe("target line"); // First unchanged
		expect(lines[7]).toBe("MODIFIED TARGET"); // Second changed
	});
});

describe("plan: Codex-style wrapped patches", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = path.join(os.tmpdir(), `plan-codex-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		fs.mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		removeSyncWithRetries(tempDir);
	});

	test("strips *** Begin Patch / *** End Patch wrapper", async () => {
		const filePath = path.join(tempDir, "wrapped.txt");
		await Bun.write(filePath, "old content\n");

		// Full Codex-style wrapper - the diff inside should be extracted
		await applyPatch(
			{
				path: "wrapped.txt",
				op: "update",
				diff: `*** Begin Patch
@@
-old content
+new content
*** End Patch`,
			},
			{ cwd: tempDir },
		);

		expect(await Bun.file(filePath).text()).toBe("new content\n");
	});

	test("strips partial wrapper (only *** End Patch)", async () => {
		const filePath = path.join(tempDir, "partial.txt");
		await Bun.write(filePath, "original\n");

		// Only end marker present
		await applyPatch(
			{
				path: "partial.txt",
				op: "update",
				diff: `@@
-original
+modified
*** End Patch`,
			},
			{ cwd: tempDir },
		);

		expect(await Bun.file(filePath).text()).toBe("modified\n");
	});

	test("strips bare *** terminator (model hallucination)", async () => {
		const filePath = path.join(tempDir, "bare-asterisk.txt");
		await Bun.write(filePath, "line1\nline2\nline3\n");

		// Model sometimes outputs just *** as end marker
		await applyPatch(
			{
				path: "bare-asterisk.txt",
				op: "update",
				diff: `@@
-line2
+LINE TWO
***`,
			},
			{ cwd: tempDir },
		);

		expect(await Bun.file(filePath).text()).toBe("line1\nLINE TWO\nline3\n");
	});

	test("strips bare *** terminator in multi-hunk diff", async () => {
		const filePath = path.join(tempDir, "multi-hunk-asterisk.txt");
		await Bun.write(filePath, "aaa\nbbb\nccc\nddd\n");

		// Multiple hunks with *** terminator at end
		await applyPatch(
			{
				path: "multi-hunk-asterisk.txt",
				op: "update",
				diff: `@@
-aaa
+AAA
@@
-ccc
+CCC
***`,
			},
			{ cwd: tempDir },
		);

		expect(await Bun.file(filePath).text()).toBe("AAA\nbbb\nCCC\nddd\n");
	});

	test("strips bare *** at beginning of diff", async () => {
		const filePath = path.join(tempDir, "leading-asterisk.txt");
		await Bun.write(filePath, "old\n");

		await applyPatch(
			{
				path: "leading-asterisk.txt",
				op: "update",
				diff: `***
@@
-old
+new`,
			},
			{ cwd: tempDir },
		);

		expect(await Bun.file(filePath).text()).toBe("new\n");
	});

	test("strips unified diff metadata lines", async () => {
		const filePath = path.join(tempDir, "unified-meta.txt");
		await Bun.write(filePath, "first\nsecond\nthird\n");

		// Full unified diff format with metadata
		await applyPatch(
			{
				path: "unified-meta.txt",
				op: "update",
				diff: `diff --git a/unified-meta.txt b/unified-meta.txt
index abc123..def456 100644
--- a/unified-meta.txt
+++ b/unified-meta.txt
@@ -1,3 +1,3 @@
 first
-second
+SECOND
 third`,
			},
			{ cwd: tempDir },
		);

		expect(await Bun.file(filePath).text()).toBe("first\nSECOND\nthird\n");
	});
});

describe("plan: strip + prefix from file creation", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = path.join(os.tmpdir(), `plan-create-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		fs.mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		removeSyncWithRetries(tempDir);
	});

	test("create file strips + prefix when all lines have it", async () => {
		await applyPatch(
			{
				path: "newfile.txt",
				op: "create",
				diff: `+line one
+line two
+line three`,
			},
			{ cwd: tempDir },
		);

		expect(await Bun.file(path.join(tempDir, "newfile.txt")).text()).toBe("line one\nline two\nline three\n");
	});

	test("create file strips + space prefix", async () => {
		await applyPatch(
			{
				path: "spaced.txt",
				op: "create",
				diff: `+ first line
+ second line`,
			},
			{ cwd: tempDir },
		);

		expect(await Bun.file(path.join(tempDir, "spaced.txt")).text()).toBe("first line\nsecond line\n");
	});

	test("create file preserves content when not all lines have + prefix", async () => {
		await applyPatch(
			{
				path: "mixed.txt",
				op: "create",
				diff: `+line one
regular line
+line three`,
			},
			{ cwd: tempDir },
		);

		// Should preserve as-is since not all lines have +
		expect(await Bun.file(path.join(tempDir, "mixed.txt")).text()).toBe("+line one\nregular line\n+line three\n");
	});
});

describe("regression: *** End of File marker handling (2A/2G)", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = path.join(os.tmpdir(), `regression-eof-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		fs.mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		removeSyncWithRetries(tempDir);
	});

	test("*** End of File marker is preserved in hunk parsing", async () => {
		const filePath = path.join(tempDir, "eof.txt");
		await Bun.write(filePath, "line1\nline2\nlast line\n");

		await applyPatch(
			{
				path: "eof.txt",
				op: "update",
				diff: `@@
-last line
+modified last line
*** End of File`,
			},
			{ cwd: tempDir },
		);

		expect(await Bun.file(filePath).text()).toBe("line1\nline2\nmodified last line\n");
	});

	test("EOF marker targets end of file for pattern matching", async () => {
		const filePath = path.join(tempDir, "eof-target.txt");
		// Pattern appears twice - EOF should target the last one
		await Bun.write(filePath, "item\nmore content\nitem\n");

		await applyPatch(
			{
				path: "eof-target.txt",
				op: "update",
				diff: `@@
-item
+FINAL ITEM
*** End of File`,
			},
			{ cwd: tempDir },
		);

		const result = await Bun.file(filePath).text();
		expect(result).toBe("item\nmore content\nFINAL ITEM\n");
	});
});

// ═══════════════════════════════════════════════════════════════════════════
// Regression: Model edit attempts that failed due to parser limitations
// These tests document real model behaviors that we want to recover from.
// Session: 2026-01-19T08-29-03-476Z_v0FEI1ixUrlssLyHL3TT3.jsonl
// ═══════════════════════════════════════════════════════════════════════════

describe("regression: model edit attempt - @@ line N syntax (session 2026-01-19)", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = path.join(os.tmpdir(), `model-line-n-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		fs.mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		removeSyncWithRetries(tempDir);
	});

	test("@@ line 125 is parsed as line hint, not literal context search", async () => {
		const filePath = path.join(tempDir, "settings.ts");
		// Create file with enough lines - the target is around line 125
		const lines: string[] = [];
		for (let i = 1; i <= 130; i++) {
			if (i === 125) {
				lines.push("\tfuzzyMatch?: boolean; // default: true");
			} else if (i === 126) {
				lines.push("\tfuzzyThreshold?: number; // default: 0.95");
			} else if (i === 127) {
				lines.push("\tpatchMode?: boolean; // default: false");
			} else if (i === 128) {
				lines.push("}");
			} else {
				lines.push(`// line ${i}`);
			}
		}
		await Bun.write(filePath, `${lines.join("\n")}\n`);

		// Model's actual attempt: used @@ line 125 as anchor
		await applyPatch(
			{
				path: "settings.ts",
				op: "update",
				diff: `@@ line 125
 	fuzzyMatch?: boolean; // default: true
 	fuzzyThreshold?: number; // default: 0.95
-	patchMode?: boolean; // default: false
+	patchMode?: boolean; // default: true
 }`,
			},
			{ cwd: tempDir },
		);

		const result = await Bun.file(filePath).text();
		expect(result).toContain("patchMode?: boolean; // default: true");
		expect(result).not.toContain("patchMode?: boolean; // default: false");
	});
});

describe("regression: model edit attempt - nested @@ anchors (session 2026-01-19)", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = path.join(os.tmpdir(), `model-nested-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		fs.mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		removeSyncWithRetries(tempDir);
	});

	test("@@ class X followed by @@   method on next line is parsed as nested anchors", async () => {
		const filePath = path.join(tempDir, "patch.ts");
		await Bun.write(
			filePath,
			`class OtherTool {
	constructor(session: ToolSession) {
		this.session = session;
		this.mode = false;
	}
}

class PatchTool {
	constructor(session: ToolSession) {
		this.session = session;
		this.patchMode = session.xyz(false);
		this.allowFuzzy = true;
	}
}
`,
		);

		// Model's actual attempt: multi-line @@ anchors
		await applyPatch(
			{
				path: "patch.ts",
				op: "update",
				diff: `@@ class PatchTool
@@   constructor
 	constructor(session: ToolSession) {
 		this.session = session;
-		this.patchMode = session.xyz(false);
+		this.patchMode = session.xyz(true);
 		this.allowFuzzy = true;`,
			},
			{ cwd: tempDir },
		);

		const result = await Bun.file(filePath).text();
		// Should change PatchTool's constructor, not OtherTool's
		expect(result).toContain("this.patchMode = session.xyz(true);");
		expect(result).toContain("this.mode = false;"); // OtherTool unchanged
	});

	test("nested @@ anchors disambiguate between multiple matching methods", async () => {
		const filePath = path.join(tempDir, "multi-class.ts");
		await Bun.write(
			filePath,
			`class Alpha {
	process() {
		return "alpha";
	}
}

class Beta {
	process() {
		return "beta";
	}
}
`,
		);

		await applyPatch(
			{
				path: "multi-class.ts",
				op: "update",
				diff: `@@ class Beta
@@   process
 	process() {
-		return "beta";
+		return "BETA";
 	}`,
			},
			{ cwd: tempDir },
		);

		const result = await Bun.file(filePath).text();
		expect(result).toContain('return "alpha"'); // Alpha unchanged
		expect(result).toContain('return "BETA"'); // Beta changed
	});
});

describe("regression: model edit attempt - space-separated anchors (session 2026-01-19)", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = path.join(os.tmpdir(), `model-space-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		fs.mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		removeSyncWithRetries(tempDir);
	});

	test("@@ class PatchTool constructor is parsed as hierarchical anchors", async () => {
		const filePath = path.join(tempDir, "tool.ts");
		await Bun.write(
			filePath,
			`class OtherTool {
	constructor() {
		this.value = 1;
	}
}

class PatchTool {
	constructor() {
		this.value = 2;
	}
}
`,
		);

		// Model's actual attempt: space-separated anchors
		await applyPatch(
			{
				path: "tool.ts",
				op: "update",
				diff: `@@ class PatchTool constructor
 	constructor() {
-		this.value = 2;
+		this.value = 200;
 	}`,
			},
			{ cwd: tempDir },
		);

		const result = await Bun.file(filePath).text();
		expect(result).toContain("this.value = 1;"); // OtherTool unchanged
		expect(result).toContain("this.value = 200;"); // PatchTool changed
	});

	test("space-separated anchors work with function keyword", async () => {
		const filePath = path.join(tempDir, "funcs.ts");
		await Bun.write(
			filePath,
			`function outer() {
	function helper() {
		return 1;
	}
	return helper();
}

function process() {
	function helper() {
		return 2;
	}
	return helper();
}
`,
		);

		await applyPatch(
			{
				path: "funcs.ts",
				op: "update",
				diff: `@@ function process helper
 	function helper() {
-		return 2;
+		return 200;
 	}`,
			},
			{ cwd: tempDir },
		);

		const result = await Bun.file(filePath).text();
		expect(result).toContain("return 1;"); // outer's helper unchanged
		expect(result).toContain("return 200;"); // process's helper changed
	});
});

describe("regression: model edit attempt - unique substring on long line (session 2026-01-19 #2)", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = path.join(os.tmpdir(), `model-long-line-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		fs.mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		removeSyncWithRetries(tempDir);
	});

	test("@@ class ClassName matches long export line when unique", async () => {
		const filePath = path.join(tempDir, "tool.ts");
		// Real-world pattern: long line with export, implements, generics
		await Bun.write(
			filePath,
			`import { Something } from "somewhere";

export class EditTool implements AgentTool<typeof replaceEditSchema | typeof patchEditSchema, EditToolDetails> {
	public readonly name = "edit";

	constructor(session: ToolSession) {
		this.session = session;
		this.patchMode = false;
	}
}
`,
		);

		// Model's actual attempt: used "class EditTool" which is only ~12% of line length
		await applyPatch(
			{
				path: "tool.ts",
				op: "update",
				diff: `@@ class EditTool
 	constructor(session: ToolSession) {
 		this.session = session;
-		this.patchMode = false;
+		this.patchMode = true;
 	}`,
			},
			{ cwd: tempDir },
		);

		const result = await Bun.file(filePath).text();
		expect(result).toContain("this.patchMode = true;");
	});

	test("@@ class ClassName falls back to unique old lines when context is ambiguous", async () => {
		const filePath = path.join(tempDir, "multi.ts");
		await Bun.write(
			filePath,
			`export class EditTool implements AgentTool<Schema1, Details1> {
	value = 1;
}

export class EditTool implements AgentTool<Schema2, Details2> {
	value = 2;
}
`,
		);

		await applyPatch(
			{
				path: "multi.ts",
				op: "update",
				diff: `@@ class EditTool
-	value = 1;
+	value = 100;`,
			},
			{ cwd: tempDir },
		);

		const result = await Bun.file(filePath).text();
		expect(result).toContain("value = 100;");
		expect(result).toContain("value = 2;");
	});
});

describe("regression: bench edit failures (2026-01-19)", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = path.join(os.tmpdir(), `bench-regression-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		fs.mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		removeSyncWithRetries(tempDir);
	});

	test("@@ @@ is treated as empty context", async () => {
		const filePath = path.join(tempDir, "empty-context.txt");
		await Bun.write(filePath, "alpha\nbeta\ngamma\n");

		await applyPatch(
			{
				path: "empty-context.txt",
				op: "update",
				diff: `@@ @@\n-beta\n+BETA`,
			},
			{ cwd: tempDir },
		);

		expect(await Bun.file(filePath).text()).toBe("alpha\nBETA\ngamma\n");
	});

	test.each([
		["@@ line 3 @@", 3],
		["@@ lines 3-5", 3],
		["@@ Line 3-5", 3],
		["@@ line 3-5 @@", 3],
		["@@ @@ line 3", 3],
	])("line hint variants (%s) target the correct line", async (header: string, targetLine: number) => {
		const filePath = path.join(tempDir, `line-hint-${targetLine}.txt`);
		await Bun.write(filePath, "line 1\nline 2\nline 3\nline 4\nline 5\n");

		await applyPatch(
			{
				path: `line-hint-${targetLine}.txt`,
				op: "update",
				diff: `${header}\n-line 3\n+LINE THREE`,
			},
			{ cwd: tempDir },
		);

		const lines = (await Bun.file(filePath).text()).split("\n");
		expect(lines[2]).toBe("LINE THREE");
	});

	test("top of file header anchors to line 1", async () => {
		const filePath = path.join(tempDir, "top-of-file.txt");
		await Bun.write(filePath, "first\nsecond\n");

		await applyPatch(
			{
				path: "top-of-file.txt",
				op: "update",
				diff: "@@ top of file\n-first\n+FIRST",
			},
			{ cwd: tempDir },
		);

		expect(await Bun.file(filePath).text()).toBe("FIRST\nsecond\n");
	});

	test("function name with empty params matches signature", async () => {
		const filePath = path.join(tempDir, "functions.ts");
		await Bun.write(
			filePath,
			`function retryIfBlockedOn(reason: string) {\n  return reason;\n}\n\nfunction describeNode(node: object) {\n  return String(node);\n}\n`,
		);

		await applyPatch(
			{
				path: "functions.ts",
				op: "update",
				diff: "@@ retryIfBlockedOn()\n-  return reason;\n+  return reason.toUpperCase();",
			},
			{ cwd: tempDir },
		);

		await applyPatch(
			{
				path: "functions.ts",
				op: "update",
				diff: "@@ describeNode()\n-  return String(node);\n+  return JSON.stringify(node);",
			},
			{ cwd: tempDir },
		);

		const result = await Bun.file(filePath).text();
		expect(result).toContain("return reason.toUpperCase();");
		expect(result).toContain("return JSON.stringify(node);");
	});

	test("label context falls back to unique old lines", async () => {
		const filePath = path.join(tempDir, "imports.js");
		await Bun.write(
			filePath,
			`import { startLoggingProfilingEvents, stopLoggingProfilingEvents } from "../SchedulerProfiling";\n\nexport function run() {\n  return startLoggingProfilingEvents();\n}\n`,
		);

		await applyPatch(
			{
				path: "imports.js",
				op: "update",
				diff: '@@ import block\n-import { startLoggingProfilingEvents, stopLoggingProfilingEvents } from "../SchedulerProfiling";\n+import { stopLoggingProfilingEvents, startLoggingProfilingEvents } from "../SchedulerProfiling";',
			},
			{ cwd: tempDir },
		);

		expect(await Bun.file(filePath).text()).toContain(
			'import { stopLoggingProfilingEvents, startLoggingProfilingEvents } from "../SchedulerProfiling";',
		);
	});

	test("ambiguous @@ context resolves via unique old lines", async () => {
		const filePath = path.join(tempDir, "ambiguous.ts");
		await Bun.write(
			filePath,
			`function getState() {\n  return 1;\n}\n\nfunction getState() {\n  return 2;\n}\n\nfunction getState() {\n  return 3;\n}\n`,
		);

		await applyPatch(
			{
				path: "ambiguous.ts",
				op: "update",
				diff: "@@ function getState() {\n-  return 2;\n+  return 200;",
			},
			{ cwd: tempDir },
		);

		const result = await Bun.file(filePath).text();
		expect(result).toContain("return 1;");
		expect(result).toContain("return 200;");
		expect(result).toContain("return 3;");
	});

	test("duplicate context lines collapse for matching", async () => {
		const filePath = path.join(tempDir, "duplicate-context.txt");
		await Bun.write(filePath, "alpha\nbeta\ngamma\n");

		await applyPatch(
			{
				path: "duplicate-context.txt",
				op: "update",
				diff: "@@\n alpha\n beta\n beta\n-gamma\n+GAMMA",
			},
			{ cwd: tempDir },
		);

		expect(await Bun.file(filePath).text()).toBe("alpha\nbeta\nGAMMA\n");
	});

	test("repeated context blocks collapse when duplicated", async () => {
		const filePath = path.join(tempDir, "repeated-block.txt");
		await Bun.write(filePath, "if (ready) {\n  handle();\n}\n");

		await applyPatch(
			{
				path: "repeated-block.txt",
				op: "update",
				diff: "@@\n if (ready) {\n  handle();\n}\n if (ready) {\n  handle();\n}\n-  handle();\n+  handleNext();",
			},
			{ cwd: tempDir },
		);

		expect(await Bun.file(filePath).text()).toBe("if (ready) {\n  handleNext();\n}\n");
	});

	test("shared prefix/suffix context is trimmed when mismatched", async () => {
		const filePath = path.join(tempDir, "trim-context.txt");
		await Bun.write(filePath, "function doThing() {\n  return 1;\n}\n");

		await applyPatch(
			{
				path: "trim-context.txt",
				op: "update",
				diff: "@@\n // NOTE: helper\n function doThing() {\n-  return 1;\n+  return 2;\n }",
			},
			{ cwd: tempDir },
		);

		expect(await Bun.file(filePath).text()).toBe("function doThing() {\n  return 2;\n}\n");
	});

	test("single-line change fallback uses the unique changed line", async () => {
		const filePath = path.join(tempDir, "single-line-change.txt");
		await Bun.write(filePath, "function getState() {\n  return 1;\n}\n\nfunction getState() {\n  return 2;\n}\n");

		await applyPatch(
			{
				path: "single-line-change.txt",
				op: "update",
				diff: "@@ function getState() {\n  return 2;\n-  return 2;\n+  return 200;\n  return 2;",
			},
			{ cwd: tempDir },
		);

		const result = await Bun.file(filePath).text();
		expect(result).toContain("return 1;");
		expect(result).toContain("return 200;");
	});

	test("implicit context lines without prefixes are accepted", async () => {
		const filePath = path.join(tempDir, "implicit-context.ts");
		await Bun.write(
			filePath,
			`function getMousePosition(\n  relativeContainer: null,\n  mouseEvent: SyntheticMouseEvent,\n) {\n  if (relativeContainer !== null) {\n    return initialTooltipState;\n  }\n}\n`,
		);

		await applyPatch(
			{
				path: "implicit-context.ts",
				op: "update",
				diff: `@@ function getMousePosition(\nrelativeContainer: null,\nmouseEvent: SyntheticMouseEvent,\n) {\n-  if (relativeContainer !== null) {\n+  if (relativeContainer === null) {\n     return initialTooltipState;\n   }`,
			},
			{ cwd: tempDir },
		);

		expect(await Bun.file(filePath).text()).toContain("if (relativeContainer === null)");
	});

	test("context lines preserve original file indentation when fuzzy matched", async () => {
		const filePath = path.join(tempDir, "context-indent.js");
		// File has 4-space indentation throughout the table
		await Bun.write(
			filePath,
			`export function describeWithPointerEvent(message, describeFn) {
  const pointerEvent = 'PointerEvent';
  const fallback = 'MouseEvent/TouchEvent';
  describe.each\`
    value    | name
    $true  | $pointerEvent
    $true | $fallback
  \`(\`\${message}: $name\`, entry => {
    const hasPointerEvents = entry.value;
    setPointerEvent(hasPointerEvents);
    describeFn(hasPointerEvents);
  });
}
`,
		);

		// Model provides diff with 3-space indentation in context lines (one less than file)
		// The changed line should be fixed, but context lines should NOT be modified
		await applyPatch(
			{
				path: "context-indent.js",
				op: "update",
				diff: `@@ describe.each\`
   value    | name
   $true  | $pointerEvent
-   $true | $fallback
+   $false | $fallback
  \`(\`\${message}: $name\`, entry => {`,
			},
			{ cwd: tempDir },
		);

		const result = await Bun.file(filePath).text();
		// The changed line should have correct value (false instead of true)
		expect(result).toContain("$false | $fallback");
		// Context lines should preserve original 4-space indentation, not become 3-space
		expect(result).toContain("    value    | name");
		expect(result).toContain("    $true  | $pointerEvent");
	});

	test("duplicate context lines are resolved via adjacent match to @@ anchor", async () => {
		const filePath = path.join(tempDir, "ReactFlightDOMClientNode.js");
		await Bun.write(
			filePath,
			`const handleEnd = () => {
  if (--streamEndedCount === 2) {
    cleanup();
  }
  if (--streamEndedCount === 2) {
    finalize();
  }
};
`,
		);

		await applyPatch(
			{
				path: "ReactFlightDOMClientNode.js",
				op: "update",
				diff: `@@     const handleEnd = () => {
       if (--streamEndedCount === 2) {
-      if (--streamEndedCount === 2) {
+      if (++streamEndedCount === 2) {`,
			},
			{ cwd: tempDir },
		);

		const result = await Bun.file(filePath).text();
		const lines = result.split("\n");
		expect(lines[1]).toContain("--streamEndedCount");
		expect(lines[4]).toContain("++streamEndedCount");
	});

	test("strip line-number prefixes from diff content", async () => {
		const filePath = path.join(tempDir, "line-numbers.txt");
		await Bun.write(
			filePath,
			`Permission is hereby granted, free of charge\nA copy of this software and associated docs\nThe above copyright notice\n`,
		);

		await applyPatch(
			{
				path: "line-numbers.txt",
				op: "update",
				diff: "@@\n 1\tPermission is hereby granted, free of charge\n- 2\tA copy of this software and associated docs\n+ 2\tA copy of this software AND associated docs\n 3\tThe above copyright notice",
			},
			{ cwd: tempDir },
		);

		const result = await Bun.file(filePath).text();
		expect(result).toContain("A copy of this software AND associated docs");
	});

	test("ellipsis placeholder lines are ignored during matching", async () => {
		const filePath = path.join(tempDir, "ellipsis.ts");
		await Bun.write(
			filePath,
			`function progress(done: boolean, value: string) {\n  if (done) {\n    return;\n  }\n  const buffer = value;\n  return buffer;\n}\n`,
		);

		await applyPatch(
			{
				path: "ellipsis.ts",
				op: "update",
				diff: "@@ function progress\n  if (done) {\n    return;\n  }\n...\n-  const buffer = value;\n+  const buffer = value.toUpperCase();",
			},
			{ cwd: tempDir },
		);

		expect(await Bun.file(filePath).text()).toContain("const buffer = value.toUpperCase();");
	});

	test("context anchor retryIfBlockedOn() matches signature without params", async () => {
		const filePath = path.join(tempDir, "context-anchor.ts");
		await Bun.write(filePath, `function retryIfBlockedOn(reason: string, blockedOn: mixed) {\n  return reason;\n}\n`);

		await applyPatch(
			{
				path: "context-anchor.ts",
				op: "update",
				diff: "@@ retryIfBlockedOn()\n-  return reason;\n+  return reason.toUpperCase();",
			},
			{ cwd: tempDir },
		);

		expect(await Bun.file(filePath).text()).toContain("return reason.toUpperCase();");
	});

	test("ambiguous context falls back to unique old lines", async () => {
		const filePath = path.join(tempDir, "ambiguous-context.ts");
		await Bun.write(
			filePath,
			`function getState() {\n  return 1;\n}\n\nfunction getState() {\n  return 2;\n}\n\nfunction getState() {\n  return 3;\n}\n`,
		);

		await applyPatch(
			{
				path: "ambiguous-context.ts",
				op: "update",
				diff: "@@ function getState() {\n-  return 2;\n+  return 200;",
			},
			{ cwd: tempDir },
		);

		const result = await Bun.file(filePath).text();
		expect(result).toContain("return 1;");
		expect(result).toContain("return 200;");
		expect(result).toContain("return 3;");
	});

	test("comment-prefix mismatches still match expected lines", async () => {
		const filePath = path.join(tempDir, "comment-prefix.txt");
		await Bun.write(
			filePath,
			`/*\n * LICENSE file in the root directory.\n * Copyright (c) Meta Platforms, Inc.\n */\n`,
		);

		await applyPatch(
			{
				path: "comment-prefix.txt",
				op: "update",
				diff: "@@\n-/ LICENSE file in the root directory.\n+ / LICENSE file in the root directory.\n",
			},
			{ cwd: tempDir },
		);

		expect(await Bun.file(filePath).text()).toContain("/ LICENSE file in the root directory.");
	});

	test("context-less fuzzy match applies even with spacing differences", async () => {
		const filePath = path.join(tempDir, "fuzzy-contextless.ts");
		await Bun.write(filePath, "const value = computeTotal(items);\n");

		await applyPatch(
			{
				path: "fuzzy-contextless.ts",
				op: "update",
				diff: "-const value=computeTotal(items);\n+const value = calculateTotal(items);",
			},
			{ cwd: tempDir },
		);

		expect(await Bun.file(filePath).text()).toContain("calculateTotal");
	});

	test("@@ header without space is accepted", async () => {
		const filePath = path.join(tempDir, "header-nospace.ts");
		await Bun.write(filePath, `const value = 1;\nconst other = 2;\n`);

		await applyPatch(
			{
				path: "header-nospace.ts",
				op: "update",
				diff: "@@const value = 1;\n-const value = 1;\n+const value = 100;",
			},
			{ cwd: tempDir },
		);

		expect(await Bun.file(filePath).text()).toContain("const value = 100;");
	});
});

describe("regression: trailing context lines don't delete file content", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = path.join(os.tmpdir(), `trailing-context-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		fs.mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		removeSyncWithRetries(tempDir);
	});

	test("context lines cannot cause collateral deletion via fuzzy match", async () => {
		const filePath = path.join(tempDir, "file.ts");
		// File has extra content between what the diff shows as context
		await Bun.write(
			filePath,
			`function outer() {
  function inner() {
    // This is an important comment
    return 1;
  }
}
`,
		);

		// Diff shows context that skips the comment - should this fail or work?
		// The expected behavior is: match the context lines, only delete - lines
		// Since there are no - lines between inner() and return 1, nothing should be deleted
		await applyPatch(
			{
				path: "file.ts",
				op: "update",
				diff: `@@ function outer
 function outer() {
   function inner() {
-    return 1;
+    return 42;
   }
 }`,
			},
			{ cwd: tempDir },
		);

		const result = await Bun.file(filePath).text();
		expect(result).toContain("return 42;");
		// The comment should still be there!
		expect(result).toContain("// This is an important comment");
	});

	test("unprefixed blank line between changes and trailing context", async () => {
		const filePath = path.join(tempDir, "terminal.ts");
		await Bun.write(
			filePath,
			`export class Example {
	private field = false;

	get value(): boolean {
		return this.field;
	}
}
`,
		);

		// Blank line has NO prefix (model might emit this)
		// The implementation treats unprefixed blank lines as context
		await applyPatch(
			{
				path: "terminal.ts",
				op: "update",
				diff: `@@ export class Example
 export class Example {
 	private field = false;
+	private other = true;

 	get value(): boolean {`,
			},
			{ cwd: tempDir },
		);

		const result = await Bun.file(filePath).text();
		expect(result).toContain("private other = true;");
		expect(result).toContain("return this.field;");
	});

	test("two-hunk diff with trailing getter context preserves getter body", async () => {
		const filePath = path.join(tempDir, "terminal.ts");
		await Bun.write(
			filePath,
			`export class ProcessTerminal implements Terminal {
	private wasRaw = false;
	private inputHandler?: (data: string) => void;
	private resizeHandler?: () => void;
	private _kittyProtocolActive = false;
	private stdinBuffer?: StdinBuffer;
	private stdinDataHandler?: (data: string) => void;

	get kittyProtocolActive(): boolean {
		return this._kittyProtocolActive;
	}

	private safeWrite(data: string): void {
		try {
			process.stdout.write(data);
		} catch (err) {
			// EIO means terminal is dead - exit gracefully instead of crashing
			if (err && typeof err === "object" && (err as { code?: string }).code === "EIO") {
				process.exit(1);
			}
			throw err;
		}
	}
}
`,
		);

		await applyPatch(
			{
				path: "terminal.ts",
				op: "update",
				diff: `@@ export class ProcessTerminal implements Terminal {
 export class ProcessTerminal implements Terminal {
 \tprivate wasRaw = false;
 \tprivate inputHandler?: (data: string) => void;
 \tprivate resizeHandler?: () => void;
 \tprivate _kittyProtocolActive = false;
 \tprivate stdinBuffer?: StdinBuffer;
 \tprivate stdinDataHandler?: (data: string) => void;
+\tprivate dead = false;
 
 \tget kittyProtocolActive(): boolean {

@@ private safeWrite(data: string): void {
 \tprivate safeWrite(data: string): void {
+\t\tif (this.dead) return;
 \t\ttry {
 \t\t\tprocess.stdout.write(data);
 \t\t} catch (err) {
-\t\t\t// EIO means terminal is dead - exit gracefully instead of crashing
+\t\t\t// EIO means terminal is dead - mark dead and skip all future writes
 \t\t\tif (err && typeof err === "object" && (err as { code?: string }).code === "EIO") {
-\t\t\t\tprocess.exit(1);
+\t\t\t\tthis.dead = true;
+\t\t\t\treturn;
 \t\t\t}
 \t\t\tthrow err;
 \t\t}
 \t}`,
			},
			{ cwd: tempDir },
		);

		const result = await Bun.file(filePath).text();
		expect(result).toContain("private dead = false;");
		expect(result).toContain("return this._kittyProtocolActive;");
		expect(result).toContain("if (this.dead) return;");
		expect(result).toContain("mark dead and skip all future writes");
		expect(result).toContain("this.dead = true;");
	});

	test("context anchor duplicated as first context line preserves file content", async () => {
		const filePath = path.join(tempDir, "terminal.ts");
		// Original file - exact structure from user's report
		await Bun.write(
			filePath,
			`export class ProcessTerminal implements Terminal {
	private wasRaw = false;
	private inputHandler?: (data: string) => void;
	private resizeHandler?: () => void;
	private _kittyProtocolActive = false;
	private stdinBuffer?: StdinBuffer;
	private stdinDataHandler?: (data: string) => void;

	get kittyProtocolActive(): boolean {
		return this._kittyProtocolActive;
	}
}
`,
		);

		// The anchor line and first context line are IDENTICAL
		// This is the exact pattern from the user's failing case
		await applyPatch(
			{
				path: "terminal.ts",
				op: "update",
				diff: `@@ export class ProcessTerminal implements Terminal {
 export class ProcessTerminal implements Terminal {
 	private wasRaw = false;
 	private inputHandler?: (data: string) => void;
 	private resizeHandler?: () => void;
 	private _kittyProtocolActive = false;
 	private stdinBuffer?: StdinBuffer;
 	private stdinDataHandler?: (data: string) => void;
+	private dead = false;

 	get kittyProtocolActive(): boolean {`,
			},
			{ cwd: tempDir },
		);

		const result = await Bun.file(filePath).text();
		expect(result).toContain("private dead = false;");
		expect(result).toContain("return this._kittyProtocolActive;");
	});

	test("adding field with getter as trailing context preserves getter body", async () => {
		const filePath = path.join(tempDir, "terminal.ts");
		// Original file has a getter with a body
		await Bun.write(
			filePath,
			`export class ProcessTerminal {
	private _kittyProtocolActive = false;
	private stdinDataHandler?: (data: string) => void;

	get kittyProtocolActive(): boolean {
		return this._kittyProtocolActive;
	}
}
`,
		);

		// Hunk adds a new field, with getter declaration as trailing context
		// The getter body should NOT be affected
		await applyPatch(
			{
				path: "terminal.ts",
				op: "update",
				diff: `@@ export class ProcessTerminal
 export class ProcessTerminal {
 	private _kittyProtocolActive = false;
 	private stdinDataHandler?: (data: string) => void;
+	private dead = false;

 	get kittyProtocolActive(): boolean {`,
			},
			{ cwd: tempDir },
		);

		const result = await Bun.file(filePath).text();
		// The new field should be added
		expect(result).toContain("private dead = false;");
		// The getter body should still be there!
		expect(result).toContain("return this._kittyProtocolActive;");
	});
});

describe("regression: context-only hunks between @@ markers must not change indentation (agent-session.ts)", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = path.join(os.tmpdir(), `regression-ctx-noop-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		fs.mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		removeSyncWithRetries(tempDir);
	});

	test("pure context hunk (no +/- lines) does not alter tab-indented file content", async () => {
		const filePath = path.join(tempDir, "agent-session.ts");
		// Actual file uses tab indentation (\t\t for method body).
		// Pre-patch state: three callsites lack `await`.
		const fileContent = [
			"class AgentSession {",
			"\tasync newSession(options?: NewSessionOptions): Promise<boolean> {",
			"\t\tconst previousSessionFile = this.sessionFile;",
			"",
			"\t\tthis._disconnectFromAgent();",
			"\t\tawait this.abort();",
			"\t\tthis.agent.reset();",
			"\t\tawait this.sessionManager.flush();",
			"\t\tthis.sessionManager.newSession(options);",
			"\t\tthis.agent.sessionId = this.sessionManager.getSessionId();",
			"\t\tthis._steeringMessages = [];",
			"\t\tthis._followUpMessages = [];",
			"\t\tthis._pendingNextTurnMessages = [];",
			"\t}",
			"}",
			"",
		].join("\n");
		await Bun.write(filePath, fileContent);

		// Exact patch from the regression case (spaces in diff, tabs in file).
		// The lines between the first @@ and second @@ are pure context.
		const diff = [
			"@@",
			"         async newSession(options?: NewSessionOptions): Promise<boolean> {",
			"             const previousSessionFile = this.sessionFile;",
			"@@",
			"             this._disconnectFromAgent();",
			"             await this.abort();",
			"             this.agent.reset();",
			"             await this.sessionManager.flush();",
			"-            this.sessionManager.newSession(options);",
			"+            await this.sessionManager.newSession(options);",
			"             this.agent.sessionId = this.sessionManager.getSessionId();",
			"             this._steeringMessages = [];",
			"             this._followUpMessages = [];",
			"             this._pendingNextTurnMessages = [];",
		].join("\n");

		await applyPatch({ path: "agent-session.ts", op: "update", diff }, { cwd: tempDir });

		const result = await Bun.file(filePath).text();
		// The change should be applied
		expect(result).toContain("\t\tawait this.sessionManager.newSession(options);");
		// Lines covered by the pure-context hunk must keep their original tab indentation
		expect(result).toContain("\tasync newSession(options?: NewSessionOptions): Promise<boolean> {");
		expect(result).toContain("\t\tconst previousSessionFile = this.sessionFile;");
		expect(result).toContain("\t\tthis._disconnectFromAgent();");
	});

	test("space-to-tab conversion with offset (ax+b model)", async () => {
		const filePath = path.join(tempDir, "offset.ts");
		// File uses tabs: 1 tab for class body, 2 tabs for method body, 3 for nested
		const fileContent = [
			"class Foo {",
			"\tbar() {",
			"\t\tif (true) {",
			"\t\t\tthis.x = 1;",
			"\t\t}",
			"\t}",
			"}",
			"",
		].join("\n");
		await Bun.write(filePath, fileContent);

		// Model rendered tabs as 3 cols with 1 extra offset:
		// 1 tab -> 4 spaces, 2 tabs -> 7 spaces, 3 tabs -> 10 spaces
		// => width=3, offset=1
		const diff = [
			"@@ class Foo {",
			"     bar() {",
			"-       if (true) {",
			"-          this.x = 1;",
			"+       if (ready) {",
			"+          this.x = 42;",
			"        }",
		].join("\n");

		await applyPatch({ path: "offset.ts", op: "update", diff }, { cwd: tempDir });

		const result = await Bun.file(filePath).text();
		expect(result).toContain("\t\tif (ready) {");
		expect(result).toContain("\t\t\tthis.x = 42;");
		// Unchanged lines must keep tabs
		expect(result).toContain("\tbar() {");
	});
});
