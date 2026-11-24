/**
 * Regression: a guest that received `agent_start` over the wire but missed
 * the matching `agent_end` across a reconnect must close its UI state when
 * the next host `state` frame reports the session idle. Without this, the
 * per-session `time_spent` meter and the `Working…` row linger after the host
 * has yielded, so `time_spent` ticks forever and the spinner never stops.
 *
 * The `state`-frame reconciler runs inside `CollabGuestLink.#applyFrame`,
 * which is private — exercising it through the full host/relay/welcome
 * train is heavyweight. The host-idle close logic is therefore extracted
 * as {@link reconcileGuestIdleHostState}; this test drives it directly.
 */
import { describe, expect, it, mock } from "bun:test";
import {
	type GuestSnapshotActivityReconcilerCtx,
	reconcileGuestIdleHostState,
	reconcileGuestSnapshotHostState,
} from "@oh-my-pi/pi-coding-agent/collab/guest";

function makeCtx() {
	const markActivityEnd = mock(() => {});
	const markActivityStart = mock(() => {});
	const clearWorking = mock((_kind?: string) => true);
	const ensureWorkingRow = mock(() => {});
	const ctx: GuestSnapshotActivityReconcilerCtx = {
		statusLine: { markActivityEnd, markActivityStart },
		clearWorking,
		ensureWorkingRow,
	};
	return {
		ctx,
		markActivityEnd,
		markActivityStart,
		clearWorking,
		ensureWorkingRow,
	};
}

describe("reconcileGuestIdleHostState", () => {
	it("closes the active-time window and takes down the turn's working row when the host reports idle", () => {
		const { ctx, markActivityEnd, clearWorking } = makeCtx();
		reconcileGuestIdleHostState(ctx, false);
		expect(markActivityEnd).toHaveBeenCalledTimes(1);
		expect(clearWorking).toHaveBeenCalledTimes(1);
		// Only the turn's row: a compaction or retry row the guest shows is not the turn's.
		expect(clearWorking.mock.calls[0]).toEqual(["turn"]);
	});

	it("is a no-op while the host is still streaming so live turns keep the meter open", () => {
		const { ctx, markActivityEnd, clearWorking } = makeCtx();
		reconcileGuestIdleHostState(ctx, true);
		expect(markActivityEnd).not.toHaveBeenCalled();
		expect(clearWorking).not.toHaveBeenCalled();
	});
});

describe("reconcileGuestSnapshotHostState", () => {
	it("stops the active meter when an idle welcome snapshot finalizes after reconnect", () => {
		const { ctx, markActivityEnd, ensureWorkingRow } = makeCtx();
		reconcileGuestSnapshotHostState(ctx, false);
		expect(markActivityEnd).toHaveBeenCalledTimes(1);
		expect(ensureWorkingRow).not.toHaveBeenCalled();
	});

	it("shows the working row for a streaming snapshot", () => {
		// Regression (F4): a guest that missed the earlier `agent_start` — most
		// often a reconnect dropped it mid-stream — showed no spinner while the
		// host kept working. `ensureWorkingRow` leaves a compaction or retry row
		// that holds the status row in place.
		const { ctx, markActivityStart, ensureWorkingRow, clearWorking } = makeCtx();
		reconcileGuestSnapshotHostState(ctx, true);
		expect(markActivityStart).toHaveBeenCalledTimes(1);
		expect(ensureWorkingRow).toHaveBeenCalledTimes(1);
		expect(clearWorking).not.toHaveBeenCalled();
	});
});
