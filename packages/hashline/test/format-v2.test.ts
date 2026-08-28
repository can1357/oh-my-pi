import { describe, expect, it } from "bun:test";
import {
	applyEdits,
	formatNumberedLines,
	parseLid,
	parsePatch,
	parsePatchStreaming,
	splitAddressableFileLines,
	Tokenizer,
} from "@oh-my-pi/hashline";

function applyPatch(text: string, diff: string): string {
	return applyEdits(text, parsePatch(diff).edits).text;
}

describe("hashline format v4", () => {
	it("replaces a concrete range with literal body rows in textual order", () => {
		const text = "a\nb\nc";
		const diff = ["PUT 2.=2:", "+before", "+after"].join("\n");

		expect(applyPatch(text, diff)).toBe("a\nbefore\nafter\nc");
	});

	it("deletes a single source line", () => {
		const text = "a\nb\nc";
		expect(applyPatch(text, "CUT 2.=2")).toBe("a\nc");
	});

	it("deletes a concrete range", () => {
		const text = "a\nb\nc\nd";
		expect(applyPatch(text, "CUT 2.=3")).toBe("a\nd");
	});

	it("leniently accepts common range separator variants", () => {
		const text = "a\nb\nc\nd";
		for (const separator of ["-", ".", "=", "..", "…", " "]) {
			expect(applyPatch(text, `CUT 2${separator}3`)).toBe("a\nd");
			expect(applyPatch(text, `PUT 2${separator}3:\n+middle`)).toBe("a\nmiddle\nd");
		}
	});

	it("inserts before and after concrete anchors", () => {
		const text = "a\nb\nc";
		const diff = ["PUT <2:", "+before", "PUT >2:", "+after"].join("\n");
		expect(applyPatch(text, diff)).toBe("a\nbefore\nb\nafter\nc");
	});

	it("inserts at head and tail", () => {
		const text = "a\nb";
		expect(applyPatch(text, "PUT <1:\n+HEAD")).toBe("HEAD\na\nb");
		expect(applyPatch(text, "PUT >$:\n+TAIL")).toBe("a\nb\nTAIL");
	});

	it("treats an empty replace as deletion while still rejecting an empty insert", () => {
		const result = parsePatch("PUT 2-3:");
		expect(applyEdits("a\nb\nc\nd", result.edits).text).toBe("a\nd");
		expect(result.warnings.some(w => /empty `PUT` body as deletion/.test(w))).toBe(true);
		expect(() => parsePatch("PUT <1:")).toThrow(/promises body rows/);
	});

	it("rejects body rows under cut", () => {
		expect(() => parsePatch("CUT 2\n+replacement")).toThrow(/takes no body rows/);
	});

	it("does not recognize removed DEL or COPY headers", () => {
		for (const header of ["DEL 2", "DEL.BLK 2", "COPY 2", "COPY.BLK 2"]) {
			expect(() => parsePatch(header)).toThrow(/payload line has no preceding hunk header/);
		}
	});

	it("auto-pipes bare body rows as literal text", () => {
		const text = "a\nb\nc";
		expect(applyPatch(text, "PUT 2-2:\nraw")).toBe("a\nraw\nc");
		const { warnings } = parsePatch("PUT 2-2:\nraw");
		expect(warnings.some(w => /Auto-prefixed bare body row/.test(w))).toBe(true);
	});

	it("strips read-output line number prefix from auto-piped bare body rows", () => {
		const text = "a\nb\nc";
		// Without this fix, "3:text" becomes literal "3:text" in the file.
		// With the fix, the "3:" prefix is stripped, yielding just "text".
		const { edits, warnings } = parsePatch("PUT 2-2:\n3:replaced");
		expect(applyEdits(text, edits).text).toBe("a\nreplaced\nc");
		expect(warnings.some(w => /Auto-prefixed bare body row/.test(w))).toBe(true);
	});

	it("validates insert anchors against file bounds", () => {
		const edits = parsePatch("PUT <4:\n+x").edits;
		expect(() => applyEdits("a\nb", edits)).toThrow(/Line 4 does not exist/);
	});

	it("rejects unsafe line numbers before expanding ranges", () => {
		const unsafe = String(Number.MAX_SAFE_INTEGER + 1);
		expect(parseLid(String(Number.MAX_SAFE_INTEGER), 1)).toEqual({ line: Number.MAX_SAFE_INTEGER });
		expect(() => parseLid(unsafe, 1)).toThrow();
		expect(new Tokenizer().isOp(`SWAP ${unsafe}.=${unsafe}:`)).toBe(false);
	});

	it("rejects safe-integer ranges above the expansion limit", () => {
		expect(() => parsePatch("PUT 1-100001:\n+x")).toThrow(/replace range spans 100001 lines; the maximum is 100000/);
	});

	it("ignores cutting the trailing blank sentinel of a newline-terminated file", () => {
		// "a\nb\n" splits into ["a", "b", ""]; line 3 is the phantom sentinel.
		const edits = parsePatch("CUT 3").edits;
		expect(applyEdits("a\nb\n", edits).text).toBe("a\nb\n");
	});

	it("separates terminal newline sentinels from addressable file lines", () => {
		expect(splitAddressableFileLines("a\nb\n")).toEqual(["a", "b"]);
		expect(splitAddressableFileLines("a\nb\n\n")).toEqual(["a", "b", ""]);
	});

	it("keeps a selected terminal blank line when formatting", () => {
		const selected = splitAddressableFileLines("a\n\nb\n").slice(0, 2).join("\n");
		expect(formatNumberedLines(selected)).toBe("1:a\n2:");
	});

	it("treats a cut range ending at the trailing sentinel as ending at the last real line", () => {
		const edits = parsePatch("CUT 2-3").edits;
		expect(applyEdits("a\nb\n", edits).text).toBe("a\n");
	});

	it("treats a replace range ending at the trailing sentinel as ending at the last real line", () => {
		const edits = parsePatch("PUT 2-3:\n+B").edits;
		expect(applyEdits("a\nb\n", edits).text).toBe("a\nB\n");
	});

	it("still allows inserts anchored on the trailing blank sentinel", () => {
		const edits = parsePatch("PUT >3:\n+tail").edits;
		expect(applyEdits("a\nb\n", edits).text).toBe("a\nb\n\ntail");
	});

	it("still cuts a genuine last line of a non-newline-terminated file", () => {
		// "a\nb" has no sentinel; line 2 is real content.
		const edits = parsePatch("CUT 2").edits;
		expect(applyEdits("a\nb", edits).text).toBe("a");
	});

	it("does not flush a trailing streaming pending empty replace hunk", () => {
		const result = parsePatchStreaming("PUT 5-5:\n");
		expect(result.edits).toEqual([]);
	});

	it("flushes a streaming CUT hunk when another hunk starts", () => {
		const result = parsePatchStreaming("CUT 2\nPUT >$:\n");
		expect(result.edits).toEqual([
			{ kind: "cut", range: { start: { line: 2 }, end: { line: 2 } }, lineNum: 1, index: 0 },
			{ kind: "delete", anchor: { line: 2 }, lineNum: 1, index: 1 },
		]);
	});
});
