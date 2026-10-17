import { afterEach, describe, expect, it } from "bun:test";
import {
	classifySixelRow,
	containsSixelSequence,
	createRawSixelExtractor,
	getSixelLineMask,
	matchSixelIntroducer,
	sanitizeWithOptionalSixelPassthrough,
	SixelSpanParser,
	splitSixelSpans,
} from "@oh-my-pi/pi-tui/render/sixel";
import { sanitizeText } from "@oh-my-pi/pi-utils";

/** 7-bit DCS: `ESC P [params] q`, terminated by ST. */
const SEVEN_BIT = "\x1bPq#0;2;100;0;0#0~~\x1b\\";
/** 8-bit C1 DCS: `0x90 [params] q`, terminated by the 8-bit ST. */
const EIGHT_BIT = "\x90q#0;2;100;0;0#0~~\x9c";
/** The other two legal terminators, on the 7-bit introducer. */
const BELL_TERMINATED = "\x1bPq#0~~\x07";

const originalForceProtocol = Bun.env.PI_FORCE_IMAGE_PROTOCOL;
const originalAllowPassthrough = Bun.env.PI_ALLOW_SIXEL_PASSTHROUGH;

function enableSixelPassthrough(): void {
	Bun.env.PI_FORCE_IMAGE_PROTOCOL = "sixel";
	Bun.env.PI_ALLOW_SIXEL_PASSTHROUGH = "1";
}

afterEach(() => {
	if (originalForceProtocol === undefined) delete Bun.env.PI_FORCE_IMAGE_PROTOCOL;
	else Bun.env.PI_FORCE_IMAGE_PROTOCOL = originalForceProtocol;
	if (originalAllowPassthrough === undefined) delete Bun.env.PI_ALLOW_SIXEL_PASSTHROUGH;
	else Bun.env.PI_ALLOW_SIXEL_PASSTHROUGH = originalAllowPassthrough;
});

/** The payloads of a split, in stream order, as the streams they came from. */
function joinSpans(spans: readonly { kind: string; text?: string; payload?: string }[]): string {
	let text = "";
	for (const span of spans) text += span.kind === "text" ? (span.text ?? "") : (span.payload ?? "");
	return text;
}

/**
 * Bytes the sixel path asked a regex to scan. The incremental parser walks its
 * input by hand, so a passing run measures zero; the pre-round-2 extractor
 * re-ran `matchAll`/`search` over the whole held accumulator on every chunk,
 * which is what this counts.
 */
function measureRegexScanVolume(fn: () => void): number {
	const originalMatchAll = String.prototype.matchAll;
	const originalSearch = String.prototype.search;
	let scanned = 0;
	String.prototype.matchAll = function (this: string, ...args: unknown[]) {
		scanned += this.length;
		return Reflect.apply(originalMatchAll as (...a: unknown[]) => unknown, this, args);
	} as unknown as typeof String.prototype.matchAll;
	String.prototype.search = function (this: string, ...args: unknown[]) {
		scanned += this.length;
		return Reflect.apply(originalSearch as (...a: unknown[]) => unknown, this, args);
	} as unknown as typeof String.prototype.search;
	try {
		fn();
	} finally {
		String.prototype.matchAll = originalMatchAll;
		String.prototype.search = originalSearch;
	}
	return scanned;
}

describe("SIXEL introducer recognition", () => {
	it("recognizes the 7-bit ESC P introducer", () => {
		expect(containsSixelSequence(SEVEN_BIT)).toBe(true);
		expect(matchSixelIntroducer(SEVEN_BIT, 0)).toBe("\x1bPq".length);
		expect(matchSixelIntroducer(`lead\x1bP1;2q#0~~\x1b\\`, 4)).toBe(10);
	});

	it("recognizes the 8-bit 0x90 introducer", () => {
		// 0x90 is a C1 byte: before this release only `ESC P` opened a frame, so
		// an 8-bit DCS reached the terminal as printable text.
		expect(containsSixelSequence(EIGHT_BIT)).toBe(true);
		expect(matchSixelIntroducer(EIGHT_BIT, 0)).toBe("\x90q".length);
		expect(matchSixelIntroducer(`lead\x90q#0~~\x9ctail`, 4)).toBe(6);
		expect(matchSixelIntroducer("\x901;2q#0~~\x9c", 0)).toBe(5);
	});

	it("still rejects a bare C1 byte and a DCS with another final byte", () => {
		expect(matchSixelIntroducer("\x90plain text", 0)).toBeUndefined();
		expect(matchSixelIntroducer("\x90q half-open", 0)).toBe(2);
		// DCS with a non-sixel final byte belongs to another protocol.
		expect(matchSixelIntroducer("\x1bPsome payload", 0)).toBeUndefined();
		expect(matchSixelIntroducer("\x90ssome payload", 0)).toBeUndefined();
		expect(matchSixelIntroducer("no introducer", 0)).toBeUndefined();
	});

	it("holds an introducer a chunk boundary split", () => {
		// A parser shown only this fragment opens a DCS string and swallows the
		// payload that arrives with the next chunk.
		expect(matchSixelIntroducer("text\x1b", 4)).toBe("partial");
		expect(matchSixelIntroducer("text\x1bP1;", 4)).toBe("partial");
		expect(matchSixelIntroducer("text\x90", 4)).toBe("partial");
		// Past the introducer length a fragment can no longer complete one.
		expect(matchSixelIntroducer("\x1bP" + ";".repeat(80), 0)).toBeUndefined();
	});
});

describe("SIXEL terminator forms", () => {
	const cases: Array<[string, string]> = [
		["ST", SEVEN_BIT],
		["BEL", BELL_TERMINATED],
		["8-bit ST on a 7-bit introducer", "\x1bPq#0~~\x9c"],
		["8-bit ST on an 8-bit introducer", EIGHT_BIT],
		["BEL on an 8-bit introducer", "\x90q#0~~\x07"],
	];

	for (const [label, stream] of cases) {
		it(`terminates a frame on ${label}`, () => {
			const spans = splitSixelSpans(stream);
			expect(spans).toEqual([{ kind: "sixel", payload: stream }]);
			expect(joinSpans(spans)).toBe(stream);
		});
	}

	it("keeps text on both sides of a frame intact", () => {
		for (const stream of [SEVEN_BIT, EIGHT_BIT]) {
			const spans = splitSixelSpans(`before\n${stream}\nafter`);
			expect(spans).toEqual([
				{ kind: "text", text: "before\n" },
				{ kind: "sixel", payload: stream },
				{ kind: "text", text: "\nafter" },
			]);
		}
	});
});

describe("SixelSpanParser handles the 8-bit form end to end", () => {
	it("emits an intact payload for an 8-bit frame fed in one write", () => {
		const parser = new SixelSpanParser();
		const spans = parser.push(EIGHT_BIT);
		expect(spans).toEqual([{ kind: "sixel", payload: EIGHT_BIT }]);
	});

	it("emits an intact payload for an 8-bit frame split across chunks", () => {
		const extract = createRawSixelExtractor();
		const spans = [...extract("\x90q#0;2;100;0;0#0"), ...extract("~~\x9c rest")];
		expect(spans).toEqual([
			{ kind: "sixel", payload: "\x90q#0;2;100;0;0#0~~\x9c" },
			{ kind: "text", text: " rest" },
		]);
	});

	it("survives the 8-bit form through the passthrough sanitizer", () => {
		// The sanitizer strips the C1 range, so an unrecognized 8-bit introducer
		// is destroyed here — the vterm then sees an unterminated payload as
		// printable text.
		enableSixelPassthrough();
		const sanitized = sanitizeWithOptionalSixelPassthrough(EIGHT_BIT, sanitizeText);
		expect(sanitized).toBe(EIGHT_BIT);
	});

	it("classifies a row closed by the 8-bit ST", () => {
		expect(classifySixelRow(`#0;2;100;0;0#0~~\x9c`, true)).toEqual({
			isSixel: true,
			inSequenceAtExit: false,
		});
		expect(classifySixelRow("#0~~", true)).toEqual({ isSixel: true, inSequenceAtExit: true });
	});
});

describe("SIXEL row classification", () => {
	it("keeps a second frame on the same row open when its terminator is still to come", () => {
		// Renderers clamp every row this classifier calls plain text. A classifier
		// that closes the row on the FIRST frame's terminator hands the second
		// frame's continuation rows to that clamp, which cuts them mid-DCS and
		// leaves the host terminal swallowing the rest of the stream as payload.
		const twoFrames = `${SEVEN_BIT}between${EIGHT_BIT}`;
		expect(classifySixelRow(twoFrames, false)).toEqual({ isSixel: true, inSequenceAtExit: false });

		// The second frame is only half written: its introducer is on this row,
		// its payload and terminator on the next.
		const halfWritten = `${SEVEN_BIT}between\x1bPq#0;2;100`;
		expect(classifySixelRow(halfWritten, false)).toEqual({ isSixel: true, inSequenceAtExit: true });
		// Over a row stream the follow-up rows stay payload, so the renderers keep
		// clamping them and cut the frame the host terminal is still inside.
		expect(getSixelLineMask([halfWritten, ";0;0#0~~\x1b\\tail", "plain"])).toEqual([true, true, false]);
	});

	it("treats a terminator that precedes an introducer as belonging to the earlier frame", () => {
		// The row enters inside a sequence, closes it, then opens a new one. A
		// terminator search that ignores order finds the stale one and reports the
		// new frame closed, so its payload rows get clamped instead of passed
		// through and the host stays inside an unterminated DCS.
		expect(classifySixelRow(`#0~~\x1b\\\x1bPq#0;2;100`, true)).toEqual({
			isSixel: true,
			inSequenceAtExit: true,
		});
	});
});

describe("SixelSpanParser incremental matching", () => {
	const chunkSize = 1024;

	function buildStream(total: number): string {
		return `\x1bPq${"~".repeat(total - "\x1bPq\x1b\\".length)}\x1b\\`;
	}

	it("produces the same split whatever the chunk boundaries are", () => {
		for (const stream of [SEVEN_BIT, EIGHT_BIT, `a${SEVEN_BIT}${EIGHT_BIT}b`]) {
			const expected = splitSixelSpans(stream);
			for (const size of [1, 2, 3, 7, 64, stream.length]) {
				const parser = new SixelSpanParser();
				const spans = [];
				for (let i = 0; i < stream.length; i += size) spans.push(...parser.push(stream.slice(i, i + size)));
				spans.push(...parser.finish());
				expect(spans).toEqual(expected);
				expect(joinSpans(spans)).toBe(stream);
			}
		}
	});

	it("holds a frame open across chunks instead of emitting its head", () => {
		const extract = createRawSixelExtractor();
		expect(extract(`text\n\x1bPq#0;2;100`)).toEqual([{ kind: "text", text: "text\n" }]);
		expect(extract(`;0;0#0`)).toEqual([]);
		expect(extract(`~~\x1b\\\ntail`)).toEqual([
			{ kind: "sixel", payload: "\x1bPq#0;2;100;0;0#0~~\x1b\\" },
			{ kind: "text", text: "\ntail" },
		]);
	});

	it("does not let the scan volume grow with the frame size", () => {
		// One size pair carries both halves of the linearity contract: the small
		// frame's absolute bound, and the large/small ratio that a super-linear
		// rescan would break. Rows at the sizes in between assert the same path
		// again, so they were duplicates rather than extra coverage.
		const volume = (total: number): number =>
			measureRegexScanVolume(() => {
				const stream = buildStream(total);
				const extract = createRawSixelExtractor();
				for (let i = 0; i < stream.length; i += chunkSize) {
					extract(stream.slice(i, i + chunkSize));
				}
			});
		const small = volume(64 * 1024);
		const large = volume(256 * 1024);
		expect(small).toBeLessThanOrEqual(64 * 1024 * 8);
		expect(large).toBeLessThanOrEqual(small * 8 + 1024);
	});

	it("emits exactly one payload span for a frame however it is chunked", () => {
		const parser = new SixelSpanParser();
		const spans = [];
		for (let i = 0; i < SEVEN_BIT.length; i++) spans.push(...parser.push(SEVEN_BIT[i]));
		spans.push(...parser.finish());
		expect(spans).toEqual([{ kind: "sixel", payload: SEVEN_BIT }]);
	});
});
