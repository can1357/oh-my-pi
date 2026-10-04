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

	it("renders a transient non-append edit that keeps the frozen prefix as a one-shot render does", () => {
		// The edit keeps the text of the frozen prefix but replaces what follows
		// it, so the line after the prefix may no longer start a block of its
		// own: a line of no-break spaces joins the blank run in front of it, and
		// a same-marker item continues the list above it. Lexing the rest
		// against that prefix kept the wrong rows through the finished render.
		for (const [before, after] of [
			["Para.\n\nnext para here", "Para.\n\n\u00a0\nAfter."],
			["- a\n\nnext", "- a\n\n- b"],
		]) {
			const streaming = new Markdown("", 0, 0, THEME);
			streaming.transientRenderCache = true;
			clearRenderCache();
			streaming.setText(before);
			streaming.render(60);
			clearRenderCache();
			streaming.setText(after);
			expect(streaming.render(60)).toEqual(renderColdTransient(after, 60));
			streaming.transientRenderCache = false;
			clearRenderCache();
			expect(streaming.render(60)).toEqual(renderCold(after, 60));
		}
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

	it("never mutates returned frames and stays byte-identical across finalize and resume", () => {
		// Streaming reuses private row/highlight caches across frames; a frame
		// already handed to a caller must never change afterwards. Finalizing
		// mid-fence (then resuming the stream) releases those caches and must
		// rebuild byte-identical output.
		const theme = {
			...THEME,
			highlightCode: (code: string): string[] => code.split("\n").map(line => `H<${line}>`),
			createHighlightStream: () => ({
				push: (chunk: string): string =>
					chunk
						.split("\n")
						.map((line, i, all) => (i === all.length - 1 ? line : `H<${line}>`))
						.join("\n"),
			}),
		};
		const renderColdWith = (text: string, transient: boolean): readonly string[] => {
			clearRenderCache();
			const md = new Markdown(text, 0, 0, theme);
			md.transientRenderCache = transient;
			const lines = md.render(60);
			clearRenderCache();
			return lines;
		};
		const code = Array.from({ length: 24 }, (_, i) => `const value_${i} = compute(${i});`).join("\n");
		const doc =
			"Intro paragraph that freezes first.\n\nSecond paragraph grows the frozen prefix.\n\n" +
			`\`\`\`ts\n${code}\n\`\`\`\n\nTail prose after the fence keeps streaming on.`;
		const finalizeAt = doc.indexOf("value_12");
		const streaming = new Markdown("", 0, 0, theme);
		streaming.transientRenderCache = true;
		const handed: Array<{ lines: readonly string[]; snapshot: string[] }> = [];
		let finalized = false;
		for (let len = 1; len <= doc.length; len += 5) {
			const slice = doc.slice(0, len);
			clearRenderCache();
			streaming.setText(slice);
			const lines = streaming.render(60);
			expect(lines).toEqual(renderColdWith(slice, true));
			handed.push({ lines, snapshot: [...lines] });
			if (!finalized && len >= finalizeAt) {
				finalized = true;
				streaming.transientRenderCache = false;
				clearRenderCache();
				expect(streaming.render(60)).toEqual(renderColdWith(slice, false));
				streaming.transientRenderCache = true;
			}
		}
		expect(finalized).toBe(true);
		for (const frame of handed) expect(frame.lines).toEqual(frame.snapshot);
	});
});

describe("Streamed Markdown equals a one-shot render across the frozen prefix", () => {
	/** Stream `full` in `step`-character chunks through one transient instance, as
	 *  a live message does. Every frame must equal a cold transient render of the
	 *  same text, and the finalized render a cold final render. Returns the frozen
	 *  prefix length at the last streamed frame. */
	function streamAgainstOneShot(full: string, step: number, width = 60): number {
		const streaming = new Markdown("", 0, 0, THEME);
		streaming.transientRenderCache = true;
		for (let len = Math.min(step, full.length); ; len = Math.min(len + step, full.length)) {
			const slice = full.slice(0, len);
			clearRenderCache();
			streaming.setText(slice);
			expect(streaming.render(width)).toEqual(renderColdTransient(slice, width));
			if (len === full.length) break;
		}
		const frozen = streaming.getLastRenderStableText().length;
		streaming.transientRenderCache = false;
		clearRenderCache();
		expect(streaming.render(width)).toEqual(renderCold(full, width));
		return frozen;
	}

	const paragraphs = (count: number) =>
		Array.from({ length: count }, (_, i) => `Body paragraph ${i} keeps the stream going.`).join("\n\n");
	const mathBody = Array.from({ length: 6 }, (_, i) => `a_{${i}} + b_{${i}} = c_{${i}}`).join("\n\n");

	for (const step of [1, 7, 40]) {
		it(`keeps a display-math block with blank lines whole, streamed in ${step}-character chunks`, () => {
			// The freeze must not cut at a blank line inside the block before its
			// closer arrives: that left raw `$$` rows even after finalizing.
			streamAgainstOneShot(`Intro.\n\n$$\n${mathBody}\n$$\n\nAfter the math.\n`, step);
		});
	}

	for (const definition of ["> [d]: https://example.com/docs", "- [d]: https://example.com/docs"]) {
		it(`resolves a reference whose definition streams in nested: ${definition.slice(0, 5)}`, () => {
			// A definition inside a quote or list resolves the reference above it,
			// which a frozen prefix lexed without the definition kept raw.
			const doc = `See [the docs][d] for details.\n\nMiddle paragraph one.\n\nMiddle paragraph two.\n\n${definition}\n`;
			for (const step of [1, 7, 40]) streamAgainstOneShot(doc, step);
		});
	}

	it("resolves a reference that streams in after a nested definition", () => {
		// The definition sits in a list that a full lex could freeze; a later
		// tail lexed without it would leave the reference raw.
		const doc = `- [d]: https://example.com/docs\n\nMiddle paragraph.\n\nSee [the docs][d] for details.\n`;
		for (const step of [1, 7, 40]) streamAgainstOneShot(doc, step);
	});

	it("renders an own-line $$ that never closes as a one-shot render does", () => {
		const doc = `Intro.\n\n$$\nx = 1\n\n${paragraphs(4)}\n`;
		for (const step of [1, 7, 40]) streamAgainstOneShot(doc, step);
	});

	it("keeps a display-math block open while its last streamed line could still grow past a closer", () => {
		// The last streamed line reads as a closer (`$$`, `\]`) until the next
		// chunk extends it into text, so the block opened above it can still
		// close further down; freezing past its opener would split that block.
		for (const doc of [
			"Intro.\n\n$$\n\n\n$$ E = mc^2 $$\n\nMiddle.\n\n$$\n\nAfter.\n",
			"Intro.\n\n\\[\n\n\n\\] E = mc^2\n\nMiddle.\n\n\\]\n\nAfter.\n",
		])
			streamAgainstOneShot(doc, 1);
	});

	it("keeps watching an open opener of one kind while blocks of the other kind close below it", () => {
		// A closer sends the prefix back only to the boundary in front of the
		// opener of its own kind, so the open opener of the other kind above it
		// is still watched, and its own closer further down still turns
		// everything from it on into one block.
		for (const doc of [
			`Intro.\n\n\\[\nx = 1\n\n${paragraphs(2)}\n\n$$\na = b\n\nc = d\n$$\n\n${paragraphs(2)}\n\n\\]\n\nAfter.\n`,
			`Intro.\n\n$$\nx = 1\n\n${paragraphs(2)}\n\n\\[\na = b\n\nc = d\n\\]\n\n${paragraphs(2)}\n\n$$\n\nAfter.\n`,
		])
			for (const step of [1, 7, 40]) streamAgainstOneShot(doc, step);
	});

	it("keeps freezing past a closed $$ pair around a blank body", () => {
		// mathBlockAt rejects a whitespace-only body and no append can move its
		// first closer, so this is no math block, and the freeze must not stall
		// in front of it for the rest of the stream.
		const doc = `Intro.\n\n$$\n \n$$\n\n${paragraphs(80)}\n`;
		const frozen = streamAgainstOneShot(doc, 40);
		expect(frozen).toBeGreaterThan(doc.indexOf("$$\n\n") + 4);
	});

	it("keeps freezing past a fenced block with an indented line that looks like a definition", () => {
		// Code registers no reference definitions, so the freeze still advances
		// over the block once the stream grows past it.
		const doc = `Intro paragraph.\n\n\`\`\`ts\ninterface Bag {\n    [key: string]: T;\n}\n\`\`\`\n\n${paragraphs(40)}\n`;
		const frozen = streamAgainstOneShot(doc, 40);
		expect(frozen).toBeGreaterThan(doc.indexOf("```\n\n") + 3);
	});

	it("keeps a no-break-space line after a blank line in the blank run", () => {
		// The lexer's blank line is any whitespace-only line, so the line joins
		// the blank run above it. A freeze in front of it gave it a blank row of
		// its own, in every later frame and in the finalized render.
		streamAgainstOneShot(`Intro.\n\nFirst paragraph.\n\n\u00a0\nAfter.\n\n${paragraphs(3)}\n`, 1);
	});

	it("finalizes as a one-shot render when the repair drops an orphan fence right after the frozen prefix", () => {
		// At finalize the orphan `~~~` is deleted (a table and a heading follow
		// it), so the text after the frozen prefix starts with blank lines that
		// a one-shot lex joins to the blank line in front of the fence.
		streamAgainstOneShot("Intro.\n\n~~~\n\n\n| a | b |\n|---|---|\n| 1 | 2 |\n### Heading\n", 7);
	});

	it("publishes no text past an own-line $$ that an append could still close", () => {
		// The stable text feeds append-only transcript publication, so it must
		// stop in front of the opener: the closer below turns everything from the
		// opener on into one math block.
		const open = `Intro.\n\n$$\nx = 1\n\n${paragraphs(40)}\n`;
		const frozen = streamAgainstOneShot(open, 40);
		expect(frozen).toBeGreaterThan(0);
		expect(frozen).toBeLessThanOrEqual(open.indexOf("$$"));
		streamAgainstOneShot(`${open}$$\n\nAfter the math.\n`, 40);
	});

	/** Wall time of streaming `doc` through one transient instance in `step`-character frames. */
	function streamTime(doc: string, step: number): number {
		const streaming = new Markdown("", 0, 0, THEME);
		streaming.transientRenderCache = true;
		const start = Bun.nanoseconds();
		for (let len = step; len < doc.length + step; len += step) {
			streaming.setText(doc.slice(0, len));
			streaming.render(100);
		}
		return Bun.nanoseconds() - start;
	}

	/** Streaming `doc` costs less than three times streaming `baseline`, best of up to three runs. */
	function expectStreamsAsFast(doc: string, baseline: string, step: number): void {
		clearRenderCache();
		const base = Math.min(streamTime(baseline, step), streamTime(baseline, step));
		let cost = Number.POSITIVE_INFINITY;
		for (let run = 0; run < 3 && cost >= 3 * base; run++) cost = Math.min(cost, streamTime(doc, step));
		expect(cost).toBeLessThan(3 * base);
	}

	it("streams past an own-line $$ that never closes as fast as without it", () => {
		// The opener stays open to the end, so a frozen prefix that stopped in
		// front of it left every frame re-lexing the whole message.
		const body = paragraphs(750);
		expectStreamsAsFast(`Intro.\n\n$$\nx = 1\n\n${body}\n`, `Intro.\n\nx = 1\n\n${body}\n`, 64);
	});

	it("streams $$ blocks around blank lines below an open \\[ as fast as $$ blocks without them", () => {
		// A `$$` block with a blank line inside is frozen open until its closer
		// arrives, and the closer turns only the text from its own opener on
		// into a math block. So the prefix goes back to the boundary in front of
		// that opener and keeps its rows there. Going back to the boundary in
		// front of the `\[`, or rendering the kept prefix again, redid all the
		// text after the `\[` for every block.
		let blankInside = "Intro.\n\n\\[\nx = 1\n\n";
		let noBlank = "Intro.\n\nx = 1\n\n";
		for (let i = 0; i < 200; i++) {
			blankInside += `Body paragraph ${i} keeps the stream going.\n\n$$\na_{${i}} = b\n\nc_{${i}} = d\n$$\n\n`;
			noBlank += `Body paragraph ${i} keeps the stream going.\n\n$$\na_{${i}} = b\nc_{${i}} = d\n$$\n\n`;
		}
		expectStreamsAsFast(blankInside, noBlank, 16);
	});

	it("renders the frame after a last line that only read as a closer from the prefix frozen before it", () => {
		// A frame ending in `$$` closes the open `$$` above it, as a one-shot
		// render of that text does. Once the next chunk turns that line into
		// text, the prefix frozen before it is right again, so the next frame
		// lexes only the new text instead of everything after the opener.
		const doc = `Intro.\n\n$$\nx = 1\n\n${paragraphs(1500)}\n\n`;
		const frameTime = (streaming: Markdown, text: string): number => {
			const start = Bun.nanoseconds();
			streaming.setText(text);
			streaming.render(100);
			return Bun.nanoseconds() - start;
		};
		let closing = 0;
		let after = Number.POSITIVE_INFINITY;
		for (let run = 0; run < 3 && after >= closing / 4; run++) {
			clearRenderCache();
			const streaming = new Markdown("", 0, 0, THEME);
			streaming.transientRenderCache = true;
			for (let len = 4096; len < doc.length; len += 4096) frameTime(streaming, doc.slice(0, len));
			frameTime(streaming, doc);
			closing = frameTime(streaming, `${doc}$$`);
			after = frameTime(streaming, `${doc}$$ E = mc^2 $$ holds.`);
		}
		expect(after).toBeLessThan(closing / 4);
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
