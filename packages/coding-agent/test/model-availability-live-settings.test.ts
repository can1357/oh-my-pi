import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { type Api, Effort, type Model } from "@oh-my-pi/pi-ai";
import { type GeneratedProvider, getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

import { cfgDisabledProviders } from "@oh-my-pi/pi-coding-agent/config/model-settings";

function bundled(provider: GeneratedProvider, id: string): Model<Api> {
	const model = getBundledModel(provider, id);
	if (!model) throw new Error(`Expected bundled model ${provider}/${id}`);
	return model;
}

describe("disabledProviders takes effect live", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession | undefined;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-model-availability-live-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorage.keys.setRuntime("anthropic", "test-key");
		authStorage.keys.setRuntime("openai", "test-key");
	});

	afterEach(async () => {
		await session?.dispose();
		session = undefined;
		authStorage.close();
		tempDir.removeSync();
	});

	it("drops a provider disabled mid-session from the model list and the Ctrl+P cycle", async () => {
		const sonnet = bundled("anthropic", "claude-sonnet-4-5");
		const opus = bundled("anthropic", "claude-opus-4-5");
		const gpt = bundled("openai", "gpt-5");
		const settings = Settings.isolated();
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"), { settings });
		session = new AgentSession({
			agent: new Agent({
				initialState: {
					model: sonnet,
					systemPrompt: ["Test"],
					tools: [],
					messages: [],
					thinkingLevel: Effort.Medium,
				},
			}),
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
			scopedModels: [{ model: sonnet }, { model: gpt }, { model: opus }],
		});
		expect(session.getAvailableModels().some(model => model.provider === "openai")).toBe(true);

		cfgDisabledProviders.set(settings, ["openai"]);
		await modelRegistry.reapplyModelPolicies();

		expect(session.scopedModels.map(entry => entry.model.id)).toEqual([sonnet.id, opus.id]);
		expect(session.getAvailableModels().some(model => model.provider === "openai")).toBe(false);
		const cycled = await session.cycleModel();
		expect(cycled?.model.id).toBe(opus.id);
		expect((await session.cycleModel())?.model.id).toBe(sonnet.id);
	});
});
