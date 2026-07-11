import * as AIError from "../../error";
import { OAuthCallbackFlow } from "./callback-server";
import { generatePKCE } from "./pkce";
import type { OAuthController, OAuthCredentials } from "./types";

type FetchFunction = NonNullable<OAuthController["fetch"]>;

const DEVIN_WEBAPP_URL = "https://app.devin.ai";
const DEVIN_API_URL = "https://api.devin.ai";
const CALLBACK_PORT = 59653;
const CALLBACK_PATH = "/callback";
const TOKEN_PATH = "/auth/cli/token";
const FALLBACK_EXPIRES_MS = 365 * 24 * 60 * 60 * 1000;

interface DevinPKCEParams {
	verifier: string;
	challenge: string;
}

export async function loginDevin(ctrl: OAuthController): Promise<OAuthCredentials> {
	const flow = new DevinOAuthFlow(ctrl);
	return flow.login();
}

class DevinOAuthFlow extends OAuthCallbackFlow {
	#pkce?: DevinPKCEParams;

	constructor(ctrl: OAuthController) {
		super(ctrl, {
			preferredPort: CALLBACK_PORT,
			callbackPath: CALLBACK_PATH,
			callbackHostname: "127.0.0.1",
		});
	}

	generateState(): string {
		return crypto.randomUUID();
	}

	async generateAuthUrl(state: string, redirectUri: string): Promise<{ url: string; instructions?: string }> {
		this.#pkce = await generatePKCE();
		const params = new URLSearchParams({
			redirect_uri: redirectUri,
			state,
			prompt: "select_account",
			code_challenge: this.#pkce.challenge,
			code_challenge_method: "S256",
		});

		return {
			url: `${DEVIN_WEBAPP_URL}/auth/cli/continue?${params.toString()}`,
			instructions: "Sign in to Devin in your browser.",
		};
	}

	async exchangeToken(code: string): Promise<OAuthCredentials> {
		if (!this.#pkce) {
			throw new AIError.OAuthError("Devin PKCE verifier was not initialized", {
				kind: "configuration",
				provider: "devin",
			});
		}
		const token = await exchangeDevinCliToken(code, this.#pkce.verifier, this.ctrl.fetch);

		return {
			access: token,
			refresh: token,
			expires: getTokenExpiry(token),
			apiEndpoint: DEVIN_API_URL,
			enterpriseUrl: DEVIN_WEBAPP_URL,
		};
	}
}

export async function exchangeDevinCliToken(
	authorizationCode: string,
	codeVerifier: string,
	fetchImpl: FetchFunction = fetch,
): Promise<string> {
	const response = await fetchImpl(`${DEVIN_API_URL}${TOKEN_PATH}`, {
		method: "POST",
		headers: {
			Accept: "application/json",
			"Content-Type": "application/json",
		},
		body: JSON.stringify({
			code: authorizationCode,
			code_verifier: codeVerifier,
		}),
	});

	if (!response.ok) {
		const error = await response.text();
		throw new AIError.OAuthError(`Devin CLI token exchange failed: ${response.status} ${error}`.trim(), {
			kind: "token-exchange",
			provider: "devin",
			status: response.status,
		});
	}

	const data = (await response.json()) as { token?: unknown };
	if (typeof data.token !== "string" || data.token.length === 0) {
		throw new AIError.OAuthError("Devin CLI token exchange returned an empty token", {
			kind: "validation",
			provider: "devin",
		});
	}
	return data.token;
}

function getTokenExpiry(token: string): number {
	try {
		const [, payload] = token.split(".");
		if (payload) {
			const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as { exp?: unknown };
			if (typeof decoded.exp === "number" && Number.isFinite(decoded.exp)) {
				return decoded.exp * 1000 - 5 * 60 * 1000;
			}
		}
	} catch {
		// Ignore malformed non-JWT tokens and use a conservative long-lived fallback.
	}
	return Date.now() + FALLBACK_EXPIRES_MS;
}
