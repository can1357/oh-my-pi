import { samplingProfilerStackTraces } from "bun:jsc";
import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import {
	createJscLoopSampler,
	type LoopSample,
	type LoopSampleFrame,
	type LoopSampler,
	summarizeBlock,
} from "@oh-my-pi/pi-tui/loop-sampler";
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
 * advances to the next pending tick. The stack sampler is off unless a test
 * injects one, so records carry exactly the phase fields.
 */
function harness(
	options: Partial<{ intervalMs: number; thresholdMs: number; sleepMs: number; sampler: LoopSampler | null }> = {},
) {
	let nowValue = 0;
	let scheduled: (() => void) | undefined;
	const now = () => nowValue;
	const schedule = (cb: () => void) => {
		scheduled = cb;
		return {};
	};
	const wd = new LoopWatchdog({ now, schedule, sampler: null, ...options });
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
		const wd = new LoopWatchdog({ now: () => nowValue, schedule, sampler: null });

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
		const wd = new LoopWatchdog({ now: () => nowValue, schedule, sampler: null });

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

	test("a healthy loop reads CPU time once per tick; isStalled() only for a suspension-length gap", () => {
		let nowValue = 0;
		let cpuReads = 0;
		let scheduled: (() => void) | undefined;
		const wd = new LoopWatchdog({
			intervalMs: 100,
			thresholdMs: 100,
			sleepMs: 10_000,
			now: () => nowValue,
			cpuNow: () => {
				cpuReads++;
				return 0;
			},
			schedule: cb => {
				scheduled = cb;
				return {};
			},
		});
		wd.start(); // deadline 100; arming samples the CPU baseline
		expect(cpuReads).toBe(1);

		for (let t = 100; t <= 500; t += 100) {
			nowValue = t; // on its deadline
			scheduled?.();
		}
		expect(cpuReads).toBe(6); // one baseline per re-arm, none to classify an on-time tick

		nowValue = 1_500; // overdue past thresholdMs but well short of sleepMs
		for (let i = 0; i < 5; i++) expect(wd.isStalled()).toBe(true);
		expect(cpuReads).toBe(6);

		nowValue = 50_000; // past sleepMs: only CPU time can tell a suspension from a block
		wd.isStalled();
		expect(cpuReads).toBe(7);
		wd.stop();
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
			sampler: null,
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

const UNKNOWN_LINE = 4294967295;

function frame(name: string, url: string, line: number): LoopSampleFrame {
	return { name, url, line };
}

/** `count` consecutive one-millisecond samples starting at `fromMs`; `stackAt(i)` is innermost first. */
function samplesFrom(fromMs: number, count: number, stackAt: (i: number) => LoopSampleFrame[]): LoopSample[] {
	return Array.from({ length: count }, (_, i) => ({ atMs: fromMs + i, frames: stackAt(i) }));
}

/** A sampler whose samples the test queues; counts drains so the test sees every tick consume them. */
function fakeSampler() {
	let pending: LoopSample[] = [];
	let drains = 0;
	let starts = 0;
	const sampler: LoopSampler = {
		start() {
			starts++;
		},
		stop() {},
		drain() {
			drains++;
			const out = pending;
			pending = [];
			return out;
		},
	};
	return {
		sampler,
		push(samples: LoopSample[]): void {
			pending.push(...samples);
		},
		get drains(): number {
			return drains;
		},
		get starts(): number {
			return starts;
		},
	};
}

const MAIN = frame("main", "/work/pi/packages/coding-agent/src/main.ts", 5);
const RENDER = frame("render", "/work/pi/packages/tui/src/tui.ts", 20);

/**
 * Contract: with a stack sampler, a logged `ui.loop-blocked` record also names
 * the code that blocked the loop — `cause`, `causeShare`, `top` — judged only
 * from samples inside the blocked window. Every tick drains the sampler, so
 * samples never outlive the interval they were taken in.
 */
describe("LoopWatchdog stack attribution", () => {
	test("a late tick names the frame dominating the blocked window and ignores older samples", () => {
		const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
		const fake = fakeSampler();
		const { wd, setNow, fireTick } = harness({ sampler: fake.sampler });

		wd.start(); // deadline 250
		expect(fake.starts).toBe(1);
		// Far more samples than the block, but they end long before it.
		fake.push(samplesFrom(1000, 500, () => [frame("oldHot", "/work/pi/packages/coding-agent/src/old.ts", 10), MAIN]));
		// The blocked window: newHot innermost in three of four samples.
		fake.push(
			samplesFrom(2000, 300, i => [
				i % 4 === 3
					? frame("otherFn", "/work/pi/packages/tui/src/other.ts", 7)
					: frame("newHot", "/work/pi/packages/tui/src/new.ts", 42),
				RENDER,
				MAIN,
			]),
		);
		setNow(560); // blockedMs = 310 → the window is the last 310ms of samples
		fireTick();

		expect(warnSpy.mock.calls).toEqual([
			[
				"ui.loop-blocked",
				{
					blockedMs: 310,
					cpuMs: expect.any(Number),
					phase: "unknown",
					cause: "newHot (tui/src/new.ts:42)",
					causeShare: 0.75,
					top: ["main (coding-agent/src/main.ts:5) 100%", "render (tui/src/tui.ts:20) 100%"],
				},
			],
		]);
	});

	test("an on-time tick drains the sampler and logs nothing", () => {
		const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
		const fake = fakeSampler();
		const { wd, setNow, fireTick } = harness({ sampler: fake.sampler });

		wd.start(); // deadline 250; start discards earlier samples
		expect(fake.drains).toBe(1);
		fake.push(samplesFrom(0, 200, () => [RENDER, MAIN]));
		setNow(250);
		fireTick(); // on time: drains, logs nothing; next deadline 500

		expect(fake.drains).toBe(2);
		expect(warnSpy).not.toHaveBeenCalled();

		setNow(810); // a block with no samples taken since the last tick
		fireTick();
		expect(warnSpy.mock.calls).toEqual([
			["ui.loop-blocked", { blockedMs: 310, cpuMs: expect.any(Number), phase: "unknown" }],
		]);
	});

	test("suspension gaps and deduped ticks drain without logging", () => {
		const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
		const fake = fakeSampler();
		const { wd, setNow, fireTick } = harness({ sleepMs: 5_000, sampler: fake.sampler });

		wd.start(); // deadline 250
		fake.push(samplesFrom(0, 50, () => [RENDER, MAIN]));
		setNow(10_250); // a suspension: no CPU burned over a 10s gap
		fireTick();
		expect(fake.drains).toBe(2);
		expect(warnSpy).not.toHaveBeenCalled();

		fake.push(samplesFrom(20_000, 300, () => [RENDER, MAIN]));
		setNow(10_760); // deadline 10_500 → a real block logs
		fireTick();
		expect(fake.drains).toBe(3);
		expect(warnSpy).toHaveBeenCalledTimes(1);

		fake.push(samplesFrom(21_000, 300, () => [RENDER, MAIN]));
		setNow(11_400); // deadline 11_010 → still blocked: deduped
		fireTick();
		expect(fake.drains).toBe(4);
		expect(warnSpy).toHaveBeenCalledTimes(1);
		wd.stop();
	});

	test("PI_LOOP_SAMPLER=0 disables the JSC sampler", () => {
		const previous = Bun.env.PI_LOOP_SAMPLER;
		Bun.env.PI_LOOP_SAMPLER = "0";
		try {
			expect(createJscLoopSampler()).toBeNull();
		} finally {
			if (previous === undefined) delete Bun.env.PI_LOOP_SAMPLER;
			else Bun.env.PI_LOOP_SAMPLER = previous;
		}
	});
});

/** Burns the JS thread for `ms`; its name is what the real sampler must report. */
function blockLoopInSamplerProbe(ms: number): number {
	const end = performance.now() + ms;
	let acc = 0;
	while (performance.now() < end) {
		for (let i = 0; i < 1_000; i++) acc += Math.sqrt(i + (acc % 7));
	}
	return acc;
}

describe("LoopWatchdog with the JSC sampler", () => {
	test.skipIf(createJscLoopSampler() === null)("names the function that blocked the loop", () => {
		const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
		let scheduled: (() => void) | undefined;
		const wd = new LoopWatchdog({
			intervalMs: 50,
			thresholdMs: 50,
			schedule: cb => {
				scheduled = cb;
				return {};
			},
		});
		try {
			wd.start();
			blockLoopInSamplerProbe(400);
			scheduled?.();
		} finally {
			wd.stop();
		}

		expect(warnSpy).toHaveBeenCalledTimes(1);
		const ctx = warnSpy.mock.calls[0]![1] as { cause?: string; top?: string[] };
		const named = [ctx.cause ?? "", ...(ctx.top ?? [])].join("\n");
		expect(named).toContain("blockLoopInSamplerProbe");
	});

	test.skipIf(createJscLoopSampler() === null)("stops the profiler once the last running watchdog stops", () => {
		const schedule = () => ({});
		const first = new LoopWatchdog({ schedule });
		const second = new LoopWatchdog({ schedule });
		first.start();
		second.start();
		first.stop();
		// The profiler is process-wide: it keeps sampling for the watchdog still running.
		while (samplingProfilerStackTraces().traces.length === 0) blockLoopInSamplerProbe(10);
		second.stop();
		// A sample left in the profiler's buffer keeps the functions on its stack from being collected.
		blockLoopInSamplerProbe(50);
		expect(samplingProfilerStackTraces().traces).toEqual([]);
	});
});

describe("summarizeBlock", () => {
	test("returns undefined without samples", () => {
		expect(summarizeBlock([], 300)).toBeUndefined();
	});

	test("judges only samples within blockedMs of the newest sample", () => {
		const a = frame("a", "/work/pi/packages/tui/src/a.ts", 1);
		const b = frame("b", "/work/pi/packages/tui/src/b.ts", 2);
		const samples = [...samplesFrom(0, 100, () => [a]), ...samplesFrom(100, 50, () => [b])];

		expect(summarizeBlock(samples, 30)).toEqual({ cause: "b (tui/src/b.ts:2)", share: 1, top: [] });
		expect(summarizeBlock(samples, 1_000)?.cause).toBe("a (tui/src/a.ts:1)");
	});

	test("skips native frames for the cause, falling back to the innermost named frame", () => {
		const native = frame("now", "", UNKNOWN_LINE);
		const spin = frame("spin", "/work/pi/packages/tui/src/spin.ts", 12);
		expect(
			summarizeBlock(
				samplesFrom(0, 10, () => [native, spin]),
				100,
			),
		).toEqual({
			cause: "spin (tui/src/spin.ts:12)",
			share: 1,
			top: [],
		});

		const allNative = samplesFrom(0, 10, () => [frame("", "", UNKNOWN_LINE), frame("sort", "", UNKNOWN_LINE)]);
		expect(summarizeBlock(allNative, 100)?.cause).toBe("sort");
	});

	test("shortens packages, node_modules and other paths", () => {
		const cause = (url: string) =>
			summarizeBlock(
				samplesFrom(0, 1, () => [frame("fn", url, 3)]),
				10,
			)?.cause;
		expect(cause("/work/pi/packages/coding-agent/src/session/agent-session.ts")).toBe(
			"fn (coding-agent/src/session/agent-session.ts:3)",
		);
		expect(cause("/home/u/proj/node_modules/marked/lib/marked.esm.js")).toBe("fn (nm/marked/lib/marked.esm.js:3)");
		expect(cause("/tmp/scratch/run.ts")).toBe("fn (run.ts:3)");
	});

	test("lists callers present in at least half the window, outermost first, at the hottest line", () => {
		const url = "/work/pi/packages/tui/src/x.ts";
		const lines = [10, 10, 11, 10];
		const samples = samplesFrom(0, 4, i => [
			frame("hot", url, lines[i]!),
			...(i < 2 ? [frame("mid", url, 30)] : i === 2 ? [frame("other", url, 40)] : []),
			frame("entry", url, 50),
		]);

		expect(summarizeBlock(samples, 100)).toEqual({
			cause: "hot (tui/src/x.ts:10)",
			share: 1,
			top: ["entry (tui/src/x.ts:50) 100%", "mid (tui/src/x.ts:30) 50%"],
		});
	});

	test("keeps the entry point and the callers nearest the cause when more than four qualify", () => {
		const url = "/work/pi/packages/tui/src/x.ts";
		const names = ["hot", "c1", "c2", "c3", "c4", "c5", "entry"];
		const samples = samplesFrom(0, 2, () => names.map((name, line) => frame(name, url, line + 1)));

		expect(summarizeBlock(samples, 100)?.top).toEqual([
			"entry (tui/src/x.ts:7) 100%",
			"c3 (tui/src/x.ts:4) 100%",
			"c2 (tui/src/x.ts:3) 100%",
			"c1 (tui/src/x.ts:2) 100%",
		]);
	});
});
