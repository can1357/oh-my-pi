import { classifyModel } from "./compat/taxonomy";
import { getCatalogProvider, getCatalogProviders, openModelCatalog } from "./model-catalog-format";
import modelsData from "./models.json" with { type: "json" };
import { dueEffectiveRate } from "./pricing";
import type {
	Api,
	EffectiveTokenCost,
	KnownProvider,
	Model,
	ModelCost,
	ModelPricingStatus,
	TimeBasedCost,
	TokenCost,
	Usage,
} from "./types";

/**
 * Static bundled model registry loaded from `models.json`.
 *
 * This module intentionally exposes compile-time defaults only.
 * It does not include runtime discovery, stencil.so overlays, or on-disk cache state.
 *
 * For runtime-aware resolution, use `createModelManager()` / `resolveProviderModels()`.
 */
const catalog = openModelCatalog(modelsData);
const bundledProviders: readonly KnownProvider[] = Object.freeze(getCatalogProviders(catalog) as KnownProvider[]);
const bundledProviderSet = new Set<string>(bundledProviders);
const modelRegistry = new Map<string, Map<string, Model<Api>>>();

/** Return one provider's bundled models, materialized by the generator. */
function getProviderModels(provider: string): Map<string, Model<Api>> | undefined {
	const cachedModels = modelRegistry.get(provider);
	if (cachedModels !== undefined) return cachedModels;
	const rawModels = getCatalogProvider(catalog, provider);
	if (!rawModels) return undefined;

	const providerModels = new Map<string, Model<Api>>();
	for (const id in rawModels) {
		const row = rawModels[id];
		// Rows baked before the compat engine (and stale cache snapshots) lack
		// `identity`; classify lazily so consumers can rely on the field.
		row.identity ??= classifyModel(provider, id, { lenient: true });
		providerModels.set(id, row);
	}
	modelRegistry.set(provider, providerModels);
	return providerModels;
}

/** Provider identifier accepted by the bundled model registry. */
export type GeneratedProvider = string;

/** Whether `provider` has bundled rows in models.json (e.g. a provider id authored in KDL). */
export function isGeneratedProvider(provider: string): provider is GeneratedProvider {
	return bundledProviderSet.has(provider);
}

/** Look up a bundled model; nested catalog values are shared and must not be mutated. */
export function getBundledModel<TApi extends Api = Api>(provider: GeneratedProvider, modelId: string): Model<TApi> {
	const providerModels = getProviderModels(provider);
	return providerModels?.get(modelId) as Model<TApi>;
}

/** List providers with bundled rows; the array is shared and frozen. */
export function getBundledProviders(): readonly KnownProvider[] {
	return bundledProviders;
}

/** List a provider's bundled models; nested catalog values are shared and must not be mutated. */
export function getBundledModels(provider: GeneratedProvider): Model<Api>[] {
	const models = getProviderModels(provider);
	return models ? (Array.from(models.values()) as Model<Api>[]) : [];
}
/** Resolve display semantics without mistaking an absent rate card for a free model. */
export function getModelPricingStatus(model: Pick<Model<Api>, "cost" | "pricingStatus">): ModelPricingStatus {
	const cost = getEffectiveTokenCost(model.cost);
	if (cost.input !== 0 || cost.output !== 0 || cost.cacheRead !== 0 || cost.cacheWrite !== 0) return "fixed";
	return model.pricingStatus ?? "unknown";
}

/**
 * The base token card in force at `timestamp` (Unix ms, default now): the
 * latest due `timeBased` effective rate, else the row's own legs. Price
 * displays read this rather than the scalar legs, which keep the card current
 * when the row was built while bundles, caches, and long sessions outlive it.
 * Applies no long-context tier or peak/off-peak multiplier.
 */
export function getEffectiveTokenCost(cost: ModelCost, timestamp = Date.now()): TokenCost {
	return resolveTokenCost(cost, 0, timestamp);
}

function resolveTokenCost(cost: ModelCost, promptInputTokens: number, timestamp: number | undefined): TokenCost {
	const rates: ModelCost | EffectiveTokenCost =
		(timestamp === undefined ? undefined : dueEffectiveRate(cost.timeBased, timestamp)) ?? cost;
	const longContext = rates.longContext;
	if (!longContext) return rates;
	const reachesThreshold =
		promptInputTokens > longContext.inputThreshold ||
		(longContext.inputThresholdInclusive === true && promptInputTokens === longContext.inputThreshold);
	return reachesThreshold ? longContext : rates;
}

function isPeakPricingPeriod(schedule: TimeBasedCost, timestamp: number): boolean {
	// Unix epoch was Thursday. Arithmetic keeps this UTC-only without allocating a Date.
	const day = Math.floor(timestamp / 86_400_000);
	const weekday = (((day + 4) % 7) + 7) % 7;
	const minute = Math.floor((timestamp - day * 86_400_000) / 60_000);
	for (const window of schedule.peakWindows) {
		if (minute >= window.startMinute && minute < window.endMinute && window.weekdays.includes(weekday)) return true;
	}
	return false;
}

function timeBasedMultiplier(schedule: TimeBasedCost | undefined, timestamp: number | undefined): number {
	if (!schedule || timestamp === undefined) return 1;
	return isPeakPricingPeriod(schedule, timestamp) ? 1 : schedule.offPeakMultiplier;
}

/**
 * Whether a schedule carries a recurring peak/off-peak tariff. A schedule with
 * no peak windows at a 1x off-peak multiplier only carries dated rate cards
 * (`cost-patch`/`cost-fallback` `effective-rates`): its price changes on a
 * date, never by time of day.
 */
export function hasRecurringTariff(schedule: TimeBasedCost): boolean {
	return schedule.peakWindows.length > 0 || schedule.offPeakMultiplier !== 1;
}

/** Return the recurring UTC tariff period, independently of its monetary multiplier. */
export function getTimeBasedPricingPeriod(cost: ModelCost, timestamp?: number): "peak" | "off-peak" | undefined {
	const schedule = cost.timeBased;
	if (!schedule || !hasRecurringTariff(schedule)) return undefined;
	return isPeakPricingPeriod(schedule, timestamp ?? Date.now()) ? "peak" : "off-peak";
}

/** Return the next actual peak/off-peak change strictly after the Unix-ms timestamp. */
export function getNextTimeBasedPricingTransition(cost: ModelCost, timestamp?: number): number | undefined {
	const schedule = cost.timeBased;
	if (!schedule) return undefined;
	const now = timestamp ?? Date.now();
	const firstDay = Math.floor(now / 86_400_000);
	const horizon = now + 7 * 86_400_000;
	let next = Infinity;
	// All changes occur at window edges; one UTC week covers the entire recurrence.
	for (let offset = 0; offset <= 7; offset++) {
		const day = firstDay + offset;
		const weekday = (((day + 4) % 7) + 7) % 7;
		for (const window of schedule.peakWindows) {
			if (!window.weekdays.includes(weekday)) continue;
			for (let edge = 0; edge < 2; edge++) {
				const minute = edge === 0 ? window.startMinute : window.endMinute;
				const candidate = day * 86_400_000 + minute * 60_000;
				if (candidate <= now || candidate > horizon || candidate >= next) continue;
				// Overlapping/touching windows can hide an edge, including at midnight.
				if (isPeakPricingPeriod(schedule, candidate - 1) !== isPeakPricingPeriod(schedule, candidate)) {
					next = candidate;
				}
			}
		}
	}
	return next === Infinity ? undefined : next;
}

/** Price a fully uncached prompt at its request timestamp (Unix ms); scheduled prices default to now. */
export function calculateUncachedInputCost(cost: ModelCost, promptInputTokens: number, timestamp?: number): number {
	const pricingTimestamp = cost.timeBased ? (timestamp ?? Date.now()) : undefined;
	const rates = resolveTokenCost(cost, promptInputTokens, pricingTimestamp);
	return (rates.input / 1_000_000) * promptInputTokens * timeBasedMultiplier(cost.timeBased, pricingTimestamp);
}

/** Price usage at its request timestamp (Unix ms); only scheduled prices default to now. */
export function calculateUsageCost(cost: ModelCost, usage: Usage, timestamp?: number): Usage["cost"] {
	const orchestration = usage.orchestration;
	const promptInputTokens =
		usage.input + usage.cacheRead + usage.cacheWrite + (orchestration?.input ?? 0) + (orchestration?.cacheRead ?? 0);
	const pricingTimestamp = cost.timeBased ? (timestamp ?? Date.now()) : undefined;
	const rates = resolveTokenCost(cost, promptInputTokens, pricingTimestamp);
	const multiplier = timeBasedMultiplier(cost.timeBased, pricingTimestamp);
	usage.cost.input = (rates.input / 1000000) * (usage.input + (orchestration?.input ?? 0)) * multiplier;
	usage.cost.output = (rates.output / 1000000) * (usage.output + (orchestration?.output ?? 0)) * multiplier;
	usage.cost.cacheRead =
		(rates.cacheRead / 1000000) * (usage.cacheRead + (orchestration?.cacheRead ?? 0)) * multiplier;
	usage.cost.cacheWrite = cacheWriteCost(rates, usage) * multiplier;
	usage.cost.total = usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
	return usage.cost;
}

/** Price usage at its request timestamp (Unix ms); preserve the resulting monetary amounts for display. */
export function calculateCost<TApi extends Api>(model: Model<TApi>, usage: Usage, timestamp?: number): Usage["cost"] {
	return calculateUsageCost(model.cost, usage, timestamp);
}

/**
 * Price cache-write tokens, honoring the TTL breakdown when the provider reports one.
 *
 * `rates.cacheWrite` is the 5-minute write rate (Anthropic bills 5m writes at
 * 1.25x base input). When `usage.cttl` is present the write can mix 5m and 1h
 * breakpoints, and 1h writes bill at 2x base input, so each component is
 * priced at its own rate instead of the flat 5m rate. Deriving 1h from
 * `input * 2` (Anthropic's published multiplier) is model-independent and
 * stays correct even for legacy entries whose stored
 * `cacheWrite` scalar drifts from 1.25x input. Providers that omit `cttl`
 * (everyone but Anthropic) keep the flat-rate calculation.
 *
 * The breakdown is documented to sum to `usage.cacheWrite`, but the two are written
 * from independent wire fields (`cache_creation` vs `cache_creation_input_tokens`),
 * so any unattributed remainder is priced at the flat rate instead of being dropped:
 * a partial or stale breakdown must never make write tokens free.
 */
function cacheWriteCost(rates: TokenCost, usage: Usage): number {
	const rate5m = rates.cacheWrite / 1000000;
	const cttl = usage.cttl;
	if (!cttl) return rate5m * usage.cacheWrite;
	const fiveMinute = cttl.ephemeral5m ?? 0;
	const oneHour = cttl.ephemeral1h ?? 0;
	const residual = Math.max(0, usage.cacheWrite - fiveMinute - oneHour);
	return rate5m * (fiveMinute + residual) + ((rates.input * 2) / 1000000) * oneHour;
}

/**
 * Check if two models are equal by comparing both their id and provider.
 * Returns false if either model is null or undefined.
 */
export function modelsAreEqual<TApi extends Api>(
	a: Model<TApi> | null | undefined,
	b: Model<TApi> | null | undefined,
): boolean {
	if (!a || !b) return false;
	return a.id === b.id && a.provider === b.provider;
}
