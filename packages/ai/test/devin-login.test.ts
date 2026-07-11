import { describe, expect, test } from "bun:test";
import { exchangeDevinCliToken } from "@pk-nerdsaver-ai/pi-ai/registry/oauth/devin";
import type { FetchImpl } from "@pk-nerdsaver-ai/pi-catalog/types";

describe("Devin CLI login", () => {
	test("exchanges callback code with CLI token JSON endpoint", async () => {
		let requestUrl = "";
		let requestInit: RequestInit | undefined;
		const fetchImpl: FetchImpl = async (url, init) => {
			requestUrl = String(url);
			requestInit = init;
			return new Response(JSON.stringify({ token: "devin-jwt" }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		};

		const token = await exchangeDevinCliToken("callback-code", "pkce-verifier", fetchImpl);

		expect(token).toBe("devin-jwt");
		expect(requestUrl).toBe("https://api.devin.ai/auth/cli/token");
		expect(requestInit?.method).toBe("POST");
		expect(requestInit?.headers).toEqual({
			Accept: "application/json",
			"Content-Type": "application/json",
		});
		expect(JSON.parse(String(requestInit?.body))).toEqual({
			code: "callback-code",
			code_verifier: "pkce-verifier",
		});
	});
});
