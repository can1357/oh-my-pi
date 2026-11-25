import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import type { MCPToolDetails } from "@oh-my-pi/pi-coding-agent/tools/details/mcp";
import { currentTheme, setCurrentTheme } from "@oh-my-pi/pi-tui/theme/runtime";
import { Settings } from "../../../src/config/settings";
import type { InteractiveModeContext } from "../../../src/modes/types";
import { ToolCall } from "../../../src/ui/transcript/tool-block";
import { createInteractiveModeContext, renderTranscript } from "../../helpers/interactive-mode-context";
import { toolCallText } from "../../helpers/tool-text";

const restoreTheme = currentTheme();

beforeAll(async () => {
	await Settings.init({ inMemory: true });
});

afterAll(() => setCurrentTheme(restoreTheme));

/** A context whose session owns no built-in tools (every call is an extension's). */
function extensionContext(): InteractiveModeContext {
	return createInteractiveModeContext({ session: { hasBuiltInTool: () => false } });
}

/** Present `tool`'s call (and `resultText`, when given) and return the transcript text. */
function presentExtensionCall(tool: AgentTool, args: unknown, resultText?: string): string {
	const ctx = extensionContext();
	const pending = ctx.presentToolCall({ name: tool.name, args, tool, id: "call-1", cwd: process.cwd() });
	pending.setArgsComplete("call-1");
	pending.setExecutionStarted("call-1");
	if (resultText !== undefined)
		pending.updateResult({ content: [{ type: "text", text: resultText }] }, false, "call-1");
	return renderTranscript(ctx, 80).join("\n");
}

/** A rows object whose painting throws (a renderer that broke at draw time). */
const throwingRows = {
	render(): readonly string[] {
		throw new TypeError("th.bold is not a function");
	},
};

describe("extension tool cards", () => {
	it("keeps the card drawable when a renderCall rows object throws while painting", () => {
		const tool = {
			name: "graphify_graph",
			label: "Graphify Graph",
			description: "renders a graph",
			parameters: { type: "object", additionalProperties: true },
			renderCall: () => throwingRows,
			async execute() {
				return { content: [{ type: "text", text: "ok" }] };
			},
		} as unknown as AgentTool;
		let text = "";
		expect(() => {
			text = presentExtensionCall(tool, {});
		}).not.toThrow();
		expect(text).toContain("th.bold is not a function");
	});

	it("keeps the card drawable when a renderResult rows object throws while painting", () => {
		const tool = {
			name: "crashy_result_renderer",
			label: "Crashy Result Renderer",
			description: "renders result output",
			parameters: { type: "object", additionalProperties: true },
			renderResult: () => throwingRows,
			async execute() {
				return { content: [{ type: "text", text: "raw" }] };
			},
		} as unknown as AgentTool;
		let text = "";
		expect(() => {
			text = presentExtensionCall(tool, {}, "raw result");
		}).not.toThrow();
		expect(text).toContain("th.bold is not a function");
	});

	it("renders a same-named extension tool result with the generic card, not the built-in's", () => {
		const resultText = "recalled postgres memory";
		const tool = {
			name: "recall",
			label: "Extension Recall",
			description: "recalls external memory",
			parameters: { type: "object", additionalProperties: true },
			async execute() {
				return { content: [{ type: "text", text: resultText }] };
			},
		} as unknown as AgentTool;
		const rendered = presentExtensionCall(tool, { query: "project context" }, resultText);
		expect(rendered).toContain("Extension Recall");
		expect(rendered).toContain(resultText);
		expect(rendered).not.toContain("no matches");
	});
});

describe("MCP result Markdown rendering", () => {
	const details: MCPToolDetails = {
		serverName: "context-mode",
		mcpToolName: "ctx_search",
	};

	/** The expanded card of an MCP call returning `text`; `markdown`: `mcp.renderMarkdownResults`. */
	function mcpText(text: string, markdown = true): string {
		const call = new ToolCall({
			id: "call-1",
			name: "mcp__context-mode_ctx_search",
			args: {},
			mcpMarkdown: markdown,
		});
		call.setArgsComplete();
		call.setExecutionStarted();
		call.updateResult({ content: [{ type: "text", text }], details }, false);
		call.setExpanded(true);
		return toolCallText(call, 80);
	}

	it("renders inline Markdown when the setting is on", () => {
		const rendered = mcpText("**bold result** and `code`");
		expect(rendered).toContain("bold result and code");
		expect(rendered).not.toContain("**bold result**");
		expect(rendered).not.toContain("`code`");
	});

	it("keeps Markdown syntax literal when the setting is disabled", () => {
		expect(mcpText("**bold result**", false)).toContain("**bold result**");
	});

	it("preserves structured JSON rendering when Markdown is enabled", () => {
		const rendered = mcpText('{"status":"**ok**"}');
		expect(rendered).toContain("status");
		expect(rendered).toContain("**ok**");
	});
});
