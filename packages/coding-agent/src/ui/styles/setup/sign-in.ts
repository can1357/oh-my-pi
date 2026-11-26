/**
 * Terminal look of the sign-in scene (`term.role` `omp.setup.sign-in`): the
 * intro over the provider sheet and the last sign-in's outcome under it,
 * the sheet cut to the rows left; or the login dialog, whose middle gives
 * way on short screens (the head keeps its title and first link row, the
 * tail the live step).
 */
import { type Block, defineRolePainter } from "@oh-my-pi/pi-tui/term/paint";
import { wrap } from "@oh-my-pi/pi-tui/text/width";

/** One status line under the sheet. */
export interface SignInLine {
	readonly text: string;
	readonly color: string;
}

/** Terminal facts of the sign-in scene body. */
export type SignInTerm = {
	readonly role: "omp.setup.sign-in";
	readonly maxLines?: number;
	/** Show the intro over the sheet. */
	readonly intro: boolean;
	readonly lines: readonly SignInLine[];
};

const LIST_LEAD = "Pick a provider to sign in — you can connect more than one.";

/** Login dialog rows kept above a cut: top border, spacer, first link row. */
const DIALOG_HEAD_ROWS = 3;

defineRolePainter("col", "omp.setup.sign-in", (node, cx): Block => {
	const term = (node.props() as { term?: SignInTerm }).term;
	const child = node.children()[0];
	if (!term || !child) return { rows: [] };
	const max = term.maxLines;
	const content = cx.paint(child, cx.width).rows;
	if (child.kind !== "col" || (child.props() as { role?: string }).role === "omp.login") {
		if (max === undefined || content.length <= max) return { rows: content };
		const head = max >= DIALOG_HEAD_ROWS * 2 ? DIALOG_HEAD_ROWS : 0;
		return { rows: [...content.slice(0, head), ...content.slice(content.length - (max - head))] };
	}
	const intro = term.intro ? [...wrap(cx.theme.fg("muted", LIST_LEAD), cx.width), ""] : [];
	const lines = term.lines.flatMap(line => wrap(cx.theme.fg(line.color, line.text), cx.width));
	const room = max === undefined ? content.length : Math.max(0, max - intro.length - lines.length);
	return { rows: [...intro, ...content.slice(0, room), ...lines] };
});
