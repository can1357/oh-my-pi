import { describe, expect, it } from "bun:test";
import { isJTDSchema, jtdToJsonSchema } from "@oh-my-pi/pi-coding-agent/tools/jtd-to-json-schema";

describe("jtdToJsonSchema", () => {
	it("converts JTD elements and int32 primitives into JSON Schema", () => {
		const converted = jtdToJsonSchema({
			properties: {
				results: {
					elements: {
						properties: {
							issue: { type: "int32" },
						},
					},
				},
			},
		});

		expect(converted).toEqual({
			type: "object",
			properties: {
				results: {
					type: "array",
					items: {
						type: "object",
						properties: {
							issue: { type: "integer" },
						},
						required: ["issue"],
						additionalProperties: false,
					},
				},
			},
			required: ["results"],
			additionalProperties: false,
		});
		expect(jtdToJsonSchema({ type: "int32" })).toEqual({ type: "integer" });
		expect(isJTDSchema({ type: "int32" })).toBe(true);
	});

	it("normalizes nested JTD fragments inside JSON Schema nodes", () => {
		const converted = jtdToJsonSchema({
			type: "object",
			properties: {
				results: {
					type: "array",
					elements: {
						properties: {
							issue: { type: "int32" },
						},
					},
				},
			},
			required: ["results"],
		});

		expect(converted).toEqual({
			type: "object",
			properties: {
				results: {
					type: "array",
					items: {
						type: "object",
						properties: {
							issue: { type: "integer" },
						},
						required: ["issue"],
						additionalProperties: false,
					},
				},
			},
			required: ["results"],
		});
	});
	it("does not misinterpret user-named properties that collide with JTD keywords (#1345)", () => {
		// Mirrors the `files[]` shape declared by the built-in scout agent:
		// a JTD elements form whose item properties include one literally named `ref`.
		const converted = jtdToJsonSchema({
			properties: {
				files: {
					elements: {
						properties: {
							ref: { type: "string" },
							description: { type: "string" },
						},
					},
				},
			},
		});

		expect(converted).toEqual({
			type: "object",
			properties: {
				files: {
					type: "array",
					items: {
						type: "object",
						properties: {
							ref: { type: "string" },
							description: { type: "string" },
						},
						required: ["ref", "description"],
						additionalProperties: false,
					},
				},
			},
			required: ["files"],
			additionalProperties: false,
		});
	});
	it("preserves native JSON Schema identity and content", () => {
		const input = {
			$schema: "https://json-schema.org/draft/2020-12/schema",
			oneOf: [
				{
					required: ["kind", "target"],
					properties: {
						kind: { const: "a" },
						target: { $ref: "#/$defs/ref" },
					},
				},
			],
			$defs: {
				ref: {
					type: "object",
					properties: {
						uri: { type: "string" },
					},
				},
			},
		};
		const expected = structuredClone(input);

		const converted = jtdToJsonSchema(input);

		expect(converted).toBe(input);
		expect(converted).toEqual(expected);
		expect(input).toEqual(expected);
	});

	it("converts unambiguous nested JTD at single-schema positions", () => {
		const annotation = { title: "keep" };
		const keywords = [
			"not",
			"if",
			"then",
			"else",
			"items",
			"contains",
			"propertyNames",
			"additionalProperties",
			"unevaluatedProperties",
			"unevaluatedItems",
			"contentSchema",
		];

		for (const keyword of keywords) {
			const input: Record<string, unknown> = {
				type: "object",
				annotation,
				[keyword]: { elements: { type: "string" } },
			};

			const converted = jtdToJsonSchema(input) as Record<string, unknown>;

			expect(converted).not.toBe(input);
			expect(converted.annotation).toBe(annotation);
			expect(converted[keyword]).toEqual({
				type: "array",
				items: { type: "string" },
			});
		}
	});

	it("converts unambiguous nested JTD at schema-array positions", () => {
		const annotation = { title: "keep" };
		const keywords = ["allOf", "anyOf", "oneOf", "prefixItems"];

		for (const keyword of keywords) {
			const nested = { elements: { type: "string" } };
			const input: Record<string, unknown> = {
				type: "object",
				annotation,
				[keyword]: [nested],
			};

			const converted = jtdToJsonSchema(input) as Record<string, unknown>;
			const convertedArray = converted[keyword] as unknown[];

			expect(converted).not.toBe(input);
			expect(converted.annotation).toBe(annotation);
			expect(convertedArray).not.toBe(input[keyword]);
			expect(convertedArray[0]).not.toBe(nested);
			expect(convertedArray).toEqual([
				{
					type: "array",
					items: { type: "string" },
				},
			]);
		}
	});

	it("converts schema-map values without treating member names as schemas", () => {
		const keywords = ["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"];

		for (const keyword of keywords) {
			const ref = { const: "kept" };
			const nested = { elements: { type: "string" } };
			const inputMap = { ref, nested };
			const input: Record<string, unknown> = {
				type: "object",
				[keyword]: inputMap,
			};

			const converted = jtdToJsonSchema(input) as Record<string, unknown>;
			const convertedMap = converted[keyword] as Record<string, unknown>;

			expect(converted).not.toBe(input);
			expect(convertedMap).not.toBe(inputMap);
			expect(convertedMap.ref).toBe(ref);
			expect(convertedMap.nested).not.toBe(nested);
			expect(convertedMap.nested).toEqual({
				type: "array",
				items: { type: "string" },
			});
		}
	});

	it("preserves data-valued and native extension members by complete identity", () => {
		const dataValue = { elements: { type: "string" } };
		const required = ["elements"];
		const dependentRequired = { x: ["elements"] };
		const vocabulary = { "https://example.test/elements": true };
		const nativeExtension = {
			discriminator: "kind",
			mapping: { a: "#/$defs/a" },
		};
		const allOf = [nativeExtension];
		const input: Record<string, unknown> = {
			type: "object",
			enum: [dataValue],
			examples: [dataValue],
			default: dataValue,
			required,
			dependentRequired,
			$vocabulary: vocabulary,
			allOf,
		};
		const expected = structuredClone(input);

		const converted = jtdToJsonSchema(input) as Record<string, unknown>;

		expect(converted).toBe(input);
		expect(converted).toEqual(expected);
		expect(converted.enum).toBe(input.enum);
		expect((converted.enum as unknown[])[0]).toBe(dataValue);
		expect(converted.examples).toBe(input.examples);
		expect((converted.examples as unknown[])[0]).toBe(dataValue);
		expect(converted.default).toBe(dataValue);
		expect(converted.required).toBe(required);
		expect(converted.dependentRequired).toBe(dependentRequired);
		expect(converted.$vocabulary).toBe(vocabulary);
		expect(converted.allOf).toBe(allOf);
		expect((converted.allOf as unknown[])[0]).toBe(nativeExtension);
	});

	it("preserves malformed and deprecated native keyword values for validation", () => {
		const schemas: Record<string, unknown>[] = [
			{ type: "constructor" },
			{ type: "object", items: [] },
			{ type: "object", properties: [] },
			{ type: "object", oneOf: {} },
			{
				type: "object",
				dependencies: {
					x: { elements: { type: "string" } },
				},
			},
			{
				type: "object",
				additionalItems: { elements: { type: "string" } },
			},
		];

		for (const schema of schemas) {
			const expected = structuredClone(schema);
			const converted = jtdToJsonSchema(schema);

			expect(converted).toBe(schema);
			expect(converted).toEqual(expected);
		}
	});
});
