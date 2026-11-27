/**
 * `diff`: a file change as gutter-numbered rows (`-12│removed`,
 * `+13│added`, context in the muted diff color, syntax-highlighted from
 * `lang` or `path`), a dim `…` row between hunks. Long lines wrap under their
 * gutter unless `wrap` is false, which cuts them at the width instead.
 * `text` (unified or omp compact diff text) stands in for `hunks`.
 *
 * Text: each diff line is one line holding its source content (indentation
 * as written, not its `·`/`→` markers); gutters and the gaps between hunks
 * are not.
 */
import { sanitizeText } from "@oh-my-pi/pi-utils";
import type { TspDiffHunk, TspDiffProps } from "@oh-my-pi/pi-wire";
import { compactDiffText, parseCompactDiff, parseUnifiedDiff, renderDiff, wrapDiffRow } from "../../text/diff";
import { replaceTabs, truncate } from "../../text/width";
import { definePainter, EMPTY_BLOCK } from "../paint";
import {
	lazyText,
	mapWrappedText,
	offsetRenderedText,
	type RenderedText,
	type RenderedTextRow,
	sliceRenderedText,
} from "../text-layout";

/** The hunks a diff node draws: its own, or those of its text. */
export function diffHunks(props: TspDiffProps): readonly TspDiffHunk[] {
	if (props.hunks) return props.hunks;
	const text = props.text ?? "";
	return /^@@ -\d/m.test(text) ? parseUnifiedDiff(text) : parseCompactDiff(text);
}

/** A numbered row of compact diff text: its content after the `|`. */
const NUMBERED = /^[+\- ]\s*\d+\|(.*)$/s;
const GAP = /^\s*(?:…|\.\.\.)?\s*$/;

/**
 * Text of diff rows: `drawn` (one per line of `compact`) wrapped, or `cut`,
 * at `width`. The drawn content shows indentation as markers of the same
 * length, so its offsets hold in the source content.
 */
function diffText(compact: string, drawn: readonly string[], cut: boolean, width: number): RenderedText {
	const sources = sanitizeText(compact).split("\n");
	const out: (RenderedTextRow | undefined)[] = [];
	for (let i = 0; i < drawn.length; i++) {
		const row = drawn[i]!;
		const segments = cut ? [truncate(row, width)] : wrapDiffRow(row, width);
		const source = sources[i] ?? "";
		const numbered = NUMBERED.exec(source);
		const plain = Bun.stripANSI(row);
		const bar = plain.indexOf("│");
		if (!numbered || bar < 0) {
			const gap = GAP.test(source);
			for (const text of mapWrappedText(plain, segments)) out.push(gap ? undefined : text);
			continue;
		}
		const shown = plain.slice(bar + 1);
		const line = { text: replaceTabs(numbered[1]!).trimEnd() };
		const mapped: (RenderedTextRow | undefined)[] = [];
		for (const text of mapWrappedText(
			shown,
			segments.map(segment => Bun.stripANSI(segment).slice(bar + 1)),
		)) {
			// A run of the drawn content stands for the same offsets of the source content.
			mapped.push(
				text?.line.text === shown.trimEnd()
					? {
							line,
							start: Math.min(text.start, line.text.length),
							end: Math.min(text.end, line.text.length),
							column: text.column + bar + 1,
						}
					: offsetRenderedText(text, bar + 1),
			);
		}
		for (const text of cut ? sliceRenderedText(mapped, 0, mapped.length) : mapped) out.push(text);
	}
	return out;
}

definePainter("diff", (node, cx) => {
	const props = node.props() as TspDiffProps;
	const hunks = diffHunks(props);
	if (hunks.length === 0 || cx.width <= 0) return EMPTY_BLOCK;
	const options = { theme: cx.theme, path: props.path, lang: props.lang };
	const compact = compactDiffText(hunks);
	const drawn = renderDiff(compact, options);
	const cut = props.wrap === false;
	const width = cx.width;
	return {
		rows: cut ? drawn.map(row => truncate(row, width)) : drawn.flatMap(row => wrapDiffRow(row, width)),
		text: lazyText(() => diffText(compact, drawn, cut, width)),
	};
});
