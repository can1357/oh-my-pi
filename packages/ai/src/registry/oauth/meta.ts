/**
 * Meta Muse OAuth key mint.
 *
 * Mirrors the official Muse Code launcher: an RFC 8628 device flow against
 * `auth.meta.com` yields a short-lived account token, which this
 * after-exchange hook swaps for a durable Model API key via the
 * `api.meta.ai/muse-code/key` endpoint. The minted key is placed in
 * {@link OAuthCredentials.access}; `getOAuthApiKey` returns it verbatim as
 * the request Bearer for the `meta` provider, so no dialect change is needed.
 */

import * as AIError from "../../error";
import type { FetchImpl } from "../../types";
import type { AfterExchangeHook } from "../hooks/types";

/** Public client used by the official Muse Code launcher. */
const META_MUSE_CLIENT = "https://api.meta.ai";
const META_MUSE_KEY_URL = `${META_MUSE_CLIENT}/muse-code/key`;
const META_MUSE_API_VERSION = "1.0.0";
const META_MUSE_TIMEOUT_MS = 30_000;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function trimmedString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * Exchange a short-lived Meta account token for a durable Model API key.
 * The mint endpoint takes no body; the account token travels as the Bearer.
 */
async function mintMetaApiKey(oauthAccessToken: string, fetchImpl: FetchImpl, signal?: AbortSignal): Promise<string> {
	const token = oauthAccessToken.trim();
	if (!token) {
		throw new AIError.OAuthError("Meta OAuth exchange returned no access token", {
			kind: "token-exchange",
			provider: "meta-oauth",
		});
	}
	let response: Response;
	try {
		response = await fetchImpl(META_MUSE_KEY_URL, {
			method: "POST",
			headers: {
				Accept: "application/json",
				Authorization: `Bearer ${token}`,
				"x-api-version": META_MUSE_API_VERSION,
			},
			redirect: "error",
			signal: signal
				? AbortSignal.any([signal, AbortSignal.timeout(META_MUSE_TIMEOUT_MS)])
				: AbortSignal.timeout(META_MUSE_TIMEOUT_MS),
		});
	} catch (error) {
		throw new AIError.OAuthError(`Meta key mint failed: ${error instanceof Error ? error.message : String(error)}`, {
			kind: "token-exchange",
			provider: "meta-oauth",
			cause: error,
		});
	}
	let payload: unknown;
	try {
		payload = await response.json();
	} catch (error) {
		throw new AIError.OAuthError("Meta key mint returned invalid JSON", {
			kind: "token-exchange",
			provider: "meta-oauth",
			status: response.status,
			cause: error,
		});
	}
	if (!response.ok) {
		const detail = isRecord(payload) ? trimmedString(payload.detail ?? payload.title ?? payload.error) : undefined;
		throw new AIError.OAuthError(`Meta key mint failed (${response.status})${detail ? `: ${detail}` : ""}`, {
			kind: "token-exchange",
			provider: "meta-oauth",
			status: response.status,
		});
	}
	const apiKey = isRecord(payload) ? trimmedString(payload.api_key) : undefined;
	if (!apiKey) {
		throw new AIError.OAuthError("Meta key mint returned no API key", {
			kind: "token-exchange",
			provider: "meta-oauth",
			status: response.status,
		});
	}
	return apiKey;
}

/** Replaces the short-lived OAuth token with the durable key minted by the Muse API. */
export const metaMintKeyHook: AfterExchangeHook = async (credentials, context) => ({
	...credentials,
	access: await mintMetaApiKey(credentials.access, context.fetch, context.signal),
});
