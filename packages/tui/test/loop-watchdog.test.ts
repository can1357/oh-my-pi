import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import { LoopWatchdog } from "@oh-my-pi/pi-tui/loop-watchdog";
import {
	currentLoopPhase,
	logger,
	popLoopPhase,
	pushLoopPhase,
	resetLoopPhaseWindow,
	takeLoopPhaseAttribution,
} from "@oh-my-pi/pi-utils";

/**
 * Contract: LoopWatchdog turns event-loop lag into exactly one
 * `logger.warn("ui.loop-blocked", { blockedMs, cpuMs, phase, phaseMs? })` line
 * per block. A tick more than `thresholdMs` past its deadline logs only on the
 * rising edge. Its phase must outweigh unlabeled time after that deadline;
 * only named phases include `phaseMs`. A stopped watchdog emits nothing.
 *
 * Time and the timer are injected so the test drives elapsed time deterministically
 * instead of sleeping. `schedule` captures the armed callback so the test fires
 * ticks by hand; firing re-arms via schedule, so the captured callback always
 * advances to the next pending tick.
 */
function harness(options: Partial<{ intervalMs: number; thresholdMs: number; sleepMs: number }> = {}) {
	let nowValue = 0;
	let scheduled: (() => void) | undefined;
	const now = () => nowValue;
	const schedule = (cb: () => void) => {
		scheduled = cb;
		return {};
	};
	const wd = new LoopWatchdog({ now, schedule, ...options });
	return {
		wd,
		setNow(value: number): void {
			nowValue = value;
		},
		fireTick(): void {
			const cb = scheduled;
			if (!cb) throw new Error("no tick was scheduled");
			cb();
		},
	};
}

function drain(): void {
	resetLoopPhaseWindow();
	while (currentLoopPhase() !== undefined) popLoopPhase();
}
beforeEach(drain);
afterEach(() => {
	vi.restoreAllMocks();
	drain();
});

describe("LoopWatchdog", () => {
	test("logs a named late-window phase with its duration and the rounded overshoot", () => {
		const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
		const { wd, setNow, fireTick } = harness();

		wd.start(); // deadline 250
		setNow(200);
		pushLoopPhase("render");
		setNow(560);
		popLoopPhase();
		fireTick();

		expect(warnSpy).toHaveBeenCalledTimes(1);
		expect(warnSpy.mock.calls[0]).toEqual([
			"ui.loop-blocked",
			{ blockedMs: 310, cpuMs: expect.any(Number), phase: "render", phaseMs: 310 },
		]);
	});

	test("stays silent when a tick fires on its deadline", () => {
		const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
		const { wd, setNow, fireTick } = harness();

		wd.start(); // deadline at 250
		setNow(250); // blockedMs = 0, not a block
		fireTick();

		expect(warnSpy).not.toHaveBeenCalled();
	});

	test("dedupes a sustained block: two consecutive late ticks log only once", () => {
		const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
		const { wd, setNow, fireTick } = harness();

		wd.start(); // deadline at 250
		setNow(250);
		pushLoopPhase("render");
		setNow(600);
		popLoopPhase();
		fireTick();
		setNow(850);
		pushLoopPhase("render");
		setNow(1200); // blockedMs = 350 again, but still blocked → no second log
		popLoopPhase();
		fireTick();

		expect(warnSpy).toHaveBeenCalledTimes(1);
	});

	test("treats a long missed interval as system sleep, not an event-loop block", () => {
		const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
		const { wd, setNow, fireTick } = harness({ sleepMs: 5_000 });

		wd.start(); // deadline at 250
		setNow(10_250); // blockedMs = 10_000 exceeds the sleep cutoff, and no CPU was burned
		fireTick();

		expect(warnSpy).not.toHaveBeenCalled();

		setNow(10_760); // next deadline is 10_500 → a real 260ms stall still reports
		fireTick();
		expect(warnSpy).toHaveBeenCalledTimes(1);
		const [event, ctx] = warnSpy.mock.calls[0] as [string, { blockedMs: number; phase: string }];
		expect(event).toBe("ui.loop-blocked");
		expect(ctx.blockedMs).toBe(260);
	});

	test("emits nothing for a tick that fires after stop()", () => {
		const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
		const { wd, setNow, fireTick } = harness();

		wd.start(); // deadline at 250
		setNow(600); // first block logs once and re-arms a follow-up tick
		fireTick();
		expect(warnSpy).toHaveBeenCalledTimes(1);

		wd.stop();
		setNow(5000); // the already-armed follow-up tick would otherwise be a huge block
		fireTick();

		expect(warnSpy).toHaveBeenCalledTimes(1); // stop() short-circuits the stale tick
	});

	test("stopping the running watchdog disarms phase attribution", () => {
		const { wd, setNow } = harness();
		wd.start();
		wd.stop();
		setNow(250);
		pushLoopPhase("after-stop");
		setNow(600);
		popLoopPhase();
		expect(takeLoopPhaseAttribution()).toBeUndefined();
	});

	test("attributes a synchronous block whose phase was already popped before the tick", () => {
		const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
		const { wd, setNow, fireTick } = harness();

		wd.start(); // deadline 250
		// The balanced span finishes before the delayed tick runs.
		setNow(250);
		pushLoopPhase("ui.select-filter");
		setNow(600);
		popLoopPhase();
		fireTick();

		expect(warnSpy).toHaveBeenCalledTimes(1);
		expect(warnSpy.mock.calls[0]![1]).toEqual({
			blockedMs: 350,
			cpuMs: expect.any(Number),
			phase: "ui.select-filter",
			phaseMs: 350,
		});
	});

	test("a restarted run's span finishing before its deadline leaves a later block unknown", () => {
		const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
		const { wd, setNow, fireTick } = harness();

		wd.start();
		wd.stop();
		pushLoopPhase("ui.transcript-retire");
		popLoopPhase();

		wd.start(); // fresh deadline 250
		pushLoopPhase("ui.select-filter");
		setNow(240);
		popLoopPhase();
		setNow(600);
		fireTick();

		expect(warnSpy).toHaveBeenCalledTimes(1);
		expect(warnSpy.mock.calls[0]![1]).toEqual({
			blockedMs: 350,
			cpuMs: expect.any(Number),
			phase: "unknown",
		});
	});

	test("a restarted run attributes a fresh span covering the late window", () => {
		const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
		const { wd, setNow, fireTick } = harness();

		wd.start();
		wd.stop();
		pushLoopPhase("ui.transcript-retire");
		popLoopPhase();

		wd.start(); // fresh deadline 250
		setNow(250);
		pushLoopPhase("ui.select-filter");
		setNow(600);
		popLoopPhase();
		fireTick();

		expect(warnSpy).toHaveBeenCalledTimes(1);
		expect(warnSpy.mock.calls[0]![1]).toEqual({
			blockedMs: 350,
			cpuMs: expect.any(Number),
			phase: "ui.select-filter",
			phaseMs: 350,
		});
	});

	test("does not misattribute a finished phase to a later phase-less block", () => {
		const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
		const { wd, setNow, fireTick } = harness();

		wd.start(); // deadline 250
		pushLoopPhase("ui.select-filter");
		setNow(240);
		popLoopPhase();
		setNow(250); // on-time tick consumes the window, logs nothing; re-arm 500
		fireTick();
		setNow(900); // block in the next interval with no phase active
		fireTick();

		expect(warnSpy).toHaveBeenCalledTimes(1);
		expect((warnSpy.mock.calls[0]![1] as { phase: string }).phase).toBe("unknown");
	});

	test("re-arms after recovery: late then on-time then late logs twice", () => {
		const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
		const { wd, setNow, fireTick } = harness();

		wd.start(); // deadline 250
		setNow(250);
		pushLoopPhase("render");
		setNow(600); // block #1 (350) → logs; re-arm 850
		popLoopPhase();
		fireTick();
		setNow(850); // on-time → falling edge resets #wasBlocked; re-arm 1100
		fireTick();
		setNow(1100);
		pushLoopPhase("render");
		setNow(1450); // block #2 (350) → logs again
		popLoopPhase();
		fireTick();

		expect(warnSpy).toHaveBeenCalledTimes(2);
	});

	test("consumes different phases on deduped and recovery ticks before a phase-less block", () => {
		const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
		const { wd, setNow, fireTick } = harness();

		wd.start(); // deadline 250
		setNow(250);
		pushLoopPhase("A");
		setNow(600);
		popLoopPhase();
		fireTick(); // A logs; next deadline 850

		setNow(850);
		pushLoopPhase("B");
		setNow(1200);
		popLoopPhase();
		fireTick(); // B consumed without a warning; next deadline 1450

		setNow(1450);
		pushLoopPhase("C");
		setNow(1500);
		popLoopPhase();
		fireTick(); // recovery consumes C; next deadline 1750

		setNow(2100);
		fireTick();

		expect(warnSpy.mock.calls).toEqual([
			["ui.loop-blocked", { blockedMs: 350, cpuMs: expect.any(Number), phase: "A", phaseMs: 350 }],
			["ui.loop-blocked", { blockedMs: 350, cpuMs: expect.any(Number), phase: "unknown" }],
		]);
	});

	test("omits phaseMs when a tiny late label is outweighed by unlabeled work", () => {
		const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
		const { wd, setNow, fireTick } = harness();

		wd.start();
		setNow(599);
		pushLoopPhase("A");
		setNow(600);
		popLoopPhase();
		fireTick();

		expect(warnSpy.mock.calls).toEqual([
			["ui.loop-blocked", { blockedMs: 350, cpuMs: expect.any(Number), phase: "unknown" }],
		]);
	});

	test("stopping a watchdog that never started keeps a running watchdog's attribution", () => {
		const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
		const { wd, setNow, fireTick } = harness();
		const idle = harness().wd;

		wd.start(); // deadline 250
		idle.stop();
		setNow(250);
		pushLoopPhase("A");
		setNow(600);
		popLoopPhase();
		fireTick();

		expect(warnSpy.mock.calls).toEqual([
			["ui.loop-blocked", { blockedMs: 350, cpuMs: expect.any(Number), phase: "A", phaseMs: 350 }],
		]);
	});

	test("a pre-stop tick no-ops after start() -> stop() -> start() and arms no parallel chain", () => {
		const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
		let nowValue = 0;
		const callbacks: Array<() => void> = [];
		const schedule = (cb: () => void) => {
			callbacks.push(cb);
			return {};
		};
		const wd = new LoopWatchdog({ now: () => nowValue, schedule });

		wd.start(); // arms callbacks[0] under generation 0
		const stale = callbacks[callbacks.length - 1]!;
		wd.stop(); // generation bumped
		wd.start(); // arms callbacks[1] under generation 1
		expect(callbacks).toHaveLength(2);

		nowValue = 5000; // the stale callback would otherwise be a huge block
		stale();

		expect(warnSpy).not.toHaveBeenCalled(); // generation mismatch short-circuits
		expect(callbacks).toHaveLength(2); // and it did NOT re-arm a parallel timer chain
	});

	test("unrefs every scheduled timer handle so the always-on probe never holds the process open", () => {
		vi.spyOn(logger, "warn").mockImplementation(() => {});
		const unref = vi.fn();
		let nowValue = 0;
		let cb: (() => void) | undefined;
		const schedule = (c: () => void) => {
			cb = c;
			return { unref };
		};
		const wd = new LoopWatchdog({ now: () => nowValue, schedule });

		wd.start();
		expect(unref).toHaveBeenCalledTimes(1); // armed on start
		nowValue = 600;
		cb?.(); // late tick logs and re-arms
		expect(unref).toHaveBeenCalledTimes(2); // the re-armed handle is unref'd too
	});

	test("stop() cancels the armed timer handle so no stale tick is left pending", () => {
		const cancel = vi.fn();
		const schedule = (_cb: () => void) => ({ cancel });
		const wd = new LoopWatchdog({ now: () => 0, schedule });

		wd.start(); // arms a handle exposing cancel()
		wd.stop();

		expect(cancel).toHaveBeenCalledTimes(1);
	});

	test("isStalled() reports a block while the tick is overdue and for thresholdMs after it runs late", () => {
		// StdinBuffer asks this when an unmarked multiline burst arrives: during
		// or right after a block it is batched typing (Enter must submit), on a
		// responsive loop an input-method commit (one paste). Both orders in which
		// a resumed loop runs the late tick and the stdin read must see the block.
		vi.spyOn(logger, "warn").mockImplementation(() => {});
		const { wd, setNow, fireTick } = harness(); // intervalMs=250, thresholdMs=250

		wd.start(); // deadline 250
		setNow(400); // 150ms overdue: a busy frame, not a stall
		expect(wd.isStalled()).toBe(false);
		setNow(560); // 310ms overdue and the tick has not run yet: blocked now
		expect(wd.isStalled()).toBe(true);

		fireTick(); // the late tick ends the block at 560 and re-arms for 810
		setNow(800); // 240ms after the block ended
		expect(wd.isStalled()).toBe(true);
		setNow(811); // past the grace window, next tick barely due
		expect(wd.isStalled()).toBe(false);

		wd.stop();
		setNow(5_000); // a stopped watchdog's stale deadline is not a stall
		expect(wd.isStalled()).toBe(false);
	});
});

/**
 * A long overshoot is classified by CPU time, not by duration. System sleep and
 * a CPU-bound wedge both produce an arbitrarily large gap, so duration alone
 * cannot separate them — and suppressing on duration discards exactly the worst
 * stalls. Issue #5372 reported an 82,391ms block that older builds logged and
 * current builds drop silently.
 */
describe("LoopWatchdog long-block classification", () => {
	function cpuHarness(options: Partial<{ intervalMs: number; thresholdMs: number; sleepMs: number }> = {}) {
		let nowValue = 0;
		let cpuValue = 0;
		let scheduled: (() => void) | undefined;
		const wd = new LoopWatchdog({
			now: () => nowValue,
			cpuNow: () => cpuValue,
			schedule: (cb: () => void) => {
				scheduled = cb;
				return {};
			},
			...options,
		});
		return {
			wd,
			set(now: number, cpu: number): void {
				nowValue = now;
				cpuValue = cpu;
			},
			fireTick(): void {
				const cb = scheduled;
				if (!cb) throw new Error("no tick was scheduled");
				cb();
			},
		};
	}

	test("reports a CPU-bound wedge longer than sleepMs instead of discarding it", () => {
		const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
		const h = cpuHarness();

		h.wd.start(); // deadline 250, cpu baseline 0
		// 82,391ms of wall clock, essentially all of it burned on a core.
		h.set(82_641, 82_000);
		h.fireTick();

		expect(warnSpy).toHaveBeenCalledTimes(1);
		const ctx = warnSpy.mock.calls[0]![1] as { blockedMs: number; cpuMs: number };
		expect(ctx.blockedMs).toBe(82_391);
		expect(ctx.cpuMs).toBeGreaterThan(80_000);
	});

	test("still suppresses a suspend/resume gap of the same duration", () => {
		const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
		const h = cpuHarness();

		h.wd.start();
		// Same wall gap, but the process was suspended: no CPU consumed.
		h.set(82_641, 3);
		h.fireTick();

		expect(warnSpy).not.toHaveBeenCalled();
	});

	test("reports a long CPU-bound block when the process is CPU throttled", () => {
		const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
		const h = cpuHarness();

		h.wd.start();
		// Ten percent CPU is still real work, not suspension.
		h.set(82_641, 8_200);
		h.fireTick();

		expect(warnSpy).toHaveBeenCalledTimes(1);
	});

	test("isStalled() does not report a suspend/resume gap as a stall", () => {
		// A laptop waking from sleep is not batched typing: input read before or
		// after the resumed tick must still classify as a responsive loop.
		const h = cpuHarness();

		h.wd.start();
		h.set(82_641, 3); // same gap as a wedge, but no CPU consumed
		expect(h.wd.isStalled()).toBe(false);
		h.fireTick();
		expect(h.wd.isStalled()).toBe(false);
	});
});
