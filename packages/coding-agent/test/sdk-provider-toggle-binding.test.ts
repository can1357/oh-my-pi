import { afterEach, describe, expect, it } from "bun:test";
import type { Api, Model, ModelSpec } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { isProviderEnabled, resetCapabilityForTests } from "@oh-my-pi/pi-coding-agent/capability";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { createSubagentSettings } from "@oh-my-pi/pi-coding-agent/task/executor";
import { TempDir } from "@oh-my-pi/pi-utils";

import { cfgDisabledProviders } from "@oh-my-pi/pi-coding-agent/config/model-settings";

const model = buildModel({
	id: "provider-toggle-binding",
	name: "Provider toggle binding",
	api: "test-provider-toggle-binding",
	provider: "managed-primary",
	baseUrl: "http://127.0.0.1:8080/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 32_768,
	maxTokens: 1024,
} as ModelSpec<Api>) as Model<Api>;

// Discovery provider toggles are process-global and follow live edits on the
// top-level session's Settings; a subagent's settings overlay must not take over.
describe("discovery provider toggles with subagents", () => {
	const sessions: AgentSession[] = [];

	afterEach(async () => {
		for (const session of sessions.splice(0)) await session.dispose();
		resetCapabilityForTests();
	});

	it("keeps following the parent's disabledProviders after a subagent session starts", async () => {
		using tempDir = TempDir.createSync("@pi-provider-toggle-binding-");
		const authStorage = await AuthStorage.create(tempDir.join("auth.db"));
		authStorage.keys.setRuntime(model.provider, "test-key");
		const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
		const start = async (settings: Settings, parentTaskPrefix?: string) => {
			const { session } = await createAgentSession({
				cwd: tempDir.path(),
				agentDir: tempDir.path(),
				sessionManager: SessionManager.inMemory(tempDir.path()),
				authStorage,
				modelRegistry,
				settings,
				model,
				disableExtensionDiscovery: true,
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				rules: [],
				enableMCP: false,
				enableLsp: false,
				skipPythonPreflight: true,
				...(parentTaskPrefix ? { parentTaskPrefix, taskDepth: 1, agentId: parentTaskPrefix } : {}),
			});
			sessions.push(session);
		};
		const parentSettings = Settings.isolated({ "compaction.enabled": false });
		await start(parentSettings);
		await start(createSubagentSettings(parentSettings), "0-Sub");

		cfgDisabledProviders.set(parentSettings, ["claude"]);
		expect(isProviderEnabled("claude")).toBe(false);
		cfgDisabledProviders.set(parentSettings, []);
		expect(isProviderEnabled("claude")).toBe(true);
		authStorage.close();
	});
});
