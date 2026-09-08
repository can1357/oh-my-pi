import { expect, it } from "bun:test";
import {
	enforceStrictSchema,
	schemaNeedsDraft202012Upgrade,
	stripSchemaDescriptions,
	toolWireSchema,
} from "@oh-my-pi/pi-ai/utils/schema";

it("normalizes frozen tool parameters without modifying caller-owned required fields", () => {
	const parameters = Object.freeze({
		type: "object",
		properties: Object.freeze({ extra: Object.freeze({}) }),
		required: Object.freeze(["extra"]),
	});
	expect(toolWireSchema({ name: "t", description: "", parameters })).toEqual({
		type: "object",
		properties: { extra: true },
		required: ["extra"],
	});
	expect(parameters.properties.extra).toEqual({});
});

it("strips annotations from sealed and nonextensible shared schema nodes", () => {
	const leaf = Object.preventExtensions({ type: "string", description: "value" });
	const schema = Object.seal({ type: "object", description: "root", properties: { a: leaf, b: leaf } });
	expect(stripSchemaDescriptions(schema)).toEqual({
		type: "object",
		properties: { a: { type: "string" }, b: { type: "string" } },
	});
});

it("revisits schemas frozen after their first draft check", () => {
	const schema = { type: "object", properties: {} as Record<string, unknown> };
	expect(schemaNeedsDraft202012Upgrade(schema)).toBe(false);
	Object.freeze(schema);
	schema.properties.legacy = { type: "string", nullable: true };
	expect(schemaNeedsDraft202012Upgrade(schema)).toBe(true);
});

it("enforces shared frozen schemas repeatedly after traversal stamps were installed", () => {
	const leaf = { type: "string" };
	const schema = { type: "object", properties: { a: leaf, b: leaf }, required: ["a", "b"] };
	const expected = {
		...schema,
		additionalProperties: false,
	};
	expect(enforceStrictSchema(schema)).toEqual(expected);
	Object.freeze(schema);
	Object.freeze(leaf);
	expect(enforceStrictSchema(schema)).toEqual(expected);
});

it("rejects frozen cycles consistently without confusing subsequent shared nodes with cycles", () => {
	const schema: Record<string, unknown> = { type: "object" };
	const properties = { self: schema };
	schema.properties = properties;
	schema.required = ["self"];
	Object.freeze(schema);
	expect(() => enforceStrictSchema(schema)).toThrow("circular object graph");
	expect(() => enforceStrictSchema(schema)).toThrow("circular object graph");
	expect(schemaNeedsDraft202012Upgrade(schema)).toBe(false);
	properties.self = Object.freeze({ type: "string" });
	expect(enforceStrictSchema(schema)).toEqual({
		type: "object",
		properties: { self: { type: "string" } },
		required: ["self"],
		additionalProperties: false,
	});
	const leaf = Object.seal({ type: "string" });
	expect(enforceStrictSchema({ type: "object", properties: { a: leaf, b: leaf }, required: ["a", "b"] })).toEqual({
		type: "object",
		properties: { a: { type: "string" }, b: { type: "string" } },
		required: ["a", "b"],
		additionalProperties: false,
	});
});
