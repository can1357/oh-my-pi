import { afterEach, describe, expect, it, vi } from "bun:test";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { getProviderDefinition } from "@oh-my-pi/pi-ai/registry";
import type { OAuthCredentials, OAuthController } from "@oh-my-pi/pi-ai/registry/oauth/types";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";

const CLIENT_ID = "client_P8X5CMWmlaRO9gyO-KSqtg";
const AUTHORIZE_URL = "https://chat.z.ai/api/oauth/authorize";
const TOKEN_URL = "https://zcode.z.ai/api/v1/oauth/token";
const BUSINESS_LOGIN_URL = "https://api.z.ai/api/auth/z/login";
const BIZ_BASE = "https://api.z.ai";
const KEYS_URL = `${BIZ_BASE}/api/biz/v1/organization/org-1/projects/proj-1/api_keys`;
const REDIRECT_URI = "http://127.0.0.1:9999/callback";

interface RecordedRequest {
	url: string;
	method: string;
	body: unknown;
	authorization: string | null;
}

/** OAuth token endpoint signals success with `code: 0`. */
function tokenEnvelope(data: unknown): Response {
	return new Response(JSON.stringify({ code: 0, msg: "ok", data }), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
}

/** Biz endpoints (api.z.ai) signal success with `code: 200` / `success: true`. */
function bizEnvelope(data: unknown): Response {
	return new Response(JSON.stringify({ code: 200, msg: "Operation successful", success: true, data }), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
}

async function loginZai(fetchImpl: FetchImpl, code = "auth-code"): Promise<OAuthCredentials> {
	let authUrl = "";
	const callbacks: OAuthController = {
		onAuth: info => {
			authUrl = info.url;
		},
		onManualCodeInput: async () => `${code}#${new URL(authUrl).searchParams.get("state")}`,
		fetch: fetchImpl,
	};
	const credentials = await getProviderDefinition("zai-coding-plan")?.login?.(callbacks);
	if (!credentials || typeof credentials === "string") throw new Error("expected structured credentials");
	return credentials;
}

/**
 * Route a mocked fetch for the full authorize → token → business-login →
 * getCustomerInfo → api_keys → copy walk, matching the live Z.ai API shapes.
 * `existingKeys` seeds the api_keys list to exercise find vs create.
 */
function makeBizFetch(
	options: {
		existingKeys?: Array<Record<string, unknown>>;
		tokenResponse?: Response;
		businessResponse?: Response;
		customerResponse?: Response;
	} = {},
) {
	const requests: RecordedRequest[] = [];
	const existingKeys = options.existingKeys ?? [];
	const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input.toString();
		const method = init?.method ?? "GET";
		const rawBody = init?.body;
		const body = typeof rawBody === "string" && rawBody.length > 0 ? JSON.parse(rawBody) : undefined;
		requests.push({ url, method, body, authorization: new Headers(init?.headers).get("Authorization") });

		if (url === TOKEN_URL) {
			return (
				options.tokenResponse ??
				tokenEnvelope({
					token: "zcode-jwt",
					zai: { access_token: "oauth-access-token" },
					user: { email: "user@example.com", id: "user-42" },
				})
			);
		}
		if (url === BUSINESS_LOGIN_URL) {
			return options.businessResponse ?? bizEnvelope({ access_token: "biz-token", expires_in: 3600 });
		}
		if (url === `${BIZ_BASE}/api/biz/customer/getCustomerInfo`) {
			return (
				options.customerResponse ??
				bizEnvelope({
					organizations: [
						{
							organizationId: "org-1",
							isDefault: true,
							projects: [{ projectId: "proj-1", isDefault: true }],
						},
					],
				})
			);
		}
		if (url === KEYS_URL && method === "GET") {
			return bizEnvelope(existingKeys);
		}
		if (url === KEYS_URL && method === "POST") {
			// Create returns an inline secret; the flow must IGNORE it and copy.
			return bizEnvelope({ name: "oh-my-pi", apiKey: "created-key", secretKey: "inline-ignored" });
		}
		if (url.startsWith(`${KEYS_URL}/copy/`)) {
			const apiKey = decodeURIComponent(url.slice(`${KEYS_URL}/copy/`.length));
			return bizEnvelope({ apiKey, secretKey: "real-secret" });
		}
		throw new Error(`unexpected fetch: ${method} ${url}`);
	});
	return { fetchMock, requests };
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("zai oauth flow", () => {
	it("generates a no-PKCE authorization URL with the ZCode client id", async () => {
		vi.spyOn(Bun, "serve").mockReturnValue({ port: 9999, stop: () => {} } as unknown as Bun.Server<unknown>);
		const controller = new AbortController();
		let url = "";
		const login = getProviderDefinition("zai-coding-plan")?.login;
		if (!login) throw new Error("zai-coding-plan login is unavailable");
		await login({
			signal: controller.signal,
			onAuth: info => {
				url = info.url;
				controller.abort();
			},
		}).catch(() => undefined);
		const authUrl = new URL(url);

		expect(authUrl.origin + authUrl.pathname).toBe(AUTHORIZE_URL);
		expect(authUrl.searchParams.get("client_id")).toBe(CLIENT_ID);
		expect(authUrl.searchParams.get("response_type")).toBe("code");
		expect(authUrl.searchParams.get("redirect_uri")).toBe(REDIRECT_URI);
		expect(authUrl.searchParams.get("state")).not.toBeNull();
		expect(authUrl.searchParams.get("code_challenge")).toBeNull();
		expect(authUrl.searchParams.get("code_challenge_method")).toBeNull();
	});

	it("advertises the ZCode-registered CLI redirect, never a random port (#10245)", async () => {
		const serveSpy = vi
			.spyOn(Bun, "serve")
			.mockReturnValue({ port: 9999, stop: () => {} } as unknown as Bun.Server<unknown>);
		const controller = new AbortController();
		const captured: { redirect: string | null } = { redirect: null };
		const login = getProviderDefinition("zai-coding-plan")?.login;
		if (!login) throw new Error("zai-coding-plan login is unavailable");
		const error = await login({
			signal: controller.signal,
			onAuth: ({ url }) => {
				captured.redirect = new URL(url).searchParams.get("redirect_uri");
				// Stop before waiting on a callback that never arrives in the test.
				controller.abort();
			},
		}).catch((caught: unknown) => caught);

		// Z.AI's allowlist only registers this exact CLI redirect for the reused
		// ZCode client id; anything else is rejected before the login page.
		expect(captured.redirect).toBe(REDIRECT_URI);
		expect(error).toBeInstanceOf(AIError.LoginCancelledError);
		// Bound the IPv4 loopback on the exact registered port — no fallback.
		expect(serveSpy.mock.calls.every(([options]) => options.hostname === "127.0.0.1" && options.port === 9999)).toBe(
			true,
		);
	});

	it("rejects an occupied fixed callback port before opening the browser", async () => {
		const serveSpy = vi.spyOn(Bun, "serve").mockImplementation(() => {
			throw Object.assign(new Error("EADDRINUSE"), { code: "EADDRINUSE" });
		});
		const onAuth = vi.fn();
		const login = getProviderDefinition("zai-coding-plan")?.login;
		if (!login) throw new Error("zai-coding-plan login is unavailable");
		const error = await login({ onAuth }).catch((caught: unknown) => caught);

		expect(error).toBeInstanceOf(AIError.ConfigurationError);
		if (!(error instanceof AIError.ConfigurationError)) throw error;
		expect(error.message).toContain(
			"OAuth callback port 9999 is in use, but oauth.redirectUri (http://127.0.0.1:9999/callback) requires this exact port",
		);
		expect(onAuth).not.toHaveBeenCalled();
		expect(serveSpy.mock.calls.every(([options]) => options.port === 9999)).toBe(true);
	});

	it("exchanges the code, does business-login, then mints an id.secret key (create path)", async () => {
		const { fetchMock, requests } = makeBizFetch();

		const creds = await loginZai(fetchMock as unknown as FetchImpl);

		// Durable minted key: apiKey.secret, with the secret from COPY (not the inline create value).
		expect(creds.access).toBe("created-key.real-secret");
		expect(creds.refresh).toBe("");
		expect(creds.expires).toBe(8.64e15);
		expect(creds.email).toBe("user@example.com");
		expect(creds.accountId).toBe("user-42");

		// Ordered walk: token → business-login → customer → list → create → copy.
		expect(requests.map(r => `${r.method} ${r.url}`)).toEqual([
			`POST ${TOKEN_URL}`,
			`POST ${BUSINESS_LOGIN_URL}`,
			`GET ${BIZ_BASE}/api/biz/customer/getCustomerInfo`,
			`GET ${KEYS_URL}`,
			`POST ${KEYS_URL}`,
			`GET ${KEYS_URL}/copy/created-key`,
		]);

		// Token exchange body is ZCode's non-RFC JSON shape.
		expect(requests[0]?.body).toEqual({
			provider: "zai",
			code: "auth-code",
			redirect_uri: REDIRECT_URI,
			state: expect.any(String),
		});
		// Business login exchanges the OAuth access token for a biz token.
		expect(requests[1]?.body).toEqual({ token: "oauth-access-token" });
		// Every biz call is authorized with the biz token (not the OAuth token).
		for (const bizReq of requests.slice(2)) {
			expect(bizReq.authorization).toBe("Bearer biz-token");
		}
		// Created OMP's own key name, never ZCode's.
		expect(requests[4]?.body).toEqual({ name: "oh-my-pi" });
	});

	it("reuses an existing key and takes the full secret from copy, not the masked list value", async () => {
		const { fetchMock, requests } = makeBizFetch({
			existingKeys: [
				{ name: "zcode-api-key", apiKey: "zcode-key", secretKey: "*****aaaa" },
				{ name: "oh-my-pi", apiKey: "existing-key", secretKey: "*****pz5Y" },
			],
		});

		const creds = await loginZai(fetchMock as unknown as FetchImpl);

		// Must use the copy secret ("real-secret"), NOT the masked list secret ("*****pz5Y").
		expect(creds.access).toBe("existing-key.real-secret");
		expect(requests.some(r => r.method === "POST" && r.url === KEYS_URL)).toBe(false);
		expect(requests.at(-1)).toMatchObject({ method: "GET", url: `${KEYS_URL}/copy/existing-key` });
	});

	it("resolves the default organization and project from the nested customer response", async () => {
		const { fetchMock, requests } = makeBizFetch({
			customerResponse: bizEnvelope({
				organizations: [
					{ organizationId: "org-other", isDefault: false, projects: [{ projectId: "proj-x", isDefault: true }] },
					{
						organizationId: "org-default",
						isDefault: true,
						projects: [
							{ projectId: "proj-a", isDefault: false },
							{ projectId: "proj-default", isDefault: true },
						],
					},
				],
			}),
		});
		// Re-point KEYS_URL routing for the default org/project this test expects.
		const creds = await loginZai(fetchMock as unknown as FetchImpl).catch((e: unknown) => e);

		// The keys URL must target org-default/proj-default (the isDefault entries).
		const customerIdx = requests.findIndex(r => r.url.endsWith("getCustomerInfo"));
		const afterCustomer = requests.slice(customerIdx + 1);
		expect(afterCustomer[0]?.url).toBe(
			`${BIZ_BASE}/api/biz/v1/organization/org-default/projects/proj-default/api_keys`,
		);
		// Flow then errors (that keys URL is unrouted) — proves selection, not a full mint.
		expect(creds).toBeInstanceOf(Error);
	});

	it("throws OAuthError when the token envelope reports a non-zero code", async () => {
		const { fetchMock } = makeBizFetch({
			tokenResponse: new Response(JSON.stringify({ code: 1, msg: "nope" }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}),
		});

		const error = await loginZai(fetchMock as unknown as FetchImpl).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(AIError.OAuthError);
		expect((error as AIError.OAuthError).message).toContain("nope");
	});

	it("throws OAuthError when business login reports success:false", async () => {
		const { fetchMock } = makeBizFetch({
			businessResponse: new Response(
				JSON.stringify({ code: 401, success: false, msg: "Authorization Token illegal" }),
				{
					status: 200,
					headers: { "Content-Type": "application/json" },
				},
			),
		});

		const error = await loginZai(fetchMock as unknown as FetchImpl).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(AIError.OAuthError);
		expect((error as AIError.OAuthError).message).toContain("business login failed");
	});

	it("throws OAuthError when the token response omits the access token", async () => {
		const { fetchMock } = makeBizFetch({ tokenResponse: tokenEnvelope({ token: "zcode-jwt", user: {} }) });

		const error = await loginZai(fetchMock as unknown as FetchImpl).catch((e: unknown) => e);
		expect(error).toBeInstanceOf(AIError.OAuthError);
		expect((error as AIError.OAuthError).message).toContain("missing access token");
	});
});
