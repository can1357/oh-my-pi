/**
 * `edit` (and apply_patch): per file a rounded card without inner padding
 * (the diff gutter pads), headed `✎ Edit: icon path ⟦+a/-r⟧ (+N more)`,
 * tinted by phase, its body the streamed preview or the result's diff; a
 * delete or plain move is one status row instead. While collapsed a result's
 * diff keeps its changes with a little context and ends `… (N more lines)`;
 * a streamed preview keeps its newest rows under `… (content above)`.
 * Several files stack their cards a blank row apart, then `Edit: N more
 * files pending…`.
 *
 * Everything comes from the presenter's `term.edit` (see `EditTerm`).
 */
import type { UiNode } from "@oh-my-pi/pi-tui";
import type { Block, PaintContext } from "@oh-my-pi/pi-tui/term/paint";
import { renderDiff, wrapDiffRow } from "@oh-my-pi/pi-tui/text/diff";
import { languageFromPath } from "@oh-my-pi/pi-tui/text/lang";
import { shortenHome } from "@oh-my-pi/pi-tui/text/sanitize";
import { padTo, replaceTabs, truncate, truncateMiddle, visibleWidth, wrap } from "@oh-my-pi/pi-tui/text/width";
import type { Theme } from "@oh-my-pi/pi-tui/theme/contract";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import type { EditBodyPart, EditCard, EditTerm } from "../../tools/edit";
import { displayPath } from "../../tools/file-common";
import { diagnosticsRows, fileLink } from "./file-common";
import { edgeRow, expandHint, PREVIEW_WINDOW_ROWS, spinnerGlyph } from "./frame";
import { defineToolLook, toolProps } from "./look";

/** Changed hunks a collapsed diff keeps. */
const COLLAPSED_HUNKS = 8;
/** Diff rows a collapsed result keeps. */
const COLLAPSED_LINES = 40;
/** Rows of a streamed preview's tail while collapsed. */
const STREAM_ROWS = 12;
/** Replacement-text lines a call previews, and the cells each keeps. */
const TEXT_LINES = 6;
const TEXT_WIDTH = 80;

// ─── Collapsed diff ─────────────────────────────────────────────────────────

interface Segment {
	readonly lines: string[];
	readonly change: boolean;
	readonly gap: boolean;
}

/** Runs of changed rows, context rows and gaps (blank or `...` rows). */
function segments(lines: readonly string[]): Segment[] {
	const out: Segment[] = [];
	let current: Segment | undefined;
	for (const line of lines) {
		const change = line.startsWith("+") || line.startsWith("-");
		if (line.trimStart().startsWith("...") || line.trim().length === 0) {
			if (current) out.push(current);
			out.push({ lines: [line], change: false, gap: true });
			current = undefined;
		} else if (!current || current.change !== change) {
			if (current) out.push(current);
			current = { lines: [line], change, gap: false };
		} else current.lines.push(line);
	}
	if (current) out.push(current);
	return out;
}

/** Changed runs of a diff (a run is a maximal block of `+`/`-` rows). */
function changeRuns(lines: readonly string[]): number {
	let runs = 0;
	let inRun = false;
	for (const line of lines) {
		const change = line.startsWith("+") || line.startsWith("-");
		if (change && !inRun) runs++;
		inRun = change;
	}
	return runs;
}

/**
 * A diff cut to `maxHunks` changed runs and about `maxLines` rows: every
 * changed row kept while they fit, the context between them shared out in
 * proportion (a long run keeps its ends around a blank gap, or the rows
 * next to the change).
 */
function trimDiff(
	diff: string,
	maxHunks: number,
	maxLines: number,
): { text: string; hiddenHunks: number; hiddenLines: number } {
	const lines = diff ? diff.split("\n") : [];
	const hunks = changeRuns(lines);
	if (lines.length <= maxLines && hunks <= maxHunks) return { text: diff, hiddenHunks: 0, hiddenLines: 0 };
	const segs = segments(lines);
	const changed = segs.filter(seg => seg.change).reduce((sum, seg) => sum + seg.lines.length, 0);
	const kept: string[] = [];
	let keptHunks = 0;
	if (changed > maxLines) {
		for (const seg of segs) {
			if (kept.length >= maxLines) break;
			if (seg.change) {
				if (keptHunks >= maxHunks) break;
				keptHunks++;
			}
			kept.push(...seg.lines.slice(0, maxLines - kept.length));
		}
		return {
			text: kept.join("\n"),
			hiddenHunks: Math.max(0, hunks - keptHunks),
			hiddenLines: Math.max(0, lines.length - kept.length),
		};
	}
	const budget = maxLines - changed;
	const context = segs.filter(seg => !seg.change).reduce((sum, seg) => sum + seg.lines.length, 0);
	let source = 0;
	if (context <= budget) {
		for (const seg of segs) {
			if (seg.change) {
				if (keptHunks >= maxHunks) break;
				keptHunks++;
			}
			kept.push(...seg.lines);
			source += seg.lines.length;
		}
	} else {
		const ratio = context > 0 ? budget / context : 0;
		let remaining = budget;
		for (let i = 0; i < segs.length; i++) {
			const seg = segs[i]!;
			if (seg.change) {
				if (keptHunks >= maxHunks) break;
				keptHunks++;
				kept.push(...seg.lines);
				source += seg.lines.length;
				continue;
			}
			if (remaining <= 0) continue;
			const allowed = Math.min(remaining, Math.max(1, Math.floor(seg.lines.length * ratio)));
			const start = kept.length;
			let added: number;
			if (seg.gap || seg.lines.length <= allowed) {
				for (let j = 0; j < allowed; j++) kept.push(seg.lines[j]!);
				added = allowed;
			} else {
				const before = segs[i + 1]?.change;
				const after = segs[i - 1]?.change;
				if (before && after) {
					if (allowed >= 3) {
						const shown = allowed - 1;
						const head = Math.ceil(shown / 2);
						kept.push(...seg.lines.slice(0, head), "");
						if (shown - head > 0) kept.push(...seg.lines.slice(-(shown - head)));
						added = shown;
					} else {
						const head = Math.ceil(allowed / 2);
						kept.push(...seg.lines.slice(0, head));
						if (allowed - head > 0) kept.push(...seg.lines.slice(-(allowed - head)));
						added = allowed;
					}
				} else if (before) {
					kept.push(...seg.lines.slice(-allowed));
					added = allowed;
				} else if (after) {
					kept.push(...seg.lines.slice(0, allowed));
					added = allowed;
				} else {
					added = Math.min(allowed, 2);
					kept.push(...seg.lines.slice(0, added));
				}
			}
			source += added;
			remaining -= kept.length - start;
		}
	}
	return {
		text: kept.join("\n"),
		hiddenHunks: Math.max(0, hunks - keptHunks),
		hiddenLines: Math.max(0, lines.length - source),
	};
}

/** A result's diff rows: whole when expanded, else trimmed to {@link COLLAPSED_LINES} rows with a remainder note. */
function diffRows(theme: Theme, diff: string, path: string, expanded: boolean, inner: number): string[] {
	if (expanded) return renderDiff(diff, { theme, path }).flatMap(row => wrapDiffRow(row, inner));
	const trimmed = trimDiff(diff, COLLAPSED_HUNKS, COLLAPSED_LINES);
	const rendered = renderDiff(trimmed.text, { theme, path });
	const rows: string[] = [];
	let complete = 0;
	for (const line of rendered) {
		const wrapped = wrapDiffRow(line, inner);
		const room = COLLAPSED_LINES - rows.length;
		if (wrapped.length <= room) {
			rows.push(...wrapped);
			complete++;
			continue;
		}
		if (room > 0) rows.push(...wrapped.slice(0, room));
		break;
	}
	const hiddenLines = trimmed.hiddenLines + rendered.length - complete;
	if (trimmed.hiddenHunks > 0 || hiddenLines > 0) {
		const remainder = [
			trimmed.hiddenHunks > 0 ? `${trimmed.hiddenHunks} more hunks` : undefined,
			hiddenLines > 0 ? `${hiddenLines} more lines` : undefined,
		].filter(Boolean);
		// The old renderer opened its color on the row before, so the note itself reads plain.
		rows.push(`… (${remainder.join(", ")}) ${expandHint(theme)}`);
	}
	return rows;
}

// ─── Streamed previews ──────────────────────────────────────────────────────

const NUMBERED = /^([+\-\s]\s*(\d+)[|│])(.*)$/s;
const NUMBERED_LEGACY = /^([+\-\s]\s*(\d+)\s)(.*)$/s;

/** Rows a raw diff line takes once drawn with its gutter at `inner` cells. */
function streamLineRows(line: string, inner: number): number {
	const numbered = NUMBERED.exec(line) ?? NUMBERED_LEGACY.exec(line);
	if (!numbered) return Math.max(1, wrap(replaceTabs(line), inner).length);
	const gutter = Math.max(visibleWidth(numbered[1]!), Math.max(3, numbered[2]!.length) + 2);
	return Math.max(1, wrap(replaceTabs(numbered[3] ?? ""), Math.max(1, inner - gutter)).length);
}

/** A streamed diff's newest lines within `budget` rows (at least one line), and whether earlier ones were cut. */
function streamTail(diff: string, inner: number, budget: number): { text: string; hidden: boolean } {
	const lines = diff.replace(/\n+$/, "").split("\n");
	if (lines.length === 1 && lines[0] === "") return { text: "", hidden: false };
	let start = lines.length;
	let rows = 0;
	while (start > 0) {
		const needed = streamLineRows(lines[start - 1]!, inner);
		if (rows > 0 && rows + needed > Math.max(1, budget)) break;
		rows += needed;
		start--;
	}
	return { text: lines.slice(start).join("\n"), hidden: start > 0 };
}

function streamRows(theme: Theme, diff: string, path: string, expanded: boolean, inner: number): string[] {
	if (!diff) return [];
	const budget = expanded ? PREVIEW_WINDOW_ROWS : Math.min(STREAM_ROWS, PREVIEW_WINDOW_ROWS);
	const tail = streamTail(diff, inner, budget);
	const rows = ["", ""];
	if (tail.hidden) rows.push(theme.fg("dim", "… (content above)"));
	rows.push(...renderDiff(tail.text, { theme, path }));
	return rows;
}

/** Replacement text: its first lines, each cut to {@link TEXT_WIDTH} cells, then `… N more lines`; trailing blank lines dropped. */
function textRows(theme: Theme, text: string): string[] {
	const lines = sanitizeText(text).split("\n");
	const rows = ["", ""];
	for (const line of lines.slice(0, TEXT_LINES))
		rows.push(theme.fg("toolOutput", truncate(replaceTabs(line), TEXT_WIDTH)));
	if (lines.length > TEXT_LINES) rows.push(theme.fg("dim", `… ${lines.length - TEXT_LINES} more lines`));
	while (rows.length > 0 && visibleWidth(rows[rows.length - 1]!) === 0) rows.pop();
	return rows;
}

// ─── Cards ──────────────────────────────────────────────────────────────────

/** A path as edit heads show it, middle-cut to `max` cells. */
function headPath(path: string, max?: number): string {
	const shown = replaceTabs(shortenHome(displayPath(sanitizeText(path))));
	return max === undefined ? shown : truncateMiddle(shown, Math.max(0, Math.floor(max)));
}

interface PaintState {
	readonly cx: PaintContext;
	readonly expanded: boolean;
	readonly spinning: boolean;
}

function headGlyph(state: PaintState, icon: EditCard["icon"]): string {
	const theme = state.cx.theme;
	const symbol = (key: string, color: string): string => theme.fg(color, theme.symbols.symbol(key));
	switch (icon) {
		case "spin":
			return state.spinning && !state.cx.reduceMotion ? spinnerGlyph(state.cx) : "";
		case "pending":
			return symbol("status.pending", "muted");
		case "error":
			return symbol("status.error", "error");
		case "success":
			return symbol("status.success", "success");
		case "edit":
			return symbol("tool.edit", "accent");
		case "delete":
			return symbol("tool.delete", "accent");
		case "move":
			return symbol("tool.move", "accent");
	}
}

/** `glyph Title: icon path → rename` plus suffixes, its paths middle-cut until it fits the top edge. */
function headRow(state: PaintState, card: EditCard, width: number): string {
	const theme = state.cx.theme;
	const glyph = headGlyph(state, card.icon);
	let suffix = "";
	if (card.stats && (card.stats.added > 0 || card.stats.removed > 0)) {
		const parts = [
			card.stats.added > 0 ? theme.fg("toolDiffAdded", `+${card.stats.added}`) : undefined,
			card.stats.removed > 0 ? theme.fg("toolDiffRemoved", `-${card.stats.removed}`) : undefined,
		].filter(Boolean);
		suffix += ` ${theme.fg("dim", theme.symbols.symbol("format.bracketLeft"))}${parts.join(theme.fg("dim", "/"))}${theme.fg("dim", theme.symbols.symbol("format.bracketRight"))}`;
	}
	if (card.more) suffix += theme.fg("dim", ` (+${card.more} more)`);
	const build = (max?: number): { text: string; pathWidth: number } => {
		const icon = theme.fg("muted", theme.symbols.langIcon(languageFromPath(card.path) ?? "text"));
		const primary = card.path ? headPath(card.path, max) : "…";
		let paths = card.path
			? fileLink(state.cx, theme.fg("accent", primary), card.link?.path, card.link?.line)
			: theme.fg("toolOutput", primary);
		let pathWidth = visibleWidth(primary);
		if (card.rename !== undefined) {
			const rename = headPath(card.rename, max);
			paths += ` ${theme.fg("dim", "→")} ${fileLink(state.cx, theme.fg("accent", rename), card.link?.rename)}`;
			pathWidth += visibleWidth(rename);
		}
		const title = `${theme.fg("accent", card.title)}: ${theme.fg("muted", `${icon} ${paths}`)}`;
		return { text: `${glyph ? `${glyph} ` : ""}${title}${suffix}`, pathWidth };
	};
	const head = build();
	// The top edge leaves `╭─── ` and ` ╮`.
	const overflow = visibleWidth(head.text) - Math.max(0, width - 7);
	if (overflow <= 0 || head.pathWidth <= 1) return head.text;
	const count = Math.max(1, (card.path ? 1 : 0) + (card.rename !== undefined ? 1 : 0));
	return build(Math.max(1, Math.floor((head.pathWidth - overflow) / count))).text;
}

function partRows(state: PaintState, part: EditBodyPart, inner: number, width: number): string[] {
	const theme = state.cx.theme;
	switch (part.k) {
		case "stream":
			return streamRows(theme, part.diff, part.path, state.expanded, inner);
		case "files": {
			const rows: string[] = [];
			for (const file of part.files) {
				if (!file.diff && !file.error && !file.notice) continue;
				// The rule's dim color opened on the blank rows before it: the rule itself reads plain.
				rows.push(...(rows.length === 0 ? ["", ""] : [""]), `── ${headPath(file.path)} ──`);
				if (file.error) rows.push(theme.fg("error", replaceTabs(file.error)));
				else if (file.notice) rows.push(theme.fg("dim", replaceTabs(file.notice)));
				else rows.push(...streamRows(theme, file.diff!, file.path, state.expanded, inner).slice(1));
			}
			return rows;
		}
		case "text":
			return textRows(theme, part.text);
		case "raw":
			return part.text.split("\n");
		case "diff":
			return diffRows(theme, part.diff, part.path, state.expanded, inner);
		case "error":
			// Only the first line takes the error color (the old renderer colored the text before splitting it).
			return replaceTabs(part.text)
				.split("\n")
				.map((line, index) => (index === 0 ? theme.fg("error", line) : line));
		case "patchError":
			return [theme.fg("error", truncate(replaceTabs(part.text), Math.max(1, width - 2)))];
		case "note":
			return [theme.fg("dim", part.text)];
		case "diagnostics":
			return [
				"",
				...diagnosticsRows(theme, part.diagnostics, state.expanded, file =>
					theme.symbols.langIcon(languageFromPath(file)),
				),
			];
	}
}

/** A row filled with a background that survives the row's own resets. */
function fillRow(theme: Theme, key: string, row: string, width: number): string {
	const padded = padTo(row, width);
	const fill = (theme as { bgFill?: (color: string, text: string) => string }).bgFill;
	return fill ? fill.call(theme, key, padded) : theme.bg(key, padded);
}

const PHASE_BG: Record<EditCard["phase"], string> = {
	pending: "toolPendingBg",
	partial: "toolPendingBg",
	success: "toolSuccessBg",
	error: "toolErrorBg",
};

function cardRows(state: PaintState, card: EditCard, width: number): string[] {
	const theme = state.cx.theme;
	const head = headRow(state, card, width);
	if (card.kind === "inline") return [truncate(head, width)];
	const inner = Math.max(1, width - 2);
	const lines: string[] = [];
	for (const part of card.body) lines.push(...partRows(state, part, inner, width));
	// A streamed preview's leading blank rows go; a per-file preview keeps its rule's.
	if (card.body[0]?.k !== "files") while (lines.length > 0 && lines[0]!.trim() === "") lines.shift();
	const border = card.phase === "error" ? "error" : "borderMuted";
	const box = theme.symbols.box;
	const v = theme.fg(border, box.vertical);
	const rows = [edgeRow(theme, width, box.topLeft, box.topRight, head, border)];
	for (const line of lines)
		for (const row of line === "" ? [""] : wrapDiffRow(line, inner))
			rows.push(`${v}${padTo(truncate(row, inner), inner)}${v}`);
	rows.push(
		edgeRow(
			theme,
			width,
			box.bottomLeft,
			box.bottomRight,
			card.footer ? theme.fg("dim", card.footer) : undefined,
			border,
		),
	);
	return rows.map(row => fillRow(theme, PHASE_BG[card.phase], truncate(row, width, ""), width));
}

function paintEdit(node: UiNode, cx: PaintContext): Block {
	const props = toolProps(node);
	const term = props.term ?? {};
	const edit = term.edit as EditTerm | undefined;
	if (!edit) return { rows: [] };
	const state: PaintState = { cx, expanded: term.expanded === true, spinning: term.spinning === true };
	const width = cx.width;
	const rows: string[] = [];
	edit.cards.forEach((card, index) => {
		if (index > 0) rows.push("");
		rows.push(...cardRows(state, card, width));
	});
	const pending = edit.pending ?? 0;
	if (pending > 0) {
		if (rows.length > 0) rows.push("");
		const theme = cx.theme;
		const glyph = state.spinning && !cx.reduceMotion ? `${spinnerGlyph(cx)} ` : "";
		rows.push(
			truncate(
				`${glyph}${theme.fg("accent", "Edit")}: ${theme.fg("muted", theme.fg("dim", `${pending} more file${pending > 1 ? "s" : ""} pending…`))}`,
				width,
			),
		);
	}
	return { rows };
}

defineToolLook("edit", { paint: paintEdit, margin: true, animated: true });
