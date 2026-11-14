import { describe, expect, it } from "bun:test";
import {
	ExchangePKCEAuthorizationCodeRequestSchema,
	ExchangePKCEAuthorizationCodeResponseSchema,
} from "@oh-my-pi/pi-catalog/discovery/devin-proto";
import { create, fromBinary, toBinary } from "@oh-my-pi/pi-catalog/discovery/protobuf";
import { exchangeWindsurfCode, loginDevinWindsurfHook } from "@oh-my-pi/pi-ai/registry/oauth/devin-windsurf";
import type { OAuthController } from "@oh-my-pi/pi-ai/registry/oauth/types";

const EXCHANGE_URL =
	"https://server.codeium.com/exa.seat_management_pb.SeatManagementService/ExchangePKCEAuthorizationCode";

function exchangeResponse(apiKey: string): Response {
	const body = toBinary(
		ExchangePKCEAuthorizationCodeResponseSchema,
		create(ExchangePKCEAuthorizationCodeResponseSchema, {
			apiKey,
			name: "Test User",
			apiServerUrl: "https://server.enterprise.windsurf.com",
		}),
	);
	return new Response(body, { status: 200 });
}

function respond(response: Response): Pick<OAuthController, "fetch"> {
	return { fetch: async () => response };
}

describe("devin-windsurf login", () => {
	it("binds the authorize PKCE challenge to the exchanged verifier and returns the raw seat key", async () => {
		let authorizeUrl: URL | undefined;
		let exchange: { url: string; contentType: string | null; body: Uint8Array } | undefined;
		const ctrl: OAuthController = {
			onAuth(info) {
				authorizeUrl = new URL(info.url);
				// Simulate the Windsurf authorize page redirecting back to the loopback callback.
				const callback = new URL(authorizeUrl.searchParams.get("redirect_uri") ?? "");
				callback.searchParams.set("code", "auth-code");
				callback.searchParams.set("state", authorizeUrl.searchParams.get("state") ?? "");
				void fetch(callback).catch(() => {});
			},
			fetch: async (input, init) => {
				const request = new Request(input.toString(), init);
				exchange = {
					url: request.url,
					contentType: request.headers.get("content-type"),
					body: new Uint8Array(await request.arrayBuffer()),
				};
				return exchangeResponse("gsk-ws-01-synthetic");
			},
		};

		expect(await loginDevinWindsurfHook(ctrl)).toBe("sk-ws-01-synthetic");

		expect(authorizeUrl?.origin + (authorizeUrl?.pathname ?? "")).toBe("https://windsurf.com/editor/signin");
		expect(authorizeUrl?.searchParams.get("code_challenge_method")).toBe("S256");
		expect(exchange?.url).toBe(EXCHANGE_URL);
		expect(exchange?.contentType).toBe("application/proto");
		const sent = fromBinary(ExchangePKCEAuthorizationCodeRequestSchema, exchange?.body ?? new Uint8Array());
		expect(sent.authorizationCode).toBe("auth-code");
		const challenge = new Bun.CryptoHasher("sha256").update(sent.codeVerifier).digest("base64url");
		expect(challenge).toBe(authorizeUrl?.searchParams.get("code_challenge") ?? "");
	});

	it("keeps an already-raw key unchanged", async () => {
		expect(await exchangeWindsurfCode("code", "verifier", respond(exchangeResponse("sk-ws-01-raw")))).toBe(
			"sk-ws-01-raw",
		);
	});

	it("ignores response fields it does not model", async () => {
		const known = new Uint8Array(await exchangeResponse("sk-ws-01-raw").arrayBuffer());
		// Field 9 as a varint: a wire type the old hand-rolled decoder rejected.
		const body = Uint8Array.from([...known, 0x48, 0x01]);
		expect(await exchangeWindsurfCode("code", "verifier", respond(new Response(body)))).toBe("sk-ws-01-raw");
	});

	it("rejects a response without an API key", async () => {
		await expect(exchangeWindsurfCode("code", "verifier", respond(exchangeResponse("")))).rejects.toThrow(
			/returned no API key/,
		);
	});

	it("surfaces the exchange status and body on failure", async () => {
		const failure = new Response('{"code":"unauthenticated"}', { status: 401 });
		await expect(exchangeWindsurfCode("code", "verifier", respond(failure))).rejects.toThrow(
			/exchange failed: 401 .*unauthenticated/,
		);
	});
});
