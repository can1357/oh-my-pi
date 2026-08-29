import type { Api, Model } from "@oh-my-pi/pi-ai/types";
import type { ModelResolutionSource } from "@oh-my-pi/pi-catalog/model-manager";
import {
	MODELS_DEV_CATALOG_PROVIDER_IDS,
	type OpenAICodexAccount,
	PROVIDER_DESCRIPTORS,
} from "@oh-my-pi/pi-catalog/provider-models";
import type { AuthStorage, OAuthCredential } from "../session/auth-storage";

/**
 * Built-in providers whose discovery requires provider-specific credentials
 * or account expansion and therefore cannot use the standard descriptor path.
 */
export const SPECIAL_MODEL_MANAGER_PROVIDER_IDS: readonly string[] = [
	"google-antigravity",
	"google-gemini-cli",
	"openai-codex",
];

const STARTUP_MODEL_CACHE_PROVIDER_IDS_RECORD: Record<string, true> = Object.create(null);
for (const providerId of [
	...PROVIDER_DESCRIPTORS.map(descriptor => descriptor.providerId),
	...SPECIAL_MODEL_MANAGER_PROVIDER_IDS,
	...MODELS_DEV_CATALOG_PROVIDER_IDS,
]) {
	STARTUP_MODEL_CACHE_PROVIDER_IDS_RECORD[providerId] = true;
}

export const STARTUP_MODEL_CACHE_PROVIDER_IDS: readonly string[] = Object.keys(STARTUP_MODEL_CACHE_PROVIDER_IDS_RECORD);

// Sentinels for local-only OAuth tokens — declared inline to avoid loading
// provider modules at startup. Must match packages/ai/src/registry/llama-cpp.ts,
// packages/ai/src/registry/lm-studio.ts, and packages/ai/src/registry/vllm.ts.
const LOCAL_PROVIDER_PLACEHOLDERS = new Set<string>(["llama-cpp-local", "lm-studio-local", "vllm-local"]);

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

/**
 * Pull the GCP project id out of a Google structured discovery key
 * (`{ token, projectId, ... }` or `{ token, project_id, ... }`). Runtime/config API-key overrides and
 * refreshed OAuth credentials carry the project inline; raw bare tokens do
 * not. Returns `undefined` when the value is not structured or omits the id.
 */
export function extractGoogleOAuthProjectId(value: string | undefined): string | undefined {
	if (!isAuthenticated(value)) return undefined;
	try {
		const parsed = JSON.parse(value) as { projectId?: unknown; project_id?: unknown };
		const rawProjectId = typeof parsed.projectId === "string" ? parsed.projectId : parsed.project_id;
		if (typeof rawProjectId === "string") {
			const projectId = rawProjectId.trim();
			return projectId.length > 0 ? projectId : undefined;
		}
	} catch {
		// Raw (non-JSON) tokens carry no project id.
	}
	return undefined;
}

export function getOAuthCredentialsForProvider(authStorage: AuthStorage, provider: string): OAuthCredential[] {
	const providerEntry = authStorage.getAll()[provider];
	if (!providerEntry) {
		return [];
	}
	const entries = Array.isArray(providerEntry) ? providerEntry : [providerEntry];
	return entries.filter((entry): entry is OAuthCredential => entry.type === "oauth");
}

/**
 * Resolve every configured Codex OAuth account for catalog discovery, refreshing
 * each credential exactly once. Codex `/models` is account-scoped, so discovery
 * must fetch per account and union the results; resolving a single access token
 * (as before) hid models available only through a sibling account (#6265).
 *
 * Returns `null` when any stored account fails to resolve (e.g. a transient
 * refresh failure): the Codex manager is authoritative, so unioning only the
 * accounts that resolved would cache a partial catalog and hide the failed
 * account's models for the cache TTL. Aborting keeps the previous/bundled
 * catalog instead.
 */
export async function resolveCodexDiscoveryAccounts(
	authStorage: AuthStorage,
	resolvedAccessToken: string,
): Promise<OpenAICodexAccount[] | null> {
	const accesses = await authStorage.getOAuthAccesses("openai-codex");
	const accounts: OpenAICodexAccount[] = [];
	for (const access of accesses) {
		if (!access.ok) return null;
		accounts.push({ accessToken: access.accessToken, accountId: access.accountId });
	}
	if (!accounts.some(account => account.accessToken === resolvedAccessToken)) {
		const matchingCredential = getOAuthCredentialsForProvider(authStorage, "openai-codex").find(
			credential => credential.access === resolvedAccessToken,
		);
		accounts.push({ accessToken: resolvedAccessToken, accountId: matchingCredential?.accountId });
	}
	return accounts;
}
