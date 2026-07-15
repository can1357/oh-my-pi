import { describe, expect, it } from "bun:test";
import { buildRequest } from "@pk-nerdsaver-ai/pi-ai/providers/google-gemini-cli";
import { convertTools } from "@pk-nerdsaver-ai/pi-ai/providers/google-shared";
import type { Context, Model, TJsonSchema, Tool } from "@pk-nerdsaver-ai/pi-ai/types";
import {
	enforceStrictSchema,
	mergeCompatibleEnumSchemas,
	normalizeSchemaForCCA,
	normalizeSchemaForGoogle,
	normalizeSchemaForMCP,
	normalizeSchemaForMoonshot,
	sanitizeSchemaForOpenAIResponses,
	sanitizeSchemaForStrictMode,
	schemaNeedsDraft202012Upgrade,
	stripResidualCombiners,
	tryEnforceStrictSchema,
	upgradeJsonSchemaTo202012,
} from "@pk-nerdsaver-ai/pi-ai/utils/schema";
import { buildModel } from "@pk-nerdsaver-ai/pi-catalog/build";

function createGoogleCliModel(id: string): Model<"google-gemini-cli"> {
	return buildModel({
		id,
		name: id,
		api: "google-gemini-cli",
		provider: "google-antigravity",
		baseUrl: "https://example.com",
		reasoning: false,
		input: ["text"],
		cost: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
		},
		contextWindow: 200000,
		maxTokens: 8192,
	});
}

// ---------------------------------------------------------------------------
// mergeCompatibleEnumSchemas
// ---------------------------------------------------------------------------

describe("mergeCompatibleEnumSchemas", () => {
	it("deduplicates object-valued enum members by deep equality", () => {
		const existing = { type: "object", enum: [{ x: 1 }] };
		const incoming = { type: "object", enum: [{ x: 1 }] };

		expect(mergeCompatibleEnumSchemas(existing, incoming)).toEqual({
			type: "object",
			enum: [{ x: 1 }],
		});
	});

	it("deduplicates structurally equal nested enum values and appends novel ones", () => {
		const existing = {
			type: "object",
			enum: [{ kind: "A", payload: { level: 1 } }],
		};
		const incoming = {
			type: "object",
			enum: [
				{ kind: "A", payload: { level: 1 } },
				{ kind: "B", payload: { level: 2 } },
			],
		};

		const merged = mergeCompatibleEnumSchemas(existing, incoming);

		expect(merged).toEqual({
			type: "object",
			enum: [
				{ kind: "A", payload: { level: 1 } },
				{ kind: "B", payload: { level: 2 } },
			],
		});
	});
});

// ---------------------------------------------------------------------------
// sanitizeSchemaForStrictMode
// ---------------------------------------------------------------------------

describe("sanitizeSchemaForStrictMode", () => {
	it("converts nullable keyword to explicit null union", () => {
		const sanitized = sanitizeSchemaForStrictMode({
			type: "string",
			nullable: true,
		});

		expect(sanitized).toEqual({
			anyOf: [{ type: "string" }, { type: "null" }],
		});
	});

	it("hoists description to the wrapper when wrapping `nullable: true` as an anyOf", () => {
		// Sanitize-side nullable wrap mirrors the optional-property wrap shape
		// produced by `enforceStrictSchema`: description lives on the wrapper,
		// branches stay bare. Both top-level entry points share this contract
		// so downstream consumers don't have to special-case which path produced
		// the nullable union.
		const sanitized = sanitizeSchemaForStrictMode({
			type: "string",
			nullable: true,
			description: "label",
		});

		expect(sanitized).toEqual({
			anyOf: [{ type: "string" }, { type: "null" }],
			description: "label",
		});
	});

	it("strips not branches", () => {
		const schema = {
			type: "object",
			not: {
				type: "object",
				properties: { token: { const: "secret" } },
				required: ["token"],
			},
		} as Record<string, unknown>;

		const sanitized = sanitizeSchemaForStrictMode(schema);

		expect(sanitized.not).toBeUndefined();
	});

	it("merges const into existing enum instead of overwriting", () => {
		const schema = {
			type: "string",
			enum: ["A", "B"],
			const: "C",
		} as Record<string, unknown>;

		const sanitized = sanitizeSchemaForStrictMode(schema);

		expect(sanitized.enum).toEqual(["A", "B", "C"]);
	});
});

// ---------------------------------------------------------------------------
// upgradeJsonSchemaTo202012
// ---------------------------------------------------------------------------

describe("upgradeJsonSchemaTo202012", () => {
	it("infers draft-07 tuple and dependency keywords without a $schema URI", () => {
		const schema = {
			type: "object",
			properties: {
				definitions: { type: "string" },
				tuple: {
					type: "array",
					items: [{ type: "string" }, { type: "integer" }],
					additionalItems: false,
				},
				gated: {
					type: "object",
					dependencies: {
						a: ["b"],
						c: { required: ["d"] },
					},
				},
			},
			definitions: {
				Ref: { type: "string" },
			},
		};

		expect(schemaNeedsDraft202012Upgrade(schema)).toBe(true);
		expect(upgradeJsonSchemaTo202012(schema)).toEqual({
			type: "object",
			properties: {
				definitions: { type: "string" },
				tuple: {
					type: "array",
					prefixItems: [{ type: "string" }, { type: "integer" }],
					items: false,
				},
				gated: {
					type: "object",
					dependentRequired: { a: ["b"] },
					dependentSchemas: { c: { required: ["d"] } },
				},
			},
			$defs: {
				Ref: { type: "string" },
			},
		});
	});

	it("returns unchanged schemas by identity when no draft upgrade is needed", () => {
		const schema = { type: "object", properties: { name: { type: "string" } } };

		expect(schemaNeedsDraft202012Upgrade(schema)).toBe(false);
		expect(upgradeJsonSchemaTo202012(schema)).toBe(schema);
	});
});

// ---------------------------------------------------------------------------
// normalizeSchemaForGoogle
// ---------------------------------------------------------------------------

describe("normalizeSchemaForGoogle", () => {
	it("sets object type when converting an object const to an enum entry", () => {
		const sanitized = normalizeSchemaForGoogle({
			const: { a: 1 },
		});

		expect(sanitized).toEqual({
			type: "object",
			properties: {},
			enum: [{ a: 1 }],
		});
	});

	it("deduplicates a deep-equal object const against an existing enum entry", () => {
		const sanitized = normalizeSchemaForGoogle({
			type: "object",
			enum: [{ a: 1 }],
			const: { a: 1 },
		});

		expect(sanitized).toEqual({
			type: "object",
			properties: {},
			enum: [{ a: 1 }],
		});
	});

	it("does not stamp a wrong scalar type when const variants span multiple primitive types", () => {
		const sanitized = normalizeSchemaForGoogle({
			anyOf: [
				{ const: "A", type: "string" },
				{ const: 1, type: "number" },
				{ const: true, type: "boolean" },
			],
		}) as Record<string, unknown>;

		expect(sanitized.enum).toEqual(["A", 1, true]);
		expect(sanitized.type).toBeUndefined();
	});

	it("collapses inferred null type to nullable when const is null", () => {
		// After python-genai parity (handle_null_fields), bare `type: 'null'` is
		// folded into `nullable: true` so the schema is OpenAPI-compatible.
		const sanitized = normalizeSchemaForGoogle({ const: null }) as Record<string, unknown>;

		expect(sanitized.type).toBeUndefined();
		expect(sanitized.nullable).toBe(true);
		expect(sanitized.enum).toEqual([null]);
	});

	it("keeps a property literally named additionalProperties, coercing its boolean schema", () => {
		const sanitized = normalizeSchemaForGoogle({
			type: "object",
			properties: {
				additionalProperties: false,
				name: { type: "string" },
			},
		}) as Record<string, unknown>;

		// The property must not be stripped as the `additionalProperties`
		// keyword; its boolean schema form is rewritten to an object because
		// Google's Schema proto rejects boolean subschemas (HTTP 400).
		const properties = sanitized.properties as Record<string, unknown>;
		expect(Object.hasOwn(properties, "additionalProperties")).toBe(true);
		expect(properties.additionalProperties).toEqual({});
	});

	it("coerces boolean property schemas to empty object schemas for the Google wire", () => {
		// Regression: `router_capture_tool_use` declares `args`/`result`/`error`
		// as the JSON Schema `true` ("any value"). Cloud Code Assist rejected the
		// whole request with `Invalid value at '...properties[9].value'` because
		// the Schema proto cannot parse a boolean where a message is expected.
		const schema = {
			type: "object",
			properties: {
				toolName: { type: "string" },
				args: true,
				result: true,
				error: false,
			},
			required: ["toolName"],
		};

		for (const normalize of [normalizeSchemaForGoogle, normalizeSchemaForCCA]) {
			const sanitized = normalize(schema) as Record<string, unknown>;
			const properties = sanitized.properties as Record<string, unknown>;
			expect(properties.toolName).toEqual({ type: "string" });
			expect(properties.args).toEqual({});
			expect(properties.result).toEqual({});
			expect(properties.error).toEqual({});
		}
	});

	it("coerces boolean subschemas in items and applies union algebra to combinator variants", () => {
		const schema = {
			type: "object",
			properties: {
				list: { type: "array", items: true },
				either: { anyOf: [{ type: "string" }, true] },
				narrowed: { anyOf: [{ type: "string" }, false] },
			},
		};

		for (const normalize of [normalizeSchemaForGoogle, normalizeSchemaForCCA]) {
			const sanitized = normalize(schema) as Record<string, unknown>;
			const properties = sanitized.properties as Record<string, Record<string, unknown>>;
			// The whole node survives — CCA must not collapse to its whole-schema
			// fallback because of a boolean combinator variant.
			expect(sanitized.type).toBe("object");
			expect(properties.list?.items).toEqual({});
			// `true` variant ⇒ the union accepts anything ⇒ combinator dropped.
			expect(properties.either?.anyOf).toBeUndefined();
			// `false` variants are never-valid branches and are removed. Google
			// keeps the single-variant union; CCA's same-type collapse folds it
			// into a bare `type: "string"` node — both preserve the semantics.
			if (normalize === normalizeSchemaForGoogle) {
				expect(properties.narrowed?.anyOf).toEqual([{ type: "string" }]);
			} else {
				expect(properties.narrowed).toEqual({ type: "string" });
			}
		}
	});

	it("preserves boolean subschemas on the MCP path", () => {
		const schema = {
			type: "object",
			properties: {
				args: true,
			},
		} as const;

		expect(normalizeSchemaForMCP(schema)).toEqual(schema);
	});

	it("inlines local $ref / $defs entries for Google compatibility", () => {
		// Mirrors python-genai/_transformers.py:754-774 ($defs inlining via
		// `process_schema`) and tests/transformers/test_schema.py::
		// test_process_schema_order_properties_propagates_into_defs.
		const schema = {
			type: "object",
			properties: {
				user: { $ref: "#/$defs/User" },
			},
			required: ["user"],
			$defs: {
				User: {
					type: "object",
					properties: {
						id: { type: "string" },
					},
					required: ["id"],
				},
			},
		} as const;

		expect(normalizeSchemaForGoogle(schema)).toEqual({
			type: "object",
			properties: {
				user: {
					type: "object",
					properties: {
						id: { type: "string" },
					},
					required: ["id"],
				},
			},
			required: ["user"],
		});
	});

	it("lifts stripped validation keywords into description", () => {
		const normalized = normalizeSchemaForGoogle({
			type: "string",
			pattern: "^\\d+$",
			minLength: 1,
			maxLength: 8,
			description: "ID",
		}) as Record<string, unknown>;

		expect(normalized.pattern).toBeUndefined();
		expect(normalized.minLength).toBeUndefined();
		expect(normalized.maxLength).toBeUndefined();
		expect(normalized.description).toBe('ID\n\n{pattern: "^\\\\d+$", minLength: 1, maxLength: 8}');
	});
});

// ---------------------------------------------------------------------------
// normalizeSchemaForMCP
// ---------------------------------------------------------------------------

describe("normalizeSchemaForMCP", () => {
	it("keeps validation keywords without mutating description", () => {
		const normalized = normalizeSchemaForMCP({
			type: "string",
			pattern: "^\\d+$",
			minLength: 1,
			description: "ID",
		}) as Record<string, unknown>;

		expect(normalized).toEqual({
			type: "string",
			pattern: "^\\d+$",
			minLength: 1,
			description: "ID",
		});
	});

	// Regression: issue #1101. Some MCP servers ship `JSON.stringify(zodSchema)`
	// directly as a tool's `inputSchema`. Zod 4 surfaces `.type`, `.enum`,
	// `.options`, and `.def` on every schema instance — those keys collide with
	// JSON Schema keywords, producing payloads that fail Anthropic's strict
	// JSON Schema 2020-12 validator (`"type":"enum"`, `"enum":{...}` as object).
	// `normalizeSchemaForMCP` must rewrite the offending nodes into clean JSON
	// Schema so the tool list still ships.
	it("rewrites a Zod-enum instance leaked as inputSchema", () => {
		const leaked = {
			def: { type: "enum", entries: { upstream: "upstream", downstream: "downstream" } },
			type: "enum",
			enum: { upstream: "upstream", downstream: "downstream" },
			options: ["upstream", "downstream"],
		};
		expect(normalizeSchemaForMCP(leaked)).toEqual({
			type: "string",
			enum: ["upstream", "downstream"],
		});
	});

	it("rewrites a numeric Zod-enum (integer values keep integer type)", () => {
		const leaked = {
			def: { type: "enum", entries: { ONE: 1, TWO: 2 } },
			type: "enum",
			enum: { ONE: 1, TWO: 2 },
			options: [1, 2],
		};
		expect(normalizeSchemaForMCP(leaked)).toEqual({
			type: "integer",
			enum: [1, 2],
		});
	});

	it("rewrites a Zod-literal instance to a single-element enum", () => {
		const leaked = {
			def: { type: "literal", values: ["only"] },
			type: "literal",
			values: ["only"],
		};
		// Decontamination emits `{const:"only"}`; downstream normalizer collapses
		// it to the equivalent enum form. End-to-end contract is what callers see.
		expect(normalizeSchemaForMCP(leaked)).toEqual({ type: "string", enum: ["only"] });
	});

	it("rewrites a Zod-union of literals (downstream collapses anyOf-of-consts to enum)", () => {
		const leaked = {
			def: {
				type: "union",
				options: [
					{ def: { type: "literal", values: ["on"] }, type: "literal", values: ["on"] },
					{ def: { type: "literal", values: ["off"] }, type: "literal", values: ["off"] },
				],
			},
			type: "union",
		};
		expect(normalizeSchemaForMCP(leaked)).toEqual({
			type: "string",
			enum: ["on", "off"],
		});
	});

	it("strips null-valued JSON Schema keywords that Zod scalars leak (format: null, minLength: null)", () => {
		const leaked = {
			def: { type: "string", checks: [] },
			type: "string",
			format: null,
			minLength: null,
			maxLength: null,
		};
		expect(normalizeSchemaForMCP(leaked)).toEqual({ type: "string" });
	});

	it("drops invalid `type` for unmodelled Zod kinds so the residue stays valid", () => {
		const leaked = {
			def: { type: "any" },
			type: "any",
			description: "anything",
		};
		expect(normalizeSchemaForMCP(leaked)).toEqual({ description: "anything" });
	});

	it("leaves a genuine JSON Schema that happens to have a `def` property alone", () => {
		// `def` is not a JSON Schema keyword but it's also not reserved. The
		// detoxifier must only fire when `def.type` is a known Zod kind AND
		// `node.type === def.type`, otherwise it would corrupt real schemas.
		const schema = {
			type: "object",
			properties: { def: { type: "string" } },
			required: ["def"],
		};
		expect(normalizeSchemaForMCP(schema)).toEqual(schema);
	});
});

// ---------------------------------------------------------------------------
// sanitizeSchemaForOpenAIResponses
// ---------------------------------------------------------------------------

describe("sanitizeSchemaForOpenAIResponses", () => {
	it("adds empty properties to object schemas without rewriting literal payloads", () => {
		const literal = { type: "object", oneOf: [{ const: "literal" }] };
		const schema = {
			type: "object",
			properties: {
				nested: { type: "object" },
				union: {
					oneOf: [{ type: "object" }],
				},
			},
			oneOf: [{ type: "object" }],
			enum: [literal],
			const: literal,
			default: literal,
			examples: [literal],
		};

		expect(sanitizeSchemaForOpenAIResponses(schema)).toEqual({
			type: "object",
			properties: {
				nested: { type: "object", properties: {} },
				union: {
					anyOf: [{ type: "object", properties: {} }],
				},
			},
			enum: [literal],
			const: literal,
			default: literal,
			examples: [literal],
			anyOf: [{ type: "object", properties: {} }],
		});
	});

	it("adds empty properties under draft-07 dependencies and draft 2019-09 contentSchema", () => {
		const schema = {
			type: "object",
			properties: {
				body: {
					type: "string",
					contentSchema: { type: "object" },
				},
			},
			dependencies: {
				body: { type: "object" },
				other: ["body"],
			},
		};

		expect(sanitizeSchemaForOpenAIResponses(schema)).toEqual({
			type: "object",
			properties: {
				body: {
					type: "string",
					contentSchema: { type: "object", properties: {} },
				},
			},
			dependencies: {
				body: { type: "object", properties: {} },
				other: ["body"],
			},
		});
	});

	it("adds empty properties when `type` is a draft 2020-12 array including object", () => {
		expect(sanitizeSchemaForOpenAIResponses({ type: ["object", "null"] })).toEqual({
			type: ["object", "null"],
			properties: {},
		});
	});

	it("strips regex lookaround patterns unsupported by OpenAI Responses", () => {
		const schema = {
			type: "object",
			properties: {
				fileKey: { type: "string", pattern: "^(?!undefined$|null$)" },
				ending: { type: "string", pattern: "(?<=/)node$" },
				slug: { type: "string", pattern: "^[a-z0-9_-]+$" },
				literal: { type: "string", pattern: "\\(?!literal" },
				patternOnly: { pattern: "^(?!bad$)" },
				"^(?!property-name)": { type: "string" },
			},
			patternProperties: {
				"^(?!secret_)": { type: "string" },
				"(?<=/)node$": { type: "string" },
				"^x-": { type: "object" },
				"\\(?!literal": { type: "string" },
			},
			propertyNames: { pattern: "^(?!invalid$)" },
		};

		expect(sanitizeSchemaForOpenAIResponses(schema)).toEqual({
			type: "object",
			properties: {
				fileKey: { type: "string" },
				ending: { type: "string" },
				slug: { type: "string", pattern: "^[a-z0-9_-]+$" },
				literal: { type: "string", pattern: "\\(?!literal" },
				patternOnly: true,
				"^(?!property-name)": { type: "string" },
			},
			patternProperties: {
				".*": { anyOf: [{ type: "string" }, { type: "string" }] },
				"^x-": { type: "object", properties: {} },
				"\\(?!literal": { type: "string" },
			},
			propertyNames: true,
		});
	});

	it("preserves non-array oneOf payloads verbatim instead of dropping them", () => {
		const malformed = { type: "object", oneOf: { type: "object" } } as unknown as Record<string, unknown>;

		expect(sanitizeSchemaForOpenAIResponses(malformed)).toEqual({
			type: "object",
			oneOf: { type: "object" },
			properties: {},
		});
	});

	it("does not recurse infinitely on self-referential object schemas", () => {
		const circular: Record<string, unknown> = { type: "object", properties: {} };
		(circular.properties as Record<string, unknown>).self = circular;

		const sanitized = sanitizeSchemaForOpenAIResponses(circular);
		const properties = (sanitized as { properties: Record<string, unknown> }).properties;
		expect(properties.self).toBe(sanitized as unknown as object);
		expect((sanitized as { type: unknown }).type).toBe("object");
	});
});

// ---------------------------------------------------------------------------
// sanitizeSchemaForOpenAIResponses — empty-schema normalization (issue #1179)
// ---------------------------------------------------------------------------

describe("sanitizeSchemaForOpenAIResponses — empty-schema normalization", () => {
	it("normalizes {} (empty schema = z.unknown()) to `true` in additionalProperties (issue #1179)", () => {
		// z.record(z.string(), z.unknown()) produces additionalProperties: {}
		const schema = { type: "object", additionalProperties: {} };
		expect(sanitizeSchemaForOpenAIResponses(schema)).toEqual({
			type: "object",
			additionalProperties: true,
			properties: {},
		});
	});

	it("normalizes {} in items to `true` (z.array(z.unknown()))", () => {
		const schema = { type: "array", items: {} };
		expect(sanitizeSchemaForOpenAIResponses(schema)).toEqual({ type: "array", items: true });
	});

	it("normalizes {} in nested property schemas (z.unknown() as a property value)", () => {
		const schema = {
			type: "object",
			properties: { meta: {} },
			required: ["meta"],
		};
		expect(sanitizeSchemaForOpenAIResponses(schema)).toEqual({
			type: "object",
			properties: { meta: true },
			required: ["meta"],
		});
	});

	it("normalizes {} in anyOf branches", () => {
		const schema = { anyOf: [{}, { type: "string" }] };
		expect(sanitizeSchemaForOpenAIResponses(schema)).toEqual({ anyOf: [true, { type: "string" }] });
	});

	it("does not normalize non-empty schemas or boolean schemas", () => {
		const schema = {
			type: "object",
			additionalProperties: { type: "string" },
			unevaluatedProperties: false,
		};
		expect(sanitizeSchemaForOpenAIResponses(schema)).toEqual({
			type: "object",
			properties: {},
			additionalProperties: { type: "string" },
			unevaluatedProperties: false,
		});
	});
});
// ---------------------------------------------------------------------------
// enforceStrictSchema and tryEnforceStrictSchema
// ---------------------------------------------------------------------------

describe("enforceStrictSchema and tryEnforceStrictSchema", () => {
	it("keeps strict mode enabled for an enum-only root schema by inferring a concrete type", () => {
		const result = tryEnforceStrictSchema({
			enum: ["draft", "published"],
		});

		expect(result.strict).toBe(true);
		expect(result.schema).toEqual({
			type: "string",
			enum: ["draft", "published"],
		});
	});

	it("keeps strict mode enabled for a const-only root schema by inferring a concrete type", () => {
		const result = tryEnforceStrictSchema({ const: 7 });

		expect(result.strict).toBe(true);
		expect(result.schema).toEqual({
			type: "number",
			enum: [7],
		});
	});

	it("infers array type when items is present without an explicit type", () => {
		const result = tryEnforceStrictSchema({
			items: { type: "string" },
		});

		expect(result.strict).toBe(true);
		expect(result.schema).toEqual({
			type: "array",
			items: { type: "string" },
		});
	});

	it("recurses into $defs and definitions when enforcing strict rules", () => {
		const schema = {
			type: "object",
			properties: {
				payload: { $ref: "#/$defs/Payload" },
				legacy: { $ref: "#/definitions/Legacy" },
			},
			required: ["payload", "legacy"],
			$defs: {
				Payload: {
					type: "object",
					properties: { value: { type: "string" } },
					required: [],
				},
			},
			definitions: {
				Legacy: {
					type: "object",
					properties: { count: { type: "number" } },
					required: [],
				},
			},
		} as Record<string, unknown>;

		const strict = enforceStrictSchema(schema);
		const defs = strict.$defs as Record<string, Record<string, unknown>>;
		const definitions = strict.definitions as Record<string, Record<string, unknown>>;

		expect(defs.Payload.additionalProperties).toBe(false);
		expect(definitions.Legacy.additionalProperties).toBe(false);
		expect(defs.Payload.required).toEqual(["value"]);
		expect(definitions.Legacy.required).toEqual(["count"]);
	});

	it("enforces strict object constraints inside tuple items", () => {
		const schema = {
			type: "array",
			prefixItems: [
				{ type: "string" },
				{
					type: "object",
					properties: {
						id: { type: "string" },
						nickname: { type: "string" },
					},
					required: ["id"],
				},
			],
		} as Record<string, unknown>;

		const result = tryEnforceStrictSchema(schema);
		const tupleItems = result.schema.prefixItems as Array<Record<string, unknown>>;
		const tupleObjectItem = tupleItems[1] as Record<string, unknown>;
		const tupleProperties = tupleObjectItem.properties as Record<string, Record<string, unknown>>;

		expect(result.strict).toBe(true);
		expect(tupleObjectItem.additionalProperties).toBe(false);
		expect(tupleObjectItem.required).toEqual(["id", "nickname"]);
		expect(tupleProperties.nickname).toEqual({ anyOf: [{ type: "string" }, { type: "null" }] });
	});
});

// ---------------------------------------------------------------------------
// stripResidualCombiners
// ---------------------------------------------------------------------------

describe("stripResidualCombiners", () => {
	it("collapses identical anyOf variants to the underlying type", () => {
		const stripped = stripResidualCombiners({
			anyOf: [
				{ type: "string", minLength: 1 },
				{ type: "string", minLength: 1 },
			],
			oneOf: [
				{ type: "string", pattern: "^a" },
				{ type: "string", pattern: "^a" },
			],
		}) as Record<string, unknown>;

		expect(stripped.type).toBe("string");
		expect(stripped.anyOf).toBeUndefined();
		expect(stripped.oneOf).toBeUndefined();
		expect(stripped.minLength).toBe(1);
		expect(stripped.pattern).toBe("^a");
	});

	it("strips residual combiners to a fixpoint at the same node", () => {
		const normalized = stripResidualCombiners({
			anyOf: [
				{ type: "string", description: "A" },
				{ type: "string", description: "B" },
			],
			oneOf: [{ type: "number" }, { type: "number" }],
		}) as Record<string, unknown>;

		expect(normalized.anyOf).toBeUndefined();
		expect(normalized.oneOf).toBeUndefined();
	});

	it("drops array-only keys when mixed-type collapse picks string from anyOf fixpoint", () => {
		const stripped = stripResidualCombiners({
			anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
			description: "pr number, url, or branch",
		}) as Record<string, unknown>;

		expect(stripped.type).toBe("string");
		expect(stripped.items).toBeUndefined();
		expect(stripped.anyOf).toBeUndefined();
		expect(stripped.description).toBe("pr number, url, or branch");
	});
});

// ---------------------------------------------------------------------------
// normalizeSchemaForCCA
// ---------------------------------------------------------------------------

describe("normalizeSchemaForCCA", () => {
	it("collapses same-type anyOf variants when mixed-type collapse bails out", () => {
		const prepared = normalizeSchemaForCCA({
			type: "object",
			properties: {
				value: {
					anyOf: [
						{ type: "string", description: "first" },
						{ type: "string", minLength: 2 },
					],
				},
			},
			required: ["value"],
		}) as {
			properties?: Record<string, Record<string, unknown>>;
		};

		const valueSchema = prepared.properties?.value;
		expect(valueSchema?.type).toBe("string");
		expect(valueSchema?.anyOf).toBeUndefined();
	});

	it("applies Google unsupported-key stripping before CCA-specific normalization", () => {
		const sanitized = normalizeSchemaForCCA({
			type: "object",
			additionalProperties: false,
			properties: {
				config: {
					type: "object",
					additionalProperties: false,
				},
				name: {
					type: "string",
					minLength: 2,
					pattern: "^[a-z]+$",
				},
			},
			required: ["config", "name"],
		});

		expect(sanitized).toEqual({
			type: "object",
			properties: {
				config: {
					type: "object",
					properties: {},
				},
				name: {
					type: "string",
					description: '{minLength: 2, pattern: "^[a-z]+$"}',
				},
			},
			required: ["config", "name"],
		});
	});

	it("lifts stripped validation keywords into description", () => {
		const normalized = normalizeSchemaForCCA({
			type: "string",
			pattern: "^\\d+$",
			minLength: 1,
			maxLength: 8,
			description: "ID",
		}) as Record<string, unknown>;

		expect(normalized.pattern).toBeUndefined();
		expect(normalized.minLength).toBeUndefined();
		expect(normalized.maxLength).toBeUndefined();
		expect(normalized.description).toBe('ID\n\n{pattern: "^\\\\d+$", minLength: 1, maxLength: 8}');
	});

	it("uses the same merged object output in shared and gemini-cli Antigravity paths", () => {
		const parameters = {
			anyOf: [
				{
					type: "object",
					properties: {
						shared: { type: "string" },
						a: { type: "string" },
					},
					required: ["shared"],
				},
				{
					type: "object",
					properties: {
						shared: { type: "string" },
						b: { type: "number" },
					},
					required: ["shared"],
				},
			],
		} as TJsonSchema;
		const tools: Tool[] = [{ name: "merge_test", description: "Merge test", parameters }];

		const sharedTools = convertTools(tools, createGoogleCliModel("claude-sonnet-4-5"));
		const sharedDeclaration = sharedTools?.[0]?.functionDeclarations[0] as Record<string, unknown>;

		const context: Context = {
			messages: [{ role: "user", content: "hello", timestamp: 0 }],
			tools,
		};
		const antigravityRequest = buildRequest(createGoogleCliModel("gemini-2.5-pro"), context, "project", {}, true);
		const antigravityDeclaration = antigravityRequest.request.tools?.[0]?.functionDeclarations[0] as Record<
			string,
			unknown
		>;

		const expected = {
			type: "object",
			properties: {
				shared: { type: "string" },
				a: { type: "string" },
				b: { type: "number" },
			},
			required: ["shared"],
		};
		expect(sharedDeclaration.parameters).toEqual(expected);
		expect(antigravityDeclaration.parameters).toEqual(expected);
		expect(antigravityDeclaration.parameters).toEqual(sharedDeclaration.parameters);
		expect(antigravityDeclaration.parametersJsonSchema).toBeUndefined();
	});

	it("does not retain stale required keys after an object-union anyOf merge", () => {
		const prepared = normalizeSchemaForCCA({
			required: ["a"],
			anyOf: [
				{
					type: "object",
					properties: { a: { type: "string" } },
					required: ["a"],
				},
				{
					type: "object",
					properties: { b: { type: "number" } },
					required: ["b"],
				},
			],
		}) as Record<string, unknown>;

		expect(prepared).toEqual({
			type: "object",
			properties: {
				a: { type: "string" },
				b: { type: "number" },
			},
		});
	});

	it("preserves required intersection when merging object anyOf variants with overlapping keys", () => {
		const schema = {
			type: "object",
			properties: {
				profile: {
					anyOf: [
						{
							type: "object",
							properties: {
								id: { type: "string" },
								name: { type: "string" },
							},
							required: ["id", "name"],
						},
						{
							type: "object",
							properties: {
								id: { type: "string" },
								age: { type: "number" },
							},
							required: ["id", "age"],
						},
					],
				},
			},
			required: ["profile"],
		} as const;

		const normalized = normalizeSchemaForCCA(schema) as {
			properties?: {
				profile?: {
					type?: string;
					properties?: Record<string, unknown>;
					required?: string[];
				};
			};
		};
		const profile = normalized.properties?.profile;

		expect(profile?.type).toBe("object");
		expect(Object.keys(profile?.properties ?? {}).sort()).toEqual(["age", "id", "name"]);
		expect(profile?.required).toEqual(["id"]);
	});

	it("does not recurse infinitely when preparing a schema with a circular object graph", () => {
		const circular: Record<string, unknown> = {
			type: "object",
			properties: {},
		};
		(circular.properties as Record<string, unknown>).self = circular;

		expect(() => normalizeSchemaForCCA(circular)).not.toThrow();
		expect(normalizeSchemaForCCA(circular)).toEqual({
			type: "object",
			properties: {
				self: {},
			},
		});
	});

	it("falls back to an empty object schema when the normalized schema is AJV-invalid", () => {
		const ajvInvalid = {
			type: "invalid-type-token",
		} as Record<string, unknown>;

		expect(normalizeSchemaForCCA(ajvInvalid)).toEqual({
			type: "object",
			properties: {},
		});
	});

	it("strips array-only keys when mixed-type collapse picks a non-array type", () => {
		// Regression: anyOf [{type:"string"}, {type:"array", items:{type:"string"}}]
		// collapsed to {type:"string", items:{type:"string"}} which is invalid.
		// The fix filters mergedVariantFields against the chosen type's allowed keys.
		const normalized = normalizeSchemaForCCA({
			anyOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
			description: "pr number, url, or branch",
		});

		expect(normalized).toEqual({
			type: "string",
			description: "pr number, url, or branch",
		});
	});

	it("strips sibling type-specific keys copied from parent when mixed-type collapse picks opposing type", () => {
		// Edge case: parent has a sibling `items` outside the anyOf,
		// and the chosen type is string. The sibling must be stripped.
		const normalized = normalizeSchemaForCCA({
			anyOf: [{ type: "string" }, { type: "array", items: { type: "number" } }],
			items: { type: "string" },
			description: "pr number, url, or branch",
		});

		expect(normalized).toEqual({
			type: "string",
			description: "pr number, url, or branch",
		});
	});
});

// ---------------------------------------------------------------------------
// Circular schema safety (normalizeSchemaForGoogle + sanitizeSchemaForStrictMode)
// ---------------------------------------------------------------------------

describe("circular schema safety", () => {
	it("does not overflow the stack when either sanitizer encounters a self-referential object", () => {
		const circular: Record<string, unknown> = {
			type: "object",
			properties: {},
		};
		(circular.properties as Record<string, unknown>).self = circular;

		expect(() => normalizeSchemaForGoogle(circular)).not.toThrow();
		expect(() => sanitizeSchemaForStrictMode(circular)).not.toThrow();
	});
});

// ---------------------------------------------------------------------------
// DAG-shared subtrees and frozen inputs (normalizeSchemaNode enter/exit)
// ---------------------------------------------------------------------------

describe("DAG-shared subtree normalization", () => {
	it("normalizes a subschema object reused across two properties instead of blanking the second occurrence", () => {
		const shared = { type: "string", description: "shared leaf" };
		const schema = {
			type: "object",
			properties: { a: shared, b: shared },
		};

		const result = normalizeSchemaForGoogle(schema) as {
			properties: { a: Record<string, unknown>; b: Record<string, unknown> };
		};
		expect(result.properties.a).toEqual({ type: "string", description: "shared leaf" });
		expect(result.properties.b).toEqual({ type: "string", description: "shared leaf" });
	});

	it("does not throw on a frozen input schema", () => {
		const shared = Object.freeze({ type: "number" });
		const schema = Object.freeze({
			type: "object",
			properties: Object.freeze({ x: shared, y: shared }),
		});

		const result = normalizeSchemaForGoogle(schema) as {
			properties: { x: Record<string, unknown>; y: Record<string, unknown> };
		};
		expect(result.properties.x).toEqual({ type: "number" });
		expect(result.properties.y).toEqual({ type: "number" });
	});
});

// ---------------------------------------------------------------------------
// normalizeSchemaForMoonshot (Moonshot Flavored JSON Schema)
// ---------------------------------------------------------------------------

const MFJS_FORBIDDEN_KEYWORDS = new Set([
	"const",
	"oneOf",
	"allOf",
	"nullable",
	"prefixItems",
	"minItems",
	"maxItems",
	"minLength",
	"maxLength",
	"pattern",
	"format",
	"minimum",
	"maximum",
	"exclusiveMinimum",
	"exclusiveMaximum",
	"multipleOf",
	"uniqueItems",
	"title",
	"$schema",
	"$comment",
]);

/** Walk schema-keyword positions only and fail on any keyword MFJS rejects. */
function assertMfjsValid(node: unknown, path = "$"): void {
	if (Array.isArray(node)) {
		for (const [i, entry] of node.entries()) assertMfjsValid(entry, `${path}[${i}]`);
		return;
	}
	if (typeof node !== "object" || node === null) return;
	const obj = node as Record<string, unknown>;
	for (const key of Object.keys(obj)) {
		if (MFJS_FORBIDDEN_KEYWORDS.has(key)) throw new Error(`MFJS-forbidden keyword '${key}' at ${path}`);
	}
	if ("type" in obj && typeof obj.type !== "string") {
		throw new Error(`MFJS requires a scalar string 'type' at ${path}, got ${JSON.stringify(obj.type)}`);
	}
	if (Array.isArray(obj.enum)) {
		for (const value of obj.enum) {
			if (typeof value !== "string" && typeof value !== "number") {
				throw new Error(`MFJS enum admits only string/number at ${path}, got ${JSON.stringify(value)}`);
			}
		}
	}
	const props = obj.properties;
	if (props && typeof props === "object" && !Array.isArray(props)) {
		for (const [key, value] of Object.entries(props)) assertMfjsValid(value, `${path}.properties.${key}`);
	}
	if (Array.isArray(obj.anyOf)) {
		for (const [i, entry] of obj.anyOf.entries()) assertMfjsValid(entry, `${path}.anyOf[${i}]`);
	}
	if (obj.items !== undefined) assertMfjsValid(obj.items, `${path}.items`);
	if (obj.additionalProperties && typeof obj.additionalProperties === "object") {
		assertMfjsValid(obj.additionalProperties, `${path}.additionalProperties`);
	}
}

describe("normalizeSchemaForMoonshot", () => {
	it("collapses an anyOf of bare consts into a typed enum", () => {
		const normalized = normalizeSchemaForMoonshot({
			anyOf: [
				{ const: "pr_checkout", description: "github operation" },
				{ const: "pr_create", description: "github operation" },
			],
			description: "github operation",
		}) as Record<string, unknown>;
		expect(normalized).toEqual({
			type: "string",
			enum: ["pr_checkout", "pr_create"],
			description: "github operation",
		});
	});

	it("infers a scalar type for a bare enum so MFJS sees a typed node", () => {
		const normalized = normalizeSchemaForMoonshot({ enum: ["capabilities", "definition"] });
		expect(normalized).toEqual({ type: "string", enum: ["capabilities", "definition"] });
	});

	it("strips array/string validators, spilling the human-meaningful ones into description", () => {
		const normalized = normalizeSchemaForMoonshot({
			type: "array",
			description: "globs",
			minItems: 1,
			maxItems: 10,
			items: { type: "string", maxLength: 256, pattern: "^x" },
		}) as Record<string, unknown>;
		expect(normalized.minItems).toBeUndefined();
		expect(normalized.maxItems).toBeUndefined();
		expect(String(normalized.description)).toContain("minItems");
		const items = normalized.items as Record<string, unknown>;
		expect(items.type).toBe("string");
		expect(items.maxLength).toBeUndefined();
		expect(items.pattern).toBeUndefined();
	});

	it("keeps additionalProperties (boolean and schema), type:null branches, and default", () => {
		const normalized = normalizeSchemaForMoonshot({
			type: "object",
			properties: {
				env: { type: "object", additionalProperties: { type: "string" } },
				extra: { type: "object", additionalProperties: true },
				skip: { anyOf: [{ type: "number" }, { type: "null" }] },
				limit: { type: "integer", default: 10 },
			},
		}) as Record<string, unknown>;
		const props = normalized.properties as Record<string, Record<string, unknown>>;
		expect(props.env.additionalProperties).toEqual({ type: "string" });
		expect(props.extra.additionalProperties).toBe(true);
		expect(props.skip.anyOf).toEqual([{ type: "number" }, { type: "null" }]);
		expect(props.limit).toEqual({ type: "integer", default: 10 });
	});

	it("folds oneOf into anyOf (the only MFJS combinator)", () => {
		const normalized = normalizeSchemaForMoonshot({
			oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }],
			description: "query",
		}) as Record<string, unknown>;
		expect(normalized.oneOf).toBeUndefined();
		expect(normalized.anyOf).toEqual([{ type: "string" }, { type: "array", items: { type: "string" } }]);
	});

	it("merges oneOf onto an existing anyOf rather than discarding either", () => {
		const normalized = normalizeSchemaForMoonshot({
			anyOf: [{ type: "boolean" }],
			oneOf: [{ type: "string" }],
		}) as Record<string, unknown>;
		expect(normalized.oneOf).toBeUndefined();
		expect(normalized.anyOf).toEqual([{ type: "boolean" }, { type: "string" }]);
	});

	it("reduces a type array to a scalar and strips the nullable keyword", () => {
		expect(normalizeSchemaForMoonshot({ type: ["string", "null"] })).toEqual({ type: "string" });
		expect(normalizeSchemaForMoonshot({ type: "string", nullable: true })).toEqual({ type: "string" });
	});

	it("produces an MFJS-valid schema for the union of built-in tool shapes", () => {
		const normalized = normalizeSchemaForMoonshot({
			type: "object",
			properties: {
				op: {
					anyOf: [
						{ const: "pr_checkout", description: "github operation" },
						{ const: "pr_create", description: "github operation" },
					],
					description: "github operation",
				},
				action: { enum: ["capabilities", "definition", "references"] },
				paths: { type: "array", description: "globs", minItems: 1, items: { type: "string" } },
				role: { type: "string", maxLength: 256 },
				skip: { anyOf: [{ type: "number" }, { type: "null" }] },
				env: { type: "object", additionalProperties: { type: "string" } },
				extra: { type: "object", additionalProperties: true },
			},
			required: ["op"],
			additionalProperties: false,
		});
		expect(() => assertMfjsValid(normalized)).not.toThrow();
		const props = (normalized as Record<string, Record<string, Record<string, unknown>>>).properties;
		expect(props.op).toEqual({ type: "string", enum: ["pr_checkout", "pr_create"], description: "github operation" });
		expect(props.action.type).toBe("string");
	});
	it("drops an enum that const-collapses to non-scalar values, keeping the inferred type", () => {
		const normalized = normalizeSchemaForMoonshot({
			anyOf: [{ const: true }, { const: false }],
		}) as Record<string, unknown>;
		expect(normalized.enum).toBeUndefined();
		expect(normalized.type).toBe("boolean");
	});
});
