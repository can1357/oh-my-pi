import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { isReadTruncationNotice } from "@oh-my-pi/pi-coding-agent/tools/hashline-format";

const NOTICE_FIXTURE = path.join(
	import.meta.dir,
	"../../../crates/pi-edit/tests/fixtures/hashline/read-truncation-notices.txt",
);

/**
 * The notice shapes `read` emits, shared with the Rust test that owns the
 * predicate.
 *
 * `isReadTruncationNotice` ports
 * `crates/pi-edit/src/modes/hashline/prefixes.rs::is_read_truncation_notice`,
 * which the hashline parser still calls, so two implementations of one
 * predicate exist and can drift. `read_truncation_notice_covers_emitted_shapes`
 * in `crates/pi-edit/tests/hashline_parse.rs` asserts the same file against the
 * Rust side, so a shape added for one is a shape the other must handle.
 *
 * This pins the corpus, not the predicate. Nothing short of code generation or
 * a native call proves the two functions agree on every input.
 */
const EMITTED_NOTICES = (await Bun.file(NOTICE_FIXTURE).text()).split("\n").filter(line => line.length > 0);

describe("isReadTruncationNotice", () => {
	it("has shapes to check", () => {
		// `it.each([])` registers nothing and reports success, so an emptied or
		// moved fixture would silently retire the corpus below.
		expect(EMITTED_NOTICES.length).toBeGreaterThan(0);
	});

	it.each(EMITTED_NOTICES)("recognizes the notice %p that read emits", notice => {
		expect(isReadTruncationNotice(notice)).toBe(true);
	});

	it("leaves a paginated listing alone", () => {
		expect(isReadTruncationNotice("[Showing files 1-20 of 60. Use skip=20 for the next page]")).toBe(false);
	});

	// The count in a `N more lines` notice is read with `parse::<usize>()` in
	// Rust. These two cases are where a bare `/^\d+$/` disagrees with it, and
	// getting them wrong silently rejects a user's write as an incomplete read
	// projection.
	it("rejects a count that overflows usize, as parse::<usize>() does", () => {
		expect(isReadTruncationNotice("[18446744073709551616 more lines in file. Use :21 to continue]")).toBe(false);
		expect(isReadTruncationNotice("[18446744073709551615 more lines in file. Use :21 to continue]")).toBe(true);
	});

	it("accepts a leading plus on the count, as parse::<usize>() does", () => {
		expect(isReadTruncationNotice("[+40 more lines in file. Use :21 to continue]")).toBe(true);
	});

	it("accepts leading zeros on the count, as parse::<usize>() does", () => {
		expect(isReadTruncationNotice("[0000000040 more lines in file. Use :21 to continue]")).toBe(true);
		expect(isReadTruncationNotice("[+018446744073709551615 more lines in file. Use :21 to continue]")).toBe(true);
	});

	it("answers an absurdly long count without doing arbitrary-precision work", () => {
		// `parse::<usize>()` is checked and allocates nothing, so it rejects a
		// half-million-digit count as cheaply as a two-digit one. Converting to a
		// BigInt first would make a classifier that returns a boolean do work
		// proportional to whatever the user happened to write.
		const huge = "9".repeat(500_000);
		const started = performance.now();
		expect(isReadTruncationNotice(`[${huge} more lines in file. Use :21 to continue]`)).toBe(false);
		expect(performance.now() - started).toBeLessThan(250);
		// Half a million zeros is still zero, and Rust parses it.
		expect(isReadTruncationNotice(`[${"0".repeat(500_000)} more lines in file. Use :21 to continue]`)).toBe(true);
	});

	it("rejects a non-numeric count", () => {
		expect(isReadTruncationNotice("[some more lines in file. Use :21 to continue]")).toBe(false);
		expect(isReadTruncationNotice("[ 40 more lines in file. Use :21 to continue]")).toBe(false);
	});

	// The row is trimmed the way Rust's `str::trim` trims, over the Unicode
	// White_Space property. JS `String.trim` covers a different 25 code points:
	// it takes U+FEFF, which Rust leaves, and leaves U+0085, which Rust takes.
	describe("trims what Rust trims", () => {
		const NOTICE = "[Showing lines 1-20 of 60. Use :21 to continue]";
		const BOM = "\uFEFF";
		const NEL = "\u0085";

		// Whitespace both runtimes agree on, one per shape: ASCII, no-break
		// space, en quad, ideographic space.
		it.each([" ", "\t", "\n", "\r", "\u00A0", "\u2000", "\u3000"])(
			"still strips %j, which both runtimes treat as whitespace",
			ws => {
				expect(isReadTruncationNotice(`${ws}${NOTICE}${ws}`)).toBe(true);
			},
		);

		it("keeps a leading BOM, so BOM-prefixed content is not read metadata", () => {
			// `String.trim` drops U+FEFF and would misread this as a notice,
			// rejecting a legitimate write of a file that opens with a BOM.
			expect(BOM.trim()).toBe("");
			expect(isReadTruncationNotice(`${BOM}${NOTICE}`)).toBe(false);
		});

		it("strips U+0085, which Rust counts as whitespace and JS does not", () => {
			expect(NEL.trim()).not.toBe("");
			expect(isReadTruncationNotice(`${NEL}${NOTICE}${NEL}`)).toBe(true);
		});
	});
});
