import { describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { adaptSchemaForStrict, toolWireSchema } from "@oh-my-pi/pi-ai/utils/schema";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ToolChoiceQueue } from "@oh-my-pi/pi-coding-agent/session/tool-choice-queue";
import { createTools, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import * as natives from "@oh-my-pi/pi-natives";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

type InvokedToolResult = {
	content: Array<{ type: string; text?: string }>;
	details?: unknown;
	isError?: boolean;
};

function createTestSession(cwd = "/tmp/test", overrides: Partial<ToolSession> = {}): ToolSession {
	return {
		cwd,
		hasUI: true,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		// xdev mounting (default-on) would unmount the discoverable ast_edit
		// into xd://; these tests need it in the returned toolset.
		settings: Settings.isolated({ "tools.xdev": false }),
		...overrides,
	};
}

function asSchemaObject(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("Expected object schema");
	}
	return value as Record<string, unknown>;
}

function mockRewriteMatches(rewriteMatches: readonly natives.AstReplaceRuleMatch[]) {
	const astEdit = natives.astEdit;
	return spyOn(natives, "astEdit").mockImplementation(async options => ({
		...(await astEdit(options)),
		rewriteMatches: [...rewriteMatches],
	}));
}

function mockLegacyAstEditResult() {
	const astEdit = natives.astEdit;
	return spyOn(natives, "astEdit").mockImplementation(async options => {
		const { rewriteMatches: _rewriteMatches, ...legacyResult } = await astEdit(options);
		return legacyResult as natives.AstReplaceResult;
	});
}

describe("ast_edit tool schema", () => {
	it("uses op entries as [{ pat, out }]", async () => {
		const tools = await createTools(createTestSession(), ["ast_edit"]);
		const tool = tools.find(entry => entry.name === "ast_edit");
		expect(tool).toBeDefined();
		const schema = toolWireSchema(tool!);
		const properties = asSchemaObject(schema.properties);
		const ops = asSchemaObject(properties.ops);

		expect(ops.type).toBe("array");
		const items = asSchemaObject(ops.items);
		expect(items.type).toBe("object");
		expect(items.required).toEqual(["pat", "out"]);
		const itemProperties = asSchemaObject(items.properties);
		expect(asSchemaObject(itemProperties.pat).type).toBe("string");
		expect(asSchemaObject(itemProperties.out).type).toBe("string");
		expect(asSchemaObject(properties.selector).type).toBe("string");
		expect(properties.preview).toBeUndefined();
	});

	it("remains strict-representable after strict adaptation", async () => {
		const tools = await createTools(createTestSession(), ["ast_edit"]);
		const tool = tools.find(entry => entry.name === "ast_edit");
		expect(tool).toBeDefined();
		const schema = toolWireSchema(tool!);

		const strict = adaptSchemaForStrict(schema, true);
		expect(strict.strict).toBe(true);
	});

	it("rejects contextual selectors on multi-operation calls", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ast-edit-selector-batch-"));
		try {
			const filePath = path.join(tempDir, "Example.php");
			await Bun.write(filePath, "<?php\nclass Example { public function greet() {} }\n");
			const tools = await createTools(createTestSession(tempDir), ["ast_edit"]);
			const tool = tools.find(entry => entry.name === "ast_edit");
			expect(tool).toBeDefined();

			await expect(
				tool!.execute("ast-edit-selector-batch", {
					ops: [
						{
							pat: "class $_ { public function $NAME($$$ARGS) { $$$BODY } }",
							out: "protected function $NAME($$$ARGS) { $$$BODY }",
						},
						{ pat: "legacy($ARG)", out: "modern($ARG)" },
					],
					paths: [filePath],
					selector: "method_declaration",
				}),
			).rejects.toThrow("`selector` requires exactly one operation");
		} finally {
			await removeWithRetries(tempDir);
		}
	});

	it("guides zero-match PHP member patterns to safe contextual selection", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ast-edit-php-member-"));
		const pattern = "public function $NAME($$$ARGS) { $$$BODY }";
		const astEditSpy = mockRewriteMatches([{ pattern, language: "php", count: 0 }]);
		try {
			const filePath = path.join(tempDir, "Example.php");
			await Bun.write(
				filePath,
				`<?php
class Example {
	public function greet($name) {
		return $name;
	}
	public function keep() {
		return "keep";
	}
}
`,
			);

			const queue = new ToolChoiceQueue();
			const tools = await createTools(
				createTestSession(tempDir, {
					getToolChoiceQueue: () => queue,
					buildToolChoice: () => ({ type: "tool" as const, name: "resolve" }),
					steer: () => {},
				}),
				["ast_edit"],
			);
			const tool = tools.find(entry => entry.name === "ast_edit");
			expect(tool).toBeDefined();

			const result = await tool!.execute("ast-edit-php-member", {
				ops: [
					{
						pat: pattern,
						out: "protected function $NAME($$$ARGS) { $$$BODY }",
					},
				],
				paths: [filePath],
			});
			const text = result.content.find(content => content.type === "text")?.text ?? "";
			const details = result.details as { totalReplacements?: number; patternHint?: string } | undefined;

			expect(details?.totalReplacements).toBe(0);
			expect(details?.patternHint).toContain("selector");
			expect(text).toContain("class $_ { … }");
			expect(text).toContain("method_declaration");

			const previewResult = await tool!.execute("ast-edit-php-member-context", {
				ops: [
					{
						pat: "class $_ { public function $NAME($$$ARGS) { $$$BODY } }",
						out: "protected function $NAME($$$ARGS) { $$$BODY }",
					},
				],
				paths: [filePath],
				selector: "method_declaration",
			});
			const previewText = previewResult.content.find(content => content.type === "text")?.text ?? "";
			expect((previewResult.details as { totalReplacements?: number }).totalReplacements).toBe(2);
			expect(previewText).toContain("public function greet");
			expect(previewText).not.toContain("class Example");

			const invoker = queue.peekPendingInvoker()!;
			const applyResult = (await invoker({
				action: "apply",
				reason: "apply safely selected PHP member edits",
			})) as InvokedToolResult;
			expect(applyResult.isError).toBeUndefined();
			const updated = await Bun.file(filePath).text();
			expect(updated).toContain("class Example {");
			expect(updated).toContain("protected function greet");
			expect(updated).toContain("protected function keep");
			expect(updated).not.toContain("public function");
		} finally {
			astEditSpy.mockRestore();
			await removeWithRetries(tempDir);
		}
	});

	it("guides attribute-prefixed PHP member patterns to contextual selection", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ast-edit-php-attributed-member-"));
		const pattern = '#[Route(path: "/items/[id]")]\nfunction $NAME($$$ARGS) { $$$BODY }';
		const astEditSpy = mockRewriteMatches([{ pattern, language: "php", count: 0 }]);
		try {
			const filePath = path.join(tempDir, "Example.php");
			await Bun.write(
				filePath,
				`<?php
class Example {
	#[Route(path: "/items/[id]")]
	function greet($value) { return $value; }
}
`,
			);
			const tools = await createTools(createTestSession(tempDir), ["ast_edit"]);
			const tool = tools.find(entry => entry.name === "ast_edit");
			expect(tool).toBeDefined();

			const result = await tool!.execute("ast-edit-php-attributed-member", {
				ops: [{ pat: pattern, out: "function renamed($$$ARGS) { $$$BODY }" }],
				paths: [filePath],
			});
			const details = result.details as { totalReplacements?: number; patternHint?: string } | undefined;
			const text = result.content.find(content => content.type === "text")?.text ?? "";

			expect(details?.totalReplacements).toBe(0);
			expect(details?.patternHint).toContain("method_declaration");
			expect(text).toContain("class $_ { … }");
		} finally {
			astEditSpy.mockRestore();
			await removeWithRetries(tempDir);
		}
	});

	it("surfaces PHP member guidance when another batch rewrite matches", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ast-edit-php-batch-"));
		const memberPattern = "function $NAME($$$ARGS) { $$$BODY }";
		const astEditSpy = mockRewriteMatches([
			{ pattern: memberPattern, language: "php", count: 0 },
			{ pattern: "legacy($ARG)", language: "php", count: 1 },
		]);
		try {
			const filePath = path.join(tempDir, "Example.php");
			await Bun.write(
				filePath,
				`<?php
legacy($value);
class Example {
	public function greet($name) {
		return $name;
	}
}
`,
			);

			const tools = await createTools(createTestSession(tempDir), ["ast_edit"]);
			const tool = tools.find(entry => entry.name === "ast_edit");
			expect(tool).toBeDefined();

			const result = await tool!.execute("ast-edit-php-batch", {
				ops: [
					{
						pat: memberPattern,
						out: "protected function $NAME($$$ARGS) { $$$BODY }",
					},
					{ pat: "legacy($ARG)", out: "modern($ARG)" },
				],
				paths: [filePath],
			});
			const text = result.content.find(content => content.type === "text")?.text ?? "";
			const details = result.details as { totalReplacements?: number; patternHint?: string } | undefined;

			expect(details?.totalReplacements).toBe(1);
			expect(details?.patternHint).toContain("method_declaration");
			expect(text).toContain("modern($value)");
			expect(text).toContain("method_declaration");
		} finally {
			astEditSpy.mockRestore();
			await removeWithRetries(tempDir);
		}
	});

	it("does not let a JavaScript match suppress missing PHP member guidance", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ast-edit-php-mixed-language-"));
		const pattern = "function $NAME($$$ARGS) { $$$BODY }";
		const astEditSpy = mockRewriteMatches([
			{ pattern, language: "javascript", count: 1 },
			{ pattern, language: "php", count: 0 },
		]);
		try {
			await Bun.write(path.join(tempDir, "functions.js"), "function greet(value) { return value; }\n");
			await Bun.write(
				path.join(tempDir, "Example.php"),
				"<?php\nclass Example { function greet($value) { return $value; } }\n",
			);
			const tools = await createTools(createTestSession(tempDir), ["ast_edit"]);
			const tool = tools.find(entry => entry.name === "ast_edit");
			expect(tool).toBeDefined();

			const result = await tool!.execute("ast-edit-php-mixed-language", {
				ops: [{ pat: pattern, out: "function renamed($$$ARGS) { $$$BODY }" }],
				paths: [tempDir],
			});
			const details = result.details as { totalReplacements?: number; patternHint?: string } | undefined;

			expect(details?.totalReplacements).toBe(1);
			expect(details?.patternHint).toContain("method_declaration");
			expect(astEditSpy).toHaveBeenCalledTimes(1);
		} finally {
			astEditSpy.mockRestore();
			await removeWithRetries(tempDir);
		}
	});

	it("does not show PHP guidance for a zero-match TypeScript function pattern", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ast-edit-non-php-function-"));
		try {
			const filePath = path.join(tempDir, "functions.ts");
			await Bun.write(filePath, "const value = 1;\n");
			const tools = await createTools(createTestSession(tempDir), ["ast_edit"]);
			const tool = tools.find(entry => entry.name === "ast_edit");
			expect(tool).toBeDefined();

			const result = await tool!.execute("ast-edit-typescript-function", {
				ops: [
					{
						pat: "function $NAME($$$ARGS) { $$$BODY }",
						out: "function renamed($$$ARGS) { $$$BODY }",
					},
				],
				paths: [filePath],
			});
			const details = result.details as { totalReplacements?: number; patternHint?: string } | undefined;
			const text = result.content.find(content => content.type === "text")?.text ?? "";

			expect(details?.totalReplacements).toBe(0);
			expect(details?.patternHint).toBeUndefined();
			expect(text).not.toContain("method_declaration");
		} finally {
			await removeWithRetries(tempDir);
		}
	});

	it("does not flag a modifierless PHP pattern that matches a top-level function", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ast-edit-php-function-"));
		try {
			const filePath = path.join(tempDir, "functions.php");
			await Bun.write(filePath, "<?php\nfunction greet($name) { return $name; }\n");
			const tools = await createTools(createTestSession(tempDir), ["ast_edit"]);
			const tool = tools.find(entry => entry.name === "ast_edit");
			expect(tool).toBeDefined();

			const result = await tool!.execute("ast-edit-php-function", {
				ops: [
					{
						pat: "function greet($$$ARGS) { $$$BODY }",
						out: "function renamed($$$ARGS) { $$$BODY }",
					},
				],
				paths: [filePath],
			});
			const details = result.details as { totalReplacements?: number; patternHint?: string } | undefined;
			const text = result.content.find(content => content.type === "text")?.text ?? "";

			expect(details?.totalReplacements).toBe(1);
			expect(details?.patternHint).toBeUndefined();
			expect(text).toContain("function renamed");
			expect(text).not.toContain("method_declaration");
		} finally {
			await removeWithRetries(tempDir);
		}
	});

	it("scans a matching multi-member batch only once", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ast-edit-php-multi-member-"));
		const astEditSpy = spyOn(natives, "astEdit");
		try {
			const filePath = path.join(tempDir, "functions.php");
			await Bun.write(
				filePath,
				"<?php\nfunction first($value) { return $value; }\nfunction second($value) { return $value; }\n",
			);
			const tools = await createTools(createTestSession(tempDir), ["ast_edit"]);
			const tool = tools.find(entry => entry.name === "ast_edit");
			expect(tool).toBeDefined();

			const result = await tool!.execute("ast-edit-php-multi-member", {
				ops: [
					{
						pat: "function first($$$ARGS) { $$$BODY }",
						out: "function renamedFirst($$$ARGS) { $$$BODY }",
					},
					{
						pat: "function second($$$ARGS) { $$$BODY }",
						out: "function renamedSecond($$$ARGS) { $$$BODY }",
					},
				],
				paths: [filePath],
			});
			const details = result.details as { totalReplacements?: number; patternHint?: string } | undefined;

			expect(details?.totalReplacements).toBe(2);
			expect(details?.patternHint).toBeUndefined();
			expect(astEditSpy).toHaveBeenCalledTimes(1);
		} finally {
			astEditSpy.mockRestore();
			await removeWithRetries(tempDir);
		}
	});

	it("accepts the previous native result shape without failing ordinary rewrites", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ast-edit-legacy-native-result-"));
		const astEditSpy = mockLegacyAstEditResult();
		try {
			const filePath = path.join(tempDir, "legacy.ts");
			await Bun.write(filePath, "legacy(value);\n");
			const tools = await createTools(createTestSession(tempDir), ["ast_edit"]);
			const tool = tools.find(entry => entry.name === "ast_edit");
			expect(tool).toBeDefined();

			const result = await tool!.execute("ast-edit-legacy-native-result", {
				ops: [{ pat: "legacy($ARG)", out: "modern($ARG)" }],
				paths: [filePath],
			});
			const details = result.details as { totalReplacements?: number; patternHint?: string } | undefined;
			const text = result.content.find(content => content.type === "text")?.text ?? "";

			expect(result.isError).toBeUndefined();
			expect(details?.totalReplacements).toBe(1);
			expect(details?.patternHint).toBeUndefined();
			expect(text).toContain("modern(value)");
		} finally {
			astEditSpy.mockRestore();
			await removeWithRetries(tempDir);
		}
	});

	it("renders +/- lines with numbered hashline prefixes", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ast-edit-render-"));
		try {
			const filePath = path.join(tempDir, "legacy.ts");
			await Bun.write(filePath, "legacyWrap(x, value)\n");

			const tools = await createTools(createTestSession(tempDir), ["ast_edit"]);
			const tool = tools.find(entry => entry.name === "ast_edit");
			expect(tool).toBeDefined();

			const result = await tool!.execute("ast-edit-test", {
				ops: [{ pat: "legacyWrap($A, $B)", out: "modernWrap($A, $B)" }],
				paths: [filePath],
			});
			const text = result.content.find(content => content.type === "text")?.text ?? "";
			const lines = text.split("\n");
			const removedLine = lines.find(line => line.startsWith("-"));
			const addedLine = lines.find(line => line.startsWith("+"));

			expect(removedLine).toBeDefined();
			expect(addedLine).toBeDefined();
			expect(removedLine).toMatch(/^-\d+:/);
			expect(addedLine).toMatch(/^\+\d+:/);
			expect(removedLine?.split(":", 1)[0].length).toBe(addedLine?.split(":", 1)[0].length);
		} finally {
			await removeWithRetries(tempDir);
		}
	});

	it("registers a pending action that apply writes changes", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ast-edit-pending-"));
		try {
			const filePath = path.join(tempDir, "legacy.ts");
			await Bun.write(filePath, "legacyWrap(x, value)\n");
			const queue = new ToolChoiceQueue();

			const tools = await createTools(
				createTestSession(tempDir, {
					getToolChoiceQueue: () => queue,
					buildToolChoice: () => ({ type: "tool" as const, name: "resolve" }),
					steer: () => {},
				}),
				["ast_edit"],
			);
			const tool = tools.find(entry => entry.name === "ast_edit");
			expect(tool).toBeDefined();

			const previewResult = await tool!.execute("ast-edit-preview", {
				ops: [{ pat: "legacyWrap($A, $B)", out: "modernWrap($A, $B)" }],
				paths: [filePath],
			});
			expect(previewResult.details).toBeDefined();
			expect((previewResult.details as { applied?: boolean }).applied).toBe(false);

			expect(queue.hasPendingInvoker).toBe(true);
			const invoker = queue.peekPendingInvoker()!;
			const applyResult = (await invoker({
				action: "apply",
				reason: "apply previewed AST edit",
			})) as InvokedToolResult;
			const applyText = applyResult.content.find(content => content.type === "text")?.text ?? "";
			expect(applyResult.isError).toBeUndefined();
			expect(applyText).toContain("Applied 1 replacement in 1 file.");
			expect(
				(applyResult.details as { sourceResultDetails?: { totalReplacements?: number } } | undefined)
					?.sourceResultDetails?.totalReplacements,
			).toBe(1);
			const updated = await Bun.file(filePath).text();
			expect(updated).toContain("modernWrap(x, value)");
		} finally {
			await removeWithRetries(tempDir);
		}
	});

	it("fails stale pending apply when preview no longer matches", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ast-edit-stale-"));
		try {
			const filePath = path.join(tempDir, "legacy.ts");
			await Bun.write(filePath, "legacyWrap(x, value)\n");
			const queue = new ToolChoiceQueue();

			const tools = await createTools(
				createTestSession(tempDir, {
					getToolChoiceQueue: () => queue,
					buildToolChoice: () => ({ type: "tool" as const, name: "resolve" }),
					steer: () => {},
				}),
				["ast_edit"],
			);
			const tool = tools.find(entry => entry.name === "ast_edit");
			expect(tool).toBeDefined();

			const previewResult = await tool!.execute("ast-edit-preview", {
				ops: [{ pat: "legacyWrap($A, $B)", out: "modernWrap($A, $B)" }],
				paths: [filePath],
			});
			expect((previewResult.details as { totalReplacements?: number } | undefined)?.totalReplacements).toBe(1);

			const mutatedContent = "otherWrap(x, value)\n";
			await Bun.write(filePath, mutatedContent);

			const invoker = queue.peekPendingInvoker()!;
			const applyResult = (await invoker({ action: "apply", reason: "apply stale preview" })) as InvokedToolResult;
			const applyText = applyResult.content.find(content => content.type === "text")?.text ?? "";

			expect(applyResult.isError).toBe(true);
			expect(applyText).toContain("Preview is stale / no longer matches");
			expect(applyText).toContain("no replacements were applied");
			expect(
				(applyResult.details as { sourceResultDetails?: { totalReplacements?: number } } | undefined)
					?.sourceResultDetails?.totalReplacements,
			).toBe(0);
			expect(await Bun.file(filePath).text()).toBe(mutatedContent);
		} finally {
			await removeWithRetries(tempDir);
		}
	});

	it("combines globbing from path and glob parameters", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ast-edit-glob-"));
		try {
			const packagesDir = path.join(tempDir, "packages");
			const sourceDir = path.join(packagesDir, "pkg-123", "src");
			const nestedDir = path.join(sourceDir, "nested");
			await fs.mkdir(nestedDir, { recursive: true });
			await Bun.write(path.join(sourceDir, "root.ts"), "legacyWrap(rootValue, rootArg)\n");
			await Bun.write(path.join(nestedDir, "child.ts"), "legacyWrap(childValue, childArg)\n");
			await Bun.write(path.join(sourceDir, "ignore.js"), "legacyWrap(ignoreValue, ignoreArg)\n");
			await Bun.write(path.join(tempDir, "outside.ts"), "legacyWrap(outsideValue, outsideArg)\n");
			const queue = new ToolChoiceQueue();

			const tools = await createTools(
				createTestSession(tempDir, {
					getToolChoiceQueue: () => queue,
					buildToolChoice: () => ({ type: "tool" as const, name: "resolve" }),
					steer: () => {},
				}),
				["ast_edit"],
			);
			const tool = tools.find(entry => entry.name === "ast_edit");
			expect(tool).toBeDefined();

			const previewResult = await tool!.execute("ast-edit-glob", {
				ops: [{ pat: "legacyWrap($A, $B)", out: "modernWrap($A, $B)" }],
				paths: [`${packagesDir}/pkg-*/src/**/*.ts`],
			});

			const text = previewResult.content.find(content => content.type === "text")?.text ?? "";
			const details = previewResult.details as
				| { totalReplacements?: number; fileReplacements?: Array<{ path: string; count: number }> }
				| undefined;

			// Multi-level tree output: `# packages/pkg-…/src/`, `## root.ts#<hash>`, then a
			// nested `## nested/` directory with `### child.ts#<hash>` under it.
			expect(text).toMatch(/^## root\.ts#[0-9A-F]{4} \(\d+ replacement[s]?\)$/m);
			expect(text).toMatch(/^### child\.ts#[0-9A-F]{4} \(\d+ replacement[s]?\)$/m);
			expect(text).not.toContain("ignore.js");
			expect(text).not.toContain("outside.ts");
			expect(details?.totalReplacements).toBe(2);
			expect(details?.fileReplacements).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ path: "packages/pkg-123/src/root.ts", count: 1 }),
					expect.objectContaining({ path: "packages/pkg-123/src/nested/child.ts", count: 1 }),
				]),
			);

			const invoker = queue.peekPendingInvoker()!;
			await invoker({ action: "apply", reason: "apply previewed AST edit with combined globs" });

			expect(await Bun.file(path.join(sourceDir, "root.ts")).text()).toContain("modernWrap(rootValue, rootArg)");
			expect(await Bun.file(path.join(nestedDir, "child.ts")).text()).toContain("modernWrap(childValue, childArg)");
			expect(await Bun.file(path.join(sourceDir, "ignore.js")).text()).toContain(
				"legacyWrap(ignoreValue, ignoreArg)",
			);
			expect(await Bun.file(path.join(tempDir, "outside.ts")).text()).toContain(
				"legacyWrap(outsideValue, outsideArg)",
			);
		} finally {
			await removeWithRetries(tempDir);
		}
	});

	it("infers tlaplus from .tla files for AST edits", async () => {
		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "ast-edit-tlaplus-"));
		try {
			const filePath = path.join(tempDir, "Spec.tla");
			await Bun.write(filePath, `---- MODULE Spec ----\nVARIABLE x\n\nInit == x = 0\n\nNext == x' = x + 1\n====\n`);
			const queue = new ToolChoiceQueue();

			const tools = await createTools(
				createTestSession(tempDir, {
					getToolChoiceQueue: () => queue,
					buildToolChoice: () => ({ type: "tool" as const, name: "resolve" }),
					steer: () => {},
				}),
				["ast_edit"],
			);
			const tool = tools.find(entry => entry.name === "ast_edit");
			expect(tool).toBeDefined();

			const previewResult = await tool!.execute("ast-edit-tlaplus", {
				ops: [{ pat: "Init", out: "Start" }],
				paths: [filePath],
			});

			const text = previewResult.content.find(content => content.type === "text")?.text ?? "";
			const details = previewResult.details as { totalReplacements?: number; parseErrors?: string[] } | undefined;
			expect(text).toContain("Start");
			expect(details?.totalReplacements).toBe(1);
			expect(details?.parseErrors).toBeUndefined();

			const invoker = queue.peekPendingInvoker()!;
			await invoker({ action: "apply", reason: "apply tlaplus AST edit" });
			expect(await Bun.file(filePath).text()).toContain("Start == x = 0");
		} finally {
			await removeWithRetries(tempDir);
		}
	});
});
