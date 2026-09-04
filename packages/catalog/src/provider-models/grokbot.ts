import type { ModelSpec } from "../types";

export const GROKBOT_BACKEND = "https://api2.cursor.sh";
export const GROKBOT_API = "grokbot-sand" as const;
export const GROKBOT_DEFAULT_MODEL_ID = "sand-default";

/**
 * Metering is intentionally $0: sand usage is billed on the renewer account,
 * not as omp-side token pricing. Stats/usage surfaces will show zero cost.
 */
const COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } as const;

type GrokbotModelSeed = {
	id: string;
	name: string;
	reasoning: boolean;
};

/**
 * Tiny offline fallback when AvailableModels is unreachable.
 * Live catalog comes from `fetchGrokbotAvailableModels` (authoritative).
 * Do not re-expand into alias forests — aliases resolve client-side from live rows.
 *
 * Deployment routing facts (`sandParameterIds`, effort ladders, context floors)
 * live in `providers/grokbot.kdl` and are applied via `buildModel` /
 * `applyCatalogAssignments`. Seeds stay identity-neutral — omit
 * `sandParameterIds` here (empty KDL arrays are unsupported; bare routing is
 * the unset default consumed as `[]` on the wire).
 */
export const GROKBOT_MODEL_SEEDS: readonly GrokbotModelSeed[] = [
	// Reasoning for routers is reviewed via KDL (`reasoning`); seeds stay neutral.
	{ id: "sand-default", name: "sand-default (routed)", reasoning: false },
	{ id: "sand-cua", name: "sand-cua (routed)", reasoning: false },
	{ id: "sand-automation", name: "sand-automation (routed)", reasoning: false },
	{ id: "default", name: "Auto", reasoning: false },
	{ id: "auto", name: "auto", reasoning: false },
	{ id: "grok-4.6", name: "Grok 4.6 (sand)", reasoning: true },
];

export function buildGrokbotStaticSeed(baseUrl = GROKBOT_BACKEND): ModelSpec<"grokbot-sand">[] {
	return GROKBOT_MODEL_SEEDS.map(seed => ({
		id: seed.id,
		name: seed.name,
		api: GROKBOT_API,
		provider: "grokbot",
		baseUrl,
		reasoning: seed.reasoning,
		// Neutral offline fallback: live AvailableModels owns modality/limits.
		// Reviewed floors/ladders come from `providers/grokbot.kdl` via `buildModel`.
		input: ["text"] as ("text" | "image")[],
		cost: COST,
		contextWindow: null,
		maxTokens: null,
		// Tool support is reviewed via KDL (`supports-tools`); do not invent true here.
		sandMaxMode: false,
	}));
}
