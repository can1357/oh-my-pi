import type { OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

export const minimaxCodeProvider = {
	id: "minimax-code",
	name: "MiniMax Token Plan (International)",
	apiKeyLoginMode: "append",
	login: async (cb: OAuthLoginCallbacks) => {
		// Lazy import: keep heavy OAuth flow modules out of the eager registry graph.
		const { loginMiniMaxCode } = await import("./oauth/minimax-code");
		return loginMiniMaxCode(cb);
	},
} as const satisfies ProviderDefinition;
