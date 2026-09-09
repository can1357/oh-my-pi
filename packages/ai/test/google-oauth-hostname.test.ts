import { describe, expect, it } from "bun:test";
import { authPolicyFor } from "@oh-my-pi/pi-catalog/compat/auth";

describe("Google OAuth callback hostname", () => {
	it("uses 127.0.0.1 to avoid IPv6 and proxy delays", () => {
		for (const provider of ["google-gemini-cli", "google-antigravity"] as const) {
			const login = authPolicyFor(provider)?.login;
			expect(login?.kind).toBe("oauth-code");
			if (login?.kind !== "oauth-code") throw new Error(`missing OAuth policy for ${provider}`);
			expect(login.callback.hostname).toBe("127.0.0.1");
		}
	});
});
