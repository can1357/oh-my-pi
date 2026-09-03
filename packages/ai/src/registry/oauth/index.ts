// ============================================================================
// High-level API
// ============================================================================

import { authPolicyFor } from "@oh-my-pi/pi-catalog/compat/auth";
import * as AIError from "../../error";
import { jwtExpiryMs, NEVER_EXPIRES } from "../engine/common";
import { getProviderDefinition, PROVIDER_REGISTRY } from "../registry";
import type {
	OAuthCredentials,
	OAuthProvider,
	OAuthProviderId,
	OAuthProviderInfo,
	OAuthProviderInterface,
} from "./types";

export * from "./anthropic";
export * from "./device-code";
export type * from "./types";

const builtInOAuthProviders: OAuthProviderInfo[] = PROVIDER_REGISTRY.filter(
	provider => provider.login && provider.showInLoginList !== false,
).map(provider => ({
	id: provider.id,
	name: provider.name,
	available: provider.available ?? true,
	storeCredentialsAs: provider.storeCredentialsAs,
}));

const customOAuthProviders = new Map<string, OAuthProviderInterface>();

/**
 * Register a custom OAuth provider.
 */
export function registerOAuthProvider(provider: OAuthProviderInterface): void {
	customOAuthProviders.set(provider.id, provider);
}

/**
 * Remove a custom OAuth provider by ID.
 */
export function unregisterOAuthProvider(id: string): void {
	customOAuthProviders.delete(id);
}

/**
 * Get a custom OAuth provider by ID.
 */
export function getOAuthProvider(id: OAuthProviderId): OAuthProviderInterface | undefined {
	return customOAuthProviders.get(id);
}

/**
 * Remove all custom OAuth providers registered by a source.
 */
export function unregisterOAuthProviders(sourceId: string): void {
	for (const [id, provider] of customOAuthProviders.entries()) {
		if (provider.sourceId === sourceId) {
			customOAuthProviders.delete(id);
		}
	}
}

/**
 * Refresh a built-in OAuth grant, cancelling provider work when refresh ownership ends.
 */
export async function refreshOAuthToken(
	provider: OAuthProvider,
	credentials: OAuthCredentials,
	signal?: AbortSignal,
): Promise<OAuthCredentials> {
	if (!credentials) {
		throw new AIError.OAuthError(`No OAuth credentials found for ${provider}`, {
			kind: "validation",
			provider,
		});
	}
	const def = getProviderDefinition(provider);
	if (!def?.login) {
		throw new AIError.OAuthError(`Unknown OAuth provider: ${provider}`, {
			kind: "validation",
			provider,
		});
	}
	// Providers without a real refresher (static bearer tokens / API keys that
	// don't expire) return the credentials unchanged.
	return def.refreshToken ? def.refreshToken(credentials, signal) : credentials;
}
const JWT_EXPIRY_SKEW_MS = 5 * 60_000;

/**
 * Build API-key bytes for a provider from an already-fresh OAuth credential.
 *
 * Refresh is owned by AuthStorage. This helper deliberately refuses expired
 * credentials so it cannot POST broker redaction sentinels to upstream token
 * endpoints as a side channel.
 *
 * For providers that need credential metadata at request time, returns
 * JSON-encoded credentials plus expiry metadata for diagnostics/edge guards.
 * @returns API key string, or null if no credentials
 * @throws Error if the credential is expired and must be refreshed upstream
 */
export async function getOAuthApiKey(
	provider: OAuthProvider,
	credentials: Record<string, OAuthCredentials>,
): Promise<{ newCredentials: OAuthCredentials; apiKey: string } | null> {
	let creds = credentials[provider];
	if (!creds) {
		return null;
	}

	const policy = authPolicyFor(provider);
	const jwtOrNever = policy?.expiry === "jwt-or-never";
	if (jwtOrNever) {
		// Session JWTs (Perplexity) usually omit `exp` (server-side sessions).
		// Trust the JWT claim when present; otherwise treat the credential as
		// non-expiring rather than honoring a stale stored `expires` (older
		// logins wrote loginTime+1h).
		const normalizedExpires =
			creds.expires > 0 && creds.expires < 10_000_000_000 ? creds.expires * 1000 : creds.expires;
		const jwtExpiry = jwtExpiryMs(creds.access, JWT_EXPIRY_SKEW_MS);
		const expires = jwtExpiry ?? Math.max(normalizedExpires, NEVER_EXPIRES);
		if (expires !== creds.expires) {
			creds = { ...creds, expires };
		}
	}
	// Refresh is the sole responsibility of `AuthStorage` (which calls
	// `refreshOAuthToken` directly with broker-aware single-flighting). If we
	// reach here with an expired credential, the outer pipeline failed to
	// refresh before this call OR the refresh slot is the broker sentinel —
	// either way, posting the credential to a provider endpoint would only
	// trigger a `__remote__`-against-real-provider failure that gets classified
	// as `invalid_grant` and disables the row. Refuse loudly instead.
	if (Date.now() >= creds.expires) {
		if (jwtOrNever) {
			const jwtExpiry = jwtExpiryMs(creds.access, JWT_EXPIRY_SKEW_MS);
			if (jwtExpiry && Date.now() < jwtExpiry) {
				const fallbackCredentials = { ...creds, expires: jwtExpiry };
				return { newCredentials: fallbackCredentials, apiKey: fallbackCredentials.access };
			}
		}
		throw new AIError.OAuthError(
			`OAuth credential for ${provider} is expired and must be refreshed via AuthStorage before getOAuthApiKey is called`,
			{ kind: "validation", provider },
		);
	}
	// Providers declaring `api-key-format "structured"` need request-time
	// credential metadata, so the API key is the JSON-encoded credential.
	const apiKey =
		policy?.apiKeyFormat === "structured"
			? JSON.stringify({
					apiEndpoint: creds.apiEndpoint,
					token: creds.access,
					enterpriseUrl: creds.enterpriseUrl,
					projectId: creds.projectId,
					refreshToken: creds.refresh,
					expiresAt: creds.expires,
					email: creds.email,
					accountId: creds.accountId,
				})
			: creds.access;
	return { newCredentials: creds, apiKey };
}

/**
 * Get list of OAuth providers.
 */
export function getOAuthProviders(): OAuthProviderInfo[] {
	const customProviders = Array.from(customOAuthProviders.values(), provider => ({
		id: provider.id,
		name: provider.name,
		available: true,
		storeCredentialsAs: provider.storeCredentialsAs,
	}));
	return [...builtInOAuthProviders, ...customProviders];
}
