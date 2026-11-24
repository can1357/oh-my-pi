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

function paintPresented(node: UiNode, cx: PaintContext): Block {
	const props = node.props() as TspToolProps & { term?: PresentedTerm };
	const theme = cx.theme;
	const summary = props.term?.summary ? styledText(theme, props.term.summary) : styledText(theme, props.target);
	const rows = [truncate(`${theme.fg("dim", "•")} ${summary}`, cx.width)];
	const body = node.children()[0];
	if (props.preview !== "none" && body?.kind === "text") {
		const spans = (body.props() as { spans?: readonly TspSpan[] }).spans ?? [];
		let line: TspSpan[] = [];
		const flush = (): void => {
			rows.push(truncate(`  ${styledText(theme, line)}`, cx.width));
			line = [];
		};
		for (const span of spans) {
			if (span.t === "\n") flush();
			else line.push(span);
		}
		flush();
	}
	return { rows: cx.height === undefined ? rows : rows.slice(0, Math.max(0, cx.height)) };
}

for (const role of PRESENTED_ROLES) defineRolePainter("tool", role, paintPresented);
