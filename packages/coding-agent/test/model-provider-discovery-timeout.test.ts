import { describe, expect, it } from "bun:test";
import { withModelDiscoveryTimeout } from "@oh-my-pi/pi-coding-agent/config/model-provider-discovery";

describe("withModelDiscoveryTimeout", () => {
	it("aborts the signal passed to run when the timeout expires", async () => {
		let capturedSignal: AbortSignal | undefined;
		let abortedDuringRun = false;

		await expect(
			withModelDiscoveryTimeout(15, signal => {
				capturedSignal = signal;
				return new Promise<string>(() => {
					signal.addEventListener("abort", () => {
						abortedDuringRun = true;
					});
				});
			}),
		).rejects.toThrow("model discovery timed out after 15ms");

		expect(capturedSignal?.aborted).toBe(true);
		expect(abortedDuringRun).toBe(true);
	});

	it("clears the timeout without aborting on fast completion", async () => {
		let capturedSignal: AbortSignal | undefined;
		const value = await withModelDiscoveryTimeout(50, async signal => {
			capturedSignal = signal;
			return "ok";
		});

		expect(value).toBe("ok");
		expect(capturedSignal?.aborted).toBe(false);
		await Bun.sleep(70);
		expect(capturedSignal?.aborted).toBe(false);
	});
});
