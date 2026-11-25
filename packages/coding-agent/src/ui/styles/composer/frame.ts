/**
 * The composer in the terminal (`col` nodes with role `omp.editor` and
 * `omp.editor.<state>`): its text field inside the chrome of the composer's
 * shape, the completion popup under it.
 *
 * The field (`line` row → `editor`) is painted at the wrap width the shape
 * leaves, plus the padding cell an end-of-row caret may take; each of its
 * rows goes through the shape's row renderer with its padding and gutter.
 * The status bar facts, mode chip and send/stop controls are native-only: the
 * terminal shows them in the status line. `term.faint` dims every cell (the
 * keys are away at an ask above).
 */
import type { UiNode } from "@oh-my-pi/pi-tui";
import { type Block, type Cell, defineRolePainter, EMPTY_BLOCK, type PaintContext } from "@oh-my-pi/pi-tui/term/paint";
import { visibleWidth } from "@oh-my-pi/pi-tui/text/width";
import { caretCell, caretOf, type EditorProps, lastLayout } from "@oh-my-pi/pi-tui/term/painters/editor";
import { fgSgr } from "@oh-my-pi/pi-tui/theme/color";
import { type ComposerChromeContext, type ComposerStatus, caretOverflow, composerShape } from "./shapes";

/** Terminal-only facts of the composer node (its `term` prop). */
export type ComposerTerm = {
	/** Registered shape id (`box` when unknown). */
	readonly shape?: string;
	/** Padding inside the side chrome (the shape's default otherwise). */
	readonly paddingX?: number;
	/** Status content for shapes that show one in their top chrome. */
	readonly status?: ComposerStatus;
	/** The border's color: a theme color key or a `#rrggbb` hex (a session accent). */
	readonly border?: string;
	/** Dim the border (the view is proxied at a focused subagent). */
	readonly borderFaint?: boolean;
	/** Dim every cell. */
	readonly faint?: boolean;
	/** Move the box bottom border to its own row when the caret ends the input (macOS IME preedit). */
	readonly imeSafeCursor?: boolean;
};

const MARK = "\u0000";

/** The escapes `styled` wraps around its text. */
function sgrPair(styled: string): [string, string] {
	const at = styled.indexOf(MARK);
	return at === -1 ? ["", ""] : [styled.slice(0, at), styled.slice(at + 1)];
}

/** Background and text color over `text`, reopened after the resets inside it. */
function surface(cx: PaintContext, text: string): string {
	const [bg] = sgrPair(cx.theme.bg("userMessageBg", MARK));
	const [fg] = sgrPair(cx.theme.fgResolved("text", MARK));
	const body = text.replace(/\x1b\[(0|39|49)?m/g, reset =>
		reset === "\x1b[39m" ? `${reset}${fg}` : reset === "\x1b[49m" ? `${reset}${bg}` : `${reset}${bg}${fg}`,
	);
	return `${bg}${fg}${body}\x1b[39m\x1b[49m`;
}

/** Dim a row, reopening faint after every reset that ends it. */
function faint(row: string): string {
	return `\x1b[2m${row.replace(/\x1b\[(?:0|22)?m/g, reset => `${reset}\x1b[2m`)}\x1b[22m`;
}

/** The composer's field node (`line` row → `editor`). */
export function composerField(node: UiNode): UiNode | undefined {
	const line = node.children().find(child => child.key() === "line");
	return line?.children().find(child => child.kind === "editor" || child.kind === "input");
}

function paintComposer(node: UiNode, cx: PaintContext): Block {
	const term = ((node.props() as { term?: ComposerTerm }).term ?? {}) as ComposerTerm;
	const theme = cx.theme;
	const shape = composerShape(term.shape);
	const paddingX = term.paddingX ?? shape.paddingX;
	const side = shape.sideWidth(paddingX);
	const gutterWidth = shape.gutter ? Math.min(visibleWidth(shape.gutter), Math.max(0, cx.width - 2 * side)) : 0;
	const contentWidth = Math.max(0, cx.width - 2 * side - gutterWidth);
	// A side-bordered shape without padding keeps a column for the end-of-row caret.
	const reserve = shape.sideBorders && paddingX === 0 ? 1 : 0;
	const wrapWidth = Math.max(1, contentWidth - reserve);
	const field = composerField(node);
	const block = field ? cx.paint(field, wrapWidth + caretOverflow(shape, paddingX)) : EMPTY_BLOCK;

	// A status source draws for the shape's attachment at the cells inside its side chrome.
	const status =
		typeof term.status === "function"
			? shape.statusAttachment && term.status(cx, shape.statusAttachment, Math.max(0, cx.width - 2 * side))
			: term.status;
	const chrome: ComposerChromeContext = {
		width: cx.width,
		paddingX,
		theme,
		border: text => {
			const color = term.border ?? "borderMuted";
			const drawn = color.startsWith("#") ? `${fgSgr(color, theme.depth)}${text}\x1b[39m` : theme.fg(color, text);
			return term.borderFaint ? `\x1b[2m${drawn}\x1b[22m` : drawn;
		},
		accent: text => theme.fg("accent", text),
		surface: text => surface(cx, text),
		box: theme.symbols.box,
		...(status ? { status } : {}),
	};
	const gutter = shape.gutter ? shape.gutter.slice(0, gutterWidth) : "";
	const rows: string[] = [];
	const top = shape.top?.(chrome);
	if (top !== undefined) rows.push(top);
	let cursor: Cell | undefined;
	const fieldRows = block.rows.length > 0 ? block.rows : [""];
	const fieldProps = field?.props() as EditorProps | undefined;
	const layout = field ? lastLayout(field) : [];
	const caret = fieldProps ? caretCell(fieldProps.text ?? "", layout, caretOf(fieldProps)) : undefined;
	const last = layout.at(-1);
	const cursorAtEnd =
		caret !== undefined && last !== undefined && caret.row === layout.length - 1 && caret.col >= last.width;
	const imeSafeCursorTail = term.imeSafeCursor === true && shape.sideBorders && cursorAtEnd;
	for (let i = 0; i < fieldRows.length; i++) {
		const text = fieldRows[i]!;
		const width = visibleWidth(text);
		if (block.cursor?.row === i) cursor = { row: rows.length, col: side + gutterWidth + block.cursor.col };
		rows.push(
			...shape.row({
				...chrome,
				text,
				pad: " ".repeat(Math.max(0, contentWidth - width)),
				gutter: i === 0 ? gutter : " ".repeat(gutterWidth),
				first: i === 0,
				last: i === fieldRows.length - 1,
				imeSafeCursorTail: i === fieldRows.length - 1 && imeSafeCursorTail,
				overflow: Math.max(0, width - contentWidth),
			}),
		);
	}
	const bottom = shape.bottom?.(chrome);
	if (bottom !== undefined) rows.push(bottom);

	// The popup covers the transcript above the composer rather than taking room from it.
	const popup = node.children().find(child => child.kind === "overlay");
	const covering = popup ? cx.paint(popup, cx.width).rows : [];
	rows.push(...covering);
	return {
		rows: term.faint ? rows.map(faint) : rows,
		...(covering.length > 0 ? { covering: covering.length } : {}),
		...(cursor ? { cursor } : {}),
	};
}

defineRolePainter("col", "omp.editor", paintComposer);
defineRolePainter("col", "omp.editor", paintComposer, { prefix: true });
