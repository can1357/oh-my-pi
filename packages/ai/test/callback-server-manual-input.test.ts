import { describe, expect, it } from "bun:test";
import { OAuthCallbackFlow } from "@oh-my-pi/pi-ai/registry/oauth/callback-server";
import type { OAuthCredentials } from "@oh-my-pi/pi-ai/registry/oauth/types";

class TestCallbackFlow extends OAuthCallbackFlow {
	async generateAuthUrl(_state: string, redirectUri: string): Promise<{ url: string; instructions?: string }> {
		return { url: `${redirectUri}?start=1` };
	}

	async exchangeToken(code: string, _state: string, _redirectUri: string): Promise<OAuthCredentials> {
		return {
			access: `access-${code}`,
			refresh: "refresh-token",
			expires: Date.now() + 60_000,
		};
	}
}

describe("OAuthCallbackFlow manual input retries", () => {
	it("retries manual input until a valid callback payload is provided", async () => {
		const attempts = ["http://localhost/callback?state=missing-code", "http://localhost/callback?code=valid-code"];
		let promptCount = 0;

		const flow = new TestCallbackFlow(
			{
				onAuth: () => {},
				onManualCodeInput: async () => {
					const value = attempts[promptCount];
					promptCount += 1;
					if (!value) {
						throw new Error("unexpected extra manual input request");
					}
					return value;
				},
				signal: AbortSignal.timeout(1_000),
			},
			14555,
		);

		const credentials = await flow.login();

		expect(promptCount).toBe(2);
		expect(credentials.access).toBe("access-valid-code");
	});

	it("does not reopen the prompt after manual input rejects", async () => {
		const promptError = new Error("manual input dismissed");
		let promptCount = 0;
		const flow = new TestCallbackFlow(
			{
				onAuth: () => {},
				onManualCodeInput: async () => {
					promptCount += 1;
					throw promptError;
				},
			},
			{
				preferredPort: 0,
				redirectUri: "test-oauth://callback",
				manualInputOnly: true,
			},
		);

		const error = await flow.login().catch((caught: unknown) => caught);

		expect(error).toBe(promptError);
		expect(promptCount).toBe(1);
	});

	it("retries when manual callback state does not match", async () => {
		const attempts = [
			"http://localhost/callback?code=first-code&state=wrong-state",
			"http://localhost/callback?code=second-code",
		];
		let promptCount = 0;

		const flow = new TestCallbackFlow(
			{
				onAuth: () => {},
				onManualCodeInput: async () => {
					const value = attempts[promptCount];
					promptCount += 1;
					if (!value) {
						throw new Error("unexpected extra manual input request");
					}
					return value;
				},
				signal: AbortSignal.timeout(1_000),
			},
			14556,
		);

		const credentials = await flow.login();

		expect(promptCount).toBe(2);
		expect(credentials.access).toBe("access-second-code");
	});
});
