/**
 * The session picker's terminal look (`term.look = "omp.sessions"`; the
 * rename card `omp.overlay.sessions` too): a frame holding the load status or
 * error, the search field, and the sessions that fit the terminal, each a
 * heading row (bold behind a `❯` when selected), its first message under a
 * title, and a dim facts row (age, size, current, status, fork, folder), with
 * a scrollbar once they overflow. A delete question or the rename form takes
 * the list's place. The key hints close the frame, pinned to the terminal's
 * last rows in the fullscreen picker. The list scrolls at its edge; a new
 * search or scope opens it centred on the selection.
 */
import type { UiNode } from "@oh-my-pi/pi-tui";
import { type Block, defineRolePainter, type Hit, type PaintContext } from "@oh-my-pi/pi-tui/term/paint";
import {
	boxBottom,
	boxRow,
	boxTop,
	definePickerLook,
	PICKER_WINDOW,
	type PickerTerm,
	pickerState,
	sheetHit,
} from "@oh-my-pi/pi-tui/term/painters/picker";
import { padTo, truncate, visibleWidth } from "@oh-my-pi/pi-tui/text/width";
import { replaceTabs } from "../../../utils/text-width";
import { paintHookPanel } from "./hook";
import type { TspPickerProps } from "@oh-my-pi/pi-wire";
import { caretField } from "./common";

/** One session row. */
export type SessionsLookRow = {
	readonly id: string;
	/** The session's title; empty when it has none (its first message then heads the row). */
	readonly title: string;
	readonly first: string;
	readonly age: string;
	readonly size: string;
	readonly current: boolean;
	readonly pinned: boolean;
	readonly status?: string;
	readonly fork: boolean;
	/** The session's folder; empty when the picker does not show folders. */
	readonly cwd: string;
};

/** The look's term facts. */
export type SessionsLookTerm = PickerTerm & {
	readonly look: "omp.sessions";
	readonly title: string;
	readonly field: { readonly text: string; readonly cursor: number };
	readonly sessions: readonly SessionsLookRow[];
	readonly message?: { readonly kind: "loading" | "error"; readonly text: string };
	/** The session a delete waits on, and the highlighted answer. */
	readonly confirm?: { readonly name: string; readonly answer: "yes" | "no" };
	/** The rename field while a session is renamed. */
	readonly rename?: { readonly text: string; readonly cursor: number };
	/** What an empty list says. */
	readonly empty: string;
	/** The key hints under the list. */
	readonly hints: string;
	/** Rows the session list may take. */
	readonly budget: number;
	/** Terminal rows the frame stretches to, its hints pinned at the bottom. */
	readonly fill?: number;
};

const STATUS: Readonly<Record<string, [string, string]>> = {
	complete: ["success", "✔ done"],
	interrupted: ["warning", "⚠ interrupted"],
	aborted: ["muted", "⏹ aborted"],
	error: ["error", "✘ error"],
	pending: ["accent", "⏳ pending"],
};

/** Rows a session takes: its heading, its first message under a title, its facts and the blank after. */
const rowHeight = (row: SessionsLookRow): number => (row.title ? 4 : 3);

/**
 * The sessions shown: as many whole ones around `selected` as fit `budget` rows. A list that just
 * opened (`from` undefined) centres the selection; afterwards it moves from `from` only as far as
 * the selection needs.
 */
function sessionWindow(
	heights: readonly number[],
	selected: number,
	budget: number,
	from: number | undefined,
): { start: number; end: number; offset: number; total: number } {
	let total = 0;
	for (const height of heights) total += height;
	if (heights.length === 0) return { start: 0, end: 0, offset: 0, total };
	const at = Math.max(0, Math.min(selected, heights.length - 1));
	const own = heights[at]!;
	let start: number;
	let used: number;
	if (from !== undefined) {
		start = Math.max(0, Math.min(from, at));
		used = 0;
		for (let i = start; i <= at; i++) used += heights[i]!;
		while (used > budget && start < at) used -= heights[start++]!;
	} else {
		const above = Math.floor(Math.max(0, budget - Math.min(own, budget)) / 2);
		start = at;
		let before = 0;
		while (start > 0 && before + heights[start - 1]! <= above) before += heights[--start]!;
		used = before + own;
	}
	let end = at + 1;
	while (end < heights.length && used + heights[end]! <= budget) used += heights[end++]!;
	while (start > 0 && used + heights[start - 1]! <= budget) used += heights[--start]!;
	let offset = 0;
	for (let i = 0; i < start; i++) offset += heights[i]!;
	return { start, end, offset, total };
}

/** The scrollbar column of `height` rows showing `total` rows from `offset`: the thumb in accent, the track muted. */
function scrollColumn(theme: PaintContext["theme"], height: number, total: number, offset: number): string[] {
	const size = Math.max(1, Math.min(Math.floor((height * height) / total), height));
	const travel = height - size;
	const most = Math.max(0, total - height);
	const top = most === 0 ? 0 : Math.round((Math.max(0, Math.min(offset, most)) / most) * travel);
	const thumb = theme.style("accent", "█");
	const track = theme.style("muted", "│");
	return Array.from({ length: height }, (_, row) => (row >= top && row < top + size ? thumb : track));
}

/** The session rows of the list at `width`, and which session each row belongs to. */
function listRows(
	node: UiNode,
	term: SessionsLookTerm,
	selectedId: string | null | undefined,
	cx: PaintContext,
	width: number,
) {
	const theme = cx.theme;
	const rows: string[] = [];
	const ids: string[] = [];
	const sessions = term.sessions;
	const selectedIndex = sessions.findIndex(row => row.id === selectedId);
	const key = `${term.title}\0${term.field.text}`;
	const state = pickerState<{ start: number; key: string } | null>(node, PICKER_WINDOW, () => null);
	const last = state.peek();
	const heights = sessions.map(rowHeight);
	const window = sessionWindow(
		heights,
		selectedIndex,
		term.budget,
		last !== null && last.key === key ? last.start : undefined,
	);
	if (last === null || last.start !== window.start || last.key !== key) state.set({ start: window.start, key });
	// The scrollbar's column comes off the rows once the list overflows its budget.
	const rowWidth = Math.max(0, width - (window.total > term.budget ? 1 : 0));
	const dim = (text: string): string => theme.style("dim", text);
	const dot = dim(" · ");
	for (let i = window.start; i < window.end; i++) {
		const row = sessions[i]!;
		const selected = i === selectedIndex;
		const lead = selected ? theme.style("accent", "❯ ") : "  ";
		const pin = row.pinned ? `${theme.style("accent", theme.symbols.symbol("icon.pin"))} ` : "";
		const room = Math.max(0, rowWidth - 2 - visibleWidth(pin));
		const heading = truncate(row.title || row.first, room);
		const from = rows.length;
		rows.push(`${lead}${pin}${selected ? theme.style("strong", heading) : heading}`);
		if (row.title) rows.push(`  ${dim(truncate(row.first, Math.max(0, rowWidth - 2)))}`);
		let facts = `  ${dim(row.age)} ${dot} ${dim(row.size)}`;
		if (row.current) facts += ` ${dot} ${theme.style("accent", "current")}`;
		const status = row.status ? STATUS[row.status] : undefined;
		if (status) facts += ` ${dot} ${theme.style(status[0], status[1])}`;
		if (row.fork) facts += ` ${dot} ${dim("⑂ fork")}`;
		if (row.cwd) facts += ` ${dot} ${dim(row.cwd)}`;
		rows.push(truncate(facts, rowWidth));
		// The last session ends flush against the hints, whose blank row stands in for its own.
		if (i < window.end - 1) rows.push("");
		for (let k = from; k < rows.length; k++) ids[k] = row.id;
	}
	const total = window.total - 1;
	if (total <= rows.length) return { rows, ids };
	const bar = scrollColumn(theme, rows.length, total, window.offset);
	return { rows: rows.map((row, index) => `${padTo(truncate(row, width - 1, ""), width - 1)}${bar[index]}`), ids };
}

/** The delete question in place of the list: the session's name and a Yes/No choice. */
function confirmRows(cx: PaintContext, width: number, confirm: NonNullable<SessionsLookTerm["confirm"]>): string[] {
	return paintHookPanel(cx.theme, width, {
		look: "omp.hook",
		title: "Delete session?",
		details: [confirm.name],
		outline: false,
		options: [
			{ label: "Yes", disabled: false },
			{ label: "No", disabled: false },
		],
		cursor: confirm.answer === "yes" ? 0 : 1,
		total: 2,
		maxVisible: 2,
		searchable: false,
		query: { text: "", cursor: 0 },
	});
}

/** The rename form in place of the list. */
function renameRows(cx: PaintContext, width: number, line: NonNullable<SessionsLookTerm["rename"]>): string[] {
	const theme = cx.theme;
	const body = [
		theme.style("strong accent", "Rename session"),
		"",
		caretField(theme, "> ", line.text, line.cursor, width - 4),
		"",
	];
	return [
		boxTop(theme, width, "Rename Session"),
		...body.map(row => boxRow(theme, width, row)),
		boxBottom(theme, width),
	];
}

/** The framed sheet: load status or error, then the search field and the list (or the open question), then the key hints. */
function paintFrame(
	node: UiNode,
	cx: PaintContext,
	term: SessionsLookTerm,
	selected: string | null | undefined,
): Block {
	const width = cx.width;
	const theme = cx.theme;
	const inner = Math.max(1, width - 4);
	const body: string[] = [""];
	const hits: Hit[] = [];
	if (term.message) {
		if (term.message.kind === "error") body.push(theme.style("error", replaceTabs(term.message.text)), "");
		else body.push(theme.style("muted", term.message.text));
	}
	if (term.confirm) body.push(...confirmRows(cx, inner, term.confirm));
	else if (term.rename) body.push(...renameRows(cx, inner, term.rename));
	else {
		body.push(caretField(theme, "> ", term.field.text, term.field.cursor, inner), "");
		if (term.sessions.length === 0) body.push(truncate(theme.style("muted", term.empty), inner));
		else {
			const list = listRows(node, term, selected, cx, inner);
			list.rows.forEach((row, index) => {
				hits.push({ row: body.length + 1, col: 2, width: inner, height: 1, node, item: list.ids[index] });
				body.push(row);
			});
		}
	}
	const footer = ["", theme.style("muted", term.hints), ""];
	if (term.fill !== undefined) {
		// The hints stay on the terminal's last rows: the body is cut or padded to what is left above them.
		const room = Math.max(0, term.fill - footer.length - 2);
		if (body.length > room) body.length = room;
		else while (body.length < room) body.push("");
	}
	const rows = [
		boxTop(theme, width, term.title),
		...[...body, ...footer].map(row => boxRow(theme, width, truncate(row, inner))),
		boxBottom(theme, width),
	];
	return { rows, hits: [sheetHit(node, width, rows.length), ...hits.filter(hit => hit.row < body.length + 1)] };
}

function paintSessions(node: UiNode, cx: PaintContext): Block {
	const props = node.props() as TspPickerProps & { term?: SessionsLookTerm };
	if (!props.term || cx.width < 6) return { rows: [] };
	return paintFrame(node, cx, props.term, props.selected);
}

definePickerLook("omp.sessions", paintSessions);

/** The sheet while a session is renamed (the picker gives way to the session card holding the form). */
function paintRename(node: UiNode, cx: PaintContext): Block {
	const term = (node.props() as { term?: SessionsLookTerm }).term;
	if (!term || cx.width < 6) return { rows: [] };
	return paintFrame(node, cx, term, undefined);
}

defineRolePainter("card", "omp.overlay.sessions", paintRename);
