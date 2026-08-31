import type { OAuthController } from "./oauth/types";
import type { ProviderDefinition } from "./types";

export const aimlApiProvider = {
	id: "aimlapi",
	name: "AIML API",
	// "Get API key" device-authorization login. The heavy flow module is
	// dynamically imported so it stays out of the eager startup graph
	// (see docs/adding-a-provider.md § Conventions).
	login: async (callbacks: OAuthController): Promise<string> => {
		const { loginAimlApi } = await import("./oauth/aimlapi");
		return loginAimlApi(callbacks);
	},
} as const satisfies ProviderDefinition;
