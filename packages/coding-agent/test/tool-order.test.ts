import { describe, expect, it } from "bun:test";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { createSubagentSettings } from "@oh-my-pi/pi-coding-agent/task/executor";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

/**
 * The provider request, `getEnabledToolNames()` and `session_init.tools` must
 * share one order. Otherwise two sessions exposing the same tools send
 * different prefixes and miss each other's prompt cache.
 */
describe("canonical tool order", () => {
	it("orders an explicit tool list like the default session", async () => {
		using dir = TempDir.createSync("@omp-tool-order-");
		const cwd = dir.path();
		const settings = Settings.isolated({ "tools.commands": true, "marketplace.autoUpdate": "off" });
		const auth = createInMemoryAuthStorage();
		auth.keys.setRuntime("openai", "test-key");
		const base = {
			cwd,
			agentDir: cwd,
			model: getBundledModel("openai", "gpt-4o-mini"),
			modelRegistry: new ModelRegistry(auth),
			settings,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableLsp: false,
			enableMCP: false,
			disableExtensionDiscovery: true,
			skipPythonPreflight: true,
		};
		const { session: defaultSession } = await createAgentSession({
			...base,
			hasUI: false,
			sessionManager: SessionManager.inMemory(cwd),
		});
		const explicit = ["write", "glob", "bash", "read"];
		const expected = defaultSession.getEnabledToolNames().filter(name => explicit.includes(name));
		const { session: explicitSession } = await createAgentSession({
			...base,
			hasUI: false,
			toolNames: explicit,
			sessionManager: SessionManager.inMemory(cwd),
		});
		try {
			expect(explicitSession.getEnabledToolNames()).toEqual(expected);
			expect(explicitSession.getActiveToolNames()).toEqual(expected);
		} finally {
			await explicitSession.dispose();
			await defaultSession.dispose();
			auth.close();
		}
	}, 30_000);

	it("keeps a fork's tools in the parent's order after a shuffled presentation", async () => {
		using dir = TempDir.createSync("@omp-tool-order-fork-");
		const cwd = dir.path();
		const settings = Settings.isolated({ "tools.commands": true, "marketplace.autoUpdate": "off" });
		const auth = createInMemoryAuthStorage();
		auth.keys.setRuntime("openai", "test-key");
		const base = {
			cwd,
			agentDir: cwd,
			model: getBundledModel("openai", "gpt-4o-mini"),
			modelRegistry: new ModelRegistry(auth),
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableLsp: false,
			enableMCP: false,
			disableExtensionDiscovery: true,
			skipPythonPreflight: true,
		};
		const { session: parent } = await createAgentSession({
			...base,
			settings,
			hasUI: true,
			sessionManager: SessionManager.inMemory(cwd),
		});
		const shuffled = [...parent.getEnabledToolNames()].reverse();
		const { session: child } = await createAgentSession({
			...base,
			settings: createSubagentSettings(settings),
			hasUI: false,
			systemPrompt: [...parent.systemPrompt],
			toolNames: shuffled,
			mountedToolNames: parent.getMountedToolCommandNames(),
			advertiseHeadlessAsk: parent.getActiveToolNames().includes("ask"),
			parentTaskPrefix: "Order-fixture",
			sessionManager: SessionManager.inMemory(cwd),
		});
		try {
			await child.setActiveToolPresentation(shuffled, parent.getMountedToolCommandNames());
			expect(child.getEnabledToolNames()).toEqual(parent.getEnabledToolNames());
			expect(child.agent.state.tools.map(tool => tool.name)).toEqual(
				parent.agent.state.tools.map(tool => tool.name),
			);
		} finally {
			await child.dispose();
			await parent.dispose();
			auth.close();
		}
	}, 30_000);
});
