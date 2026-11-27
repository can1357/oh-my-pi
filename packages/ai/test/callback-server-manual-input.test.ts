import { describe, expect, it } from "bun:test";
import { OAuthError } from "@oh-my-pi/pi-ai/error";
import { OAuthCallbackFlow } from "@oh-my-pi/pi-ai/registry/oauth/callback-server";
import type { OAuthCredentials } from "@oh-my-pi/pi-ai/registry/oauth/types";

class TestCallbackFlow extends OAuthCallbackFlow {
	override generateState(): string {
		return "flow-state";
	}

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

	it("ends the login when the pasted redirect reports a denied consent for this flow", async () => {
		const flow = new TestCallbackFlow(
			{
				onAuth: () => {},
				onManualCodeInput: async () => "http://127.0.0.1:5/oauth2callback?error=access_denied&state=flow-state",
				signal: AbortSignal.timeout(1_000),
			},
			{ preferredPort: 0 },
		);

		const error = await flow.login().catch((caught: unknown) => caught);

		expect(error).toBeInstanceOf(OAuthError);
		expect(error instanceof OAuthError && error.code).toBe("access_denied");
	});

	it("ignores a pasted denial carrying another flow's state", async () => {
		const attempts = [
			"http://127.0.0.1:5/oauth2callback?error=access_denied&state=other-flow",
			"http://127.0.0.1:5/oauth2callback?code=good-code&state=flow-state",
		];
		let promptCount = 0;
		const flow = new TestCallbackFlow(
			{
				onAuth: () => {},
				onManualCodeInput: async () => attempts[promptCount++] ?? "",
				signal: AbortSignal.timeout(1_000),
			},
			{ preferredPort: 0 },
		);

		const credentials = await flow.login();

		expect(promptCount).toBe(2);
		expect(credentials.access).toBe("access-good-code");
	});
});
