import { type } from "@oh-my-pi/omptype";
import * as AIError from "../../error";
import type { AfterExchangeHook, ExchangeContext } from "../hooks/types";
import type { FetchImpl } from "../../types";
import type { OAuthCredentials } from "./types";

const PROVIDER = "muse-code";
const MUSE_KEY_URL = "https://api.meta.ai/muse-code/key";
const API_VERSION = "1.0.0";
const REQUEST_TIMEOUT_MS = 20_000;

const subscriptionWindowSchema = type({
	"used_percent?": "number",
	"resets_at?": "string | number",
	"window_duration_mins?": "number",
});

const subscriptionUsageSchema = type({
	"window?": subscriptionWindowSchema.or("null"),
	"weekly?": subscriptionWindowSchema.or("null"),
});

const museCodeKeyResponseSchema = type({
	"api_key?": "string",
	"require_payment_action_url?": "string",
	"require_payment?": "boolean",
	"action_url?": "string | null",
	"user_email?": "string",
	"user_id?": "string",
	"is_subs_active?": "boolean",
	"subs_tier_id?": "string",
	"subs_tier_name?": "string",
	"subs_usage?": subscriptionUsageSchema.or("null"),
});
export type MuseCodeKeyResponse = typeof museCodeKeyResponseSchema.infer;

const museCodeCredentialSchema = type({
	oauthAccessToken: "string",
	apiKey: "string",
});
export type MuseCodeCredential = typeof museCodeCredentialSchema.infer;
export interface MuseCodeKeyRequestOptions {
	fetch?: FetchImpl;
	signal?: AbortSignal;
	/** Ask Meta to onboard the account during an interactive login exchange. */
	onboard?: boolean;
}

function requestSignal(signal?: AbortSignal): AbortSignal {
	const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

export function parseMuseCodeCredential(value: string): MuseCodeCredential {
	let payload: unknown;
	try {
		payload = JSON.parse(value);
	} catch (cause) {
		throw new AIError.ConfigurationError("Muse Code credential is invalid; sign in again", { cause });
	}
	const parsed = museCodeCredentialSchema(payload);
	if (parsed instanceof type.errors || !parsed.oauthAccessToken.trim() || !parsed.apiKey.trim()) {
		throw new AIError.ConfigurationError("Muse Code credential is invalid; sign in again");
	}
	return parsed;
}

function encodeMuseCodeCredential(oauthAccessToken: string, apiKey: string): string {
	return JSON.stringify({ oauthAccessToken, apiKey });
}

export async function requestMuseCodeKey(
	accessToken: string,
	options: MuseCodeKeyRequestOptions = {},
): Promise<MuseCodeKeyResponse> {
	const response = await (options.fetch ?? fetch)(MUSE_KEY_URL, {
		method: "POST",
		headers: {
			Accept: "application/json",
			Authorization: `Bearer ${accessToken}`,
			"Content-Type": "application/json",
			"x-api-version": API_VERSION,
		},
		body: JSON.stringify(options.onboard ? { onboard: true } : {}),
		redirect: "error",
		signal: requestSignal(options.signal),
	});
	const text = await response.text();
	if (!response.ok) {
		const excerpt = text.trim() ? ` ${text.slice(0, 500).trim()}` : "";
		throw new AIError.OAuthError(`Muse Code key exchange failed: ${response.status}${excerpt}`, {
			kind: "token-exchange",
			provider: PROVIDER,
			status: response.status,
		});
	}
	let payload: unknown;
	try {
		payload = JSON.parse(text);
	} catch (cause) {
		throw new AIError.OAuthError("Muse Code key exchange returned invalid JSON", {
			kind: "validation",
			provider: PROVIDER,
			status: response.status,
			cause,
		});
	}
	const parsed = museCodeKeyResponseSchema(payload);
	if (parsed instanceof type.errors) {
		throw new AIError.OAuthError(`Invalid Muse Code key response: ${parsed.summary}`, {
			kind: "validation",
			provider: PROVIDER,
		});
	}
	return parsed;
}

/** Exchange Meta account access for the Model API key authorized by a Muse subscription. */
export const attachMuseCodeApiKey: AfterExchangeHook = async (
	credentials: OAuthCredentials,
	context: ExchangeContext,
): Promise<OAuthCredentials> => {
	// Reuse an already-minted subscription key instead of re-minting on every
	// token refresh. The key endpoint is aggressively rate-limited (429s), and
	// Meta returns the same api_key for the account, so a refresh that already
	// carries one must not burn another key call. Only a login/refresh without
	// one (first login, or a previously failed mint) re-mints here.
	try {
		const existing = parseMuseCodeCredential(credentials.access);
		if (existing.apiKey.trim()) return credentials;
	} catch {
		// No usable minted key yet — fall through to mint one.
	}
	const payload = await requestMuseCodeKey(credentials.access, {
		fetch: context.fetch,
		signal: context.signal,
		onboard: true,
	});
	if (payload.is_subs_active === false) {
		throw new AIError.OAuthError("invalid_grant: Muse Code subscription is inactive", {
			kind: "token-exchange",
			provider: PROVIDER,
			status: 403,
		});
	}
	const apiKey = payload.api_key?.trim() || "";
	if (!apiKey) {
		const actionUrl = payload.action_url?.trim() || payload.require_payment_action_url?.trim();
		if (payload.require_payment === true || actionUrl) {
			throw new AIError.OAuthError(
				actionUrl ? `Muse Code subscription is required: ${actionUrl}` : "Muse Code subscription is required",
				{ kind: "entitlement", provider: PROVIDER },
			);
		}
		throw new AIError.OAuthError("Muse Code key response is missing api_key", {
			kind: "validation",
			provider: PROVIDER,
		});
	}
	const email = payload.user_email?.trim().toLowerCase();
	const accountId = payload.user_id?.trim() || email;
	if (!accountId) {
		throw new AIError.OAuthError("Muse Code key response is missing a stable account identity", {
			kind: "validation",
			provider: PROVIDER,
		});
	}
	return {
		...credentials,
		access: encodeMuseCodeCredential(credentials.access, apiKey),
		accountId,
		email,
	};
};
