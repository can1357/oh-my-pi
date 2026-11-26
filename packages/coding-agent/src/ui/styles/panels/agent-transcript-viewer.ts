/**
 * The transcript viewer in the terminal (`card` role `omp.hub.transcript`),
 * filling the screen: a rule, the `Agent Hub · <id>` title and the agent's
 * meta, a rule, the transcript scrolled to the rows left (a scrollbar in the
 * last column when it overflows; it follows the end until scrolled up), then
 * the send failure, the draft in a rounded field, the stats, the key hints
 * and a closing rule. The wheel scrolls three rows a notch.
 */
import type { UiNode } from "@oh-my-pi/pi-tui";
import { type Block, defineRolePainter, EMPTY_BLOCK, type PaintContext } from "@oh-my-pi/pi-tui/term/paint";
import { defineRoleWidget } from "@oh-my-pi/pi-tui/term/widgets";
import type { Theme } from "@oh-my-pi/pi-tui/theme/contract";
import { stripEscapes } from "@oh-my-pi/pi-tui/text/ansi";
import { padTo, truncate, visibleWidth } from "@oh-my-pi/pi-tui/text/width";
import { formatDuration, formatNumber } from "@oh-my-pi/pi-utils";
import { sanitizeErrorLine } from "../../../modes/view-model/chrome/error-block";
import type {
	AgentTranscriptViewerModel,
	ViewerAgentStatus,
} from "../../overlays/panels/agent-transcript-viewer-model";
import { formatContextUsage } from "../../status/format";
import { type ComposerChromeContext, caretOverflow, composerRowLines, composerShape } from "../composer/shapes";
import "../messages";
import "../tools";
import { keyLabel } from "../../keys/hints";
import { bindingGlyph, findNode, roleOf, termOf } from "./common";

const STATUS_COLOR: Readonly<Record<ViewerAgentStatus, string>> = {
	running: "success",
	idle: "accent",
	parked: "muted",
	aborted: "error",
};

function headerLines(theme: Theme, model: AgentTranscriptViewerModel): string[] {
	const id = model.deps.agentId;
	const sep = theme.symbols.symbol("sep.dot");
	const lines = [theme.fg("accent", `Agent Hub ${sep} ${id}`)];
	const ref = model.ref();
	if (ref) {
		const kind = ref.parentId ? `${ref.kind} ${sep} of ${ref.parentId}` : ref.kind;
		const label = model.model ? theme.fg("muted", `${sep}${model.model}`) : "";
		lines.push(
			`${theme.style("strong", id)} ${theme.fg(STATUS_COLOR[ref.status], ref.status)}${theme.fg("dim", ` ${kind}`)}${label}`,
		);
	}
	return lines;
}

function statsLine(theme: Theme, model: AgentTranscriptViewerModel): string | undefined {
	const progress = model.progress();
	if (!progress) return undefined;
	const sep = theme.symbols.symbol("sep.dot");
	const stats: string[] = [];
	if (progress.toolCount > 0)
		stats.push(`${formatNumber(progress.toolCount)} ${theme.symbols.symbol("icon.extensionTool")}`);
	if (progress.contextTokens && progress.contextTokens > 0) {
		stats.push(
			progress.contextWindow && progress.contextWindow > 0
				? formatContextUsage(
						(progress.contextTokens / progress.contextWindow) * 100,
						progress.contextWindow,
						progress.contextTokens,
					)
				: formatNumber(progress.contextTokens),
		);
	}
	if (progress.durationMs > 0) stats.push(formatDuration(progress.durationMs));
	const parts: string[] = [];
	if (stats.length > 0) parts.push(theme.fg("dim", stats.join(sep)));
	if (progress.cost > 0) parts.push(theme.fg("statusLineCost", `$${progress.cost.toFixed(2)}`));
	return parts.length > 0 ? parts.join(sep) : undefined;
}

function hintLine(theme: Theme, model: AgentTranscriptViewerModel): string {
	const keys = [
		`${keyLabel(theme, "escape")}:close`,
		`${keyLabel(theme, model.deps.expandKeys[0] ?? "ctrl+o")}:expand`,
		`${model.sendable ? "empty input → " : ""}j/k:scroll`,
		`g/${keyLabel(theme, "shift+g")}:top/bottom`,
	].join("  ");
	return theme.fg("dim", model.sendable ? `${bindingGlyph("tui.input.submit", "enter", theme)}:send  ${keys}` : keys);
}

/** The draft in the rounded field (its last row merged into the bottom border). */
function fieldRows(cx: PaintContext, editor: UiNode, width: number): string[] {
	const theme = cx.theme;
	const shape = composerShape("box");
	const paddingX = shape.paddingX;
	const side = shape.sideWidth(paddingX);
	const content = Math.max(1, width - 2 * side);
	const block = cx.paint(editor, content + caretOverflow(shape, paddingX));
	const chrome: ComposerChromeContext = {
		width,
		paddingX,
		theme,
		border: text => theme.fg("borderMuted", text),
		accent: text => theme.fg("accent", text),
		surface: text => text,
		box: theme.symbols.box,
	};
	const rows: string[] = [];
	const top = shape.top?.(chrome);
	if (top !== undefined) rows.push(top);
	const lines = block.rows.length > 0 ? block.rows : [""];
	lines.forEach((text, index) => {
		const used = visibleWidth(text);
		rows.push(
			...composerRowLines(shape, {
				...chrome,
				text,
				pad: " ".repeat(Math.max(0, content - used)),
				gutter: "",
				first: index === 0,
				last: index === lines.length - 1,
				overflow: Math.max(0, used - content),
			}),
		);
	});
	const bottom = shape.bottom?.(chrome);
	if (bottom !== undefined) rows.push(bottom);
	return rows;
}

/** A row showing nothing: no text and no background. */
function bare(row: string): boolean {
	return !row.includes("\x1b[48") && stripEscapes(row).trim() === "";
}

/**
 * The transcript's blocks one blank row apart, each without bare edge rows (a
 * bubble keeps its padding), and the row each block starts at.
 */
function transcriptRows(cx: PaintContext, transcript: UiNode, width: number): { rows: string[]; starts: number[] } {
	const rows: string[] = [];
	const starts: number[] = [];
	for (const child of transcript.children()) {
		const block = cx.paint(child, width).rows;
		let start = 0;
		let end = block.length;
		while (start < end && bare(block[start]!)) start++;
		while (end > start && bare(block[end - 1]!)) end--;
		if (rows.length > 0 && start < end) rows.push("");
		starts.push(rows.length);
		rows.push(...block.slice(start, end));
	}
	return { rows, starts };
}

/** The body window: `lines` from the model's scroll, a scrollbar in the last column when they overflow. */
function bodyWindow(
	theme: Theme,
	model: AgentTranscriptViewerModel,
	lines: readonly string[],
	height: number,
	width: number,
) {
	const max = Math.max(0, lines.length - height);
	model.bodyRows = lines.length;
	model.bodyHeight = height;
	model.scroll = model.followTail ? max : Math.min(model.scroll, max);
	const out: string[] = [];
	if (max === 0) {
		for (let row = 0; row < height; row++) out.push(truncate(lines[row] ?? "", width));
		return out;
	}
	const inner = Math.max(0, width - 1);
	const size = Math.max(1, Math.min(Math.floor((height * height) / lines.length), height));
	const start = Math.round((model.scroll / max) * (height - size));
	for (let row = 0; row < height; row++) {
		const bar = row >= start && row < start + size ? theme.fg("accent", "█") : theme.fg("dim", "│");
		out.push(`${padTo(truncate(lines[model.scroll + row] ?? "", inner), inner)}${bar}`);
	}
	return out;
}

defineRolePainter("card", "omp.hub.transcript", (node, cx): Block => {
	const model = termOf<{ model: AgentTranscriptViewerModel }>(node).model;
	if (!model || cx.width <= 0) return EMPTY_BLOCK;
	const theme = cx.theme;
	const width = cx.width;
	const content = Math.max(1, width - 1);
	const chromeWidth = Math.max(1, width - 2);
	const chrome = (line: string) => ` ${truncate(line, Math.max(0, width - 1))}`;

	const header = headerLines(theme, model);
	const footer: string[] = [];
	const notice = model.shownNotice();
	if (notice) footer.push(theme.fg("error", sanitizeErrorLine(notice, chromeWidth)));
	const editor = model.sendable ? findNode(node, child => child.kind === "editor") : undefined;
	if (editor) footer.push(...fieldRows(cx, editor, chromeWidth));
	const stats = statsLine(theme, model);
	if (stats) footer.push(stats);
	footer.push(hintLine(theme, model));

	const transcript = findNode(node, child => roleOf(child) === "omp.transcript");
	let lines = [` ${theme.fg("dim", sanitizeErrorLine(model.placeholder(), Math.max(10, content - 1)))}`];
	if (transcript) {
		const painted = transcriptRows(cx, transcript, content);
		lines = painted.rows;
		// Opened from an activity row: start at that entry once.
		const reveal = model.revealEntry;
		const at = reveal === undefined ? -1 : model.blocks().findIndex(block => block.id === reveal);
		if (at !== -1 && painted.starts[at] !== undefined) {
			model.revealEntry = undefined;
			model.followTail = false;
			model.scroll = painted.starts[at]!;
		}
	}
	const height = Math.max(0, Math.trunc(model.deps.terminalRows()));
	const bodyHeight = Math.max(3, height - header.length - footer.length - 3);
	const rule = theme.fg("border", theme.symbols.box.horizontal.repeat(width));
	const rows = [
		rule,
		...header.map(chrome),
		rule,
		...bodyWindow(theme, model, lines, bodyHeight, width),
		...footer.map(chrome),
		rule,
	];
	return { rows, hits: [{ row: 0, col: 0, width, height: rows.length, node }] };
});

defineRoleWidget("card", "omp.hub.transcript", {
	mouse(node, mouse) {
		const model = termOf<{ model: AgentTranscriptViewerModel }>(node).model;
		if (!model || mouse.action !== "press") return false;
		if (mouse.button === "wheel-up") model.scrollBy(-3);
		else if (mouse.button === "wheel-down") model.scrollBy(3);
		else return false;
		return true;
	},
});
