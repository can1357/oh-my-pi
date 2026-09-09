import { describe, expect, it } from "bun:test";
import {
	adaptSchemaForStrict,
	areJsonValuesEqual,
	copySchemaWithout,
	isJsonObject,
	mergeCompatibleEnumSchemas,
	mergePropertySchemas,
	stripResidualCombiners,
} from "@oh-my-pi/pi-ai/utils/schema";

describe("isJsonObject", () => {
	it("returns true for plain objects", () => {
		expect(isJsonObject({})).toBe(true);
		expect(isJsonObject({ a: 1 })).toBe(true);
	});

	it("returns false for arrays", () => {
		expect(isJsonObject([])).toBe(false);
		expect(isJsonObject([1, 2])).toBe(false);
	});

	it("returns false for primitives and null", () => {
		expect(isJsonObject(null)).toBe(false);
		expect(isJsonObject(undefined)).toBe(false);
		expect(isJsonObject(0)).toBe(false);
		expect(isJsonObject("")).toBe(false);
		expect(isJsonObject(false)).toBe(false);
	});
});

describe("areJsonValuesEqual", () => {
	it("returns true for identical primitives", () => {
		expect(areJsonValuesEqual(1, 1)).toBe(true);
		expect(areJsonValuesEqual("a", "a")).toBe(true);
		expect(areJsonValuesEqual(null, null)).toBe(true);
		expect(areJsonValuesEqual(true, true)).toBe(true);
	});

	it("returns false for different primitives", () => {
		expect(areJsonValuesEqual(1, 2)).toBe(false);
		expect(areJsonValuesEqual("a", "b")).toBe(false);
		expect(areJsonValuesEqual(null, undefined)).toBe(false);
	});

	it("compares nested objects deeply", () => {
		expect(areJsonValuesEqual({ a: { b: 1 } }, { a: { b: 1 } })).toBe(true);
		expect(areJsonValuesEqual({ a: { b: 1 } }, { a: { b: 2 } })).toBe(false);
	});

	it("compares arrays element-wise", () => {
		expect(areJsonValuesEqual([1, 2, 3], [1, 2, 3])).toBe(true);
		expect(areJsonValuesEqual([1, 2], [1, 2, 3])).toBe(false);
		expect(areJsonValuesEqual([1, 2], [2, 1])).toBe(false);
	});

	it("handles mixed types correctly", () => {
		expect(areJsonValuesEqual([], {})).toBe(false);
		expect(areJsonValuesEqual({}, [])).toBe(false);
		expect(areJsonValuesEqual(1, "1")).toBe(false);
	});

	it("handles empty structures", () => {
		expect(areJsonValuesEqual({}, {})).toBe(true);
		expect(areJsonValuesEqual([], [])).toBe(true);
	});

	it("distinguishes NaN via Object.is", () => {
		expect(areJsonValuesEqual(Number.NaN, Number.NaN)).toBe(true);
	});

	it("distinguishes +0 and -0 via Object.is", () => {
		expect(areJsonValuesEqual(0, -0)).toBe(false);
	});
});

describe("mergeCompatibleEnumSchemas", () => {
	it("merges two enum schemas with the same type", () => {
		const a = { type: "string", enum: ["x", "y"] };
		const b = { type: "string", enum: ["y", "z"] };
		const result = mergeCompatibleEnumSchemas(a, b);
		expect(result).toEqual({ type: "string", enum: ["x", "y", "z"] });
	});

	it("returns null when types differ", () => {
		const a = { type: "string", enum: ["x"] };
		const b = { type: "number", enum: [1] };
		expect(mergeCompatibleEnumSchemas(a, b)).toBeNull();
	});

	it("returns null when non-enum keys differ", () => {
		const a = { type: "string", enum: ["x"], description: "A" };
		const b = { type: "string", enum: ["y"], description: "B" };
		expect(mergeCompatibleEnumSchemas(a, b)).toBeNull();
	});

	it("returns null when one input lacks enum", () => {
		const a = { type: "string", enum: ["x"] };
		const b = { type: "string" };
		expect(mergeCompatibleEnumSchemas(a, b)).toBeNull();
	});

	it("returns null for non-object inputs", () => {
		expect(mergeCompatibleEnumSchemas(null, null)).toBeNull();
		expect(mergeCompatibleEnumSchemas("x", "y")).toBeNull();
	});

	it("deduplicates enum values", () => {
		const a = { type: "number", enum: [1, 2] };
		const b = { type: "number", enum: [2, 3] };
		const result = mergeCompatibleEnumSchemas(a, b);
		expect(result).toEqual({ type: "number", enum: [1, 2, 3] });
	});
});

describe("mergePropertySchemas", () => {
	it("returns existing when schemas are equal", () => {
		const schema = { type: "string" };
		expect(mergePropertySchemas(schema, { type: "string" })).toEqual(schema);
	});

	it("merges compatible enum schemas", () => {
		const a = { type: "string", enum: ["x"] };
		const b = { type: "string", enum: ["y"] };
		expect(mergePropertySchemas(a, b)).toEqual({ type: "string", enum: ["x", "y"] });
	});

	it("creates anyOf for incompatible schemas", () => {
		const a = { type: "string" };
		const b = { type: "number" };
		expect(mergePropertySchemas(a, b)).toEqual({ anyOf: [a, b] });
	});

	it("appends to existing anyOf without duplicates", () => {
		const a = { anyOf: [{ type: "string" }, { type: "number" }] };
		const b = { type: "boolean" };
		const result = mergePropertySchemas(a, b) as { anyOf: unknown[] };
		expect(result.anyOf).toHaveLength(3);
		expect(result.anyOf).toContainEqual({ type: "boolean" });
	});

	it("does not duplicate when merging with existing anyOf variant", () => {
		const a = { anyOf: [{ type: "string" }, { type: "number" }] };
		const b = { type: "string" };
		const result = mergePropertySchemas(a, b) as { anyOf: unknown[] };
		expect(result.anyOf).toHaveLength(2);
	});
});

describe("copySchemaWithout", () => {
	it("copies all keys except the specified one", () => {
		const schema = { type: "object", anyOf: [1, 2], description: "test" };
		const result = copySchemaWithout(schema, "anyOf");
		expect(result).toEqual({ type: "object", description: "test" });
	});

	it("returns a copy when key is not present", () => {
		const schema = { type: "string" };
		const result = copySchemaWithout(schema, "anyOf");
		expect(result).toEqual({ type: "string" });
		expect(result).not.toBe(schema);
	});
});

describe("stripResidualCombiners", () => {
	it("collapses same-type anyOf into single schema", () => {
		const input = {
			anyOf: [
				{ type: "string", description: "A" },
				{ type: "string", description: "B" },
			],
		};
		const result = stripResidualCombiners(input) as Record<string, unknown>;
		expect(result.type).toBe("string");
		expect(result.anyOf).toBeUndefined();
	});

	it("collapses nested residual combiners", () => {
		const input = {
			type: "object",
			properties: {
				field: {
					anyOf: [
						{ type: "string", description: "A" },
						{ type: "string", description: "B" },
					],
				},
			},
		};
		const result = stripResidualCombiners(input) as Record<string, unknown>;
		const props = result.properties as Record<string, Record<string, unknown>>;
		expect(props.field.type).toBe("string");
		expect(props.field.anyOf).toBeUndefined();
	});

	it("preserves non-collapsible combiners", () => {
		const input = {
			anyOf: [{ type: "string" }, { type: "number" }, { type: "boolean" }],
		};
		// This has 3 variants of different types but all are distinct non-null.
		// collapseMixedTypeCombinerVariants should collapse this to first non-null type.
		const result = stripResidualCombiners(input) as Record<string, unknown>;
		expect(result.type).toBe("string");
	});

	it("passes through primitives and arrays unchanged", () => {
		expect(stripResidualCombiners("hello")).toBe("hello");
		expect(stripResidualCombiners(42)).toBe(42);
		expect(stripResidualCombiners(null)).toBe(null);
		expect(stripResidualCombiners([1, 2])).toEqual([1, 2]);
	});
});

describe("adaptSchemaForStrict", () => {
	it("passes through when strict is false", () => {
		const schema = { type: "object", properties: { x: { type: "string" } } };
		const result = adaptSchemaForStrict(schema, false);
		expect(result.strict).toBe(false);
		expect(result.schema).toBe(schema);
	});

	it("enforces strict mode for valid schemas", () => {
		const schema = {
			type: "object",
			properties: { x: { type: "string" } },
			required: ["x"],
		};
		const result = adaptSchemaForStrict(schema, true);
		expect(result.strict).toBe(true);
		expect(result.schema.additionalProperties).toBe(false);
	});

	it("degrades gracefully for non-representable schemas", () => {
		const schema = {
			type: "object",
			properties: {
				items: { items: {}, type: "array" },
			},
			required: ["items"],
		};
		const result = adaptSchemaForStrict(schema, true);
		expect(result.strict).toBe(false);
		expect(result.schema).toBe(schema);
	});

	it("degrades gracefully for schemas with patternProperties maps", () => {
		const schema = {
			type: "object",
			properties: {
				rewrites: {
					type: "object",
					patternProperties: {
						"^(.*)$": { type: "string" },
					},
				},
			},
			required: ["rewrites"],
		};
		const result = adaptSchemaForStrict(schema, true);
		expect(result.strict).toBe(false);
		expect(result.schema).toBe(schema);
	});
});
