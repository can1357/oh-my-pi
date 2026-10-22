import { describe, expect, it } from "bun:test";
import {
	applyHelloTabActivation,
	applyHelloTabChanges,
	filterHelloTabIds,
	invalidatesHelloReconciliation,
	shouldSuppressHelloSnapshot,
} from "./hello-refresh";

describe("hello refresh invalidation", () => {
	it("treats URL and group changes as reconciliation state", () => {
		expect(invalidatesHelloReconciliation({ url: "https://example.com/next" })).toBe(true);
		expect(invalidatesHelloReconciliation({ groupId: -1 })).toBe(true);
	});

	it("keeps cosmetic tab churn metadata-only", () => {
		expect(invalidatesHelloReconciliation({})).toBe(false);
	});

	it("suppresses the first stale reconciliation snapshot but bounds continuous churn", () => {
		expect(shouldSuppressHelloSnapshot(false, true, false)).toBe(true);
		expect(shouldSuppressHelloSnapshot(false, true, true)).toBe(false);
	});

	it("never permits a stale attachment snapshot", () => {
		expect(shouldSuppressHelloSnapshot(true, false, false)).toBe(true);
		expect(shouldSuppressHelloSnapshot(true, true, true)).toBe(true);
	});

	it("overlays tab lifecycle events on an in-flight hello snapshot", () => {
		const changes = new Map<number, { tabId: number; title: string } | null>([
			[1, null],
			[2, { tabId: 2, title: "newer" }],
			[3, { tabId: 3, title: "created" }],
		]);
		expect(
			applyHelloTabChanges(
				[
					{ tabId: 1, title: "removed" },
					{ tabId: 2, title: "stale" },
				],
				changes,
			),
		).toEqual([
			{ tabId: 2, title: "newer" },
			{ tabId: 3, title: "created" },
		]);
	});

	it("drops attachment state for tabs removed after the snapshot", () => {
		expect(filterHelloTabIds([1, 2], [{ tabId: 2 }, { tabId: 3 }])).toEqual([2]);
	});

	it("overlays tab activation on every tab in the affected window", () => {
		expect(
			applyHelloTabActivation(
				[
					{ tabId: 1, windowId: 10, active: true },
					{ tabId: 2, windowId: 10, active: false },
					{ tabId: 3, windowId: 20, active: true },
				],
				10,
				2,
			),
		).toEqual([
			{ tabId: 1, windowId: 10, active: false },
			{ tabId: 2, windowId: 10, active: true },
			{ tabId: 3, windowId: 20, active: true },
		]);
	});
});
