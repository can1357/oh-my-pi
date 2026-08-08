import type { OAuthCredentials, OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

/**
 * Factory Droid (Droid Core subscription).
 *
 * Single credential path: `/login factory-droid` runs the WorkOS device-code
 * flow over the public Droid client, stored in OMP's auth storage and
 * refreshed through WorkOS.
 */
export const factoryDroidProvider = {
	id: "factory-droid",
	name: "Factory Droid",
	login: async (cb: OAuthLoginCallbacks) => {
		// Lazy import: keep heavy OAuth flow modules out of the eager registry graph.
		const { loginFactoryDroid } = await import("./oauth/factory-droid");
		return loginFactoryDroid(cb);
	},
	refreshToken: async (credentials: OAuthCredentials) => {
		// Lazy import: keep heavy OAuth flow modules out of the eager registry graph.
		const { refreshFactoryDroidToken } = await import("./oauth/factory-droid");
		return refreshFactoryDroidToken(credentials.refresh);
	},
	getApiKey: (credentials: OAuthCredentials) => credentials.access,
	mapSimpleOptions: options => ({ reasoning: options.reasoning, cwd: options.cwd }),
} as const satisfies ProviderDefinition;
