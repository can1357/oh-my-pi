import { describe, expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { jsonSchemaToTypeScript, toolWireSchema } from "@oh-my-pi/pi-ai/utils/schema";

describe("jsonSchemaToTypeScript", () => {
	it("renders objects with optional markers and JSDoc descriptions", () => {
		const ts = jsonSchemaToTypeScript({
			type: "object",
			properties: {
				query: { type: "string", description: "search query" },
				limit: { type: "number", description: "max results" },
			},
			required: ["query"],
		});
		expect(ts).toContain("/** search query */");
		expect(ts).toContain("query: string;");
		expect(ts).toContain("/** max results */");
		expect(ts).toContain("limit?: number;");
	});

	it("renders the harmony style with line comments, comma delimiters, and no indentation", () => {
		const ts = jsonSchemaToTypeScript(
			{
				type: "object",
				properties: {
					position: { type: "number", description: "keypad position, 1 through 5" },
					digit: { type: "number", description: "digit guess, 0 through 9" },
				},
				required: ["position", "digit"],
			},
			{ style: "harmony" },
		);
		expect(ts).toBe(
			"{\n// keypad position, 1 through 5\nposition: number,\n// digit guess, 0 through 9\ndigit: number,\n}",
		);
	});

	it("renders enums and consts as literal unions", () => {
		const ts = jsonSchemaToTypeScript({
			type: "object",
			properties: {
				recency: { type: "string", enum: ["day", "week", "month"] },
				kind: { const: "fixed" },
			},
			required: ["recency", "kind"],
		});
		expect(ts).toContain('recency: "day" | "week" | "month";');
		expect(ts).toContain('kind: "fixed";');
	});

	it("renders arrays, tuples, and records", () => {
		const ts = jsonSchemaToTypeScript({
			type: "object",
			properties: {
				tags: { type: "array", items: { type: "string" } },
				pair: { type: "array", prefixItems: [{ type: "string" }, { type: "number" }] },
				meta: { type: "object", additionalProperties: { type: "number" } },
				rows: {
					type: "array",
					items: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
				},
			},
			required: ["tags", "pair", "meta", "rows"],
		});
		expect(ts).toContain("tags: string[];");
		expect(ts).toContain("pair: [string, number];");
		expect(ts).toContain("meta: Record<string, number>;");
		// Object-valued array elements expand to Array<{ … }> rather than inline `[]`.
		expect(ts).toContain("rows: Array<{");
		expect(ts).toContain("id: string;");
	});

	it("renders nullable unions from both type-arrays and anyOf", () => {
		const ts = jsonSchemaToTypeScript({
			type: "object",
			properties: {
				a: { type: ["string", "null"] },
				b: { anyOf: [{ type: "number" }, { type: "null" }] },
			},
			required: ["a", "b"],
		});
		expect(ts).toContain("a: string | null;");
		expect(ts).toContain("b: number | null;");
	});

	it("resolves a local $ref against $defs", () => {
		const ts = jsonSchemaToTypeScript({
			type: "object",
			properties: { node: { $ref: "#/$defs/Node" } },
			required: ["node"],
			$defs: { Node: { type: "object", properties: { value: { type: "number" } }, required: ["value"] } },
		});
		expect(ts).toContain("node: {");
		expect(ts).toContain("value: number;");
	});

	it("renders an empty object schema as {}", () => {
		expect(jsonSchemaToTypeScript({ type: "object", properties: {}, additionalProperties: false })).toBe("{}");
	});

	it("converts a Zod schema through the wire pipeline", () => {
		const parameters = type({
			name: type("string").describe("the name"),
			count: type("number.integer").optional(),
		});
		const ts = jsonSchemaToTypeScript(toolWireSchema({ name: "t", description: "", parameters }));
		expect(ts).toContain("/** the name */");
		expect(ts).toContain("name: string;");
		expect(ts).toContain("count?: number;");
	});
});
