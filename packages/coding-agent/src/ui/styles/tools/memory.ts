/**
 * The `memory` look (retain, recall, reflect): `🧠 Recall: query 3 found`
 * (`⏳` while pending, `⚠` without matches), then indented lines: retained
 * memories as bullets (eight while collapsed), recalled and reflected lines
 * muted, clamped while collapsed under `… N more` and an expand hint.
 * Failures are one `✘ Error: message` line.
 */
import type { UiNode } from "@oh-my-pi/pi-tui";
import type { Block, PaintContext } from "@oh-my-pi/pi-tui/term/paint";
import { truncate, visibleWidth, wrap } from "@oh-my-pi/pi-tui/text/width";
import type { MemoryTerm } from "../../tools/memory";
import { expandHint, standaloneError } from "./frame";
import { defineToolLook, toolProps } from "./look";

/** Retained memories listed while collapsed. */
const COLLAPSED_ITEMS = 8;
/** Query characters the head shows. */
const QUERY_CHARS = 80;

function paintMemory(node: UiNode, cx: PaintContext): Block {
	const props = toolProps(node);
	const term = props.term as MemoryTerm | undefined;
	if (!term) return { rows: [] };
	const theme = cx.theme;
	if (term.error !== undefined) return standaloneError(cx, term.error);
	const expanded = props.collapsed === false;
	const glyph = !term.result
		? theme.fg("muted", theme.symbols.symbol("status.pending"))
		: props.tone === "warning"
			? theme.fg("warning", theme.symbols.symbol("status.warning"))
			: theme.fg("accent", theme.symbols.symbol("tool.memory"));
	let head = `${glyph} ${theme.fg("accent", term.title)}`;
	if (term.query) head += `: ${theme.fg("muted", truncate(term.query, QUERY_CHARS))}`;
	if (term.outcome) head += ` ${theme.fg("dim", term.outcome)}`;
	// A pending call wraps its query; a result keeps its head to one row.
	const rows = term.result ? [truncate(head, cx.width, "")] : wrap(head, cx.width);
	const more = (text: string | undefined) =>
		rows.push(truncate(`  ${text ? `${theme.fg("dim", text)} ` : ""}${expandHint(theme)}`, cx.width, ""));
	if (term.items && term.items.length > 0) {
		const items = term.items;
		const shown = expanded ? items : items.slice(0, COLLAPSED_ITEMS);
		const prefix = `  ${theme.fg("muted", theme.symbols.symbol("format.bullet"))} `;
		const contentWidth = Math.max(1, cx.width - visibleWidth(prefix));
		for (const item of shown) rows.push(`${prefix}${theme.fg("muted", truncate(item, contentWidth))}`);
		if (shown.length < items.length) more(`${theme.symbols.ellipsis} ${items.length - shown.length} more`);
	}
	if (term.lines && term.lines.length > 0) {
		const lines = term.lines;
		const limit = expanded ? (term.expandedLines ?? lines.length) : (term.collapsedLines ?? lines.length);
		const shown = lines.slice(0, limit);
		for (const line of shown) rows.push(truncate(`  ${theme.fg("muted", line)}`, cx.width, ""));
		const hidden = lines.length - shown.length;
		if (hidden > 0) {
			const count = shown.length > 0 ? `${theme.symbols.ellipsis} ${hidden} more lines` : undefined;
			if (expanded) rows.push(truncate(`  ${theme.fg("dim", count ?? "")}`, cx.width, ""));
			else more(count);
		}
	}
	return { rows };
}

defineToolLook("memory", { paint: paintMemory, margin: true });
