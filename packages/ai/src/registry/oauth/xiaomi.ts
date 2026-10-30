/**
 * Xiaomi MiMo login flow.
 *
 * Xiaomi MiMo provides OpenAI-compatible models via
 * https://api.xiaomimimo.com/v1.
 *
 * Standard Xiaomi login accepts both pay-as-you-go keys and regional Token Plan
 * (`tp-...`/`ttp-...`) keys, probing the regional Token Plan clusters in fallback order.
 */

import { t as __ompTranslate } from "@oh-my-pi/pi-utils/i18n";
import { authPolicyFor } from "@oh-my-pi/pi-catalog/compat/auth";
import { providerEntry } from "@oh-my-pi/pi-catalog/compat/providers";
import { isXiaomiTokenPlanKey } from "@oh-my-pi/pi-catalog/wire/xiaomi-token-plan";
import * as AIError from "../../error";
import type { FetchImpl } from "../../types";
import type { OAuthController } from "./types";

const PROVIDER_ID = "xiaomi";
const PROVIDER_NAME = "Xiaomi MiMo";
const STANDARD_AUTH_URL = "https://platform.xiaomimimo.com/#/console/api-keys";
const STANDARD_API_BASE_URL = "https://api.xiaomimimo.com/v1";
const VALIDATION_TIMEOUT_MS = 15_000;

async function validateXiaomiApiKey(apiKey: string, signal?: AbortSignal, fetchOverride?: FetchImpl): Promise<void> {
	const fetchImpl = fetchOverride ?? fetch;
	// Generic Xiaomi login keeps the historical SGP → AMS → CN fallback.
	const endpoints = isXiaomiTokenPlanKey(apiKey)
		? ["xiaomi-token-plan-sgp", "xiaomi-token-plan-ams", "xiaomi-token-plan-cn"].map(provider => {
				const login = authPolicyFor(provider)?.login;
				if (login?.kind !== "api-key" || login.validate?.kind !== "chat-completions") {
					throw new AIError.ConfigurationError(
						__ompTranslate("Missing chat-completions validation policy for {0}", `${provider}`),
					);
				}
				return login.validate;
			})
		: [{ baseUrl: STANDARD_API_BASE_URL, model: providerEntry(PROVIDER_ID)!.defaultModel }];

	let lastError: Error | null = null;

	for (const ep of endpoints) {
		// Fresh timeout per endpoint so SGP→AMS fallback works after a regional
		// timeout: a shared AbortSignal.timeout would stay aborted and instantly
		// abort the AMS fetch.
		const timeoutSignal = AbortSignal.timeout(VALIDATION_TIMEOUT_MS);
		const requestSignal = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
		let response: Response;
		try {
			response = await fetchImpl(`${ep.baseUrl}/chat/completions`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${apiKey}`,
				},
				body: JSON.stringify({
					model: ep.model,
					max_tokens: 1,
					messages: [{ role: "user", content: "ping" }],
				}),
				signal: requestSignal,
			});
		} catch (e) {
			// Only re-throw AbortError when the caller explicitly cancelled.
			// Timeout aborts (from AbortSignal.timeout) should fall through to
			// the next endpoint so SGP→AMS fallback works during regional outages.
			if (e instanceof DOMException && e.name === "AbortError" && signal?.aborted) {
				throw e;
			}
			lastError = e instanceof Error ? e : new Error(String(e));
			continue;
		}

		if (response.ok) {
			return;
		}

		let details = "";
		try {
			details = (await response.text()).trim();
		} catch {
			// ignore body read errors, status is enough
		}
		const error = new AIError.OAuthError(
			details
				? __ompTranslate(
						"{0} API key validation failed ({1}): {2}",
						`${PROVIDER_NAME}`,
						`${response.status}`,
						`${details}`,
					)
				: __ompTranslate("{0} API key validation failed ({1})", `${PROVIDER_NAME}`, `${response.status}`),
			{ kind: "validation", provider: PROVIDER_ID, status: response.status },
		);
		// 401 means this endpoint didn't accept the key; try the next one. Any other
		// status means the endpoint accepted the key but the probe failed, so surface
		// it instead of letting later regions replace it with their 401.
		if (response.status !== 401) {
			throw error;
		}
		lastError = error;
	}
	throw (
		lastError ??
		new AIError.OAuthError(__ompTranslate("{0} API key validation failed", `${PROVIDER_NAME}`), {
			kind: "validation",
			provider: PROVIDER_ID,
		})
	);
}

/**
 * Login to Xiaomi MiMo.
 *
 * Opens browser to API keys page, prompts user to paste their API key.
 * Returns the API key directly (not OAuthCredentials - this isn't OAuth).
 */
export async function loginXiaomi(options: OAuthController): Promise<string> {
	const fetchImpl = options.fetch ?? fetch;
	if (!options.onPrompt) {
		throw new AIError.OnPromptRequiredError(PROVIDER_NAME);
	}
	options.onAuth?.({
		url: STANDARD_AUTH_URL,
		instructions: __ompTranslate("Copy your API key from the Xiaomi MiMo console"),
	});
	const apiKey = await options.onPrompt({
		message: __ompTranslate("Paste your Xiaomi API key (sk-... or Token Plan tp-... / ttp-...)"),
		placeholder: __ompTranslate("sk-..., tp-..., or ttp-..."),
	});
	if (options.signal?.aborted) {
		throw new AIError.LoginCancelledError();
	}
	const trimmed = apiKey.trim();
	if (!trimmed) {
		throw new AIError.ApiKeyRequiredError();
	}

	options.onProgress?.(__ompTranslate("Validating {0} API key...", `${PROVIDER_ID}`));
	await validateXiaomiApiKey(trimmed, options.signal, fetchImpl);
	return trimmed;
}
