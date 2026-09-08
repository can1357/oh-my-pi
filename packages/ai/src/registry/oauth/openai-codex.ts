/**
 * OpenAI Codex (ChatGPT OAuth) flow — browser and device-code flows.
 */

import { OPENAI_HEADER_VALUES } from "@oh-my-pi/pi-catalog/wire/codex";
import * as AIError from "../../error";
import type { FetchImpl } from "../../types";
import { isRecord } from "../../utils";
import type { AfterExchangeHook } from "../hooks/types";
import type { OAuthController, OAuthCredentials } from "./types";

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const AUTHORIZE_URL = "https://auth.openai.com/oauth/authorize";
const TOKEN_URL = "https://auth.openai.com/oauth/token";
const SCOPE = "openid profile email offline_access api.connectors.read api.connectors.invoke";
const JWT_CLAIM_PATH = "https://api.openai.com/auth";
const JWT_PROFILE_CLAIM = "https://api.openai.com/profile";
const TOKEN_REQUEST_TIMEOUT_MS = 15_000;
const DEVICE_USERCODE_URL = "https://auth.openai.com/api/accounts/deviceauth/usercode";
const DEVICE_TOKEN_URL = "https://auth.openai.com/api/accounts/deviceauth/token";
const DEVICE_REDIRECT_URI = "https://auth.openai.com/deviceauth/callback";
const DEVICE_AUTH_URL = "https://auth.openai.com/codex/device";
const DEVICE_POLL_INTERVAL_MS = 5_000;
const DEVICE_POLL_SAFETY_MARGIN_MS = 3_000;
/** Upper bound on device-code polling to avoid infinite loops on server errors. */
const DEVICE_MAX_POLLS = 120;

type JwtPayload = {
	[JWT_CLAIM_PATH]?: {
		chatgpt_account_id?: string;
		chatgpt_plan_type?: string;
	};
	[JWT_PROFILE_CLAIM]?: {
		email?: string;
	};
	[key: string]: unknown;
};

export function decodeJwt<T = Record<string, unknown>>(token: string): T | null {
	try {
		const parts = token.split(".");
		if (parts.length !== 3) return null;
		const payload = parts[1] ?? "";
		const decoded = Buffer.from(payload, "base64").toString("utf-8");
		return JSON.parse(decoded) as T;
	} catch {
		return null;
	}
}

/**
 * Identity slice decoded from the token claims. The ChatGPT workspace
 * (`chatgpt_account_id`) is the subscription pool the token draws limits
 * from — one account email can hold several (e.g. a personal Pro plan plus a
 * Team seat). `chatgpt_plan_type` may only be present on the `id_token`.
 */
function getTokenProfile(
	accessToken: string,
	idToken?: string,
): { accountId?: string; email?: string; planType?: string } {
	const payload = decodeJwt<JwtPayload>(accessToken);
	const idPayload = idToken ? decodeJwt<JwtPayload>(idToken) : null;
	const auth = payload?.[JWT_CLAIM_PATH];
	const idAuth = idPayload?.[JWT_CLAIM_PATH];
	const accountId = auth?.chatgpt_account_id ?? idAuth?.chatgpt_account_id;
	const email = (payload?.[JWT_PROFILE_CLAIM]?.email ?? idPayload?.[JWT_PROFILE_CLAIM]?.email)?.trim().toLowerCase();
	const planType = (auth?.chatgpt_plan_type ?? idAuth?.chatgpt_plan_type)?.trim().toLowerCase();
	return {
		accountId: typeof accountId === "string" && accountId.length > 0 ? accountId : undefined,
		email: typeof email === "string" && email.length > 0 ? email : undefined,
		planType: typeof planType === "string" && planType.length > 0 ? planType : undefined,
	};
}

function describeTokenEndpointValue(value: unknown): string | undefined {
	if (typeof value === "string") {
		const trimmed = value.trim();
		return trimmed.length > 0 ? trimmed : undefined;
	}
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	if (!isRecord(value)) return undefined;

	const code = describeTokenEndpointValue(value.code ?? value.error);
	const message = describeTokenEndpointValue(value.message ?? value.error_description ?? value.description);
	if (code && message && code !== message) return `${code}: ${message}`;
	return code ?? message ?? JSON.stringify(value);
}

/** Enriches declaratively exchanged Codex credentials from access/id-token JWT claims. */
export const openAICodexProfileHook: AfterExchangeHook = async (credentials, context) => {
	const idToken = isRecord(context.raw) && typeof context.raw.id_token === "string" ? context.raw.id_token : undefined;
	const { accountId, email, planType } = getTokenProfile(credentials.access, idToken);
	if (context.phase === "login" && !accountId) {
		throw new AIError.OAuthError("Failed to extract accountId from token", {
			kind: "validation",
			provider: context.provider,
		});
	}
	const resolvedAccountId = accountId ?? context.stored?.accountId;
	return {
		...credentials,
		...(resolvedAccountId ? { accountId: resolvedAccountId } : {}),
		...(email ? { email } : context.stored?.email ? { email: context.stored.email } : {}),
		...(context.phase === "login" && resolvedAccountId ? { orgId: resolvedAccountId } : {}),
		...(context.phase === "login" && planType ? { orgName: planType } : {}),
		...(context.phase === "refresh" && context.stored?.orgId ? { orgId: context.stored.orgId } : {}),
		...(context.phase === "refresh" && context.stored?.orgName ? { orgName: context.stored.orgName } : {}),
	};
};

/**
 * Formats OpenAI Codex OAuth token endpoint errors for login and refresh failures.
 */
export function formatOpenAICodexTokenEndpointError(status: number, bodyText: string): string {
	const trimmed = bodyText.trim();
	if (trimmed.length === 0) return `${status}`;

	try {
		const body: unknown = JSON.parse(trimmed);
		if (!isRecord(body)) return `${status} ${trimmed}`;

		const error = describeTokenEndpointValue(body.error);
		const description = describeTokenEndpointValue(body.error_description);
		if (error && description && error !== description) return `${status} ${error}: ${description}`;
		return `${status} ${error ?? description ?? describeTokenEndpointValue(body.message) ?? trimmed}`;
	} catch {
		return `${status} ${trimmed}`;
	}
}
/** Builds the Codex browser OAuth URL used by browser login; exported for auth regression tests. */
export function createOpenAICodexAuthorizationUrl(args: {
	state: string;
	redirectUri: string;
	challenge: string;
	originator?: string;
}): string {
	const originator = args.originator?.trim() || OPENAI_HEADER_VALUES.ORIGINATOR_CODEX;
	const searchParams = new URLSearchParams({
		response_type: "code",
		client_id: CLIENT_ID,
		redirect_uri: args.redirectUri,
		scope: SCOPE,
		code_challenge: args.challenge,
		code_challenge_method: "S256",
		state: args.state,
		id_token_add_organizations: "true",
		codex_cli_simplified_flow: "true",
		originator,
	});

	return `${AUTHORIZE_URL}?${searchParams.toString()}`;
}

async function exchangeCodeForToken(
	code: string,
	verifier: string,
	redirectUri: string,
	fetchImpl: FetchImpl = fetch,
): Promise<OAuthCredentials> {
	const tokenResponse = await fetchImpl(TOKEN_URL, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "authorization_code",
			client_id: CLIENT_ID,
			code,
			code_verifier: verifier,
			redirect_uri: redirectUri,
		}),
		signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
	});

	if (!tokenResponse.ok) {
		const bodyText = await tokenResponse.text();
		throw new AIError.OAuthError(
			`Token exchange failed: ${formatOpenAICodexTokenEndpointError(tokenResponse.status, bodyText)}`,
			{ kind: "token-exchange", status: tokenResponse.status },
		);
	}

	const tokenData = (await tokenResponse.json()) as {
		access_token?: string;
		refresh_token?: string;
		id_token?: string;
		expires_in?: number;
	};

	if (!tokenData.access_token || !tokenData.refresh_token || typeof tokenData.expires_in !== "number") {
		throw new AIError.OAuthError("Token response missing required fields", { kind: "validation" });
	}

	const { accountId, email, planType } = getTokenProfile(tokenData.access_token, tokenData.id_token);
	if (!accountId) {
		throw new AIError.OAuthError("Failed to extract accountId from token", { kind: "validation" });
	}

	return {
		access: tokenData.access_token,
		refresh: tokenData.refresh_token,
		expires: Date.now() + tokenData.expires_in * 1000,
		accountId,
		email,
		orgId: accountId,
		orgName: planType,
	};
}

/**
 * Login with OpenAI Codex using the device-code (headless) flow.
 *
 * Avoids a local callback server entirely — useful when port 1455 is unavailable
 * or when the browser callback flow fails with 403 (e.g. network/proxy issues).
 */
export async function loginOpenAICodexDevice(ctrl: OAuthController): Promise<OAuthCredentials> {
	ctrl.onProgress?.("Initiating device authorization…");

	const initResponse = await fetch(DEVICE_USERCODE_URL, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({ client_id: CLIENT_ID }),
		signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
	});

	if (!initResponse.ok) {
		throw new AIError.OAuthError(`Device authorization initiation failed: ${initResponse.status}`, {
			kind: "device-auth",
			status: initResponse.status,
		});
	}

	const initData = (await initResponse.json()) as {
		device_auth_id?: string;
		user_code?: string;
		interval?: string | number;
	};

	if (!initData.device_auth_id || !initData.user_code) {
		throw new AIError.OAuthError("Device authorization response missing required fields", { kind: "validation" });
	}

	const userCode = initData.user_code;
	const pollIntervalMs =
		(typeof initData.interval === "number"
			? initData.interval
			: parseInt(String(initData.interval ?? "5"), 10) || 5) *
			1000 +
		DEVICE_POLL_SAFETY_MARGIN_MS;

	ctrl.onAuth?.({
		url: DEVICE_AUTH_URL,
		instructions: `Enter code: ${userCode}`,
	});

	ctrl.onProgress?.(`Waiting for browser authorization (code: ${userCode})…`);

	for (let poll = 0; poll < DEVICE_MAX_POLLS; poll++) {
		await Bun.sleep(poll === 0 ? Math.min(pollIntervalMs, DEVICE_POLL_INTERVAL_MS) : pollIntervalMs);

		if (ctrl.signal?.aborted) {
			throw new AIError.LoginCancelledError("Device authorization cancelled");
		}

		const pollResponse = await fetch(DEVICE_TOKEN_URL, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				device_auth_id: initData.device_auth_id,
				user_code: userCode,
			}),
			signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
		});

		// 403/404 = authorization pending, keep polling
		if (pollResponse.status === 403 || pollResponse.status === 404) {
			continue;
		}

		if (!pollResponse.ok) {
			throw new AIError.OAuthError(`Device token polling failed: ${pollResponse.status}`, {
				kind: "polling",
				status: pollResponse.status,
			});
		}

		const pollData = (await pollResponse.json()) as {
			authorization_code?: string;
			code_verifier?: string;
		};

		if (!pollData.authorization_code || !pollData.code_verifier) {
			throw new AIError.OAuthError("Device token response missing authorization_code or code_verifier", {
				kind: "validation",
			});
		}

		ctrl.onProgress?.("Exchanging authorization code for tokens…");
		return exchangeCodeForToken(pollData.authorization_code, pollData.code_verifier, DEVICE_REDIRECT_URI);
	}

	throw new AIError.OAuthError("Device authorization timed out — user did not complete login in time", {
		kind: "timeout",
	});
}
