/**
 * Tightly scoped adapter for one-shot standalone TUI prompts.
 *
 * Owns the `ProcessTerminal`/`TUI` lifecycle (mount, idempotent finish,
 * teardown) so individual pickers only declare their form field. Styling goes
 * through {@link fgOrPlain} and {@link getSelectListTheme}, both of which are
 * safe before theme initialization, so standalone paths never initialize the
 * global theme.
 */
import type { SelectItem } from "../components/select-list";
import { Form, SelectFormField, TextFormField, type FormFieldTheme } from "../components/form";
import type { DescribeContext, NativeNode, NativeUiEvent } from "../native/node";
import { SelectListSheet, type SelectPickerOptions } from "../native/picker";
import { ProcessTerminal } from "../terminal";
import { TUI, type Component, type OverlayOptions } from "../tui";
import { getSelectListTheme } from "../theme/tui-adapters";
import { fgOrPlain } from "../theme/theme";

/** Build context for a standalone prompt: the owned UI plus its resolver. */
export interface StandaloneTuiContext<T> {
	ui: TUI;
	/** Idempotent: stops the UI and resolves the runner promise with `value`. */
	finish: (value: T) => void;
}

/** Presentation controls for a standalone prompt. */
export interface StandaloneTuiOptions {
	/** Present the component as an overlay instead of a plain child. */
	overlay?: OverlayOptions;
}

/** Plain-safe field chrome: unstyled text until a theme is initialized. */
const STANDALONE_FIELD_THEME: FormFieldTheme = {
	label: text => fgOrPlain("accent", text),
	description: text => fgOrPlain("muted", text),
	error: text => fgOrPlain("error", text),
	hint: text => fgOrPlain("dim", text),
};

/**
 * Run a one-shot TUI component built from `{ ui, finish }` until `finish` is
 * called, then tear the UI down and resolve with the finished value.
 */
export async function runStandaloneTui<T>(
	build: (context: StandaloneTuiContext<T>) => Component,
	options?: StandaloneTuiOptions,
): Promise<T> {
	const { promise, resolve } = Promise.withResolvers<T>();
	const ui = new TUI(new ProcessTerminal());
	let settled = false;
	const finish = (value: T): void => {
		if (settled) return;
		settled = true;
		ui.stop();
		resolve(value);
	};
	const component = build({ ui, finish });
	if (options?.overlay) ui.showOverlay(component, options.overlay);
	else ui.addChild(component);
	ui.setFocus(component);
	ui.start();
	return promise;
}

/** Options for a standalone single-column item picker. */
export interface StandaloneSelectOptions {
	currentValue?: string;
	maxVisible?: number;
	/** How the native picker sheet names and marks its items (`noun`, `icon`). */
	picker?: Pick<SelectPickerOptions, "noun" | "icon" | "subtitle" | "confirm">;
}

/**
 * A standalone choice: the form's list in ANSI, and in Tern a `picker md`
 * sheet (NATIVE_REDESIGN §10) over the pane, whatever the item count. Keys
 * stay the form's; pointer events drive the same list.
 */
class StandaloneSelect implements Component {
	readonly #form: Form;
	readonly #sheet: SelectListSheet;

	constructor(form: Form, field: SelectFormField, picker: SelectPickerOptions) {
		this.#form = form;
		this.#sheet = new SelectListSheet(field.selectList, picker);
	}

	get focused(): boolean {
		return this.#form.focused;
	}

	set focused(value: boolean) {
		this.#form.focused = value;
	}

	describe(cx: DescribeContext): NativeNode {
		return cx.supports("picker") ? this.#sheet.describe() : this.#form.describe(cx);
	}

	handleNativeEvent(event: NativeUiEvent): void {
		this.#sheet.handle(event);
	}

	handleInput(data: string): void {
		this.#form.handleInput(data);
	}

	render(width: number): readonly string[] {
		return this.#form.render(width);
	}

	invalidate(): void {
		this.#sheet.invalidate();
		this.#form.invalidate();
	}
}

/**
 * Show a single-column item picker and resolve with the chosen item's value,
 * or `null` if the user cancelled.
 */
export async function selectStandaloneItem(
	title: string,
	items: SelectItem[],
	options?: StandaloneSelectOptions,
): Promise<string | null> {
	process.stdout.write(`${title}\n`);
	return runStandaloneTui<string | null>(({ finish }) => {
		const field = new SelectFormField({
			theme: STANDALONE_FIELD_THEME,
			items,
			currentValue: options?.currentValue,
			maxVisible: options?.maxVisible ?? 10,
			selectTheme: getSelectListTheme(),
			spaceBeforeControl: false,
			spaceAfterControl: false,
			onSubmit: value => finish(value),
			onCancel: () => finish(null),
		});
		const form = new Form({ fields: [field], onCancel: () => finish(null) });
		return new StandaloneSelect(form, field, {
			title: title.replace(/:\s*$/, ""),
			searchable: true,
			...(options?.currentValue !== undefined ? { current: [options.currentValue] } : {}),
			...options?.picker,
		});
	});
}

/**
 * Show a one-shot text prompt and resolve with the trimmed input, or `null`
 * when cancelled or left empty.
 */
export async function promptStandaloneText(title: string): Promise<string | null> {
	process.stdout.write(`${title}\n`);
	return runStandaloneTui<string | null>(({ finish }) => {
		const field = new TextFormField({
			theme: STANDALONE_FIELD_THEME,
			spaceBeforeControl: false,
			spaceAfterControl: false,
			onSubmit: value => finish(value.trim() || null),
			onCancel: () => finish(null),
		});
		return new Form({ fields: [field], onCancel: () => finish(null) });
	});
}
