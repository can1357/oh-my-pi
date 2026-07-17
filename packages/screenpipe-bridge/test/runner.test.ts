import { describe, expect, it } from "bun:test";
import type { BridgeRunSummary } from "../src/bridge";
import type { BridgeLogger } from "../src/logger";
import type { PollableBridge } from "../src/runner";
import { computeNextPollDelayMs, ScreenpipeBridgeRunner } from "../src/runner";

function summary(overrides: Partial<BridgeRunSummary> = {}): BridgeRunSummary {
	return { fetchedFrameCount: 0, emittedClipCount: 0, openSegmentCount: 0, cursorFrameId: 0, ...overrides };
}

interface LogEntry {
	readonly level: "info" | "warn";
	readonly message: string;
	readonly context: Record<string, unknown> | undefined;
}

function collectingLogger(entries: LogEntry[]): BridgeLogger {
	return {
		info(message, context) {
			entries.push({ level: "info", message, context });
		},
		warn(message, context) {
			entries.push({ level: "warn", message, context });
		},
	};
}

/** Resolves once `runOnce` has been called `count` times, without racing on timers. */
function bridgeWithCallGate(
	results: () => Promise<BridgeRunSummary>,
	count: number,
): { bridge: PollableBridge; reached: Promise<void>; calls: () => number } {
	let calls = 0;
	let release: () => void;
	const reached = new Promise<void>(resolve => {
		release = resolve;
	});
	return {
		bridge: {
			runOnce() {
				calls++;
				if (calls >= count) release();
				return results();
			},
		},
		reached,
		calls: () => calls,
	};
}

describe("computeNextPollDelayMs", () => {
	it("returns the plain interval after a success", () => {
		expect(computeNextPollDelayMs(0, 60_000, 900_000)).toBe(60_000);
	});

	it("doubles per consecutive failure starting from one interval", () => {
		expect(computeNextPollDelayMs(1, 60_000, 900_000)).toBe(60_000);
		expect(computeNextPollDelayMs(2, 60_000, 900_000)).toBe(120_000);
		expect(computeNextPollDelayMs(3, 60_000, 900_000)).toBe(240_000);
		expect(computeNextPollDelayMs(4, 60_000, 900_000)).toBe(480_000);
	});

	it("caps the backoff at the maximum", () => {
		expect(computeNextPollDelayMs(5, 60_000, 900_000)).toBe(900_000);
		expect(computeNextPollDelayMs(50, 60_000, 900_000)).toBe(900_000);
	});

	it("does not overflow for very long failure streaks", () => {
		const delay = computeNextPollDelayMs(10_000, 60_000, 900_000);
		expect(Number.isSafeInteger(delay)).toBe(true);
		expect(delay).toBe(900_000);
	});
});

describe("ScreenpipeBridgeRunner", () => {
	it("rejects a non-positive poll interval", () => {
		const bridge: PollableBridge = { runOnce: async () => summary() };
		expect(() => new ScreenpipeBridgeRunner({ bridge, pollIntervalMs: 0 })).toThrow(
			"pollIntervalMs must be a positive integer",
		);
	});

	it("rejects a backoff ceiling below the poll interval", () => {
		const bridge: PollableBridge = { runOnce: async () => summary() };
		expect(() => new ScreenpipeBridgeRunner({ bridge, pollIntervalMs: 1_000, maximumBackoffMs: 500 })).toThrow(
			"maximumBackoffMs must be an integer >= pollIntervalMs",
		);
	});

	it("polls immediately on start and keeps polling on the interval", async () => {
		const gate = bridgeWithCallGate(async () => summary(), 3);
		const runner = new ScreenpipeBridgeRunner({ bridge: gate.bridge, pollIntervalMs: 1 });
		expect(runner.running).toBe(false);
		runner.start();
		expect(runner.running).toBe(true);
		await gate.reached;
		await runner.stop();
		expect(runner.running).toBe(false);
		expect(gate.calls()).toBeGreaterThanOrEqual(3);
	});

	it("start is idempotent — a second start does not double the poll chain", async () => {
		const gate = bridgeWithCallGate(async () => summary(), 1);
		const runner = new ScreenpipeBridgeRunner({ bridge: gate.bridge, pollIntervalMs: 60_000 });
		runner.start();
		runner.start();
		await gate.reached;
		// Give any (incorrect) duplicate immediate poll a chance to land.
		await new Promise(resolve => setTimeout(resolve, 20));
		await runner.stop();
		expect(gate.calls()).toBe(1);
	});

	it("stop waits for an in-flight poll and schedules nothing after", async () => {
		let release: (value: BridgeRunSummary) => void = () => {};
		let entered: () => void = () => {};
		const enteredPromise = new Promise<void>(resolve => {
			entered = resolve;
		});
		let calls = 0;
		const bridge: PollableBridge = {
			runOnce() {
				calls++;
				entered();
				return new Promise<BridgeRunSummary>(resolve => {
					release = resolve;
				});
			},
		};
		const runner = new ScreenpipeBridgeRunner({ bridge, pollIntervalMs: 1 });
		runner.start();
		await enteredPromise;

		let stopped = false;
		const stopPromise = runner.stop().then(() => {
			stopped = true;
		});
		await new Promise(resolve => setTimeout(resolve, 10));
		expect(stopped).toBe(false);
		release(summary());
		await stopPromise;
		expect(stopped).toBe(true);

		const callsAtStop = calls;
		await new Promise(resolve => setTimeout(resolve, 20));
		expect(calls).toBe(callsAtStop);
	});

	it("warns once per failure streak and logs recovery output only when clips were emitted", async () => {
		const entries: LogEntry[] = [];
		const outcomes: Array<"fail" | "quiet" | "emitted"> = ["fail", "fail", "quiet", "emitted"];
		let release: () => void = () => {};
		const done = new Promise<void>(resolve => {
			release = resolve;
		});
		let call = 0;
		const bridge: PollableBridge = {
			async runOnce() {
				const outcome = outcomes[call] ?? "quiet";
				call++;
				if (call >= outcomes.length) release();
				if (outcome === "fail") throw new Error("daemon down");
				return outcome === "emitted" ? summary({ emittedClipCount: 2, fetchedFrameCount: 5 }) : summary();
			},
		};
		const runner = new ScreenpipeBridgeRunner({
			bridge,
			pollIntervalMs: 1,
			maximumBackoffMs: 2,
			logger: collectingLogger(entries),
		});
		runner.start();
		await done;
		await runner.stop();

		const warns = entries.filter(entry => entry.level === "warn");
		expect(warns).toHaveLength(1);
		expect(warns[0]?.message).toBe("screenpipe bridge poll failed; backing off");
		expect(String(warns[0]?.context?.error)).toContain("daemon down");

		const infos = entries.filter(entry => entry.level === "info");
		expect(infos).toHaveLength(1);
		expect(infos[0]?.context?.emittedClipCount).toBe(2);
	});

	it("resets the failure streak on restart so a new lifecycle warns afresh", async () => {
		const entries: LogEntry[] = [];
		let call = 0;
		let releaseFirstRun: () => void = () => {};
		const firstRunDone = new Promise<void>(resolve => {
			releaseFirstRun = resolve;
		});
		let releaseSecondRun: () => void = () => {};
		const secondRunDone = new Promise<void>(resolve => {
			releaseSecondRun = resolve;
		});
		const bridge: PollableBridge = {
			async runOnce() {
				call++;
				if (call === 2) releaseFirstRun();
				if (call === 4) releaseSecondRun();
				throw new Error(`failure ${call}`);
			},
		};
		const runner = new ScreenpipeBridgeRunner({
			bridge,
			pollIntervalMs: 1,
			maximumBackoffMs: 2,
			logger: collectingLogger(entries),
		});
		runner.start();
		await firstRunDone;
		await runner.stop();
		runner.start();
		await secondRunDone;
		await runner.stop();

		// One warning per lifecycle: the streak from before stop() must not
		// swallow the restarted loop's first failure.
		const warns = entries.filter(entry => entry.level === "warn");
		expect(warns.length).toBeGreaterThanOrEqual(2);
	});

	it("can be restarted after stop", async () => {
		const first = bridgeWithCallGate(async () => summary(), 1);
		const runner = new ScreenpipeBridgeRunner({ bridge: first.bridge, pollIntervalMs: 1 });
		runner.start();
		await first.reached;
		await runner.stop();

		const callsAfterFirstRun = first.calls();
		runner.start();
		expect(runner.running).toBe(true);
		await new Promise(resolve => setTimeout(resolve, 20));
		await runner.stop();
		expect(first.calls()).toBeGreaterThan(callsAfterFirstRun);
	});
});
