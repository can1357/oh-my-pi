import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
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

import { cfgDisabledModels, cfgDisabledProviders } from "@oh-my-pi/pi-coding-agent/config/model-settings";

function bundled(provider: GeneratedProvider, id: string): Model<Api> {
	const model = getBundledModel(provider, id);
	if (!model) throw new Error(`Expected bundled model ${provider}/${id}`);
	return model;
}

describe("live model availability", () => {
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
		vi.restoreAllMocks();
	});

	const startSession = (settings: Settings, modelRegistry: ModelRegistry, scopedModels?: Model<Api>[]) => {
		session = new AgentSession({
			agent: new Agent({
				initialState: {
					model: scopedModels?.[0] ?? bundled("anthropic", "claude-sonnet-4-5"),
					systemPrompt: ["Test"],
					tools: [],
					messages: [],
					thinkingLevel: Effort.Medium,
				},
			}),
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
			scopedModels: scopedModels?.map(model => ({ model })),
		});
		return session;
	};

	it("hides session-denied models from ACP without an allowlist and rejects a stale picker selection", async () => {
		const settings = Settings.isolated();
		const registry = new ModelRegistry(authStorage, tempDir.join("models.yml"), { settings: Settings.isolated() });
		const live = startSession(settings, registry);
		const opus = bundled("anthropic", "claude-opus-4-5");
		const selector = `${opus.provider}/${opus.id}`;
		const offered = () =>
			live.getAvailableModels().some(model => model.id === opus.id && model.provider === opus.provider);
		expect(offered()).toBe(true);
		cfgDisabledModels.set(settings, [selector]);
		expect(offered()).toBe(false);
		const refresh = vi.spyOn(registry, "refreshSelectedModelMetadata");
		await expect(live.setModel(opus)).rejects.toThrow(selector);
		await expect(live.setModelTemporary(opus)).rejects.toThrow(selector);
		expect(refresh).not.toHaveBeenCalled();
		expect(live.model?.id).toBe("claude-sonnet-4-5");
		cfgDisabledModels.set(settings, []);
		expect(offered()).toBe(true);
	});

	it("does not cycle or offer unrelated models when the sole member of an explicit scope is denied", async () => {
		const settings = Settings.isolated({ modelRoles: { slow: "anthropic/claude-opus-4-5" } });
		const registry = new ModelRegistry(authStorage, tempDir.join("models.yml"), { settings: Settings.isolated() });
		const sonnet = bundled("anthropic", "claude-sonnet-4-5");
		const live = startSession(settings, registry, [sonnet]);
		cfgDisabledModels.set(settings, [`anthropic/${sonnet.id}`]);
		expect(live.getAvailableModels()).toHaveLength(0);
		expect(await live.cycleModel()).toBeUndefined();
		expect(live.getRoleModelCycle(["default", "slow"])).toBeUndefined();
		expect(live.model?.id).toBe(sonnet.id);
		live.setScopedModels([]);
		expect(await live.cycleModel("backward")).toBeUndefined();
		live.setScopedModels(undefined);
		expect(live.getAvailableModels().some(model => model.id === "claude-opus-4-5")).toBe(true);
	});

	it("rejects a selection denied while its metadata was loading", async () => {
		const settings = Settings.isolated();
		const registry = new ModelRegistry(authStorage, tempDir.join("models.yml"), { settings: Settings.isolated() });
		const live = startSession(settings, registry);
		const opus = bundled("anthropic", "claude-opus-4-5");
		const selector = `${opus.provider}/${opus.id}`;
		const metadata = Promise.withResolvers<Model>();
		vi.spyOn(registry, "refreshSelectedModelMetadata").mockReturnValue(metadata.promise);
		const switching = live.setModelTemporary(opus);
		cfgDisabledModels.set(settings, [selector]);
		metadata.resolve(opus);
		await expect(switching).rejects.toThrow(selector);
		expect(live.model?.id).toBe("claude-sonnet-4-5");
	});

	it("drops a provider disabled mid-session from the model list and the Ctrl+P cycle", async () => {
		const sonnet = bundled("anthropic", "claude-sonnet-4-5");
		const opus = bundled("anthropic", "claude-opus-4-5");
		const gpt = bundled("openai", "gpt-5");
		const settings = Settings.isolated();
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"), { settings });
		const live = startSession(settings, modelRegistry, [sonnet, gpt, opus]);
		expect(live.getAvailableModels().some(model => model.provider === "openai")).toBe(true);

		cfgDisabledProviders.set(settings, ["openai"]);

		expect(live.scopedModels.map(entry => entry.model.id)).toEqual([sonnet.id, opus.id]);
		expect(live.getAvailableModels().some(model => model.provider === "openai")).toBe(false);
		const cycled = await live.cycleModel();
		expect(cycled?.model.id).toBe(opus.id);
		expect((await live.cycleModel())?.model.id).toBe(sonnet.id);
	});

	it("re-seeds implicit discovery for a provider re-enabled mid-session", async () => {
		const sonnet = bundled("anthropic", "claude-sonnet-4-5");
		const settings = Settings.isolated();
		cfgDisabledProviders.set(settings, ["lm-studio"]);
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"), { settings });
		startSession(settings, modelRegistry, [sonnet]);
		expect(modelRegistry.getDiscoverableProviders()).not.toContain("lm-studio");
		// Only a catalog rebuild re-seeds implicit discovery; await the one the session's
		// settings listener starts (the rebuild is async and exposes no other signal).
		const reapply = vi.spyOn(modelRegistry, "reapplyModelPolicies");

		cfgDisabledProviders.set(settings, []);
		await Promise.resolve();
		await reapply.mock.results[0]?.value;

		expect(modelRegistry.getDiscoverableProviders()).toContain("lm-studio");
	});
});
