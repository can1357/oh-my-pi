/**
 * The fullscreen hub frame's terminal look (the /models hub, the agents hub):
 * a rounded frame titled in its top rule, a sidebar of scopes beside a body
 * pane (`│ sidebar │ body │`, a `┬`/`┴` over the split), a divider and one
 * footer row (key hints or a chip strip).
 */
import { padTo, truncate, visibleWidth } from "@oh-my-pi/pi-tui/text/width";
import type { Theme } from "@oh-my-pi/pi-tui/theme/contract";

/** A sidebar entry as the frame measures and draws it. */
export interface HubSidebarEntry {
	readonly id: string;
	/** `separator` draws a rule. */
	readonly kind: string;
	readonly label: string;
	readonly annotation?: string;
}

/** A sidebar entry's decoration. */
export interface HubSidebarStyle {
	/** Styled icon. */
	readonly icon: string;
	/** Styled right-aligned annotation. */
	readonly annotation: string;
	readonly muted?: boolean;
	readonly hovered?: boolean;
}

/** A chip's columns in frame coordinates (the footer row's first content column is 2). */
export interface HubChipRange {
	readonly start: number;
	readonly end: number;
	readonly index: number;
}

/**
 * Sidebar and body widths at a total `width`: the sidebar fits its longest
 * label and annotation within `bounds`; the body keeps `bodyMin` cells
 * before the sidebar shrinks to its minimum.
 */
export function hubGeometry(
	width: number,
	entries: readonly HubSidebarEntry[],
	bounds: { min: number; max: number } = { min: 18, max: 26 },
	bodyMin = 28,
): { sidebar: number; body: number } {
	let longest = 0;
	for (const entry of entries)
		longest = Math.max(longest, visibleWidth(entry.label) + visibleWidth(entry.annotation ?? "") + 5);
	const desired = Math.max(bounds.min, Math.min(bounds.max, longest));
	const available = Math.max(0, width - 7);
	const floor = Math.max(0, Math.min(bodyMin, available - bounds.min));
	const sidebar = Math.max(0, Math.min(available - floor, desired));
	return { sidebar, body: Math.max(0, available - sidebar) };
}

/** Sidebar rows: `❯ icon label   annotation` (active label bold accent; muted dim), separators as rules. */
export function hubSidebarRows<E extends HubSidebarEntry>(
	theme: Theme,
	entries: readonly E[],
	width: number,
	rows: number,
	selection: { readonly activeId: string; readonly focused: boolean; readonly scroll: number },
	style: (entry: E, index: number) => HubSidebarStyle,
): string[] {
	const out: string[] = [];
	for (let i = selection.scroll; i < Math.min(entries.length, selection.scroll + rows); i++) {
		const entry = entries[i]!;
		if (entry.kind === "separator") {
			out.push(theme.style("border", "─".repeat(width)));
			continue;
		}
		const active = entry.id === selection.activeId;
		const cursor = active && selection.focused ? theme.style("accent", theme.symbols.symbol("nav.cursor")) : " ";
		const decoration = style(entry, i);
		const label = decoration.muted
			? theme.style("dim", entry.label)
			: active
				? theme.style("strong accent", entry.label)
				: entry.label;
		const left = `${cursor} ${decoration.icon} ${label}`;
		const leftWidth = visibleWidth(left);
		const annotationWidth = visibleWidth(decoration.annotation);
		const line =
			leftWidth + annotationWidth + 1 <= width
				? `${left}${" ".repeat(width - leftWidth - annotationWidth)}${decoration.annotation}`
				: padTo(truncate(left, width, theme.symbols.ellipsis), width);
		out.push(decoration.hovered ? theme.bg("selectedBg", line) : line);
	}
	while (out.length < rows) out.push("");
	return out;
}

/** The framed hub: title rule, `rows` content rows of sidebar and body, divider, footer, bottom rule. */
export function hubFrameRows(
	theme: Theme,
	width: number,
	title: string,
	sidebarRows: readonly string[],
	bodyRows: readonly string[],
	footer: string,
	sidebarWidth: number,
): string[] {
	const box = theme.symbols.box;
	const border = (text: string): string => theme.style("border", text);
	const divider = sidebarWidth + 3;
	const leftLen = Math.max(0, divider - 1);
	const rightLen = Math.max(0, width - 2 - divider);
	const shown = truncate(` ${title} `, Math.max(0, leftLen - 1), theme.symbols.ellipsis);
	const fill = Math.max(0, leftLen - 1 - visibleWidth(shown));
	const bodyWidth = Math.max(0, width - sidebarWidth - 7);
	const v = border(box.vertical);
	const out = [
		`${border(`${box.topLeft}${box.horizontal}`)}${theme.style("strong accent", shown)}${border(`${box.horizontal.repeat(fill)}${box.teeDown}${box.horizontal.repeat(rightLen)}${box.topRight}`)}`,
	];
	const rows = Math.max(sidebarRows.length, bodyRows.length);
	for (let i = 0; i < rows; i++) {
		const side = padTo(truncate(sidebarRows[i] ?? "", sidebarWidth, theme.symbols.ellipsis), sidebarWidth);
		const body = padTo(truncate(bodyRows[i] ?? "", bodyWidth, theme.symbols.ellipsis), bodyWidth);
		out.push(`${v} ${side} ${v} ${body} ${v}`);
	}
	out.push(
		border(
			`${box.teeRight}${box.horizontal.repeat(leftLen)}${box.teeUp}${box.horizontal.repeat(rightLen)}${box.teeLeft}`,
		),
	);
	const inner = width - 4;
	out.push(`${v} ${inner > 0 ? padTo(truncate(footer, inner, theme.symbols.ellipsis), inner) : ""} ${v}`);
	out.push(border(`${box.bottomLeft}${box.horizontal.repeat(Math.max(0, width - 2))}${box.bottomRight}`));
	return out;
}

/**
 * The first chip a strip draws so the selected chip (and one chip of
 * lookahead when it fits) stays in view; leading chips drop behind `… `.
 * `widths` are each chip's cells (` label `).
 */
export function hubChipWindowStart(widths: readonly number[], selected: number, available: number): number {
	const cell = (i: number): number => (widths[i] ?? 0) + (i === selected ? 2 : 0) + 1;
	const startFor = (target: number): number => {
		let start = 0;
		while (start < target) {
			let sum = start > 0 ? 2 : 0;
			for (let i = start; i <= target; i++) sum += cell(i);
			if (sum <= available) break;
			start++;
		}
		return start;
	};
	let start = startFor(Math.min(selected + 1, widths.length - 1));
	if (start > selected) start = startFor(selected);
	return start;
}

/**
 * A chip strip row: `prefix`, then ` chip ` cells (the selected one in
 * accent brackets on the selection band) from `start`, cut at `width`, and
 * each chip's columns in frame coordinates.
 */
export function hubChipRow(
	theme: Theme,
	width: number,
	prefix: string,
	chips: readonly string[],
	selected: number,
	start: number,
): { row: string; ranges: HubChipRange[] } {
	let line = prefix;
	let col = 2 + visibleWidth(prefix);
	if (start > 0) {
		line += theme.style("dim", "… ");
		col += 2;
	}
	const ranges: HubChipRange[] = [];
	for (let i = start; i < chips.length; i++) {
		const body = ` ${chips[i]} `;
		const isSelected = i === selected;
		const cells = visibleWidth(body) + (isSelected ? 2 : 0);
		ranges.push({ start: col, end: col + cells, index: i });
		line += isSelected
			? theme.bg("selectedBg", `${theme.style("accent", "[")}${body}${theme.style("accent", "]")}`)
			: body;
		line += " ";
		col += cells + 1;
	}
	return { row: truncate(line, width, theme.symbols.ellipsis), ranges };
}
