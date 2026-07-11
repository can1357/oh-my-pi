import { describe, expect, it, vi } from "bun:test";
import {
	GITLAB_DUO_WORKFLOW_OAUTH_CLIENT_ID,
	GITLAB_DUO_WORKFLOW_OAUTH_REDIRECT_URI,
	loginGitLabDuoWorkflow,
	refreshGitLabDuoWorkflowToken,
} from "@pk-nerdsaver-ai/pi-ai/registry/oauth/gitlab-duo-workflow";
import type { OAuthLoginCallbacks } from "@pk-nerdsaver-ai/pi-ai/registry/oauth/types";
import type { FetchImpl } from "@pk-nerdsaver-ai/pi-ai/types";

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

describe("gitlab duo workflow OAuth", () => {
	it("uses the official VS Code OAuth app and accepts pasted vscode callback URLs", async () => {
		let authUrl = "";
		let instructions = "";
		const bodies: string[] = [];
		const fetchMock: FetchImpl = vi.fn(async (_input, init) => {
			bodies.push(String(init?.body ?? ""));
			return makeTokenResponse();
		});
		const callbacks: OAuthLoginCallbacks = {
			onAuth: info => {
				authUrl = info.url;
				instructions = info.instructions ?? "";
			},
			onPrompt: async () => "unused",
			onManualCodeInput: async () => {
				const state = new URL(authUrl).searchParams.get("state");
				return `${GITLAB_DUO_WORKFLOW_OAUTH_REDIRECT_URI}?code=oauth-code&state=${state}`;
			},
			fetch: fetchMock,
		};

		const credentials = await loginGitLabDuoWorkflow(callbacks);

		const authorize = new URL(authUrl);
		expect(authorize.toString()).toStartWith("https://gitlab.com/oauth/authorize?");
		expect(authorize.searchParams.get("client_id")).toBe(GITLAB_DUO_WORKFLOW_OAUTH_CLIENT_ID);
		expect(authorize.searchParams.get("redirect_uri")).toBe(GITLAB_DUO_WORKFLOW_OAUTH_REDIRECT_URI);
		expect(authorize.searchParams.get("response_type")).toBe("code");
		expect(authorize.searchParams.get("scope")).toBe("api");
		expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
		expect(instructions).toContain("VS Code");
		expect(instructions).toContain("copy");

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(bodies[0]).toContain(`client_id=${GITLAB_DUO_WORKFLOW_OAUTH_CLIENT_ID}`);
		expect(bodies[0]).toContain(`redirect_uri=${encodeURIComponent(GITLAB_DUO_WORKFLOW_OAUTH_REDIRECT_URI)}`);
		expect(bodies[0]).toContain("grant_type=authorization_code");
		expect(bodies[0]).toContain("code=oauth-code");
		expect(bodies[0]).toContain("code_verifier=");
		expect(credentials.access).toBe("access-token");
		expect(credentials.refresh).toBe("refresh-token");
		expect(credentials.expires).toBe(1000 * 1000 + 7200 * 1000 - 5 * 60 * 1000);
	});

	it("refreshes with the VS Code OAuth app redirect URI", async () => {
		let body = "";
		const fetchMock: FetchImpl = vi.fn(async (_input, init) => {
			body = String(init?.body ?? "");
			return makeTokenResponse({ access_token: "fresh-access", refresh_token: "fresh-refresh" });
		});

		const credentials = await refreshGitLabDuoWorkflowToken(
			{ access: "old-access", refresh: "old-refresh", expires: 0 },
			fetchMock,
		);

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(body).toContain(`client_id=${GITLAB_DUO_WORKFLOW_OAUTH_CLIENT_ID}`);
		expect(body).toContain(`redirect_uri=${encodeURIComponent(GITLAB_DUO_WORKFLOW_OAUTH_REDIRECT_URI)}`);
		expect(body).toContain("grant_type=refresh_token");
		expect(body).toContain("refresh_token=old-refresh");
		expect(credentials.access).toBe("fresh-access");
		expect(credentials.refresh).toBe("fresh-refresh");
	});
});
