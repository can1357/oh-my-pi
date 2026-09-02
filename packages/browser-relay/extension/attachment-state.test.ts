import { describe, expect, it } from "bun:test";
import {
	consumeRelayInitiatedDetach,
	filterFreshAttachmentState,
	noteAttachmentStateChange,
	snapshotAttachmentState,
} from "./attachment-state";

describe("attachment-state", () => {
	it("keeps unrelated attached tabs fresh when one tab changes after a shared snapshot", () => {
		const epochs = new Map<number, number>();
		const tabIds = [11, 22, 33];
		const snapshot = snapshotAttachmentState(epochs, tabIds);

		noteAttachmentStateChange(epochs, 22);

		expect(filterFreshAttachmentState(epochs, snapshot, tabIds)).toEqual([11, 33]);
	});

	it("drops every tab when the caller freshness gate is already invalid", () => {
		const epochs = new Map<number, number>();
		const tabIds = [1, 2];
		const snapshot = snapshotAttachmentState(epochs, tabIds);

		noteAttachmentStateChange(epochs, 1);
		noteAttachmentStateChange(epochs, 2);

		expect(filterFreshAttachmentState(epochs, snapshot, tabIds)).toEqual([]);
	});

	it("lets user detach reasons override an in-flight relay marker", () => {
		for (const reason of ["canceled_by_user", "replaced_with_devtools"]) {
			const markedTabs = new Set([1]);
			expect(consumeRelayInitiatedDetach(markedTabs, 1, reason)).toBe(false);
			expect(markedTabs.has(1)).toBe(false);
		}
	});

	it("retains relay attribution for non-user detach reasons", () => {
		const markedTabs = new Set([1]);
		expect(consumeRelayInitiatedDetach(markedTabs, 1, "target_closed")).toBe(
			true,
		);
		expect(markedTabs.has(1)).toBe(false);
	});
});
