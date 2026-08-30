import { describe, expect, it } from "bun:test";
import { filterFreshAttachmentState, noteAttachmentStateChange, snapshotAttachmentState } from "./attachment-state";

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
});
