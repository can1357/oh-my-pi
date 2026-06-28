import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ThinkingLevel } from "@pk-nerdsaver-ai/pi-agent-core";
import { AuthStorage, Effort, type Model } from "@pk-nerdsaver-ai/pi-ai";
import { buildModel } from "@pk-nerdsaver-ai/pi-catalog/build";
import { getBundledModel } from "@pk-nerdsaver-ai/pi-catalog/models";
import { ModelRegistry } from "@pk-nerdsaver-ai/pi-coding-agent/config/model-registry";
import { Settings } from "@pk-nerdsaver-ai/pi-coding-agent/config/settings";
import type { CustomTool } from "@pk-nerdsaver-ai/pi-coding-agent/extensibility/custom-tools/types";
import { createAgentSession } from "@pk-nerdsaver-ai/pi-coding-agent/sdk";
import { SessionManager } from "@pk-nerdsaver-ai/pi-coding-agent/session/session-manager";
import { TOOL_DISCOVERY_AUTO_THRESHOLD } from "@pk-nerdsaver-ai/pi-coding-agent/tool-discovery/mode";
import { removeSyncWithRetries, Snowflake } from "@pk-nerdsaver-ai/pi-utils";
import { type } from "arktype";

function createMcpCustomTool(name: string, serverName: string, mcpToolName: string): CustomTool {
	return {
		name,
		label: `${serverName}/${mcpToolName}`,
		description: `Tool ${mcpToolName} from ${serverName}`,
		mcpServerName: serverName,
		mcpToolName,
		parameters: type({ query: "string" }),
		async execute() {
			return { content: [{ type: "text", text: `${name} executed` }] };
		},
	} as CustomTool;
}

function createReasoningModel(): Model<"openai-responses"> {
	return buildModel({
		id: "mock-reasoning",
		name: "mock-reasoning",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://example.invalid",
		reasoning: true,
		thinking: { mode: "effort", efforts: [Effort.Medium, Effort.High] },
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 2048,
	});
}

const oldSessionMtime = new Date("2000-01-01T00:00:00.000Z");

describe("createAgentSession MCP discovery prompt gating", () => {
	let tempDir: string;
	let registryDir: string;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;

	// Immutable across tests: ModelRegistry's constructor eagerly loads the bundled
	// model catalog (~120ms). The tests pass models explicitly and never mutate the
	// registry (refreshInBackground is skipped when modelRegistry is supplied, and
	// extension source sync is empty under disableExtensionDiscovery), so build it once.
	beforeAll(async () => {
		registryDir = path.join(os.tmpdir(), `pi-sdk-mcp-discovery-registry-${Snowflake.next()}`);
		fs.mkdirSync(registryDir, { recursive: true });
		authStorage = await AuthStorage.create(path.join(registryDir, "auth.db"));
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterAll(() => {
		authStorage.close();
		if (registryDir && fs.existsSync(registryDir)) {
			removeSyncWithRetries(registryDir);
		}
	});

	beforeEach(() => {
		tempDir = path.join(os.tmpdir(), `pi-sdk-mcp-discovery-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
	});

	afterEach(() => {
		if (tempDir && fs.existsSync(tempDir)) {
			removeSyncWithRetries(tempDir);
		}
	});

	it("does not advertise MCP discovery when search_tool_bm25 is not active", async () => {
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			modelRegistry,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "mcp.discoveryMode": true }),
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			toolNames: ["read"],
			customTools: [createMcpCustomTool("mcp__github_create_issue", "github", "create_issue")],
		});

		expect(session.systemPrompt.join("\n")).not.toContain("### MCP tool discovery");
		expect(session.systemPrompt.join("\n")).not.toContain(
			"call `search_tool_bm25` before concluding no such tool exists",
		);
	});

	it("default auto discovery hides MCP tools once the total tool set is too large", async () => {
		const mcpTools = Array.from({ length: TOOL_DISCOVERY_AUTO_THRESHOLD + 1 }, (_, index) =>
			createMcpCustomTool(`mcp__auto_tool_${index}`, "auto", `tool_${index}`),
		);
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			modelRegistry,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({}),
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			customTools: mcpTools,
		});

		const activeNames = session.getActiveToolNames();
		expect(session.isToolDiscoveryEnabled()).toBe(true);
		expect(activeNames).toContain("search_tool_bm25");
		expect(activeNames).not.toContain("mcp__auto_tool_0");
		expect(session.getDiscoverableTools({ source: "mcp" })).toHaveLength(TOOL_DISCOVERY_AUTO_THRESHOLD + 1);
	});

	it("advertises discovery guidance for builtin-only tools.discoveryMode all sessions", async () => {
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			modelRegistry,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "tools.discoveryMode": "all" }),
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
		});

		const prompt = session.systemPrompt.join("\n");
		const searchTool = session.agent.state.tools.find(tool => tool.name === "search_tool_bm25");
		expect(session.getActiveToolNames()).not.toContain("search");
		expect(prompt).toContain("call `search_tool_bm25` before concluding no such tool exists");
		expect(searchTool?.description).toContain("Total discoverable tools available:");
	});

	it("exposes task under tools.discoveryMode all when task.eager is preferred", async () => {
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			modelRegistry,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "tools.discoveryMode": "all", "task.eager": "preferred" }),
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
		});

		expect(session.getActiveToolNames()).toContain("task");
		await session.dispose();
	});

	it("hides task under tools.discoveryMode all when task.eager is default", async () => {
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			modelRegistry,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "tools.discoveryMode": "all" }),
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
		});

		expect(session.getActiveToolNames()).not.toContain("task");
		await session.dispose();
	});

	it("preserves explicitly requested MCP tools in discovery mode", async () => {
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			modelRegistry,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "mcp.discoveryMode": true }),
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			toolNames: ["read", "mcp__github_create_issue", "search_tool_bm25"],
			customTools: [
				createMcpCustomTool("mcp__github_create_issue", "github", "create_issue"),
				createMcpCustomTool("mcp__slack_post_message", "slack", "post_message"),
			],
		});

		expect(session.getActiveToolNames()).toContain("mcp__github_create_issue");
		expect(session.getSelectedMCPToolNames()).toEqual(["mcp__github_create_issue"]);
		expect(session.systemPrompt.join("\n")).toContain("mcp__github_create_issue");

		await session.activateDiscoveredMCPTools(["mcp__slack_post_message"]);

		expect(session.getActiveToolNames()).toEqual(
			expect.arrayContaining(["read", "search_tool_bm25", "mcp__github_create_issue", "mcp__slack_post_message"]),
		);
		expect(session.getSelectedMCPToolNames()).toEqual(["mcp__github_create_issue", "mcp__slack_post_message"]);
	});

	it("keeps configured discovery default servers visible in discovery mode", async () => {
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			modelRegistry,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({
				"mcp.discoveryMode": true,
				"mcp.discoveryDefaultServers": ["github", "missing"],
			}),
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			toolNames: ["read", "search_tool_bm25"],
			customTools: [
				createMcpCustomTool("mcp__github_create_issue", "github", "create_issue"),
				createMcpCustomTool("mcp__slack_post_message", "slack", "post_message"),
			],
		});
		try {
			expect(session.getSelectedMCPToolNames()).toEqual(["mcp__github_create_issue"]);
			expect(session.getActiveToolNames()).toEqual(
				expect.arrayContaining(["read", "search_tool_bm25", "mcp__github_create_issue"]),
			);
			expect(session.getActiveToolNames()).not.toContain("mcp__slack_post_message");
		} finally {
			await session.dispose();
		}
	});

	it("builds search_tool_bm25 descriptions from the loaded MCP catalog", async () => {
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			modelRegistry,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "mcp.discoveryMode": true }),
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			toolNames: ["read", "search_tool_bm25"],
			customTools: [createMcpCustomTool("mcp__github_create_issue", "github", "create_issue")],
		});

		const searchTool = session.agent.state.tools.find(tool => tool.name === "search_tool_bm25");
		expect(searchTool?.description).toContain("Total discoverable tools available: 1.");
		expect(searchTool?.description).toContain("Discoverable MCP servers in this session: github (1 tool).");
	});

	it("prunes deactivated builtin discoveries so they can be rediscovered", async () => {
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			modelRegistry,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "tools.discoveryMode": "all" }),
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
		});

		expect(await session.activateDiscoveredTools(["grep"])).toEqual(["grep"]);
		expect(session.getSelectedDiscoveredToolNames()).toContain("grep");

		await session.setActiveToolsByName(["read", "search_tool_bm25"]);

		expect(session.getActiveToolNames()).not.toContain("grep");
		expect(session.getSelectedDiscoveredToolNames()).not.toContain("grep");
		expect(await session.activateDiscoveredTools(["grep"])).toEqual(["grep"]);
		expect(session.getActiveToolNames()).toContain("grep");
	});
	it("restores explicit MCP, thinking, and service-tier entries when resuming without rewriting the session file", async () => {
		const firstManager = SessionManager.create(tempDir, tempDir);
		const { session: firstSession } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			modelRegistry,
			sessionManager: firstManager,
			settings: Settings.isolated({
				"mcp.discoveryMode": true,
				defaultThinkingLevel: "high",
				serviceTier: "priority",
			}),
			model: createReasoningModel(),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			toolNames: ["read", "search_tool_bm25"],
			customTools: [
				createMcpCustomTool("mcp__github_create_issue", "github", "create_issue"),
				createMcpCustomTool("mcp__slack_post_message", "slack", "post_message"),
			],
		});
		await firstSession.activateDiscoveredMCPTools(["mcp__slack_post_message"]);
		firstSession.sessionManager.appendThinkingLevelChange(ThinkingLevel.Off);
		firstSession.sessionManager.appendServiceTierChange("priority");
		expect(firstSession.sessionManager.buildSessionContext().thinkingLevel).toBe(ThinkingLevel.Off);
		expect(firstSession.getSelectedMCPToolNames()).toEqual(["mcp__slack_post_message"]);
		const sessionFile = firstSession.sessionFile;
		expect(sessionFile).toBeDefined();
		await firstSession.sessionManager.rewriteEntries();
		fs.utimesSync(sessionFile!, oldSessionMtime, oldSessionMtime);
		const persistedBeforeResume = fs.readFileSync(sessionFile!, "utf8");
		const persistedMtimeBeforeResume = fs.statSync(sessionFile!).mtimeMs;
		await firstSession.dispose();
		const resumedManager = await SessionManager.open(sessionFile!, tempDir);
		const { session: resumedSession } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			modelRegistry,
			sessionManager: resumedManager,
			settings: Settings.isolated({
				"mcp.discoveryMode": true,
				defaultThinkingLevel: "high",
				serviceTier: "none",
			}),
			model: createReasoningModel(),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			toolNames: ["read", "search_tool_bm25"],
			customTools: [
				createMcpCustomTool("mcp__github_create_issue", "github", "create_issue"),
				createMcpCustomTool("mcp__slack_post_message", "slack", "post_message"),
			],
		});
		try {
			expect(resumedSession.thinkingLevel).toBe(ThinkingLevel.Off);
			expect(resumedSession.serviceTier).toBe("priority");
			expect(resumedSession.getSelectedMCPToolNames()).toEqual(["mcp__slack_post_message"]);
			expect(resumedSession.getActiveToolNames()).toEqual(
				expect.arrayContaining(["read", "search_tool_bm25", "mcp__slack_post_message"]),
			);
			expect(resumedSession.systemPrompt.join("\n")).toContain("mcp__slack_post_message");
			expect(fs.readFileSync(sessionFile!, "utf8")).toBe(persistedBeforeResume);
			expect(fs.statSync(sessionFile!).mtimeMs).toBe(persistedMtimeBeforeResume);
		} finally {
			await resumedSession.dispose();
		}
	});

	it("restores fallback MCP, thinking, and service-tier state in memory without rewriting the session file", async () => {
		const sessionManager = SessionManager.create(tempDir, tempDir);
		sessionManager.appendMessage({
			role: "user",
			content: "resume me",
			timestamp: Date.now(),
		});
		const sessionFile = sessionManager.getSessionFile();
		expect(sessionFile).toBeDefined();
		await sessionManager.rewriteEntries();
		fs.utimesSync(sessionFile!, oldSessionMtime, oldSessionMtime);
		const persistedBeforeResume = fs.readFileSync(sessionFile!, "utf8");
		const persistedMtimeBeforeResume = fs.statSync(sessionFile!).mtimeMs;
		const resumedManager = await SessionManager.open(sessionFile!, tempDir);
		const { session } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			modelRegistry,
			sessionManager: resumedManager,
			settings: Settings.isolated({
				"mcp.discoveryMode": true,
				"mcp.discoveryDefaultServers": ["github"],
				defaultThinkingLevel: "high",
				serviceTier: "priority",
			}),
			model: createReasoningModel(),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			toolNames: ["read", "search_tool_bm25"],
			customTools: [
				createMcpCustomTool("mcp__github_create_issue", "github", "create_issue"),
				createMcpCustomTool("mcp__slack_post_message", "slack", "post_message"),
			],
		});
		try {
			expect(session.thinkingLevel).toBe(ThinkingLevel.High);
			expect(session.serviceTier).toBe("priority");
			expect(session.getSelectedMCPToolNames()).toEqual(["mcp__github_create_issue"]);
			expect(session.getActiveToolNames()).toEqual(
				expect.arrayContaining(["read", "search_tool_bm25", "mcp__github_create_issue"]),
			);
			expect(session.sessionManager.buildSessionContext().hasPersistedMCPToolSelection).toBe(false);
			expect(fs.readFileSync(sessionFile!, "utf8")).toBe(persistedBeforeResume);
			expect(fs.statSync(sessionFile!).mtimeMs).toBe(persistedMtimeBeforeResume);
		} finally {
			await session.dispose();
		}
	});

	it("keeps a cleared MCP selection empty when resuming with explicitly requested MCP tools", async () => {
		const firstManager = SessionManager.create(tempDir, tempDir);
		const { session: firstSession } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			modelRegistry,
			sessionManager: firstManager,
			settings: Settings.isolated({ "mcp.discoveryMode": true }),
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			toolNames: ["read", "search_tool_bm25", "mcp__github_create_issue"],
			customTools: [
				createMcpCustomTool("mcp__github_create_issue", "github", "create_issue"),
				createMcpCustomTool("mcp__slack_post_message", "slack", "post_message"),
			],
		});
		await firstSession.setActiveToolsByName(["read", "search_tool_bm25"]);
		expect(firstSession.getSelectedMCPToolNames()).toEqual([]);
		const sessionFile = firstSession.sessionFile;
		expect(sessionFile).toBeDefined();
		await firstSession.sessionManager.rewriteEntries();
		await firstSession.dispose();

		const resumedManager = await SessionManager.open(sessionFile!, tempDir);
		const { session: resumedSession } = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			modelRegistry,
			sessionManager: resumedManager,
			settings: Settings.isolated({ "mcp.discoveryMode": true }),
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			toolNames: ["read", "search_tool_bm25", "mcp__github_create_issue"],
			customTools: [
				createMcpCustomTool("mcp__github_create_issue", "github", "create_issue"),
				createMcpCustomTool("mcp__slack_post_message", "slack", "post_message"),
			],
		});
		try {
			expect(resumedSession.getSelectedMCPToolNames()).toEqual([]);
			expect(resumedSession.getActiveToolNames()).toEqual(expect.arrayContaining(["read", "search_tool_bm25"]));
			expect(resumedSession.getActiveToolNames()).not.toContain("mcp__github_create_issue");
		} finally {
			await resumedSession.dispose();
		}
	});
});
