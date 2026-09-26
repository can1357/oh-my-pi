import { describe, expect, it, vi } from "bun:test";
import { pollOAuthDeviceCodeFlow } from "@oh-my-pi/pi-ai/oauth";

describe("OAuth device-code polling", () => {
	it("exports the legacy device-code poll helper for external providers", async () => {
		const value = await pollOAuthDeviceCodeFlow({
			poll: () => ({ status: "complete", value: { access: "token" } }),
		});

		expect(value).toEqual({ access: "token" });
	});

	it("surfaces provider failure messages", async () => {
		await expect(
			pollOAuthDeviceCodeFlow({
				poll: () => ({ status: "failed", message: "authorization denied" }),
			}),
		).rejects.toThrow("authorization denied");
	});

	it("keeps a successful poll that finishes after the deadline", async () => {
		let now = 1_000;
		const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
		try {
			const value = await pollOAuthDeviceCodeFlow({
				expiresInSeconds: 1,
				poll: () => {
					now = 2_001;
					return { status: "complete", value: "authorized" };
				},
			});
			expect(value).toBe("authorized");
		} finally {
			clock.mockRestore();
		}
	});

	it("prefers caller cancellation over a completed poll", async () => {
		const controller = new AbortController();
		await expect(
			pollOAuthDeviceCodeFlow({
				signal: controller.signal,
				poll: () => {
					controller.abort();
					return { status: "complete", value: "authorized" };
				},
			}),
		).rejects.toThrow("Login cancelled");
	});

	it("times out pending device flows", async () => {
		await expect(
			pollOAuthDeviceCodeFlow({
				expiresInSeconds: 0.001,
				poll: () => ({ status: "pending" }),
			}),
		).rejects.toThrow("Device flow timed out");
	});
});
