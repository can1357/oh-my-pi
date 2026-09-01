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
} from "@oh-my-pi/pi-tui";
import { theme } from "../../modes/theme/theme";
import {
	matchesAppInterrupt,
	matchesSelectDown,
	matchesSelectPageDown,
	matchesSelectPageUp,
	matchesSelectUp,
} from "../../modes/utils/keybinding-matchers";
import type { HistoryEntry, HistoryStorage } from "../../session/history-storage";
import { rawKeyHint } from "./keybinding-hints";
import { OverlayPanel } from "./overlay-box";
import { centeredWindow, contentRowWidth, renderScrollableList } from "./selector-helpers";

/** Visible result rows; also the jump distance for PageUp/PageDown. */
const MAX_VISIBLE = 10;

/** Split a query the same way `HistoryStorage` tokenizes it, so highlights align with matches. */
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
	#results: HistoryEntry[] = [];
	#tokens: string[] = [];
	#selectedIndex = 0;
	#maxVisible = MAX_VISIBLE;

	setResults(results: HistoryEntry[], selectedIndex: number, tokens: string[]): void {
		this.#results = results;
		this.#selectedIndex = selectedIndex;
		this.#tokens = tokens;
	}

	setSelectedIndex(selectedIndex: number): void {
		this.#selectedIndex = selectedIndex;
	}

	invalidate(): void {
		// No cached state to invalidate currently
	}

	render(width: number): readonly string[] {
		const lines: string[] = [];

		if (this.#results.length === 0) {
			const message = this.#tokens.length > 0 ? "No matching history" : "No history yet";
			lines.push(theme.fg("muted", `  ${theme.status.info} ${message}`));
			return lines;
		}

		const cursorSymbol = `${theme.nav.cursor} `;
		const gutterWidth = visibleWidth(cursorSymbol);

		const { startIndex, endIndex } = centeredWindow(this.#selectedIndex, this.#results.length, this.#maxVisible);

		const rowWidth = contentRowWidth(width, this.#results.length, this.#maxVisible);
		const rows: string[] = [];

		for (let i = startIndex; i < endIndex; i++) {
			const entry = this.#results[i];
			const isSelected = i === this.#selectedIndex;

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

		lines.push(...renderScrollableList(rows, { width, totalRows: this.#results.length, scrollOffset: startIndex }));
		return lines;
	}
}

export class HistorySearchComponent extends OverlayPanel {
	#historyStorage: HistoryStorage;
	#searchInput: Input;
	#results: HistoryEntry[] = [];
	#selectedIndex = 0;
	#resultsList: HistoryResultsList;
	#onSelect: (prompt: string) => void;
	#onCancel: () => void;
	#resultLimit = 100;

	constructor(historyStorage: HistoryStorage, onSelect: (prompt: string) => void, onCancel: () => void) {
		super("History");
		this.#historyStorage = historyStorage;
		this.#onSelect = onSelect;
		this.#onCancel = onCancel;

		this.#searchInput = new Input();
		this.#searchInput.onSubmit = () => {
			const selected = this.#results[this.#selectedIndex];
			if (selected) {
				this.#onSelect(selected.prompt);
			}
		};
		this.#searchInput.onEscape = () => {
			this.#onCancel();
		};

		this.#resultsList = new HistoryResultsList();

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
			if (this.#results.length === 0) return;
			this.#selectedIndex = Math.max(0, this.#selectedIndex - 1);
			this.#resultsList.setSelectedIndex(this.#selectedIndex);
			return;
		}

		if (matchesSelectDown(keyData)) {
			if (this.#results.length === 0) return;
			this.#selectedIndex = Math.min(this.#results.length - 1, this.#selectedIndex + 1);
			this.#resultsList.setSelectedIndex(this.#selectedIndex);
			return;
		}

		if (matchesSelectPageUp(keyData)) {
			if (this.#results.length === 0) return;
			this.#selectedIndex = Math.max(0, this.#selectedIndex - MAX_VISIBLE);
			this.#resultsList.setSelectedIndex(this.#selectedIndex);
			return;
		}

		if (matchesSelectPageDown(keyData)) {
			if (this.#results.length === 0) return;
			this.#selectedIndex = Math.min(this.#results.length - 1, this.#selectedIndex + MAX_VISIBLE);
			this.#resultsList.setSelectedIndex(this.#selectedIndex);
			return;
		}

		if (matchesKey(keyData, "home")) {
			if (this.#results.length === 0) return;
			this.#selectedIndex = 0;
			this.#resultsList.setSelectedIndex(this.#selectedIndex);
			return;
		}

		if (matchesKey(keyData, "end")) {
			if (this.#results.length === 0) return;
			this.#selectedIndex = this.#results.length - 1;
			this.#resultsList.setSelectedIndex(this.#selectedIndex);
			return;
		}

		if (matchesKey(keyData, "enter") || matchesKey(keyData, "return") || keyData === "\n") {
			const selected = this.#results[this.#selectedIndex];
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
		this.#results = query
			? this.#historyStorage.search(query, this.#resultLimit)
			: this.#historyStorage.getRecent(this.#resultLimit);
		this.#selectedIndex = 0;
		this.#resultsList.setResults(this.#results, this.#selectedIndex, query ? queryTokens(query) : []);
	}
}
