import { describe, expect, it } from "bun:test";
import { Snowflake } from "@oh-my-pi/pi-utils/snowflake";

const EPOCH = Snowflake.EPOCH_TIMESTAMP;
const MAX_SEQ = Snowflake.MAX_SEQUENCE;

describe("Snowflake", () => {
	// Contract: format and parse are exact inverses across the packing
	// boundaries (sequence width, the 32-bit hex split, and large timestamps).
	it("round-trips timestamp and sequence through formatParts", () => {
		const dts = [0, 1, 1023, 1024, 0xffff_ffff, Date.now() - EPOCH, 2 ** 41, 2 ** 42 - 1];
		for (const dt of dts) {
			for (const seq of [0, 1, MAX_SEQ]) {
				const value = Snowflake.formatParts(dt, seq);
				expect(Snowflake.valid(value)).toBe(true);
				expect(Snowflake.getTimestamp(value)).toBe(dt + EPOCH);
				expect(Snowflake.getSequence(value)).toBe(seq);
			}
		}
	});

	// Contract: ids are 16 lowercase hex chars so lexicographic order equals
	// numeric order — session files and DB keys sort by time.
	it("orders lexicographically by timestamp", () => {
		const ts = Date.now();
		const a = Snowflake.next(ts);
		const earlier = Snowflake.lowerbound(ts - 1);
		const later = Snowflake.upperbound(ts + 1);
		expect(earlier < a).toBe(true);
		expect(a < later).toBe(true);
	});

	it("brackets a timestamp with lowerbound/upperbound", () => {
		const ts = Date.now();
		const id = Snowflake.next(ts);
		expect(Snowflake.lowerbound(ts) <= id).toBe(true);
		expect(id <= Snowflake.upperbound(ts)).toBe(true);
		expect(Snowflake.getTimestamp(Snowflake.lowerbound(ts))).toBe(ts);
		expect(Snowflake.getTimestamp(Snowflake.upperbound(ts))).toBe(ts);
	});
});
