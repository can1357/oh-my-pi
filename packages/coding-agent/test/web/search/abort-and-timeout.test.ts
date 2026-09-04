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
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { ToolAbortError } from "@oh-my-pi/pi-coding-agent/tools/tool-errors";
import { runSearchQuery, WebSearchTool } from "@oh-my-pi/pi-coding-agent/web/search";
import * as provider from "@oh-my-pi/pi-coding-agent/web/search/provider";
import { searchAnthropic } from "@oh-my-pi/pi-coding-agent/web/search/providers/anthropic";
import type { SearchParams } from "@oh-my-pi/pi-coding-agent/web/search/providers/base";
import { searchBrave } from "@oh-my-pi/pi-coding-agent/web/search/providers/brave";
import { withHardTimeout } from "@oh-my-pi/pi-coding-agent/web/search/providers/utils";
import {
	SearchProviderError,
	type SearchProviderId,
	type SearchResponse,
} from "@oh-my-pi/pi-coding-agent/web/search/types";

const FAKE_SESSION = {} as ToolSession;
const fakeStorage = {
	listAuthCredentials: () => [],
	updateAuthCredential: () => undefined,
	get authStore() {
		return null as never;
	},
} as unknown as AgentStorage;

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
		delete process.env.ANTHROPIC_SEARCH_API_KEY;
		delete process.env.ANTHROPIC_SEARCH_BASE_URL;
	});

	it("passes a composed signal to fetch even when the caller did not supply one", async () => {
		process.env.ANTHROPIC_SEARCH_API_KEY = "sk-test";

		let capturedSignal: AbortSignal | null | undefined;
		const fetchMock: FetchImpl = async (_input, init) => {
			capturedSignal = init?.signal;
			return new Response(JSON.stringify({ content: [{ type: "text", text: "ok" }], usage: {} }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		};

		await searchAnthropic({ query: "ping", system_prompt: "", fetch: fetchMock }, fakeStorage);

		// Without the hard-timeout wrapper, init.signal would be undefined when
		// the caller didn't supply one — leaving fetch with no cancellation at
		// all on a stalled WinHTTP connection.
		expect(capturedSignal).toBeInstanceOf(AbortSignal);
		expect(capturedSignal?.aborted).toBe(false);
	});

	it("composes the caller signal with the hard timeout instead of forwarding it directly", async () => {
		process.env.ANTHROPIC_SEARCH_API_KEY = "sk-test";

		const ac = new AbortController();
		let capturedSignal: AbortSignal | null | undefined;
		const fetchMock: FetchImpl = async (_input, init) => {
			capturedSignal = init?.signal;
			return new Response(JSON.stringify({ content: [{ type: "text", text: "ok" }], usage: {} }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		};

		await searchAnthropic({ query: "ping", system_prompt: "", signal: ac.signal, fetch: fetchMock }, fakeStorage);

		// The signal handed to fetch must be a *composed* one, not the raw
		// caller signal: that's what guarantees the hard timeout fires even
		// when Bun fails to honour the caller's abort.
		expect(capturedSignal).toBeInstanceOf(AbortSignal);
		expect(capturedSignal).not.toBe(ac.signal);
	});
	it("applies ANTHROPIC_SEARCH_BASE_URL to stored Anthropic credentials", async () => {
		process.env.ANTHROPIC_SEARCH_BASE_URL = "https://search.example.test/";

		let capturedUrl: string | undefined;
		const fetchMock: FetchImpl = async input => {
			capturedUrl = String(input);
			return new Response(JSON.stringify({ content: [{ type: "text", text: "ok" }], usage: {} }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		};

		await searchAnthropic({
			query: "ping",
			systemPrompt: "",
			fetch: fetchMock,
			authStorage: {
				getApiKey: async () => "sk-fallback",
				resolver: vi.fn(() => async () => "sk-fallback"),
				getOAuthAccountId: () => undefined,
			} as unknown as AuthStorage,
		});

		expect(capturedUrl).toBe("https://search.example.test/v1/messages?beta=true");
	});
});

describe("Brave provider hard-timeout wiring", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		delete process.env.BRAVE_API_KEY;
	});

	it("hands fetch a composed signal even with no caller signal — confirms the rollout reaches non-Anthropic providers", async () => {
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
			authStorage: {
				resolver: vi.fn(() => async () => "brave-test-key"),
			} as unknown as AuthStorage,
		});

		expect(capturedSignal).toBeInstanceOf(AbortSignal);
		expect(capturedSignal?.aborted).toBe(false);
	});
});

describe("executeSearch abort propagation", () => {
	afterEach(() => {
		vi.restoreAllMocks();
		resetSettingsForTest();
	});

	function fakeProvider(
		id: SearchProviderId,
		behaviour: (params: SearchParams) => Promise<SearchResponse>,
	): provider.SearchProvider {
		return {
			id,
			label: id,
			isAvailable: () => true,
			isExplicitlyAvailable: () => true,
			search: behaviour,
		};
	}

	function mockProviderChain(providers: provider.SearchProvider[], options?: { explicitFirst?: boolean }) {
		vi.spyOn(provider, "resolveProviderCandidates").mockReturnValue(
			providers.map(({ id }, index) => ({ id, explicit: options?.explicitFirst === true && index === 0 })),
		);
		return vi.spyOn(provider, "getSearchProvider").mockImplementation(async id => {
			const match = providers.find(candidate => candidate.id === id);
			if (!match) throw new Error(`Unexpected provider: ${id}`);
			return match;
		});
	}

	it("passes the configured provider-request timeout into the search adapter", async () => {
		resetSettingsForTest();
		const config = await Settings.init({ inMemory: true });
		config.set("providers.webSearchTimeoutSeconds", 180);
		let timeoutMs: number | undefined;
		mockProviderChain([
			fakeProvider("codex", async params => {
				timeoutMs = params.timeoutMs;
				return {
					provider: "codex",
					sources: [{ title: "Configured result", url: "https://example.com/configured" }],
				};
			}),
		]);

		const result = await new WebSearchTool(FAKE_SESSION).execute("test-id", { query: "anything" });

		expect(result.details?.response.provider).toBe("codex");
		expect(timeoutMs).toBe(180_000);
	});

	it("caps the configured provider-request timeout at five minutes", async () => {
		resetSettingsForTest();
		const config = await Settings.init({ inMemory: true });
		config.set("providers.webSearchTimeoutSeconds", 600);
		let timeoutMs: number | undefined;
		mockProviderChain([
			fakeProvider("codex", async params => {
				timeoutMs = params.timeoutMs;
				return {
					provider: "codex",
					sources: [{ title: "Capped result", url: "https://example.com/capped" }],
				};
			}),
		]);

		await new WebSearchTool(FAKE_SESSION).execute("test-id", { query: "anything" });

		expect(timeoutMs).toBe(300_000);
	});

	it("uses the default provider timeout for a non-positive setting", async () => {
		resetSettingsForTest();
		const config = await Settings.init({ inMemory: true });
		config.set("providers.webSearchTimeoutSeconds", 0);
		let timeoutMs: number | undefined;
		mockProviderChain([
			fakeProvider("codex", async params => {
				timeoutMs = params.timeoutMs;
				return {
					provider: "codex",
					sources: [{ title: "Default result", url: "https://example.com/default" }],
				};
			}),
		]);

		await new WebSearchTool(FAKE_SESSION).execute("test-id", { query: "anything" });

		expect(timeoutMs).toBe(60_000);
	});

	it("surfaces caller cancellation as ToolAbortError instead of falling through to the next provider", async () => {
		// Two providers: the first throws an AbortError after the caller aborted,
		// the second would happily return a value. Pre-fix, executeSearch would
		// fall through to provider B and report success; post-fix, the abort
		// re-throw stops the loop immediately.
		const secondProviderSearch = vi.fn();
		mockProviderChain([
			fakeProvider("anthropic", async () => {
				throw new DOMException("aborted", "AbortError");
			}),
			fakeProvider("brave", secondProviderSearch),
		]);

		const tool = new WebSearchTool(FAKE_SESSION);
		const ac = new AbortController();
		ac.abort();

		await expect(tool.execute("test-id", { query: "anything" }, ac.signal)).rejects.toBeInstanceOf(ToolAbortError);
		expect(secondProviderSearch).not.toHaveBeenCalled();
	});

	it("still reports provider failures as a tool result when the caller has not aborted", async () => {
		// Defensive: the abort re-throw must NOT alter normal provider-error
		// flow. A genuine provider error should still produce an error result
		// rather than throwing.
		mockProviderChain([
			fakeProvider("anthropic", async () => {
				throw new Error("upstream 500");
			}),
		]);

		const tool = new WebSearchTool(FAKE_SESSION);
		const result = await tool.execute("test-id", { query: "anything" });
		const block = result.content[0];
		expect(block?.type).toBe("text");
		expect(block && "text" in block ? block.text : "").toContain("upstream 500");
		expect(result.details?.error).toContain("upstream 500");
	});

	it("falls through when a provider returns no renderable search content", async () => {
		const emptyProviderSearch = vi.fn(async (): Promise<SearchResponse> => ({
			provider: "searxng",
			sources: [],
		}));
		const sourceProviderSearch = vi.fn(async (): Promise<SearchResponse> => ({
			provider: "brave",
			sources: [{ title: "Fallback result", url: "https://example.com/fallback", snippet: "fallback body" }],
		}));
		mockProviderChain([fakeProvider("searxng", emptyProviderSearch), fakeProvider("brave", sourceProviderSearch)]);

		const tool = new WebSearchTool(FAKE_SESSION);
		const result = await tool.execute("test-id", { query: "anything" });

		expect(emptyProviderSearch).toHaveBeenCalledTimes(1);
		expect(sourceProviderSearch).toHaveBeenCalledTimes(1);
		const block = result.content[0];
		expect(block?.type).toBe("text");
		expect(block && "text" in block ? block.text : "").toContain("Fallback result");
		expect(result.details?.response.provider).toBe("brave");
	});

	it("does not load fallback providers after the preferred provider succeeds", async () => {
		const fallbackSearch = vi.fn();
		const getProvider = mockProviderChain([
			fakeProvider("exa", async () => ({
				provider: "exa",
				sources: [{ title: "Preferred result", url: "https://example.com/preferred" }],
			})),
			fakeProvider("duckduckgo", fallbackSearch),
		]);

		const tool = new WebSearchTool(FAKE_SESSION);
		const result = await tool.execute("test-id", { query: "anything" });

		expect(result.details?.response.provider).toBe("exa");
		expect(getProvider).toHaveBeenCalledTimes(1);
		expect(getProvider).toHaveBeenCalledWith("exa");
		expect(fallbackSearch).not.toHaveBeenCalled();
	});

	it("falls through after the preferred provider fails", async () => {
		const fallbackSearch = vi.fn(async (): Promise<SearchResponse> => ({
			provider: "brave",
			sources: [{ title: "Fallback result", url: "https://example.com/fallback" }],
		}));
		const getProvider = mockProviderChain(
			[
				fakeProvider("exa", async () => {
					throw new SearchProviderError("exa", "Preferred provider failed.", 500);
				}),
				fakeProvider("brave", fallbackSearch),
			],
			{ explicitFirst: true },
		);

		const tool = new WebSearchTool(FAKE_SESSION);
		const result = await tool.execute("test-id", { query: "anything" });

		expect(result.details?.response.provider).toBe("brave");
		expect(getProvider).toHaveBeenCalledTimes(2);
		expect(fallbackSearch).toHaveBeenCalledTimes(1);
	});

	it("does not fall through after an explicitly selected provider fails", async () => {
		const fallbackSearch = vi.fn(async (): Promise<SearchResponse> => ({
			provider: "brave",
			sources: [{ title: "Hidden fallback", url: "https://example.com/fallback" }],
		}));
		const getProvider = mockProviderChain(
			[
				fakeProvider("codex", async () => {
					throw new SearchProviderError("codex", "Configured Codex endpoint does not support web_search.", 400);
				}),
				fakeProvider("brave", fallbackSearch),
			],
			{ explicitFirst: true },
		);

		const result = await runSearchQuery({ query: "anything", provider: "codex" }, { authStorage: {} as AuthStorage });

		expect(result.details?.error).toContain("Configured Codex endpoint does not support web_search.");
		expect(result.details?.response.provider).toBe("codex");
		expect(getProvider).toHaveBeenCalledTimes(1);
		expect(fallbackSearch).not.toHaveBeenCalled();
	});
});
