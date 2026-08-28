/**
 * Anthropic OAuth flow (Claude Pro/Max)
 */

import * as AIError from "../../error";
import { claudeCodeSdkVersion, claudeCodeVersion } from "../../providers/claude-code-fingerprint";
import type { FetchImpl } from "../../types";
import { OAuthCallbackFlow } from "./callback-server";
import { generatePKCE } from "./pkce";
import type { OAuthController, OAuthCredentials } from "./types";

const decode = (s: string) => atob(s);
const CLIENT_ID = decode("OWQxYzI1MGEtZTYxYi00NGQ5LTg4ZWQtNTk0NGQxOTYyZjVl");
const AUTHORIZE_URL = "https://claude.ai/oauth/authorize";
const TOKEN_URL = "https://api.anthropic.com/v1/oauth/token";
const BOOTSTRAP_URL = "https://api.anthropic.com/api/claude_cli/bootstrap";
const CLAUDE_CODE_BOOTSTRAP_MODEL = "claude-opus-4-8";
const CLAUDE_CODE_BOOTSTRAP_USER_AGENT = `claude-code/${claudeCodeVersion}`;
const CALLBACK_PORT = 54545;
const CALLBACK_PATH = "/callback";
// Scopes required for direct OAuth-token inference (user:inference) plus account/session management.
// platform.claude.com/oauth/authorize issues console tokens (org:create_api_key only) and does not
// grant user:inference — the claude.ai endpoint is required for direct inference access.
const SCOPES =
	"org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload";

export { ANTHROPIC_OAUTH_GRANT_TTL_MS } from "./anthropic-constants";

function formatErrorDetails(error: unknown): string {
	if (error instanceof Error) {
		const details: string[] = [`${error.name}: ${error.message}`];
		const errorWithCode = error as Error & { code?: string; errno?: number | string; cause?: unknown };
		if (errorWithCode.code) details.push(`code=${errorWithCode.code}`);
		if (typeof errorWithCode.errno !== "undefined") details.push(`errno=${String(errorWithCode.errno)}`);
		if (typeof error.cause !== "undefined") {
			details.push(`cause=${formatErrorDetails(error.cause)}`);
		}
		if (error.stack) {
			details.push(`stack=${error.stack}`);
		}
		return details.join("; ");
	}
	return String(error);
}

async function postJson(
	url: string,
	body: Record<string, string | number>,
	fetchImpl: FetchImpl,
	extraHeaders?: Record<string, string>,
): Promise<string> {
	const response = await fetchImpl(url, {
		method: "POST",
		headers: {
			// No Accept header: CC omits it on OAuth token requests.
			...extraHeaders,
			"Content-Type": "application/json",
		},
		body: JSON.stringify(body),
		signal: AbortSignal.timeout(30_000),
	});

	const responseBody = await response.text();
	if (!response.ok) {
		throw new AIError.ProviderHttpError(
			`HTTP request failed. status=${response.status}; url=${url}; body=${responseBody}`,
			response.status,
		);
	}
	return responseBody;
}

/**
 * Decoded shape of Anthropic's `/v1/oauth/token` response (both
 * `authorization_code` exchange and `refresh_token` refresh return the same
 * envelope). Newer responses inline `account`; older/stale credentials can
 * recover the same identity from `/api/claude_cli/bootstrap`.
 */
interface AnthropicTokenResponse {
	access_token: string;
	refresh_token: string;
	expires_in: number;
	account?: { uuid?: string; email_address?: string };
	organization?: { uuid?: string; name?: string };
}

interface AnthropicBootstrapResponse {
	oauth_account?: {
		account_uuid?: string;
		account_email?: string;
		organization_uuid?: string;
		organization_name?: string;
	};
}

/**
 * Account + organization identity slice resolved from the token response
 * and/or the `/api/claude_cli/bootstrap` endpoint. The organization is the
 * subscription workspace the token draws limits from — one account email can
 * hold several (e.g. a Team seat plus a personal Max plan).
 */
interface AnthropicIdentity {
	accountId?: string;
	email?: string;
	orgId?: string;
	orgName?: string;
}

function nonEmpty(value: string | undefined): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function parseOAuthTokenResponse(responseBody: string, operation: string): AnthropicTokenResponse {
	try {
		return JSON.parse(responseBody) as AnthropicTokenResponse;
	} catch (error) {
		throw new AIError.OAuthError(
			`Anthropic ${operation} returned invalid JSON. url=${TOKEN_URL}; body=${responseBody}; details=${formatErrorDetails(error)}`,
			{ kind: "validation", provider: "anthropic", cause: error },
		);
	}
}

/**
 * Lift the OAuth response's `account: { uuid, email_address }` and
 * `organization: { uuid, name }` blocks onto {@link OAuthCredentials} so
 * downstream identity propagation (e.g. `metadata.user_id.account_uuid`,
 * usage tracking, org-scoped credential identity) works without a separate
 * `/api/oauth/profile` round-trip. Returns `undefined` for any field the
 * response omits or carries as a non-string / empty value.
 */
function extractAccountFromTokenResponse(data: AnthropicTokenResponse): AnthropicIdentity {
	return {
		accountId: nonEmpty(data.account?.uuid),
		email: nonEmpty(data.account?.email_address),
		orgId: nonEmpty(data.organization?.uuid),
		orgName: nonEmpty(data.organization?.name),
	};
}

async function fetchBootstrapIdentity(accessToken: string, fetchImpl: FetchImpl): Promise<AnthropicIdentity> {
	const url = `${BOOTSTRAP_URL}?entrypoint=cli&model=${encodeURIComponent(CLAUDE_CODE_BOOTSTRAP_MODEL)}`;
	const response = await fetchImpl(url, {
		method: "GET",
		headers: {
			Accept: "application/json, text/plain, */*",
			Authorization: `Bearer ${accessToken}`,
			"Content-Type": "application/json",
			"User-Agent": CLAUDE_CODE_BOOTSTRAP_USER_AGENT,
			"anthropic-beta": "oauth-2025-04-20",
		},
		signal: AbortSignal.timeout(30_000),
	});
	const responseBody = await response.text();
	if (!response.ok) {
		throw new AIError.ProviderHttpError(
			`HTTP request failed. status=${response.status}; url=${url}; body=${responseBody}`,
			response.status,
		);
	}
	let data: AnthropicBootstrapResponse;
	try {
		data = JSON.parse(responseBody) as AnthropicBootstrapResponse;
	} catch (error) {
		throw new AIError.OAuthError(
			`Anthropic bootstrap returned invalid JSON. url=${url}; body=${responseBody}; details=${formatErrorDetails(error)}`,
			{ kind: "validation", provider: "anthropic", cause: error },
		);
	}
	return {
		accountId: nonEmpty(data.oauth_account?.account_uuid),
		email: nonEmpty(data.oauth_account?.account_email),
		orgId: nonEmpty(data.oauth_account?.organization_uuid),
		orgName: nonEmpty(data.oauth_account?.organization_name),
	};
}

/**
 * Resolve account (and optionally organization) identity for a token
 * response. `includeOrg` is login-only: the org an access token is scoped to
 * is captured once when the credential is created and deliberately never
 * refreshed afterwards — rewriting identity during background token
 * refreshes could silently re-key stored credentials.
 */
async function resolveAccountIdentity(
	data: AnthropicTokenResponse,
	fetchImpl: FetchImpl,
	options?: { includeOrg?: boolean },
): Promise<AnthropicIdentity> {
	const identity = extractAccountFromTokenResponse(data);
	const orgSatisfied = !options?.includeOrg || identity.orgId !== undefined;
	if (identity.accountId && identity.email && orgSatisfied) return identity;
	try {
		const bootstrap = await fetchBootstrapIdentity(data.access_token, fetchImpl);
		return {
			accountId: identity.accountId ?? bootstrap.accountId,
			email: identity.email ?? bootstrap.email,
			orgId: identity.orgId ?? bootstrap.orgId,
			orgName: identity.orgName ?? bootstrap.orgName,
		};
	} catch {
		return identity;
	}
}

export class AnthropicOAuthFlow extends OAuthCallbackFlow {
	#verifier: string = "";
	#challenge: string = "";
	#fetch: FetchImpl;

	constructor(ctrl: OAuthController) {
		super(ctrl, CALLBACK_PORT, CALLBACK_PATH);
		this.#fetch = ctrl.fetch ?? fetch;
	}

	async generateAuthUrl(state: string, redirectUri: string): Promise<{ url: string; instructions?: string }> {
		const pkce = await generatePKCE();
		this.#verifier = pkce.verifier;
		this.#challenge = pkce.challenge;

		const authParams = new URLSearchParams({
			code: "true",
			client_id: CLIENT_ID,
			response_type: "code",
			redirect_uri: redirectUri,
			scope: SCOPES,
			code_challenge: this.#challenge,
			code_challenge_method: "S256",
			state,
		});
		const url = `${AUTHORIZE_URL}?${authParams.toString()}`;

		return {
			url,
			instructions:
				"Complete login in your browser. If the browser cannot reach this machine, paste the final redirect URL or authorization code when prompted.",
		};
	}

	async exchangeToken(code: string, state: string, redirectUri: string): Promise<OAuthCredentials> {
		let exchangeCode = code;
		let exchangeState = state;
		const codeFragmentIndex = code.indexOf("#");
		if (codeFragmentIndex >= 0) {
			exchangeCode = code.slice(0, codeFragmentIndex);
			const codeFragmentState = code.slice(codeFragmentIndex + 1);
			if (codeFragmentState.length > 0) {
				exchangeState = codeFragmentState;
			}
		}

		let responseBody: string;
		try {
			responseBody = await postJson(
				TOKEN_URL,
				{
					grant_type: "authorization_code",
					client_id: CLIENT_ID,
					code: exchangeCode,
					state: exchangeState,
					redirect_uri: redirectUri,
					code_verifier: this.#verifier,
				},
				this.#fetch,
			);
		} catch (error) {
			throw new AIError.OAuthError(
				`Token exchange request failed. url=${TOKEN_URL}; redirect_uri=${redirectUri}; response_type=authorization_code; details=${formatErrorDetails(error)}`,
				{ kind: "token-exchange", provider: "anthropic", cause: error },
			);
		}

		const tokenData = parseOAuthTokenResponse(responseBody, "token exchange");
		const { accountId, email, orgId, orgName } = await resolveAccountIdentity(tokenData, this.#fetch, {
			includeOrg: true,
		});

		return {
			refresh: tokenData.refresh_token,
			access: tokenData.access_token,
			expires: Date.now() + tokenData.expires_in * 1000 - 5 * 60 * 1000,
			accountId,
			email,
			orgId,
			orgName,
		};
	}
}

/**
 * Login with Anthropic OAuth
 */
export async function loginAnthropic(ctrl: OAuthController): Promise<OAuthCredentials> {
	const flow = new AnthropicOAuthFlow(ctrl);
	return flow.login();
}

/**
 * Refresh Anthropic OAuth token
 */
export async function refreshAnthropicToken(
	refreshToken: string,
	fetchOverride?: FetchImpl,
): Promise<OAuthCredentials> {
	const fetchImpl = fetchOverride ?? fetch;
	let responseBody: string;
	try {
		responseBody = await postJson(
			TOKEN_URL,
			{
				grant_type: "refresh_token",
				client_id: CLIENT_ID,
				refresh_token: refreshToken,
			},
			fetchImpl,
			{
				// CC sends these on refresh but not on the initial code exchange
				"anthropic-beta": "oauth-2025-04-20",
				"User-Agent": `anthropic-sdk-typescript/${claudeCodeSdkVersion} userOAuthProvider`,
			},
		);
	} catch (error) {
		throw new AIError.OAuthError(
			`Anthropic token refresh request failed. url=${TOKEN_URL}; details=${formatErrorDetails(error)}`,
			{
				kind: "token-refresh",
				provider: "anthropic",
				cause: error,
			},
		);
	}

	const data = parseOAuthTokenResponse(responseBody, "token refresh");
	// Deliberately no `includeOrg` and no org fields on the result: the org a
	// credential is scoped to is fixed at login. Callers merge refresh results
	// over the stored credential, so omitting org here preserves it verbatim.
	const { accountId, email } = await resolveAccountIdentity(data, fetchImpl);

	return {
		refresh: data.refresh_token || refreshToken,
		access: data.access_token,
		expires: Date.now() + data.expires_in * 1000 - 5 * 60 * 1000,
		accountId,
		email,
	};
}
