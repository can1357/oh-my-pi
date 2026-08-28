import type { TokenCost } from "./types";

/** Standard GPT-5.6 Sol rates used by the Daybreak Blue aliases. */
export const OPENAI_GPT_56_SOL_STANDARD_COST = {
	input: 5,
	output: 30,
	cacheRead: 0.5,
	cacheWrite: 6.25,
} as const satisfies TokenCost;

/** Standard GPT-5.6 Cyber rates used by the Daybreak Red aliases. */
export const OPENAI_GPT_56_CYBER_STANDARD_COST = {
	input: 12.5,
	output: 75,
	cacheRead: 1.25,
	cacheWrite: 15.625,
} as const satisfies TokenCost;

/** Resolve standard rates for Codex-prefixed Daybreak aliases. */
export function resolveOpenAIDaybreakStandardCost(modelId: string): TokenCost | undefined {
	switch (modelId) {
		case "gpt-daybreak-blue-latest":
			return OPENAI_GPT_56_SOL_STANDARD_COST;
		case "gpt-daybreak-red-latest":
			return OPENAI_GPT_56_CYBER_STANDARD_COST;
		default:
			return undefined;
	}
}
