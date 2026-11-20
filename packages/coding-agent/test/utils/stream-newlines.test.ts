import { describe, expect, it } from "bun:test";
import { StreamNewlineNormalizer } from "../../src/utils/stream-newlines";

describe("StreamNewlineNormalizer", () => {
	it("keeps a CRLF split across reads as one line ending", () => {
		const newlines = new StreamNewlineNormalizer();
		const out = ["a\r", "\nb\r\n", "c\r", "d\r", "", "\n"].map(chunk => newlines.push(chunk)).join("");
		expect(out).toBe("a\nb\nc\nd\n");
	});
});
