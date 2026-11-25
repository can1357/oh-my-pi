/**
 * State of the reusable form controls: a text field, a select field and a
 * form that walks focus between fields. Components (`./field.tsx`) render
 * these; hosts drive them with keys and calls (`setValue`, `submit`, …).
 */
import { batch, computed, type KeyEvent, type Signal, signal, untrack } from "@oh-my-pi/pi-tui";
import { errorMessage } from "@oh-my-pi/pi-utils";
import { fuzzyFilter } from "../../utils/fuzzy";
import { editLine, type LineState } from "../overlays/settings/line-edit";
import { listKeyId, matchesSelectCancel } from "../../config/keybindings/matchers";
import { getKeybindings } from "../../config/keybindings/keybindings";

/** Longest error a field shows (cells, ellipsis included). */
const ERROR_MAX = 100;

/** An error message as one line: tabs as three spaces, line breaks as spaces, cut at {@link ERROR_MAX}. */
export function errorLine(message: string): string {
	const flat = message.replaceAll("\t", "   ").replace(/\r?\n/g, " ");
	return [...flat].length > ERROR_MAX ? `${[...flat].slice(0, ERROR_MAX - 1).join("")}…` : flat;
}

/** One masking bullet per character of a secret. */
export function maskSecret(text: string): string {
	return "•".repeat([...text].length);
}

export interface TextFieldOptions {
	readonly initialValue?: string;
	/** Show bullets instead of the text. */
	readonly secret?: boolean;
	/** `reject`: submitting an empty value shows "A value is required." */
	readonly empty?: "reject" | "allow";
	/** An error message for a value that may not be submitted. */
	readonly validate?: (value: string) => string | undefined;
	/** Throwing shows the error under the field. */
	readonly onSubmit?: (value: string) => void;
	readonly onCancel?: () => void;
	readonly focused?: boolean;
}

/** A one-line text field. */
export class TextFieldModel {
	readonly line: Signal<LineState>;
	readonly error = signal<string | undefined>(undefined);
	/** Whether the field holds focus (hardware cursor). */
	readonly focused: Signal<boolean>;
	readonly secret: boolean;
	readonly #options: TextFieldOptions;

	constructor(options: TextFieldOptions = {}) {
		this.#options = options;
		this.secret = options.secret === true;
		const text = options.initialValue ?? "";
		this.line = signal<LineState>({ text, cursor: text.length });
		this.focused = signal(options.focused === true);
	}

	get value(): string {
		return untrack(this.line).text;
	}

	setFocused(focused: boolean): void {
		this.focused.set(focused);
	}

	/** Replace the value (caret at the end); clears the error. */
	setValue(value: string): void {
		batch(() => {
			this.line.set({ text: value, cursor: value.length });
			this.error.set(undefined);
		});
	}

	setError(message: string | undefined): void {
		this.error.set(message === undefined ? undefined : errorLine(message));
	}

	/** Insert text at the caret (line breaks become spaces). */
	paste(text: string): void {
		const line = untrack(this.line);
		const flat = text.replace(/\r?\n/g, " ");
		this.line.set({
			text: line.text.slice(0, line.cursor) + flat + line.text.slice(line.cursor),
			cursor: line.cursor + flat.length,
		});
	}

	/** Validate and hand the value to `onSubmit`; a rejection shows as the field's error. */
	submit(): void {
		const value = this.value;
		if (value === "" && this.#options.empty === "reject") return this.setError("A value is required.");
		const invalid = this.#options.validate?.(value);
		if (invalid !== undefined) return this.setError(invalid);
		try {
			this.#options.onSubmit?.(value);
			this.setError(undefined);
		} catch (error) {
			this.setError(errorMessage(error));
		}
	}

	cancel(): void {
		this.#options.onCancel?.();
	}

	/** Edit through the visible text (a secret's edits address its bullets one per character). */
	edit(next: (shown: LineState) => LineState | undefined): void {
		const line = untrack(this.line);
		if (!this.secret) {
			const edited = next(line);
			if (edited) this.line.set(edited);
			return;
		}
		const chars = [...line.text];
		const caret = Array.from(line.text.slice(0, line.cursor)).length;
		const edited = next({ text: maskSecret(line.text), cursor: caret });
		if (!edited) return;
		// Bullets are one code unit each: map the edited bullet line back onto characters.
		const before = edited.text.length;
		const added = before - chars.length;
		if (added >= 0) {
			const at = edited.cursor - added;
			const shown = edited.text.slice(at, edited.cursor);
			chars.splice(at, 0, ...Array.from(shown));
		} else {
			const at = edited.cursor;
			chars.splice(at, -added);
		}
		const text = chars.join("");
		this.line.set({ text, cursor: chars.slice(0, edited.cursor).join("").length });
	}

	/** Field keys: Enter submits, Escape cancels, anything else edits the line. */
	key(key: KeyEvent): boolean {
		if (getKeybindings().matches(key, "tui.input.submit")) {
			this.submit();
			return true;
		}
		if (matchesSelectCancel(key)) {
			this.cancel();
			return true;
		}
		let handled = false;
		this.edit(line => {
			const next = editLine(line, key);
			handled = next !== undefined;
			return next;
		});
		return handled;
	}
}

/** One option of a select field. */
export interface SelectFieldItem {
	readonly value: string;
	readonly label: string;
	readonly description?: string;
}

export interface SelectFieldOptions {
	readonly items: readonly SelectFieldItem[];
	readonly currentValue?: string;
	/** Rows of the list before it scrolls (and type-to-search turns on). Default 10. */
	readonly maxVisible?: number;
	readonly onSelectionChange?: (value: string) => void;
	/** Throwing shows the error under the field. */
	readonly onSubmit?: (value: string) => void;
	readonly onCancel?: () => void;
}

/** A list of options with type-to-search once it overflows. */
export class SelectFieldModel {
	readonly items: readonly SelectFieldItem[];
	readonly maxVisible: number;
	readonly query = signal("");
	readonly selected: Signal<string | undefined>;
	readonly error = signal<string | undefined>(undefined);
	/** Options matching the query, best first. */
	readonly visible = computed(() => {
		const query = this.query().trim();
		if (!query) return this.items;
		return fuzzyFilter([...this.items], query, item => `${item.label} ${item.description ?? ""}`);
	});
	readonly #options: SelectFieldOptions;

	constructor(options: SelectFieldOptions) {
		this.#options = options;
		this.items = options.items;
		this.maxVisible = options.maxVisible ?? 10;
		const current = options.items.find(item => item.value === options.currentValue) ?? options.items[0];
		this.selected = signal(current?.value);
	}

	/** Whether typing filters the list (more options than rows). */
	get searchable(): boolean {
		return this.items.length > this.maxVisible;
	}

	/** Highlight `value` (when it is listed). */
	select(value: string): void {
		if (!untrack(this.visible).some(item => item.value === value)) return;
		if (untrack(this.selected) === value) return;
		batch(() => {
			this.selected.set(value);
			this.error.set(undefined);
		});
		this.#options.onSelectionChange?.(value);
	}

	move(delta: number): void {
		const visible = untrack(this.visible);
		if (visible.length === 0) return;
		const at = visible.findIndex(item => item.value === untrack(this.selected));
		const next = (Math.max(0, at) + delta + visible.length) % visible.length;
		this.select(visible[next]!.value);
	}

	setQuery(query: string): void {
		batch(() => {
			this.query.set(query);
			// The highlight stays on its option while it still matches, else moves to the best match.
			const visible = untrack(this.visible);
			if (!visible.some(item => item.value === untrack(this.selected)) && visible[0]) this.select(visible[0].value);
		});
	}

	submit(): void {
		const value = untrack(this.selected);
		if (value === undefined || !untrack(this.visible).some(item => item.value === value)) return;
		try {
			this.#options.onSubmit?.(value);
			this.error.set(undefined);
		} catch (error) {
			this.error.set(errorLine(errorMessage(error)));
		}
	}

	key(key: KeyEvent): boolean {
		switch (listKeyId(key)) {
			case "up":
				this.move(-1);
				return true;
			case "down":
				this.move(1);
				return true;
			case "enter":
				this.submit();
				return true;
			case "escape":
				this.#options.onCancel?.();
				return true;
			case "backspace": {
				const query = untrack(this.query);
				if (!this.searchable || query === "") return false;
				this.setQuery([...query].slice(0, -1).join(""));
				return true;
			}
		}
		const typed = key.text;
		if (!this.searchable || typed === undefined || typed === "" || /[\x00-\x1f\x7f]/.test(typed)) return false;
		this.setQuery(untrack(this.query) + typed);
		return true;
	}
}

/** Fields of a form, one focused at a time; Tab / Shift+Tab walk them. */
export class FormModel {
	readonly fields: readonly TextFieldModel[];
	readonly active = signal(0);
	readonly focused: Signal<boolean>;
	readonly #onCancel: () => void;

	constructor(options: { fields: readonly TextFieldModel[]; onCancel: () => void; focused?: boolean }) {
		this.fields = options.fields;
		this.#onCancel = options.onCancel;
		this.focused = signal(options.focused === true);
		this.#sync();
	}

	#sync(): void {
		const active = untrack(this.active);
		const focused = untrack(this.focused);
		this.fields.forEach((field, index) => {
			field.focused.set(focused && index === active);
		});
	}

	setFocused(focused: boolean): void {
		batch(() => {
			this.focused.set(focused);
			this.#sync();
		});
	}

	focusField(index: number): void {
		if (index < 0 || index >= this.fields.length) return;
		batch(() => {
			this.active.set(index);
			this.#sync();
		});
	}

	paste(text: string): void {
		this.fields[untrack(this.active)]?.paste(text);
	}

	key(key: KeyEvent): boolean {
		const count = this.fields.length;
		if (matchesSelectCancel(key)) {
			this.#onCancel();
			return true;
		}
		if (count === 0) return false;
		if (key.id === "tab") {
			this.focusField((untrack(this.active) + 1) % count);
			return true;
		}
		if (key.id === "shift+tab") {
			this.focusField((untrack(this.active) - 1 + count) % count);
			return true;
		}
		return this.fields[untrack(this.active)]!.key(key);
	}
}
