import { describe, expect, it } from "bun:test";
import { pollOAuthDeviceCodeFlow } from "@oh-my-pi/pi-ai/oauth";

describe("OAuth device-code polling", () => {
	it("exports the legacy device-code poll helper for external providers", async () => {
		const value = await pollOAuthDeviceCodeFlow({
			poll: () => ({ status: "complete", value: { access: "token" } }),
		});

		expect(value).toEqual({ access: "token" });
	});

	it("surfaces provider failure messages", async () => {
		expect(
			pollOAuthDeviceCodeFlow({
				poll: () => ({ status: "failed", message: "authorization denied" }),
			}),
		).rejects.toThrow("authorization denied");
	});

	it("times out pending device flows", async () => {
		expect(
			pollOAuthDeviceCodeFlow({
				expiresInSeconds: 0.001,
				poll: () => ({ status: "pending" }),
			}),
		).rejects.toThrow("Device flow timed out");
	});
});
