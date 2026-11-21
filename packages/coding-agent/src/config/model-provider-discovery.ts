import type { OAuthAccess } from "@oh-my-pi/pi-ai";
import type { Api, Model } from "@oh-my-pi/pi-ai/types";
import { authProviders, providerRefreshesOnUseOnly } from "@oh-my-pi/pi-catalog/compat/auth";
import type { ModelResolutionSource } from "@oh-my-pi/pi-catalog/model-manager";
import { MODELS_DEV_CATALOG_PROVIDER_IDS, PROVIDER_DESCRIPTORS } from "@oh-my-pi/pi-catalog/provider-models";
import type { AuthStorage, OAuthCredential } from "../session/auth-storage";

/**
 * Built-in providers whose discovery requires provider-specific credentials
 * or account expansion and therefore cannot use the standard descriptor path.
 */
export const SPECIAL_MODEL_MANAGER_PROVIDER_IDS: readonly string[] = ["google-antigravity", "kiro", "openai-codex"];

const STARTUP_MODEL_CACHE_PROVIDER_IDS_RECORD: Record<string, true> = Object.create(null);
for (const providerId of [
	...PROVIDER_DESCRIPTORS.map(descriptor => descriptor.providerId),
	...SPECIAL_MODEL_MANAGER_PROVIDER_IDS,
	...MODELS_DEV_CATALOG_PROVIDER_IDS,
]) {
	STARTUP_MODEL_CACHE_PROVIDER_IDS_RECORD[providerId] = true;
}

export const STARTUP_MODEL_CACHE_PROVIDER_IDS: readonly string[] = Object.keys(STARTUP_MODEL_CACHE_PROVIDER_IDS_RECORD);

// Keyless-mode markers: each api-key login's KDL `empty-fallback` (e.g.
// `lm-studio-local`), stored on an empty paste and never sent as a bearer.
const LOCAL_PROVIDER_PLACEHOLDERS = new Set<string>(
	authProviders().flatMap(entry =>
		entry.login?.kind === "api-key" && entry.login.emptyFallback ? [entry.login.emptyFallback] : [],
	),
);

/**
 * Hard bound for extension-provided fetchDynamicModels to prevent indefinite hangs
 * during runtime provider discovery. Uses a cancellable manual timer (not AbortSignal.timeout)
 * so a successful fast path does not leave an armed timeout signal for concurrent GC.
 */
export const RUNTIME_DYNAMIC_MODEL_FETCH_TIMEOUT_MS = 15_000;
// Built-in discovery preflight mirror of the catalog model-manager's private
// cache timings (model-manager.ts: DEFAULT_CACHE_TTL_MS / NON_AUTHORITATIVE_RETRY_MS).
// Built-in descriptors never override cacheTtlMs, so agreeing with these values
// makes the OAuth-refresh preflight fire exactly when the manager will fetch.
export const BUILT_IN_DISCOVERY_CACHE_TTL_MS = 2 * 60 * 60 * 1000;
export const BUILT_IN_DISCOVERY_NON_AUTHORITATIVE_RETRY_MS = 5 * 60 * 1000;
export const kNoAuth = "N/A";

export function isAuthenticated(apiKey: string | undefined | null): apiKey is string {
	return Boolean(apiKey) && apiKey !== kNoAuth;
}

export function isDiscoveryBearerApiKey(apiKey: string | undefined | null): apiKey is string {
	return isAuthenticated(apiKey) && !LOCAL_PROVIDER_PLACEHOLDERS.has(apiKey);
}

/**
 * Wraps a model-discovery operation with a hard timeout. Uses a cancellable
 * manual timer (not AbortSignal.timeout) so that a fast successful path does
 * not leave an armed timeout signal for concurrent GC. The inner operation
 * does not receive a signal because not every discovery contract accepts one.
 */
export async function withModelDiscoveryTimeout<T>(timeoutMs: number, run: () => Promise<T>): Promise<T> {
	const { promise: timeoutPromise, reject: timeoutReject } = Promise.withResolvers<never>();
	const timer = setTimeout(() => {
		timeoutReject(new Error(`model discovery timed out after ${timeoutMs}ms`));
	}, timeoutMs);
	try {
		return await Promise.race([run(), timeoutPromise]);
	} finally {
		clearTimeout(timer);
	}
}

export interface BuiltInDiscoveryResult {
	models: Model<Api>[];
	authoritativeProviders: Set<string>;
	/** Providers whose successful endpoint refresh replaces their prior dynamic discovery slice. */
	replaceRuntimeProviders: Set<string>;
}

export type ProviderDiscoveryStatus = "idle" | "ok" | "empty" | "cached" | "unavailable" | "unauthenticated";

export interface ProviderDiscoveryState {
	provider: string;
	status: ProviderDiscoveryStatus;
	optional: boolean;
	stale: boolean;
	fetchedAt?: number;
	source?: ModelResolutionSource;
	models: string[];
	error?: string;
}
export function extractGoogleOAuthToken(value: string | undefined): string | undefined {
	if (!isAuthenticated(value)) return undefined;
	try {
		const parsed = JSON.parse(value) as { token?: unknown };
		if (Object.hasOwn(parsed, "token")) {
			if (typeof parsed.token !== "string") {
				return undefined;
			}
			const token = parsed.token.trim();
			return token.length > 0 ? token : undefined;
		}
	} catch {
		// OAuth values for Google providers are expected to be JSON, but custom setups may already provide raw token.
	}
	return value;
}

export function getOAuthCredentialsForProvider(authStorage: AuthStorage, provider: string): OAuthCredential[] {
	const providerEntry = authStorage.credentials.all()[provider];
	if (!providerEntry) {
		return [];
	}
	const entries = Array.isArray(providerEntry) ? providerEntry : [providerEntry];
	return entries.filter((entry): entry is OAuthCredential => entry.type === "oauth");
}

/** One account resolved for discovery; `apiKey` is the key the provider's transport sends for it. */
export type OAuthDiscoveryAccount = OAuthAccess & { apiKey: string };

/** Accounts an account-scoped discovery reads; `partial` when some stored accounts were left out on purpose. */
export interface OAuthDiscoveryAccounts {
	accounts: OAuthDiscoveryAccount[];
	partial: boolean;
}

/**
 * Resolve every stored OAuth account of an account-scoped discovery provider
 * (Codex `/models`, Antigravity `fetchAvailableModels`, Kiro
 * `ListAvailableModels`), refreshing each credential exactly once. Discovery
 * must fetch per account and union the results; resolving a single access
 * token hid models available only through a sibling account (#6265, #14924).
 *
 * `resolvedKey` is the access token or encoded key the discovery preflight
 * resolved; it is appended when it belongs to no stored account (runtime or
 * env credential).
 *
 * A provider whose auth rule says `refresh { on-use-only #true }` refreshes
 * nothing here: only the preflight's account (the one about to be used) may
 * have been refreshed, and stored accounts whose token has expired are left
 * out. The result is then `partial`, so the union adds models without pruning
 * and is cached non-authoritative (short retry) instead of standing for the
 * whole catalog.
 *
 * Returns `null` when any stored account fails to resolve (e.g. a transient
 * refresh failure): these managers are authoritative, so unioning only the
 * accounts that resolved would cache a partial catalog and hide the failed
 * account's models for the cache TTL. Aborting keeps the previous/bundled
 * catalog instead.
 */
export async function resolveOAuthDiscoveryAccounts(
	authStorage: AuthStorage,
	provider: string,
	resolvedKey: string,
): Promise<OAuthDiscoveryAccounts | null> {
	const accesses = await authStorage.oauth.accessAll(
		provider,
		providerRefreshesOnUseOnly(provider) ? { refresh: "valid-only" } : undefined,
	);
	const accounts: OAuthDiscoveryAccount[] = [];
	let partial = false;
	for (const access of accesses) {
		if (access.ok) {
			accounts.push(access);
		} else if (access.skipped) {
			partial = true;
		} else {
			return null;
		}
	}
	if (!accounts.some(account => account.accessToken === resolvedKey || account.apiKey === resolvedKey)) {
		const matchingCredential = getOAuthCredentialsForProvider(authStorage, provider).find(
			credential => credential.access === resolvedKey,
		);
		accounts.push({
			accessToken: resolvedKey,
			apiKey: resolvedKey,
			accountId: matchingCredential?.accountId,
			email: matchingCredential?.email,
			projectId: matchingCredential?.projectId,
		});
	}
	return { accounts, partial };
}
