import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	Agent,
	type AgentTool,
	type AgentToolContext,
	type AgentToolResult,
	ThinkingLevel,
} from "@pk-nerdsaver-ai/pi-agent-core";
import { Effort, type Model } from "@pk-nerdsaver-ai/pi-ai";
import { buildModel } from "@pk-nerdsaver-ai/pi-catalog/build";
import { Settings } from "@pk-nerdsaver-ai/pi-coding-agent/config/settings";
import type { CustomTool } from "@pk-nerdsaver-ai/pi-coding-agent/extensibility/custom-tools/types";
import { AgentSession } from "@pk-nerdsaver-ai/pi-coding-agent/session/agent-session";
import { SessionManager } from "@pk-nerdsaver-ai/pi-coding-agent/session/session-manager";
import type { OutputMeta } from "@pk-nerdsaver-ai/pi-coding-agent/tools/output-meta";
import { removeSyncWithRetries } from "@pk-nerdsaver-ai/pi-utils";
import { type } from "arktype";

function createModel(): Model<"openai-responses"> {
	return buildModel({
		id: "mock",
		name: "mock",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 2048,
	});
}

function createBasicTool(name: string, label: string): AgentTool {
	const schema = type({ value: "string" });
	return {
		name,
		label,
		description: `${label} tool`,
		parameters: schema,
		strict: true,
		async execute() {
			return { content: [{ type: "text", text: `${name} executed` }] };
		},
	};
}

function createMcpTool(
	name: string,
	serverName: string,
	mcpToolName: string,
	description: string,
	schemaKeys: string[],
): AgentTool {
	const properties: Record<string, unknown> = {};
	for (const key of schemaKeys) {
		properties[key] = "string";
	}
	return {
		name,
		label: `${serverName}/${mcpToolName}`,
		description,
		parameters: type(properties),
		strict: true,
		mcpServerName: serverName,
		mcpToolName,
		async execute() {
			return { content: [{ type: "text", text: `${name} executed` }] };
		},
	} as AgentTool;
}

function createMcpCustomTool(
	name: string,
	serverName: string,
	mcpToolName: string,
	description: string,
	schemaKeys: string[],
): CustomTool {
	const properties: Record<string, unknown> = {};
	for (const key of schemaKeys) {
		properties[key] = "string";
	}
	return {
		name,
		label: `${serverName}/${mcpToolName}`,
		description,
		parameters: type(properties),
		mcpServerName: serverName,
		mcpToolName,
		async execute() {
			return { content: [{ type: "text", text: `${name} executed` }] };
		},
	} as CustomTool;
}

/** MCP custom tool whose execute returns a fixed (large) text payload. */
function createOversizedMcpTool(name: string, serverName: string, mcpToolName: string, text: string): CustomTool {
	return {
		name,
		label: `${serverName}/${mcpToolName}`,
		description: `${mcpToolName} dump`,
		parameters: type("object"),
		mcpServerName: serverName,
		mcpToolName,
		async execute() {
			return { content: [{ type: "text", text }] };
		},
	} as CustomTool;
}

/**
 * Execute-time context with tiny spill thresholds so a few KB of output trips
 * the artifact spill deterministically. The spill reads `context.settings`, not
 * the session's settings, so the budget lives here.
 */
function createSpillContext(sessionManager: SessionManager = SessionManager.inMemory()): AgentToolContext {
	return {
		sessionManager,
		settings: Settings.isolated({
			"tools.artifactSpillThreshold": 1,
			"tools.artifactHeadBytes": 1,
			"tools.artifactTailBytes": 1,
			"tools.artifactTailLines": 5,
		}),
		modelRegistry: {} as never,
		model: undefined,
		isIdle: () => true,
		hasQueuedMessages: () => false,
		abort: () => {},
	} as unknown as AgentToolContext;
}

function textOf(result: AgentToolResult): string {
	return result.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map(c => c.text)
		.join("\n");
}

describe("AgentSession MCP discovery", () => {
	const sessions: AgentSession[] = [];
	const tempDirs: string[] = [];

	afterEach(async () => {
		for (const session of sessions.splice(0)) {
			await session.dispose();
		}
		for (const tempDir of tempDirs.splice(0)) {
			removeSyncWithRetries(tempDir);
		}
	});

	it("caches discoverable MCP search indexes until MCP tools refresh", async () => {
		const readTool = createBasicTool("read", "Read");
		const docsSearchTool = createMcpTool("mcp__docs_search", "docs", "search", "Search internal docs", ["query"]);
		const toolRegistry = new Map([
			[readTool.name, readTool],
			[docsSearchTool.name, docsSearchTool],
		]);
		const agent = new Agent({
			initialState: {
				model: createModel(),
				systemPrompt: ["initial"],
				tools: [readTool],
				messages: [],
			},
		});
		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "mcp.discoveryMode": true }),
			modelRegistry: {} as never,
			toolRegistry,
			mcpDiscoveryEnabled: true,
			rebuildSystemPrompt: async toolNames => ({
				systemPrompt: [`tools:${toolNames.join(",")}`],
			}),
		});
		sessions.push(session);

		const firstIndex = session.getDiscoverableToolSearchIndex();
		const secondIndex = session.getDiscoverableToolSearchIndex();
		expect(secondIndex).toBe(firstIndex);
		expect(firstIndex.documents.map(document => document.tool.name)).toEqual(["mcp__docs_search"]);

		await session.refreshMCPTools([
			createMcpCustomTool("mcp__pager_list", "pager", "list", "List pager alerts", ["service"]),
		]);

		const refreshedIndex = session.getDiscoverableToolSearchIndex();
		expect(refreshedIndex).not.toBe(firstIndex);
		expect(refreshedIndex.documents.map(document => document.tool.name)).toEqual(["mcp__pager_list"]);
	});

	it("reports only currently active MCP tools in non-discovery sessions", async () => {
		const readTool = createBasicTool("read", "Read");
		const docsSearchTool = createMcpTool("mcp__docs_search", "docs", "search", "Search internal docs", ["query"]);
		const slackSendTool = createMcpTool("mcp__slack_send_message", "slack", "send_message", "Send a Slack message", [
			"channel",
			"text",
		]);
		const toolRegistry = new Map([
			[readTool.name, readTool],
			[docsSearchTool.name, docsSearchTool],
			[slackSendTool.name, slackSendTool],
		]);
		const agent = new Agent({
			initialState: {
				model: createModel(),
				systemPrompt: ["initial"],
				tools: [readTool, docsSearchTool],
				messages: [],
			},
		});
		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "mcp.discoveryMode": false }),
			modelRegistry: {} as never,
			toolRegistry,
			mcpDiscoveryEnabled: false,
			rebuildSystemPrompt: async toolNames => ({
				systemPrompt: [`tools:${toolNames.join(",")}`],
			}),
		});
		sessions.push(session);

		expect(session.getSelectedMCPToolNames()).toEqual(["mcp__docs_search"]);

		await session.setActiveToolsByName(["read"]);

		expect(session.getSelectedMCPToolNames()).toEqual([]);
		expect(session.getActiveToolNames()).toEqual(["read"]);
		expect(session.systemPrompt).toEqual(["tools:read"]);
	});

	it("keeps manually deactivated MCP tools off after refresh in non-discovery sessions", async () => {
		const readTool = createBasicTool("read", "Read");
		const docsSearchTool = createMcpTool("mcp__docs_search", "docs", "search", "Search internal docs", ["query"]);
		const slackSendTool = createMcpTool("mcp__slack_send_message", "slack", "send_message", "Send a Slack message", [
			"channel",
			"text",
		]);
		const toolRegistry = new Map([
			[readTool.name, readTool],
			[docsSearchTool.name, docsSearchTool],
			[slackSendTool.name, slackSendTool],
		]);
		const agent = new Agent({
			initialState: {
				model: createModel(),
				systemPrompt: ["initial"],
				tools: [readTool, docsSearchTool],
				messages: [],
			},
		});
		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "mcp.discoveryMode": false }),
			modelRegistry: {} as never,
			toolRegistry,
			mcpDiscoveryEnabled: false,
			rebuildSystemPrompt: async toolNames => ({
				systemPrompt: [`tools:${toolNames.join(",")}`],
			}),
		});
		sessions.push(session);

		await session.setActiveToolsByName(["read"]);
		expect(session.getSelectedMCPToolNames()).toEqual([]);

		await session.refreshMCPTools([
			createMcpCustomTool("mcp__docs_search", "docs", "search", "Search internal docs", ["query"]),
			createMcpCustomTool("mcp__slack_send_message", "slack", "send_message", "Send a Slack message", [
				"channel",
				"text",
			]),
		]);

		expect(session.getSelectedMCPToolNames()).toEqual([]);
		expect(session.getActiveToolNames()).toEqual(["read"]);
		expect(session.systemPrompt).toEqual(["tools:read"]);
	});

	it("activates all new MCP tools when activateAll is true, even with discovery off", async () => {
		const readTool = createBasicTool("read", "Read");
		const toolRegistry = new Map([[readTool.name, readTool]]);
		const agent = new Agent({
			initialState: {
				model: createModel(),
				systemPrompt: ["initial"],
				tools: [readTool],
				messages: [],
			},
		});
		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "mcp.discoveryMode": false }),
			modelRegistry: {} as never,
			toolRegistry,
			mcpDiscoveryEnabled: false,
			rebuildSystemPrompt: async toolNames => ({
				systemPrompt: [`tools:${toolNames.join(",")}`],
			}),
		});
		sessions.push(session);

		// Start with only non-MCP tools active — no MCP tools in registry.
		expect(session.getActiveToolNames()).toEqual(["read"]);
		expect(session.getSelectedMCPToolNames()).toEqual([]);

		// Load MCP tools via activateAll path (simulating ACP client provisioning).
		await session.refreshMCPTools(
			[
				createMcpCustomTool("mcp__docs_search", "docs", "search", "Search internal docs", ["query"]),
				createMcpCustomTool("mcp__slack_send_message", "slack", "send_message", "Send a Slack message", [
					"channel",
					"text",
				]),
			],
			{ activateAll: true },
		);

		expect(session.getSelectedMCPToolNames()).toEqual(["mcp__docs_search", "mcp__slack_send_message"]);
		expect(session.getActiveToolNames()).toEqual(["read", "mcp__docs_search", "mcp__slack_send_message"]);
		expect(session.systemPrompt).toEqual(["tools:read,mcp__docs_search,mcp__slack_send_message"]);
	});

	it("preserves directly activated MCP tools across refreshes in discovery mode", async () => {
		const readTool = createBasicTool("read", "Read");
		const docsSearchTool = createMcpTool("mcp__docs_search", "docs", "search", "Search internal docs", ["query"]);
		const slackSendTool = createMcpTool("mcp__slack_send_message", "slack", "send_message", "Send a Slack message", [
			"channel",
			"text",
		]);
		const toolRegistry = new Map([
			[readTool.name, readTool],
			[docsSearchTool.name, docsSearchTool],
			[slackSendTool.name, slackSendTool],
		]);
		const agent = new Agent({
			initialState: {
				model: createModel(),
				systemPrompt: ["initial"],
				tools: [readTool],
				messages: [],
			},
		});
		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "mcp.discoveryMode": true }),
			modelRegistry: {} as never,
			toolRegistry,
			mcpDiscoveryEnabled: true,
			rebuildSystemPrompt: async toolNames => ({
				systemPrompt: [`tools:${toolNames.join(",")}`],
			}),
		});
		sessions.push(session);

		await session.setActiveToolsByName(["read", "mcp__docs_search"]);
		expect(session.getSelectedMCPToolNames()).toEqual(["mcp__docs_search"]);
		expect(session.getActiveToolNames()).toEqual(["read", "mcp__docs_search"]);

		await session.refreshMCPTools([
			createMcpCustomTool("mcp__docs_search", "docs", "search", "Search internal docs", ["query"]),
			createMcpCustomTool("mcp__slack_send_message", "slack", "send_message", "Send a Slack message", [
				"channel",
				"text",
			]),
		]);
		expect(session.getSelectedMCPToolNames()).toEqual(["mcp__docs_search"]);
		expect(session.getActiveToolNames()).toEqual(["read", "mcp__docs_search"]);
	});

	it("keeps MCP tools hidden by default and activates discovered selections additively", async () => {
		const readTool = createBasicTool("read", "Read");
		const docsSearchTool = createMcpTool("mcp__docs_search", "docs", "search", "Search internal docs", ["query"]);
		const slackSendTool = createMcpTool("mcp__slack_send_message", "slack", "send_message", "Send a Slack message", [
			"channel",
			"text",
		]);
		const toolRegistry = new Map([
			[readTool.name, readTool],
			[docsSearchTool.name, docsSearchTool],
			[slackSendTool.name, slackSendTool],
		]);
		const agent = new Agent({
			initialState: {
				model: createModel(),
				systemPrompt: ["initial"],
				tools: [readTool],
				messages: [],
			},
		});
		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "mcp.discoveryMode": true }),
			modelRegistry: {} as never,
			toolRegistry,
			mcpDiscoveryEnabled: true,
			rebuildSystemPrompt: async toolNames => ({
				systemPrompt: [`tools:${toolNames.join(",")}`],
			}),
		});
		sessions.push(session);

		expect(session.getActiveToolNames()).toEqual(["read"]);
		expect(session.getDiscoverableTools({ source: "mcp" }).map(tool => tool.name)).toEqual([
			"mcp__docs_search",
			"mcp__slack_send_message",
		]);

		await session.activateDiscoveredMCPTools(["mcp__docs_search"]);
		expect(session.getSelectedMCPToolNames()).toEqual(["mcp__docs_search"]);
		expect(session.getActiveToolNames()).toEqual(["read", "mcp__docs_search"]);
		expect(session.systemPrompt).toEqual(["tools:read,mcp__docs_search"]);

		await session.activateDiscoveredMCPTools(["mcp__slack_send_message"]);
		expect(session.getSelectedMCPToolNames()).toEqual(["mcp__docs_search", "mcp__slack_send_message"]);
		expect(session.getActiveToolNames()).toEqual(["read", "mcp__docs_search", "mcp__slack_send_message"]);
		expect(session.systemPrompt).toEqual(["tools:read,mcp__docs_search,mcp__slack_send_message"]);
	});
	it("reapplies default MCP server baselines when refreshed tools reconnect", async () => {
		const readTool = createBasicTool("read", "Read");
		const docsSearchTool = createMcpTool("mcp__docs_search", "docs", "search", "Search internal docs", ["query"]);
		const toolRegistry = new Map([
			[readTool.name, readTool],
			[docsSearchTool.name, docsSearchTool],
		]);
		const sessionManager = SessionManager.inMemory();
		const agent = new Agent({
			initialState: {
				model: createModel(),
				systemPrompt: ["initial"],
				tools: [readTool],
				messages: [],
			},
		});
		const session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "mcp.discoveryMode": true }),
			modelRegistry: {} as never,
			toolRegistry,
			mcpDiscoveryEnabled: true,
			defaultSelectedMCPServerNames: ["slack"],
			rebuildSystemPrompt: async toolNames => ({
				systemPrompt: [`tools:${toolNames.join(",")}`],
			}),
		});
		sessions.push(session);

		expect(session.getSelectedMCPToolNames()).toEqual([]);
		expect(session.getActiveToolNames()).toEqual(["read"]);

		await session.refreshMCPTools([
			createMcpCustomTool("mcp__docs_search", "docs", "search", "Search internal docs", ["query"]),
			createMcpCustomTool("mcp__slack_send_message", "slack", "send_message", "Send a Slack message", [
				"channel",
				"text",
			]),
		]);

		expect(session.getSelectedMCPToolNames()).toEqual(["mcp__slack_send_message"]);
		expect(session.getActiveToolNames()).toEqual(["read", "mcp__slack_send_message"]);
		expect(session.systemPrompt).toEqual(["tools:read,mcp__slack_send_message"]);
		expect(sessionManager.buildSessionContext().selectedMCPToolNames).toEqual(["mcp__slack_send_message"]);
	});

	it("persists cleared MCP selections when refresh removes a selected tool", async () => {
		const readTool = createBasicTool("read", "Read");
		const docsSearchTool = createMcpTool("mcp__docs_search", "docs", "search", "Search internal docs", ["query"]);
		const toolRegistry = new Map([
			[readTool.name, readTool],
			[docsSearchTool.name, docsSearchTool],
		]);
		const sessionManager = SessionManager.inMemory();
		const agent = new Agent({
			initialState: {
				model: createModel(),
				systemPrompt: ["initial"],
				tools: [readTool],
				messages: [],
			},
		});
		const session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "mcp.discoveryMode": true }),
			modelRegistry: {} as never,
			toolRegistry,
			mcpDiscoveryEnabled: true,
			rebuildSystemPrompt: async toolNames => ({
				systemPrompt: [`tools:${toolNames.join(",")}`],
			}),
		});
		sessions.push(session);

		await session.activateDiscoveredMCPTools(["mcp__docs_search"]);
		expect(sessionManager.buildSessionContext().selectedMCPToolNames).toEqual(["mcp__docs_search"]);

		await session.refreshMCPTools([]);

		expect(session.getSelectedMCPToolNames()).toEqual([]);
		expect(session.getActiveToolNames()).toEqual(["read"]);
		expect(sessionManager.buildSessionContext().selectedMCPToolNames).toEqual([]);
	});

	it("restores unavailable MCP selections in memory without rewriting the persisted session selection", async () => {
		const readTool = createBasicTool("read", "Read");
		const sessionManager = SessionManager.inMemory();
		sessionManager.appendMCPToolSelection(["mcp__docs_search"]);
		const agent = new Agent({
			initialState: {
				model: createModel(),
				systemPrompt: ["initial"],
				tools: [readTool],
				messages: [],
			},
		});
		const session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "mcp.discoveryMode": true }),
			modelRegistry: {} as never,
			toolRegistry: new Map([[readTool.name, readTool]]),
			mcpDiscoveryEnabled: true,
			rebuildSystemPrompt: async toolNames => ({
				systemPrompt: [`tools:${toolNames.join(",")}`],
			}),
		});
		sessions.push(session);

		expect(session.getSelectedMCPToolNames()).toEqual([]);
		expect(sessionManager.buildSessionContext().selectedMCPToolNames).toEqual(["mcp__docs_search"]);
	});

	it("restores MCP discovery selections when branching to a context without them", async () => {
		const readTool = createBasicTool("read", "Read");
		const docsSearchTool = createMcpTool("mcp__docs_search", "docs", "search", "Search internal docs", ["query"]);
		const sessionManager = SessionManager.inMemory();
		const userEntryId = sessionManager.appendMessage({
			role: "user",
			content: "start",
			timestamp: Date.now(),
		});
		const toolRegistry = new Map([
			[readTool.name, readTool],
			[docsSearchTool.name, docsSearchTool],
		]);
		const agent = new Agent({
			initialState: {
				model: createModel(),
				systemPrompt: ["initial"],
				tools: [readTool],
				messages: sessionManager.buildSessionContext().messages,
			},
		});
		const session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "mcp.discoveryMode": true }),
			modelRegistry: {} as never,
			toolRegistry,
			mcpDiscoveryEnabled: true,
			rebuildSystemPrompt: async toolNames => ({
				systemPrompt: [`tools:${toolNames.join(",")}`],
			}),
		});
		sessions.push(session);

		await session.activateDiscoveredMCPTools(["mcp__docs_search"]);
		expect(session.getSelectedMCPToolNames()).toEqual(["mcp__docs_search"]);

		const result = await session.branch(userEntryId);

		expect(result.cancelled).toBe(false);
		expect(session.getSelectedMCPToolNames()).toEqual([]);
		expect(session.getActiveToolNames()).toEqual(["read"]);
		expect(session.systemPrompt).toEqual(["tools:read"]);
	});

	it("restores MCP discovery selections when navigating to a branch without them", async () => {
		const readTool = createBasicTool("read", "Read");
		const docsSearchTool = createMcpTool("mcp__docs_search", "docs", "search", "Search internal docs", ["query"]);
		const sessionManager = SessionManager.inMemory();
		const userEntryId = sessionManager.appendMessage({
			role: "user",
			content: "start",
			timestamp: Date.now(),
		});
		const toolRegistry = new Map([
			[readTool.name, readTool],
			[docsSearchTool.name, docsSearchTool],
		]);
		const agent = new Agent({
			initialState: {
				model: createModel(),
				systemPrompt: ["initial"],
				tools: [readTool],
				messages: sessionManager.buildSessionContext().messages,
			},
		});
		const session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "mcp.discoveryMode": true }),
			modelRegistry: {} as never,
			toolRegistry,
			mcpDiscoveryEnabled: true,
			rebuildSystemPrompt: async toolNames => ({
				systemPrompt: [`tools:${toolNames.join(",")}`],
			}),
		});
		sessions.push(session);

		await session.activateDiscoveredMCPTools(["mcp__docs_search"]);
		expect(session.getSelectedMCPToolNames()).toEqual(["mcp__docs_search"]);

		const result = await session.navigateTree(userEntryId, { summarize: false });

		expect(result.cancelled).toBe(false);
		expect(session.getSelectedMCPToolNames()).toEqual([]);
		expect(session.getActiveToolNames()).toEqual(["read"]);
		expect(session.systemPrompt).toEqual(["tools:read"]);
	});

	it("preserves explicit MCP baseline when branching into older history without persisted selection", async () => {
		const readTool = createBasicTool("read", "Read");
		const docsSearchTool = createMcpTool("mcp__docs_search", "docs", "search", "Search internal docs", ["query"]);
		const sessionManager = SessionManager.inMemory();
		const userEntryId = sessionManager.appendMessage({
			role: "user",
			content: "start",
			timestamp: Date.now(),
		});
		const toolRegistry = new Map([
			[readTool.name, readTool],
			[docsSearchTool.name, docsSearchTool],
		]);
		const agent = new Agent({
			initialState: {
				model: createModel(),
				systemPrompt: ["initial"],
				tools: [readTool, docsSearchTool],
				messages: sessionManager.buildSessionContext().messages,
			},
		});
		const session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "mcp.discoveryMode": true }),
			modelRegistry: {} as never,
			toolRegistry,
			mcpDiscoveryEnabled: true,
			initialSelectedMCPToolNames: ["mcp__docs_search"],
			defaultSelectedMCPToolNames: ["mcp__docs_search"],
			rebuildSystemPrompt: async toolNames => ({
				systemPrompt: [`tools:${toolNames.join(",")}`],
			}),
		});
		sessions.push(session);

		const result = await session.branch(userEntryId);

		expect(result.cancelled).toBe(false);
		expect(session.getSelectedMCPToolNames()).toEqual(["mcp__docs_search"]);
		expect(session.getActiveToolNames()).toEqual(["read", "mcp__docs_search"]);
		expect(session.systemPrompt).toEqual(["tools:read,mcp__docs_search"]);
	});

	it("preserves explicit MCP baseline when navigating into older history without persisted selection", async () => {
		const readTool = createBasicTool("read", "Read");
		const docsSearchTool = createMcpTool("mcp__docs_search", "docs", "search", "Search internal docs", ["query"]);
		const sessionManager = SessionManager.inMemory();
		const userEntryId = sessionManager.appendMessage({
			role: "user",
			content: "start",
			timestamp: Date.now(),
		});
		sessionManager.appendMessage({
			role: "user",
			content: "follow up",
			timestamp: Date.now(),
		});
		const toolRegistry = new Map([
			[readTool.name, readTool],
			[docsSearchTool.name, docsSearchTool],
		]);
		const agent = new Agent({
			initialState: {
				model: createModel(),
				systemPrompt: ["initial"],
				tools: [readTool, docsSearchTool],
				messages: sessionManager.buildSessionContext().messages,
			},
		});
		const session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "mcp.discoveryMode": true }),
			modelRegistry: {} as never,
			toolRegistry,
			mcpDiscoveryEnabled: true,
			initialSelectedMCPToolNames: ["mcp__docs_search"],
			defaultSelectedMCPToolNames: ["mcp__docs_search"],
			rebuildSystemPrompt: async toolNames => ({
				systemPrompt: [`tools:${toolNames.join(",")}`],
			}),
		});
		sessions.push(session);

		const result = await session.navigateTree(userEntryId, { summarize: false });

		expect(result.cancelled).toBe(false);
		expect(session.getSelectedMCPToolNames()).toEqual(["mcp__docs_search"]);
		expect(session.getActiveToolNames()).toEqual(["read", "mcp__docs_search"]);
		expect(session.systemPrompt).toEqual(["tools:read,mcp__docs_search"]);
	});

	it("restores session defaults in memory across session switches without rewriting sessions missing persisted metadata", async () => {
		const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-agent-session-mcp-switch-"));
		tempDirs.push(tempDir);
		const readTool = createBasicTool("read", "Read");
		const docsSearchTool = createMcpTool("mcp__docs_search", "docs", "search", "Search internal docs", ["query"]);
		const toolRegistry = new Map([
			[readTool.name, readTool],
			[docsSearchTool.name, docsSearchTool],
		]);

		const olderSessionManager = SessionManager.create(tempDir, tempDir);
		olderSessionManager.appendMessage({
			role: "user",
			content: "older session",
			timestamp: Date.now(),
		});
		const olderSessionFile = olderSessionManager.getSessionFile();
		expect(olderSessionFile).toBeString();
		await olderSessionManager.rewriteEntries();
		const olderSessionBeforeSwitch = fs.readFileSync(olderSessionFile!, "utf8");
		const olderSessionMtimeBeforeSwitch = fs.statSync(olderSessionFile!).mtimeMs;

		const sessionManager = SessionManager.create(tempDir, tempDir);
		const originalSessionFile = sessionManager.getSessionFile();
		expect(originalSessionFile).toBeString();
		await sessionManager.flush();

		const reasoningModel: Model<"openai-responses"> = {
			...createModel(),
			reasoning: true,
			thinking: { mode: "effort", efforts: [Effort.Medium] },
		};

		const agent = new Agent({
			initialState: {
				model: reasoningModel,
				systemPrompt: ["initial"],
				tools: [readTool, docsSearchTool],
				messages: sessionManager.buildSessionContext().messages,
			},
		});
		const session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({
				"mcp.discoveryMode": true,
				defaultThinkingLevel: "high",
				serviceTier: "priority",
			}),
			modelRegistry: {} as never,
			toolRegistry,
			mcpDiscoveryEnabled: true,
			initialSelectedMCPToolNames: ["mcp__docs_search"],
			defaultSelectedMCPToolNames: ["mcp__docs_search"],
			rebuildSystemPrompt: async toolNames => ({
				systemPrompt: [`tools:${toolNames.join(",")}`],
			}),
		});
		sessions.push(session);

		expect(session.getSelectedMCPToolNames()).toEqual(["mcp__docs_search"]);
		sessionManager.appendThinkingLevelChange(ThinkingLevel.High);
		sessionManager.appendServiceTierChange("flex");
		sessionManager.appendMCPToolSelection(["mcp__docs_search"]);
		expect(sessionManager.buildSessionContext().thinkingLevel).toBe(ThinkingLevel.High);
		expect(sessionManager.buildSessionContext().serviceTier).toBe("flex");
		expect(sessionManager.buildSessionContext().selectedMCPToolNames).toEqual(["mcp__docs_search"]);
		expect(sessionManager.buildSessionContext().hasPersistedMCPToolSelection).toBe(true);
		await sessionManager.rewriteEntries();
		const originalSessionBeforeSwitch = fs.readFileSync(originalSessionFile!, "utf8");
		const originalSessionMtimeBeforeSwitch = fs.statSync(originalSessionFile!).mtimeMs;
		await Bun.sleep(20);

		await session.switchSession(olderSessionFile!);
		expect(session.sessionFile).toBe(olderSessionFile);
		expect(session.thinkingLevel).toBe(ThinkingLevel.Medium);
		expect(session.serviceTier).toBe("priority");
		expect(session.getSelectedMCPToolNames()).toEqual([]);
		expect(session.getActiveToolNames()).toEqual(["read"]);
		expect(session.systemPrompt).toEqual(["tools:read"]);
		expect(fs.readFileSync(olderSessionFile!, "utf8")).toBe(olderSessionBeforeSwitch);
		expect(fs.statSync(olderSessionFile!).mtimeMs).toBe(olderSessionMtimeBeforeSwitch);

		await session.switchSession(originalSessionFile!);
		expect(session.sessionFile).toBe(originalSessionFile);
		expect(session.thinkingLevel).toBe(ThinkingLevel.Medium);
		expect(session.serviceTier).toBe("flex");
		expect(session.getSelectedMCPToolNames()).toEqual(["mcp__docs_search"]);
		expect(session.getActiveToolNames()).toEqual(["read", "mcp__docs_search"]);
		expect(session.systemPrompt).toEqual(["tools:read,mcp__docs_search"]);
		expect(fs.readFileSync(originalSessionFile!, "utf8")).toBe(originalSessionBeforeSwitch);
		expect(fs.statSync(originalSessionFile!).mtimeMs).toBe(originalSessionMtimeBeforeSwitch);
	});

	it("restores explicit MCP defaults after startup outage once tools recover in a new session", async () => {
		const readTool = createBasicTool("read", "Read");
		const docsSearchTool = createMcpTool("mcp__docs_search", "docs", "search", "Search internal docs", ["query"]);
		const toolRegistry = new Map([
			[readTool.name, readTool],
			[docsSearchTool.name, docsSearchTool],
		]);
		const sessionManager = SessionManager.inMemory();
		const agent = new Agent({
			initialState: {
				model: createModel(),
				systemPrompt: ["initial"],
				tools: [readTool, docsSearchTool],
				messages: [],
			},
		});
		const session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "mcp.discoveryMode": true }),
			modelRegistry: {} as never,
			toolRegistry,
			mcpDiscoveryEnabled: true,
			initialSelectedMCPToolNames: ["mcp__docs_search", "mcp__slack_send_message"],
			defaultSelectedMCPToolNames: ["mcp__docs_search", "mcp__slack_send_message"],
			rebuildSystemPrompt: async toolNames => ({
				systemPrompt: [`tools:${toolNames.join(",")}`],
			}),
		});
		sessions.push(session);

		expect(session.getSelectedMCPToolNames()).toEqual(["mcp__docs_search"]);
		expect(session.getActiveToolNames()).toEqual(["read", "mcp__docs_search"]);

		await session.refreshMCPTools([
			createMcpCustomTool("mcp__docs_search", "docs", "search", "Search internal docs", ["query"]),
			createMcpCustomTool("mcp__slack_send_message", "slack", "send_message", "Send a Slack message", [
				"channel",
				"text",
			]),
		]);

		expect(session.getSelectedMCPToolNames()).toEqual(["mcp__docs_search"]);
		expect(session.getActiveToolNames()).toEqual(["read", "mcp__docs_search"]);

		await session.newSession();

		expect(session.getSelectedMCPToolNames()).toEqual(["mcp__docs_search", "mcp__slack_send_message"]);
		expect(session.getActiveToolNames()).toEqual(["read", "mcp__docs_search", "mcp__slack_send_message"]);
		expect(session.systemPrompt).toEqual(["tools:read,mcp__docs_search,mcp__slack_send_message"]);
		expect(sessionManager.buildSessionContext().selectedMCPToolNames).toEqual([
			"mcp__docs_search",
			"mcp__slack_send_message",
		]);
	});

	it("clears discovered MCP selections when starting a brand-new session", async () => {
		const readTool = createBasicTool("read", "Read");
		const docsSearchTool = createMcpTool("mcp__docs_search", "docs", "search", "Search internal docs", ["query"]);
		const slackSendTool = createMcpTool("mcp__slack_send_message", "slack", "send_message", "Send a Slack message", [
			"channel",
			"text",
		]);
		const toolRegistry = new Map([
			[readTool.name, readTool],
			[docsSearchTool.name, docsSearchTool],
			[slackSendTool.name, slackSendTool],
		]);
		const agent = new Agent({
			initialState: {
				model: createModel(),
				systemPrompt: ["initial"],
				tools: [readTool],
				messages: [],
			},
		});
		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "mcp.discoveryMode": true }),
			modelRegistry: {} as never,
			toolRegistry,
			mcpDiscoveryEnabled: true,
			rebuildSystemPrompt: async toolNames => ({
				systemPrompt: [`tools:${toolNames.join(",")}`],
			}),
		});
		sessions.push(session);

		await session.activateDiscoveredMCPTools(["mcp__docs_search"]);
		expect(session.getSelectedMCPToolNames()).toEqual(["mcp__docs_search"]);
		expect(session.getActiveToolNames()).toEqual(["read", "mcp__docs_search"]);

		await session.newSession();

		expect(session.getSelectedMCPToolNames()).toEqual([]);
		expect(session.getActiveToolNames()).toEqual(["read"]);
		expect(session.systemPrompt).toEqual(["tools:read"]);
	});
	// ── Findings #3: discovery index is invalidated on active-tool changes ─────
	it("setActiveToolsByName invalidates the generic discoverable tool search index", async () => {
		const readTool = createBasicTool("read", "Read");
		const docsSearchTool = createMcpTool("mcp__docs_search", "docs", "search", "Search internal docs", ["query"]);
		const toolRegistry = new Map([
			[readTool.name, readTool],
			[docsSearchTool.name, docsSearchTool],
		]);
		const agent = new Agent({
			initialState: { model: createModel(), systemPrompt: ["initial"], tools: [readTool], messages: [] },
		});
		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "mcp.discoveryMode": true }),
			modelRegistry: {} as never,
			toolRegistry,
			mcpDiscoveryEnabled: true,
			rebuildSystemPrompt: async toolNames => ({ systemPrompt: [`tools:${toolNames.join(",")}`] }),
		});
		sessions.push(session);

		// Index built before activation contains the discoverable MCP tool.
		const beforeIndex = session.getDiscoverableToolSearchIndex();
		const beforeNames = beforeIndex.documents.map(d => d.tool.name);
		expect(beforeNames).toContain("mcp__docs_search");

		await session.setActiveToolsByName(["read", "mcp__docs_search"]);

		// After activation the same lookup must return a fresh index that no longer lists the
		// now-active tool. If invalidation regressed, this would still return `beforeIndex`.
		const afterIndex = session.getDiscoverableToolSearchIndex();
		expect(afterIndex).not.toBe(beforeIndex);
		expect(afterIndex.documents.map(d => d.tool.name)).not.toContain("mcp__docs_search");
	});

	// ── Findings #4: built-in discovery is restricted to declared discoverable ─
	it("getDiscoverableTools({source:'builtin'}) excludes hidden and non-declared registry tools", () => {
		const readTool = createBasicTool("read", "Read");
		readTool.loadMode = "essential";
		const findTool = createBasicTool("find", "Find");
		findTool.loadMode = "discoverable";
		findTool.summary = "Find files and directories matching a glob pattern";
		const resolveTool = createBasicTool("resolve", "Resolve"); // hidden — must be excluded
		const customTool = createBasicTool("custom_inactive", "Custom"); // not in metadata — must be excluded
		const toolRegistry = new Map([
			[readTool.name, readTool],
			[findTool.name, findTool],
			[resolveTool.name, resolveTool],
			[customTool.name, customTool],
		]);
		const agent = new Agent({
			initialState: { model: createModel(), systemPrompt: ["initial"], tools: [readTool], messages: [] },
		});
		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "tools.discoveryMode": "all" }),
			modelRegistry: {} as never,
			toolRegistry,
			mcpDiscoveryEnabled: false,
			rebuildSystemPrompt: async toolNames => ({ systemPrompt: [`tools:${toolNames.join(",")}`] }),
		});
		sessions.push(session);

		const builtin = session.getDiscoverableTools({ source: "builtin" });
		const names = builtin.map(t => t.name);
		expect(names).toContain("find"); // declared discoverable AND present in registry
		expect(names).not.toContain("read"); // already active
		expect(names).not.toContain("resolve"); // hidden — no discoverable loadMode
		expect(names).not.toContain("custom_inactive"); // unknown — no discoverable loadMode
	});

	it("spills oversized MCP tool output to an artifact after refreshMCPTools", async () => {
		const readTool = createBasicTool("read", "Read");
		const toolRegistry = new Map([[readTool.name, readTool]]);
		const agent = new Agent({
			initialState: { model: createModel(), systemPrompt: ["initial"], tools: [readTool], messages: [] },
		});
		const sessionManager = SessionManager.inMemory();
		const session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "mcp.discoveryMode": false }),
			modelRegistry: {} as never,
			toolRegistry,
			mcpDiscoveryEnabled: false,
			rebuildSystemPrompt: async toolNames => ({ systemPrompt: [`tools:${toolNames.join(",")}`] }),
		});
		sessions.push(session);

		const big = "data line\n".repeat(500);
		await session.refreshMCPTools([createOversizedMcpTool("mcp__demo_dump", "demo", "dump", big)]);

		const registered = session.getToolByName("mcp__demo_dump");
		expect(registered).toBeDefined();

		const result = await registered!.execute(
			"call-spill",
			{},
			undefined,
			undefined,
			createSpillContext(sessionManager),
		);
		const text = textOf(result);
		expect(Buffer.byteLength(text)).toBeLessThan(Buffer.byteLength(big));
		expect(text).toContain("artifact://");
		expect(result.isError).toBeFalsy();
		const meta = (result.details as { meta?: OutputMeta }).meta;
		expect(meta?.truncation?.artifactId).toBeDefined();
	});

	it("keeps an oversized MCP result successful and truncated when the artifact save fails", async () => {
		const readTool = createBasicTool("read", "Read");
		const toolRegistry = new Map([[readTool.name, readTool]]);
		const agent = new Agent({
			initialState: { model: createModel(), systemPrompt: ["initial"], tools: [readTool], messages: [] },
		});
		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "mcp.discoveryMode": false }),
			modelRegistry: {} as never,
			toolRegistry,
			mcpDiscoveryEnabled: false,
			rebuildSystemPrompt: async toolNames => ({ systemPrompt: [`tools:${toolNames.join(",")}`] }),
		});
		sessions.push(session);

		const big = "data line\n".repeat(500);
		await session.refreshMCPTools([createOversizedMcpTool("mcp__demo_dump", "demo", "dump", big)]);
		const registered = session.getToolByName("mcp__demo_dump");
		expect(registered).toBeDefined();

		// Local in-memory manager whose artifact save throws (e.g. disk full). The
		// spy lives on a throwaway instance, so it never leaks to other tests.
		const failingManager = SessionManager.inMemory();
		vi.spyOn(failingManager, "saveArtifact").mockRejectedValue(new Error("disk full"));
		const context = createSpillContext(failingManager);

		const result = await registered!.execute("call-fail", {}, undefined, undefined, context);
		const text = textOf(result);
		expect(result.isError).toBeFalsy();
		expect(Buffer.byteLength(text)).toBeLessThan(Buffer.byteLength(big));
		expect(text).not.toContain("artifact://");
		const meta = (result.details as { meta?: OutputMeta }).meta;
		expect(meta?.truncation).toBeDefined();
		expect(meta?.truncation?.artifactId).toBeUndefined();
	});
});
