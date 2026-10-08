/**
 * Environment-variable API key fallbacks.
 *
 * Lives outside `stream.ts` so auth code (AuthStorage, credential cascade,
 * usage) can resolve env keys without importing the whole provider stack.
 */
import { providerEntries } from "@oh-my-pi/pi-catalog/compat/providers";
import { $env, $pickenv } from "@oh-my-pi/pi-utils";
import { PROVIDER_REGISTRY } from "./registry";

type KeyResolver = string | (() => string | undefined);

const LEGACY_ENV_KEYS: Record<string, KeyResolver> = {
	// Non-provider / search-tool keys and API-name keys not modeled as registry provider defs.
	"azure-openai-responses": "AZURE_OPENAI_API_KEY",
	jina: "JINA_API_KEY",
	brave: "BRAVE_API_KEY",
	tinyfish: "TINYFISH_API_KEY",
	firecrawl: "FIRECRAWL_API_KEY",
};

/**
 * Env fallbacks derived from the catalog provider entries (`env` in
 * `providers/<id>.kdl`) — the single source for plain provider env-var names.
 * Registry defs override with computed resolvers (Foundry/ADC/Bedrock
 * probes); legacy non-provider keys merge last.
 */
const CATALOG_ENTRY_ENV_KEYS = Object.values(providerEntries()).flatMap(provider => {
	const envVars = provider.envVars;
	if (!envVars || envVars.length === 0) return [];
	const resolver: KeyResolver = envVars.length === 1 ? envVars[0] : () => $pickenv(...envVars);
	return [[provider.id, resolver] as [string, KeyResolver]];
});

const serviceProviderMap: Record<string, KeyResolver> = {
	...Object.fromEntries(CATALOG_ENTRY_ENV_KEYS),
	...Object.fromEntries(
		PROVIDER_REGISTRY.flatMap(provider =>
			provider.envKeys != null ? [[provider.id, provider.envKeys] as [string, KeyResolver]] : [],
		),
	),
	...LEGACY_ENV_KEYS,
};

/**
 * Get API key for provider from known environment variables, e.g. OPENAI_API_KEY.
 *
 * Will not return API keys for providers that require OAuth tokens.
 * Checks Bun.env, then cwd/.env, then ~/.env.
 */
export function getEnvApiKey(provider: string): string | undefined {
	const resolver = serviceProviderMap[provider];
	if (typeof resolver === "string") {
		return $env[resolver];
	}
	return resolver?.();
}

/**
 * Name of the environment variable that backs `getEnvApiKey` for a provider,
 * when that provider maps to a single named variable (e.g. `github-copilot` →
 * `COPILOT_GITHUB_TOKEN`). Returns undefined for providers whose env fallback
 * is computed (multi-var pickers, Vertex ADC / Bedrock probes, …) since no
 * single variable name describes the source.
 */
export function getEnvApiKeyName(provider: string): string | undefined {
	const resolver = serviceProviderMap[provider];
	return typeof resolver === "string" ? resolver : undefined;
}

/**
 * Enumerate every provider that has an env-var fallback for `getEnvApiKey`.
 * Used by `omp auth-broker migrate --include-env` to discover env-sourced keys
 * that should be uploaded to the broker.
 */
export function listProvidersWithEnvKey(): string[] {
	return Object.keys(serviceProviderMap);
}
