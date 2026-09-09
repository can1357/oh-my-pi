import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { adaptSchemaForStrict, toolWireSchema } from "@oh-my-pi/pi-ai/utils/schema";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ToolChoiceQueue } from "@oh-my-pi/pi-coding-agent/session/tool-choice-queue";
import { createTools, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
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
