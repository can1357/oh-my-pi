import { afterEach, expect, test, vi } from "bun:test";
import { loginOpenAICodexDevice, openAICodexProfileHook } from "@oh-my-pi/pi-ai/oauth/openai-codex";

afterEach(() => {
	vi.restoreAllMocks();
});

function jwtWithPayload(payload: Record<string, unknown>): string {
	const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
	const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
	return `${header}.${body}.sig`;
}

test("accepts Codex login tokens with an email when workspace claims are absent", async () => {
	const access = jwtWithPayload({
		sub: "user-fixture",
		"https://api.openai.com/auth": { user_id: "user-fixture", poid: "org-fixture" },
		"https://api.openai.com/profile": { email: "Fixture@Example.com" },
	});

	const credentials = await openAICodexProfileHook(
		{ access, refresh: "refresh-token", expires: Date.now() + 60_000 },
		{ provider: "openai-codex", phase: "login", raw: {}, fetch },
	);

	expect(credentials.email).toBe("fixture@example.com");
	expect(credentials.accountId).toBeUndefined();
	expect(credentials.orgId).toBeUndefined();
});

test("completes device login when the token has email but no workspace claim", async () => {
	const access = jwtWithPayload({
		sub: "user-fixture",
		"https://api.openai.com/auth": { user_id: "user-fixture", poid: "org-fixture" },
		"https://api.openai.com/profile": { email: "fixture@example.com" },
	});
	vi.spyOn(globalThis, "fetch").mockImplementation(
		Object.assign(
			async (input: string | URL | Request) => {
				const url = typeof input === "string" ? input : input instanceof Request ? input.url : input.toString();
				if (url.endsWith("/api/accounts/deviceauth/usercode")) {
					return Response.json({ device_auth_id: "device-auth", user_code: "USER-CODE", interval: -3 });
				}
				if (url.endsWith("/api/accounts/deviceauth/token")) {
					return Response.json({ authorization_code: "authorization-code", code_verifier: "verifier" });
				}
				if (url.endsWith("/oauth/token")) {
					return Response.json({
						access_token: access,
						refresh_token: "refresh-token",
						expires_in: 3600,
					});
				}
				throw new Error(`Unexpected request: ${url}`);
			},
			{ preconnect: fetch.preconnect },
		),
	);

	const credentials = await loginOpenAICodexDevice({});

	expect(credentials.email).toBe("fixture@example.com");
	expect(credentials.accountId).toBeUndefined();
	expect(credentials.orgId).toBeUndefined();
});

test("rejects Codex login tokens without a workspace or email identity", async () => {
	const access = jwtWithPayload({ sub: "user-fixture" });

	await expect(
		openAICodexProfileHook(
			{ access, refresh: "refresh-token", expires: Date.now() + 60_000 },
			{ provider: "openai-codex", phase: "login", raw: {}, fetch },
		),
	).rejects.toMatchObject({ kind: "validation", provider: "openai-codex" });
});
