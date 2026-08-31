/**
 * AIML API "Get API key" login — Device Authorization Grant (RFC 8628).
 *
 * Selecting AIML API in `/login` runs this flow: it starts a device
 * authorization, shows the user a consent link to open in their browser, and
 * polls until they approve — at which point AIML API mints an API key that is
 * returned and stored as the provider credential. No local callback server and
 * no redirect URI, so it works over SSH / in sandboxes just like the other
 * device-code providers here (see `kilo.ts`).
 *
 * Endpoints default to production and are overridable for testing via
 * `AIMLAPI_APP_URL` (start + poll host) and `AIMLAPI_VERIFICATION_BASE_URL`
 * (the browser consent page). Every request carries the partner attribution
 * headers so the sign-up is credited to this client.
 */

import {
	AIMLAPI_SOURCE,
	getAimlApiCommonHeaders,
	resolveAimlApiPartnerId,
	resolveAimlApiPartnerName,
} from "@oh-my-pi/pi-catalog/provider-models/aimlapi";
import * as AIError from "../../error";
import type { FetchImpl } from "../../types";
import type { OAuthController } from "./types";

const PROVIDER = "aimlapi";
const AGENT_NAME = "Oh My Pi";
const DEVICE_CODE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";

const DEFAULT_APP_URL = "https://app.aimlapi.com";
const DEFAULT_VERIFICATION_BASE_URL = "https://aimlapi.com/app";
/** OpenAI-compatible inference host — also serves the key-validation balance probe. */
const DEFAULT_INFERENCE_URL = "https://api.aimlapi.com/v1";

/** Cap the manual-key validation probe so a stuck network can't hang login. */
const VALIDATION_TIMEOUT_MS = 15_000;

const DEFAULT_INTERVAL_SECONDS = 5;
const DEFAULT_EXPIRES_IN_SECONDS = 900;
/** Requested spend cap for the minted key, in USD minor units (cents). */
const DEFAULT_REQUESTED_USD_LIMIT_MINOR = 1000;

/** Poll statuses that mean the flow is over and no key will be issued. */
const TERMINAL_FAILURE_STATUSES = new Set([
	"cancelled",
	"canceled",
	"denied",
	"error",
	"expired",
	"failed",
	"rejected",
]);

interface StartAuthorizationResponse {
	requestId?: string;
	deviceCode?: string;
	interval?: number;
	expiresIn?: number;
}

interface PollTokenResponse {
	status?: string;
	apiKey?: string;
	api_key?: string;
	access_token?: string;
	key?: string;
}

function envOrDefault(name: string, fallback: string): string {
	const value = Bun.env[name]?.trim();
	return value ? value : fallback;
}

function resolveAppUrl(): string {
	return envOrDefault("AIMLAPI_APP_URL", DEFAULT_APP_URL).replace(/\/+$/, "");
}

function resolveVerificationBaseUrl(): string {
	return envOrDefault("AIMLAPI_VERIFICATION_BASE_URL", DEFAULT_VERIFICATION_BASE_URL);
}

function resolveInferenceBaseUrl(): string {
	return envOrDefault("AIMLAPI_INFERENCE_URL", DEFAULT_INFERENCE_URL).replace(/\/+$/, "");
}

/**
 * Verify a manually-pasted key actually works before accepting it — otherwise a
 * bad key would be stored and the provider shown as "logged in" until the first
 * real request 401s. Uses the balance endpoint (`GET /v1/billing/balance`): it
 * needs auth (401 on a bad key) but, unlike an inference call, spends nothing
 * and any valid key of the account can read it. Honors `AIMLAPI_INFERENCE_URL`
 * so it validates against the same environment inference will run on.
 */
async function validateAimlApiKey(apiKey: string, fetchImpl: FetchImpl, signal?: AbortSignal): Promise<void> {
	const timeoutSignal = AbortSignal.timeout(VALIDATION_TIMEOUT_MS);
	const combinedSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;

	const response = await fetchImpl(`${resolveInferenceBaseUrl()}/billing/balance`, {
		method: "GET",
		headers: {
			Accept: "application/json",
			Authorization: `Bearer ${apiKey}`,
			...getAimlApiCommonHeaders(),
		},
		signal: combinedSignal,
	});

	if (response.ok) return;

	// Report the status only — the API's error body (the "create a key on the
	// Billing page" blurb) makes the one-line login error too long to read.
	throw new AIError.ApiKeyRequiredError(`aimlapi.com API key validation failed (${response.status})`);
}

function resolveRequestedUsdLimitMinor(): number {
	const raw = Bun.env.AIMLAPI_REQUESTED_USD_LIMIT_MINOR;
	if (raw === undefined) return DEFAULT_REQUESTED_USD_LIMIT_MINOR;
	const value = Number.parseInt(raw, 10);
	return Number.isFinite(value) && value > 0 ? value : DEFAULT_REQUESTED_USD_LIMIT_MINOR;
}

/**
 * Build the browser consent URL from the configured verification base — never
 * trusted from the response — so a compromised backend can't redirect the user
 * to an arbitrary host. Carries `source=<channel>/<client>` so the consent page
 * can attribute the sign-up: the query survives the browser redirect that
 * creates the account, where the `X-AIMLAPI-Source` request header cannot.
 */
function buildVerificationUrl(requestId: string): string {
	const base = resolveVerificationBaseUrl().replace(/\/+$/, "");
	const params = new URLSearchParams({ request: requestId, source: AIMLAPI_SOURCE });
	return `${base}/agent/authorize?${params.toString()}`;
}

function positiveOrDefault(value: number | undefined, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

/** Sleep that rejects immediately on abort so cancelling doesn't wait out the interval. */
function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal?.aborted) {
			reject(new AIError.LoginCancelledError());
			return;
		}
		const timer = setTimeout(resolve, ms);
		signal?.addEventListener(
			"abort",
			() => {
				clearTimeout(timer);
				reject(new AIError.LoginCancelledError());
			},
			{ once: true },
		);
	});
}

interface PollParams {
	fetchImpl: FetchImpl;
	appUrl: string;
	requestHeaders: Record<string, string>;
	deviceCode: string;
	intervalMs: number;
	expiresInSeconds: number;
	signal: AbortSignal;
}

/** Poll the token endpoint until the browser approval mints a key (or it fails/expires). */
async function pollForApiKey(params: PollParams): Promise<string> {
	const { fetchImpl, appUrl, requestHeaders, deviceCode, intervalMs, expiresInSeconds, signal } = params;
	const deadline = Date.now() + expiresInSeconds * 1000;
	while (Date.now() < deadline) {
		if (signal.aborted) {
			throw new AIError.LoginCancelledError();
		}

		const pollResponse = await fetchImpl(`${appUrl}/v3/agent-auth/token`, {
			method: "POST",
			headers: requestHeaders,
			body: JSON.stringify({
				partnerId: resolveAimlApiPartnerId(),
				deviceCode,
				grant_type: DEVICE_CODE_GRANT,
			}),
			signal,
		});

		if (!pollResponse.ok) {
			throw new AIError.OAuthError(`AIML API authorization check failed: ${pollResponse.status}`, {
				kind: "polling",
				provider: PROVIDER,
				status: pollResponse.status,
			});
		}

		const pollData = (await pollResponse.json()) as PollTokenResponse;
		const apiKey = (pollData.apiKey || pollData.api_key || pollData.access_token || pollData.key || "").trim();
		if (apiKey) {
			return apiKey;
		}

		const status = (pollData.status ?? "").trim().toLowerCase();
		if (TERMINAL_FAILURE_STATUSES.has(status)) {
			throw new AIError.OAuthError(`AIML API authorization ${status}`, {
				kind: "device-auth",
				provider: PROVIDER,
			});
		}

		await abortableSleep(intervalMs, signal);
	}

	throw new AIError.OAuthError("AIML API authorization timed out. Please try again.", {
		kind: "timeout",
		provider: PROVIDER,
	});
}

/**
 * Runs two paths for one key, first to finish wins:
 *  - the browser device grant (poll), and
 *  - an optional manual paste field ({@link OAuthController.onPrompt}) for users
 *    who already have a key — parity with OpenRouter's paste flow.
 *
 * When the browser side wins it drops the minted key into the paste field via
 * {@link OAuthController.onPromptResolve} (green "already generated" line); when
 * the user pastes first, polling is aborted. Without an `onPrompt` surface it
 * degrades to a plain device-grant login (progress message, no field).
 */
export async function loginAimlApi(callbacks: OAuthController): Promise<string> {
	const fetchImpl = callbacks.fetch ?? fetch;
	const appUrl = resolveAppUrl();
	const requestHeaders = {
		"Content-Type": "application/json",
		Accept: "application/json",
		...getAimlApiCommonHeaders(),
	};

	callbacks.onProgress?.("Starting AIML API authorization…");
	const startResponse = await fetchImpl(`${appUrl}/v3/agent-auth/authorizations`, {
		method: "POST",
		headers: requestHeaders,
		body: JSON.stringify({
			partnerId: resolveAimlApiPartnerId(),
			partnerName: resolveAimlApiPartnerName(),
			agentName: AGENT_NAME,
			returnUrl: resolveVerificationBaseUrl(),
			requestedUsdLimitMinor: resolveRequestedUsdLimitMinor(),
		}),
		signal: callbacks.signal,
	});

	if (!startResponse.ok) {
		throw new AIError.OAuthError(`Failed to start AIML API authorization: ${startResponse.status}`, {
			kind: "device-auth",
			provider: PROVIDER,
			status: startResponse.status,
		});
	}

	const startData = (await startResponse.json()) as StartAuthorizationResponse;
	const requestId = startData.requestId?.trim();
	const deviceCode = startData.deviceCode?.trim();
	if (!requestId || !deviceCode) {
		throw new AIError.OAuthError("AIML API authorization response is incomplete", {
			kind: "validation",
			provider: PROVIDER,
		});
	}

	const intervalMs = positiveOrDefault(startData.interval, DEFAULT_INTERVAL_SECONDS) * 1000;
	const expiresInSeconds = positiveOrDefault(startData.expiresIn, DEFAULT_EXPIRES_IN_SECONDS);

	callbacks.onAuth?.({
		url: buildVerificationUrl(requestId),
		instructions: "Sign in via the link above and we'll create an API key for you.",
	});

	// One abort controller drives both the poll loop and any in-flight token
	// fetch; it fires when either path wins, or when the caller cancels login.
	const abort = new AbortController();
	const cancel = () => abort.abort();
	callbacks.signal?.addEventListener("abort", cancel, { once: true });

	const poll = pollForApiKey({
		fetchImpl,
		appUrl,
		requestHeaders,
		deviceCode,
		intervalMs,
		expiresInSeconds,
		signal: abort.signal,
	});

	try {
		return await new Promise<string>((resolve, reject) => {
			let settled = false;
			const win = (key: string) => {
				if (settled) return;
				settled = true;
				resolve(key);
			};
			const fail = (error: unknown) => {
				if (settled) return;
				settled = true;
				reject(error);
			};

			poll.then(key => {
				// Browser approval finished. Reflect the minted key into the paste
				// field (screen shows it filled + a green confirmation); fall back
				// to a progress line when there is no field to fill.
				if (callbacks.onPromptResolve) {
					callbacks.onPromptResolve(key, "Your key has already been generated and added above");
				} else {
					callbacks.onProgress?.("Your API key was successfully generated.");
				}
				win(key);
			}, fail);

			// Manual paste option. A non-empty submit is validated before it wins;
			// an empty submit is ignored so the browser flow can still complete. No
			// placeholder: the field stays bare until the browser flow auto-fills it
			// (onPromptResolve).
			const pastePrompt = callbacks.onPrompt?.({
				message: "Already have an aimlapi.com API key? Just paste it below.",
			});
			pastePrompt?.then(async value => {
				const trimmed = value.trim();
				if (!trimmed) return;
				try {
					// Prove the pasted key works (non-inference balance probe) before
					// accepting it — a bad key must fail login, not be stored as valid.
					callbacks.onProgress?.("Validating API key...");
					await validateAimlApiKey(trimmed, fetchImpl, abort.signal);
					win(trimmed);
				} catch (error) {
					fail(error);
				}
			}, fail);
		});
	} finally {
		abort.abort();
		callbacks.signal?.removeEventListener("abort", cancel);
	}
}
