/**
 * Mistral Vibe browser sign-in: the same flow the Vibe Code CLI uses
 * (mistralai/mistral-vibe, vibe/core/config/_defaults.py). Mistral's console
 * provisions and stores a regular API key; the browser session does the
 * authorizing, so no password ever transits this code.
 *
 * Flow, verified 2026-09-30 against a Pro plan:
 *  1. POST https://console.mistral.ai/api/vibe/sign-in
 *     { code_challenge, code_challenge_method: "S256" }  (no auth header)
 *     -> { process_id, sign_in_url, poll_url, expires_at }
 *  2. The user approves in the browser at sign_in_url.
 *  3. Poll GET poll_url -> { status: "pending" | "completed" | ... ,
 *     exchange_token? } (HTTP 410 once the process expires).
 *  4. POST .../vibe/sign-in/{process_id}/exchange
 *     { exchange_token, code_verifier } -> { api_key }
 *
 * The minted key authenticates https://api.mistral.ai/v1 over the plain
 * `openai-completions` transport; its usage is billed against the Vibe Code
 * quota of the signed-in plan, not against pay-as-you-go API credits
 * (observed 2026-09-30: sustained traffic moved the plan's Vibe Code
 * counter, not the API credits counter).
 */
import { isRecord, sleepLong } from "@oh-my-pi/pi-utils";
import * as AIError from "../../error";
import type { FetchImpl } from "../../types";
import { generatePKCE } from "./pkce";
import type { OAuthController } from "./types";

const AUTH_BASE_URL = "https://console.mistral.ai";
const AUTH_API_BASE_URL = `${AUTH_BASE_URL}/api`;
const SIGN_IN_PATH = "/vibe/sign-in";
const POLL_INTERVAL_MS = 3000;

type SignInProcess = {
	processId: string;
	signInUrl: string;
	pollUrl: string;
	expiresAtMs: number;
};

type PollPayload = {
	status: "pending" | "completed" | "expired" | "denied" | "error";
	exchangeToken?: string;
	message?: string;
};

/** Narrow a decoded JSON body at the network boundary, once per response. */
function asRecord(value: unknown, message: string): Record<string, unknown> {
	if (isRecord(value)) return value;
	throw new AIError.OAuthError(`${message}: malformed JSON response`, { kind: "validation", provider: "mistral" });
}

function requiredString(record: Record<string, unknown>, field: string, message: string): string {
	const value = record[field];
	if (typeof value === "string" && value.length > 0) return value;
	throw new AIError.OAuthError(`${message}: response is missing "${field}"`, {
		kind: "validation",
		provider: "mistral",
	});
}

/** Reject any URL the sign-in server returns outside its own origin. */
function assertUrlUnder(value: string, baseUrl: string, message: string): string {
	const url = new URL(value);
	const base = new URL(baseUrl);
	if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname.replace(/\/$/, ""))) {
		throw new AIError.OAuthError(`${message}: unexpected URL ${value}`, { kind: "validation", provider: "mistral" });
	}
	return value;
}

async function readJson(response: Response, message: string): Promise<unknown> {
	if (!response.ok)
		throw new AIError.OAuthError(`${message}: HTTP ${response.status}`, { kind: "validation", provider: "mistral" });
	try {
		return await response.json();
	} catch (cause) {
		throw new AIError.OAuthError(`${message}: malformed JSON response`, {
			kind: "validation",
			provider: "mistral",
			cause,
		});
	}
}

function throwIfCancelled(signal: AbortSignal | undefined): void {
	if (signal?.aborted) throw new AIError.LoginCancelledError("Login cancelled");
}

/** `fetch` bound to the login's abort signal; an abort surfaces as a cancelled login. */
async function request(url: string, init: RequestInit, ctrl: OAuthController, fetchImpl: FetchImpl): Promise<Response> {
	throwIfCancelled(ctrl.signal);
	try {
		return await fetchImpl(url, { ...init, signal: ctrl.signal });
	} catch (error) {
		throwIfCancelled(ctrl.signal);
		throw error;
	}
}

async function postJson(
	url: string,
	body: Record<string, string>,
	ctrl: OAuthController,
	fetchImpl: FetchImpl,
	message: string,
): Promise<unknown> {
	const response = await request(
		url,
		{ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
		ctrl,
		fetchImpl,
	);
	return readJson(response, message);
}

async function abortableSleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
	try {
		await sleepLong(ms, signal);
	} catch (error) {
		throwIfCancelled(signal);
		throw error;
	}
}

async function startSignIn(codeChallenge: string, ctrl: OAuthController, fetchImpl: FetchImpl): Promise<SignInProcess> {
	const message = "Failed to start Mistral browser sign-in";
	const payload = asRecord(
		await postJson(
			`${AUTH_API_BASE_URL}${SIGN_IN_PATH}`,
			{ code_challenge: codeChallenge, code_challenge_method: "S256" },
			ctrl,
			fetchImpl,
			message,
		),
		message,
	);
	const expiresAtMs = Date.parse(requiredString(payload, "expires_at", message));
	if (!Number.isFinite(expiresAtMs)) {
		throw new AIError.OAuthError(`${message}: invalid expires_at`, { kind: "validation", provider: "mistral" });
	}
	return {
		processId: requiredString(payload, "process_id", message),
		signInUrl: assertUrlUnder(requiredString(payload, "sign_in_url", message), AUTH_BASE_URL, message),
		pollUrl: assertUrlUnder(requiredString(payload, "poll_url", message), AUTH_API_BASE_URL, message),
		expiresAtMs,
	};
}

async function pollSignIn(process: SignInProcess, ctrl: OAuthController, fetchImpl: FetchImpl): Promise<PollPayload> {
	const message = "Mistral sign-in status unavailable";
	const response = await request(process.pollUrl, {}, ctrl, fetchImpl);
	// The process is gone: 410 instead of a status payload.
	if (response.status === 410) return { status: "expired" };
	const payload = asRecord(await readJson(response, message), message);
	const status = payload.status;
	if (
		status !== "pending" &&
		status !== "completed" &&
		status !== "expired" &&
		status !== "denied" &&
		status !== "error"
	) {
		throw new AIError.OAuthError("Mistral sign-in returned an unknown state", {
			kind: "validation",
			provider: "mistral",
		});
	}
	const exchangeToken = payload.exchange_token;
	const detail = payload.message;
	return {
		status,
		exchangeToken: typeof exchangeToken === "string" && exchangeToken.length > 0 ? exchangeToken : undefined,
		message: typeof detail === "string" && detail.length > 0 ? detail : undefined,
	};
}

async function waitForCompletion(process: SignInProcess, ctrl: OAuthController, fetchImpl: FetchImpl): Promise<string> {
	while (Date.now() < process.expiresAtMs) {
		const result = await pollSignIn(process, ctrl, fetchImpl);
		switch (result.status) {
			case "pending":
				await abortableSleep(
					Math.min(POLL_INTERVAL_MS, Math.max(0, process.expiresAtMs - Date.now())),
					ctrl.signal,
				);
				break;
			case "completed":
				if (result.exchangeToken) return result.exchangeToken;
				throw new AIError.OAuthError("Mistral sign-in completed without an exchange token", {
					kind: "validation",
					provider: "mistral",
				});
			case "expired":
				throw new AIError.OAuthError("Mistral sign-in expired; run /login again", {
					kind: "polling",
					provider: "mistral",
				});
			case "denied":
				throw new AIError.OAuthError("Mistral sign-in was denied", { kind: "polling", provider: "mistral" });
			case "error":
				throw new AIError.OAuthError(result.message ?? "Mistral sign-in failed", {
					kind: "polling",
					provider: "mistral",
				});
		}
	}
	throw new AIError.OAuthError("Mistral sign-in timed out", { kind: "polling", provider: "mistral" });
}

async function exchangeForApiKey(
	process: SignInProcess,
	exchangeToken: string,
	codeVerifier: string,
	ctrl: OAuthController,
	fetchImpl: FetchImpl,
): Promise<string> {
	const message = "Failed to exchange Mistral sign-in for an API key";
	const payload = asRecord(
		await postJson(
			`${AUTH_API_BASE_URL}${SIGN_IN_PATH}/${encodeURIComponent(process.processId)}/exchange`,
			{ exchange_token: exchangeToken, code_verifier: codeVerifier },
			ctrl,
			fetchImpl,
			message,
		),
		message,
	);
	return requiredString(payload, "api_key", message);
}

/**
 * `login "custom" hook="mistral-vibe-sign-in"`: whole-flow login for the Mistral provider.
 * Returns the minted key as a string so `/login` stores it as a plain API-key credential.
 */
export async function loginMistralVibeSignIn(ctrl: OAuthController): Promise<string> {
	throwIfCancelled(ctrl.signal);
	const fetchImpl = ctrl.fetch ?? fetch;
	const { verifier, challenge } = await generatePKCE();
	const process = await startSignIn(challenge, ctrl, fetchImpl);
	throwIfCancelled(ctrl.signal);
	ctrl.onAuth?.({
		url: process.signInUrl,
		instructions: "Sign in with your Mistral account (Pro plan or higher), then return here.",
	});
	ctrl.onProgress?.("Waiting for Mistral sign-in to complete...");
	const exchangeToken = await waitForCompletion(process, ctrl, fetchImpl);
	ctrl.onProgress?.("Exchanging sign-in for a Mistral API key...");
	return exchangeForApiKey(process, exchangeToken, verifier, ctrl, fetchImpl);
}
