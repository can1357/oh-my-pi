import type { Api, Model } from "../types";

export function createProviderErrorMessage(model: Model<Api>, err: unknown) {
	const errorMessage = err instanceof Error ? err.message : String(err);
	return {
		role: "assistant" as const,
		content: [],
		errorMessage,
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "error" as const,
		timestamp: Date.now(),
	};
}
