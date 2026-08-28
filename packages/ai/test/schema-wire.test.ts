import { describe, expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import type { Tool } from "@oh-my-pi/pi-ai/types";
import {
	adaptSchemaForStrict,
	normalizeEmptySchemas,
	stripSchemaDescriptions,
	stripToolDescriptions,
	toolWireSchema,
} from "@oh-my-pi/pi-ai/utils/schema";

// ---------------------------------------------------------------------------
// normalizeEmptySchemas — provider-agnostic post-pipeline normalization
// ---------------------------------------------------------------------------

describe("normalizeEmptySchemas", () => {
	it("normalizes {} in additionalProperties / items / property values / combiner branches", () => {
		const schema: Record<string, unknown> = {
			type: "object",
			properties: { meta: {}, items: { type: "array", items: {} } },
			additionalProperties: {},
			anyOf: [{}, { type: "string" }],
		};
		normalizeEmptySchemas(schema);
		expect(schema).toEqual({
			type: "object",
			properties: { meta: true, items: { type: "array", items: true } },
			additionalProperties: true,
			anyOf: [true, { type: "string" }],
		});
	});

	it("leaves non-empty schemas and boolean values alone", () => {
		const schema: Record<string, unknown> = {
			type: "object",
			additionalProperties: { type: "string" },
			unevaluatedProperties: false,
		};
		normalizeEmptySchemas(schema);
		expect(schema).toEqual({
			type: "object",
			additionalProperties: { type: "string" },
			unevaluatedProperties: false,
		});
	});
});

// ---------------------------------------------------------------------------
// toolWireSchema — raw JSON Schema normalization (issue #1179)
// ---------------------------------------------------------------------------

describe("toolWireSchema — raw JSON Schema normalization", () => {
	function jsonTool(parameters: Record<string, unknown>): Tool {
		return { name: "t", description: "", parameters, async execute() {} } as unknown as Tool;
	}

	it("normalizes {} → true for TypeBox / raw JSON Schema tools", () => {
		const wire = toolWireSchema(
			jsonTool({
				type: "object",
				properties: { extra: { type: "object", additionalProperties: {} } },
				required: [],
			}),
		);
		const extra = (wire.properties as Record<string, unknown>).extra as Record<string, unknown>;
		expect(extra.additionalProperties).toBe(true);
	});

	it("normalizes nullable scalar anyOf for TypeBox / raw JSON Schema tools", () => {
		const wire = toolWireSchema(
			jsonTool({
				type: "object",
				properties: {
					skip: {
						anyOf: [{ type: "number", minimum: 0 }, { type: "null" }],
						description: "matches to skip",
					},
				},
				required: ["skip"],
			}),
		);
		const skip = (wire.properties as Record<string, unknown>).skip as Record<string, unknown>;
		expect(skip).toEqual({
			type: ["number", "null"],
			description: "matches to skip",
			minimum: 0,
		});
	});

	it("preserves exclusive-required anyOf for provider-specific handling", () => {
		const wire = toolWireSchema(
			jsonTool({
				type: "object",
				properties: {
					project: { type: "string" },
					paths: { type: "array", items: { type: "string" } },
					scopes: { type: "array", items: { type: "string" } },
				},
				required: ["project"],
				anyOf: [{ required: ["paths"] }, { required: ["scopes"] }],
			}),
		);
		expect(wire.anyOf).toEqual([{ required: ["paths"] }, { required: ["scopes"] }]);
		expect(wire.type).toBe("object");
		expect(wire.required).toEqual(["project"]);
	});

	it("does not flatten nested exclusive-required anyOf (only the tool root 400s xAI)", () => {
		const wire = toolWireSchema(
			jsonTool({
				type: "object",
				properties: {
					outputSchema: {
						type: "object",
						properties: {
							paths: { type: "array", items: { type: "string" } },
							scopes: { type: "array", items: { type: "string" } },
						},
						anyOf: [{ required: ["paths"] }, { required: ["scopes"] }],
					},
				},
				required: ["outputSchema"],
			}),
		);
		expect(wire.anyOf).toBeUndefined();
		const outputSchema = (wire.properties as Record<string, unknown>).outputSchema as Record<string, unknown>;
		expect(outputSchema.anyOf).toEqual([{ required: ["paths"] }, { required: ["scopes"] }]);
	});

	it("does not flatten a root union that constrains existing properties", () => {
		const wire = toolWireSchema(
			jsonTool({
				type: "object",
				properties: { kind: { type: "string" } },
				anyOf: [{ properties: { kind: { const: "a" } } }, { properties: { kind: { const: "b" } } }],
			}),
		);
		expect(wire.anyOf).toEqual([{ properties: { kind: { const: "a" } } }, { properties: { kind: { const: "b" } } }]);
		const properties = wire.properties;
		expect(
			properties && typeof properties === "object" && "kind" in properties ? properties.kind : undefined,
		).toEqual({
			type: "string",
		});
	});

	it("preserves raw JSON Schema required defaults and safe-integer bounds", () => {
		const wire = toolWireSchema(
			jsonTool({
				type: "object",
				properties: {
					mode: { type: "string", default: "fast" },
					limit: {
						type: "integer",
						minimum: Number.MIN_SAFE_INTEGER,
						maximum: Number.MAX_SAFE_INTEGER,
					},
				},
				required: ["mode", "limit"],
			}),
		);
		expect(wire.required).toEqual(["mode", "limit"]);
		const limit = (wire.properties as Record<string, unknown>).limit as Record<string, unknown>;
		expect(limit.minimum).toBe(Number.MIN_SAFE_INTEGER);
		expect(limit.maximum).toBe(Number.MAX_SAFE_INTEGER);
	});
});

// ---------------------------------------------------------------------------
// arkToWireSchema — `T | undefined` value-union pruning (Codex strict-mode break)
// ---------------------------------------------------------------------------

describe("arkToWireSchema — undefined-union branch pruning", () => {
	function arkTool(parameters: unknown): Tool {
		return { name: "t", description: "d", parameters } as Tool;
	}
	/** True when any `anyOf`/`oneOf`/`allOf` carries a `true` or `{}` branch. */
	function hasPermissiveBranch(node: unknown): boolean {
		if (Array.isArray(node)) return node.some(hasPermissiveBranch);
		if (!node || typeof node !== "object") return false;
		const obj = node as Record<string, unknown>;
		for (const key of ["anyOf", "oneOf", "allOf"]) {
			const arr = obj[key];
			if (
				Array.isArray(arr) &&
				arr.some(
					b =>
						b === true ||
						(b !== null && typeof b === "object" && !Array.isArray(b) && Object.keys(b).length === 0),
				)
			) {
				return true;
			}
		}
		return Object.values(obj).some(hasPermissiveBranch);
	}

	it("inlines `T | undefined` to the concrete type and keeps the key required", () => {
		const wire = toolWireSchema(arkTool(type({ id: "string | undefined", assignment: "string" })));
		const props = wire.properties as Record<string, unknown>;
		expect(props.id).toEqual({ type: "string" });
		// ArkType validates `string | undefined` as required-present (an absent key is
		// rejected at runtime), so the wire must keep the key required for consistency.
		expect(wire.required).toEqual(expect.arrayContaining(["id", "assignment"]));
		expect(hasPermissiveBranch(wire)).toBe(false);
	});

	it("prunes the undefined branch inside nested array items", () => {
		const wire = toolWireSchema(
			arkTool(type({ tasks: type({ id: "string | undefined", assignment: "string" }).array() })),
		);
		const tasks = (wire.properties as Record<string, unknown>).tasks as Record<string, unknown>;
		const itemProps = (tasks.items as Record<string, unknown>).properties as Record<string, unknown>;
		expect(itemProps.id).toEqual({ type: "string" });
		expect(hasPermissiveBranch(wire)).toBe(false);
	});

	it("collapses `(string | undefined)[]` element unions to a typed item", () => {
		const wire = toolWireSchema(arkTool(type({ xs: "(string | undefined)[]" })));
		const xs = (wire.properties as Record<string, unknown>).xs as Record<string, unknown>;
		expect(xs.items).toEqual({ type: "string" });
		expect(hasPermissiveBranch(wire)).toBe(false);
	});

	it("stays strict-mode-representable end to end (Codex acceptance)", () => {
		const wire = toolWireSchema(
			arkTool(
				type({
					agent: "string",
					context: "string",
					tasks: type({ id: "string | undefined", assignment: "string" }).array(),
				}),
			),
		);
		const adapted = adaptSchemaForStrict(wire, true);
		expect(adapted.strict).toBe(true);
		expect(hasPermissiveBranch(adapted.schema)).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// arkToWireSchema — authored property order (guards the @ark/schema patch)
// ---------------------------------------------------------------------------

describe("arkToWireSchema — authored property order", () => {
	function arkTool(parameters: unknown): Tool {
		return { name: "t", description: "d", parameters } as Tool;
	}

	it("preserves declaration order rather than alphabetizing keys", () => {
		// Without the @ark/schema patch, ArkType canonicalizes keys by hash
		// (alphabetical): `zebra, content, path`. Streaming renderers and prompt
		// caching depend on the authored order being preserved on the wire.
		const wire = toolWireSchema(arkTool(type({ path: "string", content: "string", zebra: "string" })));
		expect(Object.keys(wire.properties as Record<string, unknown>)).toEqual(["path", "content", "zebra"]);
	});

	it("emits required props before optional props, each in declaration order", () => {
		const wire = toolWireSchema(
			arkTool(type({ pattern: "string", "paths?": "string", i: "boolean", "skip?": "number" })),
		);
		expect(Object.keys(wire.properties as Record<string, unknown>)).toEqual(["pattern", "i", "paths", "skip"]);
	});
});

// ---------------------------------------------------------------------------
// const-union collapse — ArkType's described literal unions / generic anyOf
// ---------------------------------------------------------------------------

describe("const-union collapse", () => {
	function tool(parameters: unknown): Tool {
		return { name: "t", description: "d", parameters } as Tool;
	}

	it("collapses a described ArkType enumerated union into one typed enum with a single description", () => {
		const wire = toolWireSchema(tool(type({ size: type.enumerated("a", "b", "c").describe("label") })));
		const size = (wire.properties as Record<string, unknown>).size as Record<string, unknown>;
		expect(size.anyOf).toBeUndefined();
		expect(size.type).toBe("string");
		expect(size.description).toBe("label");
		expect(size.enum).toEqual(expect.arrayContaining(["a", "b", "c"]));
		expect((size.enum as unknown[]).length).toBe(3);
		// "label" appears exactly once — not duplicated onto every value branch.
		expect(JSON.stringify(size).match(/"label"/g)?.length).toBe(1);
	});

	it("emits an exact { type, enum, description } shape, lifting a shared branch description", () => {
		const param = {
			type: "object",
			properties: {
				x: {
					anyOf: [
						{ const: "a", description: "lbl" },
						{ const: "b", description: "lbl" },
					],
				},
			},
			required: ["x"],
			additionalProperties: false,
		};
		const wire = toolWireSchema(tool(param));
		const x = (wire.properties as Record<string, unknown>).x as Record<string, unknown>;
		expect(x).toEqual({ type: "string", enum: ["a", "b"], description: "lbl" });
	});

	it("leaves a non-const anyOf with distinct per-branch descriptions untouched", () => {
		const param = {
			type: "object",
			properties: {
				x: {
					anyOf: [
						{ type: "string", description: "a string" },
						{ type: "number", description: "a number" },
					],
				},
			},
			required: ["x"],
			additionalProperties: false,
		};
		const wire = toolWireSchema(tool(param));
		const x = (wire.properties as Record<string, unknown>).x as Record<string, unknown>;
		expect(x.enum).toBeUndefined();
		expect(x.anyOf).toEqual([
			{ type: "string", description: "a string" },
			{ type: "number", description: "a number" },
		]);
	});

	it("preserves a const union whose branches carry distinct per-variant descriptions", () => {
		const param = {
			type: "object",
			properties: {
				x: {
					anyOf: [
						{ const: "a", description: "first" },
						{ const: "b", description: "second" },
					],
				},
			},
			required: ["x"],
			additionalProperties: false,
		};
		const wire = toolWireSchema(tool(param));
		const x = (wire.properties as Record<string, unknown>).x as Record<string, unknown>;
		expect(x.enum).toBeUndefined();
		expect(x.anyOf).toEqual([
			{ const: "a", description: "first" },
			{ const: "b", description: "second" },
		]);
	});

	it("keeps the anyOf when a shared branch description disagrees with the union root's description", () => {
		const param = {
			type: "object",
			properties: {
				x: {
					description: "parent",
					anyOf: [
						{ const: "a", description: "branch" },
						{ const: "b", description: "branch" },
					],
				},
			},
			required: ["x"],
			additionalProperties: false,
		};
		const wire = toolWireSchema(tool(param));
		const x = (wire.properties as Record<string, unknown>).x as Record<string, unknown>;
		expect(x.enum).toBeUndefined();
		expect(x.description).toBe("parent");
		expect(Array.isArray(x.anyOf)).toBe(true);
	});
});

describe("stripSchemaDescriptions", () => {
	it("removes annotations through nested schema keywords while preserving structure", () => {
		const schema = {
			type: "object",
			description: "object annotation",
			properties: {
				path: { type: "string", description: "the path" },
				choice: {
					anyOf: [
						{ type: "string", description: "string variant" },
						{ type: "number", description: "number variant" },
					],
				},
			},
			dependentSchemas: {
				path: { type: "object", description: "dependent annotation" },
			},
			required: ["path"],
		};
		const stripped = stripSchemaDescriptions(schema);
		expect(JSON.stringify(stripped)).not.toContain("annotation");
		expect(JSON.stringify(stripped)).not.toContain("variant");
		expect(JSON.stringify(stripped)).not.toContain("the path");
		// Structure survives: types, property names, required, union arity.
		const props = stripped.properties as Record<string, { type?: string; anyOf?: unknown[] }>;
		expect(props.path.type).toBe("string");
		expect(props.choice.anyOf).toHaveLength(2);
		expect(stripped.required).toEqual(["path"]);
	});

	it("keeps a property literally named `description` (only its own annotation is dropped)", () => {
		const schema = {
			type: "object",
			properties: {
				description: { type: "string", description: "a field that is named description" },
			},
		};
		const stripped = stripSchemaDescriptions(schema);
		const prop = (stripped.properties as Record<string, { type: string; description?: string }>).description;
		expect(prop).toBeDefined();
		expect(prop.type).toBe("string");
		expect(prop.description).toBeUndefined();
	});

	it("never descends into data-bearing keywords (default/const/examples)", () => {
		const schema = {
			type: "object",
			properties: {
				mode: {
					type: "string",
					description: "the mode",
					default: { description: "data, keep me" },
					examples: [{ description: "example data" }],
				},
			},
		};
		const stripped = stripSchemaDescriptions(schema);
		const mode = (stripped.properties as Record<string, Record<string, unknown>>).mode;
		expect(mode.description).toBeUndefined();
		expect(mode.default).toEqual({ description: "data, keep me" });
		expect(mode.examples).toEqual([{ description: "example data" }]);
	});

	it("does not mutate the input schema", () => {
		const schema = {
			type: "object",
			description: "keep",
			properties: { a: { type: "string", description: "keep a" } },
		};
		stripSchemaDescriptions(schema);
		expect(schema.description).toBe("keep");
		expect(schema.properties.a.description).toBe("keep a");
	});

	it("memoizes the result on the input via a hidden stamp", () => {
		const schema = { type: "object", properties: { a: { type: "string", description: "x" } } };
		const first = stripSchemaDescriptions(schema);
		const second = stripSchemaDescriptions(schema);
		expect(second).toBe(first);
	});
});

describe("stripToolDescriptions", () => {
	const tool: Tool = {
		name: "demo",
		description: "top-level tool description",
		parameters: {
			type: "object",
			properties: {
				path: { type: "string", description: "where to read" },
			},
			required: ["path"],
		},
	};

	it("empties the top-level description and strips nested schema descriptions", () => {
		const [stripped] = stripToolDescriptions([tool]);
		expect(stripped.description).toBe("");
		expect(JSON.stringify(stripped.parameters)).not.toContain("where to read");
		expect((stripped.parameters as { properties: Record<string, { type: string }> }).properties.path.type).toBe(
			"string",
		);
	});

	it("leaves the original tool and the cached wire schema intact", () => {
		stripToolDescriptions([tool]);
		expect(tool.description).toBe("top-level tool description");
		expect(JSON.stringify(toolWireSchema(tool))).toContain("where to read");
	});
});
