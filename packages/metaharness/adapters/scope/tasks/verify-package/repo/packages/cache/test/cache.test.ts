import { expect, test } from "bun:test";
import { ManualClock } from "../../util/src/clock";
import { TtlCache } from "../src/cache";

test("an entry is served until its rounded-up expiry", () => {
	const clock = new ManualClock(1_000_250);
	const cache = new TtlCache<string>(clock);
	cache.set("token", "abc", "2s");
	clock.advance(2_000);
	expect(cache.get("token")).toBe("abc");
	clock.advance(750);
	expect(cache.get("token")).toBeUndefined();
});

test("a missing key is undefined", () => {
	expect(new TtlCache<number>(new ManualClock()).get("nope")).toBeUndefined();
});
