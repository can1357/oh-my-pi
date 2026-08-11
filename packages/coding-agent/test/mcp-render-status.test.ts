import { beforeAll, describe, expect, it } from "bun:test";
import type { AgentTool } from "@pk-nerdsaver-ai/pi-agent-core";
import type { TSchema } from "@pk-nerdsaver-ai/pi-ai";
import { resetSettingsForTest, Settings } from "@pk-nerdsaver-ai/pi-coding-agent/config/settings";
import { formatMCPStructuredContent, renderMCPResult } from "@pk-nerdsaver-ai/pi-coding-agent/mcp/render";
import { DeferredMCPTool, MCPTool, type MCPToolDetails } from "@pk-nerdsaver-ai/pi-coding-agent/mcp/tool-bridge";
import type { MCPServerConnection, MCPToolDefinition, MCPTransport } from "@pk-nerdsaver-ai/pi-coding-agent/mcp/types";
import { ToolExecutionComponent } from "@pk-nerdsaver-ai/pi-coding-agent/modes/components/tool-execution";
import { theme as activeTheme, getThemeByName, initTheme } from "@pk-nerdsaver-ai/pi-coding-agent/modes/theme/theme";
import { formatOutputNotice, type OutputMeta } from "@pk-nerdsaver-ai/pi-coding-agent/tools/output-meta";
import { formatStatusIcon } from "@pk-nerdsaver-ai/pi-coding-agent/tools/render-utils";
import { TUI } from "@pk-nerdsaver-ai/pi-tui";
import { VirtualTerminal } from "../../tui/test/virtual-terminal";

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true, cwd: process.cwd() });
	await initTheme(false, undefined, undefined, "dark", "light");
}, 15_000);

async function getRequiredTheme() {
	const uiTheme = await getThemeByName("dark");
	if (!uiTheme) {
		throw new Error("dark theme missing");
	}
	return uiTheme;
}

function makeConnection(): MCPServerConnection {
	const transport: MCPTransport = {
		connected: true,
		request<T = unknown>(): Promise<T> {
			return Promise.reject(new Error("transport is not used by renderer tests"));
		},
		notify(): Promise<void> {
			return Promise.resolve();
		},
		close(): Promise<void> {
			return Promise.resolve();
		},
	};

	return {
		name: "sentry",
		config: { command: "sentry-mcp" },
		transport,
		serverInfo: { name: "sentry", version: "1.0.0" },
		capabilities: { tools: {} },
	};
}

function makeDefinition(): MCPToolDefinition {
	return {
		name: "search_events",
		description: "Search Sentry events",
		inputSchema: {
			type: "object",
			properties: { query: { type: "string" } },
			required: ["query"],
		},
	};
}

function makeTool(): MCPTool {
	return new MCPTool(makeConnection(), makeDefinition());
}

function makeDeferredTool(): DeferredMCPTool {
	return new DeferredMCPTool("sentry", makeDefinition(), () => Promise.resolve(makeConnection()));
}

type RenderableMCPAgentTool = AgentTool<TSchema, MCPToolDetails> & { mergeCallAndResult: true };

function makeAgentTool(mcpTool: MCPTool): RenderableMCPAgentTool {
	return {
		name: mcpTool.name,
		label: mcpTool.label,
		description: mcpTool.description,
		parameters: mcpTool.parameters,
		mergeCallAndResult: mcpTool.mergeCallAndResult,
		execute(): Promise<never> {
			return Promise.reject(new Error("MCP execution is not used by renderer tests"));
		},
		renderCall(args, options) {
			return mcpTool.renderCall(args, options, activeTheme);
		},
		renderResult(result, options) {
			return mcpTool.renderResult(result, options, activeTheme);
		},
	};
}

async function renderCompletedMCPTool(isError: boolean): Promise<string> {
	const mcpTool = makeTool();
	const tool = makeAgentTool(mcpTool);
	const tui = new TUI(new VirtualTerminal(120, 20));
	const component = new ToolExecutionComponent(tool.name, { query: "level:error" }, {}, tool, tui);

	component.updateResult(
		{
			content: [{ type: "text", text: isError ? "Error: denied" : '{"ok":true}' }],
			details: { serverName: "sentry", mcpToolName: "search_events", isError },
			...(isError ? { isError: true } : {}),
		},
		false,
	);

	return Bun.stripANSI(component.render(160).join("\n"));
}

describe("MCP tool rendering", () => {
	it("replaces the pending call header with a success header after completion", async () => {
		const uiTheme = await getRequiredTheme();
		const pendingIcon = Bun.stripANSI(formatStatusIcon("pending", uiTheme));
		const doneIcon = Bun.stripANSI(uiTheme.styledSymbol("tool.mcp", "accent"));

		const rendered = await renderCompletedMCPTool(false);

		expect(makeTool().mergeCallAndResult).toBe(true);
		expect(makeDeferredTool().mergeCallAndResult).toBe(true);
		expect(rendered).toContain(`${doneIcon} sentry/search_events`);
		expect(rendered).not.toContain(`${pendingIcon} sentry/search_events`);
	}, 15_000);

	it("replaces the pending call header with an error header for MCP errors", async () => {
		const uiTheme = await getRequiredTheme();
		const pendingIcon = Bun.stripANSI(formatStatusIcon("pending", uiTheme));
		const errorIcon = Bun.stripANSI(formatStatusIcon("error", uiTheme));

		const rendered = await renderCompletedMCPTool(true);

		expect(rendered).toContain(`${errorIcon} sentry/search_events`);
		expect(rendered).not.toContain(`${pendingIcon} sentry/search_events`);
	}, 15_000);

	it("strips the spill notice from the body and surfaces the artifact link as a styled warning", () => {
		const meta: OutputMeta = {
			truncation: {
				direction: "tail",
				truncatedBy: "bytes",
				totalLines: 100,
				totalBytes: 8000,
				outputLines: 4,
				outputBytes: 160,
				maxBytes: 1024,
				shownRange: { start: 97, end: 100 },
				artifactId: "7",
			},
		};
		// Mirror what the spill wrapper emits: the truncated body with the
		// LLM-facing notice appended (via formatOutputNotice) plus meta.truncation.
		const body = "event 97\nevent 98\nevent 99\nevent 100";
		const result = {
			content: [{ type: "text" as const, text: body + formatOutputNotice(meta) }],
			details: { serverName: "evk", mcpToolName: "peek", meta },
		};

		const rendered = Bun.stripANSI(
			renderMCPResult(result, { expanded: true, isPartial: false }, activeTheme).render(160).join("\n"),
		);

		expect(rendered).toContain("event 97");
		expect(rendered).toContain("event 100");
		expect(rendered).toContain("artifact://7");
		// The link appears exactly once — as the styled warning — proving the
		// inline notice was stripped from the body rather than echoed verbatim.
		expect(rendered.split("artifact://7").length - 1).toBe(1);
	}, 15_000);
	it("renders every text block and structured data without echoing the model-only JSON block", () => {
		const structuredContent = { zeta: [2, 3], alpha: "one" };
		const structuredModelText = formatMCPStructuredContent(structuredContent);
		const result = {
			content: [
				{ type: "text" as const, text: "first server block" },
				{ type: "text" as const, text: "second server block" },
				{ type: "text" as const, text: structuredModelText },
			],
			details: {
				serverName: "sentry",
				mcpToolName: "search_events",
				structuredContent,
			},
		};

		const rendered = Bun.stripANSI(
			renderMCPResult(result, { expanded: true, isPartial: false }, activeTheme).render(160).join("\n"),
		);

		expect(rendered).toContain("first server block");
		expect(rendered).toContain("second server block");
		expect(rendered).toContain("Structured content");
		expect(rendered).toContain("alpha");
		expect(rendered).toContain("zeta");
		expect(rendered.split("Structured content").length - 1).toBe(1);
	}, 15_000);
	it("renders result keys that are hidden only from argument trees", () => {
		const structuredContent = JSON.parse(
			'{"i":"result intent","__partialJson":"result wire","__proto__":{"safe":true}}',
		);
		const result = {
			content: [{ type: "text" as const, text: formatMCPStructuredContent(structuredContent) }],
			details: { serverName: "sentry", mcpToolName: "inspect", structuredContent },
		};

		const rendered = Bun.stripANSI(
			renderMCPResult(result, { expanded: true, isPartial: false }, activeTheme).render(160).join("\n"),
		);

		expect(rendered).toContain("i");
		expect(rendered).toContain("result intent");
		expect(rendered).toContain("__partialJson");
		expect(rendered).toContain("result wire");
		expect(rendered).toContain("__proto__");
		expect(rendered).toContain("safe");
	}, 15_000);

	it("removes complete or partial bridge JSON retained by artifact spilling before rendering details", () => {
		const structuredContent = { answer: "complete", values: [1, 2, 3] };
		const structuredModelText = formatMCPStructuredContent(structuredContent);
		const meta: OutputMeta = {
			truncation: {
				direction: "tail",
				truncatedBy: "bytes",
				totalLines: 20,
				totalBytes: 2000,
				outputLines: 8,
				outputBytes: 400,
				maxBytes: 512,
				shownRange: { start: 13, end: 20 },
				artifactId: "structured-spill",
			},
		};
		const render = (text: string) =>
			Bun.stripANSI(
				renderMCPResult(
					{
						content: [{ type: "text" as const, text: text + formatOutputNotice(meta) }],
						details: { serverName: "sentry", mcpToolName: "inspect", structuredContent, meta },
					},
					{ expanded: true, isPartial: false },
					activeTheme,
				)
					.render(160)
					.join("\n"),
			);

		const completeSuffix = render(`server tail\n${structuredModelText}`);
		const partialSuffix = render(`server head\n…\n${structuredModelText.slice(-24)}`);

		expect(completeSuffix).toContain("server tail");
		expect(completeSuffix.split("Structured content").length - 1).toBe(1);
		expect(partialSuffix).toContain("server head");
		expect(partialSuffix).not.toContain(structuredModelText.slice(-24));
		expect(partialSuffix.split("Structured content").length - 1).toBe(1);
		expect(completeSuffix).toContain("artifact://structured-spill");
	}, 15_000);
	it("renders scalar structured values instead of slicing away their only tree line", () => {
		const render = (structuredContent: string | number | boolean | null) =>
			Bun.stripANSI(
				renderMCPResult(
					{
						content: [{ type: "text" as const, text: formatMCPStructuredContent(structuredContent) }],
						details: { serverName: "sentry", mcpToolName: "inspect", structuredContent },
					},
					{ expanded: true, isPartial: false },
					activeTheme,
				)
					.render(160)
					.join("\n"),
			);

		expect(render("scalar value")).toContain('"scalar value"');
		expect(render(42)).toContain("42");
		expect(render(true)).toContain("true");
		expect(render(null)).toContain("null");
	}, 15_000);
});
