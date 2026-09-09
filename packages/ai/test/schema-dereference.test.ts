import { describe, expect, it } from "bun:test";
import { dereferenceJsonSchema } from "@oh-my-pi/pi-ai/utils/schema";

describe("dereferenceJsonSchema", () => {
	it("returns non-object input unchanged", () => {
		expect(dereferenceJsonSchema(null)).toBe(null);
		expect(dereferenceJsonSchema("string")).toBe("string");
		expect(dereferenceJsonSchema(42)).toBe(42);
	});

	it("returns schema without $defs unchanged", () => {
		const schema = {
			type: "object",
			properties: { name: { type: "string" } },
			required: ["name"],
		};
		expect(dereferenceJsonSchema(schema)).toBe(schema);
	});

	it("inlines a simple $ref from $defs", () => {
		const schema = {
			type: "object",
			properties: {
				anchor: { $ref: "#/$defs/Anchor" },
			},
			$defs: {
				Anchor: {
					type: "object",
					properties: {
						path: { type: "string" },
						line: { type: "integer", minimum: 0 },
					},
				},
			},
		};
		const result = dereferenceJsonSchema(schema) as any;
		expect(result.$defs).toBeUndefined();
		expect(result.properties.anchor).toEqual({
			type: "object",
			properties: {
				path: { type: "string" },
				line: { type: "integer", minimum: 0 },
			},
		});
	});

	it("inlines $ref from definitions (legacy keyword)", () => {
		const schema = {
			type: "object",
			properties: {
				item: { $ref: "#/definitions/Item" },
			},
			definitions: {
				Item: { type: "string", enum: ["a", "b"] },
			},
		};
		const result = dereferenceJsonSchema(schema) as any;
		expect(result.definitions).toBeUndefined();
		expect(result.properties.item).toEqual({ type: "string", enum: ["a", "b"] });
	});

	it("inlines nested $ref inside arrays (items, anyOf, oneOf)", () => {
		const schema = {
			type: "object",
			properties: {
				anchors: {
					type: "array",
					items: { $ref: "#/$defs/SourceAnchorInput" },
				},
				value: {
					anyOf: [{ $ref: "#/$defs/Str" }, { type: "null" }],
				},
			},
			$defs: {
				SourceAnchorInput: {
					type: "object",
					properties: {
						anchor_type: { type: "string", enum: ["file", "symbol", "pattern"] },
						path: { type: "string" },
					},
					required: ["anchor_type", "path"],
				},
				Str: { type: "string" },
			},
		};
		const result = dereferenceJsonSchema(schema) as any;
		expect(result.$defs).toBeUndefined();
		expect(result.properties.anchors.items).toEqual({
			type: "object",
			properties: {
				anchor_type: { type: "string", enum: ["file", "symbol", "pattern"] },
				path: { type: "string" },
			},
			required: ["anchor_type", "path"],
		});
		expect(result.properties.value.anyOf[0]).toEqual({ type: "string" });
		expect(result.properties.value.anyOf[1]).toEqual({ type: "null" });
	});

	it("handles $ref inside a definition pointing to another definition", () => {
		const schema = {
			type: "object",
			properties: {
				wrapper: { $ref: "#/$defs/Wrapper" },
			},
			$defs: {
				Inner: { type: "integer", minimum: 0 },
				Wrapper: {
					type: "object",
					properties: {
						value: { $ref: "#/$defs/Inner" },
					},
				},
			},
		};
		const result = dereferenceJsonSchema(schema) as any;
		expect(result.$defs).toBeUndefined();
		expect(result.properties.wrapper).toEqual({
			type: "object",
			properties: {
				value: { type: "integer", minimum: 0 },
			},
		});
	});

	it("breaks circular $ref with empty object", () => {
		const schema = {
			type: "object",
			properties: {
				node: { $ref: "#/$defs/TreeNode" },
			},
			$defs: {
				TreeNode: {
					type: "object",
					properties: {
						name: { type: "string" },
						children: {
							type: "array",
							items: { $ref: "#/$defs/TreeNode" },
						},
					},
				},
			},
		};
		const result = dereferenceJsonSchema(schema) as any;
		expect(result.$defs).toBeUndefined();
		const node = result.properties.node;
		expect(node.properties.name).toEqual({ type: "string" });
		// Circular ref breaks to {}
		expect(node.properties.children.items).toEqual({});
	});

	it("leaves external $ref untouched", () => {
		const schema = {
			type: "object",
			properties: {
				ext: { $ref: "https://example.com/schema.json#/Foo" },
			},
			$defs: {},
		};
		const result = dereferenceJsonSchema(schema) as any;
		expect(result.properties.ext).toEqual({ $ref: "https://example.com/schema.json#/Foo" });
	});

	it("preserves sibling keywords alongside $ref", () => {
		const schema = {
			type: "object",
			properties: {
				anchor_type: {
					$ref: "#/$defs/AnchorType",
					description: "Field-level description",
					default: "file",
				},
			},
			$defs: {
				AnchorType: {
					type: "string",
					enum: ["file", "symbol", "pattern"],
					description: "Type-level description",
				},
			},
		};
		const result = dereferenceJsonSchema(schema) as any;
		expect(result.$defs).toBeUndefined();
		// Sibling description overrides the definition's description
		expect(result.properties.anchor_type).toEqual({
			type: "string",
			enum: ["file", "symbol", "pattern"],
			description: "Field-level description",
			default: "file",
		});
	});

	it("handles multiple properties referencing the same $def", () => {
		const schema = {
			type: "object",
			properties: {
				a: { $ref: "#/$defs/Shared" },
				b: { $ref: "#/$defs/Shared" },
			},
			$defs: {
				Shared: { type: "string", maxLength: 100 },
			},
		};
		const result = dereferenceJsonSchema(schema) as any;
		expect(result.$defs).toBeUndefined();
		expect(result.properties.a).toEqual({ type: "string", maxLength: 100 });
		expect(result.properties.b).toEqual({ type: "string", maxLength: 100 });
	});

	it("reproduces the nucleus write_memory schema pattern", () => {
		// Simplified version of the actual nucleus tool schema
		const schema = {
			type: "object",
			properties: {
				kind: { type: "string", description: "Memory kind" },
				content: { type: "string", description: "Memory content" },
				anchors: {
					description: "Source anchors",
					items: { $ref: "#/$defs/SourceAnchorInput" },
					type: "array",
				},
			},
			required: ["kind", "content", "anchors"],
			$defs: {
				SourceAnchorInput: {
					type: "object",
					properties: {
						anchor_type: {
							description: "Anchor type",
							enum: ["file", "symbol", "pattern"],
							type: "string",
						},
						path: { type: "string" },
						role: { type: "string" },
						symbol: { type: "string" },
					},
					required: ["anchor_type", "path"],
				},
			},
		};
		const result = dereferenceJsonSchema(schema) as any;

		// $defs stripped
		expect(result.$defs).toBeUndefined();

		// anchors items fully inlined
		expect(result.properties.anchors.items.properties.anchor_type.enum).toEqual(["file", "symbol", "pattern"]);
		expect(result.properties.anchors.items.required).toEqual(["anchor_type", "path"]);

		// Other properties preserved
		expect(result.properties.kind).toEqual({ type: "string", description: "Memory kind" });
		expect(result.required).toEqual(["kind", "content", "anchors"]);
	});
});
