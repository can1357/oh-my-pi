import { describe, expect, it } from "bun:test";
import { decodeFoundationModelsArguments, toFoundationModelsSchema } from "../src/utils/schema/foundation-models";

describe("toFoundationModelsSchema", () => {
	it("emits the strict object dialect GenerationSchema's decoder requires", () => {
		const { schema, encodedPaths } = toFoundationModelsSchema(
			{
				type: "object",
				properties: {
					path: { type: "string", description: "File" },
					edits: {
						type: "array",
						items: { type: "object", properties: { find: { type: "string" } }, required: ["find", "gone"] },
					},
				},
				required: ["path", "missing"],
			},
			"edit-file",
		);
		expect(encodedPaths).toEqual([]);
		expect(schema).toEqual({
			type: "object",
			title: "edit_file",
			properties: {
				path: { type: "string", description: "File" },
				edits: {
					type: "array",
					items: {
						type: "object",
						title: "edit_file_edits_item",
						properties: { find: { type: "string" } },
						required: ["find"],
						"x-order": ["find"],
						additionalProperties: false,
					},
				},
			},
			required: ["path"],
			"x-order": ["path", "edits"],
			additionalProperties: false,
		});
	});

	it("collapses literal unions to string enums and drops null branches", () => {
		const { schema } = toFoundationModelsSchema(
			{
				type: "object",
				properties: {
					mode: { anyOf: [{ const: "text" }, { const: "hex" }, { enum: ["raw"] }] },
					range: { type: ["string", "null"] },
					limit: { anyOf: [{ type: "integer", minimum: 1 }, { type: "null" }] },
				},
			},
			"read",
		);
		expect(schema.properties).toEqual({
			mode: { type: "string", enum: ["text", "hex", "raw"] },
			range: { type: "string" },
			limit: { type: "integer", minimum: 1 },
		});
	});

	it("encodes unrepresentable subschemas as JSON strings and decodes them back", () => {
		const { schema, encodedPaths } = toFoundationModelsSchema(
			{
				type: "object",
				properties: {
					meta: { type: "object", additionalProperties: true, description: "Extra" },
					items: { type: "array", items: {} },
					// A union whose object branch holds a free-form map is encoded whole,
					// never per-branch, so decoding stays unambiguous.
					value: {
						anyOf: [{ type: "string" }, { type: "object", properties: { data: { type: "object" } } }],
					},
				},
			},
			"call",
		);
		expect(encodedPaths).toEqual([["meta"], ["items", "*"], ["value"]]);
		expect(schema.properties).toMatchObject({
			meta: { type: "string", description: "Extra (JSON-encoded value)" },
			items: { type: "array", items: { type: "string" } },
			value: { type: "string" },
		});

		const args = decodeFoundationModelsArguments(
			{ meta: '{"why":"debug"}', items: ["1", '{"a":true}', "not json"], value: '"plain"' },
			encodedPaths,
		);
		expect(args).toEqual({ meta: { why: "debug" }, items: [1, { a: true }, "not json"], value: "plain" });
	});

	it("keeps representable unions as titled anyOf", () => {
		const { schema } = toFoundationModelsSchema(
			{ type: "object", properties: { target: { anyOf: [{ type: "string" }, { type: "integer" }] } } },
			"go",
		);
		expect(schema.properties).toEqual({
			target: { title: "go_target", anyOf: [{ type: "string" }, { type: "integer" }] },
		});
	});
});
