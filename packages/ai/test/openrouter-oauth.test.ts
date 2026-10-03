import { describe, expect, it, vi } from "bun:test";
import { getProviderDefinition } from "@oh-my-pi/pi-ai/registry";
import type { OAuthController } from "@oh-my-pi/pi-ai/registry/oauth/types";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";

const KEY_EXCHANGE_URL = "https://openrouter.ai/api/v1/auth/keys";
const REDIRECT_URI = "http://localhost:54549/callback";

interface RecordedRequest {
	url: string;
	method: string;
	body?: Record<string, unknown>;
}

function login(callbacks: OAuthController) {
	const provider = getProviderDefinition("openrouter");
	if (!provider?.login) throw new Error("openrouter login is unavailable");
	return provider.login(callbacks);
}

describe("OpenRouter OAuth flow", () => {
	it("builds a stateless authorize URL whose challenge binds the exchanged verifier", async () => {
		let authUrl = "";
		const requests: RecordedRequest[] = [];
		const fetchImpl: FetchImpl = vi.fn(async (input, init) => {
			requests.push({
				url: String(input),
				method: init?.method ?? "GET",
				body: typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : undefined,
			});
			return new Response(JSON.stringify({ key: "sk-or-v1-minted" }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		});
		const credentials = await login({
			onAuth: info => {
				authUrl = info.url;
			},
			onManualCodeInput: async () => "auth-code-123",
			fetch: fetchImpl,
		});
		if (typeof credentials !== "string") throw new Error("expected the durable key as a plain string");

		const parsed = new URL(authUrl);
		expect(parsed.origin + parsed.pathname).toBe("https://openrouter.ai/auth");
		expect(parsed.searchParams.get("callback_url")).toBe(REDIRECT_URI);
		expect(parsed.searchParams.get("code_challenge_method")).toBe("S256");
		expect(parsed.searchParams.has("state")).toBe(false);
		expect(credentials).toBe("sk-or-v1-minted");
		expect(requests).toHaveLength(1);
		expect(requests[0]?.url).toBe(KEY_EXCHANGE_URL);
		expect(requests[0]?.method).toBe("POST");
		const body = requests[0]?.body;
		expect(body?.code).toBe("auth-code-123");
		expect(body?.code_challenge_method).toBe("S256");
		const verifier = String(body?.code_verifier);
		const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
		expect(parsed.searchParams.get("code_challenge")).toBe(Buffer.from(digest).toString("base64url"));
	});

	it("validates pasted sk-or- input via /auth/key and skips the exchange", async () => {
		const requests: RecordedRequest[] = [];
		const fetchImpl: FetchImpl = vi.fn(async (input, init) => {
			requests.push({ url: String(input), method: init?.method ?? "GET" });
			expect(new Headers(init?.headers ?? {}).get("authorization")).toBe("Bearer sk-or-v1-pasted");
			return new Response(JSON.stringify({ data: {} }), { status: 200 });
		});
		const credentials = await login({
			onAuth: () => {},
			onManualCodeInput: async () => "sk-or-v1-pasted",
			fetch: fetchImpl,
		});
		if (typeof credentials !== "string") throw new Error("expected the durable key as a plain string");
		expect(credentials).toBe("sk-or-v1-pasted");
		expect(requests).toEqual([{ url: "https://openrouter.ai/api/v1/auth/key", method: "GET" }]);
	});

	it("surfaces rejected exchanges and pasted-key validation failures", async () => {
		const rejectedExchange: FetchImpl = vi.fn(async () => new Response("bad code", { status: 403 }));
		await expect(
			login({ onAuth: () => {}, onManualCodeInput: async () => "bad-code", fetch: rejectedExchange }),
		).rejects.toThrow(/403/);

		const rejectedKey: FetchImpl = vi.fn(async () => new Response("unauthorized", { status: 401 }));
		await expect(
			login({ onAuth: () => {}, onManualCodeInput: async () => "sk-or-v1-revoked", fetch: rejectedKey }),
		).rejects.toThrow(/401/);
	});
});
