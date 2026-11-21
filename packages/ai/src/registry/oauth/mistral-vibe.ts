/**
 * Mistral Vibe browser sign-in, mirroring the Vibe Code CLI (mistralai/mistral-vibe, vibe/setup/auth/):
 *  1. POST /api/vibe/sign-in { code_challenge, code_challenge_method: "S256" }
 *     -> { process_id, sign_in_url, poll_url, expires_at }
 *  2. The user approves at sign_in_url; poll_url answers { status, exchange_token? }
 *     (HTTP 410 once expired, 429 when polled too often).
 *  3. POST /api/vibe/sign-in/{process_id}/exchange { exchange_token, code_verifier } -> { api_key }
 *
 * The minted key is a regular Mistral API key billed against the plan's Vibe Code quota.
 */
import { type } from "@oh-my-pi/omptype";
import { isRecord, ptree } from "@oh-my-pi/pi-utils";
import * as AIError from "../../error";
import type { FetchImpl } from "../../types";
import { getRetryAfterMsFromHeaders } from "../../utils/retry-after";
import { throwIfCancelled } from "../engine/common";
import { type OAuthDeviceCodePollResult, pollOAuthDeviceCodeFlow } from "./device-code";
import { generatePKCE } from "./pkce";
import type { OAuthController } from "./types";

const PROVIDER = "mistral";
const CONSOLE_ORIGIN = "https://console.mistral.ai";
const API_PATH = "/api";
const REQUEST_TIMEOUT_MS = 30_000;
/** The Vibe CLI's poll cadence and failure budget. */
const POLL_INTERVAL_SECONDS = 3;
const MAX_CONSECUTIVE_POLL_FAILURES = 3;
/** Longest `Retry-After` honored, so one large value cannot hide an approval until expiry. */
const MAX_RETRY_AFTER_MS = 30_000;
/** Console `error_code` when the selected workspace may not mint API keys. */
const WORKSPACE_DENIED_ERROR_CODE = 9004;
const EXPIRED_MESSAGE = "Mistral sign-in expired; run /login again";

const startSchema = type({
	process_id: "string > 0",
	sign_in_url: "string",
	poll_url: "string",
	expires_at: "string",
});
const pollSchema = type({ status: "string", "exchange_token?": "string", "message?": "string" });
const exchangeSchema = type({ api_key: "string > 0" });

interface SignIn {
	processId: string;
	signInUrl: string;
	pollUrl: string;
	expiresAtMs: number;
}

function oauthError(message: string, kind: AIError.OAuthErrorKind, status?: number): AIError.OAuthError {
	return new AIError.OAuthError(message, { kind, provider: PROVIDER, status });
}

/** POST to the console API; cancellation surfaces as a cancelled login, an unparseable body as `undefined`. */
async function post(
	path: string,
	body: Record<string, string>,
	ctrl: OAuthController,
	fetchImpl: FetchImpl,
): Promise<{ response: Response; payload: unknown }> {
	throwIfCancelled(ctrl.signal);
	let response: Response | undefined;
	try {
		response = await fetchImpl(`${CONSOLE_ORIGIN}${API_PATH}${path}`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
			signal: ptree.combineSignals(ctrl.signal, REQUEST_TIMEOUT_MS),
		});
		return { response, payload: await response.json() };
	} catch (error) {
		throwIfCancelled(ctrl.signal);
		if (!response) throw error;
		return { response, payload: undefined };
	}
}

/** Accept only console URLs at or below `basePath` (segment-aware: `/api` rejects `/api-x`). */
function consoleUrl(value: string, basePath: string, message: string): string {
	const url = URL.parse(value);
	if (url?.origin === CONSOLE_ORIGIN && (url.pathname === basePath || url.pathname.startsWith(`${basePath}/`))) {
		return url.href;
	}
	throw oauthError(`${message}: unexpected URL ${value}`, "validation");
}

async function startSignIn(codeChallenge: string, ctrl: OAuthController, fetchImpl: FetchImpl): Promise<SignIn> {
	const message = "Failed to start Mistral browser sign-in";
	const { response, payload } = await post(
		"/vibe/sign-in",
		{ code_challenge: codeChallenge, code_challenge_method: "S256" },
		ctrl,
		fetchImpl,
	);
	if (!response.ok) throw oauthError(`${message}: HTTP ${response.status}`, "http", response.status);
	const started = startSchema(payload);
	if (started instanceof type.errors) throw oauthError(`${message}: ${started.summary}`, "validation");
	const expiresAtMs = Date.parse(started.expires_at);
	if (Number.isNaN(expiresAtMs)) throw oauthError(`${message}: invalid expires_at`, "validation");
	return {
		processId: started.process_id,
		signInUrl: consoleUrl(started.sign_in_url, "", message),
		pollUrl: consoleUrl(started.poll_url, API_PATH, message),
		expiresAtMs,
	};
}

/**
 * Classifies each poll for {@link pollOAuthDeviceCodeFlow}. Terminal states throw; 429 is a
 * `slow_down` carrying the console's `Retry-After`. Network errors, non-2xx and unreadable answers
 * count as `pending` until {@link MAX_CONSECUTIVE_POLL_FAILURES} occur in a row.
 */
function signInPoller(
	pollUrl: string,
	fetchImpl: FetchImpl,
): (signal?: AbortSignal) => Promise<OAuthDeviceCodePollResult<string>> {
	let failures = 0;
	return async signal => {
		let response: Response | undefined;
		let payload: unknown;
		let cause: unknown;
		try {
			response = await fetchImpl(pollUrl, { signal: ptree.combineSignals(signal, REQUEST_TIMEOUT_MS) });
			payload = await response.json();
		} catch (error) {
			if (signal?.aborted) throw error;
			cause = error;
		}
		if (response?.status === 410) throw oauthError(EXPIRED_MESSAGE, "timeout", 410);
		if (response?.status === 429) {
			failures = 0;
			const retryAfterMs = getRetryAfterMsFromHeaders(response.headers);
			return { status: "slow_down", retryAfterMs: retryAfterMs && Math.min(retryAfterMs, MAX_RETRY_AFTER_MS) };
		}
		const answer = response?.ok ? pollSchema(payload) : undefined;
		if (answer === undefined || answer instanceof type.errors) {
			if (++failures < MAX_CONSECUTIVE_POLL_FAILURES) return { status: "pending" };
			const reason = !response ? "request failed" : response.ok ? "malformed response" : `HTTP ${response.status}`;
			throw new AIError.OAuthError(`Mistral sign-in status unavailable: ${reason}`, {
				kind: "polling",
				provider: PROVIDER,
				status: response?.status,
				cause,
			});
		}
		failures = 0;

		switch (answer.status) {
			case "pending":
				return { status: "pending" };
			case "completed":
				if (answer.exchange_token) return { status: "complete", value: answer.exchange_token };
				throw oauthError("Mistral sign-in completed without an exchange token", "validation");
			case "expired":
				throw oauthError(EXPIRED_MESSAGE, "timeout");
			case "denied":
				throw oauthError("Mistral sign-in was denied", "device-auth");
			case "error":
				throw oauthError(answer.message || "Mistral sign-in failed", "polling");
			default:
				throw oauthError(`Mistral sign-in returned unknown state "${answer.status}"`, "validation");
		}
	};
}

async function exchangeForApiKey(
	processId: string,
	exchangeToken: string,
	codeVerifier: string,
	ctrl: OAuthController,
	fetchImpl: FetchImpl,
): Promise<string> {
	const message = "Failed to exchange Mistral sign-in for an API key";
	const { response, payload } = await post(
		`/vibe/sign-in/${encodeURIComponent(processId)}/exchange`,
		{ exchange_token: exchangeToken, code_verifier: codeVerifier },
		ctrl,
		fetchImpl,
	);
	if (response.status === 403 && isRecord(payload) && payload.error_code === WORKSPACE_DENIED_ERROR_CODE) {
		throw oauthError(
			"Your Mistral workspace can't be used for Mistral Vibe; run /login again and pick another workspace in the browser, or ask your administrator",
			"entitlement",
			403,
		);
	}
	if (!response.ok) throw oauthError(`${message}: HTTP ${response.status}`, "http", response.status);
	const exchanged = exchangeSchema(payload);
	if (exchanged instanceof type.errors) throw oauthError(`${message}: ${exchanged.summary}`, "validation");
	return exchanged.api_key;
}

/**
 * `login "custom" hook="mistral-vibe-sign-in"`. Returns the minted key as a string so `/login`
 * stores it as a plain API-key credential.
 */
export async function loginMistralVibeSignIn(ctrl: OAuthController): Promise<string> {
	const fetchImpl = ctrl.fetch ?? fetch;
	const { verifier, challenge } = await generatePKCE();
	const signIn = await startSignIn(challenge, ctrl, fetchImpl);
	ctrl.onAuth?.({
		url: signIn.signInUrl,
		instructions: "Sign in with your Mistral account and approve Mistral Vibe access, then return here.",
	});
	ctrl.onProgress?.("Waiting for Mistral sign-in to complete...");
	const exchangeToken = await pollOAuthDeviceCodeFlow({
		intervalSeconds: POLL_INTERVAL_SECONDS,
		expiresInSeconds: Math.max(0, signIn.expiresAtMs - Date.now()) / 1000,
		signal: ctrl.signal,
		poll: signInPoller(signIn.pollUrl, fetchImpl),
	});
	ctrl.onProgress?.("Exchanging sign-in for a Mistral API key...");
	return exchangeForApiKey(signIn.processId, exchangeToken, verifier, ctrl, fetchImpl);
}
