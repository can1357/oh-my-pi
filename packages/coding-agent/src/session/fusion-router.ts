/**
 * Fusion dynamic mid-session routing (Devin-Fusion style).
 *
 * At each compaction boundary the messages-segment cache is already
 * invalidated by the history rewrite, so switching the main model there is
 * marginal-cost (only the tools/system segment re-prefills). A lightweight
 * classifier reads the
 * compaction summary and picks the tier for the next stretch:
 *
 * - Binary mode (no pool): `cheap` (the configured `fusion.compactModel`) for
 *   settled mechanical work, `frontier` (the session's original model) when the
 *   work needs strong reasoning.
 * - Pool mode (`fusion.modelPool` has 2+ entries): the classifier picks a tier
 *   number from the pool, where tier 1 = most powerful … 5 = least intelligent.
 */
import { type Api, completeSimple, type Model, type ServiceTier } from "@pk-nerdsaver-ai/pi-ai";
import { logger, prompt } from "@pk-nerdsaver-ai/pi-utils";
import type { ModelRegistry } from "../config/model-registry";
import { resolveRoleSelection } from "../config/model-resolver";
import type { Settings } from "../config/settings";
import routeClassifierPrompt from "../prompts/fusion/route-classifier.md" with { type: "text" };
import routeClassifierPoolPrompt from "../prompts/fusion/route-classifier-pool.md" with { type: "text" };

export type FusionRoute = "cheap" | "frontier" | number;

/** One tier of the routing pool. Tier 1 = most powerful … 5 = least intelligent. */
export interface FusionPoolTier {
	tier: number;
	selector: string;
}

export const FUSION_POOL_MIN_TIER = 1;
export const FUSION_POOL_MAX_TIER = 5;

const ROUTE_SYSTEM_PROMPT = prompt.render(routeClassifierPrompt);
const ROUTE_MARKER_RE = /<route>\s*(cheap|frontier|[1-5])\s*<\/route>/i;
const ROUTE_MAX_TOKENS = 16;
const ROUTE_REASONING_SAFE_MAX_TOKENS = 1024;
const ROUTE_SUMMARY_LIMIT = 8_000;

/** Parse the classifier's `<route>…</route>` marker. Exported for tests. */
export function parseFusionRoute(text: string): FusionRoute | null {
	const match = ROUTE_MARKER_RE.exec(text);
	if (!match) return null;
	const value = match[1].toLowerCase();
	if (value === "cheap" || value === "frontier") return value;
	return Number.parseInt(value, 10);
}

/**
 * Parse `fusion.modelPool` entries of the form `"<tier>=<selector>"`.
 * Invalid entries are dropped; duplicate tiers keep the last assignment.
 * Result is sorted by tier ascending (strongest first).
 */
export function parseFusionPoolEntries(entries: readonly string[]): FusionPoolTier[] {
	const byTier = new Map<number, string>();
	for (const entry of entries) {
		const eq = entry.indexOf("=");
		if (eq <= 0) continue;
		const tier = Number.parseInt(entry.slice(0, eq).trim(), 10);
		const selector = entry.slice(eq + 1).trim();
		if (!Number.isInteger(tier) || tier < FUSION_POOL_MIN_TIER || tier > FUSION_POOL_MAX_TIER) continue;
		if (!selector) continue;
		byTier.set(tier, selector);
	}
	return Array.from(byTier.entries(), ([tier, selector]) => ({ tier, selector })).sort((a, b) => a.tier - b.tier);
}

/** Serialize pool tiers back to `fusion.modelPool` entries. */
export function formatFusionPoolEntries(pool: readonly FusionPoolTier[]): string[] {
	return [...pool].sort((a, b) => a.tier - b.tier).map(({ tier, selector }) => `${tier}=${selector}`);
}

/**
 * Map the main-model route to a sidekick tier: `strong` when the classifier
 * judged the next stretch hard (`frontier`, or the strongest configured pool
 * tier), `base` otherwise. Pure — exported for tests.
 */
export function resolveSidekickRoute(route: FusionRoute, pool: readonly FusionPoolTier[]): "strong" | "base" {
	if (route === "frontier") return "strong";
	if (typeof route === "number" && pool.length > 0 && route === pool[0].tier) return "strong";
	return "base";
}

/**
 * Predicate: does the compaction switch path have *any* work to do this
 * compaction — main-model target, dynamic main routing, or independent sidekick
 * re-tiering? Extracted as a pure helper so the early-return contract is
 * unit-testable in isolation from `AgentSession`.
 */
export function shouldRunFusionCompactionSwitch(options: {
	hasCompactSelector: boolean;
	poolMode: boolean;
	dynamicRouting: boolean;
	hasSidekickStrongSelector: boolean;
	pool: readonly FusionPoolTier[];
}): boolean {
	if (options.hasCompactSelector) return true;
	if (options.poolMode) return true;
	if (options.dynamicRouting && options.pool.length >= 2) return true;
	if (options.dynamicRouting && options.hasSidekickStrongSelector) return true;
	return false;
}

/**
 * Fallback used when the classifier is unavailable or unparseable.
 * Binary mode: preserve the static one-shot ramp-down to `fusion.compactModel`
 * (never let a broken classifier disable the configured downgrade), once per
 * session. Pool mode: no fallback — the pool is classifier-driven, and silently
 * dropping to the weakest tier would be an unrequested quality cut.
 * Pure — exported for tests.
 */
export function resolveEffectiveFusionRoute(
	route: FusionRoute | null,
	options: { alreadySwitched: boolean; pool?: readonly FusionPoolTier[] },
): FusionRoute | undefined {
	if (route !== null) return route;
	if (options.alreadySwitched) return undefined;
	if ((options.pool?.length ?? 0) >= 2) return undefined;
	return "cheap";
}

function getRouteModel(
	registry: ModelRegistry,
	settings: Settings,
): { model: Model<Api>; serviceTier?: ServiceTier } | undefined {
	const availableModels = registry.getAvailable();
	if (availableModels.length === 0) return undefined;
	const resolved = resolveRoleSelection(["smol", "title", "commit"], settings, availableModels, registry);
	return resolved?.model ? { model: resolved.model, serviceTier: resolved.serviceTier } : undefined;
}

/** Render the pool-mode classifier system prompt. Exported for tests. */
export function renderPoolClassifierPrompt(pool: readonly FusionPoolTier[]): string {
	return prompt.render(routeClassifierPoolPrompt, {
		tiers: pool.map(({ tier, selector }) => ({ tier, descriptor: selector })),
	});
}

/**
 * Classify which tier should drive the post-compaction stretch.
 * With a `pool` (2+ tiers) the classifier picks a tier number from it;
 * otherwise it makes the binary cheap/frontier call.
 * Returns `null` when no classifier model is available or the call fails —
 * callers fall back to their static behavior (see {@link resolveEffectiveFusionRoute}).
 */
export async function classifyFusionRoute(
	summary: string,
	registry: ModelRegistry,
	settings: Settings,
	sessionId?: string,
	pool?: readonly FusionPoolTier[],
): Promise<FusionRoute | null> {
	const trimmed = summary.trim();
	if (!trimmed) return null;
	const poolMode = (pool?.length ?? 0) >= 2;
	const routeSelection = getRouteModel(registry, settings);
	const model = routeSelection?.model;
	if (!model) {
		logger.debug("fusion-router: no classifier model available");
		return null;
	}
	try {
		const maxTokens = model.reasoning ? ROUTE_REASONING_SAFE_MAX_TOKENS : ROUTE_MAX_TOKENS;
		const systemPrompt = poolMode && pool ? renderPoolClassifierPrompt(pool) : ROUTE_SYSTEM_PROMPT;
		const response = await completeSimple(
			model,
			{
				systemPrompt: [systemPrompt],
				messages: [
					{
						role: "user",
						content: trimmed.slice(0, ROUTE_SUMMARY_LIMIT),
						timestamp: Date.now(),
					},
				],
			},
			{
				apiKey: registry.resolver(model, sessionId),
				maxTokens,
				disableReasoning: true,
				serviceTier: routeSelection?.serviceTier,
			},
		);
		if (response.stopReason === "error") {
			logger.warn("fusion-router: classifier response error", { errorMessage: response.errorMessage });
			return null;
		}
		const text = response.content.map(block => (block.type === "text" ? block.text : "")).join(" ");
		const route = parseFusionRoute(text);
		if (route === null) {
			logger.debug("fusion-router: unparseable classifier output", { text: text.slice(0, 200) });
			return null;
		}
		// Cross-mode answers are invalid: a tier number without a pool, a listed
		// tier that isn't in the pool, or cheap/frontier while in pool mode.
		if (typeof route === "number") {
			if (!poolMode || !pool?.some(t => t.tier === route)) return null;
		} else if (poolMode) {
			return null;
		}
		return route;
	} catch (err) {
		logger.warn("fusion-router: classifier failed", { error: err instanceof Error ? err.message : String(err) });
		return null;
	}
}
