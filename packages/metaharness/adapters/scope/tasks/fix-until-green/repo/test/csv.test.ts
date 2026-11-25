import { expect, test } from "bun:test";
import { parseCsv } from "../src/csv";

test("parses RFC 4180 CSV", () => {
	expect(parseCsv("a,b\nc,d")).toEqual([
		["a", "b"],
		["c", "d"],
	]);
	expect(parseCsv('"x,y",z')).toEqual([["x,y", "z"]]);
	expect(parseCsv("a,b\n")).toEqual([["a", "b"]]);
	expect(parseCsv('"say ""hi""",x')).toEqual([['say "hi"', "x"]]);
	expect(parseCsv('"line 1\nline 2",x\ny,z')).toEqual([
		["line 1\nline 2", "x"],
		["y", "z"],
	]);
});
