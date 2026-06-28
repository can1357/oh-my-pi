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

export type * from "./types";

const DEVICE_FLOW_CANCEL_MESSAGE = "Login cancelled";
const DEVICE_FLOW_TIMEOUT_MESSAGE = "Device flow timed out";
const DEVICE_FLOW_SLOW_DOWN_TIMEOUT_MESSAGE =
	"Device flow timed out after one or more slow_down responses. This is often caused by clock drift in WSL or VM environments. Please sync or restart the VM clock and try again.";
const MINIMUM_DEVICE_FLOW_INTERVAL_MS = 1000;
const DEFAULT_DEVICE_FLOW_INTERVAL_SECONDS = 5;
const SLOW_DOWN_INTERVAL_INCREMENT_MS = 5000;

/** Result returned by one OAuth device-code polling attempt. */
export type OAuthDeviceCodePollResult<T> =
	| { status: "complete"; value: T }
	| { status: "pending" }
	| { status: "slow_down" }
	| { status: "failed"; message: string };

/** Options for polling an RFC 8628-style OAuth device-code flow. */
export interface OAuthDeviceCodeFlowOptions<T> {
	/** Poll the provider once and classify the response. */
	poll(): OAuthDeviceCodePollResult<T> | Promise<OAuthDeviceCodePollResult<T>>;
	/** Provider-requested polling cadence; defaults to RFC 8628's five seconds. */
	intervalSeconds?: number;
	/** Provider-issued expiry window for the device code. */
	expiresInSeconds?: number;
	/** Cancels the flow with the legacy "Login cancelled" error. */
	signal?: AbortSignal;
}

async function abortableDeviceFlowSleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
	if (!signal) {
		await Bun.sleep(ms);
		return;
	}
	if (signal.aborted) {
		throw new AIError.LoginCancelledError(DEVICE_FLOW_CANCEL_MESSAGE);
	}

	const { promise, resolve, reject } = Promise.withResolvers<void>();
	let timer: Timer | undefined;
	const onAbort = () => {
		if (timer) clearTimeout(timer);
		reject(new AIError.LoginCancelledError(DEVICE_FLOW_CANCEL_MESSAGE));
	};
	timer = setTimeout(() => {
		signal.removeEventListener("abort", onAbort);
		resolve();
	}, ms);
	signal.addEventListener("abort", onAbort, { once: true });
	await promise;
}

/** Poll an OAuth device-code flow until completion, provider failure, timeout, or cancellation. */
export async function pollOAuthDeviceCodeFlow<T>(options: OAuthDeviceCodeFlowOptions<T>): Promise<T> {
	const deadline =
		typeof options.expiresInSeconds === "number"
			? Date.now() + options.expiresInSeconds * 1000
			: Number.POSITIVE_INFINITY;
	let intervalMs = Math.max(
		MINIMUM_DEVICE_FLOW_INTERVAL_MS,
		Math.floor((options.intervalSeconds ?? DEFAULT_DEVICE_FLOW_INTERVAL_SECONDS) * 1000),
	);
	let slowDownResponses = 0;

	while (Date.now() < deadline) {
		if (options.signal?.aborted) {
			throw new AIError.LoginCancelledError(DEVICE_FLOW_CANCEL_MESSAGE);
		}
		const result = await options.poll();
		if (result.status === "complete") {
			return result.value;
		}
		if (result.status === "failed") {
			throw new AIError.OAuthError(result.message, { kind: "polling" });
		}
		if (result.status === "slow_down") {
			slowDownResponses += 1;
			intervalMs = Math.max(MINIMUM_DEVICE_FLOW_INTERVAL_MS, intervalMs + SLOW_DOWN_INTERVAL_INCREMENT_MS);
		}

		const remainingMs = deadline - Date.now();
		if (remainingMs <= 0) {
			break;
		}
		await abortableDeviceFlowSleep(Math.min(intervalMs, remainingMs), options.signal);
	}

	throw new AIError.OAuthError(
		slowDownResponses > 0 ? DEVICE_FLOW_SLOW_DOWN_TIMEOUT_MESSAGE : DEVICE_FLOW_TIMEOUT_MESSAGE,
		{ kind: "timeout" },
	);
}

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
 * Refresh token for any OAuth provider.
 * Saves the new credentials and returns the new access token.
 */
export async function refreshOAuthToken(
	provider: OAuthProvider,
	credentials: OAuthCredentials,
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
	return def.refreshToken ? def.refreshToken(credentials) : credentials;
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
