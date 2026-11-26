import { expect, test } from "bun:test";
import { countWords } from "../src/count";

test("counts lines, words, and chars", () => {
	expect(countWords("one two three\nfour five\n")).toEqual({ lines: 2, words: 5, chars: 24 });
	expect(countWords("")).toEqual({ lines: 0, words: 0, chars: 0 });
});
