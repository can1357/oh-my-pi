import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ApplyPatchError, applyPatch } from "@pk-nerdsaver-ai/pi-coding-agent/edit";
import { removeSyncWithRetries } from "@pk-nerdsaver-ai/pi-utils";

describe("applyPatch adversarial inputs", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = path.join(os.tmpdir(), `apply-patch-adversarial-${Date.now()}-${Math.random().toString(36).slice(2)}`);
		fs.mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		try {
			removeSyncWithRetries(tempDir);
		} catch {
			// Ignore cleanup errors
		}
	});

	test("rejects rename when it matches path", async () => {
		const filePath = path.join(tempDir, "same.txt");
		await Bun.write(filePath, "foo\n");

		await expect(
			applyPatch({ path: "same.txt", op: "update", rename: "same.txt", diff: "@@\n-foo\n+bar" }, { cwd: tempDir }),
		).rejects.toThrow(ApplyPatchError);

		expect(await Bun.file(filePath).text()).toBe("foo\n");
	});

	test("respects changeContext for pure additions", async () => {
		const filePath = path.join(tempDir, "add-context.ts");
		await Bun.write(filePath, "function foo() {\n  return 1;\n}\nfunction bar() {\n  return 2;\n}\n");

		await applyPatch(
			{
				path: "add-context.ts",
				op: "update",
				diff: "@@ function bar\n+  console.log('x');",
			},
			{ cwd: tempDir },
		);

		expect(await Bun.file(filePath).text()).toBe(
			"function foo() {\n  return 1;\n}\nfunction bar() {\n  console.log('x');\n  return 2;\n}\n",
		);
	});

	test("rejects multi-file patch markers in a single-file update", async () => {
		const filePath = path.join(tempDir, "single.txt");
		await Bun.write(filePath, "foo\nbar\n");

		await expect(
			applyPatch(
				{
					path: "single.txt",
					op: "update",
					diff: "*** Begin Patch\n*** Update File: single.txt\n@@\n-foo\n+FOO\n*** Update File: other.txt\n@@\n-bar\n+BAR\n*** End Patch",
				},
				{ cwd: tempDir },
			),
		).rejects.toThrow(ApplyPatchError);
	});

	test("preserves context lines that look like diff metadata", async () => {
		const filePath = path.join(tempDir, "metadata-context.txt");
		await Bun.write(filePath, "diff --git a b\nalpha\nmid\ndiff --git a b\nalpha\n");

		await applyPatch(
			{
				path: "metadata-context.txt",
				op: "update",
				diff: "@@\n diff --git a b\n-alpha\n+ALPHA",
			},
			{ cwd: tempDir },
		);

		expect(await Bun.file(filePath).text()).toBe("diff --git a b\nALPHA\nmid\ndiff --git a b\nalpha\n");
	});

	test("applies hunks regardless of order", async () => {
		const filePath = path.join(tempDir, "order.txt");
		await Bun.write(filePath, "first\nkeep\nsecond\nkeep\n");

		await applyPatch(
			{
				path: "order.txt",
				op: "update",
				diff: "@@ second\n-keep\n+KEEP2\n@@ first\n-keep\n+KEEP1",
			},
			{ cwd: tempDir },
		);

		expect(await Bun.file(filePath).text()).toBe("first\nKEEP1\nsecond\nKEEP2\n");
	});

	test("rejects ambiguous changeContext matches", async () => {
		const filePath = path.join(tempDir, "ambiguous-context.ts");
		await Bun.write(filePath, "if (a) {\n  return foo;\n}\nif (b) {\n  return foo;\n}\n");

		await expect(
			applyPatch(
				{
					path: "ambiguous-context.ts",
					op: "update",
					diff: "@@ return foo;\n-  return foo;\n+  return bar;",
				},
				{ cwd: tempDir },
			),
		).rejects.toThrow(ApplyPatchError);
	});

	test("rejects ambiguous prefix/substring matches", async () => {
		const filePath = path.join(tempDir, "ambiguous-prefix.ts");
		await Bun.write(filePath, "const enabled = true;\nconst enabled = true; // secondary\n");

		await expect(
			applyPatch(
				{
					path: "ambiguous-prefix.ts",
					op: "update",
					diff: "@@\n-const enabled = true\n+const enabled = false",
				},
				{ cwd: tempDir },
			),
		).rejects.toThrow(ApplyPatchError);
	});

	test("rejects out-of-range line hints for insertions", async () => {
		const filePath = path.join(tempDir, "line-hint.txt");
		await Bun.write(filePath, "a\nb\n");

		await expect(
			applyPatch(
				{
					path: "line-hint.txt",
					op: "update",
					diff: "@@ -999,0 +999,1 @@\n+tail",
				},
				{ cwd: tempDir },
			),
		).rejects.toThrow(ApplyPatchError);
	});

	test("retains trailing blank context lines for disambiguation", async () => {
		const filePath = path.join(tempDir, "blank-context.txt");
		await Bun.write(filePath, "section\nvalue\nx\nsection\nvalue\n\n");

		await applyPatch(
			{
				path: "blank-context.txt",
				op: "update",
				diff: "@@\n section\n-value\n+VALUE\n ",
			},
			{ cwd: tempDir },
		);

		expect(await Bun.file(filePath).text()).toBe("section\nvalue\nx\nsection\nVALUE\n\n");
	});

	test("fuzzy under-indented context can shift indentation", async () => {
		const filePath = path.join(tempDir, "under-indent.ts");
		await Bun.write(
			filePath,
			"function sum(values, offset) {\n" +
				"  let total = 0;\n" +
				"  for (const value of values) {\n" +
				"    total += value + offset;\n" +
				"    total += 1;\n" +
				"  }\n" +
				"  return total + 1;\n" +
				"}\n",
		);

		await applyPatch(
			{
				path: "under-indent.ts",
				op: "update",
				diff:
					"@@ -1,6 +1,7 @@\n" +
					" function sum(values, offset) {\n" +
					"-let total = 0;\n" +
					"-for (const value of values) {\n" +
					"+let total = 0;\n" +
					'+  const tag = "sum";\n' +
					"+for (const value of values) {\n" +
					"     total += value + offset;\n" +
					"     total += 1;\n" +
					"   }\n",
			},
			{ cwd: tempDir },
		);

		expect(await Bun.file(filePath).text()).toBe(
			"function sum(values, offset) {\n" +
				"  let total = 0;\n" +
				'  const tag = "sum";\n' +
				"  for (const value of values) {\n" +
				"    total += value + offset;\n" +
				"    total += 1;\n" +
				"  }\n" +
				"  return total + 1;\n" +
				"}\n",
		);
	});

	test("preserves CRLF endings and trailing newline", async () => {
		const filePath = path.join(tempDir, "crlf.txt");
		await Bun.write(filePath, "foo\r\nbar\r\n");

		await applyPatch({ path: "crlf.txt", op: "update", diff: "@@\n-foo\n+FOO" }, { cwd: tempDir });

		const content = await Bun.file(filePath).text();
		expect(content).toBe("FOO\r\nbar\r\n");
	});

	test("preserves UTF-8 BOM and CRLF endings", async () => {
		const filePath = path.join(tempDir, "bom.txt");
		fs.writeFileSync(filePath, "\uFEFFfoo\r\nbar\r\n");

		await applyPatch({ path: "bom.txt", op: "update", diff: "@@\n-foo\n+FOO" }, { cwd: tempDir });

		const content = fs.readFileSync(filePath, "utf-8");
		expect(content).toBe("\uFEFFFOO\r\nbar\r\n");
	});

	test("preserves missing trailing newline", async () => {
		const filePath = path.join(tempDir, "nonewline.txt");
		await Bun.write(filePath, "foo\nbar");

		await applyPatch({ path: "nonewline.txt", op: "update", diff: "@@\n-bar\n+baz" }, { cwd: tempDir });

		const content = await Bun.file(filePath).text();
		expect(content).toBe("foo\nbaz");
	});

	test("normalizes tab-indented diff to space-indented file", async () => {
		const filePath = path.join(tempDir, "tabs-to-spaces.js");
		// File uses 4-space indentation
		await Bun.write(
			filePath,
			`class Foo {
    method() {
        const x = 1;
        return x;
    }
}
`,
		);

		// Diff uses tab indentation (common LLM output)
		await applyPatch(
			{
				path: "tabs-to-spaces.js",
				op: "update",
				diff: "@@ method() {\n\tmethod() {\n\t\tconst x = 1;\n+\t\tconsole.log(x);\n\t\treturn x;",
			},
			{ cwd: tempDir },
		);

		const content = await Bun.file(filePath).text();
		// Added line should use spaces, not tabs
		expect(content).toBe(`class Foo {
    method() {
        const x = 1;
        console.log(x);
        return x;
    }
}
`);
		// Verify no tabs were introduced
		expect(content).not.toContain("\t");
	});

	test("preserves indentation when trailing context has less indent than additions", async () => {
		const filePath = path.join(tempDir, "dedent-context.js");
		await Bun.write(
			filePath,
			`class Foo {
    method() {
    }
}
`,
		);

		// Trailing context ` }` has less indentation than added lines
		await applyPatch(
			{
				path: "dedent-context.js",
				op: "update",
				diff: "@@\n     method() {\n     }\n+\n+    other() {\n+        return 1;\n+    }\n }",
			},
			{ cwd: tempDir },
		);

		const content = await Bun.file(filePath).text();
		// The closing brace of other() should have 4-space indent, not 0
		expect(content).toBe(`class Foo {
    method() {
    }

    other() {
        return 1;
    }
}
`);
	});
});
