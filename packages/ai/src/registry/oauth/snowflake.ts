import { authPolicyFor } from "@oh-my-pi/pi-catalog/compat/auth";
import { isRecord } from "@oh-my-pi/pi-utils";
import * as AIError from "../../error";
import { normalizeSnowflakeAccountUrl } from "../snowflake";
import { OAuthCallbackFlow } from "./callback-server";
import { generatePKCE } from "./pkce";
import type { OAuthController, OAuthCredentials } from "./types";

const SNOWFLAKE_OAUTH_CLIENT_ID = "LOCAL_APPLICATION";

function snowflakeCallbackPort(): number {
	const port = authPolicyFor("snowflake")?.callbackPort;
	if (port === undefined) throw new Error("Snowflake auth policy is missing callback-port");
	return port;
}

interface SnowflakeTokens {
	access: string;
	refresh?: string;
	expires: number;
}

async function parseTokenResponse(
	response: Response,
	kind: "token-exchange" | "token-refresh",
	signal?: AbortSignal,
): Promise<SnowflakeTokens> {
	signal?.throwIfAborted();
	if (!response.ok) {
		const operation = kind === "token-exchange" ? "exchange" : "refresh";
		throw new AIError.OAuthError(`Snowflake token ${operation} failed (${response.status})`, {
			kind,
			provider: "snowflake",
			status: response.status,
		});
	}

	let body: unknown;
	try {
		body = await response.json();
	} catch (error) {
		signal?.throwIfAborted();
		if (error instanceof Error && error.name === "AbortError") throw error;
		throw new AIError.OAuthError("Snowflake returned an invalid token response", {
			kind: "validation",
			provider: "snowflake",
		});
	}
	signal?.throwIfAborted();
	if (
		!isRecord(body) ||
		typeof body.access_token !== "string" ||
		!body.access_token.trim() ||
		typeof body.expires_in !== "number" ||
		!Number.isFinite(body.expires_in) ||
		body.expires_in <= 0 ||
		(body.refresh_token !== undefined && (typeof body.refresh_token !== "string" || !body.refresh_token.trim()))
	) {
		throw new AIError.OAuthError("Snowflake returned an invalid token response", {
			kind: "validation",
			provider: "snowflake",
		});
	}
	const lifetimeMs = body.expires_in * 1000;
	if (!Number.isFinite(lifetimeMs) || lifetimeMs <= 0) {
		throw new AIError.OAuthError("Snowflake returned an invalid token lifetime", {
			kind: "validation",
			provider: "snowflake",
		});
	}
	return {
		access: body.access_token,
		refresh: body.refresh_token,
		expires: Date.now() + lifetimeMs,
	};
}

class SnowflakeOAuthFlow extends OAuthCallbackFlow {
	#accountUrl: string;
	#verifier = "";

	constructor(ctrl: OAuthController, accountUrl: string) {
		super(ctrl, {
			preferredPort: snowflakeCallbackPort(),
			// Some local-app integrations reject callback subpaths despite the documented allowance.
			callbackPath: "/",
			callbackHostname: "127.0.0.1",
		});
		this.#accountUrl = accountUrl;
	}

	async generateAuthUrl(state: string, redirectUri: string): Promise<{ url: string; instructions: string }> {
		const { verifier, challenge } = await generatePKCE();
		this.#verifier = verifier;
		const params = new URLSearchParams({
			client_id: SNOWFLAKE_OAUTH_CLIENT_ID,
			response_type: "code",
			redirect_uri: redirectUri,
			scope: "refresh_token",
			state,
			code_challenge: challenge,
			code_challenge_method: "S256",
		});
		return {
			url: `${this.#accountUrl}/oauth/authorize?${params.toString()}`,
			instructions: "Sign in to Snowflake in your browser and approve access for omp.",
		};
	}

	async exchangeToken(code: string, _state: string, redirectUri: string): Promise<OAuthCredentials> {
		const signal = this.ctrl.signal;
		const fetchImpl = this.ctrl.fetch ?? fetch;
		let tokens: SnowflakeTokens;
		try {
			const response = await fetchImpl(`${this.#accountUrl}/oauth/token-request`, {
				method: "POST",
				headers: { "Content-Type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams({
					grant_type: "authorization_code",
					code,
					redirect_uri: redirectUri,
					code_verifier: this.#verifier,
					client_id: SNOWFLAKE_OAUTH_CLIENT_ID,
				}),
				signal,
				redirect: "error",
			});
			tokens = await parseTokenResponse(response, "token-exchange", signal);
		} catch (error) {
			if (signal?.aborted) throw new AIError.LoginCancelledError();
			throw error;
		}
		return { ...tokens, refresh: tokens.refresh ?? "", enterpriseUrl: this.#accountUrl };
	}
}

export async function loginSnowflake(ctrl: OAuthController): Promise<OAuthCredentials> {
	if (!ctrl.onPrompt) throw new AIError.OnPromptRequiredError("Snowflake");
	if (ctrl.signal?.aborted) throw new AIError.LoginCancelledError();
	const account = await ctrl.onPrompt({
		message: "Enter your Snowflake account identifier or URL",
		placeholder: "myorg-myaccount",
	});
	if (ctrl.signal?.aborted) throw new AIError.LoginCancelledError();
	const accountUrl = normalizeSnowflakeAccountUrl(account);
	return new SnowflakeOAuthFlow(ctrl, accountUrl).login();
}

export async function refreshSnowflakeToken(
	credentials: OAuthCredentials,
	signal?: AbortSignal,
): Promise<OAuthCredentials> {
	if (!credentials.refresh.trim()) {
		// Without refresh issuance the shared refresh skew would discard a still-valid token.
		if (Date.now() < credentials.expires) return credentials;
		throw new AIError.OAuthError(
			"Snowflake did not issue a refresh token; run /login snowflake again or use SNOWFLAKE_ACCOUNT and SNOWFLAKE_PAT",
			{ kind: "token-refresh", provider: "snowflake" },
		);
	}
	let accountUrl: string;
	try {
		accountUrl = normalizeSnowflakeAccountUrl(credentials.enterpriseUrl ?? "");
	} catch {
		throw new AIError.OAuthError("Invalid Snowflake account; run /login snowflake again", {
			kind: "validation",
			provider: "snowflake",
		});
	}
	const response = await fetch(`${accountUrl}/oauth/token-request`, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			grant_type: "refresh_token",
			refresh_token: credentials.refresh,
			client_id: SNOWFLAKE_OAUTH_CLIENT_ID,
		}),
		signal,
		redirect: "error",
	});
	const tokens = await parseTokenResponse(response, "token-refresh", signal);
	return { ...credentials, ...tokens, refresh: tokens.refresh ?? credentials.refresh };
}
