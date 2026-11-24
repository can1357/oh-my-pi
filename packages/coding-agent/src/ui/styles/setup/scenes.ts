/**
 * Terminal look of the setup scene bodies (`src/ui/setup/scenes`): the
 * intro, a blank row, then the scene's controls; every body is cut to the
 * rows the wizard gives it (`term.maxLines`).
 */
import type { UiNode } from "@oh-my-pi/pi-tui";
import { type Block, defineRolePainter, type PaintContext, roleOf } from "@oh-my-pi/pi-tui/term/paint";
import { styledText } from "@oh-my-pi/pi-tui/term/painters/layout";
import { padTo, spaces, truncate, visibleWidth, wrap } from "@oh-my-pi/pi-tui/text/width";
import type { TspInputProps, TspText, TspTextProps } from "@oh-my-pi/pi-wire";
import { selectRows } from "../forms/field";
import { composerShapePreviewRows } from "../overlays/composer-shape-preview";

/** Terminal facts of a scene body. */
export type SceneTerm = { readonly maxLines?: number };

/**
 * Rows of one child of a scene body: texts wrap (each row filled to the
 * width), select lists draw as lists, the rest paint as they are.
 */
export function sceneChildRows(node: UiNode, cx: PaintContext): string[] {
	if (node.kind === "text") {
		const props = node.props() as TspTextProps;
		return wrap(styledText(cx.theme, props.spans ?? props.text ?? ""), cx.width).map(row => padTo(row, cx.width));
	}
	if (roleOf(node) === "omp.select") return selectRows(cx.theme, node, cx.width);
	return [...cx.paint(node, cx.width).rows];
}

/** The rows a scene may show. */
export function clip(rows: readonly string[], node: UiNode): string[] {
	const max = ((node.props() as { term?: SceneTerm }).term ?? {}).maxLines;
	const shown = max === undefined ? [...rows] : rows.slice(0, Math.max(0, max));
	// A cut body never ends on a blank row.
	while (shown.length > 0 && shown[shown.length - 1] === "") shown.pop();
	return shown;
}

/** Intro then list, a blank row between. */
function paintChoiceScene(node: UiNode, cx: PaintContext): Block {
	const rows: string[] = [];
	for (const child of node.children()) {
		const shown = sceneChildRows(child, cx);
		if (shown.length === 0) continue;
		if (rows.length > 0) rows.push("");
		rows.push(...shown);
	}
	return { rows: clip(rows, node) };
}

defineRolePainter("col", "omp.setup.glyph", paintChoiceScene);
defineRolePainter("col", "omp.setup.updates", paintChoiceScene);

/** Terminal facts of the composer scene's preview. */
type PreviewTerm = { readonly shape?: string };

/**
 * Composer scene: intro, the live preview (the shape at the paint width), then
 * the list. The preview is the first thing given up when the rows run short.
 */
defineRolePainter("col", "omp.setup.composer", (node, cx): Block => {
	const [intro, list, preview] = node.children();
	const introRows = intro ? sceneChildRows(intro, cx) : [];
	const listRows = list ? sceneChildRows(list, cx) : [];
	const shape = preview ? ((preview.props() as { term?: PreviewTerm }).term ?? {}).shape : undefined;
	const shapeRows = shape === undefined ? [] : composerShapePreviewRows(cx.theme, shape, cx.width);
	// Blank chrome rows are not drawn, but the budget counts them.
	const previewRows =
		shape === undefined ? [] : [cx.theme.fg("muted", "Preview:"), ...shapeRows.filter(row => row !== "")];
	const max = ((node.props() as { term?: SceneTerm }).term ?? {}).maxLines;
	const full = [...introRows, "", ...previewRows, "", ...listRows];
	const needed = introRows.length + 2 + (shape === undefined ? 0 : 1 + shapeRows.length) + listRows.length;
	const rows = max !== undefined && needed > max ? [...introRows, "", ...listRows] : full;
	return { rows: clip(rows, node) };
});

/** Rows of the theme preview: samples, a status line and an editor box in the active look. */
function themePreviewRows(node: UiNode, cx: PaintContext): string[] {
	const [title, samples, statusLabel, status, editorLabel, input, hint] = node.children();
	const rows: string[] = [];
	for (const text of [title, samples, statusLabel]) if (text) rows.push(...sceneChildRows(text, cx));
	if (status) rows.push(statusLine(status, cx));
	if (editorLabel) rows.push(...sceneChildRows(editorLabel, cx));
	if (input && hint) rows.push(...editorBox(input, hint, cx));
	return rows.map(row => truncate(row, cx.width, ""));
}

/** The status line sample: left and right segments on the status background, `│` between segments. */
function statusLine(node: UiNode, cx: PaintContext): string {
	const theme = cx.theme;
	const sep = theme.fg("statusLineSep", "  │  ".replace("│", theme.symbols.box.vertical));
	const group = (side: string): { text: string; width: number } => {
		const segs = node.children().filter(seg => (seg.props() as { side?: string }).side === side);
		const parts = segs.map(seg => styledText(theme, (seg.props() as TspTextProps).spans ?? ""));
		const text = parts.join(sep);
		return { text, width: visibleWidth(text) };
	};
	const left = group("left");
	const right = group("right");
	const width = cx.width;
	const used = 1 + left.width;
	let body: string;
	if (used + 1 + right.width + 3 <= width) {
		body = ` ${left.text}${spaces(width - used - right.width - 3)}${right.text}   `;
	} else {
		const room = width - used - 1;
		body = room > 0 ? ` ${left.text} ${truncate(right.text, room)}` : truncate(` ${left.text}`, width);
	}
	return theme.bg("statusLineBg", body);
}

/** The editor sample: a rounded box around the prompt row (accent edges) and its key hints (muted edges). */
function editorBox(input: UiNode, hint: UiNode, cx: PaintContext): string[] {
	const theme = cx.theme;
	const box = theme.symbols.box;
	const inner = Math.max(1, cx.width - 2);
	const props = input.props() as TspInputProps;
	const prompt = styledText(theme, props.prompt);
	const text = truncate(props.text ?? "", Math.max(1, inner - visibleWidth(prompt) - 2), theme.symbols.ellipsis);
	const promptRow = `${prompt} ${text}${theme.style("inverse", " ")}`;
	const hintRow = styledText(theme, (hint.props() as TspTextProps).spans ?? "");
	const fill = (row: string): string => `${row}${spaces(Math.max(0, inner - visibleWidth(row)))}`;
	const accent = (s: string): string => theme.fg("borderAccent", s);
	const muted = (s: string): string => theme.fg("borderMuted", s);
	return [
		accent(`${box.topLeft}${box.horizontal.repeat(inner)}${box.topRight}`),
		`${accent(box.vertical)}${fill(promptRow)}${accent(box.vertical)}`,
		// Hints wider than the box wrap, edges and all.
		...wrap(`${muted(box.vertical)}${fill(hintRow)}${muted(box.vertical)}`, cx.width),
		muted(`${box.bottomLeft}${box.horizontal.repeat(inner)}${box.bottomRight}`),
	];
}

/**
 * List rows that fit in `room` rows: all of them with a row to spare, else a
 * window leaving a row for the search status.
 */
export function fittedListMax(count: number, room: number): number {
	return count < room ? count : Math.max(1, room - 1);
}

/** Widest the theme preview draws. */
const THEME_PREVIEW_MAX_WIDTH = 88;

/**
 * The theme list's rows within a body budget: the whole list when it fits
 * under the intro, else a window one row shorter than the room left, with
 * the search status under it.
 */
function fittedListRows(list: UiNode, cx: PaintContext, room: number | undefined): string[] {
	if (room === undefined) return sceneChildRows(list, cx);
	return selectRows(cx.theme, list, cx.width, fittedListMax(listCount(list), room));
}

function listCount(select: UiNode): number {
	return (
		select
			.children()
			.find(child => child.kind === "list")
			?.children().length ?? 0
	);
}

/** Fewest list rows worth keeping the preview for. */
const MIN_LIST_ROWS = 5;

/**
 * Theme scene: intro and hint, the live preview, then the list (or the
 * loading line). Short of rows, the preview goes first, then the list shrinks.
 */
defineRolePainter("col", "omp.setup.theme", (node, cx): Block => {
	const [intro, preview, ...rest] = node.children();
	const introRows: string[] = [];
	for (const line of intro?.children() ?? []) introRows.push(...sceneChildRows(line, cx));
	const previewWidth = Math.min(cx.width, THEME_PREVIEW_MAX_WIDTH);
	const previewRows = preview ? themePreviewRows(preview, { ...cx, width: previewWidth }) : [];
	const tailRows = (room: number | undefined): string[] => {
		const tail: string[] = [];
		for (const child of rest) {
			if (child.kind === "spinner") {
				const label = (child.props() as { label?: TspText }).label;
				tail.push(truncate(styledText(cx.theme, label), cx.width));
			} else if (roleOf(child) === "omp.select") tail.push(...fittedListRows(child, cx, room));
			else tail.push(...sceneChildRows(child, cx));
		}
		return tail;
	};
	const max = ((node.props() as { term?: SceneTerm }).term ?? {}).maxLines;
	const full = [...introRows, "", ...previewRows, "", ...tailRows(undefined)];
	if (max === undefined || full.length <= max) return { rows: clip(full, node) };
	const select = rest.find(child => roleOf(child) === "omp.select");
	const withPreview = introRows.length + 1 + previewRows.length + 1;
	const rows =
		select && max - withPreview >= Math.min(listCount(select), MIN_LIST_ROWS)
			? [...introRows, "", ...previewRows, "", ...tailRows(max - withPreview)]
			: [...introRows, "", ...tailRows(max - introRows.length - 1)];
	return { rows: clip(rows, node) };
});
