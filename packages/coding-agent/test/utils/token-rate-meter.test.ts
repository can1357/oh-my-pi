/**
 * Contracts: working-row live tok/s meter.
 *
 * 1. Inertia: a short burst (a write's args at 3× the settled rate) nudges the
 *    reading in proportion to its token mass instead of replacing it, while a
 *    sustained change converges within the longest half-life.
 * 2. Only stream time counts: tool execution between messages neither decays
 *    nor dilutes the reading, and it holds across it.
 * 3. Billed-but-unstreamed tokens are additive: a fixed per-message overhead
 *    learned from small tool calls never amplifies a later fast visible burst,
 *    and hidden pre-delta reasoning is charged against its silent span.
 * 4. Too few tokens is no reading, not a spurious one; reset blanks it.
 */
import { describe, expect, it } from "bun:test";
import { TokenRateMeter } from "../../src/utils/token-rate";

const words = (text: string) => text.split(/\s+/).filter(Boolean).length;

/** Stream `perDelta` words every 100ms from `from` to `to`. */
function stream(meter: TokenRateMeter, from: number, to: number, perDelta: number) {
	const delta = `${"w ".repeat(perDelta)}`;
	for (let t = from; t < to; t += 100) meter.push(delta, t);
}

/** `count` messages of 600 tokens over 10s at 60 tok/s, 5s tool gaps, billed as counted. Returns the clock. */
function settle(meter: TokenRateMeter, count: number, billed = 600): number {
	let clock = 0;
	for (let i = 0; i < count; i++) {
		meter.begin(clock);
		stream(meter, clock, clock + 10_000, 6);
		clock += 10_000;
		meter.end(billed, clock);
		clock += 5_000;
	}
	return clock;
}

describe("TokenRateMeter", () => {
	it("reports null until enough tokens and stream time have accumulated", () => {
		const meter = new TokenRateMeter(words);
		expect(meter.rate(0)).toBeNull();
		meter.begin(0);
		// A provider's first buffered chunk: 300 tokens in one delta is not a rate yet.
		meter.push("w ".repeat(300), 500);
		expect(meter.rate(600)).toBeNull();
		stream(meter, 600, 10_000, 6);
		expect(meter.rate(10_000)).toBeGreaterThan(80);
		expect(meter.rate(10_000)).toBeLessThan(100);
	});

	it("holds across tool execution and is only nudged by a short burst", () => {
		const meter = new TokenRateMeter(words);
		const clock = settle(meter, 6);
		expect(meter.rate(clock)).toBeCloseTo(60, 0);
		expect(meter.rate(clock + 60_000)).toBeCloseTo(60, 0);
		// 2s write-args burst at 200 tok/s.
		meter.begin(clock);
		stream(meter, clock, clock + 2000, 20);
		const peak = meter.rate(clock + 2000) ?? 0;
		expect(peak).toBeGreaterThan(60);
		expect(peak).toBeLessThan(80);
	});

	it("converges to a sustained new rate within the longest half-life", () => {
		const meter = new TokenRateMeter(words);
		const clock = settle(meter, 6);
		meter.begin(clock);
		stream(meter, clock, clock + 80_000, 20);
		const after = meter.rate(clock + 80_000) ?? 0;
		expect(after).toBeGreaterThan(150);
		expect(after).toBeLessThan(200);
	});

	it("charges hidden pre-delta reasoning against its silent span", () => {
		const meter = new TokenRateMeter(words);
		// 20s of silence, then a 2-token tool call; the provider bills 1500.
		meter.begin(0);
		meter.push("x y", 20_000);
		meter.end(1500, 20_100);
		expect(meter.rate(20_100)).toBeCloseTo(1500 / 20.1, 0);
	});

	it("never amplifies a visible burst by overhead learned from small tool calls", () => {
		const meter = new TokenRateMeter(words);
		// Ten 25-token tool calls over 2s each, billed 80 (a ~55-token envelope) → ~40 tok/s.
		let clock = 0;
		for (let i = 0; i < 10; i++) {
			meter.begin(clock);
			meter.push("w ".repeat(25), clock + 1500);
			clock += 2000;
			meter.end(80, clock);
			clock += 3000;
		}
		expect(meter.rate(clock)).toBeCloseTo(40, -1);
		// A write streams 2000 visible tokens over 20s at a true 100 tok/s. A
		// multiplicative fit (80/25 ≈ 3×) would read ~300; additive stays honest.
		meter.begin(clock);
		let peak = 0;
		for (let t = 0; t < 20_000; t += 100) {
			meter.push("w ".repeat(10), clock + t);
			peak = Math.max(peak, meter.rate(clock + t) ?? 0);
		}
		expect(peak).toBeLessThan(115);
		meter.end(2055, clock + 20_000);
		expect(meter.rate(clock + 20_000)).toBeGreaterThan(80);
		expect(meter.rate(clock + 20_000)).toBeLessThan(105);
	});

	it("blanks on reset", () => {
		const meter = new TokenRateMeter(words);
		const clock = settle(meter, 2);
		meter.reset();
		expect(meter.rate(clock)).toBeNull();
	});

	it("seed shows a completed turn's rate immediately and it holds like a settled turn", () => {
		const meter = new TokenRateMeter(words);
		// 600 tokens over 10s (60 tok/s).
		meter.seed(600, 10_000);
		expect(meter.rate(1_000)).toBeCloseTo(60, 0);
		expect(meter.rate(61_000)).toBeCloseTo(60, 0);
	});

	it("seed scales small turns past the evidence gate without changing the rate", () => {
		const meter = new TokenRateMeter(words);
		// 120 tokens over 2s (60 tok/s) is below the gate unscaled.
		meter.seed(120, 2_000);
		expect(meter.rate(0)).toBeCloseTo(60, 0);
		// Invalid seeds blank the meter instead of throwing or showing garbage.
		meter.seed(0, 2_000);
		expect(meter.rate(0)).toBeNull();
	});

	it("a new turn blends with the seeded baseline instead of replacing it", () => {
		const meter = new TokenRateMeter(words);
		meter.seed(600, 10_000);
		meter.begin(5_000);
		// 10s at 30 tok/s against a 60 tok/s baseline: the reading sits between.
		stream(meter, 5_000, 15_000, 3);
		const blended = meter.rate(15_000) ?? 0;
		expect(blended).toBeGreaterThan(30);
		expect(blended).toBeLessThan(60);
	});
});

describe("TokenRateMeter objective average", () => {
	it("rolls across messages and holds when the objective is done", () => {
		const meter = new TokenRateMeter(words);
		expect(meter.objectiveRate(0)).toBeNull();
		meter.begin(0);
		stream(meter, 0, 1_000, 5);
		meter.end(100, 1_000);
		expect(meter.objectiveRate(1_000)).toBeCloseTo(100, 0);

		meter.begin(5_000);
		stream(meter, 5_000, 7_000, 5);
		// The open message's streamed estimate counts while it runs.
		expect(meter.objectiveRate(6_000)!).toBeGreaterThan(50);
		meter.end(300, 7_000);
		// (100 + 300) tokens over (1 + 2) s, and it holds once nothing streams.
		expect(meter.objectiveRate(9_000)).toBeCloseTo(400 / 3, 1);

		meter.reset();
		expect(meter.objectiveRate(9_000)).toBeNull();
	});
});

describe("TokenRateMeter fastest window", () => {
	it("remembers the fastest 1 s of streamed tokens and holds it", () => {
		const meter = new TokenRateMeter(words);
		meter.begin(0);
		stream(meter, 0, 2_000, 5); // 50 tok/s
		const slow = meter.fastestRate();
		expect(slow).not.toBeNull();
		expect(slow!).toBeGreaterThan(30);
		expect(slow!).toBeLessThan(70);

		stream(meter, 2_000, 3_000, 20); // 200 tok/s
		const fast = meter.fastestRate()!;
		expect(fast).toBeGreaterThan(slow! + 20);
		expect(fast).toBeGreaterThan(120);
		expect(fast).toBeLessThan(300);

		stream(meter, 3_000, 6_000, 1); // 10 tok/s: the peak stays remembered
		const remembered = meter.fastestRate()!;
		expect(remembered).toBeGreaterThanOrEqual(fast);
		meter.end(400, 6_000);
		expect(meter.fastestRate()).toBe(remembered);

		meter.reset();
		expect(meter.fastestRate()).toBeNull();
	});
});

describe("TokenRateMeter short requests", () => {
	it("measures a request that finishes inside the 1 s window", () => {
		const meter = new TokenRateMeter(words);
		meter.begin(0);
		stream(meter, 0, 500, 5); // 25 streamed words over 500 ms
		meter.end(25, 500);
		// 25 billed tokens over its own half second, not a 1 s denominator.
		expect(meter.objectiveRate(500)).toBeCloseTo(50, 0);
		expect(meter.fastestRate()).toBeCloseTo(50, 0);
	});

	it("keeps the average exact for a request under the live reading floor", () => {
		const meter = new TokenRateMeter(words);
		meter.begin(0);
		stream(meter, 0, 150, 5); // 10 words in 150 ms
		meter.end(10, 150);
		expect(meter.objectiveRate(150)).toBeCloseTo(66.7, 0);
	});
});

describe("TokenRateMeter objective reset", () => {
	it("restarts the average and peak per request while holding between requests", () => {
		const meter = new TokenRateMeter(words);
		meter.begin(0);
		stream(meter, 0, 1_000, 10); // 100 tok/s
		meter.end(100, 1_000);
		expect(meter.objectiveRate(1_000)).toBeCloseTo(100, 0);
		// The finished stat holds until the next request resets it.
		expect(meter.objectiveRate(60_000)).toBeCloseTo(100, 0);
		expect(meter.fastestRate()).not.toBeNull();

		meter.resetObjective();
		expect(meter.objectiveRate(60_000)).toBeNull();
		expect(meter.fastestRate()).toBeNull();

		meter.begin(60_000);
		stream(meter, 60_000, 61_000, 5); // 50 tok/s: only this request counts
		meter.end(50, 61_000);
		expect(meter.objectiveRate(61_000)).toBeCloseTo(50, 0);
	});
});

describe("TokenRateMeter window rate", () => {
	it("reports the trailing 1 s, not the running average", () => {
		const meter = new TokenRateMeter(words);
		meter.begin(0);
		stream(meter, 0, 4_000, 10); // 100 tok/s for 4 s
		expect(meter.windowRate(4_000)).toBeCloseTo(100, 0);
		expect(meter.objectiveRate(4_000)).toBeCloseTo(100, 0);

		stream(meter, 4_000, 6_000, 1); // 10 tok/s: the window follows at once
		expect(meter.windowRate(6_000)).toBeCloseTo(10, 0);
		// The average still carries the whole run.
		expect(meter.objectiveRate(6_000)!).toBeGreaterThan(40);

		meter.end(250, 6_000);
		expect(meter.windowRate(6_000)).toBeNull();
	});
});
