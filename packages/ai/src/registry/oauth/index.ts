// ============================================================================
// High-level API
// ============================================================================

import { authPolicyFor } from "@oh-my-pi/pi-catalog/compat/auth";
import {
	callThroughGate,
	type GatedRegistration,
	type ProviderCallGate,
	selectLiveRegistration,
} from "../../auth/provider-gate";
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

/**
 * A custom OAuth provider as its author wrote it. The registry can record `id` and `sourceId`
 * beside the object (see {@link OAuthProviderRegistrationOptions}), so the object need not carry
 * them.
 */
export type CustomOAuthProvider = Omit<OAuthProviderInterface, "id" | "sourceId"> &
	Partial<Pick<OAuthProviderInterface, "id" | "sourceId">>;

/** What the registry records beside a provider, never on it. */
export interface OAuthProviderRegistrationOptions {
	/** Registry key. Defaults to the provider's own `id`. */
	readonly id?: OAuthProviderId;
	/** Source that {@link unregisterOAuthProviders} matches. Defaults to the provider's own `sourceId`. */
	readonly sourceId?: string;
	/** Lifetime of the session that registered the provider. Omitted for the host's own. */
	readonly gate?: ProviderCallGate;
}

/** One registration of a custom OAuth provider: the author's object, stored as given, and what
 *  the registry knows about it. Call the provider's methods on `provider` itself, through `gate`. */
export interface OAuthProviderRegistration extends GatedRegistration {
	readonly provider: CustomOAuthProvider;
	readonly id: OAuthProviderId;
	readonly sourceId?: string;
}

/** Registrations by provider id, oldest first. Several sessions can register one id; the newest
 *  live one answers. A retired registration stays until it is unregistered: retirement only stops
 *  it being selected. */
const customOAuthProviders = new Map<string, OAuthProviderRegistration[]>();

/**
 * Register a custom OAuth provider. The object is stored as given. Its own `id` and `sourceId` are
 * read only when `options` does not supply them, and then through the registration's gate, since a
 * property of the author's object may be a getter. Registering an id again with the same gate (or,
 * for the host, again without one) replaces that registration in place.
 */
export function registerOAuthProvider(
	provider: OAuthProviderInterface,
	options?: OAuthProviderRegistrationOptions,
): void;
export function registerOAuthProvider(
	provider: CustomOAuthProvider,
	options: OAuthProviderRegistrationOptions & { readonly id: OAuthProviderId },
): void;
export function registerOAuthProvider(provider: CustomOAuthProvider, options?: OAuthProviderRegistrationOptions): void {
	const gate = options?.gate;
	const id = options?.id ?? callThroughGate(gate, () => provider.id);
	if (id === undefined) {
		throw new AIError.ConfigurationError("Cannot register an OAuth provider without an id.");
	}
	const sourceId = options?.sourceId ?? callThroughGate(gate, () => provider.sourceId);
	const registration: OAuthProviderRegistration = { provider, id, sourceId, gate };
	const registrations = customOAuthProviders.get(id);
	if (!registrations) {
		customOAuthProviders.set(id, [registration]);
		return;
	}
	const index = registrations.findIndex(entry => entry.gate === gate);
	if (index === -1) {
		registrations.push(registration);
	} else {
		registrations[index] = registration;
	}
}

/** Drops the registrations of `id` that `remove` matches, and the id once none are left. */
function removeOAuthRegistrations(id: string, remove: (entry: OAuthProviderRegistration) => boolean): void {
	const registrations = customOAuthProviders.get(id);
	if (!registrations) return;
	const kept = registrations.filter(entry => !remove(entry));
	if (kept.length === 0) {
		customOAuthProviders.delete(id);
	} else if (kept.length !== registrations.length) {
		customOAuthProviders.set(id, kept);
	}
}

/**
 * Remove a custom OAuth provider by ID: only `gate`'s registration when a gate is given, so other
 * sessions' registrations of the same ID go on being selected; every registration otherwise.
 */
export function unregisterOAuthProvider(id: string, gate?: ProviderCallGate): void {
	if (gate) {
		removeOAuthRegistrations(id, entry => entry.gate === gate);
	} else {
		customOAuthProviders.delete(id);
	}
}

/**
 * The registration in force for a custom OAuth provider ID: the newest one whose session is still
 * live. Calls into its provider go through {@link callThroughGate} with its `gate`.
 *
 * This is the only way to reach a registered provider, deliberately. A registration's `id` and
 * `sourceId` belong to THIS registry — a provider may expose an `id` of its own, through a
 * getter it alone controls, that disagrees with the name it was registered under — and the
 * author's object is handed back untouched, so the two cannot be read from one value. Returning
 * the entry keeps the registry's name and the author's object each saying only what it knows.
 */
export function getOAuthProviderEntry(id: OAuthProviderId): OAuthProviderRegistration | undefined {
	const registrations = customOAuthProviders.get(id);
	return registrations ? selectLiveRegistration(registrations) : undefined;
}

/**
 * Remove the custom OAuth provider registrations made for a source: only `gate`'s when a gate is
 * given, every session's otherwise.
 */
export function unregisterOAuthProviders(sourceId: string, gate?: ProviderCallGate): void {
	for (const id of customOAuthProviders.keys()) {
		removeOAuthRegistrations(id, entry => entry.sourceId === sourceId && (!gate || entry.gate === gate));
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
	const customProviders: OAuthProviderInfo[] = [];
	for (const registrations of customOAuthProviders.values()) {
		const entry = selectLiveRegistration(registrations);
		if (!entry) continue;
		const { provider } = entry;
		// `name` and `storeCredentialsAs` are the author's properties (either may be a getter), so
		// they are read as the owning session's work.
		customProviders.push(
			callThroughGate(entry.gate, () => ({
				id: entry.id,
				name: provider.name,
				available: true,
				storeCredentialsAs: provider.storeCredentialsAs,
			})),
		);
	}
	return [...builtInOAuthProviders, ...customProviders];
}

/** Provider id that stores `providerId`'s credentials: login aliases (`openai-codex-device`) map to their target (`openai-codex`). */
export function getOAuthCredentialProvider(providerId: string): string {
	const builtIn = builtInOAuthProviders.find(provider => provider.id === providerId);
	if (builtIn) return builtIn.storeCredentialsAs ?? providerId;
	const entry = getOAuthProviderEntry(providerId);
	if (!entry) return providerId;
	// Only this provider's property is read, as its owning session's work: listing every
	// provider would run each one's `name` getter for nothing.
	const { provider } = entry;
	return callThroughGate(entry.gate, () => provider.storeCredentialsAs) ?? providerId;
}
