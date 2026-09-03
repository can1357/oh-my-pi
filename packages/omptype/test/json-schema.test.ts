import { describe, expect, it } from "bun:test";
import type { EmbeddableSchema, IR } from "../src/ir";
import { IR_BRAND, parseDef } from "../src/ir";
import { irToJsonSchema } from "../src/json-schema";

describe("irToJsonSchema", () => {
	it("emits a flat tool schema with optional integer bounds", () => {
		const ir = parseDef({ name: "string", "limit?": "1 <= number.integer <= 10" });
		const expected = {
			type: "object",
			properties: {
				name: { type: "string" },
				limit: { type: "integer", minimum: 1, maximum: 10 },
			},
			required: ["name"],
		};
		expect(irToJsonSchema(ir)).toEqual(expected);
	});

	it("collapses a described literal union to a typed enum", () => {
		const ir: IR = {
			k: "union",
			members: [
				{ k: "lit", v: "read" },
				{ k: "lit", v: "write" },
			],
			desc: "Access mode",
		};
		const expected = { enum: ["read", "write"], type: "string", description: "Access mode" };
		expect(irToJsonSchema(ir)).toEqual(expected);
	});

	it("emits nested arrays of objects", () => {
		const ir = parseDef({ items: [{ id: "string", active: "boolean" }, "[]"] });
		const expected = {
			type: "object",
			properties: {
				items: {
					type: "array",
					items: {
						type: "object",
						properties: { id: { type: "string" }, active: { type: "boolean" } },
						required: ["id", "active"],
					},
				},
			},
			required: ["items"],
		};
		expect(irToJsonSchema(ir)).toEqual(expected);
	});

	it("closes objects whose plus policy is reject", () => {
		expect(irToJsonSchema(parseDef({ id: "string", "+": "reject" }))).toEqual({
			type: "object",
			properties: { id: { type: "string" } },
			required: ["id"],
			additionalProperties: false,
		});
	});

	it("emits value and factory defaults and excludes them from required", () => {
		let factoryCalls = 0;
		const ir: IR = {
			k: "object",
			extras: "keep",
			props: [
				{ key: "count", opt: false, val: { k: "number" }, def: 5, hasDefault: true },
				{
					key: "label",
					opt: false,
					val: { k: "string" },
					def: () => {
						factoryCalls++;
						return "generated";
					},
					defFactory: true,
					hasDefault: true,
				},
				{ key: "enabled", opt: false, val: { k: "boolean" } },
			],
		};
		const expected = {
			type: "object",
			properties: {
				count: { type: "number", default: 5 },
				label: { type: "string", default: "generated" },
				enabled: { type: "boolean" },
			},
			required: ["enabled"],
		};
		expect(irToJsonSchema(ir)).toEqual(expected);
		expect(factoryCalls).toBe(1);
		expect(irToJsonSchema(parseDef({ count: "number = 5" }))).toEqual({
			type: "object",
			properties: { count: { type: "number", default: 5 } },
		});
	});

	it("emits an index signature as additionalProperties", () => {
		expect(irToJsonSchema(parseDef({ "[string]": "number.integer" }))).toEqual({
			type: "object",
			properties: {},
			additionalProperties: { type: "integer" },
		});
	});

	it("emits URL strings with the uri format", () => {
		const expected = { type: "string", format: "uri" };
		expect(irToJsonSchema(parseDef("string.url"))).toEqual(expected);
	});

	it("prunes undefined union members and unwraps the remaining schema", () => {
		expect(irToJsonSchema(parseDef("string | undefined"))).toEqual({ type: "string" });
		expect(irToJsonSchema({ k: "union", members: [{ k: "undefined" }, { k: "number" }, { k: "boolean" }] })).toEqual({
			anyOf: [{ type: "number" }, { type: "boolean" }],
		});
	});

	it("falls back through sub nodes and merges the embedded description", () => {
		const schema: EmbeddableSchema = {
			[IR_BRAND]: true,
			ir: { k: "array", el: { k: "number", int: true }, min: 1 },
			hasSteps: true,
			hasDefault: false,
			description: "Non-empty identifiers",
			run: value => value,
		};
		expect(irToJsonSchema({ k: "sub", schema })).toEqual({
			type: "array",
			items: { type: "integer" },
			minItems: 1,
			description: "Non-empty identifiers",
		});
	});

	it("lets a root description option override the IR description", () => {
		expect(irToJsonSchema({ k: "string", desc: "inner" }, { description: "root" })).toEqual({
			type: "string",
			description: "root",
		});
	});

	it("honors draft targets, explicit dialects, and unsupported-node fallbacks", () => {
		// A fixed tuple is closed by `additionalItems: false`; ArkType emits no `maxItems`.
		expect(irToJsonSchema(parseDef(["string", "number"]), { target: "draft-07" })).toEqual({
			type: "array",
			items: [{ type: "string" }, { type: "number" }],
			minItems: 2,
			additionalItems: false,
			$schema: "http://json-schema.org/draft-07/schema#",
		});
		expect(irToJsonSchema(parseDef("string"), { dialect: "https://example.test/schema" })).toEqual({
			type: "string",
			$schema: "https://example.test/schema",
		});
		expect(
			irToJsonSchema(parseDef("symbol"), {
				fallback: ({ base }) => ({ ...base, type: "string", description: "symbol token" }),
			}),
		).toEqual({ type: "string", description: "symbol token" });
	});
});
