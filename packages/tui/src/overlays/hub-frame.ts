import { bottomBorder, dividerSplit, PanelRows, row, topBorderSplit } from "../chrome/overlay-box";
import { SplitPane } from "../components/layout/split-pane";
import { Stack } from "../components/layout/stack";
import { matchesKey } from "../keys";
import { theme } from "../theme/theme";
import { truncateToWidth, visibleWidth } from "../utils";

/** A scope row shared by fullscreen hubs, with hub-specific kinds and metadata. */
export interface SidebarEntry<TKind extends string> {
	id: string;
	kind: TKind;
	label: string;
	annotation?: string;
}

/** A pre-styled footer choice carrying a hub-specific action. */
export interface StripChip<TAction> {
	label: string;
	styled: string;
	action: TAction;
}

/** Shared selection state for a hub's chip-bearing strip variants. */
export interface StripState<TChip extends StripChip<unknown>> {
	chips: TChip[];
	index: number;
}

/** A chip hit range in frame-relative columns. */
export interface ChipRange {
	start: number;
	end: number;
	index: number;
}

/** Hub-specific sidebar decoration, independent of viewport and row layout. */
export interface SidebarStyle {
	icon: string;
	annotation: string;
	muted?: boolean;
	hovered?: boolean;
	padTruncated?: boolean;
}

/** Cycle a strip's selection for directional and tab input, returning whether it handled the key. */
export function moveStripSelection(strip: StripState<StripChip<unknown>>, data: string): boolean {
	if (matchesKey(data, "left") || matchesKey(data, "up") || matchesKey(data, "shift+tab")) {
		strip.index = (strip.index - 1 + strip.chips.length) % strip.chips.length;
		return true;
	}
	if (matchesKey(data, "right") || matchesKey(data, "down") || matchesKey(data, "tab")) {
		strip.index = (strip.index + 1) % strip.chips.length;
		return true;
	}
	return false;
}

/** Persistent fullscreen split frame, sidebar viewport, and footer chip renderer. */
export class HubFrame {
	/** Current sidebar viewport offset, shared with the hub's navigation. */
	sidebarScroll = 0;
	/** Chip hit ranges from the last footer render. */
	chipRanges: ChipRange[] = [];
	readonly #split: SplitPane;
	readonly #top = new PanelRows();
	readonly #divider = new PanelRows();
	readonly #footer = new PanelRows();
	readonly #bottom = new PanelRows();
	readonly #stack: Stack;
	readonly #title: string;
	readonly #sidebarBounds: { min: number; max: number };

	/** Compose hub-specific sidebar and body renderers into a persistent frame. */
	constructor(
		title: string,
		sidebarBounds: { min: number; max: number },
		renderSidebar: (width: number, rows: number) => string[],
		renderBody: (width: number, height: number | undefined) => readonly string[],
	) {
		this.#title = title;
		this.#sidebarBounds = sidebarBounds;
		this.#split = new SplitPane({
			left: (width, height) => {
				const rows = Math.max(0, Math.floor(height ?? 10));
				const lines = renderSidebar(width, rows);
				while (lines.length < rows) lines.push("");
				return lines.slice(0, rows);
			},
			right: renderBody,
			prefix: () => `${theme.fg("border", theme.boxRound.vertical)} `,
			divider: () => ` ${theme.fg("border", theme.boxRound.vertical)} `,
			suffix: () => ` ${theme.fg("border", theme.boxRound.vertical)}`,
		});
		this.#stack = new Stack({
			children: [
				{ content: this.#top, height: 1 },
				{ content: this.#split, grow: 1 },
				{ content: this.#divider, height: 1 },
				{ content: this.#footer, height: 1 },
				{ content: this.#bottom, height: 1 },
			],
		});
	}

	/** Invalidate the composed layout. */
	invalidate(): void {
		this.#stack.invalidate();
	}

	/** Measure the title, labels, and annotations within this hub's sidebar width bounds. */
	sidebarWidth(entries: readonly SidebarEntry<string>[]): number {
		// The top border paints ` title ` over the sidebar column, one column in.
		let longest = visibleWidth(this.#title) + 1;
		for (const entry of entries) {
			longest = Math.max(longest, visibleWidth(entry.label) + visibleWidth(entry.annotation ?? "") + 5);
		}
		return Math.max(this.#sidebarBounds.min, Math.min(this.#sidebarBounds.max, longest));
	}

	/** Pan the sidebar within the current viewport's bounds. */
	scrollSidebar(delta: number, rows: number, entryCount: number): void {
		const maxScroll = Math.max(0, entryCount - rows);
		this.sidebarScroll = Math.max(0, Math.min(this.sidebarScroll + delta, maxScroll));
	}

	/** Select a footer chip at a frame-relative column, if one was painted there. */
	selectChipAt(strip: StripState<StripChip<unknown>>, col: number): boolean {
		for (const range of this.chipRanges) {
			if (col >= range.start && col < range.end) {
				strip.index = range.index;
				return true;
			}
		}
		return false;
	}

	/** Render the sidebar viewport while retaining each hub's follow and clipping policy. */
	renderSidebar<TEntry extends SidebarEntry<string>>(
		entries: readonly TEntry[],
		width: number,
		rows: number,
		selection: { id: string; focused: boolean; follow: boolean; clamp: boolean },
		style: (entry: TEntry, index: number) => SidebarStyle,
	): string[] {
		if (selection.follow) {
			const activeIndex = Math.max(
				0,
				entries.findIndex(entry => entry.id === selection.id),
			);
			if (activeIndex < this.sidebarScroll) this.sidebarScroll = activeIndex;
			else if (activeIndex >= this.sidebarScroll + rows) this.sidebarScroll = activeIndex - rows + 1;
		}
		if (selection.clamp) {
			this.sidebarScroll = Math.max(0, Math.min(this.sidebarScroll, Math.max(0, entries.length - rows)));
		}
		const lines: string[] = [];
		for (let i = this.sidebarScroll; i < Math.min(entries.length, this.sidebarScroll + rows); i++) {
			const entry = entries[i];
			if (!entry) continue;
			if (entry.kind === "separator") {
				lines.push(theme.fg("border", "─".repeat(width)));
				continue;
			}
			const active = entry.id === selection.id;
			const cursor = active && selection.focused ? theme.fg("accent", theme.nav.cursor) : " ";
			const decoration = style(entry, i);
			const label = decoration.muted
				? theme.fg("dim", entry.label)
				: active
					? theme.bold(theme.fg("accent", entry.label))
					: entry.label;
			const left = `${cursor} ${decoration.icon} ${label}`;
			const leftWidth = visibleWidth(left);
			const annWidth = visibleWidth(decoration.annotation);
			let line: string;
			if (leftWidth + annWidth + 1 <= width) {
				line = `${left}${" ".repeat(width - leftWidth - annWidth)}${decoration.annotation}`;
			} else {
				line = truncateToWidth(left, width);
				if (decoration.padTruncated) {
					const lineWidth = visibleWidth(line);
					if (lineWidth < width) line += " ".repeat(width - lineWidth);
				}
			}
			if (decoration.hovered) line = theme.bg("selectedBg", line);
			lines.push(line);
		}
		return lines;
	}

	/** Render footer hints or a hub-specific strip, resetting stale mouse ranges. */
	renderFooter(width: number, hint: string, renderStrip?: () => string): string {
		this.chipRanges = [];
		return renderStrip ? renderStrip() : truncateToWidth(theme.fg("dim", hint), width);
	}

	/** Render footer chips from a hub-selected horizontal window and record their hit ranges. */
	renderChips(width: number, prefix: string, strip: StripState<StripChip<unknown>>, start = 0): string {
		let line = prefix;
		let col = 2 + visibleWidth(prefix);
		if (start > 0) {
			line += theme.fg("dim", "… ");
			col += 2;
		}
		for (let i = start; i < strip.chips.length; i++) {
			const chip = strip.chips[i];
			if (!chip) continue;
			const selected = i === strip.index;
			const body = ` ${chip.styled} `;
			const rendered = selected
				? theme.bg("selectedBg", `${theme.fg("accent", "[")}${body}${theme.fg("accent", "]")}`)
				: body;
			const w = visibleWidth(body) + (selected ? 2 : 0);
			this.chipRanges.push({ start: col, end: col + w, index: i });
			line += rendered;
			col += w;
			line += " ";
			col += 1;
		}
		return truncateToWidth(line, width);
	}

	/** Translate a mouse position into footer, sidebar, and body coordinates. */
	locate(row: number, col: number) {
		const hit = this.#stack.locate(row, col);
		const bodyHeight = this.#stack.childRect(1)?.height ?? 0;
		let contentLine = -1;
		let overSidebar = false;
		let overBody = false;
		if (hit && hit.index === 1) {
			const pane = this.#split.locate(hit.line, hit.col);
			if (pane?.pane === "left") {
				overSidebar = true;
				contentLine = pane.line;
			} else if (pane?.pane === "right") {
				overBody = true;
				contentLine = pane.line;
			}
		}
		const overContent = contentLine >= 0 && contentLine < bodyHeight;
		return {
			footerColumn: hit?.index === 3 ? hit.col : undefined,
			bodyHeight,
			contentLine,
			overSidebar: overSidebar && overContent,
			overBody: overBody && overContent,
			bodyLine: contentLine - 1,
		};
	}

	/** Paint a complete fullscreen hub with its title, width bounds, and contextual footer. */
	render(width: number, height: number, entries: readonly SidebarEntry<string>[], footer: string): readonly string[] {
		const contentRows = Math.max(10, height - 4);
		this.#split.setLeftSize({ fixed: this.sidebarWidth(entries) });
		const leftWidth = this.#split.measure(width).left?.width ?? 0;
		this.#top.setLines([topBorderSplit(width, this.#title, leftWidth)]);
		this.#divider.setLines([dividerSplit(width, leftWidth)]);
		this.#footer.setLines([row(footer, width)]);
		this.#bottom.setLines([bottomBorder(width)]);
		this.#stack.setHeight(contentRows + 4);
		return this.#stack.render(width);
	}
}
