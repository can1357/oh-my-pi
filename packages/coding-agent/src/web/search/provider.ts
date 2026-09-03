// Lazy registry of web search providers.
//
// Each provider is loaded on first use; importing this module loads zero
// provider implementations. Provider modules are heavy (each pulls in
// fetch/parse/format helpers) and only one — at most — is needed per session,
// so eager construction was wasted work at startup.
//
// Provider modules are loaded lazily; display metadata lives in types.ts so UI
// listings can share it without importing provider implementations.

import type { AuthStorage } from "@oh-my-pi/pi-ai";
import type { SearchProvider } from "./providers/base";
import { SEARCH_PROVIDER_LABELS, SEARCH_PROVIDER_ORDER, SearchProviderError, type SearchProviderId } from "./types";

export type { SearchParams } from "./providers/base";
export { SearchProvider } from "./providers/base";
export { SEARCH_PROVIDER_ORDER } from "./types";

interface ProviderMeta {
	id: SearchProviderId;
	label: string;
	load: () => Promise<SearchProvider>;
}

/** Lazy factories. Each `load()` dynamic-imports its provider module on first call. */
const PROVIDER_META: Record<SearchProviderId, ProviderMeta> = {
	perplexity: {
		id: "perplexity",
		label: SEARCH_PROVIDER_LABELS.perplexity,
		load: async () => new (await import("./providers/perplexity")).PerplexityProvider(),
	},
	gemini: {
		id: "gemini",
		label: SEARCH_PROVIDER_LABELS.gemini,
		load: async () => new (await import("./providers/gemini")).GeminiProvider(),
	},
	anthropic: {
		id: "anthropic",
		label: SEARCH_PROVIDER_LABELS.anthropic,
		load: async () => new (await import("./providers/anthropic")).AnthropicProvider(),
	},
	codex: {
		id: "codex",
		label: SEARCH_PROVIDER_LABELS.codex,
		load: async () => new (await import("./providers/codex")).CodexProvider(),
	},
	xai: {
		id: "xai",
		label: SEARCH_PROVIDER_LABELS.xai,
		load: async () => new (await import("./providers/xai")).XAIProvider(),
	},
	zai: {
		id: "zai",
		label: SEARCH_PROVIDER_LABELS.zai,
		load: async () => new (await import("./providers/zai")).ZaiProvider(),
	},
	exa: {
		id: "exa",
		label: SEARCH_PROVIDER_LABELS.exa,
		load: async () => new (await import("./providers/exa")).ExaProvider(),
	},
	tinyfish: {
		id: "tinyfish",
		label: SEARCH_PROVIDER_LABELS.tinyfish,
		load: async () => new (await import("./providers/tinyfish")).TinyFishProvider(),
	},
	jina: {
		id: "jina",
		label: SEARCH_PROVIDER_LABELS.jina,
		load: async () => new (await import("./providers/jina")).JinaProvider(),
	},
	kagi: {
		id: "kagi",
		label: SEARCH_PROVIDER_LABELS.kagi,
		load: async () => new (await import("./providers/kagi")).KagiProvider(),
	},
	tavily: {
		id: "tavily",
		label: SEARCH_PROVIDER_LABELS.tavily,
		load: async () => new (await import("./providers/tavily")).TavilyProvider(),
	},
	firecrawl: {
		id: "firecrawl",
		label: SEARCH_PROVIDER_LABELS.firecrawl,
		load: async () => new (await import("./providers/firecrawl")).FirecrawlProvider(),
	},
	brave: {
		id: "brave",
		label: SEARCH_PROVIDER_LABELS.brave,
		load: async () => new (await import("./providers/brave")).BraveProvider(),
	},
	kimi: {
		id: "kimi",
		label: SEARCH_PROVIDER_LABELS.kimi,
		load: async () => new (await import("./providers/kimi")).KimiProvider(),
	},
	parallel: {
		id: "parallel",
		label: SEARCH_PROVIDER_LABELS.parallel,
		load: async () => new (await import("./providers/parallel")).ParallelProvider(),
	},
	synthetic: {
		id: "synthetic",
		label: SEARCH_PROVIDER_LABELS.synthetic,
		load: async () => new (await import("./providers/synthetic")).SyntheticProvider(),
	},
	searxng: {
		id: "searxng",
		label: SEARCH_PROVIDER_LABELS.searxng,
		load: async () => new (await import("./providers/searxng")).SearXNGProvider(),
	},
	duckduckgo: {
		id: "duckduckgo",
		label: SEARCH_PROVIDER_LABELS.duckduckgo,
		load: async () => new (await import("./providers/duckduckgo")).DuckDuckGoProvider(),
	},
	google: {
		id: "google",
		label: SEARCH_PROVIDER_LABELS.google,
		load: async () => new (await import("./providers/google")).GoogleProvider(),
	},
	ecosia: {
		id: "ecosia",
		label: SEARCH_PROVIDER_LABELS.ecosia,
		load: async () => new (await import("./providers/ecosia")).EcosiaProvider(),
	},
	startpage: {
		id: "startpage",
		label: SEARCH_PROVIDER_LABELS.startpage,
		load: async () => new (await import("./providers/startpage")).StartpageProvider(),
	},
	mojeek: {
		id: "mojeek",
		label: SEARCH_PROVIDER_LABELS.mojeek,
		load: async () => new (await import("./providers/mojeek")).MojeekProvider(),
	},
	public: {
		id: "public",
		label: SEARCH_PROVIDER_LABELS.public,
		load: async () => new (await import("./providers/public")).PublicWebProvider(),
	},
};

const instanceCache = new Map<SearchProviderId, SearchProvider>();

/** Cheap, sync metadata accessor — never triggers a provider load. */
export function getSearchProviderLabel(id: SearchProviderId): string {
	return PROVIDER_META[id]?.label ?? id;
}

/** Format one provider failure for the user-facing fallback summary. */
export function formatSearchProviderFailure(error: unknown, provider: Pick<SearchProvider, "id" | "label">): string {
	if (error instanceof SearchProviderError) {
		if (error.provider === "anthropic" && error.status === 404) {
			return "Anthropic web search returned 404 (model or endpoint not found).";
		}
		if (error.status === 401 || error.status === 403) {
			if (error.provider === "zai") {
				return error.message;
			}
			return `${getSearchProviderLabel(error.provider)} authorization failed (${error.status}). Check API key or base URL.`;
		}
		return error.message;
	}
	if (error instanceof Error) return error.message;
	return `Unknown error from ${provider.label}`;
}

/** Format the ordered provider fallback failures for terminal/tool output. */
export function formatSearchProviderFailures(
	failures: readonly { provider: Pick<SearchProvider, "id" | "label">; error: unknown }[],
): string {
	return failures.map(f => `${f.provider.id}: ${formatSearchProviderFailure(f.error, f.provider)}`).join("; ");
}

/**
 * Resolve and cache a provider instance. First call for a given id loads the
 * underlying module; subsequent calls return the cached singleton.
 */
export async function getSearchProvider(id: SearchProviderId): Promise<SearchProvider> {
	const cached = instanceCache.get(id);
	if (cached) return cached;
	const meta = PROVIDER_META[id];
	if (!meta) {
		throw new Error(`Unknown search provider: ${id}`);
	}
	const provider = await meta.load();
	instanceCache.set(id, provider);
	return provider;
}

/** Provider fallback order set via settings (default: built-in order). */
let orderedProvIds: readonly SearchProviderId[] = SEARCH_PROVIDER_ORDER;
/** Providers the user explicitly listed in `providers.webSearchOrder`. */
let explicitProvIds = new Set<SearchProviderId>();

/**
 * Prioritize configured providers while retaining every unlisted provider in
 * its built-in relative order. Invalid IDs are ignored defensively. Listed
 * providers are treated as explicit selections: they resolve through
 * `isExplicitlyAvailable`, so e.g. a hand-listed Perplexity may fall back to
 * anonymous search exactly like the retired single-preference setting did.
 */
export function setSearchProviderOrder(providers: readonly SearchProviderId[]): void {
	const prioritized = new Set(providers.filter(id => SEARCH_PROVIDER_ORDER.includes(id)));
	explicitProvIds = prioritized;
	orderedProvIds =
		prioritized.size === 0
			? SEARCH_PROVIDER_ORDER
			: [...prioritized, ...SEARCH_PROVIDER_ORDER.filter(id => !prioritized.has(id))];
}

/** Providers excluded from web search resolution via settings. */
let excludedProvIds = new Set<SearchProviderId>();

/** Set providers that web search should never use, including fallbacks. */
export function setExcludedSearchProviders(providers: readonly SearchProviderId[]): void {
	excludedProvIds = new Set(providers);
}

/** `true` when settings exclude `id` from web search (auto chain and the Public Web fan-out). */
export function isSearchProviderExcluded(id: SearchProviderId): boolean {
	return excludedProvIds.has(id);
}

export interface SearchProviderCandidate {
	id: SearchProviderId;
	explicit: boolean;
}

/**
 * Return provider candidates in fallback order without loading their modules.
 * `forcedProvider` (a per-request `provider` argument) is terminal-first and
 * bypasses exclusion; configured-order entries carry `explicit: true`.
 */
export function resolveProviderCandidates(forcedProvider?: SearchProviderId): SearchProviderCandidate[] {
	const candidates: SearchProviderCandidate[] = [];

	if (forcedProvider !== undefined && !isSearchProviderExcluded(forcedProvider)) {
		candidates.push({ id: forcedProvider, explicit: true });
	}

	for (const id of orderedProvIds) {
		if (id === forcedProvider || isSearchProviderExcluded(id)) continue;
		candidates.push({ id, explicit: explicitProvIds.has(id) });
	}

	return candidates;
}

/**
 * Resolve the complete available provider chain.
 *
 * This compatibility helper loads every candidate. Search execution should use
 * {@link resolveProviderCandidates} so fallback modules load only when reached.
 */
export async function resolveProviderChain(
	authStorage: AuthStorage,
	forcedProvider?: SearchProviderId,
): Promise<SearchProvider[]> {
	const providers: SearchProvider[] = [];

	for (const candidate of resolveProviderCandidates(forcedProvider)) {
		const provider = await getSearchProvider(candidate.id);
		const available = candidate.explicit
			? await provider.isExplicitlyAvailable(authStorage)
			: await provider.isAvailable(authStorage);
		if (available) providers.push(provider);
	}

	return providers;
}
