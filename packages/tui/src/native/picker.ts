/**
 * Builders for the data-first `picker` kind (Stencil repo,
 * `crates/tern/NATIVE_REDESIGN.md` §4): the model hub, session selector,
 * rewind, tree, copy, history search and the small selectors send their data
 * and Tern draws the sheet (head, scopes, tabs, fact columns, rows, preview,
 * action bar).
 *
 * A picker is its own sheet: the component returns `nativeSheet(cx)` true
 * (usually `cx.supports("picker")`) so the backend puts it directly in
 * `layer`, and `describe()` returns {@link picker}. When the terminal lacks
 * the kind, components keep describing their generic composition.
 *
 * Keys stay the program's: a search field is an {@link Input} (every editor
 * text binding works), sent through {@link pickerQuery} with its caret.
 * Pointer events arrive as `select`/`activate` with
 * the item id and `action` with an action id (plus `value` for
 * `scope`/`tab`/`strip`). {@link pickerEvent} folds them into one shape.
 */
import type { TspPickerAction, TspPickerItem, TspPickerProps } from "@oh-my-pi/pi-wire";
import type { KeyName } from "../key-hint-format";
import { getKeybindings, type Keybinding } from "../keybindings";
import type { Input } from "../components/input";
import type { SelectItem, SelectList } from "../components/select-list";
import { col, node } from "./describe";
import type { NativeChild, NativeNode, NativeUiEvent } from "./node";

/** The picker sheet; `preview` children fill its preview pane. */
export function picker(p: TspPickerProps, preview?: readonly NativeChild[]): NativeNode {
	return node("picker", p, preview);
}

/**
 * A picker's search field from the {@link Input} that edits it: the text and
 * its caret. `null` hides the field. Memoized pickers MUST key on the caret
 * too, or motion keys (word jumps, line start) never reach the screen.
 */
export function pickerQuery(input: Input | null): Pick<TspPickerProps, "query" | "cursor"> {
	return input ? { query: input.getValue(), cursor: input.getCursor() } : { query: null };
}

/** Key of the picker child a dock/editor-mounted selector describes; its events arrive at this keypath. */
export const PICKER_KEY = "picker";

/**
 * The root a selector mounted in the editor slot describes: a column holding
 * the picker as child {@link PICKER_KEY}, which the reconciler hoists into
 * `layer`. Route its events with `pickerEvent(event, PICKER_KEY)`.
 */
export function dockedPicker(p: TspPickerProps, preview?: readonly NativeChild[]): NativeNode {
	return col([node("picker", p, preview, PICKER_KEY)]);
}

/** Keycap names for one key id (`"alt+enter"` → `["alt", "enter"]`, `"escape"` → `["esc"]`). */
export function pickerKeys(key: KeyName | string): string[] {
	if (key === "+") return ["+"];
	const parts = key.endsWith("++") ? [...key.slice(0, -2).split("+"), "+"] : key.split("+");
	return parts.filter(part => part.length > 0).map(part => (part === "escape" ? "esc" : part));
}

/** The keycaps of a keybinding's primary key, empty when unbound. */
export function bindingKeys(binding: Keybinding): string[] {
	const [key] = getKeybindings().getKeys(binding);
	return key ? pickerKeys(key) : [];
}

/** An action-bar button; `keys` is a key id (`"alt+enter"`), a keybinding's keycaps, or none. */
export function pickerAction(
	id: string,
	label: string,
	keys?: KeyName | string | readonly string[],
	opts?: Omit<TspPickerAction, "id" | "label" | "keys">,
): TspPickerAction {
	const caps = keys === undefined ? undefined : typeof keys === "string" ? pickerKeys(keys) : keys;
	return { id, label, ...(caps && caps.length > 0 ? { keys: caps } : {}), ...opts };
}

/** The right-aligned `Close esc` every picker ends with; Tern's backdrop and head `esc` send it too. */
export const CLOSE_ACTION: TspPickerAction = { id: "close", label: "Close", keys: ["esc"], end: true };

/** A `time` fact: the compact age of `at` (`now`, `5m`, `2h`, `3d`, `2w`, `6mo`, `1y`). */
export function pickerAge(at: Date | number, now = Date.now()): string {
	const seconds = Math.max(0, Math.floor((now - (typeof at === "number" ? at : at.getTime())) / 1000));
	if (seconds < 60) return "now";
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h`;
	const days = Math.floor(hours / 24);
	if (days < 7) return `${days}d`;
	if (days < 30) return `${Math.floor(days / 7)}w`;
	if (days < 365) return `${Math.floor(days / 30)}mo`;
	return `${Math.floor(days / 365)}y`;
}

/**
 * Search `hits` for a label: disjoint, ordered UTF-16 ranges of every
 * case-insensitive occurrence of any of the (lowercase) `tokens`.
 */
export function pickerHits(label: string, tokens: readonly string[]): [number, number][] {
	if (tokens.length === 0) return [];
	const lower = label.toLowerCase();
	const ranges: [number, number][] = [];
	for (const token of tokens) {
		if (token.length === 0) continue;
		for (let from = lower.indexOf(token); from !== -1; from = lower.indexOf(token, from + token.length)) {
			ranges.push([from, from + token.length]);
		}
	}
	ranges.sort((a, b) => a[0] - b[0]);
	const merged: [number, number][] = [];
	for (const [start, end] of ranges) {
		const last = merged.at(-1);
		if (last && start <= last[1]) last[1] = Math.max(last[1], end);
		else merged.push([start, end]);
	}
	return merged;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** The absolute local time behind a `time` fact, for its tooltip (`28 Sep 2026, 18:02`). */
export function pickerDate(at: Date | number): string {
	const d = typeof at === "number" ? new Date(at) : at;
	const hh = String(d.getHours()).padStart(2, "0");
	const mm = String(d.getMinutes()).padStart(2, "0");
	return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}, ${hh}:${mm}`;
}

/** A picker pointer event, folded: which item, or which action with its value. */
export type PickerEvent =
	| { readonly kind: "select" | "activate"; readonly item: string }
	| { readonly kind: "action"; readonly act: string; readonly value: string | undefined };

/**
 * The picker event `event` carries, or undefined when it is not for the
 * picker at keypath `key`: `""` for a root picker, else the picker child's
 * key (a hoisted child's keypath carries a `^` marker, ignored here).
 */
export function pickerEvent(event: NativeUiEvent, key = ""): PickerEvent | undefined {
	if (event.key.replaceAll("^", "") !== key) return undefined;
	switch (event.type) {
		case "select":
		case "activate":
			return { kind: event.type, item: event.item };
		case "action":
			return { kind: "action", act: event.act, value: event.value };
		default:
			return undefined;
	}
}

/**
 * {@link pickerHits} for fuzzy-filtered lists: each whitespace token of
 * `query` marks its first case-insensitive substring, else its characters as
 * a greedy in-order subsequence (the fuzzy matcher's shape). Undefined when
 * nothing matches.
 */
export function pickerFuzzyHits(label: string, query: string): [number, number][] | undefined {
	const tokens = query
		.toLowerCase()
		.split(/\s+/)
		.filter(token => token.length > 0);
	if (tokens.length === 0) return undefined;
	const lower = label.toLowerCase();
	const marked = new Uint8Array(lower.length);
	for (const token of tokens) {
		const at = lower.indexOf(token);
		if (at >= 0) {
			marked.fill(1, at, at + token.length);
			continue;
		}
		let from = 0;
		for (const ch of token) {
			const index = lower.indexOf(ch, from);
			if (index < 0) break;
			marked[index] = 1;
			from = index + ch.length;
		}
	}
	const ranges: [number, number][] = [];
	for (let i = 0; i < marked.length; i++) {
		if (!marked[i]) continue;
		const start = i;
		while (i < marked.length && marked[i]) i++;
		ranges.push([start, i]);
	}
	return ranges.length > 0 ? ranges : undefined;
}

/** The `md` sheet a short {@link SelectList} selector becomes (thinking level, hook options, queue mode, …). */
export interface SelectPickerOptions {
	readonly title: string;
	readonly subtitle?: string;
	readonly icon?: string;
	readonly noun?: string;
	/** Show omp's filter text as the search field (lists that filter as you type). */
	readonly searchable?: boolean;
	/** Per-item extras (a thinking-level dot, a swatch mark, a budget fact). */
	readonly decorate?: (item: SelectItem) => Partial<Omit<TspPickerItem, "id">> | undefined;
	readonly columns?: TspPickerProps["columns"];
	/** Values in use now (the current theme, the current level). */
	readonly current?: readonly string[];
	/** The primary action's label (`Apply`, `Select`). */
	readonly confirm?: string;
}

/**
 * Picker props for a {@link SelectList}: its filtered items in order, the
 * selection, the pending-confirmation strip, and `Select ⏎` / `Close esc`.
 * Memoize on {@link SelectList.pickerView}'s parts: the builder allocates.
 */
export function selectListPicker(list: SelectList, o: SelectPickerOptions): TspPickerProps {
	const view = list.pickerView();
	const items: TspPickerItem[] = view.items.map(item => ({
		id: item.value,
		label: item.label,
		...(item.description ? { detail: item.description } : {}),
		...(item.disabled ? { disabled: true as const } : {}),
		...o.decorate?.(item),
	}));
	const pending = view.pending === null ? undefined : view.items.find(item => item.value === view.pending);
	return {
		title: o.title,
		...(o.subtitle ? { subtitle: o.subtitle } : {}),
		...(o.icon ? { icon: o.icon } : {}),
		noun: o.noun ?? "options",
		size: "md",
		layout: "rows",
		preview: "none",
		...(o.searchable ? { query: view.query, cursor: view.cursor } : { query: null }),
		items,
		selected: view.selected,
		...(o.current ? { current: o.current } : {}),
		...(o.columns ? { columns: o.columns } : {}),
		actions: [pickerAction("confirm", o.confirm ?? "Select", "enter", { primary: true }), CLOSE_ACTION],
		confirm:
			pending?.confirmation !== undefined ? { text: pending.confirmation, act: "confirm", label: "Confirm" } : null,
	};
}

/**
 * Routes a picker event to a {@link SelectList}: a row click selects (and
 * previews, through `onSelectionChange`), a second click or `confirm`
 * activates, `close`/`cancel` cancels. Returns whether it handled the event.
 */
export function routeSelectListPicker(list: SelectList, event: NativeUiEvent, key = ""): boolean {
	const ev = pickerEvent(event, key);
	if (!ev) return false;
	const view = list.pickerView();
	if (ev.kind === "action") {
		if (ev.act === "close" || ev.act === "cancel") {
			list.onCancel?.();
			return true;
		}
		if (ev.act === "confirm" && view.selected !== null) {
			const index = view.items.findIndex(item => item.value === view.selected);
			if (index >= 0) list.clickItem(index);
			return true;
		}
		return false;
	}
	const index = view.items.findIndex(item => item.value === ev.item);
	if (index < 0) return false;
	if (ev.kind === "activate") {
		list.clickItem(index);
	} else {
		list.setSelectedIndex(index);
		list.onSelectionChange?.(view.items[index]!);
	}
	return true;
}

/**
 * A {@link SelectList} described as a picker, memoized: the node is rebuilt
 * only when the list's filtered items, selection, pending confirmation or
 * query change (or {@link invalidate} is called after `options` inputs move).
 */
export class SelectListSheet {
	readonly list: SelectList;
	#options: () => SelectPickerOptions;
	#memo:
		| {
				readonly items: readonly SelectItem[];
				readonly selected: string | null;
				readonly pending: string | null;
				readonly query: string;
				readonly cursor: number;
				readonly node: NativeNode;
		  }
		| undefined;

	/** Described as {@link dockedPicker} (editor-slot selectors) rather than a root picker. */
	readonly #docked: boolean;

	constructor(
		list: SelectList,
		options: SelectPickerOptions | (() => SelectPickerOptions),
		{ docked = true }: { docked?: boolean } = {},
	) {
		this.list = list;
		this.#options = typeof options === "function" ? options : () => options;
		this.#docked = docked;
	}

	/** Drop the memo (decorations or options changed outside the list). */
	invalidate(): void {
		this.#memo = undefined;
	}

	describe(): NativeNode {
		const view = this.list.pickerView();
		const memo = this.#memo;
		if (
			memo !== undefined &&
			memo.items === view.items &&
			memo.selected === view.selected &&
			memo.pending === view.pending &&
			memo.query === view.query &&
			memo.cursor === view.cursor
		) {
			return memo.node;
		}
		const props = selectListPicker(this.list, this.#options());
		const result = this.#docked ? dockedPicker(props) : picker(props);
		this.#memo = { ...view, node: result };
		return result;
	}

	/** Route a picker event onto the list; see {@link routeSelectListPicker}. */
	handle(event: NativeUiEvent): boolean {
		return routeSelectListPicker(this.list, event, this.#docked ? PICKER_KEY : "");
	}
}
