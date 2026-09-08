import { afterAll, beforeAll, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AuthStorage } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";

// Guards the SDK/session boundary: browser and computer stay outside the tool
// registry while their eval preludes follow live, session-local settings.
describe("AgentSession eval preludes", () => {
	let registryDir: string;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	const sessions: AgentSession[] = [];

	beforeAll(async () => {
		registryDir = path.join(os.tmpdir(), `pi-computer-toggle-${Snowflake.next()}`);
		fs.mkdirSync(registryDir, { recursive: true });
		authStorage = await AuthStorage.create(path.join(registryDir, "auth.db"));
		authStorage.setRuntimeApiKey("google", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterAll(async () => {
		for (const session of sessions) await session.dispose().catch(() => {});
		authStorage.close();
		if (fs.existsSync(registryDir)) removeSyncWithRetries(registryDir);
	});

	it("updates enabled preludes without registering browser or computer tools", async () => {
		const settings = Settings.isolated({ "browser.enabled": false });
		const { session } = await createAgentSession({
			cwd: registryDir,
			agentDir: registryDir,
			modelRegistry,
			sessionManager: SessionManager.inMemory(),
			settings,
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
		});
		sessions.push(session);

		expect(session.getAllToolNames()).not.toContain("computer");
		expect(session.getAllToolNames()).not.toContain("browser");
		expect(session.getEnabledToolNames()).not.toContain("computer");
		expect(session.getEnabledToolNames()).not.toContain("browser");
		expect(session.getEvalPreludes()).toEqual([]);

		session.settings.override("computer.enabled", true);
		expect(session.getEvalPreludes().map(definition => definition.name)).toEqual(["computer"]);
		expect(session.getAllToolNames()).not.toContain("computer");
		await session.runToolRegistryMutation(async () => undefined);
		expect(session.agent.state.systemPrompt.join("\n\n")).toContain("# Computer Use");
		expect(session.agent.state.systemPrompt.join("\n\n")).toContain("`computer` eval prelude");

		session.settings.override("computer.enabled", false);
		expect(session.getEvalPreludes()).toEqual([]);
		await session.runToolRegistryMutation(async () => undefined);
		expect(session.agent.state.systemPrompt.join("\n\n")).not.toContain("# Computer Use");

		session.settings.override("browser.enabled", true);
		expect(session.getEvalPreludes().map(definition => definition.name)).toEqual(["browser"]);
		expect(session.getAllToolNames()).not.toContain("browser");

		const gemini = getBundledModel("google", "gemini-2.5-flash");
		if (!gemini) throw new Error("Expected bundled Google Gemini model to exist");
		await session.setModel(gemini);
		expect(session.model).toBe(gemini);
		expect(session.getEvalPreludes().map(definition => definition.name)).toEqual(["browser"]);
	});

	it("reconciles browser MCP filtering on live browser toggles", async () => {
		const manager = new MCPManager(registryDir, null, async () => ({
			configs: {},
			sources: {},
			exaApiKeys: [],
		}));
		const reconcile = vi.spyOn(manager, "reconcileBrowserFilter");
		const settings = Settings.isolated({ "browser.enabled": false });
		const { session } = await createAgentSession({
			cwd: registryDir,
			agentDir: registryDir,
			modelRegistry,
			sessionManager: SessionManager.inMemory(),
			settings,
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			mcpManager: manager,
			enableLsp: false,
			skipPythonPreflight: true,
		});
		sessions.push(session);

		settings.override("browser.enabled", true);
		expect(reconcile).toHaveBeenLastCalledWith(true);
		const enableReconcile = reconcile.mock.results.at(-1);
		if (!enableReconcile || enableReconcile.type !== "return") throw new Error("Expected browser MCP reconcile");
		await enableReconcile.value;
		await session.runToolRegistryMutation(async () => undefined);
		expect(session.getEvalPreludes().some(definition => definition.name === "browser")).toBe(true);

		settings.override("browser.enabled", false);
		expect(reconcile).toHaveBeenLastCalledWith(false);
		const disableReconcile = reconcile.mock.results.at(-1);
		if (!disableReconcile || disableReconcile.type !== "return") throw new Error("Expected browser MCP reconcile");
		await disableReconcile.value;
		await session.runToolRegistryMutation(async () => undefined);
		expect(session.getEvalPreludes().some(definition => definition.name === "browser")).toBe(false);
	});

	it("does not add host preludes to a restricted eval-only session", async () => {
		const settings = Settings.isolated({
			"browser.enabled": true,
			"computer.enabled": true,
		});
		const { session } = await createAgentSession({
			cwd: registryDir,
			agentDir: registryDir,
			modelRegistry,
			sessionManager: SessionManager.inMemory(),
			settings,
			model: getBundledModel("openai", "gpt-4o-mini"),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
			restrictToolNames: true,
			toolNames: ["eval"],
		});
		sessions.push(session);

		expect(session.getEnabledToolNames()).toEqual(["eval"]);
		expect(session.getEvalPreludes()).toEqual([]);
		expect(session.getAllToolNames()).not.toContain("browser");
		expect(session.getAllToolNames()).not.toContain("computer");
	});
});
