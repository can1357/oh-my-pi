import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { dispatchToolCommand, type ToolCommandState } from "../../src/tools/tool-commands";
import type { Tool } from "../../src/tools";

function fixtureTool(): Tool {
	return {
		name: "fixture",
		description: "Fixture tool.",
		parameters: { type: "object", properties: {}, additionalProperties: true },
		async execute() {
			return { content: [{ type: "text", text: "ok" }] };
		},
	} as unknown as Tool;
}

function state(tool: Tool): ToolCommandState {
	return {
		tools: new Map([[tool.name, tool]]),
		mountedNames: new Set([tool.name]),
		builtInNames: new Set([tool.name]),
		isActive: () => false,
	};
}

describe("tool command shell cwd guard", () => {
	it("executes when the shell cwd matches the session cwd", async () => {
		const tool = fixtureTool();
		const { result, dispatch } = await dispatchToolCommand(
			state(tool),
			"fixture",
			{},
			"id",
			undefined,
			undefined,
			undefined,
			{ shellCwd: "/repo", sessionCwd: "/repo" },
		);
		expect(result.isError).toBeFalsy();
		expect(dispatch.exitCode).toBe(0);
	});

	it("refuses with both directories when the shell cwd differs from the session cwd", async () => {
		const tool = fixtureTool();
		const { result } = await dispatchToolCommand(
			state(tool),
			"fixture",
			{},
			"id",
			undefined,
			undefined,
			undefined,
			{ shellCwd: path.resolve("/repo/sub"), sessionCwd: path.resolve("/repo") },
		);
		expect(result.isError).toBe(true);
		const text = result.content.find(block => block.type === "text");
		expect(text?.type === "text" && text.text).toContain("/repo/sub");
		expect(text?.type === "text" && text.text).toContain("/repo");
	});
});
