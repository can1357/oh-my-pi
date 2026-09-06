import { describe, expect, test } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { buildParams, convertTools } from "@oh-my-pi/pi-ai/providers/openai-responses";
import type { Context, Model, ModelSpec, Tool } from "@oh-my-pi/pi-ai/types";
import { findStrictToolSchemaViolation } from "@oh-my-pi/pi-ai/utils/schema";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

function makeModel(provider: "openai" | "xai-oauth" = "openai"): Model<"openai-responses"> {
	return buildModel({
		id: provider === "xai-oauth" ? "grok-4" : "gpt-5",
		name: provider === "xai-oauth" ? "Grok 4" : "GPT-5",
		api: "openai-responses",
		provider,
		baseUrl: provider === "xai-oauth" ? "https://api.x.ai/v1" : "https://api.openai.com/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 400000,
		maxTokens: 128000,
	} as ModelSpec<"openai-responses">);
}

const leftoverRootUnion = {
	type: "object",
	properties: { kind: { type: "string" } },
	anyOf: [
		{ required: ["kind"], minProperties: 1 },
		{ required: ["kind"], minProperties: 2 },
	],
} as const;

describe("findStrictToolSchemaViolation (#2652)", () => {
	test("flags a non-null enum on a null-typed node (nullable-enum shape)", () => {
		expect(findStrictToolSchemaViolation({ enum: ["A", "B"], type: "null" })).toBe("#/enum");
	});

	test("flags an enum on an array-typed node (enum-on-array shape)", () => {
		expect(findStrictToolSchemaViolation({ enum: [0, 1, 2], items: { type: "integer" }, type: "array" })).toBe(
			"#/enum",
		);
	});

	test("flags a const incompatible with its type (anyOf/const shape) with its path", () => {
		const schema = { anyOf: [{ const: 5, type: "string" }, { type: "null" }] };
		expect(findStrictToolSchemaViolation(schema)).toBe("#/anyOf/0/const");
	});

	test("reports the nested path to the offending node", () => {
		const schema = {
			type: "object",
			properties: { tag: { enum: ["x"], type: "null" } },
			required: ["tag"],
		};
		expect(findStrictToolSchemaViolation(schema)).toBe("#/properties/tag/enum");
	});

	test("accepts valid enum/const/type combinations, including nullable unions", () => {
		expect(findStrictToolSchemaViolation({ enum: ["a", "b"], type: "string" })).toBeNull();
		expect(findStrictToolSchemaViolation({ enum: ["a", null], type: ["string", "null"] })).toBeNull();
		expect(findStrictToolSchemaViolation({ const: 5, type: "integer" })).toBeNull();
		// An enum belongs on the array's items, which is valid.
		expect(findStrictToolSchemaViolation({ type: "array", items: { enum: [1, 2], type: "integer" } })).toBeNull();
		// enum without a declared type cannot contradict anything.
		expect(findStrictToolSchemaViolation({ enum: ["x"] })).toBeNull();
	});

	test("flags a leftover xAI root anyOf only when the xAI option is on", () => {
		expect(findStrictToolSchemaViolation(leftoverRootUnion)).toBeNull();
		expect(findStrictToolSchemaViolation(leftoverRootUnion, "#", { rejectXaiRootObjectUnion: true })).toBe("#/anyOf");
	});

	test("accepts a root anyOf of typed object branches even for xAI", () => {
		expect(
			findStrictToolSchemaViolation(
				{
					anyOf: [
						{ type: "object", properties: { a: { type: "string" } } },
						{ type: "object", properties: { b: { type: "number" } } },
					],
				},
				"#",
				{ rejectXaiRootObjectUnion: true },
			),
		).toBeNull();
	});
});

const badTool: Tool = {
	name: "mcp__server__bad",
	description: "an MCP tool with an invalid nullable-enum schema",
	parameters: {
		type: "object",
		properties: { choice: { enum: ["A", "B"], type: "null" } },
		required: ["choice"],
		additionalProperties: false,
	} as unknown as Tool["parameters"],
};
const coverageTool: Tool = {
	name: "mcp__codebase_memory_check_index_coverage",
	description: "coverage",
	parameters: {
		type: "object",
		properties: {
			project: { type: "string" },
			paths: { type: "array", items: { type: "string" } },
			scopes: { type: "array", items: { type: "string" } },
		},
		required: ["project"],
		anyOf: [{ required: ["paths"] }, { required: ["scopes"] }],
	} as unknown as Tool["parameters"],
};
const goodTool: Tool = {
	name: "read_file",
	description: "read a file",
	parameters: type({ path: "string" }),
};
const computerTool: Tool = {
	name: "computer",
	description: "control the desktop",
	parameters: type({}),
	native: { type: "computer" },
};

describe("convertTools quarantine (#2652)", () => {
	test("drops only the tool with the provider-rejecting schema, keeping the rest", () => {
		const out = convertTools([goodTool, badTool], true, makeModel()) as Array<{ name: string }>;
		const names = out.map(t => t.name);
		expect(names).toContain("read_file");
		expect(names).not.toContain("mcp__server__bad");
		expect(out).toHaveLength(1);
	});

	test("emits every tool when all schemas are valid", () => {
		expect(convertTools([goodTool], true, makeModel())).toHaveLength(1);
	});

	test("flattens an exclusive-required MCP tool on xAI Responses", () => {
		const out = convertTools([coverageTool, goodTool], true, makeModel("xai-oauth")) as Array<{
			name: string;
			parameters: { anyOf?: unknown };
		}>;
		expect(out.map(t => t.name)).toEqual(["mcp__codebase_memory_check_index_coverage", "read_file"]);
		expect(out[0]?.parameters.anyOf).toBeUndefined();
	});

	test("preserves an exclusive-required MCP tool on OpenAI Responses", () => {
		const out = convertTools([coverageTool, goodTool], true, makeModel()) as Array<{
			name: string;
			parameters: { anyOf?: unknown };
		}>;
		expect(out.map(t => t.name)).toEqual(["mcp__codebase_memory_check_index_coverage", "read_file"]);
		expect(out[0]?.parameters.anyOf).toHaveLength(2);
	});

	test("keeps a leftover object-root union on OpenAI Responses", () => {
		const leftoverTool: Tool = {
			name: "mcp__leftover_union",
			description: "union",
			parameters: {
				type: "object",
				properties: { kind: { type: "string" } },
				anyOf: [
					{ required: ["kind"], minProperties: 1 },
					{ required: ["kind"], minProperties: 2 },
				],
			} as unknown as Tool["parameters"],
		};
		const out = convertTools([leftoverTool, goodTool], true, makeModel()) as Array<{
			name: string;
			parameters: { anyOf?: unknown };
		}>;
		expect(out.map(t => t.name)).toEqual(["mcp__leftover_union", "read_file"]);
		expect(out[0]?.parameters.anyOf).toHaveLength(2);
	});

	test("quarantines a leftover object-root union on xAI Responses only", () => {
		const leftoverTool: Tool = {
			name: "mcp__leftover_union",
			description: "union",
			parameters: {
				type: "object",
				properties: { kind: { type: "string" } },
				anyOf: [
					{ required: ["kind"], minProperties: 1 },
					{ required: ["kind"], minProperties: 2 },
				],
			} as unknown as Tool["parameters"],
		};
		const out = convertTools([leftoverTool, goodTool], true, makeModel("xai-oauth")) as Array<{ name: string }>;
		expect(out.map(t => t.name)).toEqual(["read_file"]);
	});
	test("reports the hidden tool name and the offending schema path", () => {
		const dropped: Array<{ name: string; path: string }> = [];
		convertTools([badTool], true, makeModel(), (name, path) => dropped.push({ name, path }));
		expect(dropped).toEqual([{ name: "mcp__server__bad", path: "#/properties/choice/enum" }]);
	});
});

describe("buildParams tool_choice reconciliation (#2652)", () => {
	function ctx(tools: Tool[]): Context {
		return { systemPrompt: [], messages: [], tools } as unknown as Context;
	}

	test("drops a forced tool_choice when the selected tool was quarantined", () => {
		const { params } = buildParams(
			makeModel(),
			ctx([goodTool, badTool]),
			{ toolChoice: { type: "tool", name: "mcp__server__bad" } },
			undefined,
		);
		expect((params.tools as Array<{ name: string }>).map(t => t.name)).toEqual(["read_file"]);
		expect(params.tool_choice).toBeUndefined();
	});

	test("drops a 'required' tool_choice when every tool was quarantined", () => {
		const { params } = buildParams(makeModel(), ctx([badTool]), { toolChoice: "required" }, undefined);
		expect(params.tools).toHaveLength(0);
		expect(params.tool_choice).toBeUndefined();
	});

	test("keeps tool_choice for a surviving forced tool", () => {
		const { params } = buildParams(
			makeModel(),
			ctx([goodTool, badTool]),
			{ toolChoice: { type: "tool", name: "read_file" } },
			undefined,
		);
		expect(params.tool_choice).toEqual({ type: "function", name: "read_file" });
	});

	test("keeps a forced native computer choice when only a sibling tool is quarantined", () => {
		const nativeModel = { ...makeModel(), supportsComputerUse: true };
		const { params } = buildParams(
			nativeModel,
			ctx([computerTool, badTool]),
			{ toolChoice: { type: "computer" } },
			undefined,
		);
		expect(params.tools).toEqual([{ type: "computer" }]);
		expect(params.tool_choice).toEqual({ type: "computer" });
	});
});
