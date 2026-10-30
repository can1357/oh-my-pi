import { describe, expect, it } from "bun:test";
import { Snowflake } from "@oh-my-pi/pi-utils/snowflake";

const EPOCH = Snowflake.EPOCH_TIMESTAMP;
const MAX_SEQ = Snowflake.MAX_SEQUENCE;
const MAX_TS = Snowflake.MAX_TIMESTAMP;

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

	// Contract: the branded type promises valid() holds. A timestamp outside
	// the 42-bit field saturates rather than rendering a leading "-" (pre-epoch)
	// or widening past 16 chars (post-2154), either of which would produce a
	// Snowflake-typed value that fails this module's own validator.
	it("saturates timestamps outside the representable range", () => {
		for (const ts of [0, Date.UTC(2000, 0, 1), EPOCH - 1, MAX_TS + 1, MAX_TS + 86_400_000]) {
			expect(Snowflake.valid(Snowflake.lowerbound(ts))).toBe(true);
			expect(Snowflake.valid(Snowflake.upperbound(ts))).toBe(true);
		}
		const floor: string = Snowflake.lowerbound(0);
		const ceiling: string = Snowflake.upperbound(MAX_TS + 1);
		expect(floor).toBe("0000000000000000");
		expect(ceiling).toBe("ffffffffffffffff");
		expect(Snowflake.valid(new Snowflake.Source(0).generate(0))).toBe(true);
	});

	// Saturation must not collapse the bracket: a range query built from a
	// clamped pair still orders correctly and still decodes to the boundary.
	it("keeps bounds ordered and decodable when saturated", () => {
		for (const ts of [0, EPOCH - 1, MAX_TS + 1]) {
			expect(Snowflake.lowerbound(ts) < Snowflake.upperbound(ts)).toBe(true);
		}
		expect(Snowflake.getTimestamp(Snowflake.lowerbound(0))).toBe(EPOCH);
		expect(Snowflake.getTimestamp(Snowflake.upperbound(MAX_TS + 1))).toBe(MAX_TS);

		const id = Snowflake.next(Date.now());
		expect(Snowflake.lowerbound(0) <= id).toBe(true);
		expect(id <= Snowflake.upperbound(MAX_TS)).toBe(true);
	});
});
