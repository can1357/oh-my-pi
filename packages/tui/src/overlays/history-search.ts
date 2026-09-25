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
}

/** Searchable prompt history supplied by the host. */
export interface HistorySource {
	search(query: string, limit: number): HistorySearchEntry[];
	getRecent(limit: number): HistorySearchEntry[];
}
import { rawKeyHint } from "../chrome/keybinding-hints";
import { OverlayPanel } from "../chrome/overlay-box";
import { contentRowWidth, renderScrollableList } from "../chrome/selector-helpers";
import { MenuSelection } from "../components/menu-selection";
import { centeredViewportRange } from "../components/scroll-viewport";

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
	if (tokens.length === 0) return text;

	const lower = text.toLowerCase();
	const ranges: Array<[number, number]> = [];
	for (const tok of tokens) {
		let from = lower.indexOf(tok);
		while (from !== -1) {
			ranges.push([from, from + tok.length]);
			from = lower.indexOf(tok, from + tok.length);
		}
	}
	if (ranges.length === 0) return text;

	ranges.sort((a, b) => a[0] - b[0]);
	let out = "";
	let pos = 0;
	for (const [start, end] of ranges) {
		if (end <= pos) continue; // fully covered by a previous (merged) range
		const from = Math.max(start, pos);
		if (from > pos) out += text.slice(pos, from);
		out += theme.fg("accent", text.slice(from, end));
		pos = end;
	}
	if (pos < text.length) out += text.slice(pos);
	return out;
}

/** Compact "time since" label (e.g. `now`, `5m`, `2h`, `3d`, `2w`, `6mo`, `1y`) from epoch seconds. */
function relativeTime(epochSeconds: number): string {
	const seconds = Math.max(0, Math.floor(Date.now() / 1000) - epochSeconds);
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

class HistoryResultsList implements Component {
	#menu: MenuSelection<HistorySearchEntry>;
	#tokens: string[] = [];
	#maxVisible = MAX_VISIBLE;

	constructor(menu: MenuSelection<HistorySearchEntry>) {
		this.#menu = menu;
	}

	setTokens(tokens: string[]): void {
		this.#tokens = tokens;
	}

	invalidate(): void {
		// No cached state to invalidate currently
	}

	render(width: number): readonly string[] {
		const lines: string[] = [];
		const items = this.#menu.visibleItems;

		if (items.length === 0) {
			const message = this.#tokens.length > 0 ? "No matching history" : "No history yet";
			lines.push(theme.fg("muted", `  ${theme.status.info} ${message}`));
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

			const timeStr = relativeTime(entry.created_at);
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
	#historyStorage: HistorySource;
	#searchInput: Input;
	#menu: MenuSelection<HistorySearchEntry>;
	#resultsList: HistoryResultsList;
	#onSelect: (prompt: string) => void;
	#onCancel: () => void;
	#resultLimit = 100;

	constructor(historyStorage: HistorySource, onSelect: (prompt: string) => void, onCancel: () => void) {
		super("History");
		this.#historyStorage = historyStorage;
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

		const dot = theme.fg("dim", theme.sep.dot);
		const hint = [rawKeyHint("↑↓", "navigate"), rawKeyHint("enter", "select"), rawKeyHint("esc", "cancel")].join(dot);

		this.addChild(new Spacer(1));
		this.addChild(this.#searchInput);
		this.addChild(new Spacer(1));
		this.addChild(this.#resultsList);
		this.addChild(new Spacer(1));
		this.addChild(new Text(hint, 0, 0));
		this.addChild(new Spacer(1));

		this.#updateResults();
	}

	handleInput(keyData: string): void {
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

	#updateResults(): void {
		const query = this.#searchInput.getValue().trim();
		const results = query
			? this.#historyStorage.search(query, this.#resultLimit)
			: this.#historyStorage.getRecent(this.#resultLimit);
		this.#menu.setItems(results);
		this.#menu.moveToBoundary("first");
		this.#resultsList.setTokens(query ? queryTokens(query) : []);
	}
}
