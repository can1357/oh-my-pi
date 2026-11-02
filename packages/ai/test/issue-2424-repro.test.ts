/**
 * Regression: `/login gitlab-duo` fails with "The redirect URI included is not
 * valid" because the bundled OAuth `client_id` no longer matches a registered
 * redirect URI on the GitLab OAuth app.
 *
 * Contract verified here: `GITLAB_CLIENT_ID` and `GITLAB_REDIRECT_URI`
 * environment variables override the bundled values both in the authorize URL
 * we send the browser and in the token-exchange / refresh POSTs we send to
 * `/oauth/token`. When the overrides are absent, the bundled defaults remain
 * in effect.
 *
 * @see https://github.com/can1357/oh-my-pi/issues/2424
 */
import { afterEach, beforeEach, describe, expect, it, spyOn, vi } from "bun:test";
import { getProviderDefinition } from "@oh-my-pi/pi-ai/registry";
import type { OAuthCredentials, OAuthLoginCallbacks } from "@oh-my-pi/pi-ai/registry/oauth/types";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";

const BUNDLED_CLIENT_ID = "da4edff2e6ebd2bc3208611e2768bc1c1dd7be791dc5ff26ca34ca9ee44f7d4b";
const provider = getProviderDefinition("gitlab-duo");
const login = (callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials | string> => {
	if (!provider?.login) throw new Error("gitlab-duo login is unavailable");
	return provider.login(callbacks);
};
const refresh = (credentials: OAuthCredentials): Promise<OAuthCredentials> => {
	if (!provider?.refreshToken) throw new Error("gitlab-duo refresh is unavailable");
	return provider.refreshToken(credentials);
};

function tokenResponse(): Response {
	return new Response(
		JSON.stringify({
			access_token: "access-token",
			refresh_token: "refresh-token",
			expires_in: 7200,
			created_at: 1_700_000_000,
		}),
		{ status: 200, headers: { "Content-Type": "application/json" } },
	);
}

describe("gitlab-duo OAuth env overrides (issue #2424)", () => {
	let originalClientId: string | undefined;
	let originalRedirectUri: string | undefined;

	beforeEach(() => {
		originalClientId = process.env.GITLAB_CLIENT_ID;
		originalRedirectUri = process.env.GITLAB_REDIRECT_URI;
		delete process.env.GITLAB_CLIENT_ID;
		delete process.env.GITLAB_REDIRECT_URI;
	});

	afterEach(() => {
		if (originalClientId === undefined) delete process.env.GITLAB_CLIENT_ID;
		else process.env.GITLAB_CLIENT_ID = originalClientId;
		if (originalRedirectUri === undefined) delete process.env.GITLAB_REDIRECT_URI;
		else process.env.GITLAB_REDIRECT_URI = originalRedirectUri;
		vi.restoreAllMocks();
	});

	it("threads GITLAB_CLIENT_ID and GITLAB_REDIRECT_URI through the authorize URL and token exchange", async () => {
		// Use a high random local port so this test never collides with another
		// process holding 8080. The local server still binds, but the manual
		// code input below wins the race so no HTTP callback is ever received.
		process.env.GITLAB_CLIENT_ID = "custom-client-abc";
		process.env.GITLAB_REDIRECT_URI = "http://127.0.0.1:0/oauth-cb";

		const tokenBodies: URLSearchParams[] = [];
		const fetchMock: FetchImpl = vi.fn(async (_input, init) => {
			tokenBodies.push(new URLSearchParams((init?.body as string) ?? ""));
			return tokenResponse();
		});

		let capturedAuthUrl = "";
		const credentials = await login({
			onAuth: info => {
				capturedAuthUrl = info.url;
			},
			onManualCodeInput: async () => "auth-code-xyz",
			onPrompt: async () => "",
			signal: AbortSignal.timeout(5_000),
			fetch: fetchMock,
		});

		const params = new URL(capturedAuthUrl).searchParams;
		expect(params.get("client_id")).toBe("custom-client-abc");
		expect(params.get("redirect_uri")).toBe("http://127.0.0.1:0/oauth-cb");

		expect(tokenBodies).toHaveLength(1);
		expect(tokenBodies[0].get("client_id")).toBe("custom-client-abc");
		expect(tokenBodies[0].get("redirect_uri")).toBe("http://127.0.0.1:0/oauth-cb");
		expect(tokenBodies[0].get("code")).toBe("auth-code-xyz");
		expect(tokenBodies[0].get("grant_type")).toBe("authorization_code");
		if (typeof credentials === "string") throw new Error("expected structured credentials");
		expect(credentials.access).toBe("access-token");
	});

	it("falls back to the bundled defaults when no overrides are set", async () => {
		const fetchMock: FetchImpl = vi.fn(async () => tokenResponse());

		let capturedAuthUrl = "";
		await login({
			onAuth: info => {
				capturedAuthUrl = info.url;
			},
			onManualCodeInput: async () => "c",
			onPrompt: async () => "",
			signal: AbortSignal.timeout(5_000),
			fetch: fetchMock,
		});

		const params = new URL(capturedAuthUrl).searchParams;
		expect(params.get("client_id")).toBe(BUNDLED_CLIENT_ID);
		// The default redirect URI is the localhost callback. Match the path
		// pattern rather than the exact port: if 8080 is busy on the test
		// machine, callback-server.ts silently falls back to a random port
		// (which itself is the broader brokenness the env-var overrides exist
		// to work around — strict OAuth providers like GitLab reject the
		// random-port URI). The `localhost:.../callback` shape is what we
		// guarantee here.
		const redirectUri = params.get("redirect_uri") ?? "";
		expect(redirectUri).toMatch(/^http:\/\/localhost:\d+\/callback$/);
	});

	it("rejects an unparseable GITLAB_REDIRECT_URI without leaking the bundled client id", async () => {
		process.env.GITLAB_REDIRECT_URI = "not a uri";
		await expect(
			login({
				onAuth: () => {},
				onManualCodeInput: async () => "x",
				onPrompt: async () => "",
				signal: AbortSignal.timeout(1_000),
			}),
		).rejects.toThrow(/Invalid redirect URI override/);
	});

	it("rejects HTTPS loopback GITLAB_REDIRECT_URI before opening browser auth", async () => {
		process.env.GITLAB_REDIRECT_URI = "https://localhost:8443/callback";
		const onAuth = vi.fn();

		await expect(
			login({
				onAuth,
				onManualCodeInput: async () => "x",
				onPrompt: async () => "",
				signal: AbortSignal.timeout(1_000),
			}),
		).rejects.toThrow(/Loopback redirect URI overrides must use http:\/\//);

		expect(onAuth).not.toHaveBeenCalled();
	});

	it("threads GITLAB_CLIENT_ID through the refresh request", async () => {
		process.env.GITLAB_CLIENT_ID = "rotation-client";

		const refreshBodies: URLSearchParams[] = [];
		const fetchSpy = spyOn(globalThis, "fetch").mockImplementation((async (_input, init) => {
			refreshBodies.push(new URLSearchParams((init?.body as string) ?? ""));
			return tokenResponse();
		}) as typeof globalThis.fetch);

		try {
			await refresh({
				access: "old-access",
				refresh: "old-refresh",
				expires: Date.now() + 60_000,
			});
		} finally {
			fetchSpy.mockRestore();
		}

		expect(refreshBodies).toHaveLength(1);
		expect(refreshBodies[0].get("client_id")).toBe("rotation-client");
		expect(refreshBodies[0].get("grant_type")).toBe("refresh_token");
		expect(refreshBodies[0].get("refresh_token")).toBe("old-refresh");
	});
});
