import { describe, expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype/ark";

describe("target option", () => {
	it("omits the dialect until a target is requested", () => {
		const T = type({ foo: "string" });
		const schema = T.toJsonSchema();
		expect(schema).toEqual({
			type: "object",
			properties: { foo: { type: "string" } },
			required: ["foo"],
		});
	});

	it("generates draft-2020-12 schema when specified", () => {
		const T = type({ foo: "string" });
		const schema = T.toJsonSchema({ target: "draft-2020-12" });
		expect(schema).toEqual({
			$schema: "https://json-schema.org/draft/2020-12/schema",
			type: "object",
			properties: { foo: { type: "string" } },
			required: ["foo"],
		});
	});

	it("generates draft-07 schema when specified", () => {
		const T = type({ foo: "string" });
		const schema = T.toJsonSchema({ target: "draft-07" });
		expect(schema).toEqual({
			$schema: "http://json-schema.org/draft-07/schema#",
			type: "object",
			properties: { foo: { type: "string" } },
			required: ["foo"],
		});
	});
});

describe("draft-specific syntax", () => {
	it("draft-2020-12 uses prefixItems for tuples", () => {
		const T = type(["string", "number"]);
		const schema = T.toJsonSchema({ target: "draft-2020-12" });
		expect(schema).toEqual({
			$schema: "https://json-schema.org/draft/2020-12/schema",
			type: "array",
			prefixItems: [{ type: "string" }, { type: "number" }],
			items: false,
			minItems: 2,
		});
	});

	it("draft-07 uses items array for tuples", () => {
		const T = type(["string", "number"]);
		const schema = T.toJsonSchema({ target: "draft-07" });
		expect(schema).toEqual({
			$schema: "http://json-schema.org/draft-07/schema#",
			type: "array",
			items: [{ type: "string" }, { type: "number" }],
			additionalItems: false,
			minItems: 2,
		});
	});

	it("draft-2020-12 uses items for variadic tuple elements", () => {
		const T = type(["string", "...", "number[]"]);
		const schema = T.toJsonSchema({ target: "draft-2020-12" });
		expect(schema).toEqual({
			$schema: "https://json-schema.org/draft/2020-12/schema",
			type: "array",
			prefixItems: [{ type: "string" }],
			items: { type: "number" },
			minItems: 1,
		});
	});

	it("draft-07 uses additionalItems for variadic tuple elements", () => {
		const T = type(["string", "...", "number[]"]);
		const schema = T.toJsonSchema({ target: "draft-07" });
		expect(schema).toEqual({
			$schema: "http://json-schema.org/draft-07/schema#",
			type: "array",
			items: [{ type: "string" }],
			additionalItems: { type: "number" },
			minItems: 1,
		});
	});

	it("draft-2020-12 uses $defs for references", () => {
		const types = type.module({
			user: {
				name: "string",
				friend: "user?",
			},
		});
		const schema = types.user.toJsonSchema({
			target: "draft-2020-12",
		}) as Record<string, unknown>;
		expect("$defs" in schema).toBe(true);
		expect("definitions" in schema).toBe(false);
		expect(Object.keys(schema.$defs as object).length > 0).toBe(true);
	});

	it("draft-07 uses definitions for references", () => {
		const types = type.module({
			user: {
				name: "string",
				friend: "user?",
			},
		});
		const schema = types.user.toJsonSchema({
			target: "draft-07",
		}) as Record<string, unknown>;
		expect("definitions" in schema).toBe(true);
		expect("$defs" in schema).toBe(false);
		expect(Object.keys(schema.definitions as object).length > 0).toBe(true);
	});
});
