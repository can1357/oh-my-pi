import { describe, expect, it } from "bun:test";
import { parseCallbackInput } from "@oh-my-pi/pi-ai/registry/oauth/callback-server";

describe("parseCallbackInput", () => {
	it("reads code and state from a redirect URL", () => {
		expect(parseCallbackInput("https://a.test/cb?code=ABC123&state=xyz")).toEqual({ code: "ABC123", state: "xyz" });
	});

	// A URL selected out of the setup wizard carries the row breaks the frame
	// painted, plus a space per row on terminals that pad. The URL parser drops
	// the newlines and keeps the space, so without this the user pastes what
	// looks like the right URL and the provider rejects a code with a hole in it.
	it("survives the line breaks and padding a terminal selection adds", () => {
		expect(parseCallbackInput("https://a.test/cb?code=ABC\n123&state=xyz")).toEqual({ code: "ABC123", state: "xyz" });
		expect(parseCallbackInput("https://a.test/cb?code=ABC \n 123&state=xyz")).toEqual({
			code: "ABC123",
			state: "xyz",
		});
	});

	it("accepts a bare code split across rows, and keeps a spec-legal interior space", () => {
		// Row breaks are never VSCHAR, so they always go.
		expect(parseCallbackInput("ABC\n123").code).toBe("ABC123");
		// A space is %x20, inside 1*VSCHAR: part of the code, not terminal noise.
		expect(parseCallbackInput("ABC DEF").code).toBe("ABC DEF");
	});

	it("returns nothing for empty or whitespace-only input", () => {
		expect(parseCallbackInput("   \n  ")).toEqual({});
	});
});
