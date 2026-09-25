import { describe, expect, it } from "bun:test";
import { exchangeWindsurfPkceCode, loginDevinWindsurfHook } from "@oh-my-pi/pi-ai/registry/oauth/devin-windsurf";
import type { FetchImpl } from "@oh-my-pi/pi-ai/types";
import type { OAuthAuthInfo, OAuthController } from "@oh-my-pi/pi-ai/registry/oauth/types";

const CODE = "DVx20I4lKPzw0l_RtC4eAR4ji2RuifEM_mxkJ6guDHg";
const VERIFIER = "EzIPAaF7AQDJ_IVzAiN0NfoAAmvK4VrEq6yxYsrHKMkwabc123";
const TOKEN = "gsk-ws-01-mzdlilE8JwVjSdA37Bg4GtrGZQHnFNyU9fsU2ur11WuPgTZ0_MsqjaH5Orl75";
const USER_NAME = "Pavel Kalmykov Razgovorov";
const API_ENDPOINT = "https://server.enterprise.windsurf.com";

function encodeExchangeResponse(fieldOne: string, fieldTwo: string, fieldThree: string): Uint8Array {
	const chunks: number[] = [];
	for (const [field, value] of [
		[1, fieldOne],
		[2, fieldTwo],
		[3, fieldThree],
	] as const) {
		chunks.push((field << 3) | 2, value.length);
		for (let index = 0; index < value.length; index++) chunks.push(value.charCodeAt(index));
	}
	return Uint8Array.from(chunks);
}

function decodeExchangeRequest(data: Uint8Array): { code: string; verifier: string } {
	const values: string[] = [];
	let offset = 0;
	while (offset < data.length) {
		const tag = data[offset++];
		expect(tag & 7).toBe(2);
		let length = 0;
		let shift = 0;
		let byte: number;
		do {
			byte = data[offset++];
			length |= (byte & 0x7f) << shift;
			shift += 7;
		} while (byte & 0x80);
		values.push(new TextDecoder().decode(data.subarray(offset, offset + length)));
		offset += length;
	}
	return { code: values[0]!, verifier: values[1]! };
}

function exchangeFetchMock(
	exchangeCalls: Array<{ url: string; headers: Record<string, string>; body: Uint8Array }>,
): FetchImpl {
	return async (input, init) => {
		const request = new Request(input.toString(), init);
		exchangeCalls.push({
			url: request.url,
			headers: Object.fromEntries(request.headers.entries()),
			body: new Uint8Array(await request.arrayBuffer()),
		});
		return new Response(encodeExchangeResponse(TOKEN, USER_NAME, API_ENDPOINT), { status: 200 });
	};
}

describe("devin-windsurf login hook", () => {
	it("drives authorize + loopback callback + Connect-proto exchange end to end", async () => {
		const exchangeCalls: Array<{ url: string; headers: Record<string, string>; body: Uint8Array }> = [];
		let authInfo: OAuthAuthInfo | undefined;

		const controller: OAuthController = {
			onAuth(info) {
				authInfo = info;
				const authorize = new URL(info.url);
				const redirectUri = authorize.searchParams.get("redirect_uri");
				expect(authorize.origin + authorize.pathname).toBe("https://windsurf.com/editor/signin");
				expect(authorize.searchParams.get("response_type")).toBe("code");
				expect(authorize.searchParams.get("code_challenge_method")).toBe("S256");
				expect(authorize.searchParams.get("prompt")).toBe("login");
				expect(authorize.searchParams.get("redirect_parameters_type")).toBe("query");
				expect(authorize.searchParams.get("code_challenge")).toBeString();
				// Simulates the Windsurf authorize page redirecting back with the code.
				const callback = new URL(redirectUri!);
				callback.searchParams.set("code", CODE);
				callback.searchParams.set("state", authorize.searchParams.get("state")!);
				void fetch(callback.toString()).catch(() => {});
			},
			fetch: exchangeFetchMock(exchangeCalls),
		};

		const credentials = await loginDevinWindsurfHook(controller);

		expect(exchangeCalls).toHaveLength(1);
		const [exchange] = exchangeCalls;
		expect(exchange.url).toBe(
			"https://server.codeium.com/exa.seat_management_pb.SeatManagementService/ExchangePKCEAuthorizationCode",
		);
		expect(exchange.headers["content-type"]).toBe("application/proto");
		expect(exchange.headers["connect-protocol-version"]).toBe("1");
		const decoded = decodeExchangeRequest(exchange.body);
		expect(decoded.code).toBe(CODE);
		const challenge = Buffer.from(
			await crypto.subtle.digest("SHA-256", new TextEncoder().encode(decoded.verifier)),
		).toString("base64url");
		expect(challenge).toBe(new URL(authInfo!.url).searchParams.get("code_challenge") ?? "");

		expect(credentials.access).toBe(TOKEN.slice(1));
		expect(credentials.refresh).toBe(TOKEN.slice(1));
		expect(credentials.apiEndpoint).toBe(API_ENDPOINT);
		expect(credentials.orgName).toBe(USER_NAME);
		expect(credentials.expires).toBeGreaterThan(Date.now());
	});

	it("rejects an exchange response that omits the session key", async () => {
		const impl: FetchImpl = async () => new Response(new Uint8Array(0), { status: 200 });
		await expect(exchangeWindsurfPkceCode(CODE, VERIFIER, impl)).rejects.toThrow(/omitted the session key/);
	});

	it("surfaces exchange failures with status and body", async () => {
		const impl: FetchImpl = async () =>
			new Response('{"code":"unauthenticated","message":"invalid code"}', {
				status: 401,
				headers: { "content-type": "application/json" },
			});
		await expect(exchangeWindsurfPkceCode(CODE, VERIFIER, impl)).rejects.toThrow(/401/);
	});
});
