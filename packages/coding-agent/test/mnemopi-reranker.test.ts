import { describe, expect, it } from "bun:test";
import type { ApiKeyResolver } from "@pk-nerdsaver-ai/pi-ai";
import { Settings } from "@pk-nerdsaver-ai/pi-coding-agent/config/settings";
import { mnemopiBackend } from "@pk-nerdsaver-ai/pi-coding-agent/mnemopi/backend";
import { loadMnemopiConfig } from "@pk-nerdsaver-ai/pi-coding-agent/mnemopi/config";
import {
	getMnemopiSessionState,
	loadMnemopi,
	loadMnemopiCore,
	MnemopiSessionState,
} from "@pk-nerdsaver-ai/pi-coding-agent/mnemopi/state";
import { withMnemopiRuntimeOptions } from "@pk-nerdsaver-ai/pi-mnemopi/core/runtime-options";
import { TempDir } from "@pk-nerdsaver-ai/pi-utils";

function openrouterResolverRegistry(resolver: ApiKeyResolver) {
	const resolverCalls: Array<{ provider: string; sessionId?: string }> = [];
	return {
		resolverCalls,
		modelRegistry: {
			hasConfiguredProviderAuth: (provider: string) => provider === "openrouter",
			resolver: (provider: string, options?: { sessionId?: string }) => {
				resolverCalls.push({ provider, sessionId: options?.sessionId });
				return resolver;
			},
		},
	};
}

await Promise.all([loadMnemopi(), loadMnemopiCore()]);

function loadConfig(overrides: Record<string, unknown> = {}) {
	const settings = Settings.isolated({ "mnemopi.scoping": "global", ...overrides });
	return loadMnemopiConfig(settings, "/tmp/mnemopi-reranker-config-test");
}

describe("loadMnemopiConfig reranker options", () => {
	it("leaves reranking unset unless a reranker setting is present", () => {
		const config = loadConfig();
		expect(config.providerOptions.reranker).toBeUndefined();
		expect(config.providerOptions.rerankerModel).toBeUndefined();
		expect(config.providerOptions.rerankerApiUrl).toBeUndefined();
		expect(config.providerOptions.rerankerApiKey).toBeUndefined();
	});

	it("propagates reranker model, URL, and key into provider options", () => {
		const config = loadConfig({
			"mnemopi.rerankerModel": "qwen/qwen3-reranker-8b",
			"mnemopi.rerankerApiUrl": "https://openrouter.ai/api/v1",
			"mnemopi.rerankerApiKey": "sk-or-test",
		});
		expect(config.providerOptions.rerankerModel).toBe("qwen/qwen3-reranker-8b");
		expect(config.providerOptions.rerankerApiUrl).toBe("https://openrouter.ai/api/v1");
		expect(config.providerOptions.rerankerApiKey).toBe("sk-or-test");
		expect(config.providerOptions.reranker).toEqual({
			model: "qwen/qwen3-reranker-8b",
			apiUrl: "https://openrouter.ai/api/v1",
			apiKey: "sk-or-test",
		});
	});

	it("keeps reranked order across scoped search and recall", async () => {
		const tempDir = TempDir.createSync(`@mnemopi-rerank-scope-${Date.now()}-`);
		const sessionId = "rerank-scope-session";
		const state = new MnemopiSessionState({
			sessionId,
			config: {
				dbPath: tempDir.join("mnemopi.db"),
				bank: "test-bank",
				autoRecall: false,
				autoRetain: false,
				polyphonicRecall: false,
				enhancedRecall: true,
				proactiveLinking: false,
				retainEveryNTurns: 3,
				recallLimit: 10,
				recallContextTurns: 1,
				recallMaxQueryChars: 800,
				injectionTokenLimit: 1024,
				debug: false,
				providerOptions: {
					noEmbeddings: true,
					llm: false,
					reranker: {
						provider: {
							rerank: async (_query, documents) =>
								documents.map((_, index) => ({
									index,
									relevanceScore: index,
								})),
						},
					},
				},
				llmMode: "none",
			},
			session: {
				sessionId,
				sessionManager: {
					getEntries: () => [],
					getCwd: () => "/tmp",
				},
				emitNotice: () => {},
				getHindsightSessionState: () => undefined,
			} as never,
		});
		try {
			state.memory.remember("alpha fruit salad");
			state.memory.remember("omega fruit salad");
			const localOrder = await withMnemopiRuntimeOptions({ reranker: { disabled: true } }, () =>
				state.memory.beam.recall("fruit salad", 5),
			);
			const results = await state.recallResultsScoped("fruit salad");
			expect(localOrder.length).toBe(2);
			expect(results.map(result => result.content)).toEqual([...localOrder].reverse().map(result => result.content));
			expect(results.every(result => typeof result.rerank_score === "number")).toBe(true);
		} finally {
			await state.dispose({ consolidate: false });
			await tempDir.remove();
		}
	});

	it("injects the OpenRouter key resolver when a reranker is enabled without an explicit key", async () => {
		const tempDir = TempDir.createSync(`@mnemopi-rerank-resolver-${Date.now()}-`);
		const resolver: ApiKeyResolver = async () => "resolved-openrouter-key";
		const { resolverCalls, modelRegistry } = openrouterResolverRegistry(resolver);
		const sessionId = "rerank-resolver-session";
		const settings = Settings.isolated({
			"mnemopi.scoping": "global",
			"mnemopi.noEmbeddings": true,
			"mnemopi.llmMode": "none",
			"mnemopi.dbPath": tempDir.join("mnemopi.db"),
			"mnemopi.rerankerModel": "qwen/qwen3-reranker-8b",
		});
		const session = {
			sessionId,
			sessionManager: {
				getEntries: () => [],
				getCwd: () => "/tmp",
			},
			emitNotice: () => {},
			settings,
		} as never;
		try {
			await mnemopiBackend.start({
				session,
				settings,
				modelRegistry: modelRegistry as never,
				agentDir: tempDir.path(),
				taskDepth: 0,
			});
			const state = getMnemopiSessionState(session);
			const reranker = state?.config.providerOptions.reranker;
			expect(reranker).toBeDefined();
			expect(reranker).not.toBe(false);
			if (reranker === undefined || reranker === false) {
				throw new Error("expected configured reranker options");
			}
			expect(reranker.apiKey).toBe(resolver);
			expect(
				resolverCalls.filter(call => call.provider === "openrouter" && call.sessionId === sessionId).length,
			).toBe(2);
		} finally {
			await getMnemopiSessionState(session)?.dispose({ consolidate: false });
			await tempDir.remove();
		}
	});

	it("does not inject the OpenRouter resolver for a non-OpenRouter reranker URL", async () => {
		const tempDir = TempDir.createSync(`@mnemopi-rerank-custom-url-${Date.now()}-`);
		const resolver: ApiKeyResolver = async () => "resolved-openrouter-key";
		const { resolverCalls, modelRegistry } = openrouterResolverRegistry(resolver);
		const sessionId = "rerank-custom-url-session";
		const settings = Settings.isolated({
			"mnemopi.scoping": "global",
			"mnemopi.noEmbeddings": true,
			"mnemopi.llmMode": "none",
			"mnemopi.dbPath": tempDir.join("mnemopi.db"),
			"mnemopi.rerankerModel": "qwen/qwen3-reranker-8b",
			"mnemopi.rerankerApiUrl": "http://127.0.0.1:9/v1",
		});
		const session = {
			sessionId,
			sessionManager: {
				getEntries: () => [],
				getCwd: () => "/tmp",
			},
			emitNotice: () => {},
			settings,
		} as never;
		try {
			await mnemopiBackend.start({
				session,
				settings,
				modelRegistry: modelRegistry as never,
				agentDir: tempDir.path(),
				taskDepth: 0,
			});
			const state = getMnemopiSessionState(session);
			const reranker = state?.config.providerOptions.reranker;
			expect(reranker).toBeDefined();
			expect(reranker).not.toBe(false);
			if (reranker === undefined || reranker === false) {
				throw new Error("expected configured reranker options");
			}
			expect(reranker.apiKey).toBeUndefined();
			expect(reranker.apiUrl).toBe("http://127.0.0.1:9/v1");
			expect(
				resolverCalls.filter(call => call.provider === "openrouter" && call.sessionId === sessionId).length,
			).toBe(1);
		} finally {
			await getMnemopiSessionState(session)?.dispose({ consolidate: false });
			await tempDir.remove();
		}
	});
});
