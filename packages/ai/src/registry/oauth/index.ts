// ============================================================================
// High-level API
// ============================================================================

import { authPolicyFor, providerDisabledReason, providerLoginWarning } from "@oh-my-pi/pi-catalog/compat/auth";
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

// A provider whose login carries an account risk (`login-warning`) says so in its label.
// One turned off in its auth rules (`disabled "<reason>"`) is filtered out at list time,
// since the end user may opt back in (see setUnpausedProviders).
const builtInOAuthProviders: OAuthProviderInfo[] = PROVIDER_REGISTRY.filter(
	provider => provider.login && provider.showInLoginList !== false,
).map(provider => ({
	id: provider.id,
	name: providerLoginWarning(provider.id) === undefined ? provider.name : `${provider.name} (at your own risk)`,
	available: provider.available ?? true,
	storeCredentialsAs: provider.storeCredentialsAs,
}));

const customOAuthProviders = new Map<string, OAuthProviderInterface>();

/** Paused provider ids the end user turned back on (see {@link setUnpausedProviders}). */
let unpausedProviders: ReadonlySet<string> = new Set();

/** Bumped whenever {@link providerPauseReason} may answer differently for some id. */
let pauseRevision = 0;

/**
 * Counter that moves whenever which providers are paused may have changed: the
 * unpaused list, or an extension login taking or releasing a paused id. Caches
 * that filter on {@link providerPauseReason} compare it to know when to refilter.
 */
export function providerPauseRevision(): number {
	return pauseRevision;
}

/** Bumps {@link pauseRevision} when `provider` is one the auth rules pause. */
function notePauseOverride(provider: string): void {
	if (providerDisabledReason(provider) !== undefined) pauseRevision++;
}

/**
 * Turns paused providers back on: each listed id ignores its `disabled "<reason>"`
 * auth rule, so it is a login choice again and its stored or env credentials resolve.
 * Replaces the previous list; ids that are not paused are ignored. Loaded credential
 * pools pick the change up on their next read.
 */
export function setUnpausedProviders(providers: Iterable<string>): void {
	const next = new Set(providers);
	if (next.size === unpausedProviders.size && [...next].every(provider => unpausedProviders.has(provider))) return;
	unpausedProviders = next;
	pauseRevision++;
}

/**
 * Register a custom OAuth provider.
 */
export function registerOAuthProvider(provider: OAuthProviderInterface): void {
	customOAuthProviders.set(provider.id, provider);
	notePauseOverride(provider.id);
}

/**
 * Remove a custom OAuth provider by ID.
 */
export function unregisterOAuthProvider(id: string): void {
	if (customOAuthProviders.delete(id)) notePauseOverride(id);
}

/**
 * Get a custom OAuth provider by ID.
 */
export function getOAuthProvider(id: OAuthProviderId): OAuthProviderInterface | undefined {
	return customOAuthProviders.get(id);
}

/**
 * Why `provider` is paused by its auth rules (`disabled "<reason>"`), or
 * undefined when it may be reached. An extension that registers its own OAuth
 * login under the paused id, or listing it in {@link setUnpausedProviders},
 * takes the id back: that is the end user's choice.
 */
export function providerPauseReason(provider: string): string | undefined {
	if (customOAuthProviders.has(provider) || unpausedProviders.has(provider)) return undefined;
	return providerDisabledReason(provider);
}

/** Throws {@link AIError.ProviderDisabledError} when {@link providerPauseReason} pauses `provider`. */
export function assertProviderEnabled(provider: string): void {
	const reason = providerPauseReason(provider);
	if (reason !== undefined) throw new AIError.ProviderDisabledError(provider, reason);
}

/**
 * The account risk a new built-in login of `provider` must accept first
 * (`login-warning "<text>"`), or undefined. An extension that registers its
 * own OAuth login under the id owns that prompt instead.
 */
export function loginRiskWarning(provider: string): string | undefined {
	return customOAuthProviders.has(provider) ? undefined : providerLoginWarning(provider);
}

/**
 * Remove all custom OAuth providers registered by a source.
 */
export function unregisterOAuthProviders(sourceId: string): void {
	for (const [id, provider] of customOAuthProviders.entries()) {
		if (provider.sourceId === sourceId) {
			customOAuthProviders.delete(id);
			notePauseOverride(id);
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
	// A paused provider never starts a token exchange, even for an SDK caller holding an old credential.
	assertProviderEnabled(provider);
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
export function normalizeOAuthCredentialExpiry<T extends OAuthCredentials>(provider: string, credentials: T): T {
	if (authPolicyFor(provider)?.expiry !== "jwt-or-never") return credentials;

	// Trust a JWT expiry claim when present; otherwise treat providers with
	// non-expiring sessions as such rather than honoring stale stored expiry
	// timestamps written by older login implementations.
	const normalizedExpires =
		credentials.expires > 0 && credentials.expires < 10_000_000_000
			? credentials.expires * 1000
			: credentials.expires;
	const expires = jwtExpiryMs(credentials.access, JWT_EXPIRY_SKEW_MS) ?? Math.max(normalizedExpires, NEVER_EXPIRES);
	return expires === credentials.expires ? credentials : ({ ...credentials, expires } as T);
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

	const policy = authPolicyFor(provider);
	creds = normalizeOAuthCredentialExpiry(provider, creds);
	// Refresh is the sole responsibility of `AuthStorage` (which calls
	// `refreshOAuthToken` directly with broker-aware single-flighting). If we
	// reach here with an expired credential, the outer pipeline failed to
	// refresh before this call OR the refresh slot is the broker sentinel —
	// either way, posting the credential to a provider endpoint would only
	// trigger a `__remote__`-against-real-provider failure that gets classified
	// as `invalid_grant` and disables the row. Refuse loudly instead.
	if (Date.now() >= creds.expires) {
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
	// Extension-registered logins are listed as-is: registering one is the end user's choice,
	// even under an id the auth rules pause (see providerPauseReason).
	const customProviders = Array.from(customOAuthProviders.values(), provider => ({
		id: provider.id,
		name: provider.name,
		available: true,
		storeCredentialsAs: provider.storeCredentialsAs,
	}));
	// A built-in entry an extension took over is listed once, as the extension's; a paused one not at all.
	const builtIns = builtInOAuthProviders.filter(
		provider => !customOAuthProviders.has(provider.id) && providerPauseReason(provider.id) === undefined,
	);
	return [...builtIns, ...customProviders];
}

/** Provider id that stores `providerId`'s credentials: login aliases (`openai-codex-device`) map to their target (`openai-codex`). */
export function getOAuthCredentialProvider(providerId: string): string {
	return getOAuthProviders().find(provider => provider.id === providerId)?.storeCredentialsAs ?? providerId;
}
