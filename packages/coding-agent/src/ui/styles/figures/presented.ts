/**
 * The compact row of a presented transcript block (`tool` nodes built by
 * `PresentedBlock`): a dim `•`, omp's summary (title bold, target muted, a
 * run's command in its mode color) or the presenter's label, then the
 * presenter's rows two cells in. A viewport allocation keeps the first rows.
 */
import type { UiNode } from "@oh-my-pi/pi-tui";
import { type Block, defineRolePainter, type PaintContext } from "@oh-my-pi/pi-tui/term/paint";
import { styledText } from "@oh-my-pi/pi-tui/term/painters/layout";
import { truncate } from "@oh-my-pi/pi-tui/text/width";
import type { TspSpan, TspToolProps } from "@oh-my-pi/pi-wire";
import { PRESENTED_ROLES, type PresentedTerm } from "../../transcript/figures/presented-block";

function isText(node: UiNode | undefined): node is UiNode<"text"> {
	return node?.kind === "text";
}

/** The spans of a compact row's body: its first child when that is a `text` node. */
export function bodySpans(node: UiNode): readonly TspSpan[] {
	const body = node.children()[0];
	return isText(body) ? (body.props().spans ?? []) : [];
}

/**
 * A presenter's compact rows (`presenterRows` spans: `\n` spans between rows) as terminal rows two
 * cells in, in their theme styles. Presented blocks, tool cards and read groups share it.
 */
export function paintPresenterRows(spans: readonly TspSpan[], cx: PaintContext): string[] {
	if (spans.length === 0) return [];
	const rows: string[] = [];
	let line: TspSpan[] = [];
	const flush = (): void => {
		rows.push(truncate(`  ${styledText(cx.theme, line)}`, cx.width));
		line = [];
	};
	for (const span of spans) {
		if (span.t === "\n") flush();
		else line.push(span);
	}
	flush();
	return rows;
}

function paintPresented(node: UiNode, cx: PaintContext): Block {
	const props = node.props() as TspToolProps & { term?: PresentedTerm };
	const theme = cx.theme;
	const summary = props.term?.summary ? styledText(theme, props.term.summary) : styledText(theme, props.target);
	const rows = [truncate(`${theme.fg("dim", "•")} ${summary}`, cx.width)];
	if (props.preview !== "none") rows.push(...paintPresenterRows(bodySpans(node), cx));
	return { rows: cx.height === undefined ? rows : rows.slice(0, Math.max(0, cx.height)) };
}

for (const role of PRESENTED_ROLES) defineRolePainter("tool", role, paintPresented);
