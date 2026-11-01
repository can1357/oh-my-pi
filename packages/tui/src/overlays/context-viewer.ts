import type { TspSpan } from "@oh-my-pi/pi-wire";
import { CONTEXT_PRESENTATION } from "../chrome/context-presentation";
import type { ContextViewCategory, ContextViewData, ContextViewEntry } from "../chrome/context-view-model";
import { editorKey } from "../chrome/keybinding-hints";
import { OverlayPanel, PanelDivider, PanelRows } from "../chrome/overlay-box";
import { nativeSlotProps } from "../components/layout/geometry";
import { MenuSelection } from "../components/menu-selection";
import { ScrollView } from "../components/scroll-view";
import {
	matchesSelectCancel,
	matchesSelectDown,
	matchesSelectPageDown,
	matchesSelectPageUp,
	matchesSelectUp,
} from "../keybinding-matchers";
import { getKeybindings } from "../keybindings";
import { col, node, row, span, text } from "../native/describe";
import type {
	DescribeContext,
	NativeNode,
	NativeReveal,
	NativeRevealAt,
	NativeScroll,
	NativeUiEvent,
} from "../native/node";
import { actionBar, actionButton, selectList } from "../native/overlay";
import { styledSpans } from "../native/spans";
import { ensureThemeSync, theme } from "../theme/theme";
import type { Component } from "../tui";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "../utils";
import {
	entryHeaderLine,
	entryHeaderSpans,
	entryMetadata,
	entryPreview,
	groupHeaderLine,
	previewHint,
	previewRows,
	safeContent,
	safeText,
} from "./context-viewer-format";
import {
	allocateUsage,
	buildOverviewRows,
	contextSnapcompactLines,
	contextUsageSummary,
	describeContextMeter,
	legendItem,
	legendLine,
	MAP_LEGEND_GAP,
	type MapGeometry,
	mapGeometry,
	mapRowLine,
	mapRowSpans,
	type OverviewRow,
	overviewLabel,
	planMapRows,
} from "./context-viewer-overview";

type ViewState = "overview" | "category" | "entry";

/** Rows of one entry inside the ANSI category preview. */
interface EntryRange {
	start: number;
	end: number;
	complete: boolean;
}

const NATIVE_ENTRY_GUTTER_COLS = 2;
// Wrapper keys around native entry nodes; entry actions arrive at `<list>/<row>/<column>/<entry id>`.
const NATIVE_ENTRY_KEYS = { list: "entries", row: "content", column: "list" } as const;
const NATIVE_ENTRY_KEYPATH = `${NATIVE_ENTRY_KEYS.list}/${NATIVE_ENTRY_KEYS.row}/${NATIVE_ENTRY_KEYS.column}/`;

/**
 * Read-only context snapshot with three states: Overview → category previews → full entry content.
 * Navigation state is shared; `render` (ANSI) and `describe` (native) each draw every state,
 * via `#render<State>` and `#describe<State>` respectively.
 */
export class ContextViewer implements Component {
	readonly #data: ContextViewData;
	readonly #close: () => void;
	readonly #requestRender: () => void;
	readonly #getRows: () => number;
	/** Attributed usage when it can be drawn against the window (meter and map). */
	readonly #drawableAllocation: ReadonlyMap<ContextViewCategory, number> | undefined;
	readonly #meter: readonly NativeNode[] | undefined;
	/** Dim notes under the legend: the scaling note when rows are attributed, then Snapcompact diagnostics. */
	readonly #overviewNotes: readonly string[];
	readonly #modelLabel: string;

	// Navigation.
	#state: ViewState = "overview";
	readonly #overviewSelection: MenuSelection<OverviewRow>;
	#category: ContextViewCategory | undefined;
	readonly #entrySelection = new MenuSelection<ContextViewEntry>([], {
		getKey: entry => entry.id,
		getSearchText: entry => entry.label,
	});
	#entry: ContextViewEntry | undefined;
	/** Back target of the entry state; single-entry categories open straight from Overview. */
	#entryParent: "overview" | "category" = "overview";
	#disposed = false;

	// Layout shared by both backends.
	#bodyWidth = 0;
	#bodyRows = 1;
	#hour12: boolean | undefined;
	/** Only ANSI input needs local full-content scroll geometry. */
	#lastRenderMode: "ansi" | "native" = "ansi";
	#entryBodyCache: { entry: ContextViewEntry; text: string } | undefined;

	// ANSI backend.
	readonly #panel = new OverlayPanel("Context");
	readonly #header = new PanelRows();
	readonly #body = new PanelRows();
	readonly #footer = new PanelRows();
	readonly #overviewScroll = new ScrollView([], { height: 1 });
	readonly #ansiPreviewScroll = new ScrollView([], { height: 1 });
	readonly #ansiEntryScroll = new ScrollView([], { height: 1 });
	/** Previews of the open category only. */
	#ansiPreviewCache:
		| { category: ContextViewCategory; width: number; height: number; lines: string[]; ranges: EntryRange[] }
		| undefined;
	#ansiEntryLayoutWidth: number | undefined;

	// Native backend.
	#nativeOverlay:
		| { category: ContextViewCategory | undefined; props: NonNullable<Component["nativeOverlay"]> }
		| undefined;
	/** Previews of the open category only. */
	#nativePreviewCache:
		| {
				category: ContextViewCategory;
				width: number;
				height: number;
				previews: Map<ContextViewEntry, { spans: TspSpan[] | undefined; complete: boolean }>;
		  }
		| undefined;
	#nativePreviewRevealAt: NativeRevealAt = "nearest";
	// Native scroll requests, not a viewport offset. The reconciler repeats each
	// line step by the increment in `n`.
	#nativeScroll: NativeScroll = { by: "start", n: 0 };
	/** Native reveal of the legend's first or last row when keyboard navigation hits the list edge. */
	#overviewEdgeReveal: { key: string; reveal: NativeReveal } | undefined;

	constructor(
		data: ContextViewData,
		options: { onClose: () => void; requestRender: () => void; getRows: () => number },
	) {
		ensureThemeSync();
		this.#data = data;
		this.#close = options.onClose;
		this.#requestRender = options.requestRender;
		this.#getRows = options.getRows;
		const { breakdown } = data;
		this.#modelLabel = safeText(breakdown.model?.name ?? breakdown.model?.id ?? "no model");
		const window = breakdown.contextWindow;
		const allocation = allocateUsage(data.categories, breakdown.usedTokens);
		this.#drawableAllocation = window > 0 && Number.isFinite(window) ? allocation : undefined;
		this.#overviewNotes = [
			...(allocation
				? ["Category totals split Used by estimated share; the entries inside may not add up to them."]
				: []),
			...contextSnapcompactLines(breakdown),
		];
		const drawable = this.#drawableAllocation;
		this.#meter = drawable
			? describeContextMeter({
					...breakdown,
					categories: data.categories.map(category => ({
						label: safeText(overviewLabel(category)),
						tokens: drawable.get(category)!,
						color: CONTEXT_PRESENTATION[category.id].color,
					})),
				})
			: undefined;
		this.#overviewSelection = new MenuSelection(buildOverviewRows(data, allocation), {
			getKey: item => item.key,
			getSearchText: item => item.label,
			isDisabled: item => !item.category,
		});
		this.#footer.setHeight(1);
		this.#panel.addChild(this.#header);
		this.#panel.addChild(this.#body);
		this.#panel.addChild(new PanelDivider());
		this.#panel.addChild(this.#footer);
	}

	invalidate(): void {
		this.#ansiPreviewCache = undefined;
		this.#nativePreviewCache = undefined;
		this.#resetEntryLayout();
		this.#panel.invalidate();
	}

	dispose(): void {
		this.#disposed = true;
		this.#nativePreviewCache = undefined;
		this.#resetEntryLayout();
		this.#overviewScroll.dispose();
		this.#ansiPreviewScroll.dispose();
		this.#ansiEntryScroll.dispose();
		this.#panel.dispose();
	}

	get nativeOverlay(): NonNullable<Component["nativeOverlay"]> {
		const category = this.#state === "overview" ? undefined : this.#category;
		if (!this.#nativeOverlay || this.#nativeOverlay.category !== category) {
			this.#nativeOverlay = {
				category,
				props: {
					role: "omp.overlay.report",
					size: "lg",
					anchor: "center",
					head: [
						span("Context", "strong"),
						span(` · ${category ? safeText(category.label) : this.#modelLabel}`, "muted"),
					],
				},
			};
		}
		return this.#nativeOverlay.props;
	}

	// ── Navigation ──────────────────────────────────────────────────────────

	/** Capture only handled navigation keys; the focus path consumes other modal input. */
	capturesInput(data: string): boolean {
		return (
			matchesSelectCancel(data) ||
			matchesSelectUp(data) ||
			matchesSelectDown(data) ||
			(this.#state === "entry" && (matchesSelectPageUp(data) || matchesSelectPageDown(data))) ||
			getKeybindings().matches(data, "tui.select.confirm")
		);
	}

	handleInput(data: string): void {
		if (this.#disposed) return;
		if (matchesSelectCancel(data)) this.#back();
		else if (getKeybindings().matches(data, "tui.select.confirm")) this.#activate();
		else if (matchesSelectUp(data)) this.#navigate(-1);
		else if (matchesSelectDown(data)) this.#navigate(1);
		else if (matchesSelectPageUp(data)) this.#page(-1);
		else if (matchesSelectPageDown(data)) this.#page(1);
		this.#requestRender();
	}

	handleNativeEvent(event: NativeUiEvent): void {
		if (this.#disposed) return;
		if (event.type === "action") {
			if (event.act === "close") this.#close();
			else if (event.act === "back") this.#back();
			else if (this.#state === "category" && (event.act === "select-entry" || event.act === "open-entry")) {
				const id = event.key.startsWith(NATIVE_ENTRY_KEYPATH) ? event.key.slice(NATIVE_ENTRY_KEYPATH.length) : "";
				const entry = this.#entrySelection.items.find(entry => entry.id === id);
				if (!entry) return;
				this.#entrySelection.setSelectedKey(entry.id);
				if (event.act === "open-entry") this.#activate();
			}
		} else if (this.#state === "overview" && (event.type === "select" || event.type === "activate")) {
			const item = this.#overviewSelection.items.find(item => item.key === event.item);
			if (!item?.category) return;
			this.#overviewSelection.setSelectedKey(event.item);
			if (event.type === "activate") this.#activate();
		}
		this.#requestRender();
	}

	#activate(): void {
		if (this.#state === "overview") {
			const activation = this.#overviewSelection.requestActivation();
			if (activation.kind !== "confirmed" || !activation.item.category) return;
			this.#category = activation.item.category;
			this.#entrySelection.setItems(this.#category.entries, this.#category.entries[0]?.id);
			this.#nativePreviewRevealAt = "nearest";
			this.#ansiPreviewCache = undefined;
			this.#ansiPreviewScroll.scrollToTop();
			if (this.#category.entries.length === 1) this.#openEntry(this.#category.entries[0]!, "overview");
			else this.#state = "category";
		} else if (this.#state === "category") {
			const entry = this.#entrySelection.selectedItem;
			if (!entry) return;
			this.#openEntry(entry, "category");
		}
	}

	#openEntry(entry: ContextViewEntry, parent: "overview" | "category"): void {
		this.#entry = entry;
		this.#entryParent = parent;
		this.#resetEntryLayout();
		this.#ansiEntryScroll.scrollToTop();
		this.#state = "entry";
		if (this.#lastRenderMode === "ansi" && this.#bodyWidth > 0) this.#ensureAnsiEntryLayout();
	}

	#back(): void {
		if (this.#state === "entry") {
			this.#state = this.#entryParent;
			if (this.#entryParent === "category") this.#nativePreviewRevealAt = "start";
			this.#entry = undefined;
			this.#resetEntryLayout();
			this.#ansiEntryScroll.setLines([]);
		} else if (this.#state === "category") this.#state = "overview";
		else this.#close();
	}

	#navigate(delta: -1 | 1): void {
		if (this.#state === "entry") {
			if (this.#lastRenderMode === "ansi") {
				if (this.#bodyWidth > 0) this.#ensureAnsiEntryLayout();
				this.#ansiEntryScroll.scroll(delta);
			}
		} else if (this.#state === "overview") {
			// Native reveals the moved selection itself; act only at the list edge, matching ANSI.
			if (this.#overviewSelection.move(delta)) return;
			this.#overviewScroll.scroll(delta);
			// Past the edge selectable row only unselectable rows (Buffer, Free Space) remain: bring the
			// edge row of the legend into view in one press.
			const rows = this.#overviewSelection.items;
			const target = delta > 0 ? rows.at(-1) : rows[0];
			if (target) {
				this.#overviewEdgeReveal = {
					key: target.key,
					reveal: { at: delta > 0 ? "end" : "start", n: (this.#overviewEdgeReveal?.reveal.n ?? 0) + 1 },
				};
			}
			return;
		} else {
			this.#entrySelection.move(delta);
			return;
		}
		this.#nativeScroll = {
			by: delta > 0 ? "line-down" : "line-up",
			n: this.#nativeScroll.n + 1,
		};
	}

	/** Page the full-content view; lists keep single-step selection. */
	#page(direction: -1 | 1): void {
		if (this.#state !== "entry") return;
		if (this.#lastRenderMode === "ansi") {
			if (this.#bodyWidth > 0) this.#ensureAnsiEntryLayout();
			// Keep one line of overlap so the reading position stays visible.
			this.#ansiEntryScroll.scroll(direction * Math.max(1, this.#bodyRows - 1));
		}
		this.#nativeScroll = {
			by: direction > 0 ? "page-down" : "page-up",
			n: this.#nativeScroll.n + 1,
		};
	}

	// ── Shared layout and content ───────────────────────────────────────────

	/** Body height for the current terminal rows; returns the header summary that fits. */
	#layout(): string[] {
		const rows = Math.max(1, this.#getRows());
		const summary = this.#summary().slice(0, Math.max(0, rows - 5));
		this.#bodyRows = Math.max(0, rows - summary.length - 4);
		return summary;
	}

	#summary(): string[] {
		if (this.#state !== "overview") return [];
		const labels = contextUsageSummary(this.#data.breakdown);
		return [`Used ${labels.used}${labels.detail}`, labels.room];
	}

	/** Both backends wrap previews to `width` with the same row and source bounds. */
	#preview(entry: ContextViewEntry, width: number): { lines: string[]; complete: boolean } {
		return entryPreview(entry, {
			width,
			rows: previewRows(entry, this.#bodyRows),
			sourceWidth: this.#bodyWidth,
			hour12: this.#hour12,
		});
	}

	#entryBodyText(): string {
		const entry = this.#entry!;
		if (this.#entryBodyCache?.entry !== entry) {
			this.#entryBodyCache = { entry, text: safeContent(entry.text.trimEnd()) };
			this.#ansiEntryLayoutWidth = undefined;
		}
		return this.#entryBodyCache.text;
	}

	#resetEntryLayout(): void {
		this.#entryBodyCache = undefined;
		this.#ansiEntryLayoutWidth = undefined;
	}

	// ── ANSI backend ────────────────────────────────────────────────────────

	render(width: number): readonly string[] {
		this.#lastRenderMode = "ansi";
		this.#bodyWidth = Math.max(1, width - 4);
		const terminalRows = Math.max(1, this.#getRows());
		const summary = this.#layout();
		this.#panel.title =
			this.#state === "overview" ? `Context · ${this.#modelLabel}` : safeText(this.#category!.label);
		this.#header.setHeight(summary.length);
		this.#header.setLines(summary.map(line => truncateToWidth(theme.fg("dim", line), this.#bodyWidth)));
		this.#body.setLines(
			this.#state === "overview"
				? this.#renderOverview()
				: this.#state === "category"
					? this.#renderCategory()
					: this.#renderEntry(),
		);
		this.#body.setHeight(this.#bodyRows);
		this.#footer.setLines([truncateToWidth(theme.fg("dim", this.#footerHints()), this.#bodyWidth)]);
		const rendered = this.#panel.render(width);
		// Short terminals keep the top border, footer, and bottom border, in that priority.
		if (terminalRows >= 4) return rendered;
		if (terminalRows === 3) return [rendered[0]!, rendered[rendered.length - 2]!, rendered[rendered.length - 1]!];
		return terminalRows === 2 ? [rendered[0]!, rendered[rendered.length - 1]!] : [rendered[rendered.length - 1]!];
	}

	#footerHints(): string {
		const navigation = [editorKey("tui.select.up"), editorKey("tui.select.down")].filter(Boolean).join("/");
		const canOpen =
			this.#state === "overview"
				? !!this.#overviewSelection.selectedItem?.category
				: this.#state === "category" && !!this.#entrySelection.selectedItem;
		const confirm = canOpen ? editorKey("tui.select.confirm") : "";
		const cancel = editorKey("tui.select.cancel");
		const movement = this.#state === "overview" ? "select/scroll" : this.#state === "category" ? "select" : "scroll";
		const paging =
			this.#state === "entry"
				? [editorKey("tui.select.pageUp"), editorKey("tui.select.pageDown")].filter(Boolean).join("/")
				: "";
		return [
			navigation && `${navigation} ${movement}`,
			paging && `${paging} page`,
			confirm && `${confirm} open`,
			cancel && `${cancel} ${this.#state === "overview" ? "close" : "back"}`,
		]
			.filter(Boolean)
			.join(" · ");
	}

	/** Map on the left when it fits; scrollable legend and Snapcompact diagnostics on the right. */
	#renderOverview(): string[] {
		const width = this.#bodyWidth;
		const height = this.#bodyRows;
		const allocation = this.#drawableAllocation;
		const map = allocation ? mapGeometry(width, height) : undefined;
		const listWidth = map ? width - map.width - MAP_LEGEND_GAP : width;
		const legendLines = this.#overviewSelection.items.map(item =>
			legendLine(item, this.#overviewSelection.selectedKey === item.key, Math.max(0, listWidth - 1)),
		);
		for (const line of this.#overviewNotes)
			legendLines.push(...wrapTextWithAnsi(theme.fg("dim", line), Math.max(1, listWidth - 1)));
		this.#overviewScroll.setHeight(height);
		this.#overviewScroll.setLines(legendLines);
		this.#overviewScroll.revealRange(
			{
				id: this.#overviewSelection.selectedKey ?? "",
				start: this.#overviewSelection.selectedIndex,
				end: this.#overviewSelection.selectedIndex + 1,
				margin: 0,
			},
			listWidth,
		);
		const legend = this.#overviewScroll.render(listWidth);
		if (!allocation || !map) return [...legend];
		const mapRows = planMapRows(this.#data, allocation, map);
		const lines: string[] = [];
		for (let index = 0; index < height; index++) {
			const cells = mapRows[index];
			const grid = cells ? mapRowLine(cells, map) : "";
			const padding = " ".repeat(Math.max(0, map.width - visibleWidth(grid)) + MAP_LEGEND_GAP);
			lines.push(`${grid}${padding}${legend[index] ?? ""}`);
		}
		return lines;
	}

	/** Entry previews with the selected one marked by a gutter bar. */
	#renderCategory(): string[] {
		const contentWidth = Math.max(1, this.#bodyWidth - 2);
		this.#prepareAnsiPreview(contentWidth, this.#bodyRows);
		const range = this.#ansiPreviewCache!.ranges[this.#entrySelection.selectedIndex];
		if (range)
			this.#ansiPreviewScroll.revealRange(
				{
					id: this.#entrySelection.selectedKey!,
					start: range.start,
					end: range.end,
					margin: 0,
					oversized: "start",
				},
				contentWidth,
			);
		const offset = this.#ansiPreviewScroll.getScrollOffset();
		return this.#ansiPreviewScroll.render(contentWidth).map((line, index) => {
			const selected = range && offset + index >= range.start && offset + index < range.end;
			if (selected && !range.complete && offset + index === range.end - 1)
				line = truncateToWidth(previewHint(true), contentWidth - 1);
			return `${selected ? theme.fg("accent", "┃ ") : "  "}${line}`;
		});
	}

	#prepareAnsiPreview(width: number, height: number): void {
		const category = this.#category!;
		const cached = this.#ansiPreviewCache;
		this.#ansiPreviewScroll.setHeight(height);
		if (cached?.category === category && cached.width === width && cached.height === height) return;
		const lines: string[] = [];
		const ranges: EntryRange[] = [];
		const groups = new Set<string>();
		for (const entry of category.entries) {
			const start = lines.length;
			const group = entry.thinkingGroup;
			const indent = group ? "  " : "";
			if (group && !groups.has(group.id)) {
				groups.add(group.id);
				lines.push(truncateToWidth(groupHeaderLine(group, category.id), Math.max(1, width - 1)));
			}
			const entryWidth = Math.max(1, width - 1 - indent.length);
			lines.push(`${indent}${truncateToWidth(entryHeaderLine(entry, category.id), entryWidth)}`);
			const content = this.#preview(entry, entryWidth);
			lines.push(...content.lines.map(line => `${indent}${line}`));
			if (!content.complete) lines.push(previewHint(false));
			ranges.push({ start, end: lines.length, complete: content.complete });
			lines.push("");
		}
		this.#ansiPreviewCache = { category, width, height, lines, ranges };
		this.#ansiPreviewScroll.setLines(lines);
	}

	#renderEntry(): string[] {
		this.#ensureAnsiEntryLayout();
		return [...this.#ansiEntryScroll.render(this.#bodyWidth)];
	}

	#ensureAnsiEntryLayout(): void {
		const width = this.#bodyWidth;
		const content = this.#entryBodyText();
		this.#ansiEntryScroll.setHeight(this.#bodyRows);
		if (this.#ansiEntryLayoutWidth !== width) {
			const entry = this.#entry!;
			const contentWidth = Math.max(1, width - 1);
			const lines = [
				truncateToWidth(entryHeaderLine(entry, this.#category!.id), contentWidth),
				...entryMetadata(entry, { hour12: this.#hour12, withGroup: true }).flatMap(line =>
					wrapTextWithAnsi(theme.fg("dim", line), contentWidth),
				),
				...content.split("\n").flatMap(line => (line ? wrapTextWithAnsi(line, contentWidth) : [""])),
			];
			this.#ansiEntryLayoutWidth = width;
			this.#ansiEntryScroll.setLines(lines);
		}
	}

	// ── Native backend ──────────────────────────────────────────────────────

	describe(cx: DescribeContext): NativeNode {
		this.#lastRenderMode = "native";
		this.#bodyWidth = Math.max(1, cx.cols - 4);
		if (this.#hour12 !== cx.hour12) {
			this.#hour12 = cx.hour12;
			this.invalidate();
		}
		this.#layout();
		const children =
			this.#state === "overview"
				? this.#describeOverview(cx)
				: this.#state === "category"
					? [this.#describeCategory()]
					: this.#describeEntry();
		children.push(
			actionBar([
				null,
				...(this.#state !== "overview" ? [actionButton("Back", "back")] : []),
				actionButton("Close", "close"),
			]),
		);
		return col(children, {
			role: "omp.context",
			// Overview and category lists own their scrollers, so the pinned actions never cover a revealed row.
			...(this.#state !== "entry" ? { grow: 1, min: { h: 0 } } : {}),
		});
	}

	/** Meter (or summary text) above a scrollable legend, with the map beside it when there is no meter. */
	#describeOverview(cx: DescribeContext): NativeNode[] {
		const meter = cx.supports("meter") ? this.#meter : undefined;
		const items = this.#overviewSelection.items.map(item => {
			const legend = legendItem(
				item,
				this.#overviewSelection.selectedKey === item.key,
				!!meter,
				this.#data.breakdown.contextWindow,
			);
			const edge = this.#overviewEdgeReveal;
			return edge?.key === item.key ? { ...legend, reveal: edge.reveal } : legend;
		});
		const list = selectList("categories", items, {
			selected: this.#overviewSelection.selectedKey,
			grow: 1,
			min: { h: 0 },
			max: { lines: Math.max(1, this.#bodyRows) },
		});
		// The map stands in for the meter on terminals without one.
		const mapAllocation = meter ? undefined : this.#drawableAllocation;
		const map = mapAllocation ? mapGeometry(this.#bodyWidth, this.#bodyRows) : undefined;
		const body: NativeNode[] = [
			mapAllocation && map ? row([this.#describeMap(mapAllocation, map), list], { gap: "lg" }) : list,
			...this.#overviewNotes.map(line => text([span(line, "dim")], { wrap: "word" })),
		];
		const head = meter ?? this.#summary().map(line => text([span(line, "dim")], { wrap: "word" }));
		return [...head, node("col", { grow: 1, min: { h: 0 } }, body, "overview")];
	}

	#describeMap(allocation: ReadonlyMap<ContextViewCategory, number>, map: MapGeometry): NativeNode {
		return col(
			planMapRows(this.#data, allocation, map).map(cells => text(mapRowSpans(cells, map), { wrap: "none" })),
		);
	}

	/** Entry previews in a viewport-bounded list; the list owns wheel scrolling. */
	#describeCategory(): NativeNode {
		const groups = new Set<string>();
		const items = this.#entrySelection.items.flatMap((entry, index) => [
			this.#describePreview(entry, groups),
			{ ...text(" ", { wrap: "none" }), key: `separator-${index}` },
		]);
		// list.max owns a wheel scroller; common max.h would only clip.
		return node(
			"list",
			{
				grow: 1,
				min: { h: 0 },
				max: { lines: Math.max(1, this.#bodyRows) },
				hidden: this.#bodyRows === 0 ? true : undefined,
			},
			[
				node(
					"row",
					{ gap: "none", align: "start" },
					[
						// Native pick bars paint outside entry boxes, but must stay inside the viewport.
						node("spacer", nativeSlotProps("w", { fixed: NATIVE_ENTRY_GUTTER_COLS }), undefined, "gutter"),
						node("col", { grow: 1, min: { w: 0 }, gap: "none" }, items, NATIVE_ENTRY_KEYS.column),
					],
					NATIVE_ENTRY_KEYS.row,
				),
			],
			NATIVE_ENTRY_KEYS.list,
		);
	}

	/** One entry: group heading on its first member, entry heading, preview, and truncation hint. */
	#describePreview(entry: ContextViewEntry, groups: Set<string>): NativeNode {
		const category = this.#category!.id;
		const selected = entry.id === this.#entrySelection.selectedKey;
		const group = entry.thinkingGroup;
		const parts: NativeNode[] = [];
		if (group && !groups.has(group.id)) {
			groups.add(group.id);
			parts.push({
				...text(styledSpans(groupHeaderLine(group, category)), { wrap: "word", lines: 1 }),
				key: "group",
			});
		}
		const header = entryHeaderSpans(entry, category);
		parts.push({
			...text(group ? [span("  "), ...header] : header, { wrap: "word", lines: 1 }),
			key: "head",
			...(selected ? { reveal: this.#nativePreviewRevealAt } : {}),
		});
		const content = this.#nativePreview(entry);
		if (content.spans) parts.push({ ...text(content.spans, { wrap: "word" }), key: "preview" });
		if (!content.complete)
			parts.push({
				...text(styledSpans(previewHint(selected)), { wrap: "word", lines: 1 }),
				key: "hint",
			});
		return {
			...node(
				"col",
				{
					gap: "none",
					mark: selected ? "pick" : undefined,
					actions: { click: "select-entry", dblclick: "open-entry" },
				},
				parts,
				entry.id,
			),
			...(selected ? { reveal: { at: "nearest" as const, n: 0 } } : {}),
		};
	}

	#nativePreview(entry: ContextViewEntry): { spans: TspSpan[] | undefined; complete: boolean } {
		const category = this.#category!;
		let cache = this.#nativePreviewCache;
		if (cache?.category !== category || cache.width !== this.#bodyWidth || cache.height !== this.#bodyRows) {
			cache = { category, width: this.#bodyWidth, height: this.#bodyRows, previews: new Map() };
			this.#nativePreviewCache = cache;
		}
		let preview = cache.previews.get(entry);
		if (!preview) {
			const indent = entry.thinkingGroup ? 2 : 0;
			const content = this.#preview(entry, Math.max(1, this.#bodyWidth - 1 - NATIVE_ENTRY_GUTTER_COLS - indent));
			// Tern owns final wrapping; only omitted source creates a more row.
			const spans = content.lines.length ? styledSpans(content.lines.join("\n")) : undefined;
			preview = { spans, complete: content.complete };
			cache.previews.set(entry, preview);
		}
		return preview;
	}

	/** Entry heading above scrollable metadata and full content. */
	#describeEntry(): NativeNode[] {
		const entry = this.#entry!;
		const body = node(
			"col",
			{},
			[
				...entryMetadata(entry, { hour12: this.#hour12, withGroup: true }).map(line => text([span(line, "dim")])),
				text(styledSpans(this.#entryBodyText()), { wrap: "word" }),
			],
			`entry-${entry.id}`,
		);
		return [text(entryHeaderSpans(entry, this.#category!.id)), { ...body, scroll: this.#nativeScroll }];
	}
}
