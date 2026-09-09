import { describe, expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype/ark";
import type { Eq } from "./type-assert";

it("validation conforms to spec", () => {
	const T = type({ foo: "string" });
	const standard: StandardSchemaV1<{ foo: string }> = T;
	const standardOut = standard["~standard"].validate({
		foo: "bar",
	});
	expect<promisable<StandardSchemaV1.Result<{ foo: string }>>>(standardOut).toEqual({
		value: { foo: "bar" },
	});

	const badStandardOut = standard["~standard"].validate({
		foo: 5,
	}) as StandardSchemaV1.FailureResult;

	expect(badStandardOut.issues).toBeInstanceOf(type.errors);
	expect(badStandardOut.issues.toString()).toEqual("foo must be a string (was a number)");
});

it("can infer generic parameter from standard schema", () => {
	const acceptsStandardSchema = <T extends StandardSchemaV1>(
		_schema: T,
	): {
		input: StandardSchemaV1.InferInput<T>;
		output: StandardSchemaV1.InferOutput<T>;
	} => ({}) as never;

	const result = acceptsStandardSchema(type({ foo: "string.numeric.parse" }));

	const _1: Eq<typeof result.input, { foo: string }> = true;
	const _2: Eq<typeof result.output, { foo: number }> = true;
});

describe("~standard.jsonSchema", () => {
	it("generates input schema with draft-2020-12", () => {
		const T = type({ foo: "string" });
		const standard: StandardJSONSchemaV1 = T;
		const jsonSchema = standard["~standard"].jsonSchema.input({
			target: "draft-2020-12",
		});
		expect(jsonSchema).toEqual({
			$schema: "https://json-schema.org/draft/2020-12/schema",
			type: "object",
			properties: { foo: { type: "string" } },
			required: ["foo"],
		});
	});

	it("generates output schema with draft-2020-12", () => {
		const T = type({ foo: "string" });
		const standard: StandardJSONSchemaV1 = T;
		const jsonSchema = standard["~standard"].jsonSchema.output({
			target: "draft-2020-12",
		});
		expect(jsonSchema).toEqual({
			$schema: "https://json-schema.org/draft/2020-12/schema",
			type: "object",
			properties: { foo: { type: "string" } },
			required: ["foo"],
		});
	});

	it("generates input schema with draft-07", () => {
		const T = type({ foo: "string" });
		const standard: StandardJSONSchemaV1 = T;
		const jsonSchema = standard["~standard"].jsonSchema.input({
			target: "draft-07",
		});
		expect(jsonSchema).toEqual({
			$schema: "http://json-schema.org/draft-07/schema#",
			type: "object",
			properties: { foo: { type: "string" } },
			required: ["foo"],
		});
	});

	it("generates output schema with draft-07", () => {
		const T = type({ foo: "string" });
		const standard: StandardJSONSchemaV1 = T;
		const jsonSchema = standard["~standard"].jsonSchema.output({
			target: "draft-07",
		});
		expect(jsonSchema).toEqual({
			$schema: "http://json-schema.org/draft-07/schema#",
			type: "object",
			properties: { foo: { type: "string" } },
			required: ["foo"],
		});
	});

	it("passes libraryOptions to toJsonSchema", () => {
		const T = type({ foo: "string" });
		const standard: StandardJSONSchemaV1 = T;
		const jsonSchema = standard["~standard"].jsonSchema.input({
			target: "draft-2020-12",
			libraryOptions: {
				dialect: null,
			},
		});
		expect(jsonSchema).toEqual({
			type: "object",
			properties: { foo: { type: "string" } },
			required: ["foo"],
		});
	});

	it("throws for unsupported target", () => {
		const T = type({ foo: "string" });
		const standard: StandardJSONSchemaV1 = T;
		expect(() =>
			standard["~standard"].jsonSchema.input({
				target: "openapi-3.0",
			}),
		).toThrow('JSONSchema target \'openapi-3.0\' is not supported (must be "draft-2020-12" or "draft-07")');
	});

	it("generates different input/output schemas for morphs", () => {
		const T = type({ foo: "string.numeric.parse" });
		const standard: StandardJSONSchemaV1 = T;

		const inputSchema = standard["~standard"].jsonSchema.input({
			target: "draft-2020-12",
		});
		expect(inputSchema).toEqual({
			$schema: "https://json-schema.org/draft/2020-12/schema",
			type: "object",
			properties: {
				foo: {
					type: "string",
					pattern: "^(?:(?!^-0\\.?0*$)(?:-?(?:(?:0|[1-9]\\d*)(?:\\.\\d+)?)|\\.\\d+?))$",
				},
			},
			required: ["foo"],
		});

		const outputSchema = standard["~standard"].jsonSchema.output({
			target: "draft-2020-12",
		});
		expect(outputSchema).toEqual({
			$schema: "https://json-schema.org/draft/2020-12/schema",
			type: "object",
			properties: { foo: { type: "number" } },
			required: ["foo"],
		});
	});
});
