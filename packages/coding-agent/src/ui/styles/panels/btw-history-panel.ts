/**
 * `/btw` history in the terminal: a box titled `BTW history`, the pane labels
 * (`❯ History (N)`, `Details`), then the history list beside the reader from
 * 96 columns (one pane below, the focused one), the follow-up composer, a
 * navigation hint, the key hints and the bottom edge. The reader is a
 * scrolled document of each turn's status, question and answer (a scrollbar
 * in its last column when it overflows); the list scrolls to keep the
 * selection in view. Short or narrow terminals drop the frame.
 */
import type { UiNode } from "@oh-my-pi/pi-tui";
import { type Block, defineRolePainter, EMPTY_BLOCK, type Hit, type PaintContext } from "@oh-my-pi/pi-tui/term/paint";
import { defineRoleWidget } from "@oh-my-pi/pi-tui/term/widgets";
import type { Theme } from "@oh-my-pi/pi-tui/theme/contract";
import { padTo, sliceColumns, truncate, visibleWidth, wrap } from "@oh-my-pi/pi-tui/text/width";
import { sanitizeDisplayLine } from "../../../extensibility/inventory/display-text";
import { sanitizeErrorLine } from "../../../modes/view-model/chrome/error-block";
import { getBtwCopyText, getBtwLatestTurn } from "../../../session/btw-history-model";
import {
	BTW_STATUS,
	type BtwHistoryModel,
	type BtwPane,
	DATE_FORMAT,
	displayTurns,
	listStamp,
	topicLabel,
} from "../../overlays/panels/btw-history-panel-model";
import { bindingGlyph, findNode, keyGlyph, roleOf, selectNavGlyphs, termOf } from "./common";

const SPLIT_AT = 96;
const LIST_RATIO = 0.42;
const LIST_MAX = 46;

/** `↑ label`: the key dim, its label muted. */
function keyHint(theme: Theme, keys: string, label: string): string {
	return `${theme.fg("dim", keys)}${theme.fg("muted", ` ${label}`)}`;
}

function focusLabel(theme: Theme, model: BtwHistoryModel, pane: BtwPane): string {
	const label = pane === "list" ? `History (${model.records.length})` : "Details";
	return model.focus === pane
		? theme.style("strong", theme.fg("accent", `${theme.symbols.symbol("nav.cursor")} ${label}`))
		: theme.fg("muted", `  ${label}`);
}

/** The offset nearest `offset` that shows `row` in a `visible`-row window over `total` rows. */
function revealRow(offset: number, row: number, total: number, visible: number): number {
	let next = offset;
	if (row < next) next = row;
	else if (row >= next + visible) next = row - visible + 1;
	return Math.max(0, Math.min(next, Math.max(0, total - visible)));
}

/** `rows` in a window of their own height, a scrollbar in the last column when `total` rows overflow it. */
function scrollbarWindow(
	theme: Theme,
	rows: readonly string[],
	width: number,
	total: number,
	offset: number,
	track: string,
): string[] {
	const height = rows.length;
	if (total <= height || height <= 0 || width <= 0) return rows.map(row => truncate(row, width));
	const inner = Math.max(0, width - 1);
	const max = total - height;
	const size = Math.max(1, Math.min(Math.floor((height * height) / total), height));
	const start = max === 0 ? 0 : Math.round((Math.max(0, Math.min(offset, max)) / max) * (height - size));
	return rows.map(
		(row, index) =>
			`${padTo(truncate(row, inner), inner)}${index >= start && index < start + size ? theme.fg("accent", "█") : theme.fg(track, "│")}`,
	);
}

function listRows(theme: Theme, model: BtwHistoryModel, width: number, height: number): string[] {
	const span = width < 36 && height >= 2 ? 2 : 1;
	model.listHeight = Math.max(1, Math.floor(height / span));
	const records = model.records;
	if (records.length === 0) {
		return wrap(theme.fg("muted", "No side questions yet.\n\nUse /btw QUESTION to start one."), width).slice(
			0,
			height,
		);
	}
	const selected = model.selectedIndex();
	model.listScroll = revealRow(model.listScroll, selected, records.length, model.listHeight);
	const total = records.length * span;
	const content = Math.max(0, width - (total > height ? 1 : 0));
	const now = model.now();
	const lines: string[] = [];
	const end = Math.min(records.length, model.listScroll + model.listHeight);
	for (let index = model.listScroll; index < end; index++) {
		const record = records[index]!;
		const picked = index === selected;
		const status = BTW_STATUS[getBtwLatestTurn(record).status];
		const cursor = picked
			? theme.fg(model.focus === "list" ? "accent" : "muted", theme.symbols.symbol("nav.cursor"))
			: " ";
		const prefix = `${cursor} ${theme.fg("dim", listStamp(record.createdAt, now))} ${theme.fg(status.color, status.label)} `;
		const snippet = truncate(
			sanitizeDisplayLine(topicLabel(record)),
			Math.max(0, content - (span === 2 ? 2 : visibleWidth(prefix))),
		);
		const question = picked ? theme.style("strong", snippet) : snippet;
		const fill = (text: string) => theme.bg("selectedBg", content > 0 ? padTo(text, content) : "");
		const first = span === 2 ? prefix : `${prefix}${question}`;
		lines.push(picked ? fill(first) : truncate(first, content));
		if (span === 2) lines.push(picked ? fill(`  ${question}`) : `  ${question}`);
	}
	while (lines.length < height) lines.push("");
	return scrollbarWindow(theme, lines, width, total, model.listScroll * span, "muted");
}

/** The reader's document at `inner` columns: each turn's status line, question and answer. */
function readerLines(cx: PaintContext, model: BtwHistoryModel, sheet: UiNode, inner: number): string[] {
	const theme = cx.theme;
	const record = model.selected();
	if (!record) return wrap(theme.fg("muted", "No side questions yet. Use /btw QUESTION to start one."), inner);
	const lines: string[] = [];
	if (model.isCopied(record)) lines.push(...wrap(theme.fg("success", "✓ Copied to clipboard"), inner), "");
	const thread = findNode(sheet, node => roleOf(node) === "omp.btw.thread");
	const turnNodes = thread?.children().filter(node => roleOf(node) === "omp.btw.turn") ?? [];
	displayTurns(record).forEach((turn, index) => {
		if (index > 0) lines.push("", theme.fg("dim", theme.symbols.box.horizontal.repeat(inner)), "");
		const status = BTW_STATUS[turn.status];
		const node = turnNodes[index];
		const question = node?.children()[0];
		const answerNode = node
			?.children()
			.find(child => roleOf(child) === "omp.btw.answer")
			?.children()[0];
		lines.push(
			...wrap(theme.fg(status.color, `${status.label} · ${DATE_FORMAT.format(turn.createdAt)}`), inner),
			"",
			theme.style("strong", theme.fg("accent", "Question")),
			...(question ? cx.paint(question, inner).rows : []),
			"",
			theme.style("strong", theme.fg("accent", "Answer")),
		);
		const block = model.injectBlock(record, turn, index);
		if ((block || turn.answer.trim()) && answerNode) lines.push(...cx.paint(answerNode, inner).rows);
		else
			lines.push(
				...wrap(theme.fg("dim", turn.status === "running" ? "Waiting for response…" : "No answer text."), inner),
			);
		if (turn.error) lines.push("", ...wrap(theme.fg("error", sanitizeErrorLine(turn.error)), inner));
		if (turn.status === "interrupted") lines.push("", ...wrap(theme.fg("muted", "Not resumed in this view."), inner));
	});
	return lines;
}

/** The reader's window at the model's scroll (clamped to `height`). */
function readerWindow(theme: Theme, model: BtwHistoryModel, lines: readonly string[], width: number, height: number) {
	const max = Math.max(0, lines.length - height);
	model.detailRows = lines.length;
	model.detailHeight = height;
	model.detailScroll = Math.max(0, Math.min(model.detailScroll, max));
	const rows: string[] = [];
	for (let row = 0; row < height; row++) rows.push(lines[model.detailScroll + row] ?? "");
	return scrollbarWindow(theme, rows, width, lines.length, model.detailScroll, "muted");
}

/**
 * The follow-up line: the accent prompt, the draft (scrolled to keep the caret in view) and an inverse caret;
 * `caretGlyph` (push-to-talk's mic) takes the caret's cell at the end of the draft.
 */
function composerLine(theme: Theme, text: string, cursor: number, width: number, caretGlyph?: string): string {
	const prompt = "Follow up: ";
	const room = Math.max(1, width - visibleWidth(prompt));
	const before = text.slice(0, cursor);
	const glyph = cursor >= text.length ? caretGlyph : undefined;
	const caretChar = glyph
		? " ".repeat(Math.max(1, visibleWidth(glyph)))
		: (text.slice(cursor).match(/^./su)?.[0] ?? " ");
	const after = text.slice(cursor + (cursor < text.length ? caretChar.length : 0));
	const caretAt = visibleWidth(before);
	const full = `${before}\u0000${after}`;
	const start = Math.max(0, caretAt + 1 - room);
	const shown = sliceColumns(full.replace("\u0000", caretChar), start, start + room);
	const caretCol = caretAt - start;
	const head = sliceColumns(shown, 0, caretCol);
	const tail = sliceColumns(shown, caretCol + visibleWidth(caretChar), room);
	return `${theme.fg("accent", prompt)}${head}${glyph ?? `\x1b[7m${caretChar}\x1b[27m`}${tail}`;
}

/** The key hints of the footer. */
function hints(theme: Theme, model: BtwHistoryModel, inner: number): string {
	const record = model.selected();
	if (model.composer) {
		return [
			keyHint(theme, bindingGlyph("tui.input.submit", "enter"), model.followUpPending ? "starting…" : "send"),
			keyHint(theme, bindingGlyph("tui.select.cancel", "escape"), "cancel"),
		].join(" · ");
	}
	const running = model.running(record);
	const hides = model.options.escapeHides === true;
	const parts = [keyHint(theme, bindingGlyph("tui.select.cancel", "escape"), running && !hides ? "cancel" : "close")];
	if (running && hides) parts.push(keyHint(theme, "x", "cancel"));
	if (model.records.length > 1) parts.push(keyHint(theme, `${keyGlyph("tab")}/${keyGlyph("ctrl+/")}`, "switch pane"));
	if (model.canFollowUp(record))
		parts.push(keyHint(theme, `f/${bindingGlyph("tui.select.confirm", "enter")}`, "follow up"));
	if (model.canInject(record)) parts.push(keyHint(theme, keyGlyph(model.injectKey), "inject"));
	if (record && getBtwCopyText(record) !== undefined) {
		parts.push(
			model.isCopied(record)
				? theme.fg("success", "✓ copied · c to copy again")
				: keyHint(theme, "c", inner < 40 ? "copy" : "copy answer"),
		);
	}
	if (model.canBranch(record)) parts.push(keyHint(theme, "b", inner < 40 ? "branch" : "branch to chat"));
	return parts.join(" · ");
}

defineRolePainter("col", "omp.btw.sheet", (node, cx): Block => {
	const { model, caretGlyph } = termOf<{ model: BtwHistoryModel; caretGlyph?: string }>(node);
	const theme = cx.theme;
	const width = Math.max(0, Math.floor(cx.width));
	const height = model ? Math.max(0, Math.floor(model.options.terminalRows())) : 0;
	if (!model || width === 0 || height === 0) return EMPTY_BLOCK;
	const framed = width >= 12 && height >= 8;
	const inner = Math.max(1, width - (framed ? 4 : 0));
	const wide = framed && width >= SPLIT_AT;
	const listWidth = wide ? Math.min(LIST_MAX, Math.floor(width * LIST_RATIO)) : inner;
	const detailWidth = wide ? width - 7 - listWidth : inner;
	const record = model.selected();
	const composer = model.composer;

	const actionLines = wrap(hints(theme, model, inner), inner).slice(0, framed ? 2 : 1);
	const chrome = framed ? 3 + actionLines.length : height >= 3 ? 2 : 0;
	const composerLines: string[] = [];
	if (composer) {
		const available = Math.max(1, height - chrome - 1);
		if (available >= 2)
			composerLines.push(
				theme.fg("dim", truncate(`Topic: ${sanitizeDisplayLine(record ? topicLabel(record) : "")}`, inner)),
			);
		if (composer.notice && available >= 3)
			composerLines.push(theme.fg(model.followUpPending ? "dim" : "warning", truncate(composer.notice, inner)));
		composerLines.push(composerLine(theme, composer.draft.text, composer.draft.cursor, inner, caretGlyph));
	}
	let bodyHeight = Math.max(composer ? 0 : 1, height - chrome - composerLines.length);
	const showDetail = wide || model.focus === "answer";
	const saved = model.detailScroll;
	const document = showDetail ? readerLines(cx, model, node, Math.max(1, detailWidth - 1)) : [];
	let detail = showDetail ? readerWindow(theme, model, document, detailWidth, bodyHeight) : undefined;
	const showNavigation = framed && !composer && (model.focus === "list" || model.detailRows - model.detailHeight > 0);
	if (showNavigation) {
		bodyHeight = Math.max(1, bodyHeight - 1);
		if (detail) {
			model.detailScroll = saved;
			detail = readerWindow(theme, model, document, detailWidth, bodyHeight);
		}
	}
	if (detail && model.followLatest) {
		model.detailScroll = Math.max(0, document.length - bodyHeight);
		detail = readerWindow(theme, model, document, detailWidth, bodyHeight);
	}

	const border = (text: string) => theme.fg("border", text);
	const box = theme.symbols.box;
	const frameRow = (line: string) =>
		`${border(box.vertical)} ${padTo(truncate(line, inner, ""), inner)} ${border(box.vertical)}`;
	const splitRow = (left: string, right: string) =>
		`${border(box.vertical)} ${padTo(truncate(left, listWidth, ""), listWidth)} ${border(box.vertical)} ${padTo(truncate(right, detailWidth, ""), detailWidth)} ${border(box.vertical)}`;
	const lines: string[] = [];
	const bodyTop = framed ? 2 : height >= 3 ? 1 : 0;
	const hits: Hit[] = [];
	if (framed) {
		const title = ` BTW history `;
		const fill = Math.max(0, width - 3 - visibleWidth(title));
		lines.push(
			`${border(`${box.topLeft}${box.horizontal}`)}${theme.style("strong", theme.fg("accent", title))}${border(`${box.horizontal.repeat(fill)}${box.topRight}`)}`,
		);
		lines.push(
			wide
				? splitRow(focusLabel(theme, model, "list"), focusLabel(theme, model, "answer"))
				: frameRow(focusLabel(theme, model, model.focus)),
		);
		const list = wide || model.focus === "list" ? listRows(theme, model, listWidth, bodyHeight) : [];
		for (let row = 0; row < bodyHeight; row++) {
			if (wide) lines.push(splitRow(list[row] ?? "", detail?.[row] ?? ""));
			else lines.push(frameRow((model.focus === "list" ? list[row] : detail?.[row]) ?? ""));
		}
		if (wide) {
			hits.push({ row: bodyTop, col: 0, width: listWidth + 3, height: bodyHeight, node, item: "list" });
			hits.push({
				row: bodyTop,
				col: listWidth + 3,
				width: width - listWidth - 3,
				height: bodyHeight,
				node,
				item: "answer",
			});
		} else hits.push({ row: bodyTop, col: 0, width, height: bodyHeight, node, item: model.focus });
	} else {
		if (height >= 3) lines.push(truncate(focusLabel(theme, model, model.focus), width));
		const body = model.focus === "list" ? listRows(theme, model, inner, bodyHeight) : (detail ?? []);
		for (let row = 0; row < bodyHeight; row++) lines.push(body[row] ?? "");
		hits.push({ row: bodyTop, col: 0, width, height: bodyHeight, node, item: model.focus });
	}
	for (const line of composerLines) lines.push(framed ? frameRow(line) : line);
	if (framed) {
		if (showNavigation)
			lines.push(frameRow(keyHint(theme, selectNavGlyphs(), model.focus === "list" ? "select" : "scroll")));
		for (const line of actionLines) lines.push(frameRow(line));
		lines.push(border(`${box.bottomLeft}${box.horizontal.repeat(Math.max(0, width - 2))}${box.bottomRight}`));
	} else if (height >= 3) lines.push(actionLines[0] ?? "");
	return { rows: lines.slice(0, height).map(line => truncate(line, width)), hits };
});

defineRoleWidget("col", "omp.btw.sheet", {
	mouse(node, mouse, _at, _cx, hit) {
		const model = termOf<{ model: BtwHistoryModel }>(node).model;
		if (!model || mouse.action !== "press") return false;
		const delta = mouse.button === "wheel-up" ? -1 : mouse.button === "wheel-down" ? 1 : 0;
		if (delta === 0 || (hit.item !== "list" && hit.item !== "answer")) return false;
		model.wheel(hit.item, delta);
		return true;
	},
});
