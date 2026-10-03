import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { Effort, type Api, type Model } from "@oh-my-pi/pi-ai";
import { getBundledModel, type GeneratedProvider } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { formatModelStringWithRouting } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import {
	getModelRolePreset,
	saveModelRolePreset,
	setModelRolePresetDefault,
} from "@oh-my-pi/pi-coding-agent/config/model-role-presets";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

// A saved preset's `default` entry binds the primary selector — `@upstream`
// routing and `:effort` suffixes included. The live model must be switched to
// the resolved saved selector (no live/persisted divergence), `:auto` must be
// distinguished from inherit, and route-suffixed selectors must survive capture.
describe("AgentSession preset default selector", () => {
	let sharedDir: TempDir;
	let authStorage: AuthStorage;
	let registry: ModelRegistry;
	const sessions: AgentSession[] = [];

	beforeAll(async () => {
		sharedDir = TempDir.createSync("@pi-preset-default-");
		authStorage = await AuthStorage.create(path.join(sharedDir.path(), "auth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		authStorage.setRuntimeApiKey("openrouter", "test-key");
		registry = new ModelRegistry(authStorage, path.join(sharedDir.path(), "models.yml"));
	});

	afterAll(() => {
		authStorage.close();
		sharedDir.removeSync();
	});

	afterEach(async () => {
		for (const session of sessions.splice(0)) await session.dispose();
	});

	function bundled(provider: GeneratedProvider, id: string): Model<Api> {
		const model = getBundledModel(provider, id);
		if (!model) throw new Error(`Expected ${provider}/${id} in the bundled catalog`);
		return model;
	}

	function makeSession(initialModel: Model<Api>, settings: Settings): AgentSession {
		const agent = new Agent({
			initialState: {
				model: initialModel,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
				thinkingLevel: Effort.Medium,
			},
		});
		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry: registry,
		});
		sessions.push(session);
		return session;
	}

	it("restores a routed default selector to the live model and persisted role verbatim", async () => {
		const settings = Settings.isolated();
		const glm = bundled("openrouter", "z-ai/glm-4.7");
		const routedSelector = "openrouter/z-ai/glm-4.7@cerebras:high";
		settings.set("modelRolePresets", saveModelRolePreset({}, glm, "routed", { default: routedSelector }));
		settings.set("modelRolePresets", setModelRolePresetDefault(settings.get("modelRolePresets"), glm, "routed"));
		// Capture keeps the route and effort suffixes verbatim.
		expect(getModelRolePreset(settings.get("modelRolePresets"), glm, "routed")?.roles.default).toBe(routedSelector);

		const session = makeSession(glm, settings);
		const result = await session.setModel(glm, "default", {
			persist: true,
			modelRolePreset: { kind: "configured-default" },
		});
		expect(result.switched).toBe(true);
		expect(result.defaultRoleValue).toBe(routedSelector);
		expect(result.defaultThinking).toBe(Effort.High);
		// Persisted role and live model agree: both carry the routed selector.
		expect(settings.getModelRole("default")).toBe(routedSelector);
		expect(session.model?.provider).toBe("openrouter");
		// The live model keeps the base id; the `@upstream` pin lives on the
		// compat routing block, surfaced by the routing-aware formatter.
		expect(session.model?.id).toBe("z-ai/glm-4.7");
		expect(session.model ? formatModelStringWithRouting(session.model) : undefined).toBe(
			"openrouter/z-ai/glm-4.7@cerebras",
		);
		expect(session.thinkingLevel).toBe(Effort.High);
	});

	it("captures and restores auto distinct from inherit via an explicit :auto suffix", async () => {
		const settings = Settings.isolated();
		const sonnet = bundled("anthropic", "claude-sonnet-4-5");
		settings.set(
			"modelRolePresets",
			saveModelRolePreset({}, sonnet, "autoPreset", { default: "anthropic/claude-sonnet-4-5:auto" }),
		);
		// The save helper stores the selector verbatim; the controller owns
		// appending `:auto` at capture time (covered by the UI save smoke), so
		// the apply path here sees the same explicit entry it must honor.
		expect(getModelRolePreset(settings.get("modelRolePresets"), sonnet, "autoPreset")?.roles.default).toBe(
			"anthropic/claude-sonnet-4-5:auto",
		);

		// Move the live session to an explicit effort, then re-apply the preset.
		settings.setModelRole("default", "anthropic/claude-sonnet-4-5:low");
		const session = makeSession(sonnet, settings);
		const result = await session.setModel(sonnet, "default", {
			persist: true,
			modelRolePreset: { kind: "named", name: "autoPreset" },
		});
		expect(result.switched).toBe(true);
		expect(result.defaultThinking).toBe("auto");
		expect(settings.getModelRole("default")).toBe("anthropic/claude-sonnet-4-5:auto");
		// The carried explicit effort is not left in place; auto is restored.
		expect(session.thinkingLevel).not.toBe("low");
	});

	it("does not honor a captured default that resolves to a different model", async () => {
		const settings = Settings.isolated();
		const glm = bundled("openrouter", "z-ai/glm-4.7");
		settings.set(
			"modelRolePresets",
			saveModelRolePreset({}, glm, "foreign", { default: "anthropic/claude-sonnet-4-5:high" }),
		);
		settings.set("modelRolePresets", setModelRolePresetDefault(settings.get("modelRolePresets"), glm, "foreign"));
		const session = makeSession(glm, settings);
		const result = await session.setModel(glm, "default", {
			persist: true,
			modelRolePreset: { kind: "configured-default" },
		});
		expect(result.switched).toBe(true);
		// The foreign default entry is ignored: no override, no thinking capture.
		expect(result.defaultRoleValue).toBeUndefined();
		expect(result.defaultThinking).toBeUndefined();
		expect(settings.getModelRole("default")).toBe("openrouter/z-ai/glm-4.7");
		expect(session.model?.id).toBe("z-ai/glm-4.7");
	});

	it("leaves the live primary untouched when autoLoad is off for on-select", async () => {
		const settings = Settings.isolated();
		const glm = bundled("openrouter", "z-ai/glm-4.7");
		settings.set(
			"modelRolePresets",
			saveModelRolePreset({}, glm, "gated", { default: "openrouter/z-ai/glm-4.7@cerebras:high" }),
		);
		settings.set("modelRolePresets", setModelRolePresetDefault(settings.get("modelRolePresets"), glm, "gated"));
		settings.set("modelRolePresets.autoLoad", false);
		const session = makeSession(glm, settings);
		const result = await session.setModel(glm, "default", {
			persist: true,
			modelRolePreset: { kind: "on-select" },
		});
		expect(result.switched).toBe(true);
		// No captured default is honored: no routed selector, no thinking capture.
		expect(result.defaultRoleValue).toBeUndefined();
		expect(result.defaultThinking).toBeUndefined();
		expect(settings.getModelRole("default")).toBe("openrouter/z-ai/glm-4.7");
		expect(session.model?.id).toBe("z-ai/glm-4.7");
		expect(session.thinkingLevel).not.toBe(Effort.High);
	});

	it("resolves a staged primary alias against the incoming slow role, not the outgoing one", async () => {
		const settings = Settings.isolated();
		const sonnet = bundled("anthropic", "claude-sonnet-4-5");
		// The pre-apply (outgoing) slow role points at glm; the preset's staged
		// slow role points at sonnet. The default alias must follow the preset.
		settings.setModelRole("slow", "openrouter/z-ai/glm-4.7");
		settings.set(
			"modelRolePresets",
			saveModelRolePreset({}, sonnet, "aliased", {
				default: "@slow:high",
				slow: "anthropic/claude-sonnet-4-5",
			}),
		);
		settings.set("modelRolePresets", setModelRolePresetDefault(settings.get("modelRolePresets"), sonnet, "aliased"));
		const session = makeSession(sonnet, settings);
		const result = await session.setModel(sonnet, "default", {
			persist: true,
			modelRolePreset: { kind: "on-select" },
		});
		expect(result.switched).toBe(true);
		// The captured alias is honored verbatim and resolves through the staged
		// incoming slow role — otherwise the current slow (glm) would not resolve
		// to the owner and the default would be silently dropped.
		expect(result.defaultRoleValue).toBe("@slow:high");
		expect(result.defaultThinking).toBe(Effort.High);
		expect(settings.getModelRole("default")).toBe("@slow:high");
		expect(session.model?.id).toBe("claude-sonnet-4-5");
		expect(session.thinkingLevel).toBe(Effort.High);
		// The supporting apply persists the preset's own slow assignment.
		expect(settings.getModelRole("slow")).toBe("anthropic/claude-sonnet-4-5");
	});
});
