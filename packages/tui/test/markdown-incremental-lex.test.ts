import { describe, expect, it } from "bun:test";
import { clearRenderCache, Markdown } from "@oh-my-pi/pi-tui/components/markdown";
import { defaultMarkdownTheme } from "./test-themes.js";

// E2 contract: the streaming incremental lexer (lex(prefix) ++ lex(tail), reusing
// frozen blank-line-bounded blocks) must produce BYTE-IDENTICAL output to a fresh
// full lex of the same text at every growth step. A faster-but-divergent render is
// a regression, so this is the gate that keeps E2 honest.
//
// Masking hazard: Markdown's module-level L2 render cache keys on (text, width),
// so a streaming render that produced WRONG lines would cache them and the "fresh"
// oracle would read the same wrong lines back. We `clearRenderCache()` around the
// oracle so it always cold-lexes, and again so the next streaming render cannot
// hit a stale entry — the streaming instance must go through its own incremental
// `#lexTokens` path every step.

const THEME = defaultMarkdownTheme;

function renderCold(text: string, width: number): readonly string[] {
	clearRenderCache();
	const out = new Markdown(text, 0, 0, THEME).render(width);
	clearRenderCache();
	return out;
}
/** Cold render in transient mode — same masking-safe pattern as renderCold. */
function renderColdTransient(text: string, width: number): readonly string[] {
	clearRenderCache();
	const out = new Markdown(text, 0, 0, THEME);
	out.transientRenderCache = true;
	const lines = out.render(width);
	clearRenderCache();
	return lines;
}

/** Reveal `full` in `step`-char increments through ONE reused (streaming) instance
 *  and assert each step matches a cold full-lex render of the same prefix. */
function assertIdenticalGrowth(full: string, width = 60, step = 13): void {
	const streaming = new Markdown("", 0, 0, THEME);
	for (let len = 1; len <= full.length; len += step) {
		const slice = full.slice(0, len);
		clearRenderCache();
		streaming.setText(slice);
		const streamLines = streaming.render(width);
		const oracle = renderCold(slice, width);
		expect(streamLines).toEqual(oracle);
	}
	clearRenderCache();
	streaming.setText(full);
	const streamLines = streaming.render(width);
	expect(streamLines).toEqual(renderCold(full, width));
}

/** Same as {@link assertIdenticalGrowth} but with a TRANSIENT streaming instance,
 *  which activates Markdown's render-prefix cache (the transient path caches
 *  content lines for the stable lex-prefix tokens and re-renders only the tail).
 *  The split render must still be byte-identical to a cold full render at every
 *  step — a faster-but-divergent split is a regression. */
function assertIdenticalGrowthTransient(full: string, width = 60, step = 13): void {
	const streaming = new Markdown("", 0, 0, THEME);
	streaming.transientRenderCache = true;
	for (let len = 1; len <= full.length; len += step) {
		const slice = full.slice(0, len);
		clearRenderCache();
		streaming.setText(slice);
		const streamLines = streaming.render(width);
		const oracle = renderCold(slice, width);
		expect(streamLines).toEqual(oracle);
	}
	clearRenderCache();
	streaming.setText(full);
	const streamLines = streaming.render(width);
	expect(streamLines).toEqual(renderCold(full, width));
}

const PROSE =
	"Para one with **bold** and _italic_ words and a `code span` for flavor.\n\n" +
	"Para two continues the document with more sentences so the lexer has real\n" +
	"block structure to chew on, then a third paragraph grows at the tail end as\n\n" +
	"the stream appends additional content token by token over many frames here.";

const FENCED =
	"Intro paragraph before the code block begins streaming in slowly.\n\n" +
	"```ts\nconst x: number = compute(a, b) + delta;\nfor (let i = 0; i < x; i++) {\n  emit(i);\n}\nreturn x.toFixed(2);\n```\n\n" +
	"Trailing prose after the fence keeps growing with more and more sentences.";

const LIST =
	"Lead-in sentence before the list.\n\n" +
	"- first bullet item with `inline`\n- second bullet item in **bold**\n- third bullet item\n\n" +
	"1. ordered one\n2. ordered two\n3. ordered three\n\n" +
	"Closing paragraph that keeps streaming additional words to the very end here.";

const HEADINGS =
	"# Title heading\n\nIntro text under the title with some detail.\n\n" +
	"## Section two\n\nBody of section two grows over time.\n\n" +
	"### Subsection\n\nDeeper content that streams in at the tail as the reveal advances.";

const MIXED = (() => {
	const para =
		"The quick brown fox jumps over the lazy dog while a `code span` and **bold** _italic_ exercise things. ";
	const cb = "\n```ts\nconst x = compute(a, b);\nreturn x;\n```\n\n";
	const list = "\n- one\n- two `inline`\n- three\n\n";
	let out = "";
	for (let i = 1; i <= 6; i++) out += `## Section ${i}\n\n${para}${para}${cb}${list}`;
	return out;
})();

const TABLE = (() => {
	// Table rows stream in as the tail grows: a growing table in the unfrozen
	// tail must render byte-identically (the tail row cache excludes `table`
	// tokens, so these frames exercise the exclusion path under
	// assertIdenticalGrowthTransient).
	const para = "Intro paragraph before the table streams in, with a `code span` and **bold** for flavor. ";
	let out = `${para}\n\n| col_a | col_b |\n| ----- | ----- |\n`;
	for (let i = 1; i <= 4; i++) out += `| row_${i}_a | row_${i}_b |\n`;
	out += "\n\nTrailing prose after the table keeps growing with more sentences.";
	return out;
})();

describe("Markdown incremental streaming lex (E2)", () => {
	it("prose growth is byte-identical to full lex", () => {
		assertIdenticalGrowth(PROSE);
	});

	it("fenced code growth (open then close) is byte-identical", () => {
		assertIdenticalGrowth(FENCED);
	});

	it("list growth is byte-identical", () => {
		assertIdenticalGrowth(LIST);
	});

	it("heading growth is byte-identical", () => {
		assertIdenticalGrowth(HEADINGS);
	});

	it("mixed multi-section corpus growth is byte-identical", () => {
		assertIdenticalGrowth(MIXED, 80, 29);
	});

	it("transient render-prefix cache: prose split render is byte-identical", () => {
		assertIdenticalGrowthTransient(PROSE);
	});

	it("transient render-prefix cache: fenced code split render is byte-identical", () => {
		assertIdenticalGrowthTransient(FENCED);
	});

	it("transient render-prefix cache: mixed multi-section split render is byte-identical", () => {
		assertIdenticalGrowthTransient(MIXED, 80, 29);
	});

	it("transient render-prefix cache: table growing in the tail is byte-identical", () => {
		assertIdenticalGrowthTransient(TABLE, 60, 7);
	});

	it("a width change mid-stream still matches a cold render at the new width", () => {
		const streaming = new Markdown("", 0, 0, THEME);
		// Warm the stream cache at width 80 across the whole message.
		for (let len = 1; len <= MIXED.length; len += 41) {
			clearRenderCache();
			streaming.setText(MIXED.slice(0, len));
			streaming.render(80);
		}
		// Now render the full text at a NARROWER width: frozen tokens are width-
		// independent, so output must match a cold full lex at the new width.
		clearRenderCache();
		streaming.setText(MIXED);
		const narrow = streaming.render(40);
		expect(narrow).toEqual(renderCold(MIXED, 40));
		// And back to a wider width.
		clearRenderCache();
		const wide = streaming.render(100);
		expect(wide).toEqual(renderCold(MIXED, 100));
	});

	it("reference-link definitions (fallback path) still render correctly while growing", () => {
		const refDoc =
			"See [the docs][d] and [the spec][s] for details on the protocol.\n\n" +
			"A middle paragraph with ordinary prose that keeps growing here.\n\n" +
			"[d]: https://example.com/docs\n[s]: https://example.com/spec\n\n" +
			"Closing paragraph streamed at the tail with extra sentences appended.";
		assertIdenticalGrowth(refDoc);
	});

	// Regression: HAS_REF_DEF must also catch labels with backslash-escaped
	// brackets (`[a\]b]: …`). marked resolves such a definition document-wide,
	// so if the detector misses it the already-frozen paragraph keeps its plain
	// text inline tokens while a cold lex rewrites `[a\]b]` into a link.
	it("an escaped-bracket reference definition falls back to a correct full render", () => {
		const escapedRef =
			"See [a\\]b] for details in the long discussion that follows below.\n\n" +
			"More prose streams in before the definition finally arrives down here.\n\n" +
			"[a\\]b]: https://example.com/escaped\n\n" +
			"Trailing paragraph after the definition keeps the stream going on.";
		assertIdenticalGrowth(escapedRef, 60, 1);
		assertIdenticalGrowth(escapedRef, 60, 13);
	});

	// Regression: marked merges a list with a following same-marker list across a
	// blank line into one renumbered loose list (CommonMark loose-list
	// continuation). Freezing across that "\n\n" cut keeps them separate and
	// renumbers/spaces wrong. These cases must hold at the production reveal
	// granularity (MIN_STEP=3) and at step=1 — the divergence is phase-sensitive.
	it("two consecutive ordered lists stay merged/renumbered while growing", () => {
		const twoLists = "1. a\n2. b\n\n1. c\n2. d";
		assertIdenticalGrowth(twoLists, 60, 1);
		assertIdenticalGrowth(twoLists, 60, 3);
	});

	it("a loose ordered list (blank lines between items) stays correct while growing", () => {
		const loose =
			"Intro line before the numbered list begins here.\n\n" +
			"1. First point with enough words to wrap nicely.\n\n" +
			"2. Second point also with sufficient words here.\n\n" +
			"3. Third and final point streamed at the tail end.";
		assertIdenticalGrowth(loose, 60, 1);
		assertIdenticalGrowth(loose, 60, 3);
	});

	it("a loose bullet list stays correct while growing", () => {
		const loose =
			"Lead-in before the bullets.\n\n" +
			"- alpha item with several words to wrap\n\n" +
			"- beta item with several words to wrap\n\n" +
			"- gamma item streamed at the tail end here.";
		assertIdenticalGrowth(loose, 60, 1);
		assertIdenticalGrowth(loose, 60, 3);
	});

	it("a non-append change (text replaced) falls back to a correct full render", () => {
		const streaming = new Markdown("", 0, 0, THEME);
		clearRenderCache();
		streaming.setText("# First document\n\nOriginal body paragraph one.\n\nOriginal body paragraph two.\n");
		streaming.render(60);
		// Replace with unrelated content that is NOT a prefix-extension.
		clearRenderCache();
		streaming.setText("## Different\n\nCompletely new content replacing the old buffer entirely.\n");
		const replaced = streaming.render(60);
		expect(replaced).toEqual(
			renderCold("## Different\n\nCompletely new content replacing the old buffer entirely.\n", 60),
		);
	});

	it("a transient non-append replacement with no block boundary is not served stale prefix lines", () => {
		// Regression: the render-prefix cache guards on #streamPrefixText, which
		// #freezeStablePrefix leaves untouched when the new text has no freezable
		// "\n\n" boundary. Without clearing it on the fallback path, a transient
		// replacement by single-line content emitted the OLD prefix's rendered lines.
		const streaming = new Markdown("", 0, 0, THEME);
		streaming.transientRenderCache = true;
		clearRenderCache();
		streaming.setText("# First document\n\nOriginal body paragraph one.\n\nOriginal body paragraph two.\n");
		streaming.render(60);
		// Replace with unrelated single-line content — no "\n\n" boundary to freeze.
		clearRenderCache();
		streaming.setText("a flat replacement with no double newline at all");
		const replaced = streaming.render(60);
		expect(replaced).toEqual(renderCold("a flat replacement with no double newline at all", 60));
	});

	it("CRLF text (fallback path) renders identically to a cold lex", () => {
		const streaming = new Markdown("", 0, 0, THEME);
		const crlf = "Para one with content.\r\n\r\nPara two with `code`.\r\n\r\nPara three tail.\r\n";
		for (let len = 1; len <= crlf.length; len += 11) {
			clearRenderCache();
			streaming.setText(crlf.slice(0, len));
			const streamLines = streaming.render(60);
			expect(streamLines).toEqual(renderCold(crlf.slice(0, len), 60));
		}
	});

	// Closed-list lookahead: a "\n\n" boundary directly after a list token is
	// freezable iff the tail cannot start a continuation item of that list
	// (same bullet char, or 1-9 digits + same delimiter — marked's
	// listItemRegex). These corpora cross list/non-list and
	// list/incompatible-list boundaries; the divergence (and the freeze
	// opportunity) is phase-sensitive, so each runs at step=1 and the
	// production reveal granularity (step=3).
	it("bullet list followed by a paragraph grows byte-identically", () => {
		const doc =
			"- alpha item with words\n- beta item with words\n- gamma item\n\n" +
			"Closing paragraph that keeps streaming additional words to the end.";
		assertIdenticalGrowth(doc, 60, 1);
		assertIdenticalGrowth(doc, 60, 3);
		assertIdenticalGrowthTransient(doc, 60, 3);
	});

	it("bullet list followed by a different-marker list stays two lists", () => {
		const doc = "- alpha\n- beta\n\n* starred one\n* starred two\n\n+ plus one\n+ plus two";
		assertIdenticalGrowth(doc, 60, 1);
		assertIdenticalGrowth(doc, 60, 3);
	});

	it("ordered list followed by a paren-delimited list stays two lists", () => {
		const doc = "1. dot one\n2. dot two\n\n1) paren one\n2) paren two";
		assertIdenticalGrowth(doc, 60, 1);
		assertIdenticalGrowth(doc, 60, 3);
		assertIdenticalGrowthTransient(doc, 60, 3);
	});

	it("list followed by blockquote grows byte-identically", () => {
		const doc = "- alpha\n- beta\n\n> quoted line one with words\n> quoted line two here";
		assertIdenticalGrowth(doc, 60, 1);
		assertIdenticalGrowth(doc, 60, 3);
	});

	it("list followed by heading grows byte-identically", () => {
		const doc = "1. one\n2. two\n\n# Heading after the list\n\nTail prose keeps going on.";
		assertIdenticalGrowth(doc, 60, 1);
		assertIdenticalGrowth(doc, 60, 3);
	});

	it("list followed by fenced code grows byte-identically", () => {
		const doc = "- alpha\n- beta\n\n```ts\nconst x = compute(a, b);\nreturn x;\n```\n\ntail text";
		assertIdenticalGrowth(doc, 60, 1);
		assertIdenticalGrowth(doc, 60, 3);
	});

	it("a same-marker list across a blank line still merges while growing", () => {
		const bullets = "- a\n- b\n\n- c\n- d";
		assertIdenticalGrowth(bullets, 60, 1);
		assertIdenticalGrowth(bullets, 60, 3);
	});

	it("a list closed by a paragraph freezes at the boundary (streaming perf gate)", () => {
		// The lookahead must actually fire here: the tail after the blank line
		// is a paragraph, which cannot continue a `-` list, so the rendered
		// list rows become settled (frozen prefix) on the transient path.
		const doc = "- alpha\n- beta\n- gamma\n\nClosing paragraph after the list keeps going.";
		const streaming = new Markdown("", 0, 0, THEME);
		streaming.transientRenderCache = true;
		clearRenderCache();
		streaming.setText(doc);
		const streamLines = streaming.render(60);
		expect(streamLines).toEqual(renderCold(doc, 60));
	});

	it("orphan-fence repair starting mid-stream keeps growth byte-identical", () => {
		// Final-mode repairOrphanClosingFence deletes an unmatched bare fence
		// once both a heading and a GFM table delimiter follow it. The raw text
		// grows append-only across the transition while the NORMALIZED text
		// (with the fence deleted) is no longer an append-extension of the
		// previous frame's, so the guard-scan memo's byte alignment is put to
		// the test: the trigger either brings "\n" into the delta (suspicious
		// path re-scans) or shortens the text (length gate re-derives). The
		// cold-render oracle must match at every step.
		const doc =
			"Intro paragraph before the stray fence lands in the stream.\n\n" +
			"```\n" +
			"# Heading after the orphan fence\n\n" +
			"| col a | col b |\n" +
			"| --- | --- |\n\n" +
			"Trailing paragraph that keeps streaming after the table ends.";
		assertIdenticalGrowth(doc, 60, 1);
		assertIdenticalGrowth(doc, 60, 3);
		assertIdenticalGrowth(doc, 60, 13);
	});

	it("a document that is one still-growing list never freezes mid-list", () => {
		// No (b)-style intra-list freezing shipped: loose/tight and ordered
		// renumbering are whole-list properties, so no prefix of an open list
		// is byte-stable. Settled rows must stay 0 for a pure-list document.
		const doc = "- one two three\n- four five six\n\n- seven eight nine";
		const streaming = new Markdown("", 0, 0, THEME);
		streaming.transientRenderCache = true;
		for (let len = 1; len <= doc.length; len += 1) {
			clearRenderCache();
			streaming.setText(doc.slice(0, len));
			const streamLines = streaming.render(60);
			expect(streamLines).toEqual(renderCold(doc.slice(0, len), 60));
		}
	});

	it("flipping transientRenderCache re-derives the guard memo", () => {
		// Regression: final mode normalized this document through
		// repairOrphanClosingFence, which deleted the bare fence line carrying
		// the text's only "\r". Memoized in final mode the verdict is
		// canStream=true (no CR, no ref defs) with #lastScanLength taken from
		// the REPAIRED buffer. Flipping to transient mode re-introduces the
		// raw "\r" (transient skips repair); if the memo survived the flip, a
		// clean-suffix append would reuse canStream=true and stream the
		// CR-containing tail. The mode flip must invalidate the memo so the
		// next frame re-derives and falls back to the full lex.
		const crlfFence =
			"Intro paragraph before the stray fence with a CRLF line end.\n\n" +
			"```\r\n" +
			"# Heading after the fence\n\n" +
			"| a | b |\n" +
			"| --- | --- |\n\n" +
			"Tail prose that only streams in after the table.";
		const streaming = new Markdown("", 0, 0, THEME);
		clearRenderCache();
		streaming.setText(crlfFence);
		streaming.render(60); // final mode: repair deletes the fence + its CR
		// Switch to transient streaming on the same instance and append only
		// CLEAN suffixes (no newline/bracket/colon): a stale memo would be
		// reused on each of these and stream the CR-containing tail against
		// the repaired-buffer prefix, diverging from the cold render.
		streaming.transientRenderCache = true;
		let grown = crlfFence;
		for (const suffix of [" tail-a", " tail-b", " tail-c"]) {
			grown += suffix;
			clearRenderCache();
			streaming.setText(grown);
			const streamLines = streaming.render(60);
			expect(streamLines).toEqual(renderColdTransient(grown, 60));
		}
	});
});

describe("Markdown OSC 8 tail normalization across streaming appends", () => {
	const ST = "\x1b\\";
	const LINK = "\x1b]8;;https://example.com";

	/** Append `chunks` one by one through a single streaming instance and
	 *  assert each step's render is byte-identical to a cold full-lex render. */
	function assertChunkedGrowth(chunks: string[], width = 60): void {
		const streaming = new Markdown("", 0, 0, THEME);
		let text = "";
		for (const chunk of chunks) {
			text += chunk;
			clearRenderCache();
			streaming.setText(text);
			expect(streaming.render(width)).toEqual(renderCold(text, width));
		}
	}

	it("normalizes an OSC 8 escape split across appends like a cold render", () => {
		// The escape prefix, its body, and the ST terminator arrive in separate
		// setText calls: the crossing match (started in the memoized pending
		// suffix, completed in the delta) must be rewritten (ST → BEL) exactly
		// like the full-document pass, and the following appends (now desynced
		// from the caller's raw text) must fall back to the cold path and stay
		// byte-identical.
		assertChunkedGrowth(["\x1b]8;;", "https://example.com", ST, "`example.ts`", `\x1b]8;;${ST}`]);
	});

	it("keeps a BEL-terminated escape and an invalid ESC tail byte-identical", () => {
		// A BEL closes the escape early (nothing to carry), and `\x1bX` is not a
		// completable ST — neither may hold stale pending-suffix state across
		// the following append.
		assertChunkedGrowth([`${LINK}\x07`, "more", "\x1b]8;;https://example.com\x1bX", "tail"]);
	});

	it("falls back to the full-document pass on a truncating edit and stays correct", () => {
		const full = `${LINK}${ST}link${"\x1b]8;;"}${ST}`;
		const streaming = new Markdown(full, 0, 0, THEME);
		// Non-append (shorter) edit: full pass re-normalizes and re-memoizes.
		const truncated = full.slice(0, 12);
		clearRenderCache();
		streaming.setText(truncated);
		expect(streaming.render(60)).toEqual(renderCold(truncated, 60));
		// Subsequent append re-enters the fast path against the NEW memo.
		clearRenderCache();
		streaming.setText(`${truncated}|${ST}`);
		expect(streaming.render(60)).toEqual(renderCold(`${truncated}|${ST}`, 60));
	});
});
