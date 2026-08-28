import { describe, expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import type { Tool, ToolCall } from "@oh-my-pi/pi-ai/types";
import {
	adaptSchemaForStrict,
	arkToWireSchema,
	enforceStrictSchema,
	isJsonSchemaValueValid,
	isValidJsonSchema,
	sanitizeSchemaForOpenAIResponses,
	sanitizeSchemaForStrictMode,
	toolWireSchema,
	tryEnforceStrictSchema,
} from "@oh-my-pi/pi-ai/utils/schema";
import { validateToolArguments } from "@oh-my-pi/pi-ai/utils/validation";

describe("sanitizeSchemaForStrictMode", () => {
	it("infers object type, strips non-structural keywords, and converts const to enum", () => {
		const schema = {
			properties: {
				token: {
					const: "abc",
					minLength: 3,
					format: "email",
				},
			},
			required: ["token"],
			format: "uuid",
			pattern: "[a-z]+",
		} as Record<string, unknown>;

		const sanitized = sanitizeSchemaForStrictMode(schema);
		const properties = sanitized.properties as Record<string, Record<string, unknown>>;
		const tokenSchema = properties.token;

		expect(sanitized.type).toBe("object");
		expect(sanitized.format).toBeUndefined();
		expect(sanitized.pattern).toBeUndefined();
		expect(tokenSchema.enum).toEqual(["abc"]);
		expect(tokenSchema.const).toBeUndefined();
		expect(tokenSchema.minLength).toBeUndefined();
		expect(tokenSchema.format).toBeUndefined();
	});

	it("strips unsupported object-key constraints like propertyNames", () => {
		const schema = {
			type: "object",
			properties: {
				metadata: {
					type: "object",
					properties: { value: { type: "string" } },
					required: ["value"],
					propertyNames: { type: "string" },
					minProperties: 1,
				},
			},
			required: ["metadata"],
			propertyNames: { type: "string" },
		} as Record<string, unknown>;

		const sanitized = sanitizeSchemaForStrictMode(schema);
		const properties = sanitized.properties as Record<string, Record<string, unknown>>;
		const metadataSchema = properties.metadata;

		expect(sanitized.propertyNames).toBeUndefined();
		expect((metadataSchema as Record<string, unknown>).propertyNames).toBeUndefined();
		expect((metadataSchema as Record<string, unknown>).minProperties).toBeUndefined();
	});
	it("normalizes type arrays into anyOf variants and cleans non-object branches", () => {
		const schema = {
			type: ["object", "null"],
			properties: {
				data: { type: "string" },
			},
			required: ["data"],
			minLength: 1,
		} as Record<string, unknown>;

		const sanitized = sanitizeSchemaForStrictMode(schema);
		expect(Array.isArray(sanitized.anyOf)).toBe(true);

		const variants = sanitized.anyOf as Array<Record<string, unknown>>;
		const objectVariant = variants.find(variant => variant.type === "object");
		const nullVariant = variants.find(variant => variant.type === "null");

		expect(objectVariant).toBeDefined();
		expect(nullVariant).toEqual({ type: "null" });
		expect((objectVariant as Record<string, unknown>).required).toEqual(["data"]);
		expect((objectVariant as Record<string, unknown>).properties).toEqual({ data: { type: "string" } });
	});

	it("distributes enum values to matching nullable type-array branches", () => {
		const sanitized = sanitizeSchemaForStrictMode({
			type: ["string", "null"],
			enum: ["javascript", "python", null],
			description: "guide",
		});

		expect(sanitized).toEqual({
			anyOf: [
				{ enum: ["javascript", "python"], type: "string" },
				{ enum: [null], type: "null" },
			],
			description: "guide",
		});
	});

	it("drops type-array branches that cannot satisfy enum constraints", () => {
		const sanitized = sanitizeSchemaForStrictMode({
			type: ["string", "null"],
			enum: ["javascript", "python"],
		});

		expect(sanitized).toEqual({
			enum: ["javascript", "python"],
			type: "string",
		});
	});

	it("keeps OpenAI Responses strict schemas valid for nullable MCP enum parameters", () => {
		const guideEnum = ["javascript", "python"];
		const raw = {
			type: "object",
			properties: {
				guide: {
					anyOf: [{ type: "string", enum: guideEnum, description: "guide" }, { type: "null" }],
					default: null,
					description: "guide",
				},
			},
			required: ["guide"],
			additionalProperties: false,
		};

		const wired = toolWireSchema({
			name: "mcp__sentry_search_docs",
			description: "",
			parameters: structuredClone(raw),
		});
		const responses = sanitizeSchemaForOpenAIResponses(wired);
		const strict = adaptSchemaForStrict(responses, true);
		const properties = strict.schema.properties as Record<string, Record<string, unknown>>;

		expect(strict.strict).toBe(true);
		expect(properties.guide).toEqual({
			anyOf: [
				{ enum: ["javascript", "python"], type: "string" },
				{ enum: [null], type: "null" },
			],
			description: "guide (default: null)",
		});
	});

	it("keeps existing anyOf constraints inside each normalized type variant", () => {
		const schema = {
			type: ["object", "null"],
			anyOf: [
				{
					type: "object",
					properties: { kind: { const: "ok" } },
					required: ["kind"],
				},
			],
		} as Record<string, unknown>;

		const sanitized = sanitizeSchemaForStrictMode(schema);
		const variants = sanitized.anyOf as Array<Record<string, unknown>>;
		const objectVariant = variants.find(variant => variant.type === "object");
		const nullVariant = variants.find(variant => variant.type === "null");

		expect(variants).toHaveLength(2);
		expect(objectVariant).toBeDefined();
		expect(nullVariant).toBeDefined();
		expect(Array.isArray((objectVariant as Record<string, unknown>).anyOf)).toBe(true);
		expect(Array.isArray((nullVariant as Record<string, unknown>).anyOf)).toBe(true);
		expect(((objectVariant as Record<string, unknown>).anyOf as unknown[]).length).toBe(1);
		expect(((nullVariant as Record<string, unknown>).anyOf as unknown[]).length).toBe(1);
	});
	it("inlines `default` value into `description` before stripping it", () => {
		const schema = {
			type: "number",
			description: "Timeout in seconds",
			default: 60,
		} as Record<string, unknown>;

		const sanitized = sanitizeSchemaForStrictMode(schema);

		expect(sanitized.default).toBeUndefined();
		expect(sanitized.description).toBe("Timeout in seconds (default: 60)");
	});

	it("preserves `default` for various primitive types when inlining", () => {
		const numberSchema = sanitizeSchemaForStrictMode({
			type: "number",
			description: "n",
			default: 0,
		});
		const boolSchema = sanitizeSchemaForStrictMode({
			type: "boolean",
			description: "flag",
			default: true,
		});
		const stringSchema = sanitizeSchemaForStrictMode({
			type: "string",
			description: "path",
			default: "cwd",
		});

		expect(numberSchema.description).toBe("n (default: 0)");
		expect(boolSchema.description).toBe("flag (default: true)");
		expect(stringSchema.description).toBe("path (default: cwd)");
	});

	it("does not double-inline when description already mentions `(default:`", () => {
		const schema = {
			type: "number",
			description: "Timeout in seconds (default: 60)",
			default: 60,
		} as Record<string, unknown>;

		const sanitized = sanitizeSchemaForStrictMode(schema);

		expect(sanitized.description).toBe("Timeout in seconds (default: 60)");
		expect(sanitized.default).toBeUndefined();
	});

	it("strips `default` when no sibling description exists (no synthesis)", () => {
		const schema = {
			type: "number",
			default: 60,
		} as Record<string, unknown>;

		const sanitized = sanitizeSchemaForStrictMode(schema);

		expect(sanitized.default).toBeUndefined();
		expect(sanitized.description).toBeUndefined();
	});

	it("inlines falsy and null defaults without treating them as absent", () => {
		const boolFalse = sanitizeSchemaForStrictMode({
			type: "boolean",
			description: "flag",
			default: false,
		});
		const emptyStr = sanitizeSchemaForStrictMode({
			type: "string",
			description: "name",
			default: "",
		});
		const nullDefault = sanitizeSchemaForStrictMode({
			type: "string",
			description: "value",
			default: null,
		});

		expect(boolFalse.description).toBe("flag (default: false)");
		expect(boolFalse.default).toBeUndefined();
		expect(emptyStr.description).toBe("name (default: )");
		expect(emptyStr.default).toBeUndefined();
		expect(nullDefault.description).toBe("value (default: null)");
		expect(nullDefault.default).toBeUndefined();
	});

	it("inlines defaults on nested object properties via recursion", () => {
		const schema = {
			type: "object",
			properties: {
				outer: {
					type: "object",
					properties: {
						retries: {
							type: "number",
							description: "retry count",
							default: 3,
						},
					},
					required: ["retries"],
				},
			},
			required: ["outer"],
		} as Record<string, unknown>;

		const sanitized = sanitizeSchemaForStrictMode(schema);
		const outer = (sanitized.properties as Record<string, Record<string, unknown>>).outer;
		const retries = (outer.properties as Record<string, Record<string, unknown>>).retries;

		expect(retries.default).toBeUndefined();
		expect(retries.description).toBe("retry count (default: 3)");
	});

	it("hoists shared description to the wrapper when expanding a nullable type-array", () => {
		const schema = {
			type: ["number", "null"],
			description: "timeout",
			default: 60,
		} as Record<string, unknown>;

		const sanitized = sanitizeSchemaForStrictMode(schema);
		const variants = sanitized.anyOf as Array<Record<string, unknown>>;
		const numberVariant = variants.find(v => v.type === "number");
		const nullVariant = variants.find(v => v.type === "null");

		// Description with the inlined `(default: …)` suffix lives on the
		// wrapper, not duplicated onto each variant — matches the optional-
		// property wrap shape produced by `enforceStrictSchema`.
		expect(sanitized.description).toBe("timeout (default: 60)");
		expect(numberVariant).toEqual({ type: "number" });
		expect(nullVariant).toEqual({ type: "null" });
	});
	// Mirrors: openai-python/tests/lib/test_pydantic.py::test_nested_inline_ref_expansion
	// SDK behavior: a `$ref` with sibling keys (e.g. description) must be unraveled —
	// resolve the ref, merge its contents, then let the sibling keys override the def's.
	it("unravels `$ref` with sibling keys by inlining the resolved def (siblings win)", () => {
		const schema = {
			type: "object",
			$defs: {
				Star: {
					type: "object",
					properties: { name: { type: "string", description: "The name of the star." } },
					required: ["name"],
				},
			},
			properties: {
				largest_star: {
					$ref: "#/$defs/Star",
					description: "The largest star in the galaxy.",
				},
			},
			required: ["largest_star"],
		} as Record<string, unknown>;

		const sanitized = sanitizeSchemaForStrictMode(schema);
		const props = sanitized.properties as Record<string, Record<string, unknown>>;
		const largest = props.largest_star;

		// $ref dropped; def contents inlined.
		expect(largest.$ref).toBeUndefined();
		expect(largest.type).toBe("object");
		// Sibling description wins over any description in the def.
		expect(largest.description).toBe("The largest star in the galaxy.");
		// Nested properties from the def are present.
		const nested = largest.properties as Record<string, Record<string, unknown>>;
		expect(nested.name.type).toBe("string");
	});

	// SDK: a bare `$ref` (no sibling keys) is preserved as-is; only siblings trigger unravel.
	// Cite: openai-python/src/openai/lib/_pydantic.py:96-110 (`has_more_than_n_keys`)
	it("preserves bare `$ref` with no sibling keys", () => {
		const schema = {
			type: "object",
			$defs: { Foo: { type: "string" } },
			properties: { foo: { $ref: "#/$defs/Foo" } },
			required: ["foo"],
		} as Record<string, unknown>;

		const sanitized = sanitizeSchemaForStrictMode(schema);
		const props = sanitized.properties as Record<string, Record<string, unknown>>;
		expect(props.foo).toEqual({ $ref: "#/$defs/Foo" });
	});

	// SDK: when a `$ref` cannot be resolved (external / unknown segment), leave it alone
	// rather than dropping data. Our sanitizer falls back to passing it through.
	it("leaves unresolvable `$ref` siblings intact", () => {
		const schema = {
			type: "object",
			properties: {
				foo: { $ref: "#/$defs/Missing", description: "x" },
			},
			required: ["foo"],
		} as Record<string, unknown>;

		const sanitized = sanitizeSchemaForStrictMode(schema);
		const props = sanitized.properties as Record<string, Record<string, unknown>>;
		expect(props.foo.$ref).toBe("#/$defs/Missing");
		expect(props.foo.description).toBe("x");
	});

	// Mirrors: openai-python SDK rule — `allOf` with exactly one entry is inlined
	// and `allOf` is removed; with multiple entries `allOf` is recursed instead.
	// Cite: openai-python/src/openai/lib/_pydantic.py:79-83
	it("inlines single-element `allOf` and drops the keyword", () => {
		const schema = {
			type: "object",
			properties: {
				wrapped: {
					allOf: [{ type: "string", description: "from allOf" }],
				},
			},
			required: ["wrapped"],
		} as Record<string, unknown>;

		const sanitized = sanitizeSchemaForStrictMode(schema);
		const props = sanitized.properties as Record<string, Record<string, unknown>>;
		expect(props.wrapped.allOf).toBeUndefined();
		expect(props.wrapped.type).toBe("string");
		expect(props.wrapped.description).toBe("from allOf");
	});

	// Cite: openai-python/src/openai/lib/_pydantic.py:79-83 — `json_schema.update(ensured)`
	// means the inlined entry's keys WIN over original sibling keys.
	it("inlines single-element `allOf` with the inlined entry winning over siblings", () => {
		const schema = {
			type: "string",
			description: "outer",
			allOf: [{ description: "inner" }],
		} as Record<string, unknown>;

		const sanitized = sanitizeSchemaForStrictMode(schema);
		expect(sanitized.allOf).toBeUndefined();
		expect(sanitized.description).toBe("inner");
	});

	// SDK does NOT inline `allOf` with more than one entry — it recurses each branch.
	// Cite: openai-python/src/openai/lib/_pydantic.py:84-88
	it("does not collapse `allOf` when it has multiple entries", () => {
		const schema = {
			type: "object",
			properties: {
				combo: {
					allOf: [
						{ type: "object", properties: { a: { type: "string" } }, required: ["a"] },
						{ type: "object", properties: { b: { type: "number" } }, required: ["b"] },
					],
				},
			},
			required: ["combo"],
		} as Record<string, unknown>;

		const sanitized = sanitizeSchemaForStrictMode(schema);
		const props = sanitized.properties as Record<string, Record<string, unknown>>;
		const combo = props.combo as Record<string, unknown>;
		expect(Array.isArray(combo.allOf)).toBe(true);
		expect((combo.allOf as unknown[]).length).toBe(2);
	});

	// Mirrors: openai-python/tests/lib/test_pydantic.py::test_nested_inline_ref_expansion
	// End-to-end via tryEnforceStrictSchema: a tree mixing nested objects and a $ref-with-sibling
	// description gets `additionalProperties: false` on every object node and every
	// property forced into `required` — matching the SDK's strict snapshot.
	it("end-to-end: nested objects all get additionalProperties:false + full required (SDK parity)", () => {
		const schema = {
			type: "object",
			$defs: {
				Star: {
					type: "object",
					properties: { name: { type: "string", description: "The name of the star." } },
					required: ["name"],
				},
			},
			properties: {
				name: { type: "string", description: "The name of the universe." },
				galaxy: {
					type: "object",
					properties: {
						name: { type: "string", description: "The name of the galaxy." },
						largest_star: { $ref: "#/$defs/Star", description: "The largest star." },
					},
					required: ["name", "largest_star"],
				},
			},
			required: ["name", "galaxy"],
		} as Record<string, unknown>;

		const { schema: strict, strict: isStrict } = tryEnforceStrictSchema(schema);
		expect(isStrict).toBe(true);
		expect(strict.additionalProperties).toBe(false);
		expect(strict.required).toEqual(["name", "galaxy"]);

		const rootProps = strict.properties as Record<string, Record<string, unknown>>;
		const galaxy = rootProps.galaxy;
		expect(galaxy.additionalProperties).toBe(false);
		expect(galaxy.required).toEqual(["name", "largest_star"]);

		const galaxyProps = galaxy.properties as Record<string, Record<string, unknown>>;
		const largest = galaxyProps.largest_star;
		// $ref was unraveled — inlined as a real object node.
		expect(largest.$ref).toBeUndefined();
		expect(largest.type).toBe("object");
		expect(largest.additionalProperties).toBe(false);
		expect(largest.required).toEqual(["name"]);
		// Sibling description survived the unravel.
		expect(largest.description).toBe("The largest star.");

		// The original $def was also enforced strict-mode style.
		const defs = strict.$defs as Record<string, Record<string, unknown>>;
		expect(defs.Star.additionalProperties).toBe(false);
		expect(defs.Star.required).toEqual(["name"]);
	});
});

describe("enforceStrictSchema", () => {
	it("converts optional properties to nullable schemas and requires all object keys", () => {
		const schema = arkToWireSchema(
			type({
				requiredText: type("string"),
				optionalCount: type("number").optional(),
			}),
		);

		const strict = enforceStrictSchema(schema);
		const properties = strict.properties as Record<string, Record<string, unknown>>;

		expect(strict.required).toEqual(["requiredText", "optionalCount"]);
		expect((properties.requiredText.type as string) === "string").toBe(true);
		const optionalVariants = (properties.optionalCount.anyOf as Array<{ type?: string }>).map(v => v.type);
		expect(optionalVariants).toEqual(["number", "null"]);
	});

	it("flattens optional union schemas instead of nesting anyOf wrappers", () => {
		const schema = arkToWireSchema(
			type({
				paths: type.union([type("string"), type("string").array()]).optional(),
			}),
		);

		const strict = enforceStrictSchema(schema);
		const properties = strict.properties as Record<string, Record<string, unknown>>;
		const branches = properties.paths.anyOf as Array<Record<string, unknown>>;

		expect(branches.map(branch => branch.type)).toEqual(["string", "array", "null"]);
		expect(branches.some(branch => Array.isArray(branch.anyOf))).toBe(false);
	});

	it("wraps constrained optional anyOf schemas so null is not blocked by sibling constraints", () => {
		const strict = enforceStrictSchema({
			type: "object",
			properties: {
				choice: {
					type: "string",
					anyOf: [{ enum: ["a"] }, { enum: ["b"] }],
				},
			},
		});
		const properties = strict.properties as Record<string, Record<string, unknown>>;
		const branches = properties.choice.anyOf as Array<Record<string, unknown>>;

		expect(branches).toHaveLength(2);
		expect(branches[0].type).toBe("string");
		expect(Array.isArray(branches[0].anyOf)).toBe(true);
		expect(branches[1]).toEqual({ type: "null" });
	});

	it("splices natively nested pure unions into the parent anyOf", () => {
		const strict = enforceStrictSchema({
			type: "object",
			properties: {
				value: {
					anyOf: [
						{ anyOf: [{ type: "string" }, { type: "number" }], description: "inner union" },
						{ type: "boolean" },
					],
				},
				optionalValue: {
					anyOf: [{ anyOf: [{ type: "string" }, { type: "number" }] }, { type: "boolean" }],
				},
			},
			required: ["value"],
		});
		const properties = strict.properties as Record<string, Record<string, unknown>>;

		const valueBranches = properties.value.anyOf as Array<Record<string, unknown>>;
		expect(valueBranches.map(branch => branch.type)).toEqual(["string", "number", "boolean"]);
		expect(properties.value.description).toBe("inner union");

		// Optional property: splice happens first, then the nullable append stays flat.
		const optionalBranches = properties.optionalValue.anyOf as Array<Record<string, unknown>>;
		expect(optionalBranches.map(branch => branch.type)).toEqual(["string", "number", "boolean", "null"]);
		expect(optionalBranches.some(branch => Array.isArray(branch.anyOf))).toBe(false);
	});

	it("does not splice anyOf branches that carry sibling constraints", () => {
		const strict = enforceStrictSchema({
			type: "object",
			properties: {
				value: {
					anyOf: [{ type: "string", anyOf: [{ enum: ["a"] }, { enum: ["b"] }] }, { type: "number" }],
				},
			},
			required: ["value"],
		});
		const properties = strict.properties as Record<string, Record<string, unknown>>;
		const branches = properties.value.anyOf as Array<Record<string, unknown>>;

		// `anyOf` is conjunctive with siblings — spreading would drop `type: "string"`.
		expect(branches).toHaveLength(2);
		expect(branches[0].type).toBe("string");
		expect(Array.isArray(branches[0].anyOf)).toBe(true);
	});

	it("never emits undefined as a schema type", () => {
		const schema = arkToWireSchema(
			type({
				questions: type.array(
					type({
						id: type("string"),
						recommended: type("number").optional(),
					}),
				),
			}),
		);

		const strict = enforceStrictSchema(schema);
		const serialized = JSON.stringify(strict);

		expect(serialized.includes('"undefined"')).toBe(false);
		expect(serialized.includes('"null"')).toBe(true);
	});

	it("normalizes malformed object nodes that declare required keys without properties", () => {
		const schema = {
			type: "object",
			required: ["data"],
		} as Record<string, unknown>;

		const strict = enforceStrictSchema(schema);

		expect(strict.properties).toEqual({});
		expect(strict.required).toEqual([]);
		expect(strict.additionalProperties).toBe(false);
	});

	it("repairs malformed object branches nested under anyOf", () => {
		const schema = {
			type: "object",
			properties: {
				result: {
					anyOf: [
						{ type: "object", required: ["data"] },
						{ type: "object", properties: { error: { type: "string" } }, required: ["error"] },
					],
				},
			},
			required: ["result"],
		} as Record<string, unknown>;

		const strict = enforceStrictSchema(schema);
		const rootProps = strict.properties as Record<string, Record<string, unknown>>;
		const resultSchema = rootProps.result;
		const branches = resultSchema.anyOf as Array<Record<string, unknown>>;
		const malformedBranch = branches[0];
		const validBranch = branches[1];

		expect(malformedBranch.properties).toEqual({});
		expect(malformedBranch.required).toEqual([]);
		expect(malformedBranch.additionalProperties).toBe(false);
		expect(validBranch.required).toEqual(["error"]);
		expect(validBranch.additionalProperties).toBe(false);
	});

	it("reuses enforced object schemas across shared branches", () => {
		const sharedTaskSchema = {
			type: "object",
			properties: {
				content: { type: "string" },
				notes: { type: "string" },
			},
			required: ["content"],
		} as Record<string, unknown>;
		const schema = {
			type: "object",
			properties: {
				primary: {
					type: "array",
					items: sharedTaskSchema,
				},
				secondary: {
					anyOf: [{ type: "array", items: sharedTaskSchema }, { type: "null" }],
				},
			},
			required: ["primary", "secondary"],
		} as Record<string, unknown>;

		const strict = enforceStrictSchema(schema);
		const rootProperties = strict.properties as Record<string, Record<string, unknown>>;
		const primaryItems = rootProperties.primary.items as Record<string, unknown>;
		const secondaryBranches = rootProperties.secondary.anyOf as Array<Record<string, unknown>>;
		const secondaryItems = secondaryBranches[0]?.items as Record<string, unknown>;

		expect(primaryItems.additionalProperties).toBe(false);
		expect(primaryItems.required).toEqual(["content", "notes"]);
		expect(secondaryItems.additionalProperties).toBe(false);
		expect(secondaryItems.required).toEqual(["content", "notes"]);
		expect(secondaryItems.properties).toEqual(primaryItems.properties);
	});

	it("treats type arrays containing object as object schemas via tryEnforceStrictSchema", () => {
		const schema = {
			type: ["object", "null"],
			properties: { value: { type: "string" } },
			required: ["value"],
		} as Record<string, unknown>;

		const result = tryEnforceStrictSchema(schema);

		expect(result.strict).toBe(true);
		// sanitizeSchemaForStrictMode splits type arrays into anyOf variants
		const branches = result.schema.anyOf as Array<Record<string, unknown>>;
		expect(branches).toHaveLength(2);

		const objectBranch = branches.find(b => b.type === "object") as Record<string, unknown>;
		const nullBranch = branches.find(b => b.type === "null");
		expect(objectBranch).toBeDefined();
		expect(nullBranch).toBeDefined();

		// enforceStrictSchema applied object constraints to the object variant
		expect(objectBranch.additionalProperties).toBe(false);
		expect(objectBranch.required).toEqual(["value"]);
		const properties = objectBranch.properties as Record<string, Record<string, unknown>>;
		expect(properties.value.type).toBe("string");
	});
});

describe("tryEnforceStrictSchema", () => {
	it("sanitizes strict schemas by stripping unsupported format keywords", () => {
		const schema = {
			type: "object",
			properties: {
				url: { type: "string", format: "uri" },
			},
			required: ["url"],
			format: "uuid",
		} as Record<string, unknown>;

		const result = tryEnforceStrictSchema(schema);
		const properties = result.schema.properties as Record<string, Record<string, unknown>>;

		expect(result.strict).toBe(true);
		expect(result.schema.format).toBeUndefined();
		expect(properties.url.format).toBeUndefined();
		expect(properties.url.type).toBe("string");
	});
	it("sanitizes propertyNames so strict mode stays enabled", () => {
		const schema = {
			type: "object",
			properties: {
				tags: {
					type: "object",
					properties: { key: { type: "string" } },
					required: ["key"],
					propertyNames: { type: "string" },
				},
			},
			required: ["tags"],
			propertyNames: { type: "string" },
		} as Record<string, unknown>;

		const result = tryEnforceStrictSchema(schema);
		const properties = result.schema.properties as Record<string, Record<string, unknown>>;
		const tagsSchema = properties.tags;

		expect(result.strict).toBe(true);
		expect(result.schema.propertyNames).toBeUndefined();
		expect((tagsSchema as Record<string, unknown>).propertyNames).toBeUndefined();
	});
	it("downgrades to non-strict mode when strict enforcement throws", () => {
		const circularSchema: Record<string, unknown> = {
			type: "object",
			properties: {},
		};
		(circularSchema.properties as Record<string, unknown>).self = circularSchema;

		const result = tryEnforceStrictSchema(circularSchema);

		expect(result.strict).toBe(false);
		expect(result.schema).toBe(circularSchema);
	});

	it("keeps strict mode enabled for valid schemas", () => {
		const schema = {
			type: "object",
			properties: { value: { type: "string" } },
			required: ["value"],
		} as Record<string, unknown>;

		const result = tryEnforceStrictSchema(schema);

		expect(result.strict).toBe(true);
		expect(result.schema.additionalProperties).toBe(false);
		expect(result.schema.required).toEqual(["value"]);
	});
	it("degrades to non-strict when array items is an empty schema", () => {
		const schema = {
			type: "object",
			properties: {
				slide_instructions: { items: {}, type: "array" },
			},
			required: ["slide_instructions"],
		} as Record<string, unknown>;

		const result = tryEnforceStrictSchema(schema);

		expect(result.strict).toBe(false);
		expect(result.schema).toBe(schema);
	});

	it("keeps shared object schemas strict-compatible after adaptation", () => {
		const sharedTaskSchema = type({
			content: type("string"),
			status: type("string").optional(),
			notes: type("string").optional(),
		});
		const schema = arkToWireSchema(
			type({
				ops: type.array(
					type.union([
						type({
							op: type.unit("replace"),
							tasks: type.array(sharedTaskSchema),
						}),
						type({
							op: type.unit("update"),
							tasks: type.array(sharedTaskSchema).optional(),
						}),
					]),
				),
			}),
		);

		const result = tryEnforceStrictSchema(schema);
		const rootProperties = result.schema.properties as Record<string, Record<string, unknown>>;
		const opBranches = ((rootProperties.ops.items as Record<string, unknown>).anyOf ?? []) as Array<
			Record<string, unknown>
		>;
		const replaceTasks = ((opBranches[0]?.properties as Record<string, Record<string, unknown>>)?.tasks?.items ??
			{}) as Record<string, unknown>;
		const updateTasks = (
			((opBranches[1]?.properties as Record<string, Record<string, unknown>>)?.tasks?.anyOf ?? []) as Array<
				Record<string, unknown>
			>
		)[0]?.items as Record<string, unknown>;

		expect(result.strict).toBe(true);
		expect(replaceTasks.additionalProperties).toBe(false);
		expect(replaceTasks.required).toEqual(["content", "status", "notes"]);
		expect(updateTasks.additionalProperties).toBe(false);
		expect(updateTasks.required).toEqual(["content", "status", "notes"]);
	});

	it("falls back to non-strict for mixed-primitive enum roots (no representable type)", () => {
		// `{enum:[1, "two", null]}` cannot be reduced to a single `type` keyword,
		// so strict mode cannot accept it. Older releases set `strict: true` with
		// a typeless `{enum:[...]}` schema that OpenAI strict mode would reject
		// on the wire; the contract is now to fall back to non-strict instead.
		const result = tryEnforceStrictSchema({ enum: [1, "two", null] });
		expect(result.strict).toBe(false);
		expect(result.schema).toEqual({ enum: [1, "two", null] });
	});

	it("falls back to non-strict for non-primitive const roots", () => {
		const objectResult = tryEnforceStrictSchema({ const: { a: 1 } });
		expect(objectResult.strict).toBe(false);
		expect(objectResult.schema).toEqual({ const: { a: 1 } });

		const arrayResult = tryEnforceStrictSchema({ const: [1, 2, 3] });
		expect(arrayResult.strict).toBe(false);
		expect(arrayResult.schema).toEqual({ const: [1, 2, 3] });
	});

	it("infers a primitive type from enum/const when calling enforceStrictSchema directly", () => {
		// `enforceStrictSchema` is a public API. Callers that pass a bare
		// `{enum:[primitives]}` (without first running sanitize) still get a
		// `type` filled in so the result is wire-valid.
		const enumResult = enforceStrictSchema({ enum: ["draft", "published"] });
		expect(enumResult).toEqual({ type: "string", enum: ["draft", "published"] });

		const constResult = enforceStrictSchema({ const: 7 });
		expect(constResult).toEqual({ type: "number", const: 7 });

		// Mixed-primitive enum still throws — caller must fall back via tryEnforce.
		expect(() => enforceStrictSchema({ enum: [1, "two"] })).toThrow();
		// Non-primitive const still throws — caller must fall back via tryEnforce.
		expect(() => enforceStrictSchema({ const: { a: 1 } })).toThrow();
	});
});

describe("json-schema validator unsupported-keyword regressions", () => {
	it("rejects values with keys that fail the propertyNames schema", () => {
		const schema = {
			type: "object",
			propertyNames: { type: "string", pattern: "^[a-z]+$" },
		};
		expect(isJsonSchemaValueValid(schema, { abc: 1 })).toBe(true);
		expect(isJsonSchemaValueValid(schema, { "BAD-KEY": 1 })).toBe(false);
	});

	it("rejects patternProperties mismatches", () => {
		const schema = {
			type: "object",
			patternProperties: { "^id_": { type: "number" } },
		};
		expect(isJsonSchemaValueValid(schema, { id_a: 1 })).toBe(true);
		expect(isJsonSchemaValueValid(schema, { id_a: "not-a-number" })).toBe(false);
	});

	it("rejects values that violate dependentRequired", () => {
		const schema = {
			type: "object",
			dependentRequired: { credit_card: ["billing_address"] },
		};
		expect(isJsonSchemaValueValid(schema, { credit_card: "x", billing_address: "y" })).toBe(true);
		expect(isJsonSchemaValueValid(schema, { credit_card: "x" })).toBe(false);
	});

	it("applies then when if matches and rejects missing required fields", () => {
		const schema = {
			type: "object",
			properties: { kind: { type: "string" }, extra: { type: "string" } },
			if: { properties: { kind: { const: "a" } }, required: ["kind"] },
			// biome-ignore lint/suspicious/noThenProperty: JSON Schema if/then/else keyword
			then: { required: ["extra"] },
		};
		expect(isJsonSchemaValueValid(schema, { kind: "b" })).toBe(true);
		expect(isJsonSchemaValueValid(schema, { kind: "a", extra: "ok" })).toBe(true);
		expect(isJsonSchemaValueValid(schema, { kind: "a" })).toBe(false);
	});

	it("validates contains against array elements", () => {
		const schema = { type: "array", contains: { type: "number" } };
		expect(isJsonSchemaValueValid(schema, ["a", 1])).toBe(true);
		expect(isJsonSchemaValueValid(schema, ["a", "b"])).toBe(false);
	});

	it("validates prefixItems by index", () => {
		const schema = { type: "array", prefixItems: [{ type: "string" }, { type: "number" }] };
		expect(isJsonSchemaValueValid(schema, ["x", 1])).toBe(true);
		expect(isJsonSchemaValueValid(schema, [1, "x"])).toBe(false);
		expect(isJsonSchemaValueValid({ type: "array", items: [{ type: "string" }] }, ["x"])).toBe(false);
	});

	it("recursively validates nested values through self-referential $ref", () => {
		const schema = {
			$ref: "#/definitions/Node",
			definitions: {
				Node: {
					type: "object",
					properties: {
						name: { type: "string" },
						child: { $ref: "#/definitions/Node" },
					},
					required: ["name"],
					additionalProperties: false,
				},
			},
		};
		// Nested shape conforming — should validate.
		expect(isJsonSchemaValueValid(schema, { name: "root", child: { name: "leaf" } })).toBe(true);
		// Nested child violates the inner shape: previously short-circuited to true
		// because the second occurrence of the $ref was treated as a seen ref.
		expect(isJsonSchemaValueValid(schema, { name: "root", child: { name: 123 } })).toBe(false);
		expect(isJsonSchemaValueValid(schema, { name: "root", child: { child: { name: "x" } } })).toBe(false);
	});

	it("fails primitive $ref chains that exceed the recursion cap instead of accepting invalid values", () => {
		const definitions: Record<string, unknown> = {};
		for (let i = 0; i < 66; i += 1) {
			definitions[`A${i}`] = { $ref: `#/definitions/A${i + 1}` };
		}
		definitions.A66 = { type: "number" };

		const schema = { $ref: "#/definitions/A0", definitions };
		expect(isJsonSchemaValueValid(schema, "not-a-number")).toBe(false);
	});
});

describe("meta-validator conditional keywords", () => {
	it("accepts well-formed if/then/else", () => {
		expect(
			isValidJsonSchema({
				type: "object",
				if: { properties: { kind: { const: "a" } } },
				// biome-ignore lint/suspicious/noThenProperty: JSON Schema if/then/else keyword
				then: { required: ["extra"] },
				else: { required: ["other"] },
			}),
		).toBe(true);
	});

	it("rejects malformed if (must be a schema, not an array)", () => {
		expect(isValidJsonSchema({ type: "object", if: [] })).toBe(false);
	});

	it("rejects malformed then", () => {
		// biome-ignore lint/suspicious/noThenProperty: JSON Schema if/then/else keyword
		expect(isValidJsonSchema({ type: "object", then: "not-a-schema" })).toBe(false);
	});

	it("accepts 2020-12 dependent keywords and rejects obsolete tuple/dependency keywords", () => {
		expect(
			isValidJsonSchema({
				type: "object",
				dependentRequired: { a: ["b"] },
				dependentSchemas: { c: { type: "object" } },
			}),
		).toBe(true);
		expect(isValidJsonSchema({ type: "object", dependentRequired: { a: [1] } })).toBe(false);
		expect(isValidJsonSchema({ type: "object", dependentSchemas: { a: 1 } })).toBe(false);
		expect(isValidJsonSchema({ type: "object", dependencies: { a: ["b"] } })).toBe(false);
		expect(isValidJsonSchema({ type: "array", items: [{ type: "string" }] })).toBe(false);
		expect(isValidJsonSchema({ type: "array", additionalItems: false })).toBe(false);
	});
});

describe("Zod root extras preserved through normalize", () => {
	it("retains a null-valued unknown root key after tool-argument validation so downstream rejection still triggers", () => {
		const tool: Tool = {
			name: "simple_tool",
			description: "",
			parameters: type({ assignment: type("string") }),
		};
		const toolCall: ToolCall = {
			type: "toolCall",
			id: "call-zod-null-root",
			name: "simple_tool",
			arguments: { assignment: "do thing", schema: null },
		};

		const result = validateToolArguments(tool, toolCall) as Record<string, unknown>;
		expect(result.assignment).toBe("do thing");
		expect("schema" in result).toBe(true);
		expect(result.schema).toBeNull();
	});
});

describe("adaptSchemaForStrict — unrepresentable open branches fall back to non-strict", () => {
	it("falls back when a property schema is an open `true` (z.unknown())", () => {
		// `z.unknown()` normalizes to `meta: true` (issue #1179); strict providers
		// reject a typeless property, so the schema must downgrade to non-strict
		// rather than emit `strict: true` with a `true` property.
		const wire = toolWireSchema({
			name: "t",
			description: "d",
			parameters: type({ a: type("string"), meta: type("unknown") }),
		} as Tool);
		expect((wire.properties as Record<string, unknown>).meta).toBe(true);
		expect(adaptSchemaForStrict(wire, true).strict).toBe(false);
	});

	it("falls back when a combiner branch is a boolean schema", () => {
		const schema: Record<string, unknown> = {
			type: "object",
			properties: { a: { anyOf: [true, { type: "string" }] } },
			required: ["a"],
			additionalProperties: false,
		};
		expect(adaptSchemaForStrict(schema, true).strict).toBe(false);
	});

	it("falls back when an array `items` schema is unconstrained", () => {
		const schema: Record<string, unknown> = {
			type: "object",
			properties: { xs: { type: "array", items: true } },
			required: ["xs"],
			additionalProperties: false,
		};
		expect(adaptSchemaForStrict(schema, true).strict).toBe(false);
	});

	it("still enforces strict for fully-typed schemas (no false positives)", () => {
		const schema: Record<string, unknown> = {
			type: "object",
			properties: { a: { type: "string" }, b: { type: "number" } },
			required: ["a", "b"],
			additionalProperties: false,
		};
		expect(adaptSchemaForStrict(schema, true).strict).toBe(true);
	});
});
