import { describe, expect, it } from "bun:test";
import {
	ORPHAN_SWEEP_GRACE_MS,
	OrphanSweep,
	type OrphanSweepTimers,
} from "@oh-my-pi/pi-coding-agent/tools/browser/relay/orphan-sweep";

class FakeTimers implements OrphanSweepTimers {
	#next = 0;
	readonly pending = new Map<number, { run: () => void; ms: number }>();

	setTimeout(run: () => void, ms: number): unknown {
		const handle = ++this.#next;
		this.pending.set(handle, { run, ms });
		return handle;
	}

	clearTimeout(handle: unknown): void {
		this.pending.delete(Number(handle));
	}

	fire(): void {
		const due = [...this.pending.values()];
		this.pending.clear();
		for (const timer of due) timer.run();
	}

	get count(): number {
		return this.pending.size;
	}
}

function sweepSpy(): { sweep: () => Promise<void>; calls: () => number } {
	let calls = 0;
	return {
		sweep: async () => {
			calls++;
		},
		calls: () => calls,
	};
}

describe("relay orphan sweep", () => {
	it("sweeps once the relay has been away for the grace period", async () => {
		const timers = new FakeTimers();
		const spy = sweepSpy();
		const sweep = new OrphanSweep(spy.sweep, ORPHAN_SWEEP_GRACE_MS, timers);
		sweep.disconnected();
		expect(timers.count).toBe(1);
		expect([...timers.pending.values()][0]?.ms).toBe(ORPHAN_SWEEP_GRACE_MS);
		expect(spy.calls()).toBe(0);
		timers.fire();
		await Promise.resolve();
		expect(spy.calls()).toBe(1);
	});

	it("cancels the sweep when the relay reconnects in time", async () => {
		const timers = new FakeTimers();
		const spy = sweepSpy();
		const sweep = new OrphanSweep(spy.sweep, 1000, timers);
		sweep.disconnected();
		sweep.connected();
		expect(timers.count).toBe(0);
		timers.fire();
		await Promise.resolve();
		expect(spy.calls()).toBe(0);
	});

	it("arms only one timer across repeated disconnects", () => {
		const timers = new FakeTimers();
		const sweep = new OrphanSweep(sweepSpy().sweep, 1000, timers);
		sweep.disconnected();
		sweep.disconnected();
		expect(timers.count).toBe(1);
	});

	it("does not let a timer armed before a reconnect sweep a later disconnect early", async () => {
		const timers = new FakeTimers();
		const spy = sweepSpy();
		const sweep = new OrphanSweep(spy.sweep, 1000, timers);
		sweep.disconnected();
		const stale = [...timers.pending.values()][0]!;
		sweep.connected();
		sweep.disconnected();
		stale.run();
		await Promise.resolve();
		expect(spy.calls()).toBe(0);
	});

	it("sweeps immediately on suspend and leaves no timer behind", async () => {
		const timers = new FakeTimers();
		const spy = sweepSpy();
		const sweep = new OrphanSweep(spy.sweep, 1000, timers);
		sweep.disconnected();
		await sweep.suspend();
		expect(spy.calls()).toBe(1);
		expect(timers.count).toBe(0);
		timers.fire();
		await Promise.resolve();
		expect(spy.calls()).toBe(1);
	});
});
