import { describe, expect, it } from "bun:test";
import {
	finalizePendingAttach,
	PendingAttaches,
	type PendingAttachToken,
} from "./pending-attaches";

describe("PendingAttaches", () => {
	it("keeps a replacement attach cancellable after the older operation settles", () => {
		const pending = new PendingAttaches();
		const first = pending.begin(1);
		pending.cancel(1, 2);
		const replacement = pending.begin(1);

		pending.finish(1, first);
		expect(pending.has(1)).toBe(true);
		expect(first.canceledAtEpoch).toBe(2);
		expect(replacement.canceled).toBe(false);
		expect(replacement.canceledAtEpoch).toBeNull();

		pending.cancel(1, 4);
		expect(replacement.canceled).toBe(true);
		expect(replacement.canceledAtEpoch).toBe(4);
	});

	it("rejects a detach that lands while final attach state is persisted", async () => {
		const persist = Promise.withResolvers<void>();
		const operation: PendingAttachToken = {
			canceled: false,
			canceledAtEpoch: null,
		};
		let canceled = false;
		const finalized = finalizePendingAttach(
			operation,
			() => persist.promise,
			async () => {
				canceled = true;
			},
		);

		operation.canceled = true;
		operation.canceledAtEpoch = 2;
		persist.resolve();

		await expect(finalized).rejects.toThrow(
			"debugger attachment detached before attach completed",
		);
		expect(canceled).toBe(true);
	});
});
