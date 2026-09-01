import type { OAuthCredentials, OAuthLoginCallbacks } from "./oauth/types";
import { loginZed, refreshZedToken } from "./oauth/zed";
import type { ProviderDefinition } from "./types";

export const zedProvider = {
	id: "zed-agent",
	name: "Zed AI (Subscription)",
	login: async (cb: OAuthLoginCallbacks) => {
		return loginZed(cb);
	},
	refreshToken: async (credentials: OAuthCredentials) => {
		return refreshZedToken(credentials.refresh);
	},
	callbackPort: 48921,
} as const satisfies ProviderDefinition;
