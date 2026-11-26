import { beforeAll, describe, expect, it } from "bun:test";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { MCPTool } from "@oh-my-pi/pi-coding-agent/mcp/tool-bridge";
import type { MCPServerConnection, MCPToolDefinition, MCPTransport } from "@oh-my-pi/pi-coding-agent/mcp/types";
import { formatOutputNotice, type OutputMeta } from "@oh-my-pi/pi-coding-agent/tools/output-meta-format";
import { currentTheme } from "@oh-my-pi/pi-tui/theme/runtime";
import { toolText } from "./helpers/tool-text";

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true, cwd: process.cwd() });
}, 15_000);

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

function renderCompletedMCPTool(isError: boolean): string {
	const tool = new MCPTool(makeConnection(), makeDefinition());
	return toolText({
		name: tool.name,
		args: { query: "level:error" },
		result: {
			content: [{ type: "text", text: isError ? "Error: denied" : '{"ok":true}' }],
			details: { serverName: "sentry", mcpToolName: "search_events", isError },
			...(isError ? { isError: true } : {}),
		},
		width: 160,
	});
}

const pendingIcon = () => currentTheme().symbols.symbol("status.pending");

describe("MCP tool rendering", () => {
	it("heads a completed call with the server tool that answered", () => {
		const rendered = renderCompletedMCPTool(false);
		expect(rendered).toContain(`${currentTheme().symbols.symbol("tool.mcp")} sentry/search_events`);
		expect(rendered).toContain("ok: true");
	});

	it("heads a failed call with the error status and the server's message", () => {
		const rendered = renderCompletedMCPTool(true);
		expect(rendered).toContain(`${currentTheme().symbols.symbol("status.error")} sentry/search_events`);
		expect(rendered).toContain("Error: denied");
	});

	it("replaces the pending call header after completion", () => {
		expect(new MCPTool(makeConnection(), makeDefinition()).mergeCallAndResult).toBe(true);
		expect(renderCompletedMCPTool(false)).not.toContain(pendingIcon());
		expect(renderCompletedMCPTool(true)).not.toContain(pendingIcon());
	});

	it("strips the spill notice from the body and surfaces the artifact link once", () => {
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
		const rendered = toolText({
			name: "mcp__evk_peek",
			args: {},
			result: {
				content: [{ type: "text", text: body + formatOutputNotice(meta) }],
				details: { serverName: "evk", mcpToolName: "peek", meta },
			},
			expanded: true,
			width: 160,
		});

		expect(rendered).toContain("event 97");
		expect(rendered).toContain("event 100");
		expect(rendered).toContain("local://7.log");
		// The link appears exactly once, proving the inline notice was not echoed twice.
		expect(rendered.split("local://7.log").length - 1).toBe(1);
	});
});
