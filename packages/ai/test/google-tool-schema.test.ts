import { describe, expect, it } from "bun:test";
import { convertTools } from "@oh-my-pi/pi-ai/providers/google-shared";
import type { TJsonSchema, Tool } from "@oh-my-pi/pi-ai/types";
import { normalizeSchemaForGoogle } from "@oh-my-pi/pi-ai/utils/schema";

describe("Google tool schema conversion", () => {
	it("collapses type arrays to a scalar type plus nullable", () => {
		const schema = {
			type: "object",
			properties: {
				value: {
					type: ["string", "null"],
				},
			},
		} as unknown;

		expect(normalizeSchemaForGoogle(schema)).toEqual({
			type: "object",
			properties: {
				value: {
					type: "string",
					nullable: true,
				},
			},
		});
	});

	it("splits a multi-type array into typed anyOf branches instead of leaving `items` on a string", () => {
		// Stencil Carly's canvas_edit `from`/`to`: a shape ref or an [x, y] point. Collapsing to
		// `{ type: "string", items }` made Gemini reject the request (`items: field predicate
		// failed: $type == Type.ARRAY`).
		const end = { type: ["string", "array", "null"], items: { type: "number" }, description: "Ref or point." };

		expect(normalizeSchemaForGoogle(end)).toEqual({
			description: "Ref or point.",
			nullable: true,
			anyOf: [{ type: "string" }, { type: "array", items: { type: "number" } }],
		});
	});

	it("normalizes tool schemas using normalizeSchemaForGoogle", () => {
		const parameters = {
			type: "object",
			properties: {
				value: {
					type: "string",
				},
			},
			additionalProperties: false,
		} as unknown as TJsonSchema;
		const tools: Tool[] = [{ name: "test_tool", description: "Test tool", parameters }];
		const result = convertTools(tools);
		const declaration = result?.[0]?.functionDeclarations[0] as Record<string, unknown>;

		expect(declaration.parametersJsonSchema).toEqual({
			type: "object",
			properties: {
				value: {
					type: "string",
				},
			},
		});
	});

	it("infers enum type through convertTools into parametersJsonSchema", () => {
		const parameters = {
			type: "object",
			properties: {
				action: { enum: ["definition", "references", "code_actions"] },
			},
			required: ["action"],
		} as unknown as TJsonSchema;
		const tools: Tool[] = [{ name: "lsp", description: "LSP tool", parameters }];

		const geminiDeclaration = convertTools(tools)?.[0]?.functionDeclarations[0] as Record<string, unknown>;
		expect((geminiDeclaration.parametersJsonSchema as { properties: { action: unknown } }).properties.action).toEqual(
			{
				type: "string",
				enum: ["definition", "references", "code_actions"],
			},
		);
	});
});

/**
 * Tests ported from python-genai's `process_schema`/`handle_null_fields`
 * coverage in google/genai/tests/transformers/test_schema.py. The Python
 * suite is the canonical regression set for the rules our `normalizeSchemaForGoogle`
 * mirrors (snake_case field renames, null-field collapsing, const→enum,
 * propertyOrdering propagation, $ref cycle handling).
 */
describe("normalizeSchemaForGoogle parity with python-genai process_schema", () => {
	// Mirrors python-genai test_schema.py::test_schema_with_no_null_fields_is_unchanged
	it("leaves anyOf alone when no variant has type null", () => {
		const schema = {
			anyOf: [{ type: "integer" }, { type: "number" }],
			default: "null",
			title: "Total Area Sq Mi",
		} as const;

		expect(normalizeSchemaForGoogle(schema)).toEqual({
			anyOf: [{ type: "integer" }, { type: "number" }],
			default: "null",
			title: "Total Area Sq Mi",
		});
	});

	// Mirrors python-genai test_schema.py::test_schema_with_any_of
	it("preserves multi-variant anyOf without any null variant", () => {
		const schema = {
			type: "object",
			properties: {
				name: { type: "string", title: "Name" },
				restaurants_per_capita: {
					any_of: [{ type: "integer" }, { type: "number" }],
					title: "Restaurants Per Capita",
				},
			},
			required: ["name", "restaurants_per_capita"],
		} as const;

		const sanitized = normalizeSchemaForGoogle(schema) as Record<string, unknown>;
		const props = sanitized.properties as Record<string, Record<string, unknown>>;
		// snake_case any_of must be rewritten to camelCase anyOf.
		expect(props.restaurants_per_capita?.anyOf).toEqual([{ type: "integer" }, { type: "number" }]);
		expect(props.restaurants_per_capita?.any_of).toBeUndefined();
	});

	// Mirrors python-genai test_schema.py::test_complex_dict_schema_with_anyof_is_unchanged
	it("leaves already-camelCased complex schemas unchanged apart from auto propertyOrdering", () => {
		const dictSchema = {
			type: "object",
			title: "Fruit Basket",
			description: "A structured representation of a fruit basket",
			required: ["fruit"],
			properties: {
				fruit: {
					type: "array",
					description: "An ordered list of the fruit in the basket",
					items: {
						description: "A piece of fruit",
						anyOf: [
							{
								title: "Apple",
								description: "Describes an apple",
								type: "object",
								properties: {
									type: { type: "string", description: "Always 'apple'" },
									color: { type: "string", description: "The color of the apple" },
								},
								propertyOrdering: ["type", "color"],
								required: ["type", "color"],
							},
							{
								title: "Orange",
								description: "Describes an orange",
								type: "object",
								properties: {
									type: { type: "string", description: "Always 'orange'" },
									size: { type: "string", description: "The size of the orange" },
								},
								propertyOrdering: ["type", "size"],
								required: ["type", "size"],
							},
						],
					},
				},
			},
		} as const;

		// fruit alone is the only top-level property; auto-ordering does not fire.
		expect(normalizeSchemaForGoogle(dictSchema)).toEqual(dictSchema);
	});

	// Mirrors python-genai test_schema.py::test_process_schema_converts_const_to_enum
	it("converts const to a singleton enum", () => {
		const sanitized = normalizeSchemaForGoogle({ type: "string", const: "FOO" });
		expect(sanitized).toEqual({ type: "string", enum: ["FOO"] });
	});

	// Mirrors python-genai test_schema.py::test_process_schema_forbids_non_string_const.
	// Google enum fields accept strings only, so normalization drops the numeric
	// singleton enum while preserving the integer type constraint.
	it("omits a non-string const enum while preserving its type", () => {
		const sanitized = normalizeSchemaForGoogle({ type: "integer", const: 123 });
		expect(sanitized).toEqual({ type: "integer" });
	});

	it("drops negations whose non-string enums cannot be represented", () => {
		const sanitized = normalizeSchemaForGoogle({ not: { enum: [1] } });
		expect(sanitized).toEqual({});
		expect(
			normalizeSchemaForGoogle({
				not: { type: "object", properties: { value: { enum: [1] } } },
			}),
		).toEqual({});
	});

	it("drops negations containing snake-case combiners with non-string enums", () => {
		expect(normalizeSchemaForGoogle({ not: { any_of: [{ const: 1 }] } })).toEqual({});
	});

	// Mirrors python-genai test_schema.py::test_process_schema_order_properties_propagates_into_defs
	it("propagates auto propertyOrdering into inlined $defs targets", () => {
		const schema = {
			$ref: "#/$defs/Foo",
			$defs: {
				Foo: {
					type: "object",
					properties: {
						foo: { type: "string" },
						bar: { type: "string" },
					},
				},
			},
		} as const;

		expect(normalizeSchemaForGoogle(schema)).toEqual({
			type: "object",
			properties: {
				foo: { type: "string" },
				bar: { type: "string" },
			},
			propertyOrdering: ["foo", "bar"],
		});
	});

	// Mirrors python-genai test_schema.py::test_process_schema_order_properties_propagates_into_items
	it("propagates auto propertyOrdering into array items", () => {
		const schema = {
			type: "array",
			items: {
				type: "object",
				properties: {
					foo: { type: "string" },
					bar: { type: "string" },
				},
			},
		} as const;

		expect(normalizeSchemaForGoogle(schema)).toEqual({
			type: "array",
			items: {
				type: "object",
				properties: {
					foo: { type: "string" },
					bar: { type: "string" },
				},
				propertyOrdering: ["foo", "bar"],
			},
		});
	});

	// Mirrors python-genai test_schema.py::test_process_schema_order_properties_propagates_into_properties
	it("propagates auto propertyOrdering into nested properties", () => {
		const schema = {
			type: "object",
			properties: {
				xyz: {
					type: "object",
					properties: {
						foo: { type: "string" },
						bar: { type: "string" },
					},
				},
				abc: { type: "string" },
			},
		} as const;

		expect(normalizeSchemaForGoogle(schema)).toEqual({
			type: "object",
			properties: {
				xyz: {
					type: "object",
					properties: {
						foo: { type: "string" },
						bar: { type: "string" },
					},
					propertyOrdering: ["foo", "bar"],
				},
				abc: { type: "string" },
			},
			propertyOrdering: ["xyz", "abc"],
		});
	});

	// Mirrors python-genai test_schema.py::test_process_schema_order_properties_propagates_into_any_of
	it("propagates auto propertyOrdering into anyOf variants", () => {
		const schema = {
			anyOf: [
				{
					type: "object",
					properties: {
						foo: { type: "string" },
						bar: { type: "string" },
					},
				},
				{ type: "string" },
			],
		} as const;

		expect(normalizeSchemaForGoogle(schema)).toEqual({
			anyOf: [
				{
					type: "object",
					properties: {
						foo: { type: "string" },
						bar: { type: "string" },
					},
					propertyOrdering: ["foo", "bar"],
				},
				{ type: "string" },
			],
		});
	});

	// Mirrors python-genai test_schema.py::test_process_schema_with_cycle
	it("breaks $ref cycles by emitting an empty schema at the recursion point", () => {
		const schema = {
			type: "object",
			properties: {
				recursive: { $ref: "#/$defs/RecursiveObject" },
			},
			$defs: {
				RecursiveObject: {
					type: "object",
					properties: {
						self: { $ref: "#/$defs/RecursiveObject" },
					},
				},
			},
		} as const;

		expect(normalizeSchemaForGoogle(schema)).toEqual({
			type: "object",
			properties: {
				recursive: {
					type: "object",
					properties: { self: {} },
				},
			},
		});
	});

	// Mirrors python-genai test_schema.py::test_t_schema_does_not_change_property_ordering_if_set
	it("does not overwrite an existing propertyOrdering", () => {
		const custom = ["code", "symbol", "name"];
		const schema = {
			type: "object",
			properties: {
				name: { type: "string" },
				code: { type: "string" },
				symbol: { type: "string" },
			},
			propertyOrdering: [...custom],
		} as const;

		const sanitized = normalizeSchemaForGoogle(schema) as Record<string, unknown>;
		expect(sanitized.propertyOrdering).toEqual(custom);
	});

	// Covers python-genai _transformers.py:745-752 snake_case → camelCase renames.
	it("normalizes snake_case schema field names to camelCase", () => {
		const schema = {
			type: "object",
			properties: {
				foo: { type: "string" },
				bar: { type: "string" },
			},
			property_ordering: ["bar", "foo"],
		} as const;

		const sanitized = normalizeSchemaForGoogle(schema) as Record<string, unknown>;
		expect(sanitized.propertyOrdering).toEqual(["bar", "foo"]);
		expect(sanitized.property_ordering).toBeUndefined();
	});

	// Covers python-genai _transformers.py:751 snake-wins-over-camel collision behavior.
	it("lets snake_case overwrite an existing camelCase entry on collision", () => {
		const schema = {
			anyOf: [{ type: "string" }],
			any_of: [{ type: "integer" }, { type: "number" }],
		} as const;

		const sanitized = normalizeSchemaForGoogle(schema) as Record<string, unknown>;
		expect(sanitized.anyOf).toEqual([{ type: "integer" }, { type: "number" }]);
		expect(sanitized.any_of).toBeUndefined();
	});

	// Covers python-genai _transformers.py:628-630 bare {type:'null'} flatten.
	it("rewrites a bare {type:'null'} schema as {nullable:true}", () => {
		expect(normalizeSchemaForGoogle({ type: "null" })).toEqual({ nullable: true });
	});

	// Covers python-genai _transformers.py:631-640 single-non-null anyOf flatten.
	it("flattens anyOf:[X, {type:'null'}] into X + nullable", () => {
		expect(
			normalizeSchemaForGoogle({
				anyOf: [{ type: "string", title: "Name" }, { type: "null" }],
			}),
		).toEqual({ type: "string", title: "Name", nullable: true });
	});
});
