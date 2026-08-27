import type { OAuthCredentials, OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

export const zedProvider = {
	id: "zed-agent",
	name: "Zed AI (Subscription)",
	login: async (cb: OAuthLoginCallbacks) => {
		// Lazy import: keep heavy OAuth flow modules out of the eager registry graph.
		const { loginZed } = await import("./oauth/zed");
		return loginZed(cb);
	},
	refreshToken: async (credentials: OAuthCredentials) => {
		// Lazy import: keep heavy OAuth flow modules out of the eager registry graph.
		const { refreshZedToken } = await import("./oauth/zed");
		return refreshZedToken(credentials.refresh);
	},
	callbackPort: 48921,
} as const satisfies ProviderDefinition;
