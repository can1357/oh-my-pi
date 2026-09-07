import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent, ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { Api, Model, ProviderSessionState } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { withOfficialAnthropicEndpoint } from "./helpers/anthropic-endpoint";

withOfficialAnthropicEndpoint();

describe("/fast targets the current model's service-tier family", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession | undefined;
	let modelRegistry: ModelRegistry;

	beforeAll(async () => {
		tempDir = TempDir.createSync("@pi-fast-mode-scope-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
	});

	afterEach(async () => {
		await session?.dispose();
		session = undefined;
	});

	afterAll(() => {
		authStorage.close();
		tempDir.removeSync();
	});

	async function createSession(
		provider: "anthropic" | "openai" | "openai-codex",
		modelId: string,
		settings: Settings = Settings.isolated(),
	): Promise<AgentSession> {
		const model = getBundledModel(provider, modelId);
		if (!model) {
			throw new Error("Expected bundled test model " + provider + "/" + modelId + " to exist");
		}
		return createSessionForModel(model, settings);
	}

	async function createSessionForModel(
		model: Model<Api>,
		settings: Settings = Settings.isolated(),
	): Promise<AgentSession> {
		const agent = new Agent({
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
		});
		authStorage.setRuntimeApiKey(model.provider, "token");
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
		});
		session.subscribe(() => {});
		return session;
	}

	it("enables priority on the Anthropic family for a Claude model", async () => {
		const session = await createSession("anthropic", "claude-sonnet-4-5");
		session.setFastMode(true);
		expect(session.serviceTierByFamily).toEqual({ anthropic: "priority" });
		expect(session.isFastModeEnabled()).toBe(true);
	});

	it("keeps Anthropic priority enabled while an exact-model provider fallback makes it inactive", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled test model anthropic/claude-sonnet-4-5 to exist");
		const session = await createSessionForModel(model);
		session.setFastMode(true);
		const state = {
			strictToolsDisabled: false,
			fastModeDisabled: true,
			replayUnsignedThinkingDisabled: false,
			close: () => {},
		} as ProviderSessionState & { fastModeDisabled: boolean };
		session.providerSessionState.set(`anthropic-messages:${model.baseUrl}\u0000${model.id}`, state);

		expect(session.isFastModeEnabled()).toBe(true);
		expect(session.isFastModeActive()).toBe(false);

		session.setFastMode(true);
		expect(session.isFastModeEnabled()).toBe(true);
		expect(session.isFastModeActive()).toBe(true);
		expect(state.fastModeDisabled).toBe(false);
	});

	it("enables priority on the OpenAI family for an OpenAI model", async () => {
		const session = await createSession("openai", "gpt-5.2");
		session.setFastMode(true);
		expect(session.serviceTierByFamily).toEqual({ openai: "priority" });
		expect(session.isFastModeEnabled()).toBe(true);
	});

	it("enables priority for a custom OpenAI-compatible relay serving an OpenAI model", async () => {
		const session = await createSessionForModel(
			buildModel({
				id: "o4-mini",
				name: "O4 Mini Relay",
				api: "openai-responses",
				provider: "custom-relay",
				baseUrl: "https://relay.example/v1",
				reasoning: true,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 400_000,
				maxTokens: 64_000,
			}),
		);
		expect(session.setFastMode(true)).toBe(true);
		expect(session.serviceTierByFamily).toEqual({ openai: "priority" });
		expect(session.isFastModeEnabled()).toBe(true);
		expect(session.isFastModeActive()).toBe(true);
	});

	it("leaves Fireworks models on the dedicated Fireworks tier control", async () => {
		const session = await createSessionForModel(
			buildModel({
				id: "gpt-oss-120b",
				name: "GPT OSS 120B",
				api: "openai-completions",
				provider: "fireworks",
				baseUrl: "https://api.fireworks.ai/inference/v1",
				reasoning: true,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128_000,
				maxTokens: 64_000,
			}),
		);
		expect(session.setFastMode(true)).toBe(false);
		expect(session.serviceTierByFamily).toEqual({});
		expect(session.isFastModeEnabled()).toBe(false);
		expect(session.isFastModeActive()).toBe(false);
	});

	it("persists explicit off for the current family when disabled", async () => {
		const session = await createSession("anthropic", "claude-sonnet-4-5");
		session.setFastMode(true);
		session.setFastMode(false);
		expect(session.serviceTierByFamily).toEqual({});
		expect(session.serviceTierOverrides).toEqual({ anthropic: null });
		expect(session.isFastModeEnabled()).toBe(false);
	});

	it("distinguishes explicit /fast off from an unset family override", async () => {
		const model = getBundledModel("openai-codex", "gpt-5.6-luna");
		if (!model) throw new Error("Expected bundled test model openai-codex/gpt-5.6-luna to exist");
		const settings = Settings.isolated();
		settings.set("tier.modelOverrides", { "openai-codex/gpt-5.6-luna": "priority" });
		const session = await createSessionForModel(model, settings);

		expect(session.isFastModeEnabled()).toBe(true);
		expect(session.serviceTierByFamily).toEqual({});

		session.setFastMode(false);
		expect(session.serviceTierByFamily).toEqual({});
		expect(session.serviceTierOverrides).toEqual({ openai: null });
		expect(session.isFastModeEnabled()).toBe(false);
		const tierEntry = [...session.sessionManager.getEntries()]
			.reverse()
			.find(entry => entry.type === "service_tier_change");
		expect(tierEntry).toMatchObject({ serviceTier: null, overrides: { openai: null } });

		session.setServiceTierFamily("openai", undefined);
		expect(session.serviceTierOverrides).toEqual({});
		expect(session.isFastModeEnabled()).toBe(true);
		expect(session.serviceTierByFamily).toEqual({});
	});

	it("keeps a model override scoped to Luna during a Luna to Sol transition", async () => {
		const luna = getBundledModel("openai-codex", "gpt-5.6-luna");
		const sol = getBundledModel("openai-codex", "gpt-5.6-sol");
		if (!luna || !sol) throw new Error("Expected bundled GPT-5.6 Luna and Sol models to exist");
		const settings = Settings.isolated();
		settings.set("tier.modelOverrides", { "openai-codex/gpt-5.6-luna": "priority" });
		const session = await createSessionForModel(luna, settings);

		expect(session.isFastModeEnabled()).toBe(true);
		expect(session.isFastModeActive()).toBe(true);
		expect(session.serviceTierByFamily).toEqual({});

		await session.setModelTemporary(sol);
		expect(session.isFastModeEnabled()).toBe(false);
		expect(session.isFastModeActive()).toBe(false);
		expect(session.serviceTierByFamily).toEqual({});

		await session.setModelTemporary(luna);
		expect(session.isFastModeEnabled()).toBe(true);
		expect(session.serviceTierByFamily).toEqual({});
	});

	it("resolves model-tier rules from the actual request effort", async () => {
		const model = getBundledModel("openai-codex", "gpt-5.6-luna");
		if (!model) throw new Error("Expected bundled test model openai-codex/gpt-5.6-luna to exist");
		const settings = Settings.isolated();
		settings.set("tier.modelOverrides", { "openai-codex/gpt-5.6-luna:high": "priority" });
		const session = await createSessionForModel(model, settings);
		const resolveTier = session.agent.serviceTierResolver;
		if (!resolveTier) throw new Error("Expected AgentSession to install a service-tier resolver");

		expect(resolveTier(model, ThinkingLevel.High, false)).toBe("priority");
		expect(resolveTier(model, ThinkingLevel.Low, false)).toBeUndefined();
		// An explicitly absent request effort must not inherit the active session effort.
		expect(resolveTier(model, undefined, false)).toBeUndefined();
		expect(resolveTier(model, ThinkingLevel.High, true)).toBeUndefined();

		session.setThinkingLevel(ThinkingLevel.High);
		expect(session.isFastModeEnabled()).toBe(true);
	});

	it("toggle reports the resulting state", async () => {
		const session = await createSession("anthropic", "claude-sonnet-4-5");
		expect(session.toggleFastMode()).toBe(true);
		expect(session.serviceTierByFamily.anthropic).toBe("priority");
		expect(session.toggleFastMode()).toBe(false);
		expect(session.serviceTierByFamily.anthropic).toBeUndefined();
	});
});
