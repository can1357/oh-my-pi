import { describe, expect, it } from "bun:test";
import { convertOpenAICodexResponsesTools } from "@oh-my-pi/pi-ai/providers/openai-codex-responses";
import { convertTools } from "@oh-my-pi/pi-ai/providers/openai-responses";
import type { Tool } from "@oh-my-pi/pi-ai/types";
import { adaptSchemaForStrict, sanitizeSchemaForOpenAIResponses } from "@oh-my-pi/pi-ai/utils/schema";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { createCodexModel } from "./helpers";

describe("Codex itemless array schemas", () => {
	it.each([
		{
			name: "top-level array",
			schema: { type: "array" },
			expected: { type: "array", items: true },
		},
		{
			name: "nullable array",
			schema: { type: ["array", "null"] },
			expected: { type: ["array", "null"], items: true },
		},
		{
			name: "nested property",
			schema: { type: "object", properties: { listeners: { type: "array" } } },
			expected: { type: "object", properties: { listeners: { type: "array", items: true } } },
		},
		{
			name: "anyOf branch",
			schema: { anyOf: [{ type: "array" }, { type: "null" }] },
			expected: { anyOf: [{ type: "array", items: true }, { type: "null" }] },
		},
		{
			name: "nested array items",
			schema: { type: "array", items: { type: "array" } },
			expected: { type: "array", items: { type: "array", items: true } },
		},
		{
			name: "prefix-only tuple",
			schema: { type: "array", prefixItems: [{ type: "string" }] },
			expected: { type: "array", prefixItems: [{ type: "string" }], items: true },
		},
		{
			name: "empty prefix tuple",
			schema: { type: "array", prefixItems: [] },
			expected: { type: "array", prefixItems: [], items: true },
		},
		{
			name: "typeless prefix-only tuple",
			schema: { prefixItems: [{ type: "string" }] },
			expected: { prefixItems: [{ type: "string" }], items: true },
		},
		{
			name: "typeless empty prefix tuple",
			schema: { prefixItems: [] },
			expected: { prefixItems: [], items: true },
		},
	])("adds open items to $name and falls back to non-strict", ({ schema, expected }) => {
		const original = structuredClone(schema);
		expect(sanitizeSchemaForOpenAIResponses(schema)).toBe(schema);
		const sanitized = sanitizeSchemaForOpenAIResponses(schema, { repairArrayItems: true });
		expect(sanitized).toEqual(expected);
		expect(adaptSchemaForStrict(sanitized, true)).toEqual({ schema: expected, strict: false });
		expect(schema).toEqual(original);
		expect(sanitizeSchemaForOpenAIResponses(sanitized, { repairArrayItems: true })).toBe(sanitized);
	});

	it.each([
		{ type: "array", items: true },
		{ type: "array", items: false },
		{ type: "array", prefixItems: [{ type: "string" }], items: { type: "number" } },
		{ type: "array", prefixItems: [], items: false },
	])("preserves existing items: %j", schema => {
		expect(sanitizeSchemaForOpenAIResponses(schema, { repairArrayItems: true })).toBe(schema);
	});

	it("does not repair an array with its own unevaluatedItems", () => {
		const schema = { type: "array", prefixItems: [{ type: "string" }], unevaluatedItems: false };
		expect(sanitizeSchemaForOpenAIResponses(schema, { repairArrayItems: true })).toBe(schema);
	});

	it("skips the whole schema, including unrelated arrays, when unevaluatedItems is present", () => {
		const tuple = { type: "array", prefixItems: [{ type: "string" }] };
		const closed = { type: "array", allOf: [tuple], unevaluatedItems: false };
		const schema = { type: "object", properties: { closed, open: tuple } };
		expect(sanitizeSchemaForOpenAIResponses(schema, { repairArrayItems: true })).toBe(schema);
		expect(tuple).not.toHaveProperty("items");
	});

	const referencedTupleSchema = {
		type: "object",
		$defs: { Tuple: { type: "array", prefixItems: [{ type: "string" }] } },
		properties: {
			row: { type: "array", allOf: [{ $ref: "#/$defs/Tuple" }], unevaluatedItems: false },
			other: { type: "array" },
		},
		required: ["row", "other"],
		additionalProperties: false,
	};

	it("does not mistake property or definition names for unevaluatedItems constraints", () => {
		const schema = {
			type: "object",
			$defs: { unevaluatedItems: { type: "string" } },
			properties: { unevaluatedItems: { type: "string" }, listeners: { type: "array" } },
		};
		expect(sanitizeSchemaForOpenAIResponses(schema, { repairArrayItems: true })).toEqual({
			...schema,
			properties: { ...schema.properties, listeners: { type: "array", items: true } },
		});
	});

	it("does not inspect unevaluatedItems inside a const payload", () => {
		const schema = {
			type: "object",
			properties: { listeners: { type: "array" } },
			const: { unevaluatedItems: false },
		};
		expect(sanitizeSchemaForOpenAIResponses(schema, { repairArrayItems: true })).toEqual({
			...schema,
			properties: { listeners: { type: "array", items: true } },
		});
	});

	it("does not rewrite itemless array-shaped literal values", () => {
		const literal = { type: "array" };
		const schema = { type: "string", enum: [literal], const: literal, default: literal, examples: [literal] };
		expect(sanitizeSchemaForOpenAIResponses(schema, { repairArrayItems: true })).toBe(schema);
	});

	it("keeps the Responses converter's itemless arrays unchanged for grammar backends", () => {
		// llama.cpp compiles tool schemas into grammars and rejects boolean subschemas.
		const model = buildModel<"openai-responses">({
			id: "local-model",
			name: "local-model",
			api: "openai-responses",
			provider: "llama.cpp",
			baseUrl: "http://127.0.0.1:8080/v1",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 8192,
			maxTokens: 1024,
		});
		const parameters = {
			type: "object",
			properties: {
				listeners: { type: "array" },
				row: { type: "array", prefixItems: [{ type: "string" }] },
				inferred: { prefixItems: [{ type: "string" }] },
			},
			required: ["listeners", "row", "inferred"],
			additionalProperties: false,
		};
		const tool: Tool = { name: "list", description: "List results", strict: true, parameters };
		const [wire] = convertTools([tool], model.compat.supportsStrictMode, model);
		if (wire?.type !== "function") throw new Error("expected a function tool payload");
		expect(wire.parameters).toEqual(parameters);
		expect(wire.strict).toBeFalsy();
	});

	describe("Codex converter", () => {
		const model = createCodexModel("gpt-5.5");
		const convert = (tool: Tool) => convertOpenAICodexResponsesTools([tool], model)[0];

		it("preserves an own __proto__ property and its required entry when repairing a sibling array", () => {
			const properties: Record<string, unknown> = JSON.parse(
				'{"__proto__":{"type":"string"},"listeners":{"type":"array"}}',
			);
			const tool: Tool = {
				name: "list",
				description: "List results",
				strict: true,
				parameters: {
					type: "object",
					properties,
					required: ["__proto__", "listeners"],
					additionalProperties: false,
				},
			};
			const converted = convert(tool);
			if (converted.type !== "function") throw new Error("Expected a function tool");
			const wireProperties = converted.parameters.properties as Record<string, unknown>;
			expect(Object.hasOwn(wireProperties, "__proto__")).toBe(true);
			expect(wireProperties.__proto__).toEqual({ type: "string" });
			expect(wireProperties.listeners).toEqual({ type: "array", items: true });
			expect(converted.parameters.required).toEqual(Object.keys(wireProperties));
		});

		it("preserves the whole tool when a referenced tuple has an enclosing unevaluatedItems constraint", () => {
			const tool: Tool = {
				name: "tuple",
				description: "Read a tuple",
				parameters: referencedTupleSchema,
				strict: false,
			};
			expect(convert(tool)).toEqual({
				type: "function",
				name: "tuple",
				description: "Read a tuple",
				parameters: referencedTupleSchema,
				strict: false,
			});
		});

		it("repairs typeless prefix-only tuples before strict inference", () => {
			const prefixItems = [{ type: "string" }];
			const tool: Tool = {
				name: "tuple",
				description: "Read a tuple",
				strict: true,
				parameters: {
					type: "object",
					properties: { row: { prefixItems } },
					required: ["row"],
					additionalProperties: false,
				},
			};
			expect(convert(tool)).toEqual({
				type: "function",
				name: "tuple",
				description: "Read a tuple",
				parameters: {
					type: "object",
					properties: { row: { prefixItems, items: true } },
					required: ["row"],
					additionalProperties: false,
				},
			});
		});

		it("preserves a prefix-only tuple with an explicit non-strict open tail", () => {
			const prefixItems = [{ type: "string" }];
			const tool: Tool = {
				name: "tuple",
				description: "Read a tuple",
				strict: true,
				parameters: {
					type: "object",
					properties: { row: { type: "array", prefixItems } },
					required: ["row"],
					additionalProperties: false,
				},
			};
			const sanitized = sanitizeSchemaForOpenAIResponses({ type: "array", prefixItems }, { repairArrayItems: true });
			expect(sanitized.prefixItems).toBe(prefixItems);
			expect(convert(tool)).toEqual({
				type: "function",
				name: "tuple",
				description: "Read a tuple",
				parameters: {
					type: "object",
					properties: { row: { type: "array", prefixItems, items: true } },
					required: ["row"],
					additionalProperties: false,
				},
			});
		});

		it("preserves tuple items and strict mode when the tail is typed", () => {
			const parameters = {
				type: "object",
				properties: {
					row: { type: "array", prefixItems: [{ type: "string" }], items: { type: "number" } },
				},
				required: ["row"],
				additionalProperties: false,
			};
			const tool: Tool = {
				name: "tuple",
				description: "Read a tuple",
				strict: true,
				parameters,
			};
			expect(convert(tool)).toEqual({
				type: "function",
				name: "tuple",
				description: "Read a tuple",
				parameters,
				strict: true,
			});
		});

		it("emits open array items without strict mode", () => {
			const tool: Tool = {
				name: "list",
				description: "List results",
				strict: true,
				parameters: {
					type: "object",
					properties: { listeners: { type: "array" } },
					required: ["listeners"],
					additionalProperties: false,
				},
			};
			expect(convert(tool)).toEqual({
				type: "function",
				name: "list",
				description: "List results",
				parameters: {
					type: "object",
					properties: { listeners: { type: "array", items: true } },
					required: ["listeners"],
					additionalProperties: false,
				},
			});
		});

		it("repairs an array whose items member is present but undefined", () => {
			// JSON.stringify drops `items: undefined`, so it must be treated as omitted.
			const tool: Tool = {
				name: "list",
				description: "List results",
				strict: true,
				parameters: {
					type: "object",
					properties: { listeners: { type: "array", items: undefined } },
					required: ["listeners"],
					additionalProperties: false,
				},
			};
			const converted = JSON.parse(JSON.stringify(convert(tool)));
			expect(converted.strict).toBeUndefined();
			expect(converted.parameters.properties.listeners).toEqual({ type: "array", items: true });
		});

		it("retains strict mode for typed array items", () => {
			const tool: Tool = {
				name: "list",
				description: "List results",
				strict: true,
				parameters: {
					type: "object",
					properties: { listeners: { type: "array", items: { type: "string" } } },
					required: ["listeners"],
					additionalProperties: false,
				},
			};
			expect(convert(tool)).toMatchObject({ strict: true, parameters: tool.parameters });
		});
	});
});
