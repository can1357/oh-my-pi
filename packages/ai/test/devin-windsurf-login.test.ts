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

	// Decision table: response field partitions -> credential mapping.
	// field 1 is required; fields 2/3 are optional with defaults. Empty and
	// omitted collapse to the same observable outcome for fields 2/3.
	it.each([
		{
			case: "gsk- prefixed key, all optional fields",
			f1: TOKEN,
			f2: USER_NAME,
			f3: API_ENDPOINT,
			apiKey: TOKEN.slice(1),
			orgName: USER_NAME,
			apiEndpoint: API_ENDPOINT,
		},
		{
			case: "key already unprefixed is stored as-is",
			f1: "sk-ws-01-already-raw",
			f2: "Some User",
			f3: API_ENDPOINT,
			apiKey: "sk-ws-01-already-raw",
			orgName: "Some User",
			apiEndpoint: API_ENDPOINT,
		},
		{
			case: "field 2 omitted -> orgName undefined",
			f1: TOKEN,
			f3: API_ENDPOINT,
			apiKey: TOKEN.slice(1),
			orgName: undefined,
			apiEndpoint: API_ENDPOINT,
		},
		{
			case: "field 2 empty -> orgName undefined",
			f1: TOKEN,
			f2: "",
			f3: API_ENDPOINT,
			apiKey: TOKEN.slice(1),
			orgName: undefined,
			apiEndpoint: API_ENDPOINT,
		},
		{
			case: "field 3 omitted -> default API endpoint",
			f1: TOKEN,
			f2: USER_NAME,
			apiKey: TOKEN.slice(1),
			orgName: USER_NAME,
			apiEndpoint: "https://server.enterprise.windsurf.com",
		},
		{
			case: "field 3 empty -> default API endpoint",
			f1: TOKEN,
			f2: USER_NAME,
			f3: "",
			apiKey: TOKEN.slice(1),
			orgName: USER_NAME,
			apiEndpoint: "https://server.enterprise.windsurf.com",
		},
	])("maps response fields: $case", async ({ f1, f2, f3, apiKey, orgName, apiEndpoint }) => {
		const chunks: number[] = [];
		for (const [field, value] of [
			[1, f1],
			[2, f2],
			[3, f3],
		] as Array<[number, string | undefined]>) {
			if (value === undefined) continue;
			chunks.push((field << 3) | 2, value.length);
			for (let index = 0; index < value.length; index++) chunks.push(value.charCodeAt(index));
		}
		const impl: FetchImpl = async () => new Response(Uint8Array.from(chunks), { status: 200 });

		const exchange = await exchangeWindsurfPkceCode(CODE, VERIFIER, impl);
		expect(exchange.apiKey).toBe(apiKey);
		expect(exchange.userName).toBe(orgName ?? "");
		expect(exchange.apiEndpoint).toBe(apiEndpoint);
	});

	it("treats an empty session-key field like a missing one", async () => {
		const chunks = [0x0a, 0x00];
		const impl: FetchImpl = async () => new Response(Uint8Array.from(chunks), { status: 200 });
		await expect(exchangeWindsurfPkceCode(CODE, VERIFIER, impl)).rejects.toThrow(/omitted the session key/);
	});

	it("encodes field lengths above 127 as multi-byte varints", async () => {
		const longVerifier = "v".repeat(128);
		let captured: Uint8Array | undefined;
		const impl: FetchImpl = async (_input, init) => {
			captured = new Uint8Array(await new Request("https://exchange.test/", init).arrayBuffer());
			return new Response(Uint8Array.from([0x0a, 0x03, 97, 98, 99]), { status: 200 });
		};

		await exchangeWindsurfPkceCode(CODE, longVerifier, impl);

		// Field 1: tag 0x0a + 1-byte length + 43-byte code = 45 bytes; field 2
		// length 128 then continues as varint 0x80 0x01.
		expect(captured).toBeDefined();
		expect(captured![45]).toBe(0x12);
		expect(Array.from(captured!.slice(46, 48))).toEqual([0x80, 0x01]);
	});

	it("propagates network failures unwrapped", async () => {
		const impl: FetchImpl = async () => {
			throw new Error("connection refused");
		};
		await expect(exchangeWindsurfPkceCode(CODE, VERIFIER, impl)).rejects.toThrow(/^connection refused$/);
	});

	it("keeps the OAuthError when the error body is unreadable", async () => {
		const impl: FetchImpl = async () =>
			({
				ok: false,
				status: 503,
				text: () => Promise.reject(new Error("stream aborted")),
			}) as unknown as Response;
		await expect(exchangeWindsurfPkceCode(CODE, VERIFIER, impl)).rejects.toThrow(/503 <unreadable>/);
	});

	it("rejects malformed protobuf wire types", async () => {
		const impl: FetchImpl = async () => new Response(Uint8Array.from([0x08, 0x01]), { status: 200 });
		await expect(exchangeWindsurfPkceCode(CODE, VERIFIER, impl)).rejects.toThrow(/Unexpected wire type/);
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
