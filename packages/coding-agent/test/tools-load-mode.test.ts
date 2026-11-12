import { afterEach, describe, expect, it, vi } from "bun:test";
import { toolWireSchema } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { cfgGrepEnabled, cfgToolsLoadMode } from "@oh-my-pi/pi-coding-agent/tools/settings";
import { logger, TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

const cleanups: Array<() => unknown> = [];
afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	vi.restoreAllMocks();
});

async function startSession(settings: Settings, toolNames?: string[]): Promise<AgentSession> {
	const root = TempDir.createSync("@omp-essential-tools-");
	cleanups.push(() => root.removeSync());
	const auth = createInMemoryAuthStorage();
	cleanups.push(() => auth.close());
	const { session } = await createAgentSession({
		cwd: root.path(),
		agentDir: root.path(),
		modelRegistry: new ModelRegistry(auth),
		model: getBundledModel("openai", "gpt-4o-mini"),
		settings,
		sessionManager: SessionManager.inMemory(root.path()),
		disableExtensionDiscovery: true,
		enableMCP: false,
		enableLsp: true,
		skipPythonPreflight: true,
		skills: [],
		rules: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		toolNames,
		workspaceTree: { rootPath: root.path(), rendered: "", truncated: false, totalLines: 0, agentsMdFiles: [] },
	});
	cleanups.push(() => session.dispose());
	return session;
}

async function settle(session: AgentSession): Promise<void> {
	await Promise.resolve();
	await session.runToolRegistryMutation(async () => {});
}

describe("essential tool load-mode overrides", () => {
	it("rejects discoverable overrides instead of silently changing tool presentation", () => {
		expect(() => Settings.isolated({ "tools.loadMode": { task: "discoverable" } })).toThrow(
			/tools\.loadMode.*essential/,
		);
	});

	it("pins full LSP schemas at startup and restores mounting when the override is removed", async () => {
		const settings = Settings.isolated({ "tools.loadMode": { lsp: "essential" } });
		const session = await startSession(settings);
		expect(session.getActiveToolNames()).toContain("lsp");
		expect(session.getMountedXdevToolNames()).not.toContain("lsp");
		let request = await session.agent.buildSideRequestContext([]);
		expect(toolWireSchema(request.tools!.find(tool => tool.name === "lsp")!).properties).toHaveProperty("action");

		cfgToolsLoadMode.override(settings, {});
		await settle(session);
		expect(session.getActiveToolNames()).not.toContain("lsp");
		expect(session.getMountedXdevToolNames()).toContain("lsp");
		request = await session.agent.buildSideRequestContext([]);
		expect(request.tools?.some(tool => tool.name === "lsp")).toBe(false);

		cfgToolsLoadMode.override(settings, { lsp: "essential" });
		await settle(session);
		request = await session.agent.buildSideRequestContext([]);
		expect(toolWireSchema(request.tools!.find(tool => tool.name === "lsp")!).properties).toHaveProperty("action");
		expect(session.getMountedXdevToolNames()).not.toContain("lsp");
	});

	it("warns once for unknown names without granting disabled or unselected tools, and rearms removed entries", async () => {
		const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
		const settings = Settings.isolated({
			"grep.enabled": false,
			"tools.loadMode": { grep: "essential", lsp: "essential", unknown_tool: "essential" },
		});
		const session = await startSession(settings, ["read"]);
		expect(session.getActiveToolNames()).not.toContain("lsp");
		expect(session.getToolByName("grep")).toBeUndefined();
		const startupWarnings = session.configWarnings.filter(message => message.startsWith("tools.loadMode."));
		expect(startupWarnings).toEqual([expect.stringContaining("tools.loadMode.unknown_tool")]);
		const warningCount = () => warn.mock.calls.filter(([message]) => message.includes("tools.loadMode.")).length;
		expect(warningCount()).toBe(1);
		const notices: string[] = [];
		session.subscribe(event => {
			if (event.type === "notice" && event.source === "tools.loadMode") notices.push(event.message);
		});

		cfgGrepEnabled.override(settings, true);
		await settle(session);
		expect(session.getActiveToolNames()).not.toContain("grep");
		expect(warningCount()).toBe(1);
		expect(notices).toEqual([]);

		cfgToolsLoadMode.override(settings, { lsp: "essential" });
		await settle(session);
		cfgToolsLoadMode.override(settings, { lsp: "essential", unknown_tool: "essential" });
		await settle(session);
		expect(warningCount()).toBe(2);
		expect(notices).toEqual([expect.stringContaining("tools.loadMode.unknown_tool")]);
	});
});
