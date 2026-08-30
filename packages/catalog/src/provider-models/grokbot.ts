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
	sandParameterIds?: readonly string[];
};

/**
 * Tiny offline fallback when AvailableModels is unreachable.
 * Live catalog comes from `fetchGrokbotAvailableModels` (authoritative).
 * Do not re-expand into alias forests — aliases resolve client-side from live rows.
 * Effort ladders are rule-owned (`providers/grokbot.kdl`); seeds stay neutral.
 */
export const GROKBOT_MODEL_SEEDS: readonly GrokbotModelSeed[] = [
	{ id: "sand-default", name: "sand-default (routed)", reasoning: true, sandParameterIds: [] },
	{ id: "sand-cua", name: "sand-cua (routed)", reasoning: false, sandParameterIds: [] },
	{ id: "sand-automation", name: "sand-automation (routed)", reasoning: false, sandParameterIds: [] },
	{ id: "default", name: "Auto", reasoning: false, sandParameterIds: [] },
	{ id: "auto", name: "auto", reasoning: false, sandParameterIds: [] },
	{ id: "grok-4.6", name: "Grok 4.6 (sand)", reasoning: true, sandParameterIds: ["effort", "fast"] },
];

export function buildGrokbotStaticSeed(baseUrl = GROKBOT_BACKEND): ModelSpec<"grokbot-sand">[] {
	return GROKBOT_MODEL_SEEDS.map(seed => ({
		id: seed.id,
		name: seed.name,
		api: GROKBOT_API,
		provider: "grokbot",
		baseUrl,
		reasoning: seed.reasoning,
		input: ["text", "image"] as ("text" | "image")[],
		cost: COST,
		contextWindow: 200_000,
		maxTokens: 64_000,
		supportsTools: true,
		sandParameterIds: seed.sandParameterIds ?? [],
		sandMaxMode: false,
	}));
}
