import { describe, expect, it } from "bun:test";
import {
	nextOrphanSweepDeadline,
	orphanSweepAlarmDelayMinutes,
	orphanSweepSeesRelayDisconnected,
	restoreOrphanSweepDeadline,
	runAfterStartupReconciliation,
	seedOrphanSweepDeadline,
	serializeOrphanSweepDeadlineUpdate,
	shouldProceedWithOrphanSweep,
	shouldRunOrphanSweep,
} from "../../../browser-relay/extension/orphan-sweep";

function deferred<T>() {
	const { promise, resolve } = Promise.withResolvers<T>();
	return { promise, resolve };
}

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
				connectionReplaced: false,
			}),
		).toBe(true);
		expect(
			shouldProceedWithOrphanSweep({
				disconnected: false,
				hasTrackedAttachments: true,
				connectionReplaced: false,
			}),
		).toBe(false);
		expect(
			shouldProceedWithOrphanSweep({
				disconnected: true,
				hasTrackedAttachments: false,
				connectionReplaced: false,
			}),
		).toBe(false);
	});

	it("vetoes an expired sweep when a reconnect/disconnect cycle replaced the connection", () => {
		// The stale sweep still sees the relay disconnected with the same tabs
		// attached — only the connection generation reveals that a fresh grace
		// period was armed while setOrphanSweepDeadline(null) was in flight.
		expect(
			shouldProceedWithOrphanSweep({
				disconnected: true,
				hasTrackedAttachments: true,
				connectionReplaced: true,
			}),
		).toBe(false);
	});

	it("does not persist a stale clear over a newer deadline", async () => {
		const clear = deferred<void>();
		const persisted: Array<number | null> = [];
		const repaired: number[] = [];
		let generation = 1;
		let pending = serializeOrphanSweepDeadlineUpdate(
			Promise.resolve(),
			clear.promise,
			() => generation === 1,
			async () => {
				persisted.push(null);
			},
			() => repaired.push(31_000),
		);

		generation = 2;
		pending = serializeOrphanSweepDeadlineUpdate(
			pending,
			Promise.resolve(),
			() => generation === 2,
			async () => {
				persisted.push(31_000);
			},
			() => repaired.push(31_000),
		);

		clear.resolve();
		await pending;

		expect(repaired).toEqual([31_000]);
		expect(persisted).toEqual([31_000]);
	});

	it("rejects when the authoritative deadline persistence fails", async () => {
		const pending = serializeOrphanSweepDeadlineUpdate(
			Promise.resolve(),
			Promise.resolve(),
			() => true,
			async () => {
				throw new Error("deadline write failed");
			},
			() => {},
		);
		await expect(pending).rejects.toThrow("deadline write failed");
	});

	it("does not restore a stale startup deadline after a newer update", () => {
		expect(restoreOrphanSweepDeadline(31_000, false)).toBeUndefined();
		expect(restoreOrphanSweepDeadline(31_000, true)).toBe(31_000);
		expect(restoreOrphanSweepDeadline(null, true)).toBeNull();
	});

	it("makes an alarm seed newer than an in-flight startup restoration", () => {
		const seeded = seedOrphanSweepDeadline(null, 31_000, 0);

		expect(seeded).toEqual({ deadlineMs: 31_000, generation: 1 });
		expect(restoreOrphanSweepDeadline(null, seeded.generation === 0)).toBeUndefined();
		expect(seedOrphanSweepDeadline(31_000, 61_000, 1)).toEqual({
			deadlineMs: 31_000,
			generation: 1,
		});
	});

	it("waits for startup ownership reconciliation before consuming an alarm", async () => {
		const startup = deferred<void>();
		let swept = false;
		const run = runAfterStartupReconciliation(
			() => startup.promise,
			async () => {
				swept = true;
			},
		);

		await Promise.resolve();
		expect(swept).toBe(false);
		startup.resolve();
		await run;
		expect(swept).toBe(true);
	});
});
