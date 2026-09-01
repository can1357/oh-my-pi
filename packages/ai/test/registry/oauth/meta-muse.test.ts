import { describe, expect, test } from "bun:test";
import { loginMetaMuse, refreshMetaMuseToken } from "../../../src/registry/oauth/meta-muse";
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

	test("refreshes the Meta grant and replaces the subscription API key", async () => {
		const requests: RecordedRequest[] = [];
		const fetchImpl: FetchImpl = (input, init) => {
			const request = { url: String(input), init };
			requests.push(request);
			if (request.url.endsWith("/oidc/device/token/")) {
				return Promise.resolve(response({ access_token: "new-oauth-access", expires_in: 7200 }));
			}
			return Promise.resolve(response({ api_key: "LLM|new-subscription-key" }));
		};

		const refreshed = await refreshMetaMuseToken(
			{ access: "old-access", refresh: "durable-refresh", expires: 0, apiKey: "LLM|old-key" },
			fetchImpl,
		);

		expect(refreshed.access).toBe("new-oauth-access");
		expect(refreshed.refresh).toBe("durable-refresh");
		expect(refreshed.apiKey).toBe("LLM|new-subscription-key");
		const refreshForm = requestForm(requests[0]!);
		expect(refreshForm.get("grant_type")).toBe("refresh_token");
		expect(refreshForm.get("refresh_token")).toBe("durable-refresh");
		expect(new Headers(requests[1]!.init?.headers).get("Authorization")).toBe("Bearer new-oauth-access");
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
});
