import { describe, expect, it } from "bun:test";
import { buildMcpToolDefinitions } from "@oh-my-pi/pi-ai/providers/cursor";
import type { Tool, TSchema } from "@oh-my-pi/pi-ai/types";
import { isJsonSchemaValueValid, sanitizeSchemaForCursor, toolWireSchema } from "@oh-my-pi/pi-ai/utils/schema";
import { decodeJsonValue } from "@oh-my-pi/pi-catalog/discovery/protobuf";

const tool = (name: string, parameters: TSchema = { type: "object", properties: {} }): Tool => ({
	name,
	description: `${name} tool`,
	parameters,
});

describe("cursor buildMcpToolDefinitions", () => {
	it("forwards the write transport alongside preview-staging devices so xd:// resolution stays reachable", () => {
		// A Cursor session with xdev on: ast_edit is a mounted device, write is the
		// xd:// transport carried top-level. ast_edit always stages a preview whose
		// resolution rides `write xd://resolve` / `write xd://reject`.
		const defs = buildMcpToolDefinitions([
			tool("read"),
			tool("write"),
			tool("bash"),
			tool("todo"),
			tool("ast_edit"),
			tool("task"),
		]);
		const names = defs.map(def => def.name);

		expect(names).toContain("ast_edit");
		expect(names).toContain("task");
		// `write` is the sole native-filtered tool re-included: without it the
		// staged preview can never be resolved and the SoftToolRequirement('write')
		// escalation aborts the turn.
		expect(names).toContain("write");
		expect(names).not.toContain("read");
		expect(names).not.toContain("bash");
		expect(names).not.toContain("todo");

		// The forwarded write must be a routable pi-agent MCP tool, so Cursor
		// dispatches it back through the coding-agent write tool's xd:// handler.
		const writeDef = defs.find(def => def.name === "write");
		expect(writeDef?.providerIdentifier).toBe("pi-agent");
		expect(writeDef?.toolName).toBe("write");
	});

	it("keeps write out when only native tools are advertised (no pi-agent device needs resolution)", () => {
		const names = buildMcpToolDefinitions([tool("read"), tool("write"), tool("bash")]).map(def => def.name);
		expect(names).toEqual([]);
	});

	it("advertises lsp, which Cursor has no native equivalent for", () => {
		// `lsp` is deliberately absent from the native-filtered set: Cursor's own
		// tools cover none of definition/references/rename, so filtering it out
		// leaves the model with no way to reach them at all.
		const defs = buildMcpToolDefinitions([tool("read"), tool("bash"), tool("lsp")]);

		const lspDef = defs.find(def => def.name === "lsp");
		expect(lspDef).toBeDefined();
		expect(lspDef?.providerIdentifier).toBe("pi-agent");
		expect(lspDef?.toolName).toBe("lsp");
	});

	it("advertises hashline edit, which Cursor has no native equivalent for", () => {
		// Native StrReplace is `editToolCall`, not hashline. Filtering `edit`
		// would leave the model with no way to apply a tagged section rewrite.
		const defs = buildMcpToolDefinitions([tool("read"), tool("bash"), tool("edit")]);
		const editDef = defs.find(def => def.name === "edit");
		expect(editDef).toBeDefined();
		expect(editDef?.providerIdentifier).toBe("pi-agent");
		expect(editDef?.toolName).toBe("edit");
		expect(defs.map(def => def.name)).not.toContain("read");
	});

	it("advertises no composition keyword and never mutates the canonical wire schema", () => {
		const schema = {
			type: "object",
			properties: {
				where: {
					oneOf: [
						{ type: "object", properties: { element_token: { type: "string" } }, required: ["element_token"] },
						{
							type: "object",
							properties: { x: { type: "number" }, y: { type: "number" } },
							required: ["x", "y"],
						},
					],
				},
			},
			required: ["where"],
		};
		const composedTool = tool("composed", schema);
		const wireSchema = toolWireSchema(composedTool);
		const originalWireSchema = structuredClone(wireSchema);

		const [definition] = buildMcpToolDefinitions([composedTool]);
		const advertised = decodeJsonValue(definition.inputSchema);

		// The whole point of the projection: Cursor rejects the request outright
		// if any composition keyword survives anywhere in an advertised schema.
		expect(hasCompositionKeyword(advertised)).toBe(false);
		// The canonical schema, which still validates arguments locally, is untouched.
		expect(structuredClone(wireSchema)).toEqual(originalWireSchema);
	});
});

/** True when `value` carries `anyOf`/`oneOf`/`allOf` in any schema position. */
function hasCompositionKeyword(value: unknown, insideProperties = false): boolean {
	if (Array.isArray(value)) return value.some(entry => hasCompositionKeyword(entry, false));
	if (typeof value !== "object" || value === null) return false;
	const record = value as Record<string, unknown>;
	if (!insideProperties && ("anyOf" in record || "oneOf" in record || "allOf" in record)) return true;
	for (const key in record) {
		const nowInsideProperties = key === "properties" || key === "patternProperties" || key === "$defs";
		if (hasCompositionKeyword(record[key], nowInsideProperties)) return true;
	}
	return false;
}

describe("sanitizeSchemaForCursor", () => {
	it("merges anyOf object branches: union properties, intersection of required", () => {
		const schema = {
			anyOf: [
				{
					type: "object",
					properties: { id: { type: "string" }, mode: { type: "string" } },
					required: ["id", "mode"],
				},
				{ type: "object", properties: { id: { type: "string" } }, required: ["id"] },
			],
		};
		expect(sanitizeSchemaForCursor(schema)).toEqual({
			type: "object",
			properties: { id: { type: "string" }, mode: {} },
			required: ["id"],
		});
	});

	it("preserves property guidance from closed oneOf object branches", () => {
		const schema = {
			oneOf: [
				{
					type: "object",
					properties: { element_token: { type: "string" } },
					required: ["element_token"],
					additionalProperties: false,
				},
				{
					type: "object",
					properties: { x: { type: "number" }, y: { type: "number" } },
					required: ["x", "y"],
					additionalProperties: false,
				},
			],
		};
		expect(sanitizeSchemaForCursor(schema)).toEqual({
			type: "object",
			properties: { element_token: { type: "string" }, x: { type: "number" }, y: { type: "number" } },
		});
	});

	it("widens properties omitted by an anyOf or oneOf branch", () => {
		for (const combiner of ["anyOf", "oneOf"] as const) {
			const schema = {
				[combiner]: [
					{ type: "object", properties: { x: { type: "string" } }, required: ["x"] },
					{ type: "object", properties: { y: { type: "number" } }, required: ["y"] },
				],
			};
			const accepted = { x: 1, y: 2 };
			const projected = sanitizeSchemaForCursor(schema);

			expect(isJsonSchemaValueValid(schema, accepted)).toBe(true);
			expect(projected).toEqual({ type: "object", properties: { x: {}, y: {} } });
			expect(isJsonSchemaValueValid(projected, accepted)).toBe(true);
		}
	});

	it("merges allOf object branches with the union of their required fields", () => {
		const schema = {
			allOf: [
				{ type: "object", properties: { a: { type: "string" } }, required: ["a"] },
				{ type: "object", properties: { b: { type: "number" } }, required: ["b"] },
			],
		};
		expect(sanitizeSchemaForCursor(schema)).toEqual({
			type: "object",
			properties: { a: { type: "string" }, b: { type: "number" } },
			required: ["a", "b"],
		});
	});

	it("widens unrepresentable scalar and mixed unions to accept-all instead of narrowing", () => {
		expect(sanitizeSchemaForCursor({ anyOf: [{ type: "string" }, { type: "number" }] })).toEqual({});
		// The shape of the built-in task.outputSchema union (`object | boolean | string | null`).
		expect(
			sanitizeSchemaForCursor({
				anyOf: [{ type: "object" }, { type: "boolean" }, { type: "string" }, { type: "null" }],
			}),
		).toEqual({});
	});

	it("drops a negation whose constraint is a stripped combiner rather than emitting the all-rejecting not: {}", () => {
		const schema = {
			type: "object",
			properties: { choice: { enum: ["a", "b"], not: { anyOf: [{ const: null }] } } },
		};
		expect(sanitizeSchemaForCursor(schema)).toEqual({
			type: "object",
			properties: { choice: { enum: ["a", "b"] } },
		});
	});

	it("drops a negation whose local reference resolves to a stripped combiner", () => {
		const schema = {
			$defs: { bad: { anyOf: [{ const: "bad" }] } },
			not: { $ref: "#/$defs/bad" },
		};
		const projected = sanitizeSchemaForCursor(schema);

		expect(isJsonSchemaValueValid(schema, "ok")).toBe(true);
		expect(projected).toEqual({});
		expect(isJsonSchemaValueValid(projected, "ok")).toBe(true);
	});

	it("preserves a negation whose constraint is representable", () => {
		const schema = { type: "object", properties: { choice: { not: { type: "null" } } } };
		expect(sanitizeSchemaForCursor(schema)).toEqual(schema);
	});

	it("treats a property literally named like a combiner as data, not a keyword", () => {
		const schema = { type: "object", properties: { anyOf: { type: "string" }, oneOf: { type: "number" } } };
		expect(sanitizeSchemaForCursor(schema)).toEqual(schema);
	});

	it("removes every composition keyword recursively without mutating the input", () => {
		const schema = {
			type: "object",
			properties: {
				nested: {
					type: "array",
					items: {
						allOf: [
							{ type: "object", properties: { a: { type: "string" } }, required: ["a"] },
							{ type: "object", properties: { b: { oneOf: [{ type: "number" }, { type: "integer" }] } } },
						],
					},
				},
			},
		};
		const original = structuredClone(schema);
		const projected = sanitizeSchemaForCursor(schema);
		expect(hasCompositionKeyword(projected)).toBe(false);
		expect(schema).toEqual(original);
	});
});
