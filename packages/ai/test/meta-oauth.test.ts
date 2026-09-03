import { afterEach, describe, expect, it, vi } from "bun:test";
import { authPolicyFor } from "@oh-my-pi/pi-catalog/compat/auth";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { getProviderDefinition } from "@oh-my-pi/pi-ai/registry";
import { metaMintKeyHook } from "@oh-my-pi/pi-ai/registry/oauth/meta";
import type { OAuthCredentials } from "@oh-my-pi/pi-ai/registry/oauth/types";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";

const DEVICE_URL = "https://auth.meta.com/oidc/device/authorization/";
const TOKEN_URL = "https://auth.meta.com/oidc/device/token/";
const MINT_URL = "https://api.meta.ai/muse-code/key";
const CLIENT_ID = "1031625952748946";

const DEVICE_AUTHORIZATION = {
	device_code: "meta-device-code",
	user_code: "ABCD-EFGH",
	verification_uri: "https://auth.meta.com/activate",
	verification_uri_complete: "https://auth.meta.com/activate?user_code=ABCD-EFGH",
	interval: 0,
	expires_in: 900,
};

function jsonResponse(body: unknown, status: number = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

type RecordedRequest = {
	url: string;
	init: RequestInit | undefined;
};

/** Route device/token/mint requests to canned responses, recording each call. */
function createMetaFlowFetch(tokenPolls: readonly unknown[], mintBody: unknown, mintStatus: number = 200) {
	const requests: RecordedRequest[] = [];
	let pollIndex = 0;
	const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input instanceof Request ? input.url : input.toString();
		requests.push({ url, init });
		if (url === DEVICE_URL) return jsonResponse(DEVICE_AUTHORIZATION);
		if (url === TOKEN_URL) {
			const body = tokenPolls[pollIndex];
			pollIndex += 1;
			if (body === undefined) throw new Error(`Unexpected Meta token poll ${pollIndex}`);
			return jsonResponse(body);
		}
		if (url === MINT_URL) return jsonResponse(mintBody, mintStatus);
		throw new Error(`Unexpected Meta OAuth request: ${url}`);
	});
	return { fetchImpl: fetchImpl as unknown as FetchImpl, requests };
}

function storedCredentials(): OAuthCredentials {
	return { access: "oauth-access-token", refresh: "oauth-refresh-token", expires: 0 };
}

function requestForm(request: RecordedRequest | undefined): URLSearchParams {
	const body = request?.init?.body;
	if (body instanceof URLSearchParams) return body;
	if (typeof body === "string") return new URLSearchParams(body);
	throw new Error("Expected an application/x-www-form-urlencoded request body");
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("meta-oauth auth policy", () => {
	it("declares the Muse launcher device flow stored as meta with no refresh", () => {
		const policy = authPolicyFor("meta-oauth");
		if (!policy) throw new Error("missing meta-oauth policy");
		expect(policy.storeAs).toBe("meta");
		expect(policy.refresh?.kind).toBe("none");
		const login = policy.login;
		expect(login?.kind).toBe("device-code");
		if (login?.kind !== "device-code") throw new Error("missing meta-oauth device-code login");
		expect(login.clientId).toMatchObject({ value: CLIENT_ID });
		expect(login.device.url).toMatchObject({ value: DEVICE_URL });
		expect(login.token.url).toMatchObject({ value: TOKEN_URL });
	});

	it("derives a loginable registry definition stored as meta", () => {
		const definition = getProviderDefinition("meta-oauth");
		if (!definition?.login) throw new Error("expected meta-oauth provider");
		expect(definition.storeCredentialsAs).toBe("meta");
		expect(definition.callbackPort).toBeUndefined();
		expect(definition.refreshToken).toBeUndefined();
	});
});

describe("metaMintKeyHook", () => {
	it("swaps the OAuth token for the minted Model API key", async () => {
		const { fetchImpl, requests } = createMetaFlowFetch([], { api_key: "LLM-minted-key" });
		const minted = await metaMintKeyHook(storedCredentials(), {
			provider: "meta-oauth",
			phase: "login",
			raw: { access_token: "oauth-access-token" },
			fetch: fetchImpl,
		});
		expect(minted.access).toBe("LLM-minted-key");
		expect(minted.refresh).toBe("oauth-refresh-token");
		const mint = requests.find(request => request.url === MINT_URL);
		expect(mint?.init?.method).toBe("POST");
		const headers = new Headers(mint?.init?.headers);
		expect(headers.get("Authorization")).toBe("Bearer oauth-access-token");
		expect(headers.get("x-api-version")).toBe("1.0.0");
		// The mint endpoint 400s on an empty body; it requires a JSON object.
		expect(headers.get("Content-Type")).toBe("application/json");
		expect(mint?.init?.body).toBe("{}");
	});

	it("surfaces mint HTTP failures as token-exchange errors", async () => {
		const { fetchImpl } = createMetaFlowFetch([], { error: "account_suspended" }, 403);
		const failure = metaMintKeyHook(storedCredentials(), {
			provider: "meta-oauth",
			phase: "login",
			raw: {},
			fetch: fetchImpl,
		});
		await expect(failure).rejects.toBeInstanceOf(AIError.OAuthError);
		await expect(failure).rejects.toMatchObject({ kind: "token-exchange" });
	});

	it("rejects a mint response with no API key", async () => {
		const { fetchImpl } = createMetaFlowFetch([], { base_url: "https://api.meta.ai/v1" });
		await expect(
			metaMintKeyHook(storedCredentials(), {
				provider: "meta-oauth",
				phase: "login",
				raw: {},
				fetch: fetchImpl,
			}),
		).rejects.toThrow(/no API key/);
	});

	it("surfaces the setup URL when Meta issues no key", async () => {
		const { fetchImpl } = createMetaFlowFetch([], {
			require_payment: true,
			action_url: "https://auth.meta.com/setup",
		});
		await expect(
			metaMintKeyHook(storedCredentials(), {
				provider: "meta-oauth",
				phase: "login",
				raw: {},
				fetch: fetchImpl,
			}),
		).rejects.toThrow(/https:\/\/auth\.meta\.com\/setup/);
	});
});

describe("meta-oauth device login", () => {
	it("mints the Model API key after device approval", async () => {
		const { fetchImpl, requests } = createMetaFlowFetch(
			[{ error: "authorization_pending" }, { access_token: "oauth-access-token", refresh_token: "oauth-refresh" }],
			{ api_key: "LLM-minted-key" },
		);
		const definition = getProviderDefinition("meta-oauth");
		if (!definition?.login) throw new Error("expected meta-oauth provider");
		let authUrl = "";
		const credentials = await definition.login({
			onAuth: info => {
				authUrl = info.url;
			},
			onPrompt: async () => "",
			fetch: fetchImpl,
		});
		if (typeof credentials === "string") throw new Error("expected structured credentials");
		expect(authUrl).toBe(DEVICE_AUTHORIZATION.verification_uri_complete);
		expect(credentials.access).toBe("LLM-minted-key");
		const device = requests.find(request => request.url === DEVICE_URL);
		expect(requestForm(device).get("client_id")).toBe(CLIENT_ID);
		const poll = requests.find(request => request.url === TOKEN_URL);
		expect(requestForm(poll).get("device_code")).toBe(DEVICE_AUTHORIZATION.device_code);
	});
});
