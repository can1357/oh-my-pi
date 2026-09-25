/**
 * `/move` overlay: a path input with live directory autocomplete.
 *
 * Rendered as a centered modal via `showHookCustom(..., { overlay: true })`.
 * The user types a path, Tab autocompletes the highlighted directory, and Enter
 * confirms — yielding the resolved directory string (or `undefined` on cancel).
 */
import { type Component, type Focusable, Key, matchesKey } from "../index";
import { theme } from "../theme/theme";
import { matchesSelectCancel, matchesSelectDown, matchesSelectUp } from "../keybinding-matchers";
import { formTheme } from "../chrome/form-theme";
import { bottomBorder, row, topBorder } from "../chrome/overlay-box";
import { TextFormField } from "../components/form";

export interface MoveOverlayResult {
	directory: string;
}

/** Directory suggestion displayed by the move dialog. */
export interface MoveDirectoryEntry {
	/** Full absolute path. */
	value: string;
	/** Display label (basename + trailing slash). */
	label: string;
}

/** Directory autocomplete supplied by the host. */
export interface MoveDirectorySource {
	search(prefix: string, cwd: string, max: number): MoveDirectoryEntry[];
}

const MAX_RESULTS = 15;

/**
 * Overlay component for `/move`: a single-line path input with a live-filtered
 * list of matching directories. Tab accepts the highlighted suggestion; Enter
 * confirms the current input (or the highlighted suggestion if the input is
 * empty); Escape cancels.
 */
export class MoveOverlay implements Component, Focusable {
	#field: TextFormField;
	#focused = false;
	#selectedIndex = 0;
	#results: MoveDirectoryEntry[] = [];
	#cwd: string;
	#source: MoveDirectorySource;
	#done: (result: MoveOverlayResult | undefined) => void;
	#revision = 0;
	#renderMemo:
		| { width: number; fieldLines: readonly string[]; revision: number; lines: readonly string[] }
		| undefined;

	constructor(cwd: string, done: (result: MoveOverlayResult | undefined) => void, source: MoveDirectorySource) {
		this.#cwd = cwd;
		this.#source = source;
		this.#done = done;
		this.#field = new TextFormField({
			theme: formTheme,
			prompt: theme.fg("dim", "Path: "),
			empty: "submit",
			spaceBeforeControl: false,
			spaceAfterControl: false,
			onSubmit: () => this.#confirm(),
			onCancel: () => this.#done(undefined),
		});
		this.#field.focused = this.#focused;
		this.#updateResults();
	}

	get focused(): boolean {
		return this.#focused;
	}

	set focused(value: boolean) {
		this.#focused = value;
		this.#field.focused = value;
	}

	setUseTerminalCursor(useTerminalCursor: boolean): void {
		this.#field.setUseTerminalCursor(useTerminalCursor);
	}

	pasteText(text: string): void {
		this.#field.pasteText(text);
		this.#selectedIndex = 0;
		this.#updateResults();
	}

	handleInput(data: string): void {
		if (matchesSelectCancel(data) || matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) {
			this.#done(undefined);
			return;
		}
		if (matchesKey(data, Key.enter) || matchesKey(data, Key.return)) {
			this.#field.submit();
			return;
		}
		if (matchesSelectUp(data) || matchesKey(data, Key.up)) {
			if (this.#results.length > 0) {
				const next = Math.max(0, this.#selectedIndex - 1);
				if (next !== this.#selectedIndex) {
					this.#selectedIndex = next;
					this.#revision++;
				}
			}
			return;
		}
		if (matchesSelectDown(data) || matchesKey(data, Key.down)) {
			if (this.#results.length > 0) {
				const next = Math.min(this.#results.length - 1, this.#selectedIndex + 1);
				if (next !== this.#selectedIndex) {
					this.#selectedIndex = next;
					this.#revision++;
				}
			}
			return;
		}
		if (matchesKey(data, Key.tab)) {
			const selected = this.#results[this.#selectedIndex];
			if (selected) {
				this.#field.setValue(selected.value);
				this.#selectedIndex = 0;
				this.#updateResults();
			}
			return;
		}
		const before = this.#field.getValue();
		this.#field.handleInput(data);
		if (this.#field.getValue() !== before) {
			this.#selectedIndex = 0;
			this.#updateResults();
		}
	}

	render(width: number): readonly string[] {
		const w = width;
		const innerWidth = Math.max(1, w - 4);
		const fieldLines = this.#field.render(innerWidth);
		const memo = this.#renderMemo;
		if (memo?.width === w && memo.fieldLines === fieldLines && memo.revision === this.#revision) {
			return memo.lines;
		}
		const lines: string[] = [];

		lines.push(topBorder(w, "Move to directory"));
		for (const fieldLine of fieldLines) {
			lines.push(row(fieldLine, w));
		}
		lines.push(row("", w));

		if (this.#results.length === 0 && this.#field.getValue().length > 0) {
			lines.push(row(theme.fg("dim", "No matching directories"), w));
		} else {
			for (let i = 0; i < Math.min(this.#results.length, MAX_RESULTS); i++) {
				const item = this.#results[i]!;
				const selected = i === this.#selectedIndex;
				const marker = selected ? theme.fg("accent", "▶ ") : "  ";
				const label = selected ? theme.fg("accent", item.label) : theme.fg("text", item.label);
				lines.push(row(`${marker}${label}`, w));
			}
		}

		lines.push(row("", w));
		lines.push(row(theme.fg("dim", "Type to filter · ↑↓ navigate · Tab accept · Enter confirm · Esc cancel"), w));
		lines.push(bottomBorder(w));
		this.#renderMemo = { width: w, fieldLines, revision: this.#revision, lines };
		return lines;
	}

	invalidate(): void {
		this.#field.input.prompt = theme.fg("dim", "Path: ");
		this.#field.invalidate();
		this.#revision++;
		this.#renderMemo = undefined;
	}

	#updateResults(): void {
		this.#results = this.#source.search(this.#field.getValue(), this.#cwd, MAX_RESULTS + 5);
		this.#revision++;
		if (this.#selectedIndex >= this.#results.length) {
			this.#selectedIndex = Math.max(0, this.#results.length - 1);
		}
	}

	#confirm(): void {
		const selected = this.#results[this.#selectedIndex];
		if (selected) {
			this.#done({ directory: selected.value });
			return;
		}
		if (this.#field.getValue().trim().length > 0) {
			this.#done({ directory: this.#field.getValue().trim() });
			return;
		}
		this.#done(undefined);
	}
}
