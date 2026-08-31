/**
 * Z.ai / GLM OAuth flow (GLM Coding Plan · Sign in)
 *
 * Mirrors ZCode's desktop "Individual Plan" browser sign-in: an
 * authorization-code flow (no PKCE) against chat.z.ai, a JSON token exchange
 * that yields a short-lived OAuth access token, and a business-API sequence
 * that provisions a durable `id.secret` API key. The minted key is placed in
 * {@link OAuthCredentials.access}; `getOAuthApiKey` returns it verbatim as the
 * request bearer for the `zai` provider, so no dialect change is needed.
 */

import * as AIError from "../../error";
import type { FetchImpl } from "../../types";
import { OAuthCallbackFlow } from "./callback-server";
import type { OAuthController, OAuthCredentials } from "./types";

const env = (key: string): string | undefined => {
	const value = process.env[key];
	return typeof value === "string" && value.length > 0 ? value : undefined;
};

const CLIENT_ID = env("ZAI_OAUTH_CLIENT_ID") ?? "client_P8X5CMWmlaRO9gyO-KSqtg";
const AUTHORIZE_URL = env("ZAI_OAUTH_AUTHORIZE_URL") ?? "https://chat.z.ai/api/oauth/authorize";
const TOKEN_URL = env("ZAI_OAUTH_TOKEN_URL") ?? "https://zcode.z.ai/api/v1/oauth/token";
const BIZ_BASE = env("ZAI_BIZ_BASE") ?? "https://api.z.ai";
/** Business-login endpoint: exchanges the OAuth access token for a biz token. */
const BUSINESS_LOGIN_URL = env("ZAI_BUSINESS_LOGIN_URL") ?? "https://api.z.ai/api/auth/z/login";
/** OMP's own key name so sign-in never mutates ZCode's `zcode-api-key`. */
const KEY_NAME = "oh-my-pi";
// ZCode reuses this OAuth client id server-side, so the redirect must match an
// entry registered against it: the CLI flow's `http://127.0.0.1:9999/callback`
// (the desktop app uses the `zcode://` scheme). Any other host/port — e.g. the
// invented `localhost:54548` — is rejected with "Redirect URI not registered
// for this client" before the login page renders (#10245).
const CALLBACK_PORT = 9999;
const CALLBACK_HOSTNAME = "127.0.0.1";
const CALLBACK_PATH = "/callback";
const REDIRECT_URI = `http://${CALLBACK_HOSTNAME}:${CALLBACK_PORT}${CALLBACK_PATH}`;
/** Durable minted key never expires; matches the perplexity NEVER_EXPIRES sentinel. */
const NEVER_EXPIRES = 8.64e15;

function formatErrorDetails(error: unknown): string {
	if (error instanceof Error) {
		return error.message;
	}
	return String(error);
}

/**
 * Z.ai's `{ code, msg, data, success }` envelope. The OAuth token endpoint
 * signals success with `code: 0`; the biz endpoints (`api.z.ai`) use
 * `code: 200` / `success: true`. Accept both; throw `msg` on failure. Bodies
 * without a status wrapper pass through unchanged.
 */
function isSuccessCode(code: unknown): boolean {
	if (code == null) return true;
	if (typeof code === "number") return code === 0 || code === 200;
	if (typeof code === "string") return code === "0" || code === "200";
	return false;
}

function unwrapEnvelope(body: unknown, operation: string): unknown {
	if (body && typeof body === "object" && ("code" in body || "success" in body)) {
		const envelope = body as { code?: unknown; msg?: string; data?: unknown; success?: unknown };
		if (envelope.success === false || !isSuccessCode(envelope.code)) {
			throw new AIError.OAuthError(`Z.ai ${operation} failed: ${envelope.msg ?? `code ${String(envelope.code)}`}`, {
				kind: "token-exchange",
				provider: "zai",
			});
		}
		return "data" in envelope ? envelope.data : envelope;
	}
	return body;
}

async function getJson(url: string, headers: Record<string, string>, fetchImpl: FetchImpl): Promise<unknown> {
	const response = await fetchImpl(url, {
		method: "GET",
		headers,
		signal: AbortSignal.timeout(30_000),
	});
	const responseBody = await response.text();
	if (!response.ok) {
		throw new AIError.ProviderHttpError(
			`HTTP request failed. status=${response.status}; url=${url}; body=${responseBody}`,
			response.status,
		);
	}
	return responseBody.length > 0 ? JSON.parse(responseBody) : undefined;
}

async function postJson(
	url: string,
	body: Record<string, string | number>,
	headers: Record<string, string>,
	fetchImpl: FetchImpl,
): Promise<unknown> {
	const response = await fetchImpl(url, {
		method: "POST",
		headers: { ...headers, "Content-Type": "application/json" },
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
	return responseBody.length > 0 ? JSON.parse(responseBody) : undefined;
}

/** Coerce an api_keys list response (bare array or common wrapper shapes) to an array. */
function asKeyArray(value: unknown): Array<Record<string, unknown>> {
	if (Array.isArray(value)) return value as Array<Record<string, unknown>>;
	if (value && typeof value === "object") {
		const record = value as Record<string, unknown>;
		for (const field of ["list", "keys", "apiKeys", "records"]) {
			if (Array.isArray(record[field])) return record[field] as Array<Record<string, unknown>>;
		}
	}
	return [];
}

function trimmedString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

/**
 * Exchange the short-lived OAuth access token for a durable biz token via
 * ZCode's business-login endpoint. The biz APIs reject the raw OAuth token;
 * they require this token.
 */
async function businessLogin(oauthAccessToken: string, fetchImpl: FetchImpl): Promise<string> {
	const data = unwrapEnvelope(
		await postJson(BUSINESS_LOGIN_URL, { token: oauthAccessToken }, {}, fetchImpl),
		"business login",
	) as { access_token?: unknown; accessToken?: unknown } | undefined;
	const bizToken = trimmedString(data?.access_token) ?? trimmedString(data?.accessToken);
	if (!bizToken) {
		throw new AIError.OAuthError("Z.ai business login returned no access token", {
			kind: "token-exchange",
			provider: "zai",
		});
	}
	return bizToken;
}

interface ZaiProject {
	projectId?: unknown;
	isDefault?: unknown;
}
interface ZaiOrganization {
	organizationId?: unknown;
	isDefault?: unknown;
	projects?: ZaiProject[];
}

/**
 * Provision the durable Z.ai API key from a short-lived OAuth access token,
 * mirroring ZCode: business-login → resolve default org/project from
 * `getCustomerInfo` → find/create the OMP-named key → obtain its secret →
 * return `${apiKey}.${secretKey}` (the 49-char durable key).
 */
async function mintZaiApiKey(oauthAccessToken: string, fetchImpl: FetchImpl): Promise<string> {
	const bizToken = await businessLogin(oauthAccessToken, fetchImpl);
	const auth = { Authorization: `Bearer ${bizToken}` };

	const customer = unwrapEnvelope(
		await getJson(`${BIZ_BASE}/api/biz/customer/getCustomerInfo`, auth, fetchImpl),
		"customer lookup",
	) as { organizations?: ZaiOrganization[] } | undefined;
	const orgs = Array.isArray(customer?.organizations) ? customer.organizations : [];
	const org = orgs.find(o => o?.isDefault) ?? orgs[0];
	const projects = Array.isArray(org?.projects) ? org.projects : [];
	const project = projects.find(p => p?.isDefault) ?? projects[0];
	const organizationId = trimmedString(org?.organizationId);
	const projectId = trimmedString(project?.projectId);
	if (!organizationId || !projectId) {
		throw new AIError.OAuthError("Z.ai key provisioning failed: no organization/project on account", {
			kind: "token-exchange",
			provider: "zai",
		});
	}

	const keysUrl = `${BIZ_BASE}/api/biz/v1/organization/${organizationId}/projects/${projectId}/api_keys`;
	const existing = asKeyArray(unwrapEnvelope(await getJson(keysUrl, auth, fetchImpl), "api key list")).find(
		key => key.name === KEY_NAME,
	);
	const keyRecord =
		existing ??
		(unwrapEnvelope(await postJson(keysUrl, { name: KEY_NAME }, auth, fetchImpl), "api key create") as
			| Record<string, unknown>
			| undefined);

	const apiKey = trimmedString(keyRecord?.apiKey);
	if (!apiKey) {
		throw new AIError.OAuthError("Z.ai key provisioning returned no apiKey", {
			kind: "token-exchange",
			provider: "zai",
		});
	}

	// Always fetch the secret via the copy endpoint: list entries mask it
	// (`*****abcd`) and the create response's inline secret is not reliable
	// across account states, whereas copy always returns the full secret.
	const copied = unwrapEnvelope(
		await getJson(`${keysUrl}/copy/${encodeURIComponent(apiKey)}`, auth, fetchImpl),
		"api key copy",
	) as { secretKey?: unknown } | undefined;
	const secretKey = trimmedString(copied?.secretKey);
	if (!secretKey) {
		throw new AIError.OAuthError("Z.ai key provisioning returned no secretKey", {
			kind: "token-exchange",
			provider: "zai",
		});
	}

	return `${apiKey}.${secretKey}`;
}

export class ZaiOAuthFlow extends OAuthCallbackFlow {
	#fetch: FetchImpl;

	constructor(ctrl: OAuthController) {
		super(ctrl, {
			preferredPort: CALLBACK_PORT,
			callbackPath: CALLBACK_PATH,
			callbackHostname: CALLBACK_HOSTNAME,
			// Pin the exact registered redirect: a busy port must fail fast, not
			// fall back to a random port the provider's allowlist would reject.
			redirectUri: REDIRECT_URI,
		});
		this.#fetch = ctrl.fetch ?? fetch;
	}

	async generateAuthUrl(state: string, redirectUri: string): Promise<{ url: string; instructions?: string }> {
		// No PKCE: matches ZCode's authorize request verbatim.
		const authParams = new URLSearchParams({
			redirect_uri: redirectUri,
			response_type: "code",
			client_id: CLIENT_ID,
			state,
		});
		return {
			url: `${AUTHORIZE_URL}?${authParams.toString()}`,
			instructions:
				"Complete Z.ai login in your browser. If the browser cannot reach this machine, paste the final redirect URL or authorization code when prompted.",
		};
	}

	async exchangeToken(code: string, state: string, redirectUri: string): Promise<OAuthCredentials> {
		if (this.ctrl.signal?.aborted) {
			throw new AIError.LoginCancelledError(`OAuth callback cancelled: ${this.ctrl.signal.reason}`);
		}

		let body: unknown;
		try {
			// Non-standard token body (no grant_type/code_verifier): matches ZCode.
			body = await postJson(TOKEN_URL, { provider: "zai", code, redirect_uri: redirectUri, state }, {}, this.#fetch);
		} catch (error) {
			throw new AIError.OAuthError(
				`Token exchange request failed. url=${TOKEN_URL}; redirect_uri=${redirectUri}; details=${formatErrorDetails(error)}`,
				{ kind: "token-exchange", provider: "zai", cause: error },
			);
		}

		const data = unwrapEnvelope(body, "token exchange") as
			| { zai?: { access_token?: unknown }; user?: { email?: unknown; id?: unknown } }
			| undefined;
		const oauthAccessToken = trimmedString(data?.zai?.access_token);
		if (!oauthAccessToken) {
			throw new AIError.OAuthError("Z.ai token response missing access token", {
				kind: "validation",
				provider: "zai",
			});
		}

		const mintedKey = await mintZaiApiKey(oauthAccessToken, this.#fetch);

		return {
			access: mintedKey,
			refresh: "",
			expires: NEVER_EXPIRES,
			email: typeof data?.user?.email === "string" ? data.user.email : undefined,
			accountId:
				typeof data?.user?.id === "string" || typeof data?.user?.id === "number" ? String(data.user.id) : undefined,
		};
	}
}

/**
 * Login with Z.ai OAuth (GLM Coding Plan).
 */
export async function loginZaiOAuth(ctrl: OAuthController): Promise<OAuthCredentials> {
	const flow = new ZaiOAuthFlow(ctrl);
	return flow.login();
}
