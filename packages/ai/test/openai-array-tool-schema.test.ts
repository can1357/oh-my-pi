import { describe, expect, it } from "bun:test";
import { convertOpenAICodexResponsesTools } from "@oh-my-pi/pi-ai/providers/openai-codex-responses";
import { convertTools } from "@oh-my-pi/pi-ai/providers/openai-responses";
import type { Tool } from "@oh-my-pi/pi-ai/types";
import { adaptSchemaForStrict, sanitizeSchemaForOpenAIResponses } from "@oh-my-pi/pi-ai/utils/schema";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { YieldTool } from "@oh-my-pi/pi-coding-agent/tools/yield";
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

	it("preserves typed items and strict mode when no repair is needed", () => {
		const schema = {
			type: "object",
			properties: { listeners: { type: "array", items: { type: "string" } } },
			required: ["listeners"],
			additionalProperties: false,
		};
		expect(sanitizeSchemaForOpenAIResponses(schema, { repairArrayItems: true })).toBe(schema);
		expect(adaptSchemaForStrict(schema, true)).toEqual({ schema, strict: true });
	});

	it.each([
		{ type: "array", items: true },
		{ type: "array", items: false },
		{ type: "array", prefixItems: [{ type: "string" }], items: { type: "number" } },
		{ type: "array", prefixItems: [], items: false },
	])("preserves existing items: %j", schema => {
		expect(sanitizeSchemaForOpenAIResponses(schema, { repairArrayItems: true })).toBe(schema);
	});

	it.each([false, true, { type: "number" }])("does not repair arrays with unevaluatedItems: %j", unevaluatedItems => {
		const schema = { type: "array", prefixItems: [{ type: "string" }], unevaluatedItems };
		expect(sanitizeSchemaForOpenAIResponses(schema, { repairArrayItems: true })).toBe(schema);
	});

	it("does not repair an allOf tuple beneath enclosing unevaluatedItems", () => {
		const schema = {
			type: "array",
			allOf: [{ type: "array", prefixItems: [{ type: "string" }] }],
			unevaluatedItems: false,
		};
		expect(sanitizeSchemaForOpenAIResponses(schema, { repairArrayItems: true })).toBe(schema);
	});

	it.each([false, true])("skips the whole schema when unevaluatedItems is present (closed first: %j)", closedFirst => {
		const tuple = { type: "array", prefixItems: [{ type: "string" }] };
		const closed = { type: "array", allOf: [tuple], unevaluatedItems: false };
		const properties = closedFirst ? { closed, open: tuple } : { open: tuple, closed };
		const schema = { type: "object", properties };
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

	it("does not repair definitions referenced from an unevaluatedItems constraint", () => {
		expect(sanitizeSchemaForOpenAIResponses(referencedTupleSchema, { repairArrayItems: true })).toBe(
			referencedTupleSchema,
		);
	});

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

	it.each(["const", "default"])("does not inspect unevaluatedItems inside a %s payload", keyword => {
		const schema = {
			type: "object",
			properties: { listeners: { type: "array" } },
			[keyword]: { unevaluatedItems: false },
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

	// Serialized tool payloads captured from main 0b5c27ab24, without a provider request.
	const responseParameters = {
		type: "object",
		properties: {
			listeners: { type: "array" },
			row: { type: "array", prefixItems: [{ type: "string" }] },
			inferred: { prefixItems: [{ type: "string" }] },
		},
		required: ["listeners", "row", "inferred"],
		additionalProperties: false,
	};
	const responsesCases = [
		{
			name: "official OpenAI",
			model: getBundledModel<"openai-responses">("openai", "gpt-5-mini"),
			parameters: {
				properties: {
					listeners: { type: "array" },
					row: { prefixItems: [{ type: "string" }], type: "array" },
					inferred: { prefixItems: [{ type: "string" }], type: "array" },
				},
				required: ["listeners", "row", "inferred"],
				type: "object",
				additionalProperties: false,
			},
			strict: true,
		},
		...[
			{ provider: "llama.cpp", id: "local-model" },
			{ provider: "ollama", id: "local-model" },
			{ provider: "llama.cpp", id: "kimi-k2.5" },
		].map(({ provider, id }) => ({
			name: `${provider}/${id}`,
			model: buildModel<"openai-responses">({
				id,
				name: id,
				api: "openai-responses",
				provider,
				baseUrl: "http://127.0.0.1:8080/v1",
				reasoning: false,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 8192,
				maxTokens: 1024,
			}),
			parameters:
				id === "kimi-k2.5"
					? {
							...responseParameters,
							properties: { listeners: { type: "array" }, row: { type: "array" }, inferred: {} },
						}
					: responseParameters,
			strict: false,
		})),
	];

	it.each(responsesCases)("keeps $name Responses tools byte-identical to main", ({ model, parameters, strict }) => {
		const tool: Tool = { name: "list", description: "List results", strict: true, parameters: responseParameters };
		expect(JSON.stringify(convertTools([tool], model.compat.supportsStrictMode, model))).toBe(
			JSON.stringify([
				{
					type: "function",
					name: "list",
					description: "List results",
					parameters,
					...(strict ? { strict: true } : {}),
				},
			]),
		);
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

		it.each([
			{ type: "array", prefixItems: [{ type: "string" }], unevaluatedItems: false },
			{
				type: "array",
				allOf: [{ type: "array", prefixItems: [{ type: "string" }] }],
				unevaluatedItems: false,
			},
		])("leaves a tuple closed by unevaluatedItems unchanged: %j", row => {
			const parameters = {
				type: "object",
				properties: { row },
				required: ["row"],
				additionalProperties: false,
			};
			const tool: Tool = { name: "tuple", description: "Read a tuple", parameters, strict: false };
			expect(convert(tool)).toEqual({
				type: "function",
				name: "tuple",
				description: "Read a tuple",
				parameters,
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

		it("repairs a real YieldTool without changing task-level validation", async () => {
			const tool = new YieldTool({
				cwd: "/tmp",
				hasUI: false,
				getSessionFile: () => null,
				getSessionSpawns: () => "*",
				settings: Settings.isolated(),
				outputSchema: {
					type: "object",
					properties: { listeners: { type: "array" } },
					required: ["listeners"],
					additionalProperties: false,
				},
			});
			expect(convert(tool)).toMatchObject({
				type: "function",
				name: "yield",
				parameters: {
					properties: {
						data: {
							anyOf: [
								{
									type: "object",
									properties: { listeners: { type: "array", items: true } },
									required: ["listeners"],
								},
								{ type: "array", items: true },
							],
						},
					},
				},
			});
			expect(convert(tool)).not.toHaveProperty("strict");
			const data = { listeners: [{ port: 1234 }, "untyped"] };
			const result = await tool.execute("valid-result", { data });
			expect(result.details).toMatchObject({ status: "success", data });
			await expect(tool.execute("invalid-result", { data: {} })).rejects.toThrow("Output does not match schema");
		});
	});
});
