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
});
