import { describe, expect, test } from "bun:test";
import { MCPOAuthCancelledError, runMCPInteractiveOAuth } from "@oh-my-pi/pi-coding-agent/mcp/interactive-oauth";
import { MCPOAuthCancelledError as ControllerOAuthCancelledError } from "@oh-my-pi/pi-coding-agent/modes/controllers/mcp-command-controller";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";

describe("shared MCP interactive OAuth", () => {
	test("reports preflight cancellation through the controller's shared cancellation type", async () => {
		const abort = new AbortController();
		abort.abort();

		const error = await runMCPInteractiveOAuth({
			serverName: "example",
			configured: {},
			authStorage: {} as AuthStorage,
			interaction: {
				onAuthorization: () => {},
				onProgress: () => {},
				requestManualInput: async () => "",
				onComplete: () => {},
			},
			owner: {},
			signal: abort.signal,
		}).catch(reason => reason);

		expect(error).toBeInstanceOf(MCPOAuthCancelledError);
		expect(error).toBeInstanceOf(ControllerOAuthCancelledError);
	});

	test("releases the shared flow slot when flow construction fails", async () => {
		const owner = {};
		const attempt = () =>
			runMCPInteractiveOAuth({
				serverName: "example",
				serverUrl: "https://mcp.example.com/mcp",
				// HTTPS loopback redirects require a separate callbackPort; the flow
				// constructor rejects this synchronously.
				configured: { redirectUri: "https://localhost:3000/callback" },
				oauthEndpoints: {
					authorizationUrl: "https://auth.example.com/authorize",
					tokenUrl: "https://auth.example.com/token",
				},
				authStorage: {} as AuthStorage,
				interaction: {
					onAuthorization: () => {},
					onProgress: () => {},
					requestManualInput: async () => "",
					onComplete: () => {},
				},
				owner,
			});

		await expect(attempt()).rejects.toThrow("callbackPort");
		// A leaked slot makes every later attempt for the same owner wait on the
		// abandoned flow forever. With endpoints supplied and construction failing,
		// the attempt is microtask-only, so one scheduler turn (no wall-clock delay)
		// is enough for it to settle; a pending promise here means the slot leaked.
		const second = attempt().then(
			() => "resolved",
			(error: Error) => error.message,
		);
		await new Promise<void>(resolve => setImmediate(resolve));
		expect(Bun.peek.status(second)).toBe("fulfilled");
		expect(await second).toContain("callbackPort");
	});
});
