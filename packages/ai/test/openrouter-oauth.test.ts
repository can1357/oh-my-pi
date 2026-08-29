import { describe, expect, it, vi } from "bun:test";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { exchangeOpenRouterCode, OpenRouterOAuthFlow } from "@oh-my-pi/pi-ai/registry/oauth/openrouter";
import type { OAuthController } from "@oh-my-pi/pi-ai/registry/oauth/types";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";

const KEY_EXCHANGE_URL = "https://openrouter.ai/api/v1/auth/keys";
const REDIRECT_URI = "http://localhost:54549/callback";

interface RecordedRequest {
	url: string;
	method: string;
	body: unknown;
}

function makeKeyFetch(response: Response): { fetchImpl: FetchImpl; requests: RecordedRequest[] } {
	const requests: RecordedRequest[] = [];
	const fetchImpl: FetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
		requests.push({
			url,
			method: init?.method ?? "GET",
			body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
		});
		return response;
	});
	return { fetchImpl, requests };
}

function makeFlow(fetchImpl?: FetchImpl): OpenRouterOAuthFlow {
	const ctrl: OAuthController = { onAuth: () => {}, fetch: fetchImpl };
	return new OpenRouterOAuthFlow(ctrl);
}

describe("OpenRouter OAuth flow", () => {
	it("builds a stateless authorize URL whose challenge is the S256 hash of the exchanged verifier", async () => {
		const { fetchImpl, requests } = makeKeyFetch(
			new Response(JSON.stringify({ key: "sk-or-v1-minted" }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			}),
		);
		const flow = makeFlow(fetchImpl);

		const { url } = await flow.generateAuthUrl(flow.generateState(), REDIRECT_URI);
		const parsed = new URL(url);
		expect(parsed.origin + parsed.pathname).toBe("https://openrouter.ai/auth");
		expect(parsed.searchParams.get("callback_url")).toBe(REDIRECT_URI);
		expect(parsed.searchParams.get("code_challenge_method")).toBe("S256");
		// OpenRouter never echoes state back, so none may be sent.
		expect(parsed.searchParams.has("state")).toBe(false);

		const credentials = await flow.exchangeToken("auth-code-123");
		expect(credentials.access).toBe("sk-or-v1-minted");
		expect(credentials.expires).toBeGreaterThan(Date.now());

		expect(requests).toHaveLength(1);
		expect(requests[0]?.url).toBe(KEY_EXCHANGE_URL);
		expect(requests[0]?.method).toBe("POST");
		const body = requests[0]?.body as { code: string; code_verifier: string; code_challenge_method: string };
		expect(body.code).toBe("auth-code-123");
		expect(body.code_challenge_method).toBe("S256");

		// PKCE binding: the posted verifier must hash to the advertised challenge.
		const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(body.code_verifier));
		expect(parsed.searchParams.get("code_challenge")).toBe(Buffer.from(digest).toString("base64url"));
	});

	it("refuses to exchange a code before the authorize URL minted a verifier", async () => {
		const flow = makeFlow();
		await expect(flow.exchangeToken("orphan-code")).rejects.toThrow(/verifier was not initialized/i);
	});

	it("treats pasted sk-or- input as an API key: validates via /auth/key and skips the PKCE exchange", async () => {
		const requests: RecordedRequest[] = [];
		const fetchImpl: FetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
			requests.push({ url, method: init?.method ?? "GET", body: undefined });
			expect(new Headers(init?.headers ?? {}).get("authorization")).toBe("Bearer sk-or-v1-pasted");
			return new Response(JSON.stringify({ data: {} }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		});
		const flow = makeFlow(fetchImpl);

		const credentials = await flow.exchangeToken("sk-or-v1-pasted");
		expect(credentials.access).toBe("sk-or-v1-pasted");
		expect(requests).toHaveLength(1);
		expect(requests[0]?.url).toBe("https://openrouter.ai/api/v1/auth/key");
		expect(requests[0]?.method).toBe("GET");
	});

	it("rejects a pasted API key that fails /auth/key validation", async () => {
		const fetchImpl: FetchImpl = vi.fn(async () => new Response("unauthorized", { status: 401 }));
		const flow = makeFlow(fetchImpl);
		await expect(flow.exchangeToken("sk-or-v1-revoked")).rejects.toThrow(/401/);
	});
});

describe("exchangeOpenRouterCode", () => {
	it("surfaces a token-exchange error with the HTTP status on a rejected code", async () => {
		const { fetchImpl } = makeKeyFetch(new Response("bad code", { status: 403 }));
		const error = await exchangeOpenRouterCode("bad-code", "verifier", fetchImpl).then(
			() => undefined,
			(err: unknown) => err,
		);
		expect(error).toBeInstanceOf(AIError.OAuthError);
		const oauthError = error as AIError.OAuthError;
		expect(oauthError.message).toMatch(/OpenRouter key exchange failed: 403/);
		expect(oauthError.status).toBe(403);
		expect(oauthError.kind).toBe("token-exchange");
	});

	it("rejects a 200 response whose body is missing the minted key", async () => {
		const { fetchImpl } = makeKeyFetch(
			new Response(JSON.stringify({ key: "" }), { status: 200, headers: { "Content-Type": "application/json" } }),
		);
		await expect(exchangeOpenRouterCode("code", "verifier", fetchImpl)).rejects.toThrow(/empty key/i);
	});
});
