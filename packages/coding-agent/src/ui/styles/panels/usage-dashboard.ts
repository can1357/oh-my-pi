/**
 * `/usage` in the terminal: a box titled `Usage` (`Usage · Details`) over the
 * report freshness, the scrolled body, a rule and the key hints. The Overview
 * body lays provider cards out in columns (bars inline beside the labels, or
 * stacked under them when the bars would be too short), names untouched
 * providers on one line, then draws the activity calendar to the width;
 * Details shows the classic report. The wheel scrolls two rows a notch.
 */
import { type Block, defineRolePainter, EMPTY_BLOCK } from "@oh-my-pi/pi-tui/term/paint";
import { defineRoleWidget } from "@oh-my-pi/pi-tui/term/widgets";
import { fgSgr } from "@oh-my-pi/pi-tui/theme/color";
import type { Theme } from "@oh-my-pi/pi-tui/theme/contract";
import { sliceCells, truncate, truncateMiddle, visibleWidth, wrap } from "@oh-my-pi/pi-tui/text/width";
import { formatDuration } from "@oh-my-pi/pi-utils";
import { colorLuma, hexToRgb, rgbToHex } from "@oh-my-pi/pi-utils/color";
import { sanitizeDisplayLine } from "../../../extensibility/inventory/display-text";
import {
	activityErrorDetail,
	activityTotals,
	amountText,
	buildCalendar,
	CARD_MAX_WINDOWS,
	cardStatus,
	type LimitStatus,
	type ProviderCard,
	pressureTone,
	type UsageDashboardModel,
} from "../../overlays/panels/usage-dashboard-model";
import { bindingGlyph, boxRows, keyGlyph, selectNavGlyphs, termOf } from "./common";

const CARD_MIN_WIDTH = 32;
const CARD_GUTTER = 3;
const CARD_MIN_BAR_WIDTH = 12;
const CARD_MAX_LABEL_LINES = 2;
const DAY_LABELS = ["M", "T", "W", "T", "F", "S", "S"];
/** `NN%` right-aligned in five cells. */
const PCT_WIDTH = 5;

function statusColor(status: LimitStatus): string {
	return status === "exhausted" ? "error" : status === "warning" ? "warning" : status === "ok" ? "success" : "dim";
}

function statusIcon(theme: Theme, status: LimitStatus): string {
	const symbol =
		status === "exhausted" ? "error" : status === "warning" ? "warning" : status === "ok" ? "success" : "info";
	return theme.fg(statusColor(status), theme.symbols.symbol(`status.${symbol}`));
}

/** Shared geometry of one row of cards: labels, bars and resets line up across them. */
interface RowGeometry {
	readonly labelWidth: number;
	readonly resetWidth: number;
	readonly barWidth: number;
	/** Bars go under their labels. */
	readonly stacked: boolean;
	/** Label lines per window index (the tallest card's). */
	readonly labelHeights: readonly number[];
}

function cardLines(
	theme: Theme,
	card: ProviderCard,
	width: number,
	labels: readonly (readonly string[])[],
	geometry: RowGeometry,
): string[] {
	const content = Math.max(1, width - 2);
	const accounts = card.accounts > 1 ? theme.fg("dim", `${card.accounts} accts`) : "";
	const nameBudget = width - 2 - visibleWidth(accounts) - (accounts ? 1 : 0);
	const name = theme.style("strong", truncate(card.name, Math.max(4, nameBudget)));
	const pad = Math.max(0, width - 2 - visibleWidth(name) - visibleWidth(accounts));
	const lines = [`${statusIcon(theme, cardStatus(card))} ${name}${" ".repeat(pad)}${accounts}`];
	const indented = (color: string, text: string) => `  ${theme.fg(color, truncate(text, width - 2))}`;
	for (const account of card.daybreakAccounts ?? [])
		lines.push(indented("success", `daybreak · ${account.replace(/[\r\n\t]+/g, " ")}`));
	const resets = card.resetCredits;
	if (resets) {
		let text = `✦ ${resets.bankedCount} reset${resets.bankedCount === 1 ? "" : "s"}`;
		if (resets.redeemableCount !== resets.bankedCount) text += ` · ${resets.redeemableCount} usable`;
		if (resets.soonestExpiryMs !== undefined)
			text += resets.soonestExpiryMs > 0 ? ` · expires ${formatDuration(resets.soonestExpiryMs)}` : " · expired";
		lines.push(indented(resets.redeemableCount > 0 ? "success" : "warning", text));
		if (resets.redeemableCount === 0 && resets.unavailableReasons.length > 0) {
			const reason = resets.unavailableReasons.join(" • ").replace(/[\r\n\t]+/g, " ");
			lines.push(indented("dim", `unavailable: ${reason}`));
		}
	}
	for (const account of card.unavailableAccounts) {
		for (const line of wrap(sanitizeDisplayLine(`${account} — usage unavailable`), content))
			lines.push(`  ${theme.fg("dim", line)}`);
	}
	if (card.unlimited) {
		lines.push(`  ${theme.fg("dim", "no limits")}`);
		return lines;
	}
	for (let index = 0; index < Math.min(card.windows.length, CARD_MAX_WINDOWS); index++) {
		const row = card.windows[index]!;
		const labelLines = labels[index]!;
		let prefix = "";
		if (geometry.stacked) {
			for (let line = 0; line < geometry.labelHeights[index]!; line++) lines.push(`  ${labelLines[line] ?? ""}`);
		} else {
			const label = labelLines[0] ?? "";
			prefix = `${label}${" ".repeat(geometry.labelWidth - visibleWidth(label))} `;
		}
		let text: string;
		if (row.fraction === undefined) {
			text = theme.fg(pressureTone(row.status) ?? "dim", amountText(row.amount, row.status, false));
		} else {
			const filled = Math.round(Math.min(Math.max(row.fraction, 0), 1) * geometry.barWidth);
			const bar = `${theme.fg(statusColor(row.status), "█".repeat(filled))}${theme.fg("dim", "░".repeat(geometry.barWidth - filled))}`;
			const pct = theme.fg(
				statusColor(row.status),
				`${Math.max(0, Math.round((1 - row.fraction) * 100))}%`.padStart(PCT_WIDTH),
			);
			const reset = row.resetMs === undefined ? "" : formatDuration(row.resetMs);
			text = `${bar}${pct}${geometry.resetWidth > 0 ? ` ${theme.fg("dim", reset.padStart(geometry.resetWidth))}` : ""}`;
		}
		for (const line of wrap(`${prefix}${text}`, content)) lines.push(`  ${line}`);
	}
	const hidden = card.windows.length - CARD_MAX_WINDOWS;
	if (hidden > 0) lines.push(`  ${theme.fg("dim", `+${hidden} more`)}`);
	return lines;
}

function cardsGrid(theme: Theme, model: UsageDashboardModel, inner: number): string[] {
	if (model.cards.length === 0) return [theme.fg("dim", "No usage data available.")];
	const active = model.cards.filter(card => !card.idle);
	const idle = model.cards.filter(card => card.idle);
	const columns = Math.max(1, Math.floor((inner + CARD_GUTTER) / (CARD_MIN_WIDTH + CARD_GUTTER)));
	const cardWidth = Math.floor((inner - (columns - 1) * CARD_GUTTER) / columns);
	const content = Math.max(1, cardWidth - 2);
	const lines: string[] = [];
	for (let start = 0; start < active.length; start += columns) {
		const cards = active.slice(start, start + columns);
		const windows = cards.map(card => card.windows.slice(0, CARD_MAX_WINDOWS));
		const labels = windows.map(rows =>
			rows.map(row => {
				const label = theme.fg("muted", sanitizeDisplayLine(row.label));
				return row.windowTag ? `${label} ${theme.fg("dim", sanitizeDisplayLine(row.windowTag))}` : label;
			}),
		);
		const labelWidth = Math.max(0, ...labels.flat().map(label => visibleWidth(label)));
		const resetWidth = Math.max(
			0,
			...windows.flat().map(row => (row.resetMs === undefined ? 0 : formatDuration(row.resetMs).length)),
		);
		const suffix = PCT_WIDTH + (resetWidth > 0 ? resetWidth + 1 : 0);
		const inlineBar = content - labelWidth - 1 - suffix;
		const stacked = inlineBar < CARD_MIN_BAR_WIDTH;
		const labelLines = labels.map(rows =>
			rows.map(label => {
				if (!stacked) return [label];
				const bounded = truncateMiddle(label, content * CARD_MAX_LABEL_LINES);
				const wrapped = wrap(bounded, content);
				if (wrapped.length <= CARD_MAX_LABEL_LINES) return wrapped;
				// Word wrap can spill onto a third line even when the label fits two: split by columns instead.
				const head = sliceCells(bounded, 0, content, true);
				const rest = sliceCells(bounded, head.width, visibleWidth(bounded) - head.width, true);
				return [head.text, truncateMiddle(rest.text, content)];
			}),
		);
		const geometry: RowGeometry = {
			labelWidth,
			resetWidth,
			barWidth: Math.max(1, stacked ? content - suffix : inlineBar),
			stacked,
			labelHeights: Array.from({ length: CARD_MAX_WINDOWS }, (_, index) =>
				Math.max(0, ...labelLines.map(rows => rows[index]?.length ?? 0)),
			),
		};
		const drawn = cards.map((card, index) => cardLines(theme, card, cardWidth, labelLines[index]!, geometry));
		const height = Math.max(...drawn.map(card => card.length));
		for (let line = 0; line < height; line++) {
			const segments = drawn.map(card => {
				const text = card[line] ?? "";
				return text + " ".repeat(Math.max(0, cardWidth - visibleWidth(text)));
			});
			lines.push(segments.join(" ".repeat(CARD_GUTTER)).trimEnd());
		}
		if (start + columns < active.length) lines.push("");
	}
	if (idle.length > 0) {
		if (active.length > 0) lines.push("");
		const names = idle.map(card => card.name).join(" · ");
		lines.push(truncate(`${statusIcon(theme, "ok")} ${theme.fg("dim", `untouched: ${names}`)}`, inner));
	}
	return lines;
}

/** Four steps from near the background to the accent (by the text's luma, so light themes ramp the other way). */
function heatRamp(theme: Theme): string[] {
	const darkBackground = (colorLuma(theme.hex("text")) ?? 1) > 0.5;
	const from = darkBackground ? { r: 20, g: 20, b: 24 } : { r: 244, g: 244, b: 246 };
	const to = hexToRgb(theme.hex("accent"));
	return [0.3, 0.5, 0.72, 1].map(t =>
		fgSgr(
			rgbToHex({
				r: Math.round(from.r + (to.r - from.r) * t),
				g: Math.round(from.g + (to.g - from.g) * t),
				b: Math.round(from.b + (to.b - from.b) * t),
			}),
			theme.depth,
		),
	);
}

function calendarLines(theme: Theme, model: UsageDashboardModel, inner: number): string[] {
	if (model.activityError) {
		const detail = activityErrorDetail(model.activityError);
		return [theme.fg("dim", detail ? `Usage history unavailable (${detail}).` : "Usage history unavailable.")];
	}
	const points = model.activity;
	if (!points) return [theme.fg("dim", "Loading usage history…")];
	const labelWidth = 2;
	const weeks = Math.max(4, Math.min(53, Math.floor((inner - labelWidth) / 2)));
	const calendar = buildCalendar(points, weeks, model.now());
	const ramp = heatRamp(theme);
	const state = model.syncing
		? theme.fg("dim", " · syncing…")
		: model.syncError
			? theme.fg("dim", ` · ${model.staleNote()}`)
			: "";
	const lines = [
		`${theme.style("strong", theme.fg("accent", "Activity"))} ${theme.fg("dim", `${activityTotals(calendar)} · last ${weeks} weeks`)}${state}`,
		"",
	];
	let months = " ".repeat(labelWidth);
	for (let week = 0; week < weeks; week++) {
		const label = calendar.monthLabels[week];
		const at = labelWidth + week * 2;
		if (label && at >= visibleWidth(months)) months = months.padEnd(at) + label;
	}
	lines.push(theme.fg("dim", truncate(months, inner)));
	for (let day = 0; day < 7; day++) {
		let line = `${theme.fg("dim", DAY_LABELS[day]!)} `;
		for (let week = 0; week < weeks; week++) {
			const cell = calendar.cells[day]![week];
			if (cell === null) line += "  ";
			else if (cell === 0) line += `${theme.fg("dim", "·")} `;
			else line += `${ramp[cell - 1]}■\x1b[39m `;
		}
		lines.push(line.trimEnd());
	}
	return lines;
}

const DIVIDER = "\u0000";

defineRolePainter("col", "omp.usage.dashboard", (node, cx): Block => {
	const model = termOf<{ model: UsageDashboardModel }>(node).model;
	if (!model || cx.width < 6) return EMPTY_BLOCK;
	const theme = cx.theme;
	const height = Math.max(14, model.options.terminalRows());
	const inner = Math.max(20, cx.width - 4);
	const detail = model.view === "detail";
	const body = detail
		? model.detailLines(inner)
		: [...cardsGrid(theme, model, inner), "", ...calendarLines(theme, model, inner)];
	const bodyRows = Math.max(5, height - 5);
	model.viewportRows = bodyRows;
	const maxScroll = Math.max(0, body.length - bodyRows);
	if (model.scroll > maxScroll) model.scroll = maxScroll;
	const fetchedAt = model.fetchedAt();
	const checked = model.refreshing
		? "refreshing…"
		: fetchedAt
			? `checked ${formatDuration(model.nowMs - fetchedAt)} ago`
			: "";
	const hints = [
		maxScroll > 0 && `${selectNavGlyphs()} scroll`,
		model.options.refresh && "r refresh",
		detail ? `${keyGlyph("tab")} overview` : `${bindingGlyph("tui.select.confirm", "enter")} details`,
		`${bindingGlyph("tui.select.cancel", "escape")} ${detail ? "back" : "close"}`,
	]
		.filter(Boolean)
		.join(" · ");
	const shown = body.slice(model.scroll, model.scroll + bodyRows);
	while (shown.length < bodyRows) shown.push("");
	const content = [checked && theme.fg("dim", checked), ...shown, DIVIDER, theme.fg("dim", hints)];
	const rows = boxRows(
		theme,
		detail ? "Usage · Details" : "Usage",
		content.map(line => truncate(line, cx.width - 4)),
		cx.width,
	);
	const box = theme.symbols.box;
	const at = rows.findIndex(row => row.includes(DIVIDER));
	rows[at] = theme.fg("border", `${box.teeRight}${box.horizontal.repeat(cx.width - 2)}${box.teeLeft}`);
	return { rows, hits: [{ row: 0, col: 0, width: cx.width, height: rows.length, node }] };
});

defineRoleWidget("col", "omp.usage.dashboard", {
	mouse(node, mouse) {
		const model = termOf<{ model: UsageDashboardModel }>(node).model;
		if (!model || mouse.action !== "press") return false;
		if (mouse.button === "wheel-up") model.scrollBy(-2);
		else if (mouse.button === "wheel-down") model.scrollBy(2);
		else return false;
		return true;
	},
});
