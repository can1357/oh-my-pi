import { describe, expect, it } from "bun:test";
import {
	nextOrphanSweepDeadline,
	orphanSweepAlarmDelayMinutes,
	orphanSweepSeesRelayDisconnected,
	shouldProceedWithOrphanSweep,
	shouldRunOrphanSweep,
} from "../../../browser-relay/extension/orphan-sweep";

describe("browser relay orphan sweep scheduling", () => {
	it("starts the grace deadline when tracked attachments first become orphaned", () => {
		expect(
			nextOrphanSweepDeadline({
				nowMs: 1_000,
				graceMs: 30_000,
				disconnected: true,
				hasTrackedAttachments: true,
				existingDeadlineMs: null,
			}),
		).toBe(31_000);
	});

	it("preserves the original deadline across repeated disconnect handling", () => {
		expect(
			nextOrphanSweepDeadline({
				nowMs: 20_000,
				graceMs: 30_000,
				disconnected: true,
				hasTrackedAttachments: true,
				existingDeadlineMs: 31_000,
			}),
		).toBe(31_000);
	});

	it("clears the deadline when the relay reconnects or no tracked attachments remain", () => {
		expect(
			nextOrphanSweepDeadline({
				nowMs: 20_000,
				graceMs: 30_000,
				disconnected: false,
				hasTrackedAttachments: true,
				existingDeadlineMs: 31_000,
			}),
		).toBeNull();
		expect(
			nextOrphanSweepDeadline({
				nowMs: 20_000,
				graceMs: 30_000,
				disconnected: true,
				hasTrackedAttachments: false,
				existingDeadlineMs: 31_000,
			}),
		).toBeNull();
	});

	it("runs the reclaim only once the persisted deadline has actually expired", () => {
		expect(
			shouldRunOrphanSweep({
				nowMs: 30_999,
				deadlineMs: 31_000,
				disconnected: true,
				hasTrackedAttachments: true,
			}),
		).toBe(false);
		expect(
			shouldRunOrphanSweep({
				nowMs: 31_000,
				deadlineMs: 31_000,
				disconnected: true,
				hasTrackedAttachments: true,
			}),
		).toBe(true);
	});

	it("keeps the follow-up alarm delay positive even when the deadline is already due", () => {
		expect(orphanSweepAlarmDelayMinutes(31_000, 1_000)).toBeCloseTo(0.5, 5);
		expect(orphanSweepAlarmDelayMinutes(31_000, 31_500)).toBe(0.01);
	});

	it("treats only an OPEN socket as owning orphan reconciliation", () => {
		expect(
			orphanSweepSeesRelayDisconnected({
				socketReadyState: null,
				openReadyState: 1,
			}),
		).toBe(true);
		expect(
			orphanSweepSeesRelayDisconnected({
				socketReadyState: 0,
				openReadyState: 1,
			}),
		).toBe(true);
		expect(
			orphanSweepSeesRelayDisconnected({
				socketReadyState: 1,
				openReadyState: 1,
			}),
		).toBe(false);
	});

	it("lets onSuspend force a disconnected deadline even before onclose updates the socket", () => {
		expect(
			orphanSweepSeesRelayDisconnected({
				socketReadyState: 1,
				openReadyState: 1,
				forceDisconnected: true,
			}),
		).toBe(true);
	});

	it("revalidates reconnects before executing an expired orphan sweep", () => {
		expect(
			shouldProceedWithOrphanSweep({
				disconnected: true,
				hasTrackedAttachments: true,
			}),
		).toBe(true);
		expect(
			shouldProceedWithOrphanSweep({
				disconnected: false,
				hasTrackedAttachments: true,
			}),
		).toBe(false);
		expect(
			shouldProceedWithOrphanSweep({
				disconnected: true,
				hasTrackedAttachments: false,
			}),
		).toBe(false);
	});
});
