import { describe, expect, test } from "bun:test";
import { hashlineIsReadTruncationNotice } from "@oh-my-pi/pi-natives";
import {
	isReadTruncationNotice,
	isReadTruncationNoticeFallback,
} from "@oh-my-pi/pi-coding-agent/tools/hashline-format";

const NATIVE_AVAILABLE = typeof hashlineIsReadTruncationNotice === "function";

const CORPUS: string[] = [
	// Each notice branch, verbatim shapes from read output.
	"[Showing 1-50 of 200 lines. Use :50-200 to continue]",
	"[Showing 1-50 of 200 lines]",
	"[More lines in file. Use :raw to continue]",
	"[5 more lines in file. Use :1-5 to continue]",
	"[+5 more lines in file. Use :1-5 to continue]",
	"[ 5 more lines in file. Use :1-5 to continue]",
	"[…12ln elided; re-read needed ranges, e.g. :1-10]",
	"[...12ln elided; re-read needed ranges, e.g. :1-10]",
	"[Line 42 exceeds 2000 bytes limit.]",
	// Boundaries the mirror must match exactly.
	"",
	"[",
	"[]",
	"[Showing]",
	"[Showing 1-50]",
	"[More lines]",
	"[5 more lines]",
	"[Line 42]",
	"   [Showing 1-50 of 200 lines]   ",
	"not a notice",
	"[file.ts#AB12]",
	"[12:34]",
];

describe("isReadTruncationNotice", () => {
	test("classifies known notices and non-notices", () => {
		expect(isReadTruncationNotice("[Showing 1-50 of 200 lines. Use :50-200 to continue]")).toBe(true);
		expect(isReadTruncationNotice("[5 more lines in file. Use :1-5 to continue]")).toBe(true);
		expect(isReadTruncationNotice("[…12ln elided; re-read needed ranges, e.g. :1-10]")).toBe(true);
		expect(isReadTruncationNotice("[Line 42 exceeds 2000 bytes limit.]")).toBe(true);
		expect(isReadTruncationNotice("[file.ts#AB12]")).toBe(false);
		expect(isReadTruncationNotice("not a notice")).toBe(false);
		expect(isReadTruncationNotice("")).toBe(false);
	});

	test.skipIf(!NATIVE_AVAILABLE)("fallback agrees with native on every corpus line", () => {
		for (const line of CORPUS) {
			expect(isReadTruncationNoticeFallback(line), JSON.stringify(line)).toBe(hashlineIsReadTruncationNotice(line));
		}
	});
});
