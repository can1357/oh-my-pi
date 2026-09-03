import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { AuthStorage } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { CustomTool } from "@oh-my-pi/pi-coding-agent/extensibility/custom-tools/types";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

// Regression for issue #5305: image-gen is registered as a custom tool, and
// custom tools are force-activated regardless of the `toolNames` filter. Before
// the fix, `generate_image` survived `--no-tools` (an empty `toolNames`), any
// explicit whitelist that omitted it, and had no `generate_image.enabled`
// settings toggle. The SDK must honor the whitelist and the new setting.
describe("generate_image tool gating", () => {
	let registryDir: string;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	const sessions: AgentSession[] = [];

	beforeAll(async () => {
		registryDir = path.join(os.tmpdir(), `pi-generate-image-gating-${Snowflake.next()}`);
		fs.mkdirSync(registryDir, { recursive: true });
		authStorage = await AuthStorage.create(path.join(registryDir, "auth.db"));
		modelRegistry = new ModelRegistry(authStorage, path.join(registryDir, "models.yml"));
	});

	afterEach(async () => {
		for (const session of sessions.splice(0)) await session.dispose().catch(() => {});
	});

	afterAll(() => {
		authStorage.close();
		if (fs.existsSync(registryDir)) removeSyncWithRetries(registryDir);
	});

	function startupShortcuts() {
		// These tests vary only tool registration and activation. Bypass unrelated
		// filesystem discovery and workspace walking on every SDK session startup.
		return {
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			rules: [],
			workspaceTree: {
				rootPath: registryDir,
				rendered: "",
				truncated: false,
				totalLines: 0,
				agentsMdFiles: [],
			},
			enableMCP: false,
			enableLsp: false,
		};
	}

	async function activeToolNames(settings: Settings, toolNames?: string[]): Promise<string[]> {
		const { session } = await createAgentSession({
			...startupShortcuts(),
			cwd: registryDir,
			agentDir: registryDir,
			modelRegistry,
			sessionManager: SessionManager.inMemory(),
			settings,
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			toolNames,
		});
		sessions.push(session);
		return session.getActiveToolNames();
	}

	function customTool(name: string, mcp = false): CustomTool {
		return {
			name,
			label: name,
			description: name,
			parameters: { type: "object", properties: {} },
			...(mcp ? { mcpServerName: "test", mcpToolName: "search" } : {}),
			execute: async () => ({ content: [] }),
		} as CustomTool;
	}

	function specializedToolsPolicy(session: AgentSession): string {
		const rendered = session.systemPrompt.join("\n");
		const start = rendered.indexOf("# Specialized Tools");
		const end = rendered.indexOf("\n# Exploration", start);
		if (start < 0 || end < 0) throw new Error("Expected the specialized-tools policy section");
		return rendered.slice(start, end);
	}

	async function sessionWithCustomTools(toolNames: string[], customTools: CustomTool[]): Promise<AgentSession> {
		const { session } = await createAgentSession({
			...startupShortcuts(),
			cwd: registryDir,
			agentDir: registryDir,
			enableMCP: false,
			modelRegistry,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "plan.enabled": false }),
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			toolNames,
			customTools,
		});
		sessions.push(session);
		return session;
	}

	it("excludes generate_image from a restricted tool whitelist", async () => {
		const names = await activeToolNames(Settings.isolated({}), ["read"]);
		expect(names).toContain("read");
		expect(names).not.toContain("generate_image");
	});

	it("excludes generate_image under --no-tools (empty whitelist)", async () => {
		const names = await activeToolNames(Settings.isolated({}), []);
		expect(names).not.toContain("generate_image");
	});

	it("respects generate_image.enabled=false even when requested", async () => {
		const names = await activeToolNames(Settings.isolated({ "generate_image.enabled": false }), [
			"read",
			"generate_image",
		]);
		expect(names).not.toContain("generate_image");
	});

	it("includes generate_image top-level when explicitly requested and enabled", async () => {
		const names = await activeToolNames(Settings.isolated({ "generate_image.enabled": true }), [
			"read",
			"generate_image",
		]);
		expect(names).toContain("generate_image");
	});

	it("exposes generate_image as an xd:// device (not top-level) in a default session", async () => {
		// Default session (no explicit --tools) with tools.xdev on: image-gen is a
		// discoverable custom tool, so it mounts as an xd:// device instead of
		// shipping its schema top-level.
		const { session } = await createAgentSession({
			...startupShortcuts(),
			cwd: registryDir,
			agentDir: registryDir,
			modelRegistry,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "generate_image.enabled": true }),
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
		});
		sessions.push(session);
		expect(session.getActiveToolNames()).not.toContain("generate_image");
		expect(session.getXdevToolEntries().map(entry => entry.name)).toContain("generate_image");
	});

	it("mounts ambient tools across runtime selection with a device-only write", async () => {
		const ambientTool = customTool("ambient_search");
		const session = await sessionWithCustomTools(["read"], [ambientTool]);
		expect(session.getActiveToolNames()).toEqual(expect.arrayContaining(["read", "write"]));
		expect(session.getActiveToolNames()).not.toContain(ambientTool.name);
		expect(session.getXdevToolEntries().map(entry => entry.name)).toContain(ambientTool.name);
		expect(specializedToolsPolicy(session)).not.toContain("`write`");

		await session.setActiveToolsByName(session.getEnabledToolNames());

		const write = session.getToolByName("write");
		expect(write).toBeDefined();
		await expect(
			write!.execute("device-only-after-reapply", {
				path: path.join(registryDir, "internal-reapply.txt"),
				content: "x",
			}),
		).rejects.toThrow("Filesystem writes are not available");

		expect(session.getActiveToolNames()).toEqual(expect.arrayContaining(["read", "write"]));
		expect(session.getActiveToolNames()).not.toContain(ambientTool.name);
		expect(session.getXdevToolEntries().map(entry => entry.name)).toContain(ambientTool.name);
	});

	it("upgrades explicit write selection while devices are already mounted", async () => {
		const ambientTool = customTool("mounted_runtime_search");
		const session = await sessionWithCustomTools(["read"], [ambientTool]);
		expect(session.getXdevToolEntries().map(entry => entry.name)).toContain(ambientTool.name);

		await session.setActiveToolsByName(["read", "write"]);

		expect(session.getXdevToolEntries().map(entry => entry.name)).not.toContain(ambientTool.name);
		expect(specializedToolsPolicy(session)).toContain("`write`");
		const write = session.getToolByName("write");
		expect(write).toBeDefined();
		const target = path.join(registryDir, "mounted-runtime-upgrade.txt");
		await write!.execute("mounted-runtime-full-write", { path: target, content: "upgraded\n" });
		expect(await Bun.file(target).text()).toBe("upgraded\n");
	});

	it("mounts ambient MCP-shaped tools when write was omitted", async () => {
		let mcpCalls = 0;
		const mcpTool = {
			name: "mcp__test__search",
			label: "test/search",
			description: "Search the test MCP server",
			parameters: { type: "object", properties: {} },
			mcpServerName: "test",
			mcpToolName: "search",
			execute: async () => {
				mcpCalls++;
				return { content: [{ type: "text" as const, text: "ok" }] };
			},
		} as CustomTool;
		const { session } = await createAgentSession({
			...startupShortcuts(),
			cwd: registryDir,
			agentDir: registryDir,
			modelRegistry,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "generate_image.enabled": true }),
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			toolNames: ["read", "generate_image"],
			customTools: [mcpTool],
		});
		sessions.push(session);

		expect(session.getActiveToolNames()).toContain("generate_image");
		expect(session.getActiveToolNames()).toContain("write");
		expect(session.getActiveToolNames()).not.toContain(mcpTool.name);
		expect(session.getXdevToolEntries().map(entry => entry.name)).toContain(mcpTool.name);
		expect(session.getAllToolNames()).toContain(mcpTool.name);
		const directTool = session.getToolByName(mcpTool.name);
		expect(directTool).toBeDefined();
		const result = await directTool!.execute("mcp-direct-dispatch", {});
		expect(result.content.find(part => part.type === "text")?.text).toBe("ok");
		expect(mcpCalls).toBe(1);
	});

	it("keeps the device-only write across an empty MCP refresh", async () => {
		const session = await sessionWithCustomTools(["read"], [customTool("mcp__test__search", true)]);
		expect(session.getActiveToolNames()).toContain("write");
		expect(session.getActiveToolNames()).not.toContain("mcp__test__search");
		expect(session.getXdevToolEntries().map(entry => entry.name)).toContain("mcp__test__search");

		await session.refreshMCPTools([]);

		expect(session.getActiveToolNames()).toContain("write");
		expect(session.getXdevToolEntries().map(entry => entry.name)).toContain("mcp__test__search");
	});

	it("keeps the device-only write during enabled-set round trips", async () => {
		const session = await sessionWithCustomTools(["read"], [customTool("mcp__test__search", true)]);
		expect(session.getActiveToolNames()).toContain("write");

		await session.setActiveToolsByName(session.getEnabledToolNames());
		expect(session.getActiveToolNames()).not.toContain("mcp__test__search");
		expect(session.getActiveToolNames()).toContain("write");
		expect(session.getXdevToolEntries().map(entry => entry.name)).toContain("mcp__test__search");

		await session.refreshMCPTools([]);
		expect(session.getActiveToolNames()).toContain("write");
		expect(session.getXdevToolEntries().map(entry => entry.name)).toContain("mcp__test__search");
	});

	it("preserves explicitly requested write after MCP devices disconnect", async () => {
		const session = await sessionWithCustomTools(["read", "write"], [customTool("mcp__test__search", true)]);

		await session.refreshMCPTools([]);

		expect(session.getActiveToolNames()).toContain("write");
	});

	it("unmounts devices when write is removed at runtime", async () => {
		const ambientTool = customTool("ambient_search");
		const session = await sessionWithCustomTools(["read", "write"], [ambientTool]);
		expect(session.getXdevToolEntries().map(entry => entry.name)).toContain(ambientTool.name);

		await session.setActiveToolsByName(["read", ambientTool.name]);

		expect(session.getActiveToolNames()).toContain(ambientTool.name);
		expect(session.getActiveToolNames()).not.toContain("write");
		expect(session.getXdevToolEntries()).toEqual([]);
	});

	it("keeps ambient tools mounted after MCP disconnect with a device-only write", async () => {
		const ambientTool = customTool("ambient_search");
		const session = await sessionWithCustomTools(["read"], [ambientTool, customTool("mcp__test__search", true)]);

		await session.refreshMCPTools([]);

		expect(session.getActiveToolNames()).toContain("write");
		expect(session.getActiveToolNames()).not.toContain(ambientTool.name);
		expect(session.getXdevToolEntries().map(entry => entry.name)).toContain(ambientTool.name);
	});

	it("keeps ambient custom tools top-level when an explicit session omitted read", async () => {
		const ambientTool = customTool("ambient_search");
		const session = await sessionWithCustomTools(["bash"], [ambientTool]);

		expect(session.getActiveToolNames()).not.toContain("read");
		expect(session.getActiveToolNames()).toContain(ambientTool.name);
		expect(session.getXdevToolEntries().map(entry => entry.name)).not.toContain(ambientTool.name);
	});

	it("keeps ambient tools top-level when write is shadowed by a custom tool", async () => {
		const ambientTool = customTool("ambient_search");
		const shadowWrite = customTool("write");
		const session = await sessionWithCustomTools(["read"], [ambientTool, shadowWrite]);

		expect(session.hasBuiltInTool("write")).toBe(false);
		expect(session.getActiveToolNames()).toContain(ambientTool.name);
		expect(session.getXdevToolEntries().map(entry => entry.name)).not.toContain(ambientTool.name);

		const rpcTool: AgentTool = {
			name: "rpc_shadow_search",
			label: "RPC Shadow Search",
			description: "Search RPC host data",
			parameters: type({}),
			loadMode: "discoverable",
			async execute() {
				return { content: [] };
			},
		};
		await session.refreshRpcHostTools([rpcTool]);
		expect(session.hasBuiltInTool("write")).toBe(false);
		expect(session.getActiveToolNames()).toContain(rpcTool.name);
		expect(session.getXdevToolEntries().map(entry => entry.name)).not.toContain(rpcTool.name);
	});

	it("keeps ambient tools top-level when read is shadowed by a custom tool", async () => {
		const ambientTool = customTool("ambient_search");
		const shadowRead = customTool("read");
		const session = await sessionWithCustomTools(["read"], [ambientTool, shadowRead]);

		expect(session.hasBuiltInTool("read")).toBe(false);
		expect(session.getActiveToolNames()).toContain(ambientTool.name);
		expect(session.getXdevToolEntries().map(entry => entry.name)).not.toContain(ambientTool.name);

		const rpcTool: AgentTool = {
			name: "rpc_shadow_read_search",
			label: "RPC Shadow Read Search",
			description: "Search RPC host data",
			parameters: type({}),
			loadMode: "discoverable",
			async execute() {
				return { content: [] };
			},
		};
		await session.refreshRpcHostTools([rpcTool]);
		expect(session.getActiveToolNames()).toContain(rpcTool.name);
		expect(session.getXdevToolEntries().map(entry => entry.name)).not.toContain(rpcTool.name);
	});

	it("keeps newly discovered tools top-level after runtime read removal", async () => {
		const session = await sessionWithCustomTools(["read", "bash"], []);
		await session.setActiveToolsByName(["bash"]);

		const rpcTool: AgentTool = {
			name: "rpc_without_read",
			label: "RPC Without Read",
			description: "Search RPC host data",
			parameters: type({}),
			loadMode: "discoverable",
			async execute() {
				return { content: [] };
			},
		};
		await session.refreshRpcHostTools([rpcTool]);

		expect(session.getActiveToolNames()).not.toContain("read");
		expect(session.getActiveToolNames()).toContain(rpcTool.name);
		expect(session.getXdevToolEntries().map(entry => entry.name)).not.toContain(rpcTool.name);
	});
	it("mounts newly discovered RPC tools under xd:// when write was omitted", async () => {
		const { session } = await createAgentSession({
			...startupShortcuts(),
			cwd: registryDir,
			agentDir: registryDir,
			modelRegistry,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "plan.enabled": false, "generate_image.enabled": false }),
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			enableMCP: false,
			toolNames: ["read"],
		});
		sessions.push(session);
		// The device-only transport stays dormant until a mountable tool appears.
		expect(session.getXdevToolEntries()).toEqual([]);
		expect(session.getActiveToolNames()).not.toContain("write");
		await session.setActiveToolsByName(["read"]);
		expect(session.getActiveToolNames()).not.toContain("write");

		const rpcTool: AgentTool = {
			name: "rpc_search",
			label: "RPC Search",
			description: "Search RPC host data",
			parameters: type({}),
			loadMode: "discoverable",
			async execute() {
				return { content: [] };
			},
		};
		await session.refreshRpcHostTools([rpcTool]);

		expect(session.getActiveToolNames()).toContain("write");

		expect(session.getActiveToolNames()).not.toContain("rpc_search");
		expect(session.getXdevToolEntries().map(entry => entry.name)).toContain("rpc_search");

		// The transport write rejects filesystem targets: the grant is xd:// only.
		const write = session.getToolByName("write");
		expect(write).toBeDefined();
		await expect(
			write!.execute("device-only-fs", { path: path.join(registryDir, "nope.txt"), content: "x" }),
		).rejects.toThrow("Filesystem writes are not available");
	});
});
