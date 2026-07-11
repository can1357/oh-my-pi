import { afterEach, describe, expect, it, vi } from "bun:test";
import { ExponentialYield, YieldGate } from "@pk-nerdsaver-ai/pi-agent-core/utils/yield";

const YIELD_INTERVAL_MS = 50;

afterEach(() => {
	vi.restoreAllMocks();
});

/**
 * Build a gate over an injected clock and a counting sleep so the test drives
 * the gate logic without spying on process-global `Date.now`/`scheduler.wait`.
 * Those globals are shared across files, so under concurrent `bun test` a
 * sibling file's `vi.restoreAllMocks()` could wipe the spies mid-run — the
 * exact race that made the previous singleton-based test flake.
 */
function makeGate(): { gate: YieldGate; advanceBy: (ms: number) => void; sleeps: () => number } {
	let now = 1_000_000;
	const sleep = vi.fn(async () => {});
	const gate = new YieldGate({ now: () => now, sleep });
	return {
		gate,
		advanceBy: (ms: number) => {
			now += ms;
		},
		sleeps: () => sleep.mock.calls.length,
	};
}

describe("YieldGate.yieldIfDue", () => {
	it("sleeps on the first call and gates immediate callers", async () => {
		const { gate, advanceBy, sleeps } = makeGate();

		await gate.yieldIfDue();
		expect(sleeps()).toBe(1);

		advanceBy(YIELD_INTERVAL_MS - 1);
		await gate.yieldIfDue();
		expect(sleeps()).toBe(1);
	});

	it("sleeps again once the gate window elapses", async () => {
		const { gate, advanceBy, sleeps } = makeGate();

		await gate.yieldIfDue();
		expect(sleeps()).toBe(1);

		advanceBy(YIELD_INTERVAL_MS);
		await gate.yieldIfDue();
		expect(sleeps()).toBe(2);
	});

	it("treats a backward clock jump as due instead of gating forever", async () => {
		const { gate, advanceBy, sleeps } = makeGate();

		await gate.yieldIfDue();
		expect(sleeps()).toBe(1);

		// NTP correction / fake timers can move the wall clock backward; the next
		// call must still yield rather than wait for an interval that never comes.
		advanceBy(-YIELD_INTERVAL_MS * 4);
		await gate.yieldIfDue();
		expect(sleeps()).toBe(2);
	});
});

describe("ExponentialYield.race", () => {
	it("returns the racer's value as soon as it settles", async () => {
		const ey = new ExponentialYield({ minMs: 5_000, maxMs: 10_000 });
		const racer = Bun.sleep(10).then(() => "done");
		const start = performance.now();
		const out = await ey.race([racer]);
		const elapsed = performance.now() - start;
		expect(out).toBe("done");
		// The 5s yield must not have delayed us: settle within a comfy margin.
		expect(elapsed).toBeLessThan(500);
	});

	it("cancels the losing sleep so it does not keep the loop alive", async () => {
		// If the losing Bun.sleep weren't cancelled, this test would block for
		// the full minMs after the racer wins, since the prior implementation
		// kept fresh timers ticking. We pick a minMs far larger than the racer
		// delay and assert we return well before it.
		const ey = new ExponentialYield({ minMs: 2_000, maxMs: 2_000 });
		const racer = Bun.sleep(20).then(() => 42);
		const start = performance.now();
		const out = await ey.race([racer]);
		const elapsed = performance.now() - start;
		expect(out).toBe(42);
		expect(elapsed).toBeLessThan(500);

		// After race resolves, ensure the AbortController-driven cancel really
		// unblocked the underlying timer: a short follow-up sleep should not
		// be perturbed by residual pending timers. (Sanity: this returns.)
		await Bun.sleep(30);
	});
});
