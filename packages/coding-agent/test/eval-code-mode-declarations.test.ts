import { describe, expect, test } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { Settings } from "../src/config/settings";
import type { ToolSession } from "../src/tools";
import { EvalTool } from "../src/tools/eval";
import { generateCodeModeDeclarations } from "../src/tools/eval-format/code-mode-declarations";

describe("generateCodeModeDeclarations", () => {
	test("emits a declare-const block with typed signatures", () => {
		const out = generateCodeModeDeclarations([
			{
				name: "read",
				parameters: {
					type: "object",
					properties: { path: { type: "string" }, limit: { type: "number" } },
					required: ["path"],
				},
			},
			{
				name: "grep",
				parameters: {
					type: "object",
					properties: { pattern: { type: "string" }, case: { type: "boolean" } },
					required: ["pattern"],
				},
			},
		]);
		expect(out.split("\n")).toEqual([
			"  read(args: { path: string; limit?: number }): Promise<unknown>;",
			"  grep(args: { pattern: string; case?: boolean }): Promise<unknown>;",
		]);
	});
	test("enums become literal unions", () => {
		const out = generateCodeModeDeclarations([
			{
				name: "todo",
				parameters: { type: "object", properties: { op: { enum: ["init", "done"] } }, required: ["op"] },
			},
		]);
		expect(out).toContain('op: "init" | "done"');
	});
	test("union item types are parenthesized inside arrays", () => {
		const out = generateCodeModeDeclarations([
			{
				name: "chmod",
				parameters: {
					type: "object",
					properties: { modes: { type: "array", items: { enum: ["read", "write"] } } },
					required: ["modes"],
				},
			},
		]);
		expect(out).toContain('modes: ("read" | "write")[]');
	});
	test("non-identifier property keys stay quoted", () => {
		const out = generateCodeModeDeclarations([
			{
				name: "cfg",
				parameters: { type: "object", properties: { "some-flag": { type: "string" } }, required: ["some-flag"] },
			},
		]);
		expect(out).toContain('"some-flag": string');
	});
	test("quotes non-identifier tool names", () => {
		const out = generateCodeModeDeclarations([{ name: "my-tool", parameters: { type: "object" } }]);
		expect(out).toContain('"my-tool"(args: unknown): Promise<unknown>;');
	});
	test("exotic schemas degrade to unknown without throwing", () => {
		const out = generateCodeModeDeclarations([{ name: "weird", parameters: { allOf: [{ type: "string" }] } }]);
		expect(out).toContain("weird(args: unknown): Promise<unknown>;");
	});
});

test("EvalTool advertises only tools authorized for its bridge", () => {
	const read = { name: "read", parameters: type({ path: "string" }) };
	const write = { name: "write", parameters: type({ path: "string", content: "string" }) };
	const session = {
		cwd: "/tmp",
		hasUI: false,
		getSessionFile: () => null,
		settings: Settings.isolated({ "providers.openai-codex.codeMode": "auto" }),
		getActiveModel: () => ({ provider: "openai-codex", toolMode: "code_mode_only" }),
		toolRegistry: new Map<string, { name: string; parameters: object }>([
			["read", read],
			["write", write],
		]),
		getEvalBridgeToolNames: () => ["eval", "read"],
		getCodeModeDirectToolNames: () => ["eval"],
	} as unknown as ToolSession;

	const description = new EvalTool(session).description;

	expect(description).toContain("read(args:");
	expect(description).not.toContain("write(args:");
});

test("EvalTool omits tools the model can still call directly", () => {
	// Plan mode keeps `write` direct as the xd://propose transport; advertising it
	// as bridged would nest plan approval inside an eval result.
	const read = { name: "read", parameters: type({ path: "string" }) };
	const write = { name: "write", parameters: type({ path: "string", content: "string" }) };
	const session = {
		cwd: "/tmp",
		hasUI: false,
		getSessionFile: () => null,
		settings: Settings.isolated(),
		toolRegistry: new Map<string, typeof read | typeof write>([
			["read", read],
			["write", write],
		]),
		getEvalBridgeToolNames: () => ["eval", "read", "write"],
		getCodeModeDirectToolNames: () => ["eval", "write"],
	} as unknown as ToolSession;

	const description = new EvalTool(session).description;

	expect(description).toContain("read(args:");
	expect(description).not.toContain("write(args:");
});

test("EvalTool advertises bridged tool declarations only while Code Mode is active", () => {
	const read = { name: "read", parameters: type({ path: "string" }) };
	const baseSession = {
		cwd: "/tmp",
		hasUI: false,
		getSessionFile: () => null,
		settings: Settings.isolated(),
		toolRegistry: new Map([["read", read]]),
		getEvalBridgeToolNames: () => ["eval", "read"],
	};
	const active = new EvalTool({
		...baseSession,
		getCodeModeDirectToolNames: () => ["eval"],
	} as unknown as ToolSession).description;
	expect(active).toContain("declare const tool: {");
	expect(active).toContain("read(args:");

	const inactive = new EvalTool({
		...baseSession,
		getCodeModeDirectToolNames: () => undefined,
	} as unknown as ToolSession).description;
	expect(inactive).not.toContain("declare const tool");
	expect(inactive).not.toContain("read(args:");
});

test("EvalTool withholds Code Mode transport support when the JS backend is disabled", () => {
	const session = {
		cwd: "/tmp",
		hasUI: false,
		getSessionFile: () => null,
		settings: Settings.isolated({ "eval.js": false, "eval.py": true }),
		toolRegistry: new Map(),
		getEvalBridgeToolNames: () => ["eval"],
	} as unknown as ToolSession;

	expect(new EvalTool(session).supportsCodeModeTransport()).toBe(false);
});
