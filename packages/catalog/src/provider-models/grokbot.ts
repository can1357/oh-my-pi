import { providerEntry, seedModels } from "../compat/providers";
import type { ModelSpec } from "../types";

export const GROKBOT_BACKEND = "https://api2.cursor.sh";
export const GROKBOT_API = "grokbot-sand" as const;
export const GROKBOT_DEFAULT_MODEL_ID = providerEntry("grokbot")!.defaultModel;

/**
 * Synthetic sand routers always unioned into live AvailableModels catalogs and
 * present in the offline seed list. Single roster — discovery must not keep a
 * parallel hard-coded copy (stale add/remove drift).
 */
// `sand-default-preferred` is the live `sand_default_model` Statsig value on sand-host
// 3f90dc1 (2026-10-08); a non-routed-list alias sent bare like `sand-default`.
export const GROKBOT_SAND_ROUTER_IDS = [
	"sand-default",
	"sand-default-preferred",
	"sand-cua",
	"sand-automation",
] as const;

export type GrokbotSandRouterId = (typeof GROKBOT_SAND_ROUTER_IDS)[number];

/**
 * Authored offline fallback when AvailableModels is unreachable.
 * Live catalog comes from `fetchGrokbotAvailableModels` (authoritative).
 * Do not re-expand into alias forests — aliases resolve client-side from live rows.
 *
 * KDL owns both seed rows and deployment policy, so the bundled catalog and
 * runtime fallback cannot drift through a parallel TypeScript seed roster.
 */
export const GROKBOT_MODEL_SEEDS = seedModels<"grokbot-sand">("grokbot");

export function buildGrokbotStaticSeed(baseUrl = GROKBOT_BACKEND): ModelSpec<"grokbot-sand">[] {
	return GROKBOT_MODEL_SEEDS.map(seed => ({
		...structuredClone(seed),
		baseUrl,
	}));
}
