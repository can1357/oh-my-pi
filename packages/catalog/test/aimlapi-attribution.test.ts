import { describe, expect, test } from "bun:test";
import { aimlapiClientHeaders, AIMLAPI_API_BASE_URL, isAimlapiOrigin } from "@oh-my-pi/pi-catalog/wire/aimlapi";

describe("aimlapi client attribution", () => {
	test("sends the four identity headers for the provider's own origin", () => {
		expect(aimlapiClientHeaders(AIMLAPI_API_BASE_URL)).toEqual({
			"HTTP-Referer": "https://github.com/can1357/oh-my-pi",
			"X-Title": "oh-my-pi",
			"X-AIMLAPI-Source": "agent/oh-my-pi",
			"X-AIMLAPI-Partner-ID": "part_esrFuB5coroCvy4ri4dDqbCX",
		});
	});

	test("sends nothing anywhere else", () => {
		// The partner id names a revenue-attribution row, so a repointed base URL
		// must not hand our client identity to somebody else's gateway.
		for (const baseUrl of [
			"https://api.openai.com/v1",
			"http://127.0.0.1:8813/v1",
			"https://api.aimlapi.com.example.net/v1", // suffix look-alike
			"http://api.aimlapi.com/v1", // plaintext would expose the bearer too
			"not a url",
			undefined,
		]) {
			expect(aimlapiClientHeaders(baseUrl)).toEqual({});
			expect(isAimlapiOrigin(baseUrl)).toBe(false);
		}
	});

	test("the partner id matches the gateway's documented shape", () => {
		// An id outside this shape is accepted by the gateway and silently
		// unattributed, so nothing but an assertion catches a typo.
		const headers = aimlapiClientHeaders(AIMLAPI_API_BASE_URL);
		expect(headers["X-AIMLAPI-Partner-ID"]).toMatch(/^part_[A-Za-z0-9]{1,64}$/);
		expect(headers["X-AIMLAPI-Source"]).toMatch(/^(web|agent|mcp)\/[a-z0-9-]{1,32}$/);
	});
});
