import { describe, expect, it } from "bun:test";
import {
	clearRenderCache,
	type DefaultTextStyle,
	fastLineStartHazard,
	fastTailSplices,
	Markdown,
	resetFastTailSplices,
} from "@oh-my-pi/pi-tui/components/markdown";
import { defaultMarkdownTheme } from "./test-themes.js";

// B+ fast-tail contract: when a transient streaming frame's last content row
// came from a paragraph, an append-only same-line delta re-renders ONLY that
// row (splice of the re-wrapped grown row onto the previous frame's rows)
// instead of re-lexing the whole tail. The observable contract is BYTE
// IDENTITY with a cold full render at EVERY frame (the new text shows every
// frame — no B-style lag) plus correct disarming on style/structural hazards
// and reset on finalize/width/flip transitions. These tests encode that
// matrix; the adversarial seam gates (URL/entity/swatch/ref-def/OSC-8/`*`
// marker completion, bgColor signature swaps) are covered HERE — each hazard
// is streamed across the splice seam so the disarming frame lands mid-stream.

const THEME = defaultMarkdownTheme;

function renderCold(text: string, width: number, defaultTextStyle?: DefaultTextStyle): readonly string[] {
	clearRenderCache();
	const out = new Markdown(text, 0, 0, THEME, defaultTextStyle).render(width);
	clearRenderCache();
	return out;
}

interface RevealOptions {
	/** Render width (default 60). */
	width?: number;
	/** Reveal `full` in `step`-char increments (default 1 — every split lands on a frame, including seam straddles). */
	step?: number;
	/** Default text style passed through to BOTH the streaming instance and the cold oracle. */
	defaultTextStyle?: DefaultTextStyle;
	/** Reuse this streaming instance instead of creating a fresh one (for stateful callers). */
	streaming?: Markdown;
}

/** Reveal `full` in `step`-char increments through ONE reused transient
 *  (streaming) instance; assert EVERY frame is byte-identical to a cold full
 *  render of the same prefix (byte identity = the new text is visible — no
 *  lag). The streaming instance must go through its own incremental path
 *  every step, so the cold oracle always re-lexes. The styled variant passes
 *  a `defaultTextStyle` so the same loop covers run-styled paths; the plain
 *  path omits it. */
function assertByteIdentityEveryFrame(full: string, opts: RevealOptions = {}): void {
	const { width = 60, step = 1, defaultTextStyle, streaming = new Markdown("", 0, 0, THEME, defaultTextStyle) } = opts;
	streaming.transientRenderCache = true;
	for (let len = 1; len <= full.length; len += step) {
		const slice = full.slice(0, len);
		clearRenderCache();
		streaming.setText(slice);
		expect(streaming.render(width)).toEqual(renderCold(slice, width, defaultTextStyle));
	}
	clearRenderCache();
	streaming.setText(full);
	expect(streaming.render(width)).toEqual(renderCold(full, width, defaultTextStyle));
}

describe("B+ fast-tail paragraph re-wrap", () => {
	it("prose reveal shows new text every frame (no lag)", () => {
		// Inert prose deltas with no style markers: the fast path re-wraps the
		// growing last row every frame.
		assertByteIdentityEveryFrame(
			"This is a plain prose paragraph that streams in one character at a time without any markdown styling markers.",
		);
	});

	it("run-level default style disarms fast path (single ANSI run contract)", () => {
		// With a run-level defaultTextStyle (color/italic — as streamed
		// thinking and colored assistant content use), a splice would
		// concatenate a pre-styled row with a separately styled delta: two
		// ANSI runs where a cold render produces one. The fast path must not
		// engage — every frame stays byte-identical to cold.
		const style = { color: (t: string) => `\x1b[35m${t}\x1b[39m`, italic: true };
		assertByteIdentityEveryFrame("a styled streaming paragraph grows one character at a time", {
			defaultTextStyle: style,
		});
	});

	it("intraword underscore deltas stay on the fast path (narrowed gate)", () => {
		// `_` inside a word is literal per CommonMark flanking rules — the
		// delta `_` must NOT force a full re-lex every frame; the grown row
		// re-wraps with the literal underscore byte-identical to cold.
		assertByteIdentityEveryFrame("measure the raw_word_delta against the baseline at every frame");
	});

	it("open emphasis closed by a later delta re-lexes the grown row", () => {
		// A row holding an OPEN `*` disarms any marker delta; the closing `*`
		// frame re-lexes so the whole span renders styled, not as a stale
		// literal row.
		assertByteIdentityEveryFrame("the *whole span* must render emphasized, not stale");
	});

	it("paragraph completing into a list marker disarms (line-start hazard)", () => {
		// `abc\n1. item` lexes as paragraph + LIST, not one paragraph — the
		// grown-line start check must disarm so the splice never renders the
		// list as paragraph text.
		assertByteIdentityEveryFrame("abc\n1. item");
	});

	it("finalize after fast-path frames is byte-identical to cold", () => {
		const full = "finalizing a streaming paragraph must match the cold render exactly";
		const streaming = new Markdown("", 0, 0, THEME);
		streaming.transientRenderCache = true;
		for (let len = 1; len <= full.length; len += 3) {
			clearRenderCache();
			streaming.setText(full.slice(0, len));
			streaming.render(60);
		}
		streaming.transientRenderCache = false;
		clearRenderCache();
		streaming.setText(full);
		expect(streaming.render(60)).toEqual(renderCold(full, 60));
	});

	it("width change after fast-path frames re-lexes at new width", () => {
		const full = "a streamed paragraph that must reflow cleanly when the terminal width changes mid-stream";
		const streaming = new Markdown("", 0, 0, THEME);
		streaming.transientRenderCache = true;
		for (let len = 1; len <= full.length; len += 3) {
			clearRenderCache();
			streaming.setText(full.slice(0, len));
			streaming.render(80);
		}
		clearRenderCache();
		streaming.setText(full);
		expect(streaming.render(40)).toEqual(renderCold(full, 40));
	});

	it("first frame is cold (no fast path)", () => {
		const fresh = new Markdown("hello world", 0, 0, THEME);
		fresh.transientRenderCache = true;
		clearRenderCache();
		expect(fresh.render(60)).toEqual(renderCold("hello world", 60));
	});

	it("overflow long word re-wraps identically (break_long_word parity)", () => {
		assertByteIdentityEveryFrame(
			"A verylongwordthatcannotfitwithintherowwidthandmustbesplitbysomeheuristicacrossthelines",
			{ width: 40 },
		);
	});

	it("CRLF delta disarms fast path", () => {
		assertByteIdentityEveryFrame("first line\r\nsecond line");
	});

	it("transientRenderCache flip mid-stream drops fast path", () => {
		const full = "flipping transient off and back on must never serve a stale fast-path row";
		const streaming = new Markdown("", 0, 0, THEME);
		streaming.transientRenderCache = true;
		for (let len = 1; len <= full.length; len += 3) {
			clearRenderCache();
			streaming.setText(full.slice(0, len));
			streaming.render(60);
		}
		streaming.transientRenderCache = false;
		streaming.transientRenderCache = true;
		clearRenderCache();
		streaming.setText(full);
		expect(streaming.render(60)).toEqual(renderCold(full, 60));
	});

	it("URL head straddling the seam disarms, then byte-identity re-establishes", () => {
		// `https:/` ends a captured row; the delta `/` completes `https://`.
		// The seam gates (FAST_URL_PREFIX_SEAM_RE on the row tail plus the
		// seam-window URL scan) must NOT splice the seam — the next frame
		// falls through to a full re-lex and byte-identity re-establishes.
		assertByteIdentityEveryFrame("see the docs at https://example.com/guide for detail");
	});

	it("HTML entity split across the seam never half-normalizes", () => {
		// `&am` ends the captured row and `p;` arrives in the delta
		// (FAST_ENTITY_SEAM_RE). The seam must disarm so the entity only
		// normalizes once complete — every frame byte-identical to cold.
		assertByteIdentityEveryFrame("fish &amp; chips");
	});

	it("hex swatch across the seam renders atomically, never partial", () => {
		// `#1a` straddles the seam; `2b3c` arrives later. FAST_SWATCH_SEAM_RE
		// (a `#` + 0-2 hex tail) and FAST_RUN_END_RE (a complete hex head)
		// must disarm so the swatch glyph appears only when the run is
		// complete, never as a stale partial row.
		assertByteIdentityEveryFrame("the accent color is #1a2b3c here");
	});

	it("paragraph line completing into a ref-def disarms (line-start gate)", () => {
		// The second block's last line grows `[lab` → `[label]: https://…`.
		// Reference definitions lex to a different token shape, so the
		// line-start gate (REF_DEF_LINE_RE) must disarm the crossing frame —
		// byte identity holds at every step.
		assertByteIdentityEveryFrame("intro words\n\n[label]: https://example.com");
	});

	it("OSC-8 hyperlink trailing row is skipped by capture, stays byte-identical", () => {
		// The tail-row capture skips rows whose rendered text contains an
		// OSC-8 sequence (`\x1b]`), so the hyperlink row always re-renders
		// whole; the reveal stays byte-identical at every frame.
		assertByteIdentityEveryFrame("see \x1b]8;;https://example.com\x07link\x1b]8;;\x07 here");
	});

	it("unordered `*` marker completing into a list item disarms (line-start hazard)", () => {
		// A paragraph line that grows `*` → `* item one` completes a list
		// marker when the space arrives — the grown-line start check must
		// disarm that frame so the block re-lexes as a LIST, never a stale
		// paragraph splice. (A lone `*` reveal is just the first-frame-cold
		// case already covered above.)
		assertByteIdentityEveryFrame("note:\n\n* item one");
	});

	it("bgColor signature change between frames re-renders with the new style", () => {
		// defaultTextStyle is passed to the constructor by reference and
		// exposes no setter, so the public mutation path is swapping bgColor
		// on that same object. A fast recipe armed under the OLD bgColor must
		// not serve rows styled with it once the signature changes: the next
		// render must equal a cold render under the NEW bgColor (never a
		// splice of the old).
		const style = { bgColor: (t: string) => `\x1b[48;5;52m${t}\x1b[0m` };
		const base = "This is a fairly long styled paragraph that wraps onto several rows";
		const streaming = new Markdown("", 0, 0, THEME, style);
		assertByteIdentityEveryFrame(base, { width: 20, step: 3, defaultTextStyle: style, streaming });
		style.bgColor = (t: string) => `\x1b[48;5;22m${t}\x1b[0m`;
		const grown = `${base} and more`;
		clearRenderCache();
		streaming.setText(grown);
		expect(streaming.render(20)).toEqual(renderCold(grown, 20, style));
	});
	/** Stream the exact `parts` frames through one transient instance and
	 *  assert the LAST frame is byte-identical to a cold render of `full`.
	 *  The two-frame sequence is required: the failing splice frame needs the
	 *  whole cross-seam delta in ONE setText call (the per-char reveal helper
	 *  cannot produce it). */
	function assertSpliceParts(parts: string[], full: string, width = 60): void {
		const streaming = new Markdown("", 0, 0, THEME);
		streaming.transientRenderCache = true;
		let out: readonly string[] = [];
		for (const p of parts) {
			clearRenderCache();
			streaming.setText(p);
			out = streaming.render(width);
		}
		expect(out).toEqual(renderCold(full, width));
		clearRenderCache();
	}

	it("closed * pair delta does not re-pair across the seam", () => {
		// Row "x *a*" ends in a closed `*`; delta `*b*` OPENS with `*`. A
		// splice renders em(a)+em(b) where the cold lex of "x *a**b*" makes
		// ONE token (em("a**b")). pairSeamHazard must disarm that frame.
		assertSpliceParts(["x *a*", "x *a**b*"], "x *a**b*");
	});

	it("closed ** pair delta does not re-pair", () => {
		// Same re-pairing with a strong delimiter: cold lex renders literal
		// `**b*` tail, not a strong run — the splice must disarm.
		assertSpliceParts(["x **a**", "x **a****b**"], "x **a****b**");
	});

	it("closed ~~ pair delta does not re-pair", () => {
		// Strikethrough mirrors the `*` case: one cold token vs two spliced
		// styled runs across the seam.
		assertSpliceParts(["x ~~a~~", "x ~~a~~~~b~~"], "x ~~a~~~~b~~");
	});

	it("box-drawing HR completing across the seam disarms", () => {
		// A blank-line-preceded `══` line grows one `═` into `═══`, which the
		// cold lex parses as an HR (customHr block); the grown-line start gate
		// must disarm so the splice never renders it as paragraph text.
		assertSpliceParts(["abc\n\n══", "abc\n\n═══"], "abc\n\n═══");
	});

	it("numeric entity decoding to # disarms", () => {
		// `&#35;` at the row end decodes to `#` — a swatch lead — so an inert
		// delta could re-swatch; the seam gate must disarm the crossing frame.
		assertSpliceParts(["&#35;", "&#35;abc"], "&#35;abc");
	});

	it("image marker completing across the seam disarms", () => {
		assertSpliceParts(["x!", "x![a](u)"], "x![a](u)");
	});

	it("entity-decoded swatch lead mid-row disarms", () => {
		assertSpliceParts(["x &#35;ab", "x &#35;abc"], "x &#35;abc");
	});

	it("row-ending underscore followed by word delta disarms (intraword re-flank)", () => {
		assertSpliceParts(["_foo_", "_foo_b"], "_foo_b");
	});

	it("row-ending star followed by word delta disarms (flank re-eval)", () => {
		assertSpliceParts(["*a.*", "*a.*b"], "*a.*b");
	});

	it("row-ending tilde pair followed by word delta disarms", () => {
		assertSpliceParts(["~~a.~~", "~~a.~~b"], "~~a.~~b");
	});

	it("row-ending math delimiter followed by digit disarms (anti-currency)", () => {
		assertSpliceParts(["the value is $x$", "the value is $x$123"], "the value is $x$123");
	});

	it("row-ending underscore after a Unicode word char disarms (intraword re-flank)", () => {
		// CommonMark flanking treats `é` as a word char (Unicode punctuation), so
		// `é_foo_` is intraword-literal: the closing `_` cannot open emphasis. An
		// ASCII-only `\w` predicate would miss that and splice the styled row.
		assertSpliceParts(["é", "é_foo_"], "é_foo_");
	});

	it("row-ending closing star followed by a Unicode format char disarms (CommonMark word class)", () => {
		// marked's flanking word-char class is `[^\s\p{P}\p{S}]` (includes Cf/Mn):
		// `*a.*` + ZWJ U+200C is literal (the `*` is non-right-flanking), but the
		// ASCII-word splice would keep the styled row.
		assertSpliceParts(["*a.*", "*a.*​"], "*a.*​");
		// Combining acute (Mn) and soft hyphen (Cf) hit the same seam.
		assertSpliceParts(["*a.*", "*a.*́"], "*a.*́");
		assertSpliceParts(["*a.*", "*a.*­"], "*a.*­");
	});

	it("inert delta completing a GFM delimiter row flips the tail to a table — disarms", () => {
		// Streamed `| col_a | col_b |\n| --`, then a marker-free `--- | -`: the
		// grown last line becomes a valid delimiter, so cold render wraps and
		// restyles the header as a table. A splice would keep the paragraph rows
		// byte-for-byte and diverge from cold.
		const frozen = "Intro paragraph before the table streams in, with a `code span` and **bold** for flavor. ";
		assertSpliceParts(
			[`${frozen}\n\n| col_a | col_b |\n| --`, `${frozen}\n\n| col_a | col_b |\n| ----- | --`],
			`${frozen}\n\n| col_a | col_b |\n| ----- | --`,
		);
		assertSpliceParts(["paragraph\n\n| one |\n|", "paragraph\n\n| one |\n|-"], "paragraph\n\n| one |\n|-");
	});
});

it("line-start hazard does not fire on prose (char-class range regression)", () => {
	// A `-` placed mid-class (`[*+-…]`) parses `+`-`─` as U+002B..U+2500,
	// matching ASCII letters — the gate would disarm every prose frame and
	// the fast path would never engage. Prose lines must stay safe.
	for (const line of ["hello world", "a b c", "the quick brown fox", "plain text here", "foo", "x y z"]) {
		expect(fastLineStartHazard(line)).toBe(false);
	}
});

it("line-start hazard fires on block markers and HRs", () => {
	for (const line of ["# h", "> q", "1. x", "- a", "+ a", "---", "***", "═══", "───", "==="]) {
		expect(fastLineStartHazard(line)).toBe(true);
	}
});

it("line-start hazard fires on a ref-def", () => {
	expect(fastLineStartHazard("[label]: https://x")).toBe(true);
});

it("fast path engages on a prose reveal (splice counter > 0)", () => {
	// A regression that silently disarms every frame (e.g. an over-broad
	// line-start gate matching all ASCII) leaves byte-identity intact but
	// drops the splice count to zero — invisible to the byte-identity suite.
	// This asserts the fast path actually runs on plain streaming prose.
	const prose =
		"This is a plain prose paragraph that streams in one character at a time without any markdown styling markers.";
	const streaming = new Markdown("", 0, 0, THEME);
	streaming.transientRenderCache = true;
	resetFastTailSplices();
	for (let len = 1; len <= prose.length; len++) {
		clearRenderCache();
		streaming.setText(prose.slice(0, len));
		streaming.render(60);
	}
	expect(fastTailSplices).toBeGreaterThan(0);
	resetFastTailSplices();
});
