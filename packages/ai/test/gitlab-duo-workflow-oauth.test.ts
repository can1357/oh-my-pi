import { afterEach, describe, expect, it, vi } from "bun:test";
import { getProviderDefinition } from "@oh-my-pi/pi-ai/registry";
import type { OAuthController } from "@oh-my-pi/pi-ai/registry/oauth/types";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";

const CLIENT_ID = "36f2a70cddeb5a0889d4fd8295c241b7e9848e89cf9e599d0eed2d8e5350fbf5";
const REDIRECT_URI = "vscode://gitlab.gitlab-workflow/authentication";

function makeTokenResponse(payload?: Record<string, unknown>): Response {
	return new Response(
		JSON.stringify({
			access_token: "access-token",
			refresh_token: "refresh-token",
			expires_in: 7200,
			created_at: 1000,
			...payload,
		}),
		{ status: 200, headers: { "Content-Type": "application/json" } },
	);
}

afterEach(() => vi.restoreAllMocks());

describe("gitlab duo workflow OAuth", () => {
	it("uses the official VS Code OAuth app and accepts pasted vscode callback URLs", async () => {
		let authUrl = "";
		let instructions = "";
		let body = "";
		const fetchMock: FetchImpl = vi.fn(async (_input, init) => {
			body = String(init?.body ?? "");
			return makeTokenResponse();
		});
		const callbacks: OAuthController = {
			onAuth: info => {
				authUrl = info.url;
				instructions = info.instructions ?? "";
			},
			onManualCodeInput: async () => {
				const state = new URL(authUrl).searchParams.get("state");
				return `${REDIRECT_URI}?code=oauth-code&state=${state}`;
			},
			fetch: fetchMock,
		};

		const credentials = await getProviderDefinition("gitlab-duo-agent")?.login?.(callbacks);
		if (!credentials || typeof credentials === "string") throw new Error("expected structured credentials");

		const authorize = new URL(authUrl);
		expect(authorize.toString()).toStartWith("https://gitlab.com/oauth/authorize?");
		expect(authorize.searchParams.get("client_id")).toBe(CLIENT_ID);
		expect(authorize.searchParams.get("redirect_uri")).toBe(REDIRECT_URI);
		expect(authorize.searchParams.get("response_type")).toBe("code");
		expect(authorize.searchParams.get("scope")).toBe("api");
		expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
		expect(instructions).toContain("VS Code");
		expect(instructions).toContain("copy");
		const params = new URLSearchParams(body);
		expect(params.get("client_id")).toBe(CLIENT_ID);
		expect(params.get("redirect_uri")).toBe(REDIRECT_URI);
		expect(params.get("grant_type")).toBe("authorization_code");
		expect(params.get("code")).toBe("oauth-code");
		expect(params.get("code_verifier")).not.toBe("");
		expect(credentials.access).toBe("access-token");
		expect(credentials.refresh).toBe("refresh-token");
		expect(credentials.expires).toBe(1000 * 1000 + 7200 * 1000 - 5 * 60 * 1000);
	});

	it("refreshes with the VS Code OAuth app redirect URI", async () => {
		let body = "";
		vi.spyOn(globalThis, "fetch").mockImplementation(
			Object.assign(
				async (_input: string | URL | Request, init?: RequestInit) => {
					body = String(init?.body ?? "");
					return makeTokenResponse({ access_token: "fresh-access", refresh_token: "fresh-refresh" });
				},
				{ preconnect: fetch.preconnect },
			),
		);

		const credentials = await getProviderDefinition("gitlab-duo-agent")?.refreshToken?.({
			access: "old-access",
			refresh: "old-refresh",
			expires: 0,
		});
		if (!credentials) throw new Error("expected refreshed credentials");

		const params = new URLSearchParams(body);
		expect(params.get("client_id")).toBe(CLIENT_ID);
		expect(params.get("redirect_uri")).toBe(REDIRECT_URI);
		expect(params.get("grant_type")).toBe("refresh_token");
		expect(params.get("refresh_token")).toBe("old-refresh");
		expect(credentials.access).toBe("fresh-access");
		expect(credentials.refresh).toBe("fresh-refresh");
	});
});
