/**
 * `diff`: a file change as gutter-numbered rows (`-12│removed`,
 * `+13│added`, context in the muted diff color, syntax-highlighted from
 * `lang` or `path`), a dim `…` row between hunks. Long lines wrap under their
 * gutter unless `wrap` is false, which cuts them at the width instead.
 * `text` (unified or omp compact diff text) stands in for `hunks`.
 */
import type { TspDiffHunk, TspDiffProps } from "@oh-my-pi/pi-wire";
import { compactDiffText, parseCompactDiff, parseUnifiedDiff, renderDiff, renderDiffHunks } from "../../text/diff";
import { truncate } from "../../text/width";
import { definePainter, EMPTY_BLOCK } from "../paint";

/** The hunks a diff node draws: its own, or those of its text. */
export function diffHunks(props: TspDiffProps): readonly TspDiffHunk[] {
	if (props.hunks) return props.hunks;
	const text = props.text ?? "";
	return /^@@ -\d/m.test(text) ? parseUnifiedDiff(text) : parseCompactDiff(text);
}

definePainter("diff", (node, cx) => {
	const props = node.props() as TspDiffProps;
	const hunks = diffHunks(props);
	if (hunks.length === 0 || cx.width <= 0) return EMPTY_BLOCK;
	const options = { theme: cx.theme, path: props.path, lang: props.lang };
	if (props.wrap === false) {
		return { rows: renderDiff(compactDiffText(hunks), options).map(row => truncate(row, cx.width)) };
	}
	return { rows: renderDiffHunks(hunks, cx.width, options) };
});
