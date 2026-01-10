import { Type } from "@sinclair/typebox";
import { describe, expect, it } from "bun:test";
import type { Tool, ToolCall } from "../src/types.js";
import { validateToolArguments } from "../src/utils/validation.js";

describe("Tool argument coercion", () => {
	it("coerces numeric strings when schema expects number", () => {
		const tool: Tool = {
			name: "t1",
			description: "",
			parameters: Type.Object({ timeout: Type.Number() }),
		};

		const toolCall: ToolCall = {
			type: "toolCall",
			id: "call-1",
			name: "t1",
			arguments: { timeout: "300" },
		};

		const result = validateToolArguments(tool, toolCall);
		expect(result.timeout).toBe(300);
		expect(typeof result.timeout).toBe("number");
	});

	it("preserves string values when schema expects string", () => {
		const tool: Tool = {
			name: "t2",
			description: "",
			parameters: Type.Object({ label: Type.String() }),
		};

		const toolCall: ToolCall = {
			type: "toolCall",
			id: "call-2",
			name: "t2",
			arguments: { label: "300" },
		};

		const result = validateToolArguments(tool, toolCall);
		expect(result.label).toBe("300");
		expect(typeof result.label).toBe("string");
	});

	it("parses JSON arrays in string values when schema expects array", () => {
		const tool: Tool = {
			name: "t3",
			description: "",
			parameters: Type.Object({ items: Type.Array(Type.Number()) }),
		};

		const toolCall: ToolCall = {
			type: "toolCall",
			id: "call-3",
			name: "t3",
			arguments: { items: "[1, 2, 3]" },
		};

		const result = validateToolArguments(tool, toolCall);
		expect(result.items).toEqual([1, 2, 3]);
	});

	it("parses JSON objects in string values when schema expects object", () => {
		const tool: Tool = {
			name: "t4",
			description: "",
			parameters: Type.Object({ payload: Type.Object({ a: Type.Number() }) }),
		};

		const toolCall: ToolCall = {
			type: "toolCall",
			id: "call-4",
			name: "t4",
			arguments: { payload: "{\"a\": 1}" },
		};

		const result = validateToolArguments(tool, toolCall);
		expect(result.payload).toEqual({ a: 1 });
	});

	it("parses nested JSON arrays in string values", () => {
		const tool: Tool = {
			name: "t5",
			description: "",
			parameters: Type.Object({ payload: Type.Object({ items: Type.Array(Type.Number()) }) }),
		};

		const toolCall: ToolCall = {
			type: "toolCall",
			id: "call-5",
			name: "t5",
			arguments: { payload: { items: "[4, 5]" } },
		};

		const result = validateToolArguments(tool, toolCall);
		expect(result.payload.items).toEqual([4, 5]);
	});

	it("does not parse quoted JSON strings when schema expects number", () => {
		const tool: Tool = {
			name: "t6",
			description: "",
			parameters: Type.Object({ timeout: Type.Number() }),
		};

		const toolCall: ToolCall = {
			type: "toolCall",
			id: "call-6",
			name: "t6",
			arguments: { timeout: "\"300\"" },
		};

		expect(() => validateToolArguments(tool, toolCall)).toThrow(
			"Validation failed for tool \"t6\"",
		);
	});
});
