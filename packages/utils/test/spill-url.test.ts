import { describe, expect, it } from "bun:test";
import { parseSpillUrl, spillIdOfFileName, spillUrl, spillUrlIds } from "../src/spill-url";

describe("spill URLs", () => {
	it("round-trips an id, with or without a read selector", () => {
		expect(parseSpillUrl(spillUrl(7))).toBe(7);
		expect(parseSpillUrl(`${spillUrl(7)}:raw:1-3000`)).toBe(7);
	});

	it("rejects local:// names that only start like a spill", () => {
		// A scratch file the model wrote must not be mistaken for (and paged as) a spill.
		for (const text of [
			"local://7.logs",
			"local://7.log.bak",
			"local://x7.log",
			"local://7.md",
			"local://dir/7.log",
		]) {
			expect(parseSpillUrl(text)).toBeUndefined();
		}
	});

	it("finds every spill a text names, once each, ascending", () => {
		const text = `see ${spillUrl(12)} and ${spillUrl(3)}:1-30, again ${spillUrl(12)}; not local://5.log.bak`;
		expect(spillUrlIds(text)).toEqual([3, 12]);
	});

	it("recognizes only bare <N>.log root files as spills", () => {
		expect(spillIdOfFileName("42.log")).toBe(42);
		expect(spillIdOfFileName("42.bash.log")).toBeUndefined();
		expect(spillIdOfFileName("42.log.tmp-1")).toBeUndefined();
	});
});
