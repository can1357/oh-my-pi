import { describe, expect, it } from "bun:test";
import { PendingAttaches } from "./pending-attaches";

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
});
