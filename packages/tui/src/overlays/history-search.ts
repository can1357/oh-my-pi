import {
	type Component,
	Ellipsis,
	Input,
	matchesKey,
	padding,
	Spacer,
	Text,
	truncateToWidth,
	visibleWidth,
} from "../index";
import { logger } from "@oh-my-pi/pi-utils";
import { theme } from "../theme/theme";
import {
	matchesAppInterrupt,
	matchesSelectDown,
	matchesSelectPageDown,
	matchesSelectPageUp,
	matchesSelectUp,
} from "../keybinding-matchers";

/** Prompt history fields displayed in search results. */
export interface HistorySearchEntry {
	prompt: string;
	created_at: number;
	/** Project folder the prompt was typed in. */
	cwd?: string;
}

/** Searchable prompt history supplied by the host. */
export interface HistorySource {
	search(query: string, limit: number): HistorySearchEntry[];
	getRecent(limit: number): HistorySearchEntry[];
}

import { boundKeys, editorKeys, keyHint, rawKeyHint } from "../chrome/keybinding-hints";
import { OverlayPanel } from "../chrome/overlay-box";
import { contentRowWidth, renderScrollableList } from "../chrome/selector-helpers";
import { MenuSelection } from "../components/menu-selection";
import { centeredViewportRange } from "../components/scroll-viewport";
import type { KeyName } from "../key-hint-format";
import type { TspPickerItem } from "@oh-my-pi/pi-wire";
import { col, keyed, node, span } from "../native/describe";
import type { DescribeContext, NativeNode, NativeUiEvent } from "../native/node";
import { actionHint, hintsRow, overlayCard } from "../native/overlay";
import { picker, pickerAction, pickerAge, pickerDate, pickerEvent, pickerHits, pickerQuery } from "../native/picker";
import { shortenPath } from "../render/render-utils";

const ENTER_KEYS: readonly KeyName[] = ["enter"];

/** Native item key of a history entry: key-path safe (prompts may hold `/` and newlines), stable across queries. */
function nativeEntryKey(entry: HistorySearchEntry): string {
	return `${entry.created_at}-${Bun.hash(entry.prompt).toString(36)}`;
}

interface HistoryNativeMemo {
	picker: boolean;
	title: string;
	items: readonly HistorySearchEntry[];
	selected: HistorySearchEntry | undefined;
	query: string;
	cursor: number;
	node: NativeNode;
}

/** Key of the `picker` child a dock-mounted history search describes (hoisted into `layer`). */
const PICKER_KEY = "picker";

/** A labeled source already bound to its scope by the host. */
export interface HistorySearchScope extends HistorySource {
	label: string;
}

/** Visible result rows; also the jump distance for PageUp/PageDown. */
const MAX_VISIBLE = 10;

/** Split a query the same way `HistorySource` tokenizes it, so highlights align with matches. */
function queryTokens(query: string): string[] {
	return query
		.toLowerCase()
		.split(/[^\p{L}\p{N}]+/u)
		.filter(tok => tok.length > 0);
}

/** Wrap every case-insensitive occurrence of any token in `text` with the accent color. */
function highlightTokens(text: string, tokens: string[]): string {
	const ranges = pickerHits(text, tokens);
	if (ranges.length === 0) return text;
	let out = "";
	let pos = 0;
	for (const [start, end] of ranges) {
		if (start > pos) out += text.slice(pos, start);
		out += theme.fg("accent", text.slice(start, end));
		pos = end;
	}
	if (pos < text.length) out += text.slice(pos);
	return out;
}

/** A past prompt as a picker row: its first line (with query hits), age and project folder. */
function historyPickerItem(entry: HistorySearchEntry, tokens: readonly string[]): TspPickerItem {
	const label = entry.prompt.trim().split("\n", 1)[0]!.replace(/\s+/g, " ").trim();
	const hits = pickerHits(label, tokens);
	return {
		id: nativeEntryKey(entry),
		label,
		...(entry.cwd ? { detail: shortenPath(entry.cwd) } : {}),
		facts: { when: pickerAge(entry.created_at * 1000) },
		...(hits.length > 0 ? { hits } : {}),
		title: pickerDate(entry.created_at * 1000),
	};
}

class HistoryResultsList implements Component {
	#menu: MenuSelection<HistorySearchEntry>;
	#tokens: string[] = [];
	// Set before every render by the owning overlay.
	#emptyMessage = "";
	#maxVisible = MAX_VISIBLE;

	constructor(menu: MenuSelection<HistorySearchEntry>) {
		this.#menu = menu;
	}

	setQuery(tokens: string[], emptyMessage: string): void {
		this.#tokens = tokens;
		this.#emptyMessage = emptyMessage;
	}

	invalidate(): void {
		// No cached state to invalidate currently
	}

	render(width: number): readonly string[] {
		const lines: string[] = [];
		const items = this.#menu.visibleItems;

		if (items.length === 0) {
			lines.push(theme.fg("muted", `  ${theme.status.info} ${this.#emptyMessage}`));
			return lines;
		}

		const cursorSymbol = `${theme.nav.cursor} `;
		const gutterWidth = visibleWidth(cursorSymbol);

		const { start: startIndex, end: endIndex } = centeredViewportRange(
			this.#menu.selectedIndex,
			items.length,
			this.#maxVisible,
		);

		const rowWidth = contentRowWidth(width, items.length, this.#maxVisible);
		const rows: string[] = [];

		for (let i = startIndex; i < endIndex; i++) {
			const entry = items[i];
			if (!entry) continue;
			const isSelected = i === this.#menu.selectedIndex;

			const timeStr = pickerAge(entry.created_at * 1000);
			const timeWidth = visibleWidth(timeStr);
			const showTime = rowWidth >= gutterWidth + 12 + timeWidth;

			const promptBudget = Math.max(4, rowWidth - gutterWidth - (showTime ? timeWidth + 1 : 0));
			const normalized = entry.prompt.replace(/\s+/g, " ").trim();
			const plain = truncateToWidth(normalized, promptBudget);
			const highlighted = highlightTokens(plain, this.#tokens);

			const cursor = isSelected ? theme.fg("accent", cursorSymbol) : padding(gutterWidth);
			let line = cursor + (isSelected ? theme.bold(highlighted) : highlighted);

			if (showTime) {
				// Pad the prompt region so the timestamp sits flush right with a one-cell gap.
				line = `${truncateToWidth(line, rowWidth - timeWidth - 1, Ellipsis.Unicode, true)} ${theme.fg("dim", timeStr)}`;
			}

			rows.push(
				isSelected
					? theme.bg("selectedBg", truncateToWidth(line, rowWidth, Ellipsis.Omit, true))
					: truncateToWidth(line, rowWidth),
			);
		}

		lines.push(...renderScrollableList(rows, { width, totalRows: items.length, scrollOffset: startIndex }));
		return lines;
	}
}

export class HistorySearchComponent extends OverlayPanel {
	#scopes: readonly HistorySearchScope[];
	#scopeIndex = 0;
	#searchInput: Input;
	#menu: MenuSelection<HistorySearchEntry>;
	#resultsList: HistoryResultsList;
	#hint: Text;
	#onSelect: (prompt: string) => void;
	#onCancel: () => void;
	#resultLimit = 100;
	#nativeHints: NativeNode | undefined;
	#nativeMemo: HistoryNativeMemo | undefined;
	#pickerItems: { items: readonly HistorySearchEntry[]; rows: readonly TspPickerItem[] } | undefined;
	#emptyMessage = "";

	/** Sources are host-bound and ordered for Tab cycling, with the initial scope first. */
	constructor(scopes: readonly HistorySearchScope[], onSelect: (prompt: string) => void, onCancel: () => void) {
		super("History", "omp.overlay.history");
		if (scopes.length === 0) throw new RangeError("History search requires at least one source");
		this.#scopes = scopes;
		this.#onSelect = onSelect;
		this.#onCancel = onCancel;

		this.#menu = new MenuSelection<HistorySearchEntry>([], {
			getKey: entry => `${entry.created_at}:${entry.prompt}`,
			getSearchText: entry => entry.prompt,
		});
		this.#searchInput = new Input();
		this.#searchInput.onSubmit = () => {
			const selected = this.#menu.selectedItem;
			if (selected) {
				this.#onSelect(selected.prompt);
			}
		};
		this.#searchInput.onEscape = () => {
			this.#onCancel();
		};

		this.#resultsList = new HistoryResultsList(this.#menu);
		this.#hint = new Text("", 0, 0);

		this.addChild(new Spacer(1));
		this.addChild(this.#searchInput);
		this.addChild(new Spacer(1));
		this.addChild(this.#resultsList);
		this.addChild(new Spacer(1));
		this.addChild(this.#hint);
		this.addChild(new Spacer(1));

		this.#updateChrome();
		this.#updateResults();
	}

	#scopeAt(index: number): HistorySearchScope {
		const count = this.#scopes.length;
		return this.#scopes[((index % count) + count) % count]!;
	}

	#updateChrome(): void {
		this.#nativeHints = undefined;
		const label = this.#scopeAt(this.#scopeIndex).label;
		this.title = `History (${label})`;
		const dot = theme.fg("dim", theme.sep.dot);
		const navigate = theme.fg("dim", editorKeys("tui.select.up", "tui.select.down")) + theme.fg("muted", " navigate");
		const hints = [navigate, rawKeyHint("enter", "select")];
		// A one-scope ring cannot cycle, so advertising Tab would promise a no-op.
		if (this.#scopes.length > 1) hints.push(rawKeyHint("tab", this.#scopeAt(this.#scopeIndex + 1).label));
		hints.push(keyHint("tui.select.cancel", "cancel"));
		this.#hint.setText(hints.join(dot));
	}

	#cycleScope(direction: 1 | -1): void {
		if (this.#scopes.length < 2) return;
		this.#scopeIndex =
			(((this.#scopeIndex + direction) % this.#scopes.length) + this.#scopes.length) % this.#scopes.length;
		this.#updateChrome();
		this.#updateResults();
	}

	handleInput(keyData: string): void {
		// Tab and Shift+Tab cycle the scope ring in opposite directions. The ring starts on
		// the configured scope and wraps, so neither key is strictly "wider" than the other.
		// Deliberately not `handleTabSwitchKey`: that helper also consumes Left/Right, which
		// move the cursor inside the query field.
		const forward = matchesKey(keyData, "tab");
		if (forward || matchesKey(keyData, "shift+tab")) {
			this.#cycleScope(forward ? 1 : -1);
			return;
		}

		if (matchesSelectUp(keyData)) {
			this.#menu.move(-1, false);
			return;
		}

		if (matchesSelectDown(keyData)) {
			this.#menu.move(1, false);
			return;
		}

		if (matchesSelectPageUp(keyData)) {
			this.#menu.move(-MAX_VISIBLE, false);
			return;
		}

		if (matchesSelectPageDown(keyData)) {
			this.#menu.move(MAX_VISIBLE, false);
			return;
		}

		if (matchesKey(keyData, "home")) {
			this.#menu.moveToBoundary("first");
			return;
		}

		if (matchesKey(keyData, "end")) {
			this.#menu.moveToBoundary("last");
			return;
		}

		if (matchesKey(keyData, "enter") || matchesKey(keyData, "return") || keyData === "\n") {
			const selected = this.#menu.selectedItem;
			if (selected) {
				this.#onSelect(selected.prompt);
			}
			return;
		}

		if (matchesAppInterrupt(keyData)) {
			this.#onCancel();
			return;
		}

		this.#searchInput.handleInput(keyData);
		this.#updateResults();
	}

	/**
	 * With the `picker` kind: a `size:"md"` sheet of past prompts (first line
	 * with hits, age, folder) as a keyed child the reconciler hoists into
	 * `layer`, since the selector replaces the editor in the dock. Otherwise
	 * the query field (the `Input`, which describes itself as `input`), the
	 * results as a `list` keyed by entry (filter = query, age as the item
	 * value), and the key hints.
	 */
	override describe(cx: DescribeContext): NativeNode {
		const items = this.#menu.visibleItems;
		const selected = this.#menu.selectedItem;
		const usePicker = cx.supports("picker");
		const query = usePicker ? this.#searchInput.getValue() : this.#searchInput.getValue().trim();
		const cursor = this.#searchInput.getCursor();
		const memo = this.#nativeMemo;
		if (
			memo &&
			memo.picker === usePicker &&
			memo.title === this.title &&
			memo.items === items &&
			memo.selected === selected &&
			memo.query === query &&
			memo.cursor === cursor
		) {
			return memo.node;
		}
		if (usePicker) {
			const root = col([keyed(this.#describePicker(items, selected, query), PICKER_KEY)]);
			this.#nativeMemo = { picker: true, title: this.title, items, selected, query, cursor, node: root };
			return root;
		}

		const rows = items.map(entry =>
			node(
				"item",
				{
					label: entry.prompt.replace(/\s+/g, " ").trim(),
					value: [span(pickerAge(entry.created_at * 1000), "dim")],
				},
				undefined,
				nativeEntryKey(entry),
			),
		);
		const list = node(
			"list",
			{
				selected: selected ? nativeEntryKey(selected) : null,
				filter: query || undefined,
				empty: this.#emptyMessage,
				max: { lines: MAX_VISIBLE },
				virtual: true,
			},
			rows,
			"list",
		);
		this.#nativeHints ??= hintsRow([
			actionHint(["tui.select.up", "tui.select.down"], "navigate"),
			{ keys: ENTER_KEYS, label: "select" },
			...(this.#scopes.length > 1
				? [
						{ keys: ["tab" as const], label: this.#scopeAt(this.#scopeIndex + 1).label },
						{ keys: ["shift+tab" as const], label: this.#scopeAt(this.#scopeIndex - 1).label },
					]
				: []),
			actionHint("tui.select.cancel", "cancel"),
		]);
		const root = overlayCard(this.nativeRole, this.title, [this.#searchInput, list, this.#nativeHints]);
		this.#nativeMemo = { picker: false, title: this.title, items, selected, query, cursor, node: root };
		return root;
	}

	#describePicker(
		items: readonly HistorySearchEntry[],
		selected: HistorySearchEntry | undefined,
		query: string,
	): NativeNode {
		let rows = this.#pickerItems;
		if (rows?.items !== items) {
			const tokens = queryTokens(query.trim());
			rows = { items, rows: items.map(entry => historyPickerItem(entry, tokens)) };
			this.#pickerItems = rows;
		}
		return picker({
			title: this.title,
			icon: "history",
			noun: "prompts",
			size: "md",
			layout: "rows",
			preview: "none",
			...pickerQuery(this.#searchInput),
			placeholder: "Search prompts…",
			columns: [{ id: "when", format: "time" }],
			items: rows.rows,
			selected: selected ? nativeEntryKey(selected) : null,
			empty: this.#emptyMessage,
			actions: [
				pickerAction("insert", "Insert", "enter", { primary: true }),
				...(this.#scopes.length > 1
					? [
							pickerAction("scope", this.#scopeAt(this.#scopeIndex + 1).label, "tab"),
							pickerAction("scope-back", this.#scopeAt(this.#scopeIndex - 1).label, "shift+tab"),
						]
					: []),
				pickerAction("close", "Close", boundKeys("app.interrupt", ["escape"])[0] ?? "escape", { end: true }),
			],
		});
	}

	/**
	 * Picker: a row click highlights, a second click or `Insert` inserts it
	 * (Enter), `Close` cancels (Esc), `Clear search` empties the query.
	 * List: picking a result does what highlighting it and pressing Enter does.
	 */
	handleNativeEvent(event: NativeUiEvent): void {
		const ev = pickerEvent(event, PICKER_KEY);
		if (ev) {
			if (ev.kind === "action") {
				if (ev.act === "close") this.#onCancel();
				else if (ev.act === "insert") this.handleInput("\r");
				else if (ev.act === "scope") this.#cycleScope(1);
				else if (ev.act === "scope-back") this.#cycleScope(-1);
				else if (ev.act === "clear") {
					this.#searchInput.setValue("");
					this.#updateResults();
				}
				return;
			}
			const index = this.#menu.visibleItems.findIndex(entry => nativeEntryKey(entry) === ev.item);
			if (index < 0) return;
			this.#menu.setSelectedIndex(index);
			if (ev.kind === "activate") this.#onSelect(this.#menu.visibleItems[index]!.prompt);
			return;
		}
		if ((event.type !== "select" && event.type !== "activate") || event.key !== "list") return;
		const index = this.#menu.visibleItems.findIndex(entry => nativeEntryKey(entry) === event.item);
		const target = this.#menu.visibleItems[index];
		if (!target) return;
		this.#menu.setSelectedIndex(index);
		this.#onSelect(target.prompt);
	}

	#updateResults(): void {
		this.#nativeMemo = undefined;
		this.#pickerItems = undefined;
		const query = this.#searchInput.getValue().trim();
		const scope = this.#scopeAt(this.#scopeIndex);
		// Source failures must not escape a keystroke handler; the next input retries.
		let results: HistorySearchEntry[] = [];
		try {
			results = query ? scope.search(query, this.#resultLimit) : scope.getRecent(this.#resultLimit);
		} catch (error) {
			logger.warn("History search read failed", { error: String(error) });
		}
		this.#menu.setItems(results);
		this.#menu.moveToBoundary("first");
		const nextScope = this.#scopeAt(this.#scopeIndex + 1).label;
		const widen = this.#scopes.length > 1 ? ` Press Tab for ${nextScope}.` : "";
		this.#emptyMessage = query
			? `No matching history in ${scope.label}.${widen}`
			: `No history in ${scope.label}.${widen}`;
		this.#resultsList.setQuery(query ? queryTokens(query) : [], this.#emptyMessage);
	}
}
