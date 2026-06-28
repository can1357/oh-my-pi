/**
 * Shared OAuth flow for Google-style providers (Gemini CLI, Antigravity).
 *
 * Both providers use the same authorization-code flow shape; only the client
 * credentials, scopes, endpoint constants, and project-discovery logic differ.
 */
import * as AIError from "../../error";
import { extractGoogleValidationUrl, formatGoogleValidationRequiredMessage } from "../../utils/google-validation";
import { OAuthCallbackFlow } from "./callback-server";
import type { OAuthController, OAuthCredentials } from "./types";

export interface GoogleOAuthFlowConfig {
	clientId: string;
	clientSecret: string;
	authUrl: string;
	tokenUrl: string;
	scopes: string[];
	callbackPort: number;
	callbackPath: string;
	discoverProject: (accessToken: string, onProgress?: (message: string) => void) => Promise<string>;
}

async function getUserEmail(accessToken: string): Promise<string | undefined> {
	try {
		const response = await fetch("https://www.googleapis.com/oauth2/v1/userinfo?alt=json", {
			headers: { Authorization: `Bearer ${accessToken}` },
		});

		if (response.ok) {
			const data = (await response.json()) as { email?: string };
			return data.email;
		}
	} catch {
		// Ignore errors, email is optional
	}
	return undefined;
}

export class GoogleOAuthFlow extends OAuthCallbackFlow {
	private readonly config: GoogleOAuthFlowConfig;

	constructor(ctrl: OAuthController, config: GoogleOAuthFlowConfig) {
		super(ctrl, {
			preferredPort: config.callbackPort,
			callbackPath: config.callbackPath,
			callbackHostname: "127.0.0.1",
		});
		this.config = config;
	}

	async generateAuthUrl(state: string, redirectUri: string): Promise<{ url: string; instructions?: string }> {
		const authParams = new URLSearchParams({
			client_id: this.config.clientId,
			response_type: "code",
			redirect_uri: redirectUri,
			scope: this.config.scopes.join(" "),
			state,
			access_type: "offline",
			prompt: "consent",
		});

		const url = `${this.config.authUrl}?${authParams.toString()}`;
		return { url, instructions: "Complete the sign-in in your browser." };
	}

	async exchangeToken(code: string, _state: string, redirectUri: string): Promise<OAuthCredentials> {
		this.ctrl.onProgress?.("Exchanging authorization code for tokens...");

		const tokenResponse = await fetch(this.config.tokenUrl, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				client_id: this.config.clientId,
				client_secret: this.config.clientSecret,
				code,
				grant_type: "authorization_code",
				redirect_uri: redirectUri,
			}),
		});

		if (!tokenResponse.ok) {
			const error = await tokenResponse.text();
			throw new AIError.OAuthError(`Token exchange failed: ${error}`, { kind: "token-exchange" });
		}

		const tokenData = (await tokenResponse.json()) as {
			access_token: string;
			refresh_token: string;
			expires_in: number;
		};

		if (!tokenData.refresh_token) {
			throw new AIError.OAuthError("No refresh token received. Please try again.", { kind: "validation" });
		}

		this.ctrl.onProgress?.("Getting user info...");
		const email = await getUserEmail(tokenData.access_token);
		let projectId: string;
		try {
			projectId = await this.config.discoverProject(tokenData.access_token, this.ctrl.onProgress);
		} catch (err) {
			const validationUrl = extractGoogleValidationUrl(err instanceof Error ? err.message : String(err));
			if (!validationUrl) throw err;
			throw new AIError.OAuthError(formatGoogleValidationRequiredMessage(validationUrl, "sign in again", email), {
				kind: "validation",
			});
		}

		return {
			refresh: tokenData.refresh_token,
			access: tokenData.access_token,
			expires: Date.now() + tokenData.expires_in * 1000 - 5 * 60 * 1000,
			projectId,
			email,
		};
	}
}

export async function runGoogleOAuthLogin(
	ctrl: OAuthController,
	config: GoogleOAuthFlowConfig,
): Promise<OAuthCredentials> {
	const flow = new GoogleOAuthFlow(ctrl, config);
	return flow.login();
}
