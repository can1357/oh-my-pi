import { afterEach, describe, expect, test, vi } from "bun:test";
import { LoopWatchdog } from "@oh-my-pi/pi-tui/loop-watchdog";
import { currentLoopPhase, logger, popLoopPhase, pushLoopPhase, takeRecentLoopPhase } from "@oh-my-pi/pi-utils";

/**
 * Contract: LoopWatchdog turns event-loop lag into exactly one
 * `logger.warn("ui.loop-blocked", { blockedMs, phase })` line per block. A tick
 * that fires more than `thresholdMs` past its `intervalMs` deadline is a block; it
 * is logged once on the rising edge (deduped while the loop stays blocked), tagged
 * with the current loop phase and the rounded overshoot, and a stopped watchdog
 * emits nothing even for a tick already armed before stop().
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

afterEach(() => {
	vi.restoreAllMocks();
	// The phase stack is a process-global; drain anything these cases pushed.
	while (currentLoopPhase() !== undefined) popLoopPhase();
	// Drain the consume-on-read recent slot too, so a phase one case set cannot
	// leak into another's attribution assertion.
	takeRecentLoopPhase();
});

describe("LoopWatchdog", () => {
	test("logs ui.loop-blocked once with the current phase and overshoot when a tick runs late", () => {
		const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
		const { wd, setNow, fireTick } = harness(); // intervalMs=250, thresholdMs=250

		pushLoopPhase("render");
		wd.start(); // deadline armed at now(0)+250 = 250
		setNow(560); // tick fires at 560 → blockedMs = 560 - 250 = 310 (> threshold)
		fireTick();

		expect(warnSpy).toHaveBeenCalledTimes(1);
		const [event, ctx] = warnSpy.mock.calls[0] as [string, { blockedMs: number; phase: string }];
		expect(event).toBe("ui.loop-blocked");
		expect(ctx.phase).toBe("render");
		expect(ctx.blockedMs).toBeGreaterThanOrEqual(250);
	});

	test("stays silent when a tick fires on its deadline", () => {
		const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
		const { wd, setNow, fireTick } = harness();

		pushLoopPhase("render");
		wd.start(); // deadline at 250
		setNow(250); // blockedMs = 0, not a block
		fireTick();

		expect(warnSpy).not.toHaveBeenCalled();
	});

	test("dedupes a sustained block: two consecutive late ticks log only once", () => {
		const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
		const { wd, setNow, fireTick } = harness();

		pushLoopPhase("render");
		wd.start(); // deadline at 250
		setNow(600); // blockedMs = 350 → rising edge, logs once; re-armed deadline = 850
		fireTick();
		setNow(1200); // blockedMs = 350 again, but still blocked → no second log
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

		pushLoopPhase("render");
		wd.start(); // deadline at 250
		setNow(600); // first block logs once and re-arms a follow-up tick
		fireTick();
		expect(warnSpy).toHaveBeenCalledTimes(1);

		wd.stop();
		setNow(5000); // the already-armed follow-up tick would otherwise be a huge block
		fireTick();

		expect(warnSpy).toHaveBeenCalledTimes(1); // stop() short-circuits the stale tick
	});

	test("attributes a synchronous block whose phase was already popped before the tick", () => {
		const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
		const { wd, setNow, fireTick } = harness();

		wd.start(); // deadline 250
		// A hot sync path pushes and pops its phase within one macrotask, so the
		// stack is empty by the time the delayed tick runs — the recent slot must
		// still surface the culprit instead of "unknown".
		pushLoopPhase("ui.select-filter");
		popLoopPhase();
		setNow(600); // blockedMs = 350
		fireTick();

		expect(warnSpy).toHaveBeenCalledTimes(1);
		expect((warnSpy.mock.calls[0]![1] as { phase: string }).phase).toBe("ui.select-filter");
	});

	test("does not misattribute a finished phase to a later phase-less block", () => {
		const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
		const { wd, setNow, fireTick } = harness();

		wd.start(); // deadline 250
		pushLoopPhase("ui.select-filter");
		popLoopPhase();
		setNow(250); // on-time tick consumes the recent phase, logs nothing; re-arm 500
		fireTick();
		setNow(900); // block in the next interval with no phase active
		fireTick();

		expect(warnSpy).toHaveBeenCalledTimes(1);
		expect((warnSpy.mock.calls[0]![1] as { phase: string }).phase).toBe("unknown");
	});

	test("re-arms after recovery: late then on-time then late logs twice", () => {
		const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
		const { wd, setNow, fireTick } = harness();

		pushLoopPhase("render");
		wd.start(); // deadline 250
		setNow(600); // block #1 (350) → logs; re-arm 850
		fireTick();
		setNow(850); // on-time → falling edge resets #wasBlocked; re-arm 1100
		fireTick();
		setNow(1450); // block #2 (350) → logs again
		fireTick();

		expect(warnSpy).toHaveBeenCalledTimes(2);
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
});
