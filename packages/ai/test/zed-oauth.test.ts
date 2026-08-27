import { describe, expect, it } from "bun:test";
import { constants, createPublicKey, publicEncrypt } from "node:crypto";
import type { RsaAuthKeypair } from "@oh-my-pi/pi-catalog/wire/zed";
import { generateZedAuthKeypair } from "@oh-my-pi/pi-catalog/wire/zed";
import * as AIError from "../src/error";
import type { OAuthAuthInfo, OAuthCredentials } from "../src/registry/oauth/types";
import { loginZed, ZedOAuthFlow } from "../src/registry/oauth/zed";
import type { FetchImpl } from "../src/types";
import { mockFetch } from "./helpers/fetch-mock";

function encryptZedAccessToken(accessToken: string, keypair: RsaAuthKeypair): string {
	const publicKeyDer = Buffer.from(
		keypair.publicKeyDerBase64Url.replace(/-/g, "+").replace(/_/g, "/") +
			"=".repeat((4 - (keypair.publicKeyDerBase64Url.length % 4)) % 4),
		"base64",
	);
	const publicKey = createPublicKey({ key: publicKeyDer, format: "der", type: "pkcs1" });
	const encrypted = publicEncrypt(
		{
			key: publicKey,
			padding: constants.RSA_PKCS1_OAEP_PADDING,
			oaepHash: "sha256",
		},
		Buffer.from(accessToken, "utf8"),
	);
	return encrypted.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function callbackUrl(info: OAuthAuthInfo, params: Record<string, string>): URL {
	const authUrl = new URL(info.url);
	const port = authUrl.searchParams.get("native_app_port");
	if (!port) throw new Error("Zed OAuth URL did not include the callback port");

	const callback = new URL(`http://127.0.0.1:${port}/`);
	for (const [name, value] of Object.entries(params)) callback.searchParams.set(name, value);
	return callback;
}

async function startZedFlow(
	keypair: RsaAuthKeypair,
	fetchImpl: FetchImpl,
): Promise<{
	info: OAuthAuthInfo;
	abort: AbortController;
	login: Promise<OAuthCredentials>;
}> {
	const abort = new AbortController();
	const authReady = Promise.withResolvers<OAuthAuthInfo>();
	const flow = new ZedOAuthFlow(
		{
			onAuth: info => authReady.resolve(info),
			signal: abort.signal,
			fetch: fetchImpl,
		},
		keypair,
	);
	// Use an ephemeral listener so this test file is safe beside other callback
	// server tests and does not depend on the well-known production port.
	flow.preferredPort = 0;
	const login = flow.login();
	void login.catch(() => undefined);
	const info = await authReady.promise;
	return { info, abort, login };
}

function responseJson(value: unknown, status = 200): Response {
	return new Response(JSON.stringify(value), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

describe("Zed OAuth flow", () => {
	it("completes a valid encrypted callback and preserves validated identity metadata", async () => {
		const keypair = generateZedAuthKeypair();
		const requests: Array<{ url: string; headers: Headers }> = [];
		const fetchMock = mockFetch(async (input, init) => {
			requests.push({
				url: typeof input === "string" ? input : input.toString(),
				headers: new Headers(init?.headers),
			});
			return responseJson({ id: 4815162342, github_login: "zed-oauth-user", email: "fallback@example.com" });
		});
		const { info, abort, login } = await startZedFlow(keypair, fetchMock);

		try {
			const authUrl = new URL(info.url);
			expect(authUrl.origin + authUrl.pathname).toBe("https://zed.dev/native_app_signin");
			expect(authUrl.searchParams.get("native_app_public_key")).toBe(keypair.publicKeyDerBase64Url);

			const userId = "zed-callback-user";
			const accessToken = "zed-access-token";
			const callback = callbackUrl(info, {
				user_id: userId,
				access_token: encryptZedAccessToken(accessToken, keypair),
			});
			const callbackResponse = await fetch(callback);

			expect(callbackResponse.status).toBe(200);
			expect(await login).toMatchObject({
				access: `4815162342 ${accessToken}`,
				refresh: `4815162342 ${accessToken}`,
				accountId: "4815162342",
				email: "zed-oauth-user",
			});
			expect(requests).toHaveLength(1);
			expect(requests[0]?.url).toBe("https://cloud.zed.dev/client/users/me");
			expect(requests[0]?.headers.get("Authorization")).toBe(`${userId} ${accessToken}`);
			expect(requests[0]?.headers.get("x-zed-version")).toBe("0.180.0");
		} finally {
			abort.abort("test cleanup");
			await login.catch(() => undefined);
		}
	});

	it("returns an error for malformed encrypted callbacks without settling login", async () => {
		const keypair = generateZedAuthKeypair();
		let profileRequests = 0;
		const fetchMock = mockFetch(async () => {
			profileRequests += 1;
			return responseJson({ id: 123, email: "valid@example.com" });
		});
		const { info, abort, login } = await startZedFlow(keypair, fetchMock);
		let loginSettled = false;
		void login.then(
			() => {
				loginSettled = true;
			},
			() => {
				loginSettled = true;
			},
		);

		try {
			const malformed = await fetch(
				callbackUrl(info, { user_id: "attacker-user", access_token: "not-an-rsa-ciphertext" }),
			);
			expect(malformed.status).toBe(500);
			await Promise.resolve();
			expect(loginSettled).toBe(false);
			expect(profileRequests).toBe(0);

			const valid = await fetch(
				callbackUrl(info, {
					user_id: "valid-user",
					access_token: encryptZedAccessToken("valid-access-token", keypair),
				}),
			);
			expect(valid.status).toBe(200);
			expect((await login).accountId).toBe("123");
			expect(profileRequests).toBe(1);
		} finally {
			abort.abort("test cleanup");
			await login.catch(() => undefined);
		}
	});

	it("rejects an explicit authorization denial instead of waiting for timeout", async () => {
		const keypair = generateZedAuthKeypair();
		const { info, abort, login } = await startZedFlow(
			keypair,
			mockFetch(async () => responseJson({ id: 1 })),
		);
		try {
			const denial = callbackUrl(info, {
				error: "access_denied",
				error_description: "The user denied Zed access",
			});
			const response = await fetch(denial);
			expect(response.status).toBe(500);

			const error = await login.catch((caught: unknown) => caught);
			expect(error).toBeInstanceOf(AIError.OAuthError);
			if (error instanceof AIError.OAuthError) {
				expect(error.kind).toBe("device-auth");
				expect(error.message).toBe("Authorization failed: The user denied Zed access");
			}
		} finally {
			abort.abort("test cleanup");
			await login.catch(() => undefined);
		}
	});

	it("falls back to the callback user ID when identity lookup fails", async () => {
		const fetchMock = mockFetch(async () => new Response("temporarily unavailable", { status: 503 }));
		const flow = new ZedOAuthFlow({ fetch: fetchMock }, generateZedAuthKeypair());

		const credentials = await flow.exchangeToken("access-token", "callback-user");
		expect(credentials).toMatchObject({
			access: "callback-user access-token",
			refresh: "callback-user access-token",
			accountId: "callback-user",
		});
		expect(credentials.email).toBeUndefined();
	});

	it("rejects a pre-aborted callback flow before opening a listener", async () => {
		const abort = new AbortController();
		abort.abort("user cancelled");
		const flow = new ZedOAuthFlow({ signal: abort.signal }, generateZedAuthKeypair());

		await expect(flow.login()).rejects.toBeInstanceOf(AIError.LoginCancelledError);
	});

	it("reports a pre-aborted exported login as an AbortError", async () => {
		const abort = new AbortController();
		abort.abort("user cancelled");

		await expect(loginZed({ signal: abort.signal })).rejects.toBeInstanceOf(AIError.AbortError);
	});
});
