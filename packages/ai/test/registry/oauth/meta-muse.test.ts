import { describe, expect, test } from "bun:test";
import * as AIError from "../../../src/error";
import { loginMetaMuse, mintMuseCodeApiKey, refreshMetaMuseToken } from "../../../src/registry/oauth/meta-muse";
import type { FetchImpl } from "../../../src/types";

interface RecordedRequest {
	url: string;
	init: RequestInit | undefined;
}

function response(body: unknown, status: number = 200): Response {
	return Response.json(body, { status });
}

function requestForm(request: RecordedRequest): URLSearchParams {
	return new URLSearchParams(String(request.init?.body));
}

describe("Muse Code OAuth", () => {
	test("exchanges Meta device authorization for a subscription Model API key", async () => {
		const requests: RecordedRequest[] = [];
		const fetchImpl: FetchImpl = (input, init) => {
			const request = { url: String(input), init };
			requests.push(request);
			if (request.url.endsWith("/oidc/device/authorization/")) {
				return Promise.resolve(
					response({
						device_code: "device-token",
						user_code: "ABCD-EFGH",
						verification_uri: "https://auth.meta.com/oauth/device/",
						verification_uri_complete: "https://auth.meta.com/oauth/device/?code=ABCD-EFGH",
						expires_in: 600,
					}),
				);
			}
			if (request.url.endsWith("/oidc/device/token/")) {
				return Promise.resolve(
					response({ access_token: "oauth-access", refresh_token: "oauth-refresh", expires_in: 3600 }),
				);
			}
			return Promise.resolve(
				response({ api_key: "LLM|subscription-key", user_email: "Muse@Example.com", is_subs_active: true }),
			);
		};
		let authUrl = "";
		let instructions = "";

		const credentials = await loginMetaMuse({
			fetch: fetchImpl,
			onAuth: info => {
				authUrl = info.url;
				instructions = info.instructions ?? "";
			},
		});

		expect(authUrl).toBe("https://auth.meta.com/oauth/device/?code=ABCD-EFGH");
		expect(instructions).toContain("ABCD-EFGH");
		expect(credentials.access).toBe("oauth-access");
		expect(credentials.refresh).toBe("oauth-refresh");
		expect(credentials.apiKey).toBe("LLM|subscription-key");
		expect(credentials.email).toBe("muse@example.com");
		expect(credentials.expires).toBeGreaterThan(Date.now());

		expect(requestForm(requests[0]!).get("client_id")).toBe("1031625952748946");
		const tokenForm = requestForm(requests[1]!);
		expect(tokenForm.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:device_code");
		expect(tokenForm.get("device_code")).toBe("device-token");
		expect(new Headers(requests[2]!.init?.headers).get("Authorization")).toBe("Bearer oauth-access");
		expect(new Headers(requests[2]!.init?.headers).get("x-api-version")).toBe("1.0.0");
	});

	test("classifies malformed verification URLs as OAuth validation failures", async () => {
		const fetchImpl: FetchImpl = () =>
			Promise.resolve(
				response({
					device_code: "device-token",
					user_code: "ABCD-EFGH",
					verification_uri: "not a URL",
					expires_in: 600,
				}),
			);

		await expect(loginMetaMuse({ fetch: fetchImpl })).rejects.toMatchObject({
			name: "OAuthError",
			kind: "validation",
			provider: "meta",
		});
	});

	test("rejects key exchanges without a stable account identity", async () => {
		const fetchImpl: FetchImpl = () => Promise.resolve(response({ api_key: "LLM|identityless-key" }));

		await expect(mintMuseCodeApiKey("oauth-access", fetchImpl)).rejects.toThrow("missing a stable account identity");
	});

	test("rejects inactive subscriptions during key exchange", async () => {
		const fetchImpl: FetchImpl = () =>
			Promise.resolve(
				response({
					api_key: "LLM|inactive-key",
					user_id: "meta-account",
					is_subs_active: false,
				}),
			);

		await expect(mintMuseCodeApiKey("oauth-access", fetchImpl)).rejects.toThrow("subscription is inactive");
	});

	test("refreshes the Meta grant and replaces the subscription API key", async () => {
		const requests: RecordedRequest[] = [];
		const fetchImpl: FetchImpl = (input, init) => {
			const request = { url: String(input), init };
			requests.push(request);
			if (request.url.endsWith("/oidc/device/token/")) {
				return Promise.resolve(response({ access_token: "new-oauth-access", expires_in: 60 }));
			}
			return Promise.resolve(response({ api_key: "LLM|new-subscription-key" }));
		};

		const beforeRefresh = Date.now();
		const refreshed = await refreshMetaMuseToken(
			{
				access: "old-access",
				refresh: "durable-refresh",
				expires: 0,
				apiKey: "LLM|old-key",
				accountId: "meta-account",
			},
			fetchImpl,
		);

		expect(refreshed.access).toBe("new-oauth-access");
		expect(refreshed.refresh).toBe("durable-refresh");
		expect(refreshed.apiKey).toBe("LLM|new-subscription-key");
		expect(refreshed.accountId).toBe("meta-account");
		expect(refreshed.expires).toBeGreaterThanOrEqual(beforeRefresh + 60_000);
		expect(refreshed.expires).toBeLessThanOrEqual(Date.now() + 60_000);
		const refreshForm = requestForm(requests[0]!);
		expect(refreshForm.get("grant_type")).toBe("refresh_token");
		expect(refreshForm.get("refresh_token")).toBe("durable-refresh");
		expect(new Headers(requests[1]!.init?.headers).get("Authorization")).toBe("Bearer new-oauth-access");
	});

	test("preserves a rotated refresh grant when Muse key minting fails transiently", async () => {
		let calls = 0;
		const fetchImpl: FetchImpl = () => {
			calls++;
			if (calls === 1) {
				return Promise.resolve(
					response({
						access_token: "rotated-oauth-access",
						refresh_token: "rotated-refresh",
						expires_in: 7200,
					}),
				);
			}
			return Promise.resolve(response({ error: "temporarily_unavailable" }, 503));
		};

		const refreshed = await refreshMetaMuseToken(
			{
				access: "expired-access",
				refresh: "old-refresh",
				expires: 0,
				apiKey: "LLM|still-valid-key",
				accountId: "meta-account",
			},
			fetchImpl,
		);

		expect(refreshed.access).toBe("rotated-oauth-access");
		expect(refreshed.refresh).toBe("rotated-refresh");
		expect(refreshed.apiKey).toBe("LLM|still-valid-key");
		expect(refreshed.accountId).toBe("meta-account");
		expect(calls).toBe(2);
	});

	test("preserves a rotated grant when Muse key minting is transiently forbidden", async () => {
		let calls = 0;
		const fetchImpl: FetchImpl = () => {
			calls++;
			if (calls === 1) {
				return Promise.resolve(
					response({
						access_token: "rotated-oauth-access",
						refresh_token: "rotated-refresh",
						expires_in: 60,
					}),
				);
			}
			return Promise.resolve(response({ error: "Cloudflare captcha temporarily unavailable" }, 403));
		};

		const refreshed = await refreshMetaMuseToken(
			{
				access: "expired-access",
				refresh: "old-refresh",
				expires: 0,
				apiKey: "LLM|still-valid-key",
				accountId: "meta-account",
			},
			fetchImpl,
		);

		expect(refreshed.access).toBe("rotated-oauth-access");
		expect(refreshed.refresh).toBe("rotated-refresh");
		expect(refreshed.apiKey).toBe("LLM|still-valid-key");
		expect(refreshed.expires).toBeGreaterThan(Date.now());
		expect(calls).toBe(2);
	});

	test("surfaces revoked refresh grants as definitive OAuth failures", async () => {
		const fetchImpl: FetchImpl = () =>
			Promise.resolve(
				response(
					{
						error: "invalid_grant",
						error_description: "The refresh token was revoked",
					},
					400,
				),
			);

		await expect(
			refreshMetaMuseToken(
				{ access: "expired-access", refresh: "revoked-refresh", expires: 0, apiKey: "LLM|old-key" },
				fetchImpl,
			),
		).rejects.toThrow("invalid_grant: The refresh token was revoked");
	});

	test("preserves an unauthorized status when the token endpoint returns non-JSON", async () => {
		const fetchImpl: FetchImpl = () =>
			Promise.resolve(
				new Response("<html>Unauthorized</html>", {
					status: 401,
					headers: { "content-type": "text/html" },
				}),
			);

		await expect(
			refreshMetaMuseToken(
				{ access: "expired-access", refresh: "revoked-refresh", expires: 0, apiKey: "LLM|old-key" },
				fetchImpl,
			),
		).rejects.toMatchObject({
			kind: "validation",
			provider: "meta",
			status: 401,
		});
	});

	test("keeps transient markers from non-JSON forbidden responses", async () => {
		const fetchImpl: FetchImpl = () =>
			Promise.resolve(
				new Response(`<html>Cloudflare captcha forbidden ${"x".repeat(10_000)} tail-marker</html>`, {
					status: 403,
					headers: { "content-type": "text/html" },
				}),
			);

		const error = await refreshMetaMuseToken(
			{ access: "expired-access", refresh: "durable-refresh", expires: 0, apiKey: "LLM|old-key" },
			fetchImpl,
		).catch(error => error);

		if (!(error instanceof Error)) throw error;
		expect(error.message).toContain("Cloudflare captcha forbidden");
		expect(error.message.length).toBeLessThan(600);
		expect(error.message).not.toContain("tail-marker");
		expect(AIError.isDefinitiveOAuthFailure(error)).toBe(false);
	});

	test("preserves a forbidden status when token JSON violates the OAuth schema", async () => {
		const fetchImpl: FetchImpl = () =>
			Promise.resolve(
				response(
					{
						error: { code: "invalid_token", message: "The refresh token was revoked" },
					},
					403,
				),
			);

		await expect(
			refreshMetaMuseToken(
				{ access: "expired-access", refresh: "revoked-refresh", expires: 0, apiKey: "LLM|old-key" },
				fetchImpl,
			),
		).rejects.toMatchObject({
			kind: "validation",
			provider: "meta",
			status: 403,
		});
	});

	test("bounds malformed token response details", async () => {
		const fetchImpl: FetchImpl = () =>
			Promise.resolve(
				response(
					{
						error: { code: "invalid_token", message: `revoked-${"x".repeat(10_000)}-tail-marker` },
					},
					403,
				),
			);

		const error = await refreshMetaMuseToken(
			{ access: "expired-access", refresh: "revoked-refresh", expires: 0, apiKey: "LLM|old-key" },
			fetchImpl,
		).catch(error => error);

		if (!(error instanceof Error)) throw error;
		expect(error.message.length).toBeLessThan(600);
		expect(error.message).not.toContain("tail-marker");
	});
});
