import type { MarkedExtension, Tokens } from "@oh-my-pi/pi-utils/marked";
import { type MathSpan, mathBlockAt, mathSpanAt, mathStartIndex } from "@oh-my-pi/pi-utils/math-delimiters";
import { renderToString } from "katex";
import { escapeHtml } from "../../lib/format";

/**
 * A backtick between the delimiters means the run is prose that merely looks
 * like math (`$x `code` y$`): KaTeX cannot express a code span, so typesetting
 * would swallow it and print an error instead.
 */
function typesettable(span: MathSpan): boolean {
	return !span.body.includes("`");
}

function renderMath(token: Tokens.Generic): string | false {
	if (token.type !== "math" || typeof token.text !== "string" || typeof token.display !== "boolean") return false;
	try {
		const math = renderToString(token.text, {
			displayMode: token.display,
			// KaTeX's HTML output needs katex.min.css, which bundles to ~940 KB
			// gzipped here because Bun inlines its 60 @font-face sources.
			output: "mathml",
			throwOnError: false,
			// `trust: false` refuses \href, \htmlClass, \includegraphics.
			strict: false,
			trust: false,
		});
		// A display equation gets a wrapper to scroll in (`.tr-math`), because
		// scrolling the `math` element itself traps a few pixels of vertical scroll:
		// its ink — fraction bars, radical overlines — overflows its own box.
		return token.display ? `<span class="tr-math">${math}</span>` : math;
	} catch {
		// KaTeX threw outside its own error handling (e.g. macro expansion limit):
		// show the source rather than let one span blank the whole message.
		return escapeHtml(typeof token.raw === "string" ? token.raw : token.text);
	}
}

/**
 * Renders LaTeX in transcript Markdown: `$…$` and `\(…\)` inline, `$$…$$` and
 * `\[…\]` in display mode, plus own-line `$$`/`\[` blocks. Delimiters and the
 * scan hint come from `@oh-my-pi/pi-utils/math-delimiters`, so this renderer and
 * the TUI agree on what counts as math; only presentation policy lives here.
 *
 * Two limits follow from that shared behavior, both matching the TUI: a rejected
 * opener hides later spans on its line ("it costs $5, and the growth is $x^2$"
 * typesets nothing, since marked drops a `start` hint of 0), and a display block
 * whose body contains a blank line must be preceded by one — attached blocks are
 * tokenized by the inline rule, which a blank line ends.
 */
export const mathExtension: MarkedExtension = {
	extensions: [
		{
			name: "math",
			level: "block",
			// No `start` hint: this parser probes block extensions only at a block
			// boundary and never consults their hints.
			tokenizer(source) {
				const block = mathBlockAt(source);
				if (!block) return undefined;
				return { type: "math", raw: block.raw, text: block.body, display: true };
			},
			renderer: renderMath,
		},
		{
			name: "math",
			level: "inline",
			start: mathStartIndex,
			tokenizer(source) {
				const span = mathSpanAt(source, 0);
				if (!span || !typesettable(span)) return undefined;
				return { type: "math", raw: source.slice(0, span.end), text: span.body, display: span.display };
			},
			renderer: renderMath,
		},
	],
};
