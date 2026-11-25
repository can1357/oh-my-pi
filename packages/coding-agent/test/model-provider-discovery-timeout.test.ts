import { describe, expect, it } from "bun:test";
import { withModelDiscoveryTimeout } from "@oh-my-pi/pi-coding-agent/config/model-provider-discovery";

describe("withModelDiscoveryTimeout", () => {
	it("aborts the signal passed to run when the timeout expires", async () => {
		let runSettledByAbort = false;

		await expect(
			withModelDiscoveryTimeout(15, signal => {
				const { promise, reject } = Promise.withResolvers<string>();
				signal.addEventListener(
					"abort",
					() => {
						runSettledByAbort = true;
						reject(signal.reason);
					},
					{ once: true },
				);
				return promise;
			}),
		).rejects.toThrow("model discovery timed out after 15ms");

		expect(runSettledByAbort).toBe(true);
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
