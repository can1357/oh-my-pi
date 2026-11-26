import { expect, test } from "bun:test";
import { ManualClock } from "../src/clock";

test("a manual clock moves only when advanced", () => {
	const clock = new ManualClock(1_000);
	expect(clock.now()).toBe(1_000);
	clock.advance(250);
	expect(clock.now()).toBe(1_250);
});
