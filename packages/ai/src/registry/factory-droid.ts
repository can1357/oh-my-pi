import type { OAuthCredentials, OAuthLoginCallbacks } from "./oauth/types";
import type { ProviderDefinition } from "./types";

/**
 * Factory Droid (Droid Core subscription).
 *
 * Two credential paths, in order:
 * 1. OMP-native `/login factory-droid`: WorkOS device-code flow (same public
 *    client the Droid CLI uses), stored in OMP's auth storage and refreshed
 *    through WorkOS.
 * 2. Bridge: an existing local `droid auth login` session
 *    (`~/.factory/auth.v2.file`), resolved by the provider transport itself
 *    when OMP has no stored credential — hence `allowsMissingApiKey`.
 */
export const factoryDroidProvider = {
	id: "factory-droid",
	name: "Factory Droid",
	allowsMissingApiKey: true,
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
