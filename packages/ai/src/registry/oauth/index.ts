// ============================================================================
// High-level API
// ============================================================================

import * as AIError from "../../error";
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
function getPerplexityJwtExpiryMs(token: string): number | undefined {
	const parts = token.split(".");
	if (parts.length !== 3) return undefined;
	const payload = parts[1];
	if (!payload) return undefined;
	try {
		const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { exp?: unknown };
		if (typeof decoded.exp !== "number" || !Number.isFinite(decoded.exp)) return undefined;
		return decoded.exp * 1000 - 5 * 60_000;
	} catch {
		return undefined;
	}
}

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

	if (provider === "perplexity") {
		// Perplexity JWTs usually omit `exp` (server-side sessions). Trust the JWT
		// claim when present; otherwise treat the credential as non-expiring rather
		// than honoring a stale stored `expires` (older logins wrote loginTime+1h).
		const NEVER_EXPIRES = 8.64e15;
		const normalizedExpires =
			creds.expires > 0 && creds.expires < 10_000_000_000 ? creds.expires * 1000 : creds.expires;
		const jwtExpiry = getPerplexityJwtExpiryMs(creds.access);
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
		if (provider === "perplexity") {
			const jwtExpiry = getPerplexityJwtExpiryMs(creds.access);
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
	// For providers that need request-time credential metadata, return JSON.
	const needsStructuredApiKey =
		provider === "github-copilot" ||
		provider === "google-gemini-cli" ||
		provider === "google-antigravity" ||
		provider === "alibaba-coding-plan";
	const apiKey = needsStructuredApiKey
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
