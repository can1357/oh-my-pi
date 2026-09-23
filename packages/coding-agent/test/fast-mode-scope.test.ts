import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
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

	async function createSession(provider: "anthropic" | "openai", modelId: string): Promise<AgentSession> {
		const model = getBundledModel(provider, modelId);
		if (!model) {
			throw new Error(`Expected bundled test model ${provider}/${modelId} to exist`);
		}
		return createSessionForModel(model);
	}

	async function createSessionForModel(model: Model<Api>, providerSessionId?: string): Promise<AgentSession> {
		const agent = new Agent({
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
		});
		authStorage.keys.setRuntime(model.provider, "token");
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated(),
			modelRegistry,
			providerSessionId,
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

	it("clears only the current model's family when disabled", async () => {
		const session = await createSession("anthropic", "claude-sonnet-4-5");
		session.setFastMode(true);
		session.setFastMode(false);
		expect(session.serviceTierByFamily).toEqual({});
		expect(session.isFastModeEnabled()).toBe(false);
	});

	it("toggle reports the resulting state", async () => {
		const session = await createSession("anthropic", "claude-sonnet-4-5");
		expect(session.toggleFastMode()).toBe(true);
		expect(session.serviceTierByFamily.anthropic).toBe("priority");
		expect(session.toggleFastMode()).toBe(false);
		expect(session.serviceTierByFamily.anthropic).toBeUndefined();
	});

	it("does not share session fast mode through a provider session ID", async () => {
		const model = getBundledModel("openai", "gpt-5.2");
		if (!model) throw new Error("Expected bundled test model openai/gpt-5.2 to exist");
		const issuer = await createSessionForModel(model, "shared-provider-routing-id");
		const peer = await createSessionForModel(model, "shared-provider-routing-id");
		const previousConfigDir = process.env.PI_CONFIG_DIR;
		try {
			process.env.PI_CONFIG_DIR = path.relative(os.homedir(), tempDir.path());
			issuer.setFastModeAction("session");
			expect(issuer.agent.serviceTierResolver?.(model)).toBe("priority");
			expect(peer.agent.serviceTierResolver?.(model)).toBeUndefined();
		} finally {
			if (previousConfigDir === undefined) delete process.env.PI_CONFIG_DIR;
			else process.env.PI_CONFIG_DIR = previousConfigDir;
			await issuer.dispose();
		}
	});

	it("Off everywhere suppresses a peer's existing priority without suppressing flex", async () => {
		const issuer = await createSession("openai", "gpt-5.2");
		const peer = await createSession("openai", "gpt-5.2");
		const previousConfigDir = process.env.PI_CONFIG_DIR;
		try {
			// No await while the config-root override is installed: other tests
			// cannot observe it, and the user's shared fast-mode state is untouched.
			process.env.PI_CONFIG_DIR = path.relative(os.homedir(), tempDir.path());
			peer.setFastMode(true);
			issuer.setFastModeAction("off");
			expect(peer.isFastModeEnabled()).toBe(false);
			expect(peer.agent.serviceTierResolver?.(peer.model!)).toBeUndefined();
			peer.setServiceTierFamily("openai", "flex");
			expect(peer.agent.serviceTierResolver?.(peer.model!)).toBe("flex");
		} finally {
			if (previousConfigDir === undefined) delete process.env.PI_CONFIG_DIR;
			else process.env.PI_CONFIG_DIR = previousConfigDir;
			await issuer.dispose();
		}
	});
});
