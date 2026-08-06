import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it, vi } from "bun:test";
import { AuthStorage, SqliteAuthCredentialStore } from "@pk-nerdsaver-ai/pi-ai/auth-storage";
import { loginCline, refreshClineToken } from "@pk-nerdsaver-ai/pi-ai/registry/cline";
import { getOAuthApiKey } from "@pk-nerdsaver-ai/pi-ai/registry/oauth";
import type { FetchImpl } from "@pk-nerdsaver-ai/pi-ai/types";

const DEVICE_URL = "https://api.workos.com/user_management/authorize/device";
const AUTH_URL = "https://api.workos.com/user_management/authenticate";
const REGISTER_URL = "https://api.cline.bot/api/v1/auth/register";
const REFRESH_URL = "https://api.cline.bot/api/v1/auth/refresh";

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

const REGISTER_OK = {
	success: true,
	data: {
		accessToken: "cline-access",
		refreshToken: "cline-refresh",
		tokenType: "Bearer",
		expiresAt: "2099-01-01T00:00:00.000Z",
		userInfo: { email: "dev@example.com", clineUserId: "user-123" },
	},
};

const DEVICE_OK = {
	device_code: "dev-code",
	user_code: "WXYZ-1234",
	verification_uri: "https://cline.bot/device",
	verification_uri_complete: "https://cline.bot/device?code=WXYZ-1234",
	expires_in: 300,
	interval: 5,
};

describe("cline oauth login", () => {
	afterEach(() => vi.restoreAllMocks());

	it("completes the WorkOS device flow and registers Cline credentials", async () => {
		const onAuth = vi.fn();
		const calls: string[] = [];
		const fetchMock: FetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			const url = input.toString();
			calls.push(url);
			if (url === DEVICE_URL) {
				expect(init?.method).toBe("POST");
				return json(DEVICE_OK);
			}
			if (url === AUTH_URL) {
				return json({ access_token: "wos-access", refresh_token: "wos-refresh", token_type: "Bearer" });
			}
			if (url === REGISTER_URL) {
				expect(JSON.parse(String(init?.body))).toEqual({ accessToken: "wos-access", refreshToken: "wos-refresh" });
				return json(REGISTER_OK);
			}
			throw new Error(`unexpected url ${url}`);
		});

		const creds = await loginCline({ onAuth, fetch: fetchMock });

		// The device-code URL (with code embedded) and user code are surfaced to the user.
		expect(onAuth).toHaveBeenCalledWith({
			url: "https://cline.bot/device?code=WXYZ-1234",
			instructions: "Enter this code in your browser: WXYZ-1234",
		});
		expect(creds.access).toBe("cline-access");
		expect(creds.refresh).toBe("cline-refresh");
		expect(creds.email).toBe("dev@example.com");
		expect(creds.accountId).toBe("user-123");
		expect(creds.expires).toBe(Date.parse("2099-01-01T00:00:00.000Z"));
		// Device authorize → WorkOS authenticate → Cline register, in order.
		expect(calls).toEqual([DEVICE_URL, AUTH_URL, REGISTER_URL]);
	});

	it("dispatches ClinePass login and stores its refreshable credential separately", async () => {
		const store = new SqliteAuthCredentialStore(new Database(":memory:"));
		const authStorage = new AuthStorage(store);
		try {
			await authStorage.reload();
			const fetchMock: FetchImpl = vi.fn(async (input: string | URL | Request) => {
				const url = input.toString();
				if (url === DEVICE_URL) return json(DEVICE_OK);
				if (url === AUTH_URL) {
					return json({ access_token: "wos-access", refresh_token: "wos-refresh", token_type: "Bearer" });
				}
				if (url === REGISTER_URL) return json(REGISTER_OK);
				throw new Error(`unexpected url ${url}`);
			});

			await authStorage.login("cline-pass", {
				onAuth: vi.fn(),
				onPrompt: async () => "",
				fetch: fetchMock,
			});

			const stored = store.listAuthCredentials("cline-pass");
			expect(stored).toHaveLength(1);
			expect(stored[0]?.credential).toMatchObject({
				type: "oauth",
				access: "cline-access",
				refresh: "cline-refresh",
				accountId: "user-123",
			});
			expect(store.listAuthCredentials("cline")).toEqual([]);
			expect(await authStorage.getApiKey("cline-pass", "cline-pass-test")).toBe("workos:cline-access");
		} finally {
			store.close();
		}
	});

	it("formats ClinePass OAuth access for the inference gateway exactly once", async () => {
		const credentials = { access: "cline-access", refresh: "cline-refresh", expires: Date.now() + 60_000 };
		const raw = await getOAuthApiKey("cline-pass", { "cline-pass": credentials });
		const prefixed = await getOAuthApiKey("cline-pass", {
			"cline-pass": { ...credentials, access: "workos:cline-access" },
		});
		const canonical = await getOAuthApiKey("cline", { cline: credentials });
		expect(raw?.apiKey).toBe("workos:cline-access");
		expect(prefixed?.apiKey).toBe("workos:cline-access");
		expect(canonical?.apiKey).toBe("cline-access");
	});

	it("keeps polling past authorization_pending before registering", async () => {
		vi.spyOn(Bun, "sleep").mockResolvedValue(undefined);
		let authCalls = 0;
		const fetchMock: FetchImpl = vi.fn(async (input: string | URL | Request) => {
			const url = input.toString();
			if (url === DEVICE_URL) return json(DEVICE_OK);
			if (url === AUTH_URL) {
				authCalls += 1;
				if (authCalls === 1) return json({ error: "authorization_pending" }, 400);
				return json({ access_token: "wos-access", refresh_token: "wos-refresh", token_type: "Bearer" });
			}
			if (url === REGISTER_URL) return json(REGISTER_OK);
			throw new Error(`unexpected url ${url}`);
		});

		const creds = await loginCline({ onAuth: vi.fn(), fetch: fetchMock });
		expect(authCalls).toBe(2);
		expect(creds.access).toBe("cline-access");
	});

	it("throws when authorization is denied", async () => {
		const fetchMock: FetchImpl = vi.fn(async (input: string | URL | Request) => {
			const url = input.toString();
			if (url === DEVICE_URL) return json(DEVICE_OK);
			if (url === AUTH_URL) return json({ error: "access_denied" }, 400);
			throw new Error(`unexpected url ${url}`);
		});

		await expect(loginCline({ onAuth: vi.fn(), fetch: fetchMock })).rejects.toThrow("Authorization was denied");
	});

	it("aborts the poll loop when the signal is already aborted", async () => {
		const fetchMock: FetchImpl = vi.fn(async (input: string | URL | Request) => {
			const url = input.toString();
			if (url === DEVICE_URL) return json(DEVICE_OK);
			throw new Error(`unexpected url ${url}`);
		});

		await expect(loginCline({ onAuth: vi.fn(), fetch: fetchMock, signal: AbortSignal.abort() })).rejects.toThrow(
			"Login cancelled",
		);
	});

	it("refreshes Cline credentials via the refresh endpoint and rotates the refresh token", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation((async (
			input: string | URL | Request,
			init?: RequestInit,
		) => {
			expect(input.toString()).toBe(REFRESH_URL);
			expect(JSON.parse(String(init?.body))).toEqual({ refreshToken: "old-refresh", grantType: "refresh_token" });
			return json({
				success: true,
				data: {
					accessToken: "new-access",
					refreshToken: "new-refresh",
					tokenType: "Bearer",
					expiresAt: "2099-06-01T00:00:00.000Z",
					userInfo: { email: "dev@example.com", clineUserId: "user-123" },
				},
			});
		}) as unknown as typeof fetch);

		const refreshed = await refreshClineToken({ access: "old-access", refresh: "old-refresh", expires: 0 });

		expect(refreshed.access).toBe("new-access");
		expect(refreshed.refresh).toBe("new-refresh");
		expect(refreshed.expires).toBe(Date.parse("2099-06-01T00:00:00.000Z"));
		expect(fetchSpy).toHaveBeenCalledTimes(1);
	});
});
