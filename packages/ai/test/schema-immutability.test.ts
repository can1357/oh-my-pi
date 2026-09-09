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

it("sends schemas carrying non-cloneable metadata to the wire without the metadata", () => {
	const parameters: Record<string, unknown> = {
		type: "object",
		properties: { path: { type: "string" } },
		required: ["path"],
		"x-omp-coerce": (value: unknown) => value,
	};
	const wire = toolWireSchema({ name: "t", description: "", parameters });
	expect(wire).toEqual({
		type: "object",
		properties: { path: { type: "string" } },
		required: ["path"],
	});
	expect(Object.hasOwn(wire, "x-omp-coerce")).toBe(false);
	expect(typeof parameters["x-omp-coerce"]).toBe("function");
});

function deepFreeze(value: unknown, seen = new WeakSet<object>()): void {
	if (!value || typeof value !== "object" || seen.has(value)) return;
	seen.add(value);
	for (const key of Reflect.ownKeys(value)) deepFreeze((value as Record<PropertyKey, unknown>)[key], seen);
	Object.freeze(value);
}

it("keeps traversal state off caller graphs that are deep-frozen after a first visit", () => {
	const schema: Record<string, unknown> = { type: "object", properties: { a: { type: "string" } }, required: ["a"] };
	const expected = { ...schema, additionalProperties: false };
	expect(schemaNeedsDraft202012Upgrade(schema)).toBe(false);
	expect(enforceStrictSchema(schema)).toEqual(expected);
	deepFreeze(schema);
	expect(schemaNeedsDraft202012Upgrade(schema)).toBe(false);
	expect(enforceStrictSchema(schema)).toEqual(expected);
});
