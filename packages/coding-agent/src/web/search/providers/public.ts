import type { AuthStorage } from "@oh-my-pi/pi-ai";
import { formatSearchProviderFailures, getSearchProvider, isSearchProviderExcluded } from "../provider";
import type { SearchProviderId, SearchResponse, SearchSource } from "../types";
import { SearchProviderError } from "../types";
import { clampNumResults } from "../utils";
import type { SearchParams } from "./base";
import { SearchProvider } from "./base";
import { withHardTimeout } from "./utils";

/**
 * Credential-free engines the Public Web aggregate fans out to. Order is the
 * tiebreak for merged ranking (earlier engines win equal consensus/rank), so
 * engines with the best ranking quality when they answer come first:
 * Google-index engines (startpage, google) lead, and Mojeek's independent
 * index breaks remaining ties (measured 2026-07).
 */
const PUBLIC_ENGINE_IDS = [
	"startpage",
	"google",
	"duckduckgo",
	"ecosia",
	"mojeek",
] as const satisfies readonly SearchProviderId[];

/** Aggregates get a wider default window than single engines: consensus needs breadth. */
const DEFAULT_NUM_RESULTS = 15;
const MAX_NUM_RESULTS = 30;

/**
 * Soft deadline for the fan-out: past this point the aggregate returns as
 * soon as it has at least one engine's results. Fast HTML engines answer
 * well under this; browser-backed engines (google, ecosia, mojeek) routinely
 * exceed it and are treated as bonus coverage rather than latency floor.
 */
const SOFT_DEADLINE_MS = 5_000;

/**
 * Hard deadline for the fan-out: the aggregate returns whatever it has, even
 * nothing, so one pathologically slow engine can never pin the tool call to
 * the per-request 60s ceiling.
 */
const HARD_DEADLINE_MS = 30_000;

/** Deadline overrides — test seam; production callers use the defaults. */
export interface PublicWebDeadlines {
	softMs?: number;
	hardMs?: number;
}

/** Accumulator for one deduplicated URL across engines. */
interface MergedSource {
	source: SearchSource;
	/** Number of engines that returned this URL — the primary ranking signal. */
	engines: number;
	/** Best (lowest) per-engine rank observed. */
	bestRank: number;
	/** First-seen insertion index; final tiebreak keeps ordering deterministic. */
	order: number;
}

/**
 * Canonical dedup key for a result URL: case-normalized host without a
 * leading `www.`, path without a trailing slash, query preserved, fragment
 * dropped. Engines disagree on exactly these variations for the same page.
 */
function dedupKey(rawUrl: string): string {
	try {
		const url = new URL(rawUrl);
		const host = url.hostname.toLowerCase().replace(/^www\./, "");
		let path = url.pathname;
		if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
		return `${host}${path}${url.search}`;
	} catch {
		return rawUrl;
	}
}

/** Merge one engine's ranked sources into the accumulator map. */
function mergeSources(merged: Map<string, MergedSource>, sources: readonly SearchSource[]): void {
	for (const [rank, source] of sources.entries()) {
		const key = dedupKey(source.url);
		const existing = merged.get(key);
		if (!existing) {
			merged.set(key, { source: { ...source }, engines: 1, bestRank: rank, order: merged.size });
			continue;
		}
		existing.engines += 1;
		if (rank < existing.bestRank) {
			existing.bestRank = rank;
			existing.source.title = source.title;
			existing.source.url = source.url;
		}
		// Keep the most informative snippet regardless of which engine ranked it best.
		if (source.snippet && source.snippet.length > (existing.source.snippet?.length ?? 0)) {
			existing.source.snippet = source.snippet;
		}
		existing.source.publishedDate ??= source.publishedDate;
		existing.source.ageSeconds ??= source.ageSeconds;
	}
}

/**
 * Execute a web search against every credential-free engine in parallel and
 * consolidate the results: URLs are deduplicated across engines, ranked by
 * cross-engine consensus (how many engines returned them), then by best
 * per-engine rank.
 *
 * The fan-out races three exits and returns at the earliest: every engine
 * settled; the soft deadline elapsed with at least one success in hand; the
 * hard deadline elapsed regardless. If the soft deadline fires before any
 * engine has delivered, the aggregate keeps waiting (up to the hard cap) for
 * the first success, so a slow field degrades to fewer engines rather than
 * an empty answer. Stragglers are aborted once the race resolves. Individual
 * engine failures (bot challenges, timeouts) are tolerated; the call fails
 * only when every engine fails.
 */
export async function searchPublicWeb(
	params: SearchParams,
	deadlines: PublicWebDeadlines = {},
): Promise<SearchResponse> {
	const softMs = deadlines.softMs ?? SOFT_DEADLINE_MS;
	const hardMs = deadlines.hardMs ?? HARD_DEADLINE_MS;
	const numResults = clampNumResults(params.numSearchResults ?? params.limit, DEFAULT_NUM_RESULTS, MAX_NUM_RESULTS);
	const engineIds = PUBLIC_ENGINE_IDS.filter(id => !isSearchProviderExcluded(id));
	if (engineIds.length === 0) {
		throw new SearchProviderError("public", "Every credential-free engine is excluded by settings.", 400);
	}

	// Each engine composes its own per-request ceiling on top of the shared
	// hard deadline; the straggler controller lets the aggregate cancel
	// still-running engines once it decides to return.
	const straggler = new AbortController();
	const signal = AbortSignal.any([withHardTimeout(params.signal, params.timeoutMs), straggler.signal]);

	const responses: (SearchResponse | undefined)[] = new Array(engineIds.length);
	const failures: { provider: { id: SearchProviderId; label: string }; error: unknown }[] = [];
	const firstSuccess = Promise.withResolvers<void>();
	const all = Promise.all(
		engineIds.map(async (id, index) => {
			try {
				const provider = await getSearchProvider(id);
				responses[index] = await provider.search({ ...params, signal });
				firstSuccess.resolve();
			} catch (error) {
				failures.push({ provider: { id, label: id }, error });
			}
		}),
	);

	await Promise.race([all, Bun.sleep(softMs)]);
	if (!responses.some(response => response !== undefined) && failures.length < engineIds.length) {
		await Promise.race([all, firstSuccess.promise, Bun.sleep(Math.max(0, hardMs - softMs))]);
	}
	straggler.abort();

	// Merge in engine-priority order (not settlement order) so ranking
	// tiebreaks stay deterministic.
	const merged = new Map<string, MergedSource>();
	for (const response of responses) {
		if (response) mergeSources(merged, response.sources);
	}

	if (merged.size === 0 && failures.length === engineIds.length) {
		throw new SearchProviderError(
			"public",
			`All public engines failed: ${formatSearchProviderFailures(failures)}`,
			503,
		);
	}

	const sources = [...merged.values()]
		.sort((a, b) => b.engines - a.engines || a.bestRank - b.bestRank || a.order - b.order)
		.slice(0, numResults)
		.map(entry => entry.source);

	return { provider: "public", sources };
}

/**
 * Aggregate meta-provider over every credential-free engine. Explicit-only:
 * the auto chain already walks the individual engines sequentially, so
 * fanning out to all of them is a deliberate user choice, not a fallback.
 */
export class PublicWebProvider extends SearchProvider {
	readonly id = "public";
	readonly label = "Public Web";

	isAvailable(_authStorage: AuthStorage): boolean {
		return false;
	}

	override isExplicitlyAvailable(_authStorage: AuthStorage): boolean {
		return true;
	}

	search(params: SearchParams): Promise<SearchResponse> {
		return searchPublicWeb(params);
	}
}
