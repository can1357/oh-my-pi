import { describe, expect, test } from "bun:test";
import { classifyMCPServer } from "@oh-my-pi/pi-coding-agent/mcp/auth-capability";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";

const directHttp = { type: "http" as const, url: "https://mcp.example.com/mcp" };

describe("classifyMCPServer", () => {
	test("offers managed OAuth only for direct network servers", () => {
		const direct = classifyMCPServer({ config: directHttp });
		expect(direct.canReauthenticate).toBe(true);
		expect(direct.authenticationMode).toBe("none");

		const staticHeader = classifyMCPServer({
			config: { ...directHttp, headers: { Authorization: "Bearer configured-elsewhere" } },
		});
		expect(staticHeader.canReauthenticate).toBe(false);
		expect(staticHeader.authenticationMode).toBe("static-header");
		expect(staticHeader.reauthenticateUnavailableReason).toContain("static Authorization header");

		const proxy = classifyMCPServer({
			config: { type: "stdio", command: "npx", args: ["-y", "mcp-remote@latest", "https://mcp.example.com/mcp"] },
		});
		expect(proxy.canReauthenticate).toBe(false);
		expect(proxy.authenticationMode).toBe("external-proxy");
		expect(proxy.reauthenticateUnavailableReason).toContain("proxy process");
	});

	test("enables clear-authentication only when an OMP-managed credential exists", () => {
		const authStorage = {
			get: () => ({ type: "oauth", access: "stored-access-token" }),
		} as unknown as AuthStorage;
		const classified = classifyMCPServer({ config: directHttp, authStorage });
		expect(classified.authenticationMode).toBe("managed-oauth");
		expect(classified.canClearAuthentication).toBe(true);
	});

	test("disabled and shadowed rows cannot run contextual actions", () => {
		const disabled = classifyMCPServer({ config: directHttp, disabled: true });
		expect(disabled.canTest).toBe(false);
		expect(disabled.canReconnect).toBe(false);
		expect(disabled.canReauthenticate).toBe(false);
		expect(disabled.canToggle).toBe(true);

		const shadowed = classifyMCPServer({ config: directHttp, shadowed: true });
		expect(shadowed.canTest).toBe(false);
		expect(shadowed.canToggle).toBe(false);
	});
});
