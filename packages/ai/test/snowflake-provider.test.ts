import { describe, expect, spyOn, test } from "bun:test";
import { AuthStorage } from "@oh-my-pi/pi-ai/auth-storage";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { getProviderDefinition } from "@oh-my-pi/pi-ai/registry";
import { getOAuthApiKey } from "@oh-my-pi/pi-ai/registry/oauth";
import { loginSnowflake, refreshSnowflakeToken } from "@oh-my-pi/pi-ai/registry/oauth/snowflake";
import type { OAuthController, OAuthCredentials } from "@oh-my-pi/pi-ai/registry/oauth/types";
import { normalizeSnowflakeAccountUrl } from "@oh-my-pi/pi-ai/registry/snowflake";
import { stream } from "@oh-my-pi/pi-ai/stream";
import type { Context, FetchImpl } from "@oh-my-pi/pi-ai/types";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { withEnv } from "./helpers";

const ACCOUNT = "https://myorg-acct.snowflakecomputing.com";
const CLAUDE = getBundledModel<"anthropic-messages">("snowflake", "claude-sonnet-4-6");
const OPENAI = getBundledModel<"openai-completions">("snowflake", "openai-gpt-5.1");
const CONTEXT: Context = {
	systemPrompt: ["Answer concisely."],
	messages: [{ role: "user", content: "Say hello", timestamp: 0 }],
};
const CREDENTIAL: OAuthCredentials = {
	access: "old-access",
	refresh: "old-refresh",
	expires: 0,
	enterpriseUrl: ACCOUNT,
};

interface CapturedRequest {
	url?: string;
	headers?: Headers;
	body?: string;
	redirect?: RequestInit["redirect"];
}

function captureRequest(captured: CapturedRequest, response?: () => Response): typeof fetch {
	return Object.assign(
		async (input: string | URL | Request, init?: RequestInit) => {
			captured.url = String(input instanceof Request ? input.url : input);
			captured.headers = new Headers(input instanceof Request ? input.headers : init?.headers);
			captured.body = typeof init?.body === "string" ? init.body : init?.body?.toString();
			captured.redirect = init?.redirect;
			return response?.() ?? Response.json({ error: { message: "captured" } }, { status: 400 });
		},
		{ preconnect: fetch.preconnect },
	);
}

function manualLoginController(fetchImpl: FetchImpl, onAuth?: OAuthController["onAuth"]): OAuthController {
	let authorize: URL;
	return {
		onPrompt: async () => "myorg-acct",
		onAuth: info => {
			authorize = new URL(info.url);
			onAuth?.(info);
		},
		onManualCodeInput: async () => {
			const callback = new URL(authorize.searchParams.get("redirect_uri")!);
			callback.searchParams.set("code", "abc");
			callback.searchParams.set("state", authorize.searchParams.get("state")!);
			return callback.href;
		},
		fetch: fetchImpl,
		signal: AbortSignal.timeout(5_000),
	};
}

describe("Snowflake Cortex requests", () => {
	test("structured OAuth selects its account over env and sends bare Bearer on Messages", async () => {
		await withEnv({ SNOWFLAKE_ACCOUNT: "different-account" }, async () => {
			const captured: CapturedRequest = {};
			const key = await getOAuthApiKey("snowflake", {
				snowflake: { ...CREDENTIAL, access: "tok", expires: Date.now() + 60_000 },
			});
			await stream(CLAUDE, CONTEXT, {
				apiKey: key!.apiKey,
				fetch: captureRequest(captured),
				maxTokens: 16,
			}).result();
			expect(captured.url).toBe(`${ACCOUNT}/api/v2/cortex/v1/messages`);
			expect(captured.headers?.get("authorization")).toBe("Bearer tok");
			expect(captured.headers?.get("x-api-key")).toBeNull();
		});
	});

	test("environment PAT resolves the chat endpoint and Cortex-compatible request fields", async () => {
		await withEnv({ SNOWFLAKE_PAT: "pat", SNOWFLAKE_ACCOUNT: "MyOrg-My_Acct" }, async () => {
			const captured: CapturedRequest = {};
			await stream(OPENAI, CONTEXT, { fetch: captureRequest(captured), maxTokens: 2048 }).result();
			expect(captured.url).toBe("https://myorg-my-acct.snowflakecomputing.com/api/v2/cortex/v1/chat/completions");
			expect(captured.headers?.get("authorization")).toBe("Bearer pat");
			const body = JSON.parse(captured.body!);
			expect(body.max_completion_tokens).toBe(2048);
			expect(body).not.toHaveProperty("max_tokens");
			expect(body).not.toHaveProperty("store");
			expect(body.messages[0].role).toBe("system");
		});
	});

	test("missing placeholder account fails before a token can be sent", async () => {
		await withEnv({ SNOWFLAKE_ACCOUNT: undefined }, async () => {
			const captured: CapturedRequest = {};
			expect(() => stream(CLAUDE, CONTEXT, { apiKey: "pat", fetch: captureRequest(captured) })).toThrow(
				"Snowflake account is required",
			);
			expect(captured.url).toBeUndefined();
		});
	});

	test("empty apiKey falls through to the environment PAT and account", async () => {
		await withEnv({ SNOWFLAKE_PAT: "env-pat", SNOWFLAKE_ACCOUNT: "env-acct" }, async () => {
			const captured: CapturedRequest = {};
			await stream(OPENAI, CONTEXT, { apiKey: "", fetch: captureRequest(captured) }).result();
			expect(captured.url).toBe("https://env-acct.snowflakecomputing.com/api/v2/cortex/v1/chat/completions");
			expect(captured.headers?.get("authorization")).toBe("Bearer env-pat");
		});
	});

	test.each([
		["truncated JSON", '{"token":'],
		["empty token", '{"token":" "}'],
		["non-string token", '{"token":123}'],
		["invalid account type", '{"token":"tok","enterpriseUrl":123}'],
		["empty stored account", '{"token":"tok","enterpriseUrl":""}'],
		["untrusted account", '{"token":"tok","enterpriseUrl":"https://evil.test"}'],
		["missing account", '{"token":"tok"}'],
	])("rejects %s credentials before fetch", (_name, apiKey) => {
		const captured: CapturedRequest = {};
		expect(() => stream(CLAUDE, CONTEXT, { apiKey, fetch: captureRequest(captured) })).toThrow(
			"Invalid Snowflake credential",
		);
		expect(captured.url).toBeUndefined();
	});

	test("stored credential keeps the specific account rejection reason", () => {
		const captured: CapturedRequest = {};
		expect(() =>
			stream(CLAUDE, CONTEXT, {
				apiKey: JSON.stringify({ token: "tok", enterpriseUrl: "https://acct.snowflakecomputing.cn" }),
				fetch: captureRequest(captured),
			}),
		).toThrow("not available in China-region accounts");
		expect(captured.url).toBeUndefined();
	});

	test("OAuth cannot send its account token to an explicit different endpoint", () => {
		const captured: CapturedRequest = {};
		expect(() =>
			stream({ ...CLAUDE, baseUrl: "https://other.snowflakecomputing.com/api/v2/cortex" }, CONTEXT, {
				apiKey: JSON.stringify({ token: "tok", enterpriseUrl: ACCOUNT }),
				fetch: captureRequest(captured),
			}),
		).toThrow("Snowflake OAuth account does not match the model endpoint");
		expect(captured.url).toBeUndefined();
	});

	test("raw PAT preserves an explicit custom endpoint without an environment account", async () => {
		await withEnv({ SNOWFLAKE_ACCOUNT: undefined }, async () => {
			const captured: CapturedRequest = {};
			await stream({ ...OPENAI, baseUrl: "https://gateway.example.test/custom/v1" }, CONTEXT, {
				apiKey: "pat",
				fetch: captureRequest(captured),
			}).result();
			expect(captured.url).toBe("https://gateway.example.test/custom/v1/chat/completions");
			expect(captured.headers?.get("authorization")).toBe("Bearer pat");
		});
	});
});

describe("Snowflake account normalization", () => {
	test.each([
		[" MyOrg-My_Acct ", "https://myorg-my-acct.snowflakecomputing.com"],
		["xy12345.us-east-2.aws", "https://xy12345.us-east-2.aws.snowflakecomputing.com"],
		["https://app.snowflake.com/myorg/my_acct/#/home", "https://myorg-my-acct.snowflakecomputing.com"],
		[
			"https://xy12345.us-east-2.privatelink.snowflakecomputing.com/ui?q=1",
			"https://xy12345.us-east-2.privatelink.snowflakecomputing.com",
		],
		["acct.snowflakecomputing.com:443", "https://acct.snowflakecomputing.com"],
	])("normalizes %s to a trusted origin", (input, origin) => {
		expect(normalizeSnowflakeAccountUrl(input)).toBe(origin);
	});

	test.each([
		"http://acct.snowflakecomputing.com",
		"https://evil.test",
		"https://user@acct.snowflakecomputing.com",
		"https://acct.snowflakecomputing.com:8443",
		"https://acct.snowflakecomputing.com.evil.test",
		"bad/value",
		"acct\\name",
		"https://app.snowflake.com/myorg/bad%2Fname",
		"org..account",
		`${"a".repeat(64)}-acct`,
		"https://snowflakecomputing.com",
		"https://app.snowflake.com/org",
		"https://-acct.snowflakecomputing.com",
		"https://app.snowflake.com/us-east-1/xy12345/#/home",
		"acct.snowflakecomputing.com:8443",
		// Cortex REST is not available in China-region accounts.
		"acct.snowflakecomputing.cn",
		"https://acct.snowflakecomputing.cn",
	])("rejects unsafe account %s", input => {
		expect(() => normalizeSnowflakeAccountUrl(input)).toThrow(AIError.ConfigurationError);
	});
});

describe("Snowflake browser OAuth", () => {
	test("registered login binds PKCE, state, loopback redirect and account to a usable credential", async () => {
		const captured: CapturedRequest = {};
		let authorize: URL | undefined;
		const before = Date.now();
		const controller = manualLoginController(
			captureRequest(captured, () => Response.json({ access_token: "a", refresh_token: "r", expires_in: 600 })),
			info => {
				authorize = new URL(info.url);
			},
		);
		const login = getProviderDefinition("snowflake")!.login!;
		const credentials = await login(controller);
		if (typeof credentials === "string") throw new Error("Expected OAuth credentials");
		expect(authorize!.origin).toBe(ACCOUNT);
		expect(authorize!.pathname).toBe("/oauth/authorize");
		expect(authorize!.searchParams.get("client_id")).toBe("LOCAL_APPLICATION");
		expect(authorize!.searchParams.get("scope")).toBe("refresh_token");
		expect(authorize!.searchParams.get("response_type")).toBe("code");
		expect(authorize!.searchParams.get("code_challenge_method")).toBe("S256");
		// Live local-app integrations can reject non-root callback paths.
		expect(authorize!.searchParams.get("redirect_uri")).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
		const form = new URLSearchParams(captured.body);
		expect(captured.url).toBe(`${ACCOUNT}/oauth/token-request`);
		expect(captured.redirect).toBe("error");
		expect(form.get("grant_type")).toBe("authorization_code");
		expect(form.get("code")).toBe("abc");
		expect(form.get("client_id")).toBe("LOCAL_APPLICATION");
		expect(form.has("client_secret")).toBe(false);
		expect(form.get("redirect_uri")).toBe(authorize!.searchParams.get("redirect_uri"));
		expect(Bun.SHA256.hash(form.get("code_verifier")!, "base64url")).toBe(
			authorize!.searchParams.get("code_challenge")!,
		);
		expect(credentials).toMatchObject({ access: "a", refresh: "r", enterpriseUrl: ACCOUNT });
		expect(credentials.expires).toBeGreaterThanOrEqual(before + 600_000);
		expect(credentials.expires).toBeLessThanOrEqual(Date.now() + 600_000);
	});

	test.each(["before-prompt", "after-prompt", "after-auth"])(
		"cancellation %s prevents token exchange",
		async stage => {
			const abort = new AbortController();
			const captured: CapturedRequest = {};
			const ctrl = manualLoginController(captureRequest(captured), () => {
				if (stage === "after-auth") abort.abort();
			});
			ctrl.signal = abort.signal;
			ctrl.onPrompt = async () => {
				if (stage === "after-prompt") abort.abort();
				return "myorg-acct";
			};
			if (stage === "before-prompt") abort.abort();
			await expect(loginSnowflake(ctrl)).rejects.toBeInstanceOf(AIError.LoginCancelledError);
			expect(captured.url).toBeUndefined();
		},
	);

	test("login stores the real token expiry and no refresh grant when none is issued", async () => {
		const before = Date.now();
		const credentials = await loginSnowflake(
			manualLoginController(captureRequest({}, () => Response.json({ access_token: "a", expires_in: 60 }))),
		);
		expect(credentials.refresh).toBe("");
		// The shared auth layer applies refresh skew; a provider-local skew would expire 60s tokens on arrival.
		expect(credentials.expires).toBeGreaterThanOrEqual(before + 60_000);
		expect(credentials.expires).toBeLessThanOrEqual(Date.now() + 60_000);
	});

	test("abort during token exchange rejects as login cancellation", async () => {
		const abort = new AbortController();
		const ctrl = manualLoginController(async (_input, init) => {
			abort.abort(new Error("raw abort reason"));
			init?.signal?.throwIfAborted();
			return Response.json({ access_token: "a", expires_in: 600 });
		});
		ctrl.signal = abort.signal;
		await expect(loginSnowflake(ctrl)).rejects.toBeInstanceOf(AIError.LoginCancelledError);
	});

	test("exchange HTTP errors omit reflected authorization codes and token bodies", async () => {
		const secret = "sentinel-exchange-secret";
		const error = await loginSnowflake(
			manualLoginController(captureRequest({}, () => Response.json({ error_description: secret }, { status: 400 }))),
		).catch((caught: unknown) => caught);
		expect(error).toMatchObject({ kind: "token-exchange", provider: "snowflake", status: 400 });
		expect(String(error)).not.toContain(secret);
	});
});

describe("Snowflake refresh transitions", () => {
	// Accounts may disable refresh issuance; the shared 60 s refresh skew must not
	// discard a token that Snowflake still accepts.
	test.each([
		["inside the refresh skew", 30_000, "still-valid"],
		["after expiry", -1_000, undefined],
	])("a refreshless token %s resolves to %s", async (_name, remainingMs, token) => {
		const storage = await AuthStorage.create(":memory:", { usageProviderResolver: () => undefined });
		await storage.credentials.set("snowflake", {
			type: "oauth",
			access: "still-valid",
			refresh: "",
			expires: Date.now() + remainingMs,
			enterpriseUrl: ACCOUNT,
		});
		const key = await storage.keys.get("snowflake", "session");
		expect(key === undefined ? undefined : JSON.parse(key).token).toBe(token);
	});

	test.each([undefined, "rotated-refresh"])(
		"refresh retains or rotates the grant (%s) with bounded expiry",
		async refreshToken => {
			const captured: CapturedRequest = {};
			const mock = spyOn(globalThis, "fetch").mockImplementation(
				captureRequest(captured, () =>
					Response.json({
						access_token: "new-access",
						expires_in: 60,
						...(refreshToken ? { refresh_token: refreshToken } : {}),
					}),
				),
			);
			try {
				const before = Date.now();
				const refreshed = await refreshSnowflakeToken(CREDENTIAL);
				expect(refreshed).toMatchObject({
					access: "new-access",
					refresh: refreshToken ?? "old-refresh",
					enterpriseUrl: ACCOUNT,
				});
				expect(refreshed.expires).toBeGreaterThanOrEqual(before + 60_000);
				expect(refreshed.expires).toBeLessThanOrEqual(Date.now() + 60_000);
				expect(captured.url).toBe(`${ACCOUNT}/oauth/token-request`);
				expect(captured.redirect).toBe("error");
				const form = new URLSearchParams(captured.body);
				expect(form.get("grant_type")).toBe("refresh_token");
				expect(form.get("refresh_token")).toBe("old-refresh");
				expect(form.get("client_id")).toBe("LOCAL_APPLICATION");
				expect(CREDENTIAL.access).toBe("old-access");
			} finally {
				mock.mockRestore();
			}
		},
	);

	test.each([
		["no refresh", { refresh: "" }, "token-refresh"],
		["missing origin", { enterpriseUrl: undefined }, "validation"],
		["unsafe origin", { enterpriseUrl: "https://evil.test" }, "validation"],
	])("%s rejects before network access", async (_name, patch, kind) => {
		const mock = spyOn(globalThis, "fetch").mockImplementation(captureRequest({}));
		try {
			const error = await refreshSnowflakeToken({ ...CREDENTIAL, ...patch }).catch((caught: unknown) => caught);
			expect(error).toMatchObject({ kind, provider: "snowflake" });
			expect(mock).not.toHaveBeenCalled();
		} finally {
			mock.mockRestore();
		}
	});

	test.each([
		["invalid JSON", "not-json"],
		["null response", "null"],
		["empty access", '{"access_token":"","expires_in":600}'],
		["non-string access", '{"access_token":1,"expires_in":600}'],
		["non-numeric lifetime", '{"access_token":"a","expires_in":"600"}'],
		["non-positive lifetime", '{"access_token":"a","expires_in":0}'],
		["overflow lifetime", '{"access_token":"a","expires_in":1e308}'],
		["invalid refresh", '{"access_token":"a","expires_in":600,"refresh_token":null}'],
	])("%s does not replace persisted credentials", async (_name, body) => {
		const mock = spyOn(globalThis, "fetch").mockImplementation(captureRequest({}, () => new Response(body)));
		try {
			const previous = { ...CREDENTIAL };
			const error = await refreshSnowflakeToken(CREDENTIAL).catch((caught: unknown) => caught);
			expect(error).toMatchObject({ kind: "validation", provider: "snowflake" });
			expect(CREDENTIAL).toEqual(previous);
		} finally {
			mock.mockRestore();
		}
	});

	test("invalid_grant exposes status and refresh kind but no server-reflected secret", async () => {
		const secret = "sentinel-refresh-secret";
		const mock = spyOn(globalThis, "fetch").mockImplementation(
			captureRequest({}, () =>
				Response.json(
					{
						error: "invalid_grant",
						error_description: secret,
					},
					{ status: 400 },
				),
			),
		);
		try {
			const error = await refreshSnowflakeToken(CREDENTIAL).catch((caught: unknown) => caught);
			expect(error).toBeInstanceOf(AIError.OAuthError);
			expect(error).toMatchObject({ kind: "token-refresh", status: 400, provider: "snowflake" });
			expect(String(error)).not.toContain(secret);
			expect(JSON.stringify(error)).not.toContain(secret);
		} finally {
			mock.mockRestore();
		}
	});

	test("aborted refresh forwards cancellation and leaves the old credential intact", async () => {
		const signal = AbortSignal.abort(new Error("refresh cancelled"));
		let received: AbortSignal | null | undefined;
		const mock = spyOn(globalThis, "fetch").mockImplementation(
			Object.assign(
				async (_input: string | URL | Request, init?: RequestInit) => {
					received = init?.signal;
					init?.signal?.throwIfAborted();
					return Response.json({ access_token: "must-not-replace", expires_in: 600 });
				},
				{ preconnect: fetch.preconnect },
			),
		);
		try {
			const previous = { ...CREDENTIAL };
			await expect(refreshSnowflakeToken(CREDENTIAL, signal)).rejects.toThrow("refresh cancelled");
			expect(received).toBe(signal);
			expect(CREDENTIAL).toEqual(previous);
		} finally {
			mock.mockRestore();
		}
	});
});
