/**
 * `picker`: a data-first sheet (models, sessions, accounts, …).
 *
 * The default look is a rounded sheet: the title in the top border, an
 * optional search row, the list (pointer `❯` on the selected row, a detail
 * column, a scrollbar when it overflows), the selected item's preview (the
 * picker's children), notes, and a key-hint row built from `actions`.
 * Terminal-only look facts come through the `term` prop ({@link PickerTerm}):
 * the frame title, per-item row text, the hint copy, notes under the list.
 *
 * Screen looks register role painters (`defineRolePainter("picker", role, …)`)
 * and compose the pieces exported here: entries/navigation order
 * ({@link pickerEntries}, {@link pickerNavIds}), the scroll window
 * ({@link pickerWindow}, {@link scrollWindow}, {@link scrollbar}), frame rows ({@link boxTop},
 * {@link boxRow}, {@link boxRule}, {@link boxBottom}), list rows
 * ({@link selectRow}, {@link inlineRow}), the search row ({@link queryRow})
 * and the hint bar ({@link actionHintFor}, {@link keyCapsFor}). The `picker`
 * widget (`../widgets/picker`) navigates through {@link pickerNavIds} and
 * {@link pickerPage}, so it works whichever painter draws the node.
 * Custom looks can use {@link actionHint} and {@link keyCaps} for legacy Unicode hints.
 */
import type {
	TspPickerAction,
	TspPickerGroup,
	TspPickerItem,
	TspPickerProps,
	TspSpan,
	TspText,
} from "@oh-my-pi/pi-wire";
import { flattenLine } from "../../text/sanitize";
import type { UiNode } from "../../node";
import { type Signal, signal } from "../../reactive";
import type { Theme } from "../../theme/contract";
import { formatKeyCaps, keyHintPlatform } from "../../theme/keys";
import { padTo, spaces, truncate, visibleWidth, wrap } from "../../text/width";
import { type Block, definePainter, EMPTY_BLOCK, type Hit, type PaintContext, type Painter } from "../paint";
import { widgetState } from "../widgets";
import { stack, styledText } from "./layout";

// ─── Term facts ─────────────────────────────────────────────────────────────

/** How a list row lays out its item when `term.rows` does not give its text. */
export type PickerRowLayout = "column" | "inline";

/** Terminal-only look facts of a picker (the `term` prop; a type alias so it fits the prop's record type). */
export type PickerTerm = {
	/**
	 * A screen look registered with {@link definePickerLook} that draws the
	 * picker instead of the default sheet. (A `role` would do the same, but a
	 * picker's role is also sent natively, where hosts use it for themselves.)
	 */
	readonly look?: string;
	/** Frame title (default: the `title` prop). `null`: no title in the border. */
	readonly title?: string | null;
	/** Rows above the list, inside the frame (a subtitle, a search hint). */
	readonly head?: readonly TspText[];
	/** Show the search row (`> query`) when `query` is a string. Default true. */
	readonly search?: boolean;
	/** Per item id: the row text drawn after the pointer (spans keep their styles; unstyled text takes the selection color). */
	readonly rows?: Readonly<Record<string, TspText>>;
	/** Per item id: the label and detail a `"column"` row draws instead of the item's. */
	readonly labels?: Readonly<Record<string, { readonly label: string; readonly detail?: string }>>;
	/** Label/detail layout of rows without `rows` text. Default `"column"`. */
	readonly layout?: PickerRowLayout;
	/** Width of the label column in `"column"` layout. Default 32. */
	readonly labelWidth?: number;
	/** Visible list rows before the list scrolls; also the widget's page size. Default 10. */
	readonly maxRows?: number;
	/** Up from the first row goes to the last (and down from the last to the first). Default true. */
	readonly wrap?: boolean;
	/** Text when the list is empty (default: `empty`, else "No items"; a string is indented under the labels, spans are drawn as given). */
	readonly empty?: TspText;
	/** The key-hint row under the list (a string is muted); `null` hides it. Default: built from `actions`. */
	readonly hint?: TspText | null;
	/** Wrap the hint instead of cutting it. */
	readonly hintWrap?: boolean;
	/** Paragraphs under the hint, wrapped; `""` is a blank row. */
	readonly notes?: readonly TspText[];
};

/** The picker's `term` facts (empty when absent). */
export function pickerTerm(node: UiNode): PickerTerm {
	return ((node.props() as { term?: PickerTerm }).term ?? {}) as PickerTerm;
}

// ─── Entries and navigation ─────────────────────────────────────────────────

/** The catalogue after `itemsAdd`/`itemsDel` patches, by id. */
export function pickerItems(props: TspPickerProps): Map<string, TspPickerItem> {
	const items = new Map<string, TspPickerItem>();
	for (const item of props.items ?? []) items.set(item.id, item);
	for (const item of props.itemsAdd ?? []) items.set(item.id, item);
	for (const id of props.itemsDel ?? []) items.delete(id);
	return items;
}

/** One drawn list entry: an item or a group header. */
export type PickerEntry =
	| { readonly kind: "item"; readonly item: TspPickerItem }
	| { readonly kind: "group"; readonly group: TspPickerGroup };

/** What the list shows, in order: `order` (items and group headers) or the catalogue order. */
export function pickerEntries(props: TspPickerProps): PickerEntry[] {
	const items = pickerItems(props);
	if (!props.order) return [...items.values()].map(item => ({ kind: "item", item }));
	const out: PickerEntry[] = [];
	for (const entry of props.order) {
		if (typeof entry === "string") {
			const item = items.get(entry);
			if (item) out.push({ kind: "item", item });
		} else out.push({ kind: "group", group: entry });
	}
	return out;
}

/** Item ids the keyboard moves through, in list order (disabled items included unless `skipDisabled`). */
export function pickerNavIds(props: TspPickerProps, options?: { skipDisabled?: boolean }): string[] {
	const ids: string[] = [];
	for (const entry of pickerEntries(props)) {
		if (entry.kind !== "item") continue;
		if (options?.skipDisabled && entry.item.disabled) continue;
		ids.push(entry.item.id);
	}
	return ids;
}

/** Default visible list rows. */
export const PICKER_MAX_ROWS = 10;

/** The list's page size (visible rows) of a picker node. */
export function pickerPage(node: UiNode): number {
	return Math.max(1, pickerTerm(node).maxRows ?? PICKER_MAX_ROWS);
}

/**
 * A per-node terminal state signal shared by the `picker` widget and looks
 * (the hovered row): created on first use, so a painter reading it repaints
 * when the widget sets it.
 */
export function pickerState<T>(node: UiNode, name: string, init: () => T): Signal<T> {
	const map = widgetState(node);
	let value = map.get(name) as Signal<T> | undefined;
	if (!value) {
		value = signal(init());
		map.set(name, value as Signal<unknown>);
	}
	return value;
}

/** The item id under the pointer (set by the widget on pointer motion). */
export const PICKER_HOVER = "hover";

// ─── Scrolling ──────────────────────────────────────────────────────────────

/**
 * The visible slice `[start, end)` of `total` rows showing `index`. Without
 * `from` (a list opening) the window centres `index`; with the first row of
 * the window drawn last it scrolls at the edge: the window stays put while
 * `index` is inside it and moves just far enough to reach it otherwise.
 */
export function scrollWindow(
	total: number,
	index: number,
	visible: number,
	from?: number,
): { start: number; end: number } {
	if (total <= visible) return { start: 0, end: total };
	const at = Math.max(0, Math.min(index, total - 1));
	const last = total - visible;
	let start: number;
	if (from === undefined) start = at - Math.floor(visible / 2);
	else {
		start = from;
		if (at < start) start = at;
		else if (at >= start + visible) start = at - visible + 1;
	}
	start = Math.max(0, Math.min(start, last));
	return { start, end: start + visible };
}

/** Picker state: the list window drawn last (its first row) and the list key it was drawn for. */
export const PICKER_WINDOW = "window";

/**
 * The list window of an edge-scrolling picker ({@link scrollWindow}): it
 * moves from the window drawn last only as far as the selection needs, and
 * centres the selection when the list opens or `key` changes (a new query, a
 * new scope; default the picker's `query`). The window is terminal-side
 * state of the node, kept by the painter (untracked: it is the painter's own
 * output).
 */
export function pickerWindow(
	node: UiNode,
	total: number,
	index: number,
	visible: number,
	key: string | undefined = (node.props() as TspPickerProps).query ?? undefined,
): { start: number; end: number } {
	const state = pickerState<{ start: number; key: string | undefined } | null>(node, PICKER_WINDOW, () => null);
	const last = state.peek();
	const window = scrollWindow(total, index, visible, last !== null && last.key === key ? last.start : undefined);
	if (last === null || last.start !== window.start || last.key !== key) state.set({ start: window.start, key });
	return window;
}

/**
 * A scrollbar of `height` cells for `visible` of `total` rows starting at
 * `start`: one glyph per row (thumb in `accent`, track in `muted`).
 */
export function scrollbar(theme: Theme, total: number, start: number, visible: number, height = visible): string[] {
	const thumb = Math.max(1, Math.min(height, Math.floor((height * visible) / Math.max(1, total))));
	const travel = height - thumb;
	const range = Math.max(1, total - visible);
	const top = Math.min(travel, Math.round((start * travel) / range));
	const out: string[] = [];
	for (let i = 0; i < height; i++)
		out.push(i >= top && i < top + thumb ? theme.style("accent", "█") : theme.style("muted", "│"));
	return out;
}

// ─── Frame ──────────────────────────────────────────────────────────────────

/** Top border `╭─ title ──╮` (title bold accent, cut to fit). */
export function boxTop(theme: Theme, width: number, title?: string | null): string {
	const b = theme.symbols.box;
	if (width < 2) return theme.style("border", b.topLeft.repeat(Math.max(0, width)));
	if (!title) return theme.style("border", `${b.topLeft}${b.horizontal.repeat(width - 2)}${b.topRight}`);
	const room = Math.max(0, width - 4);
	const label = truncate(` ${title} `, room, theme.symbols.ellipsis);
	const fill = Math.max(0, width - 3 - visibleWidth(label));
	return `${theme.style("border", `${b.topLeft}${b.horizontal}`)}${theme.style("strong accent", label)}${theme.style("border", `${b.horizontal.repeat(fill)}${b.topRight}`)}`;
}

/** A frame row: `│ content │`, content padded (or cut) to `width - 4`. */
export function boxRow(theme: Theme, width: number, content: string): string {
	const v = theme.style("border", theme.symbols.box.vertical);
	return `${v} ${padTo(content, Math.max(0, width - 4))} ${v}`;
}

/** A divider across the frame: `├──┤`. */
export function boxRule(theme: Theme, width: number): string {
	const b = theme.symbols.box;
	return theme.style("border", `${b.teeRight}${b.horizontal.repeat(Math.max(0, width - 2))}${b.teeLeft}`);
}

/** Bottom border `╰──╯`. */
export function boxBottom(theme: Theme, width: number): string {
	const b = theme.symbols.box;
	return theme.style("border", `${b.bottomLeft}${b.horizontal.repeat(Math.max(0, width - 2))}${b.bottomRight}`);
}

// ─── Rows ───────────────────────────────────────────────────────────────────

/** Plain text of a TSP text value. */
export function plainText(content: TspText | undefined): string {
	if (content === undefined) return "";
	if (typeof content === "string") return content;
	let out = "";
	for (const span of content as readonly TspSpan[]) out += span.t;
	return out;
}

/** Spans of `content` with unstyled spans given `style` (the selection color). */
export function styledSelected(theme: Theme, content: TspText | undefined, style: string | undefined): string {
	if (content === undefined) return "";
	if (typeof content === "string") return style ? theme.style(style, content) : content;
	let out = "";
	for (const span of content as readonly TspSpan[]) {
		const tokens = span.s ?? style;
		out += tokens ? theme.style(tokens, span.t) : span.t;
	}
	return out;
}

/** The pointer cell of a row: `❯ ` on the selected row, two spaces otherwise. */
export function pointer(theme: Theme, selected: boolean): string {
	return selected ? `${theme.symbols.symbol("nav.cursor")} ` : "  ";
}

/**
 * A `column` list row: pointer, the label in a column of `labelWidth`, the
 * detail after it (shown when the row is wider than 40 and leaves the detail
 * more than 10 cells). The selected row is all `accent`; other details `muted`.
 */
export function selectRow(
	theme: Theme,
	options: { label: string; detail?: string; selected: boolean; width: number; labelWidth?: number },
): string {
	const { width, selected } = options;
	const lead = pointer(theme, selected);
	const leadWidth = visibleWidth(lead);
	const detail = options.detail ? flattenLine(options.detail) : "";
	const label = flattenLine(options.label);
	if (detail && width > 40) {
		const column = Math.max(1, Math.min(options.labelWidth ?? 32, width - leadWidth - 4));
		const shown = truncate(label, Math.max(1, column - 2), "");
		const gap = spaces(Math.max(1, column - visibleWidth(shown)));
		const room = width - leadWidth - visibleWidth(shown) - gap.length - 2;
		if (room > 10) {
			const cut = truncate(detail, room, "");
			if (selected) return theme.style("accent", `${lead}${shown}${gap}${cut}`);
			return `${lead}${shown}${theme.style("muted", `${gap}${cut}`)}`;
		}
	}
	const shown = truncate(label, Math.max(1, width - leadWidth - 2), "");
	return selected ? theme.style("accent", `${lead}${shown}`) : `${lead}${shown}`;
}

/**
 * An `inline` list row: pointer then `text` (spans keep their styles; on the
 * selected row unstyled text and the pointer are `accent`), cut with an
 * ellipsis at `width`.
 */
export function inlineRow(theme: Theme, options: { text: TspText; selected: boolean; width: number }): string {
	const lead = options.selected ? theme.style("accent", pointer(theme, true)) : pointer(theme, false);
	const body = styledSelected(theme, options.text, options.selected ? "accent" : undefined);
	return truncate(`${lead}${body}`, options.width, theme.symbols.ellipsis);
}

/** The search row: `> query` (placeholder muted when empty). */
export function queryRow(theme: Theme, query: string, width: number, placeholder?: string): string {
	const text = query.length > 0 ? query : placeholder ? theme.style("muted", placeholder) : "";
	return truncate(`> ${text}`, width, theme.symbols.ellipsis);
}

// ─── Hints ──────────────────────────────────────────────────────────────────

// Preserve the published Unicode output through the current major.
const KEY_CAPS: Readonly<Record<string, string>> = {
	enter: "⏎",
	return: "⏎",
	esc: "⎋",
	escape: "⎋",
	tab: "⇥",
	backspace: "⌫",
	delete: "⌦",
	space: "␣",
	up: "↑",
	down: "↓",
	left: "←",
	right: "→",
	ctrl: "⌃",
	alt: "⌥",
	shift: "⇧",
	super: "⌘",
	pageup: "PgUp",
	pagedown: "PgDn",
	home: "Home",
	end: "End",
};

/**
 * Keycaps of a key chord (`["alt","enter"]` → `⌥⏎`).
 * @deprecated Use {@link keyCapsFor} to honor the theme's symbol preset.
 */
export function keyCaps(keys: readonly string[]): string {
	return keys.map(key => KEY_CAPS[key.toLowerCase()] ?? (key.length === 1 ? key.toUpperCase() : key)).join("");
}

/**
 * The hint row of `actions`: `⏎ select · ⎋ close` (actions without keys are skipped).
 * @deprecated Use {@link actionHintFor} to honor the theme's symbol preset.
 */
export function actionHint(actions: readonly TspPickerAction[] | undefined): string {
	const parts: string[] = [];
	for (const action of actions ?? []) {
		if (!action.keys || action.keys.length === 0 || action.disabled) continue;
		parts.push(`${keyCaps(action.keys)} ${action.label.toLowerCase()}`);
	}
	return parts.join(" · ");
}

/** Draw keycaps in the theme's symbol preset, preserving chords and alternative keys. */
export function keyCapsFor(theme: Theme, keys: readonly string[]): string {
	return formatKeyCaps(keys, { preset: theme.symbols.preset, platform: keyHintPlatform() });
}

/** Draw enabled picker action hints with keycaps in the theme's symbol preset. */
export function actionHintFor(theme: Theme, actions: readonly TspPickerAction[] | undefined): string {
	const parts: string[] = [];
	for (const action of actions ?? []) {
		if (!action.keys || action.keys.length === 0 || action.disabled) continue;
		parts.push(`${keyCapsFor(theme, action.keys)} ${action.label.toLowerCase()}`);
	}
	return parts.join(" · ");
}

// ─── The default sheet ──────────────────────────────────────────────────────

/** The list rows of the default sheet, with hits. */
export function paintPickerList(node: UiNode, theme: Theme, width: number): { rows: string[]; hits: Hit[] } {
	const props = node.props() as TspPickerProps;
	const term = pickerTerm(node);
	const entries = pickerEntries(props);
	const rows: string[] = [];
	const hits: Hit[] = [];
	if (entries.length === 0) {
		const empty = term.empty ?? props.empty ?? (props.state === "loading" ? "Loading…" : "No items");
		// Plain empty copy sits under the labels; spans are drawn as given.
		const text = typeof empty === "string" ? theme.style("muted", `  ${empty}`) : styledText(theme, empty);
		rows.push(truncate(text, width, theme.symbols.ellipsis));
		return { rows, hits };
	}
	const visible = pickerPage(node);
	const selectedIndex = entries.findIndex(entry => entry.kind === "item" && entry.item.id === props.selected);
	const { start, end } = scrollWindow(entries.length, selectedIndex, visible);
	const overflow = entries.length > visible;
	const rowWidth = overflow ? width - 1 : width;
	const bar = overflow ? scrollbar(theme, entries.length, start, visible, end - start) : undefined;
	const current = new Set(props.current ?? []);
	for (let i = start; i < end; i++) {
		const entry = entries[i]!;
		let row: string;
		if (entry.kind === "group") {
			row = truncate(theme.style("muted", plainText(entry.group.label)), rowWidth, theme.symbols.ellipsis);
		} else {
			const item = entry.item;
			const selected = item.id === props.selected;
			const text = term.rows?.[item.id];
			if (text !== undefined) row = inlineRow(theme, { text, selected, width: rowWidth });
			else if (term.layout === "inline") {
				const label = plainText(item.label);
				const parts: TspSpan[] = [{ t: flattenLine(label), ...(item.disabled ? { s: "dim" } : {}) }];
				if (current.has(item.id)) parts.push({ t: " (current)", s: "muted" });
				if (item.detail) parts.push({ t: `  ${flattenLine(plainText(item.detail))}`, s: "dim" });
				row = inlineRow(theme, { text: parts, selected, width: rowWidth });
			} else {
				const own = term.labels?.[item.id];
				row = selectRow(theme, {
					label: own ? own.label : plainText(item.label),
					detail: own ? own.detail : plainText(item.detail),
					selected,
					width: rowWidth,
					labelWidth: term.labelWidth,
				});
			}
			hits.push({ row: rows.length, col: 0, width, height: 1, node, item: item.id });
		}
		rows.push(bar ? `${padTo(row, rowWidth)}${bar[i - start]}` : row);
	}
	return { rows, hits };
}

/** The hint and note rows under the list. */
export function paintPickerFooter(node: UiNode, theme: Theme, width: number): string[] {
	const props = node.props() as TspPickerProps;
	const term = pickerTerm(node);
	const rows: string[] = [];
	const hint = term.hint === undefined ? actionHintFor(theme, props.actions) : term.hint;
	if (hint !== null && plainText(hint).length > 0) {
		// A plain hint is muted; spans carry their own styles (a warning in its place).
		const text = typeof hint === "string" ? theme.style("muted", hint) : styledText(theme, hint);
		if (term.hintWrap) rows.push(...wrap(text, width));
		else rows.push(truncate(text, width, theme.symbols.ellipsis));
	}
	for (const note of term.notes ?? []) {
		const text = styledText(theme, note);
		if (text.length === 0) rows.push("");
		else rows.push(...wrap(text, width));
	}
	return rows;
}

/**
 * The whole sheet as a hit without an item, listed before the row hits (the
 * backend tries later hits first): pointer motion off the rows reaches the
 * widget, which clears the hover.
 */
export function sheetHit(node: UiNode, width: number, height: number): Hit {
	return { row: 0, col: 0, width, height, node };
}

/** The default sheet: frame, head rows, search, list, preview, hint and notes. */
export function paintPickerSheet(node: UiNode, cx: PaintContext): Block {
	const width = cx.width;
	if (width < 4) return EMPTY_BLOCK;
	const theme = cx.theme;
	const props = node.props() as TspPickerProps;
	const term = pickerTerm(node);
	const inner = width - 4;
	const body: string[] = [];
	const hits: Hit[] = [];
	for (const head of term.head ?? []) body.push(...wrap(styledText(theme, head), inner));
	if (typeof props.query === "string" && term.search !== false) {
		body.push(queryRow(theme, props.query, inner, props.placeholder));
	}
	const list = paintPickerList(node, theme, inner);
	for (const hit of list.hits) hits.push({ ...hit, row: hit.row + body.length + 1, col: 2 });
	body.push(...list.rows);
	const children = node.children();
	if (children.length > 0) {
		const preview = stack(
			children.map(child => cx.paint(child, inner)),
			0,
		);
		if (preview.rows.length > 0) body.push("", ...preview.rows);
	}
	body.push(...paintPickerFooter(node, theme, inner));
	const title = term.title === undefined ? props.title : term.title;
	const rows = [boxTop(theme, width, title), ...body.map(row => boxRow(theme, width, row)), boxBottom(theme, width)];
	return { rows, hits: [sheetHit(node, width, rows.length), ...hits] };
}

const looks = new Map<string, Painter>();

/** Register a screen look for pickers whose `term.look` is `look`. */
export function definePickerLook(look: string, painter: Painter): void {
	looks.set(look, painter);
}

definePainter("picker", (node, cx) => {
	const look = pickerTerm(node).look;
	const painter = look ? looks.get(look) : undefined;
	return painter ? painter(node, cx) : paintPickerSheet(node, cx);
});
