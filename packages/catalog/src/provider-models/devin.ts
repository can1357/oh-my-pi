import type { ModelSpec } from "../types";

export const DEVIN_DEFAULT_BASE_URL = "https://server.codeium.com";
export const DEVIN_DEFAULT_CONTEXT_WINDOW = 200_000;
export const DEVIN_DEFAULT_MAX_TOKENS = 64_000;

/** Deterministic offline seed used before credentialed Devin discovery succeeds. */
export function buildDevinFallbackModel(baseUrl = DEVIN_DEFAULT_BASE_URL): ModelSpec<"devin-agent"> {
	return {
		id: "swe-1-6",
		name: "SWE 1.6",
		api: "devin-agent",
		provider: "devin",
		baseUrl,
		reasoning: false,
		input: ["text", "image"],
		supportsTools: true,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: DEVIN_DEFAULT_CONTEXT_WINDOW,
		maxTokens: DEVIN_DEFAULT_MAX_TOKENS,
	};
}
