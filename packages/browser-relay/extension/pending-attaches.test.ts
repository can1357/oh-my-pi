import { describe, expect, it } from "bun:test";
import { PendingAttaches } from "./pending-attaches";

describe("PendingAttaches", () => {
	it("keeps a replacement attach cancellable after the older operation settles", () => {
		const pending = new PendingAttaches();
		const first = pending.begin(1);
		pending.cancel(1);
		const replacement = pending.begin(1);

		pending.finish(1, first);
		expect(pending.has(1)).toBe(true);
		expect(replacement.canceled).toBe(false);

		pending.cancel(1);
		expect(replacement.canceled).toBe(true);
	});
});
