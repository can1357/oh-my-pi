import { describe, expect, it } from "bun:test";
import { authPolicyFor } from "@oh-my-pi/pi-catalog/compat/auth";

describe("Stencil OAuth callback", () => {
	it("uses a port-flexible IPv4 loopback redirect", () => {
		const login = authPolicyFor("stencil")?.login;
		expect(login?.kind).toBe("oauth-code");
		if (login?.kind !== "oauth-code") throw new Error("missing OAuth policy for stencil");
		expect(login.callback).toMatchObject({
			hostname: "127.0.0.1",
			port: 54547,
			path: "/callback",
			portFallback: true,
		});
	});
});
