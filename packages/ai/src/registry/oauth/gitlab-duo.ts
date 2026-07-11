import * as AIError from "../../error";
import { clearGitLabDuoDirectAccessCache } from "../../providers/gitlab-duo";
import type { FetchImpl } from "../../types";
import { OAuthCallbackFlow, type OAuthCallbackFlowOptions } from "./callback-server";
import { generatePKCE } from "./pkce";
import type { OAuthCredentials, OAuthLoginCallbacks } from "./types";

const GITLAB_COM_URL = "https://gitlab.com";
/**
 * Default OAuth client id baked into the bundled GitLab Duo login flow. GitLab
 * authorize requests are rejected outright (`The redirect URI included is not
 * valid`) whenever this client id's registered redirect URI list drifts from
 * `http://localhost:8080/callback`. Users hitting that case can either:
 *
 * - register their own GitLab OAuth application and override the bundled
 *   credentials with `GITLAB_CLIENT_ID` + `GITLAB_REDIRECT_URI`, or
 * - skip OAuth entirely and supply a Personal Access Token via `GITLAB_TOKEN`.
 *
 * @see https://github.com/can1357/oh-my-pi/issues/2424
 */
const DEFAULT_CLIENT_ID = "da4edff2e6ebd2bc3208611e2768bc1c1dd7be791dc5ff26ca34ca9ee44f7d4b";
const OAUTH_SCOPES = ["api"];
const DEFAULT_CALLBACK_PORT = 8080;
const DEFAULT_CALLBACK_PATH = "/callback";
const DEFAULT_CALLBACK_HOSTNAME = "localhost";

interface PKCEPair {
	verifier: string;
	challenge: string;
}

/**
 * Resolve the OAuth client id, preferring `GITLAB_CLIENT_ID` when set so users
 * with their own GitLab OAuth application can bypass the bundled credentials.
 */
function resolveClientId(): string {
	const env = process.env.GITLAB_CLIENT_ID?.trim();
	return env && env.length > 0 ? env : DEFAULT_CLIENT_ID;
}

/**
 * Resolve callback-server options from `GITLAB_REDIRECT_URI`. When set, the
 * exact string is advertised to GitLab (strict matching), random-port fallback
 * is disabled, and HTTP loopback URIs bind the listener to the URI's host/port
 * so the browser callback lands on us. HTTPS loopback URIs are rejected because
 * the local callback server is plaintext HTTP. Non-loopback URIs bind a random
 * local port — only the paste-code path can complete in that case.
 */
function resolveCallbackOptions(): OAuthCallbackFlowOptions {
	const raw = process.env.GITLAB_REDIRECT_URI?.trim();
	if (!raw) {
		return {
			preferredPort: DEFAULT_CALLBACK_PORT,
			callbackPath: DEFAULT_CALLBACK_PATH,
			callbackHostname: DEFAULT_CALLBACK_HOSTNAME,
		};
	}

	let parsed: URL;
	try {
		parsed = new URL(raw);
	} catch {
		throw new AIError.OAuthError(`Invalid GITLAB_REDIRECT_URI: ${raw}`, {
			kind: "configuration",
			provider: "gitlab-duo",
		});
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new AIError.OAuthError(`GITLAB_REDIRECT_URI must use http:// or https://, got: ${raw}`, {
			kind: "configuration",
			provider: "gitlab-duo",
		});
	}

	const isLoopback = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "[::1]";
	if (isLoopback && parsed.protocol !== "http:") {
		throw new AIError.OAuthError(`GITLAB_REDIRECT_URI loopback callbacks must use http://, got: ${raw}`, {
			kind: "configuration",
			provider: "gitlab-duo",
		});
	}

	const port = parsed.port ? Number.parseInt(parsed.port, 10) : parsed.protocol === "https:" ? 443 : 80;

	return {
		preferredPort: isLoopback ? port : 0,
		callbackPath: parsed.pathname || DEFAULT_CALLBACK_PATH,
		callbackHostname: isLoopback ? parsed.hostname : DEFAULT_CALLBACK_HOSTNAME,
		redirectUri: raw,
	};
}

function mapTokenResponse(payload: {
	access_token?: string;
	refresh_token?: string;
	expires_in?: number;
	created_at?: number;
}): OAuthCredentials {
	if (!payload.access_token || !payload.refresh_token || typeof payload.expires_in !== "number") {
		throw new AIError.OAuthError("GitLab OAuth token response missing required fields", {
			kind: "validation",
			provider: "gitlab-duo",
		});
	}

	const createdAtMs =
		typeof payload.created_at === "number" && Number.isFinite(payload.created_at)
			? payload.created_at * 1000
			: Date.now();

	return {
		access: payload.access_token,
		refresh: payload.refresh_token,
		expires: createdAtMs + payload.expires_in * 1000 - 5 * 60 * 1000,
	};
}

class GitLabDuoOAuthFlow extends OAuthCallbackFlow {
	#pkce: PKCEPair;
	#clientId: string;
	#fetch: FetchImpl;

	constructor(ctrl: OAuthLoginCallbacks, pkce: PKCEPair, clientId: string, options: OAuthCallbackFlowOptions) {
		super(ctrl, options);
		this.#pkce = pkce;
		this.#clientId = clientId;
		this.#fetch = ctrl.fetch ?? fetch;
	}

	override async generateAuthUrl(state: string, redirectUri: string): Promise<{ url: string; instructions?: string }> {
		const authParams = new URLSearchParams({
			client_id: this.#clientId,
			redirect_uri: redirectUri,
			response_type: "code",
			scope: OAUTH_SCOPES.join(" "),
			code_challenge: this.#pkce.challenge,
			code_challenge_method: "S256",
			state,
		});

		return {
			url: `${GITLAB_COM_URL}/oauth/authorize?${authParams.toString()}`,
			instructions:
				'Complete GitLab login in browser. If GitLab responds with "The redirect URI included is not valid", ' +
				"register your own GitLab OAuth application and set GITLAB_CLIENT_ID + GITLAB_REDIRECT_URI, or use a " +
				"Personal Access Token via GITLAB_TOKEN.",
		};
	}

	override async exchangeToken(code: string, _state: string, redirectUri: string): Promise<OAuthCredentials> {
		const response = await this.#fetch(`${GITLAB_COM_URL}/oauth/token`, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				client_id: this.#clientId,
				grant_type: "authorization_code",
				code,
				code_verifier: this.#pkce.verifier,
				redirect_uri: redirectUri,
			}).toString(),
		});

		if (!response.ok) {
			throw new AIError.OAuthError(
				`GitLab OAuth token exchange failed: ${response.status} ${await response.text()}`,
				{
					kind: "token-exchange",
					provider: "gitlab-duo",
					status: response.status,
				},
			);
		}

		clearGitLabDuoDirectAccessCache();
		return mapTokenResponse(
			(await response.json()) as {
				access_token?: string;
				refresh_token?: string;
				expires_in?: number;
				created_at?: number;
			},
		);
	}
}

export async function loginGitLabDuo(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
	const pkce = await generatePKCE();
	const clientId = resolveClientId();
	const options = resolveCallbackOptions();
	const flow = new GitLabDuoOAuthFlow(callbacks, pkce, clientId, options);
	return flow.login();
}

export async function refreshGitLabDuoToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
	const response = await fetch(`${GITLAB_COM_URL}/oauth/token`, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			client_id: resolveClientId(),
			grant_type: "refresh_token",
			refresh_token: credentials.refresh,
		}).toString(),
	});

	if (!response.ok) {
		throw new AIError.OAuthError(`GitLab OAuth refresh failed: ${response.status} ${await response.text()}`, {
			kind: "token-refresh",
			provider: "gitlab-duo",
			status: response.status,
		});
	}

	clearGitLabDuoDirectAccessCache();
	return mapTokenResponse(
		(await response.json()) as {
			access_token?: string;
			refresh_token?: string;
			expires_in?: number;
			created_at?: number;
		},
	);
}
