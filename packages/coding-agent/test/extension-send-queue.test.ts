import { describe, expect, test } from "bun:test";
import { ExtensionSendQueue } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/send-queue";

describe("ExtensionSendQueue", () => {
	test("a send held by a failed discovery round is rejected instead of starting a turn", async () => {
		const queue = new ExtensionSendQueue();
		let sendStarted = false;
		let heldOutcome: Promise<string> | undefined;

		await expect(
			queue.withHeld(async () => {
				// Callers attach their error handling synchronously, as every mode does.
				heldOutcome = queue
					.dispatch(async () => {
						sendStarted = true;
					})
					.then(
						() => "dispatched",
						(error: Error) => error.message,
					);
				throw new Error("discovery failed");
			}),
		).rejects.toThrow("discovery failed");

		expect(await heldOutcome).toContain("Extension send discarded");
		expect(sendStarted).toBe(false);
	});
});
