import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { Model, ProviderSessionState } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

// Regression: `#closeProviderSessionsForModelSwitch` historically only handled
// the `openai-codex-responses` / `openai-responses` keys and left
// `openai-completions:<provider>:<baseUrl>:<modelId>` entries behind on a
// /model switch. The cached strict-tools disable scopes and reasoning-effort
// fallbacks for the old backend then survived indefinitely — repro reported
// in #3260 (PR #3236).

describe("AgentSession openai-completions provider session eviction", () => {
	let tempDir: TempDir;
	let session: AgentSession;
	let modelRegistry: ModelRegistry;
	let authStorage: AuthStorage;

	beforeAll(async () => {
		tempDir = TempDir.createSync("@pi-completions-eviction-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterAll(() => {
		authStorage.close();
		tempDir.removeSync();
	});

	afterEach(async () => {
		if (session) {
			await session.dispose();
		}
	});

	function completionsModel(provider: string, id: string): Model {
		const model = modelRegistry.find(provider, id);
		if (!model) {
			throw new Error(`expected bundled openai-completions model ${provider}/${id}`);
		}
		if (model.api !== "openai-completions") {
			throw new Error(`expected ${provider}/${id} to use openai-completions, got ${model.api}`);
		}
		return model;
	}

	function completionsSessionKey(model: Model): string {
		return `openai-completions:${model.provider}:${model.baseUrl ?? ""}:${model.id}`;
	}

	function buildSession(model: Model): AgentSession {
		authStorage.setRuntimeApiKey(model.provider, "test-key");
		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
		});
		return new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
		});
	}

	it("evicts stale openai-completions state on provider/baseUrl switch", async () => {
		const deepseek = completionsModel("deepseek", "deepseek-v4-pro");
		const cerebras = completionsModel("cerebras", "llama3.1-8b");
		authStorage.setRuntimeApiKey(cerebras.provider, "cerebras-test-key");

		session = buildSession(deepseek);

		const oldCloseSpy = vi.fn();
		session.providerSessionState.set(completionsSessionKey(deepseek), {
			close: oldCloseSpy,
		} satisfies ProviderSessionState);

		await session.setModel(cerebras);

		expect(session.model?.provider).toBe(cerebras.provider);
		expect(session.model?.id).toBe(cerebras.id);
		expect(oldCloseSpy).toHaveBeenCalledTimes(1);
		expect(session.providerSessionState.has(completionsSessionKey(deepseek))).toBe(false);
	});

	it("evicts every cached entry under the old provider prefix", async () => {
		const deepseekPro = completionsModel("deepseek", "deepseek-v4-pro");
		const deepseekFlash = completionsModel("deepseek", "deepseek-v4-flash");
		const cerebras = completionsModel("cerebras", "llama3.1-8b");
		authStorage.setRuntimeApiKey(cerebras.provider, "cerebras-test-key");

		session = buildSession(deepseekPro);

		const proCloseSpy = vi.fn();
		const flashCloseSpy = vi.fn();
		session.providerSessionState.set(completionsSessionKey(deepseekPro), {
			close: proCloseSpy,
		} satisfies ProviderSessionState);
		// A sibling model on the same backend — set up earlier in the session but
		// not currently active. Same `(provider, baseUrl)` prefix; must also go.
		session.providerSessionState.set(completionsSessionKey(deepseekFlash), {
			close: flashCloseSpy,
		} satisfies ProviderSessionState);

		await session.setModel(cerebras);

		expect(proCloseSpy).toHaveBeenCalledTimes(1);
		expect(flashCloseSpy).toHaveBeenCalledTimes(1);
		expect(session.providerSessionState.has(completionsSessionKey(deepseekPro))).toBe(false);
		expect(session.providerSessionState.has(completionsSessionKey(deepseekFlash))).toBe(false);
	});

	it("evicts entries whose base URL was resolved at request time", async () => {
		const moonshot = completionsModel("moonshot", "kimi-k2-thinking");
		const cerebras = completionsModel("cerebras", "llama3.1-8b");
		authStorage.setRuntimeApiKey(cerebras.provider, "cerebras-test-key");

		session = buildSession(moonshot);

		const closeSpy = vi.fn();
		const resolvedBaseUrlKey = `openai-completions:${moonshot.provider}:https://api.moonshot.cn/v1:${moonshot.id}`;
		session.providerSessionState.set(resolvedBaseUrlKey, {
			close: closeSpy,
		} satisfies ProviderSessionState);

		await session.setModel(cerebras);

		expect(closeSpy).toHaveBeenCalledTimes(1);
		expect(session.providerSessionState.has(resolvedBaseUrlKey)).toBe(false);
	});

	it("leaves unrelated provider session state untouched", async () => {
		const deepseek = completionsModel("deepseek", "deepseek-v4-pro");
		const cerebras = completionsModel("cerebras", "llama3.1-8b");
		authStorage.setRuntimeApiKey(cerebras.provider, "cerebras-test-key");

		session = buildSession(deepseek);

		const oldCloseSpy = vi.fn();
		const unrelatedCloseSpy = vi.fn();
		const unrelatedKey = "openai-completions:other-provider:https://other.example/v1:other-model";
		session.providerSessionState.set(completionsSessionKey(deepseek), {
			close: oldCloseSpy,
		} satisfies ProviderSessionState);
		session.providerSessionState.set(unrelatedKey, {
			close: unrelatedCloseSpy,
		} satisfies ProviderSessionState);

		await session.setModel(cerebras);

		expect(oldCloseSpy).toHaveBeenCalledTimes(1);
		expect(unrelatedCloseSpy).not.toHaveBeenCalled();
		expect(session.providerSessionState.has(unrelatedKey)).toBe(true);
	});

	it("keeps cached state when switching models on the same (provider, baseUrl)", async () => {
		const deepseekPro = completionsModel("deepseek", "deepseek-v4-pro");
		const deepseekFlash = completionsModel("deepseek", "deepseek-v4-flash");
		expect(deepseekPro.provider).toBe(deepseekFlash.provider);
		expect(deepseekPro.baseUrl).toBe(deepseekFlash.baseUrl);

		session = buildSession(deepseekPro);

		const proCloseSpy = vi.fn();
		session.providerSessionState.set(completionsSessionKey(deepseekPro), {
			close: proCloseSpy,
		} satisfies ProviderSessionState);

		await session.setModel(deepseekFlash);

		expect(session.model?.id).toBe(deepseekFlash.id);
		expect(proCloseSpy).not.toHaveBeenCalled();
		expect(session.providerSessionState.has(completionsSessionKey(deepseekPro))).toBe(true);
	});
});
