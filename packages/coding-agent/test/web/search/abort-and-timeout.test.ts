/**
 * Regression coverage for issue #1221: `web_search` froze when an upstream
 * provider stalled because Bun's WinHTTP fetch could ignore `AbortSignal`,
 * and `executeSearch` masked the eventual `AbortError` as a normal provider
 * failure.
 *
 * The fix has two halves: a hard-timeout safety net wrapped around every
 * provider's outbound fetch (via the shared `withHardTimeout` helper), and
 * an abort re-throw in the provider-fallback loop so the session sees a real
 * cancellation instead of "all providers failed". The provider wiring is
 * spot-checked on anthropic (LLM-backed) and brave (pure search API); the
 * helper itself is exercised directly.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import type { AuthStorage, FetchImpl } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ToolAbortError } from "@oh-my-pi/pi-coding-agent/tools/tool-errors";
import { runSearchQuery } from "@oh-my-pi/pi-coding-agent/web/search";
import * as provider from "@oh-my-pi/pi-coding-agent/web/search/provider";
import { searchAnthropic } from "@oh-my-pi/pi-coding-agent/web/search/providers/anthropic";
import type { SearchParams } from "@oh-my-pi/pi-coding-agent/web/search/providers/base";
import { searchBrave } from "@oh-my-pi/pi-coding-agent/web/search/providers/brave";
import { withHardTimeout } from "@oh-my-pi/pi-coding-agent/web/search/providers/utils";
import { SearchProviderError } from "@oh-my-pi/pi-coding-agent/web/search/types";
import { type SearchProviderId, type SearchResponse } from "@oh-my-pi/pi-coding-agent/web/search/types";
import { createInMemoryAuthStorage } from "../../helpers/agent-session-setup";

import {
	cfgProvidersWebSearchTimeoutSeconds,
	cfgRetryFallbackChains,
} from "@oh-my-pi/pi-coding-agent/session/settings";

const openAuthStorages: AuthStorage[] = [];

function createSearchContext(modelProvider: string, modelId: string) {
	const authStorage = createInMemoryAuthStorage();
	openAuthStorages.push(authStorage);
	const modelRegistry = new ModelRegistry(authStorage);
	const model = modelRegistry.find(modelProvider, modelId);
	if (!model) throw new Error(`Missing catalog model: ${modelProvider}/${modelId}`);
	return { authStorage, modelRegistry, model };
}

describe("withHardTimeout", () => {
	it("returns a signal that aborts on the hard timeout when no caller signal is supplied", async () => {
		const signal = withHardTimeout(undefined, 10);
		await Bun.sleep(40);
		expect(signal.aborted).toBe(true);
	});

	it("forwards a caller signal's abort to the composed signal", () => {
		const ac = new AbortController();
		const signal = withHardTimeout(ac.signal, 60_000);
		ac.abort(new Error("user-cancel"));
		expect(signal.aborted).toBe(true);
	});

	it("fires the hard timeout even when the caller signal stays open", async () => {
		const ac = new AbortController();
		const signal = withHardTimeout(ac.signal, 10);
		await Bun.sleep(40);
		expect(signal.aborted).toBe(true);
		expect(ac.signal.aborted).toBe(false);
	});
});

describe("Anthropic provider hard-timeout wiring", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		for (const authStorage of openAuthStorages.splice(0)) authStorage.close();
	});

	it("passes a composed signal to fetch even when the caller did not supply one", async () => {
		const context = createSearchContext("anthropic", "claude-sonnet-4-5");
		context.authStorage.keys.setRuntime("anthropic", "sk-test");

		let capturedSignal: AbortSignal | null | undefined;
		const fetchMock: FetchImpl = async (_input, init) => {
			capturedSignal = init?.signal;
			return new Response(JSON.stringify({ content: [{ type: "text", text: "ok" }], usage: {} }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		};

		await searchAnthropic({ query: "ping", systemPrompt: "", fetch: fetchMock, ...context });

		// Without the hard-timeout wrapper, init.signal would be undefined when
		// the caller didn't supply one — leaving fetch with no cancellation at
		// all on a stalled WinHTTP connection.
		expect(capturedSignal).toBeInstanceOf(AbortSignal);
		expect(capturedSignal?.aborted).toBe(false);
	});

	it("composes the caller signal with the hard timeout instead of forwarding it directly", async () => {
		const context = createSearchContext("anthropic", "claude-sonnet-4-5");
		context.authStorage.keys.setRuntime("anthropic", "sk-test");

		const ac = new AbortController();
		let capturedSignal: AbortSignal | null | undefined;
		const fetchMock: FetchImpl = async (_input, init) => {
			capturedSignal = init?.signal;
			return new Response(JSON.stringify({ content: [{ type: "text", text: "ok" }], usage: {} }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		};

		await searchAnthropic({ query: "ping", systemPrompt: "", signal: ac.signal, fetch: fetchMock, ...context });

		// The signal handed to fetch must be a *composed* one, not the raw
		// caller signal: that's what guarantees the hard timeout fires even
		// when Bun fails to honour the caller's abort.
		expect(capturedSignal).toBeInstanceOf(AbortSignal);
		expect(capturedSignal).not.toBe(ac.signal);
	});
});

describe("Brave provider hard-timeout wiring", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		for (const authStorage of openAuthStorages.splice(0)) authStorage.close();
	});

	it("hands fetch a composed signal even with no caller signal — confirms the rollout reaches non-Anthropic providers", async () => {
		const context = createSearchContext("web", "brave");
		context.authStorage.keys.setRuntime("brave", "brave-test-key");
		let capturedSignal: AbortSignal | null | undefined;
		const fetchMock: FetchImpl = async (_input, init) => {
			capturedSignal = init?.signal;
			return new Response(JSON.stringify({ web: { results: [] } }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		};

		await searchBrave({
			query: "ping",
			fetch: fetchMock,
			authStorage: context.authStorage,
		});

		expect(capturedSignal).toBeInstanceOf(AbortSignal);
		expect(capturedSignal?.aborted).toBe(false);
	});
});

describe("executeSearch abort propagation", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		resetSettingsForTest();
		for (const authStorage of openAuthStorages.splice(0)) authStorage.close();
	});

	function fakeProvider(
		id: SearchProviderId,
		behaviour: (params: SearchParams) => Promise<SearchResponse>,
		available = true,
	): provider.SearchProvider {
		return {
			id,
			label: id,
			isAvailable: () => available,
			isExplicitlyAvailable: () => available,
			search: behaviour,
		};
	}

	async function configureProviderChain(providers: provider.SearchProvider[]) {
		const primary = providers[0];
		if (!primary) throw new Error("Provider chain must contain a primary candidate");
		const config = await Settings.init({ inMemory: true });
		config.setModelRole("web", `web/${primary.id}`);
		cfgRetryFallbackChains.set(config, { web: providers.slice(1).map(candidate => `web/${candidate.id}`) });
		const authStorage = createInMemoryAuthStorage();
		openAuthStorages.push(authStorage);
		const modelRegistry = new ModelRegistry(authStorage, undefined, { settings: config });
		const getProvider = vi.spyOn(provider, "getSearchProvider").mockImplementation(async id => {
			const match = providers.find(candidate => candidate.id === id);
			if (!match) throw new Error(`Unexpected provider: ${id}`);
			return match;
		});
		return { authStorage, modelRegistry, getProvider };
	}

	it("prefers grounded search matching the active model's grounding family when the web role is not configured", async () => {
		const config = await Settings.init({ inMemory: true });
		const authStorage = createInMemoryAuthStorage();
		openAuthStorages.push(authStorage);
		authStorage.keys.setRuntime("anthropic", "test-anthropic-key");
		authStorage.keys.setRuntime("openai-codex", "test-codex-token");
		const modelRegistry = new ModelRegistry(authStorage, undefined, { settings: config });
		const codexModel = modelRegistry.find("openai-codex", "gpt-5.6-sol");
		const anthropicModel = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		const hostedClaudeModel = modelRegistry.find("gitlab-duo", "duo-chat-sonnet-4-6");
		if (!codexModel || !anthropicModel || !hostedClaudeModel) {
			throw new Error("Bundled Codex, Anthropic, or GitLab Duo model missing");
		}
		const anthropicSearch = vi.fn(async (): Promise<SearchResponse> => ({
			provider: "anthropic",
			sources: [{ title: "Anthropic result", url: "https://example.com/anthropic" }],
		}));
		const codexSearch = vi.fn(async (): Promise<SearchResponse> => ({
			provider: "codex",
			sources: [{ title: "OpenAI result", url: "https://example.com/openai" }],
		}));
		vi.spyOn(provider, "getSearchProvider").mockImplementation(async id => {
			const providerId = id as SearchProviderId;
			return fakeProvider(providerId, async () => ({ provider: providerId, sources: [] }), false);
		});
		vi.spyOn(provider, "getGroundedSearchProvider").mockImplementation(async grounding => {
			if (grounding === "anthropic") return fakeProvider("anthropic", anthropicSearch);
			if (grounding === "codex") return fakeProvider("codex", codexSearch);
			return fakeProvider(grounding, async () => ({ provider: grounding, sources: [] }), false);
		});

		const codexResult = await runSearchQuery(
			{ query: "anything" },
			{ authStorage, modelRegistry, activeModel: codexModel },
		);

		expect(codexResult.details.response.provider).toBe("codex");
		expect(codexSearch).toHaveBeenCalledTimes(1);
		expect(anthropicSearch).not.toHaveBeenCalled();

		codexSearch.mockClear();
		anthropicSearch.mockClear();
		const anthropicResult = await runSearchQuery(
			{ query: "anything" },
			{ authStorage, modelRegistry, activeModel: anthropicModel },
		);

		expect(anthropicResult.details.response.provider).toBe("anthropic");
		expect(anthropicSearch).toHaveBeenCalledTimes(1);
		expect(codexSearch).not.toHaveBeenCalled();

		codexSearch.mockClear();
		anthropicSearch.mockClear();
		const hostedClaudeResult = await runSearchQuery(
			{ query: "anything" },
			{ authStorage, modelRegistry, activeModel: hostedClaudeModel },
		);

		expect(hostedClaudeResult.details.response.provider).toBe("anthropic");
		expect(anthropicSearch).toHaveBeenCalledTimes(1);
		expect(codexSearch).not.toHaveBeenCalled();
	});

	it("passes the configured provider-request timeout into the search adapter", async () => {
		let timeoutMs: number | undefined;
		const context = await configureProviderChain([
			fakeProvider("brave", async params => {
				timeoutMs = params.timeoutMs;
				return {
					provider: "brave",
					sources: [{ title: "Configured result", url: "https://example.com/configured" }],
				};
			}),
		]);
		const config = await Settings.init({ inMemory: true });
		config.setModelRole("web", "web/brave");
		cfgRetryFallbackChains.set(config, { web: [] });
		cfgProvidersWebSearchTimeoutSeconds.set(config, 180);

		const result = await runSearchQuery({ query: "anything" }, context);

		expect(result.details.response.provider).toBe("brave");
		expect(timeoutMs).toBe(180_000);
	});

	it("caps the configured provider-request timeout at five minutes", async () => {
		let timeoutMs: number | undefined;
		const context = await configureProviderChain([
			fakeProvider("brave", async params => {
				timeoutMs = params.timeoutMs;
				return {
					provider: "brave",
					sources: [{ title: "Capped result", url: "https://example.com/capped" }],
				};
			}),
		]);
		const config = await Settings.init({ inMemory: true });
		config.setModelRole("web", "web/brave");
		cfgRetryFallbackChains.set(config, { web: [] });
		cfgProvidersWebSearchTimeoutSeconds.set(config, 600);

		await runSearchQuery({ query: "anything" }, context);

		expect(timeoutMs).toBe(300_000);
	});

	it("uses the default provider timeout for a non-positive setting", async () => {
		let timeoutMs: number | undefined;
		const context = await configureProviderChain([
			fakeProvider("brave", async params => {
				timeoutMs = params.timeoutMs;
				return {
					provider: "brave",
					sources: [{ title: "Default result", url: "https://example.com/default" }],
				};
			}),
		]);
		const config = await Settings.init({ inMemory: true });
		config.setModelRole("web", "web/brave");
		cfgRetryFallbackChains.set(config, { web: [] });
		cfgProvidersWebSearchTimeoutSeconds.set(config, 0);

		await runSearchQuery({ query: "anything" }, context);

		expect(timeoutMs).toBe(60_000);
	});

	it("surfaces caller cancellation instead of falling through to the next role candidate", async () => {
		const fallbackSearch = vi.fn();
		const context = await configureProviderChain([
			fakeProvider("brave", async () => {
				throw new DOMException("aborted", "AbortError");
			}),
			fakeProvider("exa", fallbackSearch),
		]);
		const ac = new AbortController();
		ac.abort();

		await expect(runSearchQuery({ query: "anything" }, { ...context, signal: ac.signal })).rejects.toBeInstanceOf(
			ToolAbortError,
		);
		expect(fallbackSearch).not.toHaveBeenCalled();
	});

	it("still reports provider failures when the caller has not aborted", async () => {
		const context = await configureProviderChain([
			fakeProvider("brave", async () => {
				throw new Error("upstream 500");
			}),
		]);

		const result = await runSearchQuery({ query: "anything" }, context);

		expect(result.content[0]?.text).toContain("upstream 500");
		expect(result.details.error).toContain("upstream 500");
	});

	it("falls through when the configured role candidate returns no renderable content", async () => {
		const emptySearch = vi.fn(async (): Promise<SearchResponse> => ({ provider: "searxng", sources: [] }));
		const fallbackSearch = vi.fn(async (): Promise<SearchResponse> => ({
			provider: "brave",
			sources: [{ title: "Fallback result", url: "https://example.com/fallback", snippet: "fallback body" }],
		}));
		const context = await configureProviderChain([
			fakeProvider("searxng", emptySearch),
			fakeProvider("brave", fallbackSearch),
		]);

		const result = await runSearchQuery({ query: "anything" }, context);

		expect(emptySearch).toHaveBeenCalledTimes(1);
		expect(fallbackSearch).toHaveBeenCalledTimes(1);
		expect(result.content[0]?.text).toContain("Fallback result");
		expect(result.details.response.provider).toBe("brave");
	});

	it("stops loading the role chain after the preferred candidate succeeds", async () => {
		const fallbackSearch = vi.fn();
		const context = await configureProviderChain([
			fakeProvider("exa", async () => ({
				provider: "exa",
				sources: [{ title: "Preferred result", url: "https://example.com/preferred" }],
			})),
			fakeProvider("duckduckgo", fallbackSearch),
		]);

		const result = await runSearchQuery({ query: "anything" }, context);

		expect(result.details.response.provider).toBe("exa");
		expect(context.getProvider).toHaveBeenCalledTimes(1);
		expect(context.getProvider).toHaveBeenCalledWith("exa");
		expect(fallbackSearch).not.toHaveBeenCalled();
	});

	it("advances through retry.fallbackChains.web after the preferred candidate fails", async () => {
		const fallbackSearch = vi.fn(async (): Promise<SearchResponse> => ({
			provider: "brave",
			sources: [{ title: "Fallback result", url: "https://example.com/fallback" }],
		}));
		const context = await configureProviderChain([
			fakeProvider("exa", async () => {
				throw new SearchProviderError("exa", "Preferred provider failed.", 500);
			}),
			fakeProvider("brave", fallbackSearch),
		]);

		const result = await runSearchQuery({ query: "anything" }, context);

		expect(result.details.response.provider).toBe("brave");
		expect(context.getProvider).toHaveBeenCalledTimes(2);
		expect(fallbackSearch).toHaveBeenCalledTimes(1);
	});

	it("treats a request model override as a single explicit candidate", async () => {
		const fallbackSearch = vi.fn(async (): Promise<SearchResponse> => ({
			provider: "brave",
			sources: [{ title: "Hidden fallback", url: "https://example.com/fallback" }],
		}));
		const context = await configureProviderChain([
			fakeProvider("exa", async () => {
				throw new SearchProviderError("exa", "Explicit Exa search failed.", 400);
			}),
			fakeProvider("brave", fallbackSearch),
		]);

		const result = await runSearchQuery({ query: "anything", model: "web/exa" }, context);

		expect(result.details.error).toContain("Explicit Exa search failed.");
		expect(result.details.response.provider).toBe("exa");
		expect(context.getProvider).toHaveBeenCalledTimes(1);
		expect(fallbackSearch).not.toHaveBeenCalled();
	});
});
