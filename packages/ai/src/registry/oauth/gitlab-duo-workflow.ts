import * as AIError from "../../error";
import type { FetchImpl } from "../../types";
import { OAuthCallbackFlow } from "./callback-server";
import { generatePKCE } from "./pkce";
import type { OAuthCredentials, OAuthLoginCallbacks } from "./types";

const GITLAB_COM_URL = "https://gitlab.com";
export const GITLAB_DUO_WORKFLOW_OAUTH_CLIENT_ID = "36f2a70cddeb5a0889d4fd8295c241b7e9848e89cf9e599d0eed2d8e5350fbf5";
export const GITLAB_DUO_WORKFLOW_OAUTH_REDIRECT_URI = "vscode://gitlab.gitlab-workflow/authentication";
const OAUTH_SCOPES = ["api"];

interface PKCEPair {
	verifier: string;
	challenge: string;
}

function mapTokenResponse(payload: {
	access_token?: string;
	refresh_token?: string;
	expires_in?: number;
	created_at?: number;
}): OAuthCredentials {
	if (!payload.access_token || !payload.refresh_token || typeof payload.expires_in !== "number") {
		throw new AIError.OAuthError("GitLab Duo Workflow OAuth token response missing required fields", {
			kind: "validation",
			provider: "gitlab-duo-workflow",
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

class GitLabDuoWorkflowOAuthFlow extends OAuthCallbackFlow {
	#pkce: PKCEPair;
	#fetch: FetchImpl;

	constructor(ctrl: OAuthLoginCallbacks, pkce: PKCEPair) {
		super(ctrl, {
			preferredPort: 0,
			redirectUri: GITLAB_DUO_WORKFLOW_OAUTH_REDIRECT_URI,
		});
		this.#pkce = pkce;
		this.#fetch = ctrl.fetch ?? fetch;
	}

	override async generateAuthUrl(state: string): Promise<{ url: string; instructions?: string }> {
		const authParams = new URLSearchParams({
			client_id: GITLAB_DUO_WORKFLOW_OAUTH_CLIENT_ID,
			redirect_uri: GITLAB_DUO_WORKFLOW_OAUTH_REDIRECT_URI,
			response_type: "code",
			scope: OAUTH_SCOPES.join(" "),
			code_challenge: this.#pkce.challenge,
			code_challenge_method: "S256",
			state,
		});

		return {
			url: `${GITLAB_COM_URL}/oauth/authorize?${authParams.toString()}`,
			instructions:
				"Complete GitLab login in your browser. This uses GitLab's official VS Code OAuth application. " +
				"If the redirect opens VS Code instead of returning to OMP, copy the full " +
				"vscode://gitlab.gitlab-workflow/authentication?... callback URL from VS Code/browser and paste it back into OMP.",
		};
	}

	override async exchangeToken(code: string): Promise<OAuthCredentials> {
		const response = await this.#fetch(`${GITLAB_COM_URL}/oauth/token`, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				client_id: GITLAB_DUO_WORKFLOW_OAUTH_CLIENT_ID,
				redirect_uri: GITLAB_DUO_WORKFLOW_OAUTH_REDIRECT_URI,
				grant_type: "authorization_code",
				code,
				code_verifier: this.#pkce.verifier,
			}).toString(),
		});

		if (!response.ok) {
			throw new AIError.OAuthError(
				`GitLab Duo Workflow OAuth token exchange failed: ${response.status} ${await response.text()}`,
				{ kind: "token-exchange", provider: "gitlab-duo-workflow", status: response.status },
			);
		}

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

export async function loginGitLabDuoWorkflow(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
	const pkce = await generatePKCE();
	const flow = new GitLabDuoWorkflowOAuthFlow(callbacks, pkce);
	return flow.login();
}

export async function refreshGitLabDuoWorkflowToken(
	credentials: OAuthCredentials,
	fetchImpl: FetchImpl = fetch,
): Promise<OAuthCredentials> {
	const response = await fetchImpl(`${GITLAB_COM_URL}/oauth/token`, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			client_id: GITLAB_DUO_WORKFLOW_OAUTH_CLIENT_ID,
			redirect_uri: GITLAB_DUO_WORKFLOW_OAUTH_REDIRECT_URI,
			grant_type: "refresh_token",
			refresh_token: credentials.refresh,
		}).toString(),
	});

	if (!response.ok) {
		throw new AIError.OAuthError(
			`GitLab Duo Workflow OAuth refresh failed: ${response.status} ${await response.text()}`,
			{
				kind: "token-refresh",
				provider: "gitlab-duo-workflow",
				status: response.status,
			},
		);
	}

	return mapTokenResponse(
		(await response.json()) as {
			access_token?: string;
			refresh_token?: string;
			expires_in?: number;
			created_at?: number;
		},
	);
}
