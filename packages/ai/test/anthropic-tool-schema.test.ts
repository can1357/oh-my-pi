import { describe, expect, it } from "bun:test";
import { normalizeAnthropicToolSchema } from "@oh-my-pi/pi-ai/providers/anthropic";

describe("normalizeAnthropicToolSchema — SDK whitelist", () => {
	describe("number / integer nodes", () => {
		it("demotes range and multipleOf keywords on number nodes", () => {
			const out = normalizeAnthropicToolSchema({
				type: "object",
				properties: {
					temperature: {
						type: "number",
						minimum: 0,
						maximum: 1,
						exclusiveMinimum: 0,
						exclusiveMaximum: 1,
						multipleOf: 0.1,
					},
				},
			}) as { properties: { temperature: Record<string, unknown> } };
			expect(out.properties.temperature).toEqual({
				type: "number",
				description: "{minimum: 0, maximum: 1, exclusiveMinimum: 0, exclusiveMaximum: 1, multipleOf: 0.1}",
			});
		});

		it("demotes range and multipleOf keywords on integer nodes", () => {
			const out = normalizeAnthropicToolSchema({
				type: "object",
				properties: {
					count: { type: "integer", minimum: 0, maximum: 100, multipleOf: 1 },
				},
			}) as { properties: { count: Record<string, unknown> } };
			expect(out.properties.count).toEqual({
				type: "integer",
				description: "{minimum: 0, maximum: 100, multipleOf: 1}",
			});
		});

		it("demotes numeric range keywords on union-type nodes that include number", () => {
			const out = normalizeAnthropicToolSchema({
				type: "object",
				properties: {
					value: { type: ["number", "null"], minimum: 0, maximum: 10 },
				},
			}) as { properties: { value: Record<string, unknown> } };
			expect(out.properties.value).toEqual({
				type: ["number", "null"],
				description: "{minimum: 0, maximum: 10}",
			});
		});
	});

	describe("string nodes", () => {
		it("demotes pattern / minLength / maxLength into description", () => {
			const out = normalizeAnthropicToolSchema({
				type: "object",
				properties: {
					name: { type: "string", pattern: "^[a-z]+$", minLength: 1, maxLength: 32 },
				},
			}) as { properties: { name: Record<string, unknown> } };
			expect(out.properties.name).toEqual({
				type: "string",
				description: '{pattern: "^[a-z]+$", minLength: 1, maxLength: 32}',
			});
		});

		it("keeps `format` only when in the supported value set", () => {
			const out = normalizeAnthropicToolSchema({
				type: "object",
				properties: {
					email: { type: "string", format: "email" },
					weird: { type: "string", format: "color-hex" },
				},
			}) as { properties: { email: Record<string, unknown>; weird: Record<string, unknown> } };
			expect(out.properties.email).toEqual({ type: "string", format: "email" });
			expect(out.properties.weird).toEqual({ type: "string", description: '{format: "color-hex"}' });
		});
	});

	describe("array nodes", () => {
		it("keeps minItems only when 0 or 1, spills otherwise; demotes maxItems / uniqueItems", () => {
			const out01 = normalizeAnthropicToolSchema({
				type: "array",
				items: { type: "string" },
				minItems: 1,
			}) as Record<string, unknown>;
			expect(out01.minItems).toBe(1);
			expect(out01).not.toHaveProperty("description");

			const out5 = normalizeAnthropicToolSchema({
				type: "array",
				items: { type: "string" },
				minItems: 5,
				maxItems: 10,
				uniqueItems: true,
			}) as Record<string, unknown>;
			expect(out5).not.toHaveProperty("minItems");
			expect(out5).not.toHaveProperty("maxItems");
			expect(out5).not.toHaveProperty("uniqueItems");
			expect(out5.description).toBe("{maxItems: 10, uniqueItems: true, minItems: 5}");
		});

		it("recurses into `items` and `prefixItems`", () => {
			const out = normalizeAnthropicToolSchema({
				type: "array",
				items: { type: "number", minimum: 0 },
				prefixItems: [{ type: "string", minLength: 1 }],
			}) as Record<string, unknown>;
			expect(out.items).toEqual({ type: "number", description: "{minimum: 0}" });
			expect(out.prefixItems).toEqual([{ type: "string", description: "{minLength: 1}" }]);
		});
	});

	describe("object nodes", () => {
		it("defaults additionalProperties to false on closed objects", () => {
			const out = normalizeAnthropicToolSchema({
				type: "object",
				properties: { a: { type: "string" } },
			}) as Record<string, unknown>;
			expect(out.additionalProperties).toBe(false);
		});

		it("preserves explicit open-map declarations (additionalProperties: true)", () => {
			const out = normalizeAnthropicToolSchema({
				type: "object",
				additionalProperties: true,
				properties: { a: { type: "string" } },
			}) as Record<string, unknown>;
			expect(out.additionalProperties).toBe(true);
		});

		it("preserves and recurses into additionalProperties schema literals", () => {
			const out = normalizeAnthropicToolSchema({
				type: "object",
				additionalProperties: { type: "number", minimum: 0 },
			}) as Record<string, unknown>;
			expect(out.additionalProperties).toEqual({ type: "number", description: "{minimum: 0}" });
		});

		it("demotes patternProperties / propertyNames / minItems on objects", () => {
			const out = normalizeAnthropicToolSchema({
				type: "object",
				properties: { tag: { type: "string" } },
				patternProperties: { "^x-": { type: "string" } },
				propertyNames: { pattern: "^[a-z]+$" },
				minItems: 1,
			}) as Record<string, unknown>;
			expect(out).not.toHaveProperty("patternProperties");
			expect(out).not.toHaveProperty("propertyNames");
			expect(out).not.toHaveProperty("minItems");
			expect(typeof out.description).toBe("string");
			expect(out.description).toContain("patternProperties");
			expect(out.description).toContain("propertyNames");
			expect(out.description).toContain("minItems");
		});
	});

	describe("universal preservation", () => {
		it("appends spilled keywords to an existing description with a blank line", () => {
			const out = normalizeAnthropicToolSchema({
				type: "object",
				properties: {
					ratio: { type: "number", description: "A ratio", minimum: 0, maximum: 1 },
				},
			}) as { properties: { ratio: Record<string, unknown> } };
			expect(out.properties.ratio).toEqual({
				type: "number",
				description: "A ratio\n\n{minimum: 0, maximum: 1}",
			});
		});

		it("preserves universal keys: $ref, $defs, anyOf, enum, const, default, title", () => {
			const out = normalizeAnthropicToolSchema({
				$defs: { Color: { type: "string", enum: ["r", "g", "b"] } },
				type: "object",
				title: "Sample",
				properties: {
					ref: { $ref: "#/$defs/Color" },
					union: { anyOf: [{ type: "string" }, { type: "number" }] },
					choice: { const: "x" },
					hint: { type: "string", default: "anon" },
				},
			}) as Record<string, unknown> & { properties: Record<string, Record<string, unknown>> };
			expect(out.title).toBe("Sample");
			expect(out.$defs).toEqual({ Color: { type: "string", enum: ["r", "g", "b"] } });
			expect(out.properties.ref).toEqual({ $ref: "#/$defs/Color" });
			expect(out.properties.union.anyOf).toEqual([{ type: "string" }, { type: "number" }]);
			expect(out.properties.choice).toEqual({ const: "x" });
			expect(out.properties.hint).toEqual({ type: "string", default: "anon" });
		});
	});
});

/**
 * Cases mirrored from the upstream Anthropic Python SDK transform tests at
 * `anthropic-sdk-python/tests/lib/_parse/test_transform.py`. We adapt assertions
 * to the function name `normalizeAnthropicToolSchema` and keep the same shapes.
 *
 * Three deliberate divergences from the SDK (NOT bugs):
 *  - `default` is preserved on every node (SDK demotes it into description).
 *    Anthropic's API accepts `default`; preserving keeps Zod/OpenAPI fidelity.
 *  - `$ref` does NOT short-circuit sibling keys (SDK drops everything else).
 *    We keep `$defs`/`description` next to a `$ref` because callers feed us
 *    deref-friendly schemas where siblings carry real semantics.
 *  - top-level `anyOf` / `allOf` and all `oneOf` occurrences are demoted into
 *    `description`; live Messages rejects root combinators and does not document `oneOf`.
 * Tests below that overlap with SDK cases asserting those behaviors are
 * adjusted to our contract; the divergence is called out inline.
 */
describe("normalizeAnthropicToolSchema — parity with anthropic-sdk-python transform_schema", () => {
	// Mirrors: anthropic-sdk-python/tests/lib/_parse/test_transform.py::test_ref_schema
	it("preserves a lone $ref node", () => {
		const out = normalizeAnthropicToolSchema({ $ref: "#/components/schemas/SomeSchema" });
		expect(out).toEqual({ $ref: "#/components/schemas/SomeSchema" });
	});

	// Mirrors: anthropic-sdk-python/tests/lib/_parse/test_transform.py::test_anyof_schema
	it("recurses into nested anyOf variants and spills per-variant constraints", () => {
		const out = normalizeAnthropicToolSchema({
			type: "object",
			properties: {
				value: { anyOf: [{ type: "string" }, { type: "integer", minimum: 1 }] },
			},
		});
		expect(out).toEqual({
			type: "object",
			properties: {
				value: { anyOf: [{ type: "string" }, { type: "integer", description: "{minimum: 1}" }] },
			},
			additionalProperties: false,
		});
	});

	// Mirrors: anthropic-sdk-python/tests/lib/_parse/test_transform.py::test_enum_schema
	it("keeps enum on string nodes verbatim", () => {
		const out = normalizeAnthropicToolSchema({ type: "string", enum: ["foo", "bar"] });
		expect(out).toEqual({ type: "string", enum: ["foo", "bar"] });
	});

	it("spills top-level anyOf variants into description for the Messages API root-combinator boundary", () => {
		const out = normalizeAnthropicToolSchema({
			type: "object",
			properties: { id: { type: "string" } },
			anyOf: [{ required: ["id"] }, { required: ["name"] }],
		});
		expect(out).toEqual({
			type: "object",
			properties: { id: { type: "string" } },
			additionalProperties: false,
			description: '{anyOf: [{"required":["id"]},{"required":["name"]}]}',
		});
	});

	// Divergence: SDK preserves allOf at the schema root, but the live Anthropic Messages
	// validator rejects root combinators in tool input_schema. Spill it so the model
	// still sees the constraints.
	it("spills top-level allOf variants into description instead of sending an unsupported root keyword", () => {
		const out = normalizeAnthropicToolSchema({
			type: "object",
			properties: { id: { type: "string" } },
			allOf: [
				{ type: "object", properties: { name: { type: "string" } } },
				{ type: "object", properties: { age: { type: "integer", minimum: 0 } } },
			],
		});
		expect(out).toEqual({
			type: "object",
			properties: { id: { type: "string" } },
			additionalProperties: false,
			description:
				'{allOf: [{"type":"object","properties":{"name":{"type":"string"}}},{"type":"object","properties":{"age":{"type":"integer","minimum":0}}}]}',
		});
	});

	it("spills oneOf variants at root and nested positions for the same Messages API compatibility boundary", () => {
		const root = normalizeAnthropicToolSchema({
			oneOf: [{ type: "string" }, { type: "integer", minimum: 1 }],
		});
		expect(root).toEqual({
			description: '{oneOf: [{"type":"string"},{"type":"integer","minimum":1}]}',
		});

		const nested = normalizeAnthropicToolSchema({
			type: "object",
			properties: {
				value: { oneOf: [{ type: "string" }, { type: "integer", minimum: 1 }] },
			},
		});
		expect(nested).toEqual({
			type: "object",
			properties: {
				value: { description: '{oneOf: [{"type":"string"},{"type":"integer","minimum":1}]}' },
			},
			additionalProperties: false,
		});
	});

	// Mirrors: anthropic-sdk-python/tests/lib/_parse/test_transform.py::test_object_schema
	// Divergence: SDK spills `default` into the property description; we preserve it.
	it("preserves object description / required / additionalProperties=false and spills per-property constraints", () => {
		const out = normalizeAnthropicToolSchema({
			type: "object",
			properties: {
				name: { type: "string", default: "John" },
				age: { type: "integer", minimum: 0 },
			},
			required: ["name"],
			description: "Person object",
		});
		expect(out).toEqual({
			type: "object",
			description: "Person object",
			properties: {
				name: { type: "string", default: "John" }, // SDK would emit description: "{default: John}"
				age: { type: "integer", description: "{minimum: 0}" },
			},
			additionalProperties: false,
			required: ["name"],
		});
	});

	// Mirrors: anthropic-sdk-python/tests/lib/_parse/test_transform.py::test_array_schema
	it("spills minItems>1 into description with the SDK's two-newline preamble", () => {
		const out = normalizeAnthropicToolSchema({
			type: "array",
			items: { type: "string" },
			minItems: 2,
			description: "A list of strings",
		});
		expect(out).toEqual({
			type: "array",
			description: "A list of strings\n\n{minItems: 2}",
			items: { type: "string" },
		});
	});

	// Mirrors: anthropic-sdk-python/tests/lib/_parse/test_transform.py::test_string_schema_with_format_and_default
	// Divergence: SDK spills `default`; we preserve it. `format=email` is kept (allowlisted).
	it("keeps an allowlisted string format alongside a preserved default", () => {
		const out = normalizeAnthropicToolSchema({
			type: "string",
			format: "email",
			default: "user@example.com",
			description: "User email",
		});
		expect(out).toEqual({
			type: "string",
			description: "User email",
			format: "email",
			default: "user@example.com", // SDK would move this into description
		});
	});

	// Mirrors: anthropic-sdk-python/tests/lib/_parse/test_transform.py::test_string_schema_without_format
	it("passes a bare string node through unchanged", () => {
		expect(normalizeAnthropicToolSchema({ type: "string" })).toEqual({ type: "string" });
	});

	// Mirrors: anthropic-sdk-python/tests/lib/_parse/test_transform.py::test_integer_schema_with_min_max_exclusive
	it("spills integer min/max/exclusive keywords in source order under description", () => {
		const out = normalizeAnthropicToolSchema({
			type: "integer",
			minimum: 1,
			maximum: 10,
			exclusiveMinimum: 0,
			exclusiveMaximum: 20,
			description: "A number",
		});
		expect(out).toEqual({
			type: "integer",
			description: "A number\n\n{minimum: 1, maximum: 10, exclusiveMinimum: 0, exclusiveMaximum: 20}",
		});
	});

	// Mirrors: anthropic-sdk-python/tests/lib/_parse/test_transform.py::test_boolean_schema
	it("passes boolean nodes with description through unchanged", () => {
		expect(normalizeAnthropicToolSchema({ type: "boolean", description: "A flag" })).toEqual({
			type: "boolean",
			description: "A flag",
		});
	});

	// Mirrors: anthropic-sdk-python/tests/lib/_parse/test_transform.py::test_null_schema
	it("passes a null-type node through unchanged", () => {
		expect(normalizeAnthropicToolSchema({ type: "null" })).toEqual({ type: "null" });
	});

	// Mirrors: anthropic-sdk-python/tests/lib/_parse/test_transform.py::test_original_schema_not_mutated
	it("does not mutate the input schema's enumerable structure", () => {
		const original: Record<string, unknown> = {
			type: "object",
			properties: {
				name: { type: "string", default: "John" },
				age: { type: "integer", minimum: 0 },
			},
			required: ["name"],
			description: "Person object",
			additionalProperties: true,
		};
		const snapshot = JSON.parse(JSON.stringify(original));
		normalizeAnthropicToolSchema(original);
		// Round-trip via JSON so the memoization Symbol slot (non-enumerable in JSON terms)
		// is excluded from comparison — that is the only field our normalizer adds.
		expect(JSON.parse(JSON.stringify(original))).toEqual(snapshot);
	});

	// Cycle safety: not in the SDK suite (Python deepcopies and Pydantic resolves refs),
	// but our normalizer pre-stamps to break cycles. Worth pinning as a regression test.
	it("resolves self-referential schemas without infinite recursion", () => {
		const node: Record<string, unknown> = { type: "object", properties: {} };
		(node.properties as Record<string, unknown>).self = node;
		const out = normalizeAnthropicToolSchema(node) as Record<string, unknown>;
		expect(out.type).toBe("object");
		const props = out.properties as Record<string, unknown>;
		expect(props.self).toBe(out); // memoized → same reference
	});
});
