import { describe, expect, it } from "bun:test";
import {
	consumeRelayInitiatedDetach,
	createRetryableLoader,
	extensionOwnedAttachedTabIds,
	filterFreshAttachmentState,
	isAttachmentStateCurrent,
	noteAttachmentStateChange,
	requireRecoveryStateLoaded,
	restoreRecoverableState,
	serializeRecoverableStateUpdate,
	shouldRetrackAfterDetachFailure,
	snapshotAttachmentState,
} from "./attachment-state";

describe("attachment-state", () => {
	it("keeps unrelated attached tabs fresh when one tab changes after a shared snapshot", () => {
		const epochs = new Map<number, number>();
		const tabIds = [11, 22, 33];
		const snapshot = snapshotAttachmentState(epochs, tabIds);

		noteAttachmentStateChange(epochs, 22);

		expect(filterFreshAttachmentState(epochs, snapshot, tabIds)).toEqual([
			11, 33,
		]);
	});

	it("drops every tab when the caller freshness gate is already invalid", () => {
		const epochs = new Map<number, number>();
		const tabIds = [1, 2];
		const snapshot = snapshotAttachmentState(epochs, tabIds);

		noteAttachmentStateChange(epochs, 1);
		noteAttachmentStateChange(epochs, 2);

		expect(filterFreshAttachmentState(epochs, snapshot, tabIds)).toEqual([]);
	});

	it("invalidates a guard retry snapshot when the user detaches", () => {
		const epochs = new Map<number, number>();
		const snapshot = snapshotAttachmentState(epochs, [1]);

		noteAttachmentStateChange(epochs, 1);

		expect(filterFreshAttachmentState(epochs, snapshot, [1])).toEqual([]);
	});

	it("keeps canceled attach cleanup from deleting replacement ownership", () => {
		const epochs = new Map<number, number>();
		noteAttachmentStateChange(epochs, 1);
		// Chrome reports the cancellation. Cleanup is valid at this epoch.
		noteAttachmentStateChange(epochs, 1);
		const canceledAtEpoch = epochs.get(1) ?? 0;
		expect(isAttachmentStateCurrent(epochs, 1, canceledAtEpoch)).toBe(true);

		// A replacement attach takes ownership before canceled cleanup resumes.
		noteAttachmentStateChange(epochs, 1);

		expect(isAttachmentStateCurrent(epochs, 1, canceledAtEpoch)).toBe(false);
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

	it("preserves detach retry state when target discovery fails", () => {
		expect(shouldRetrackAfterDetachFailure(null, 1)).toBe(true);
		expect(
			shouldRetrackAfterDetachFailure(
				[
					{ tabId: 1, attached: true },
					{ tabId: 2, attached: false },
				],
				1,
			),
		).toBe(true);
		expect(
			shouldRetrackAfterDetachFailure([{ tabId: 1, attached: false }], 1),
		).toBe(false);
	});

	it("repairs an older recoverable-state write that settles after a user detach", async () => {
		const firstWrite = Promise.withResolvers<void>();
		const detachedWrite = Promise.withResolvers<void>();
		const persisted: number[][] = [];
		let generation = 1;
		let pending = serializeRecoverableStateUpdate(
			Promise.resolve(),
			firstWrite.promise,
			() => generation === 1,
			async () => {
				persisted.push([1]);
			},
		);

		generation = 2;
		pending = serializeRecoverableStateUpdate(
			pending,
			detachedWrite.promise,
			() => generation === 2,
			async () => {
				persisted.push([]);
			},
		);
		detachedWrite.resolve();
		firstWrite.resolve();
		await pending;

		expect(persisted).toEqual([[]]);
	});

	it("rejects when the final ownership persistence fails", async () => {
		const pending = serializeRecoverableStateUpdate(
			Promise.resolve(),
			Promise.reject(new Error("immediate write failed")),
			() => true,
			async () => {
				throw new Error("final write failed");
			},
		);
		await expect(pending).rejects.toThrow("final write failed");
	});

	it("restores only startup ids unaffected by concurrent ownership changes", () => {
		const current = new Set<number>();
		restoreRecoverableState(current, [1, 2, "invalid"], new Set([1]));
		expect([...current]).toEqual([2]);
	});

	it("filters hello and orphan reconciliation to extension-owned attachments", () => {
		expect(
			extensionOwnedAttachedTabIds(
				[
					{ tabId: 1, attached: true },
					{ tabId: 2, attached: true },
					{ tabId: 3, attached: false },
				],
				new Set([1, 3]),
			),
		).toEqual([1]);
	});

	it("rejects an unknown startup recovery state instead of treating it as empty", () => {
		expect(() => requireRecoveryStateLoaded(false)).toThrow(
			"browser relay recovery state failed to load",
		);
		expect(() => requireRecoveryStateLoaded(true)).not.toThrow();
	});

	it("retries a transient startup load failure and then caches success", async () => {
		const first = Promise.withResolvers<number>();
		const second = Promise.withResolvers<number>();
		let attempts = 0;
		const load = createRetryableLoader(() => {
			attempts++;
			return attempts === 1 ? first.promise : second.promise;
		});

		const sharedFirst = load();
		expect(load()).toBe(sharedFirst);
		first.reject(new Error("storage unavailable"));
		await expect(sharedFirst).rejects.toThrow("storage unavailable");

		const retry = load();
		expect(attempts).toBe(2);
		second.resolve(42);
		await expect(retry).resolves.toBe(42);
		expect(load()).toBe(retry);
		expect(attempts).toBe(2);
	});
});
