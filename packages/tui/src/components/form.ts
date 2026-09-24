import { getKeybindings } from "../keybindings";
import { matchesKey } from "../keys";
import type { MouseRoutable, SgrMouseEvent } from "../mouse";
import { Container, type Component, type Focusable } from "../tui";
import { replaceTabs, truncateToWidth } from "../utils";
import { Input } from "./input";
import { type SelectItem, SelectList, type SelectListTheme } from "./select-list";
import { Spacer } from "./spacer";
import { Text } from "./text";
import { localizeTuiText } from "../i18n";

/** Styling hooks used by the reusable form-field layout. */
export interface FormFieldTheme {
	label(text: string): string;
	description(text: string): string;
	error(text: string): string;
	hint(text: string): string;
}

/** Interactive control accepted by {@link FormField}. */
export type FormControl = Component &
	Partial<Focusable> & {
		handleInput(data: string): void;
		pasteText?(text: string): void;
	};

/** Declarative label, help, preview, and footer content surrounding a control. */
export interface FormFieldOptions {
	theme: FormFieldTheme;
	label?: string;
	description?: string;
	details?: readonly Component[];
	previewLabel?: string;
	preview?: Component;
	hint?: string;
	/** Read-only rows rendered after the control and before the interaction hint. */
	summary?: readonly Component[];
	footer?: Component;
	/** Insert a blank row before the field's label/description/detail content. */
	leadingSpace?: boolean;
	spaceBeforeControl?: boolean;
	spaceAfterControl?: boolean;
}

function hasMouseRouter(component: FormControl): component is FormControl & MouseRoutable {
	return "routeMouse" in component && typeof component.routeMouse === "function";
}

class StyledText implements Component {
	readonly #text: Text;
	#value: string;

	constructor(
		value: string,
		private readonly style: (text: string) => string,
	) {
		this.#value = value;
		this.#text = new Text(this.style(value), 0, 0);
	}

	setText(value: string): void {
		if (value === this.#value) return;
		this.#value = value;
		this.#text.setText(this.style(value));
	}

	render(width: number): readonly string[] {
		return this.#text.render(width);
	}

	invalidate(): void {
		this.#text.setText(this.style(this.#value));
		this.#text.invalidate();
	}
}

class OptionalText implements Component {
	readonly #text: StyledText;
	#value = "";
	readonly #empty: readonly string[] = [];

	constructor(style: (text: string) => string) {
		this.#text = new StyledText("", style);
	}

	setText(value: string): void {
		if (value === this.#value) return;
		this.#value = value;
		this.#text.setText(value);
	}

	render(width: number): readonly string[] {
		return this.#value ? this.#text.render(width) : this.#empty;
	}

	invalidate(): void {
		this.#text.invalidate();
	}
}

/**
 * Layout and focus adapter for one form control. The control remains a normal
 * component; this class only owns shared form chrome and local mouse routing.
 */
export class FormField implements Component, Focusable, MouseRoutable {
	readonly control: FormControl;
	readonly #beforeControl = new Container();
	readonly #afterControl = new Container();
	readonly #error: OptionalText;
	#focused = false;
	#controlLineOffset = 0;
	#controlLineCount = 0;
	#memoWidth = -1;
	#memoBefore: readonly string[] | undefined;
	#memoControl: readonly string[] | undefined;
	#memoAfter: readonly string[] | undefined;
	#memoLines: readonly string[] = [];

	constructor(control: FormControl, options: FormFieldOptions) {
		this.control = control;
		this.#error = new OptionalText(options.theme.error);

		if (options.leadingSpace) this.#beforeControl.addChild(new Spacer(1));
		if (options.label) {
			this.#beforeControl.addChild(new StyledText(localizeTuiText(options.label), options.theme.label));
		}
		if (options.description) {
			if (options.label) this.#beforeControl.addChild(new Spacer(1));
			this.#beforeControl.addChild(new StyledText(localizeTuiText(options.description), options.theme.description));
		}
		for (const detail of options.details ?? []) this.#beforeControl.addChild(detail);
		if (options.preview) {
			this.#beforeControl.addChild(new Spacer(1));
			if (options.previewLabel) {
				this.#beforeControl.addChild(
					new StyledText(localizeTuiText(options.previewLabel), options.theme.description),
				);
			}
			this.#beforeControl.addChild(options.preview);
		}
		if (options.spaceBeforeControl !== false) this.#beforeControl.addChild(new Spacer(1));

		if (options.spaceAfterControl !== false) this.#afterControl.addChild(new Spacer(1));
		this.#afterControl.addChild(this.#error);
		for (const summary of options.summary ?? []) this.#afterControl.addChild(summary);
		if (options.hint) this.#afterControl.addChild(new StyledText(localizeTuiText(options.hint), options.theme.hint));
		if (options.footer) {
			this.#afterControl.addChild(new Spacer(1));
			this.#afterControl.addChild(options.footer);
		}
	}

	get focused(): boolean {
		return this.#focused;
	}

	get debugChildren(): readonly Component[] {
		return [this.control];
	}

	set focused(value: boolean) {
		this.#focused = value;
		if ("focused" in this.control) this.control.focused = value;
	}

	setUseTerminalCursor(useTerminalCursor: boolean): void {
		this.control.setUseTerminalCursor?.(useTerminalCursor);
	}

	/** Show a bounded, single-line validation or submission error. */
	setError(message: string | undefined): void {
		const safe = message
			? truncateToWidth(
					replaceTabs(message)
						.replace(/[\r\n]+/g, " ")
						.trim(),
					100,
				)
			: "";
		this.#error.setText(safe);
	}

	handleInput(data: string): void {
		this.control.handleInput(data);
	}

	pasteText(text: string): void {
		this.control.pasteText?.(text);
	}

	/** Translate a field-local row to its control-local row, excluding all surrounding chrome. */
	controlLineAt(line: number): number | undefined {
		if (line < this.#controlLineOffset || line >= this.#controlLineOffset + this.#controlLineCount) {
			return undefined;
		}
		return line - this.#controlLineOffset;
	}

	routeMouse(event: SgrMouseEvent, line: number, col: number): void {
		const controlLine = this.controlLineAt(line);
		if (controlLine === undefined) return;
		if (hasMouseRouter(this.control)) {
			this.control.routeMouse(event, controlLine, col);
		}
	}

	render(width: number): readonly string[] {
		const renderWidth = Math.max(1, width);
		const before = this.#beforeControl.render(renderWidth);
		const control = this.control.render(renderWidth);
		const after = this.#afterControl.render(renderWidth);
		this.#controlLineOffset = before.length;
		this.#controlLineCount = control.length;
		if (
			this.#memoWidth === renderWidth &&
			this.#memoBefore === before &&
			this.#memoControl === control &&
			this.#memoAfter === after
		) {
			return this.#memoLines;
		}
		this.#memoWidth = renderWidth;
		this.#memoBefore = before;
		this.#memoControl = control;
		this.#memoAfter = after;
		this.#memoLines = [...before, ...control, ...after];
		return this.#memoLines;
	}

	setIgnoreTight(ignore: boolean): this {
		this.#beforeControl.setIgnoreTight(ignore);
		this.control.setIgnoreTight?.(ignore);
		this.#afterControl.setIgnoreTight(ignore);
		this.#memoWidth = -1;
		return this;
	}

	invalidate(): void {
		this.#beforeControl.invalidate();
		this.control.invalidate?.();
		this.#afterControl.invalidate();
		this.#memoWidth = -1;
	}

	dispose(): void {
		this.#beforeControl.dispose();
		this.control.dispose?.();
		this.#afterControl.dispose();
	}
}

/** Behavior used when a single-line field is submitted with an empty value. */
export type EmptyInputBehavior = "submit" | "cancel" | "reject";

/** Options for a validated, cancellable single-line field. */
export interface TextFormFieldOptions extends Omit<FormFieldOptions, "preview"> {
	initialValue?: string;
	secret?: boolean;
	prompt?: string;
	empty?: EmptyInputBehavior;
	emptyError?: string;
	validate?: (value: string) => string | undefined;
	onSubmit(value: string): void | Promise<void>;
	onCancel(): void;
	/** Schedule a frame after an asynchronous submit settles. */
	requestRender?: () => void;
}

/**
 * Single-line form field backed by {@link Input}. Validation and thrown submit
 * errors stay visible on the field; empty-value policy is explicit per caller.
 */
export class TextFormField extends FormField {
	readonly input: Input;
	readonly #options: TextFormFieldOptions;

	constructor(options: TextFormFieldOptions) {
		const input = new Input();
		input.mask = options.secret ?? false;
		if (options.prompt !== undefined) input.prompt = options.prompt;
		if (options.initialValue) input.setValue(options.initialValue);
		super(input, options);
		this.input = input;
		this.#options = options;
		input.onSubmit = () => this.submit();
		input.onEscape = options.onCancel;
	}

	getValue(): string {
		return this.input.getValue();
	}

	setValue(value: string): void {
		this.input.setValue(value);
		this.setError(undefined);
	}

	/** Validate and submit the current value according to the configured empty policy. */
	submit(): void {
		const value = this.input.getValue();
		if (value.trim().length === 0) {
			const empty = this.#options.empty ?? "submit";
			if (empty === "cancel") {
				this.#options.onCancel();
				return;
			}
			if (empty === "reject") {
				this.setError(this.#options.emptyError ?? "A value is required.");
				return;
			}
		}

		try {
			const validationError = this.#options.validate?.(value);
			if (validationError) {
				this.setError(validationError);
				return;
			}
			const result = this.#options.onSubmit(value);
			if (result) {
				void result.then(
					() => {
						this.setError(undefined);
						this.#options.requestRender?.();
					},
					error => {
						this.setError(error instanceof Error ? error.message : String(error));
						this.#options.requestRender?.();
					},
				);
			} else {
				this.setError(undefined);
			}
		} catch (error) {
			this.setError(error instanceof Error ? error.message : String(error));
		}
	}
}

/** Options for a SelectList-backed form field with optional live preview. */
export interface SelectFormFieldOptions extends Omit<FormFieldOptions, "preview"> {
	items: ReadonlyArray<SelectItem>;
	currentValue?: string;
	maxVisible?: number;
	selectTheme: SelectListTheme;
	getPreview?: () => string;
	onSelectionChange?: (value: string) => void | Promise<void>;
	onSubmit(value: string): void | Promise<void>;
	onCancel(): void;
	/** Schedule a frame after an asynchronous preview update settles. */
	requestRender?: () => void;
}

/** SelectList field that centralizes selection, cancellation, preview refresh, and mouse routing. */
export class SelectFormField extends FormField {
	readonly selectList: SelectList;
	readonly #previewText: StyledText | undefined;
	readonly #getPreview: (() => string) | undefined;
	readonly #requestRender: (() => void) | undefined;
	#previewRequestId = 0;

	constructor(options: SelectFormFieldOptions) {
		const selectList = new SelectList(
			options.items,
			Math.min(options.items.length || 1, options.maxVisible ?? 10),
			options.selectTheme,
		);
		const currentIndex = options.items.findIndex(item => item.value === options.currentValue);
		if (currentIndex !== -1) selectList.setSelectedIndex(currentIndex);

		const previewText = options.getPreview ? new StyledText(options.getPreview(), text => text) : undefined;
		super(selectList, {
			...options,
			previewLabel: previewText ? (options.previewLabel ?? "Preview:") : undefined,
			preview: previewText,
		});
		this.selectList = selectList;
		this.#previewText = previewText;
		this.#getPreview = options.getPreview;
		this.#requestRender = options.requestRender;

		selectList.onSelect = item => {
			try {
				const result = options.onSubmit(item.value);
				if (result) {
					void result.then(
						() => {
							this.setError(undefined);
							this.#requestRender?.();
						},
						error => {
							this.setError(error instanceof Error ? error.message : String(error));
							this.#requestRender?.();
						},
					);
				} else {
					this.setError(undefined);
				}
			} catch (error) {
				this.setError(error instanceof Error ? error.message : String(error));
			}
		};
		selectList.onCancel = options.onCancel;
		if (options.onSelectionChange) {
			selectList.onSelectionChange = item => {
				const requestId = ++this.#previewRequestId;
				try {
					const result = options.onSelectionChange?.(item.value);
					if (result) {
						void result.then(
							() => this.#finishPreview(requestId),
							error => this.#failPreview(requestId, error),
						);
						return;
					}
					this.#finishPreview(requestId);
				} catch (error) {
					this.#failPreview(requestId, error);
				}
			};
		}
	}

	override invalidate(): void {
		this.#updatePreview();
		super.invalidate();
	}

	#finishPreview(requestId: number): void {
		if (requestId !== this.#previewRequestId) return;
		this.setError(undefined);
		this.#updatePreview();
		this.#requestRender?.();
	}

	#failPreview(requestId: number, error: unknown): void {
		if (requestId !== this.#previewRequestId) return;
		this.setError(error instanceof Error ? error.message : String(error));
		this.#requestRender?.();
	}

	#updatePreview(): void {
		if (!this.#previewText || !this.#getPreview) return;
		this.#previewText.setText(this.#getPreview());
	}
}

/** Options for focus and input dispatch across several composable fields. */
export interface FormOptions {
	fields: readonly FormField[];
	onCancel(): void;
	isCancel?: (data: string) => boolean;
}

interface FormFieldBounds {
	start: number;
	end: number;
}

/**
 * Small form controller for multi-field surfaces. It owns focus traversal,
 * field-local mouse routing, and cancellation while fields retain submit policy.
 */
export class Form implements Component, Focusable, MouseRoutable {
	readonly #fields: readonly FormField[];
	readonly #options: FormOptions;
	#activeIndex = 0;
	#focused = false;
	#bounds: FormFieldBounds[] = [];
	#memoWidth = -1;
	#memoFieldLines: (readonly string[])[] = [];
	#memoLines: readonly string[] = [];

	constructor(options: FormOptions) {
		this.#options = options;
		this.#fields = options.fields;
		this.#syncFocus();
	}

	get focused(): boolean {
		return this.#focused;
	}

	get debugChildren(): readonly Component[] {
		return this.#fields;
	}

	set focused(value: boolean) {
		this.#focused = value;
		this.#syncFocus();
	}

	setUseTerminalCursor(useTerminalCursor: boolean): void {
		this.#fields[this.#activeIndex]?.setUseTerminalCursor(useTerminalCursor);
	}

	handleInput(data: string): void {
		const isCancel = this.#options.isCancel?.(data) ?? getKeybindings().matches(data, "tui.select.cancel");
		if (isCancel) {
			this.#options.onCancel();
			return;
		}
		if (this.#fields.length > 1 && (matchesKey(data, "tab") || matchesKey(data, "shift+tab"))) {
			const delta = matchesKey(data, "shift+tab") ? -1 : 1;
			this.#activeIndex = (this.#activeIndex + delta + this.#fields.length) % this.#fields.length;
			this.#syncFocus();
			return;
		}
		this.#fields[this.#activeIndex]?.handleInput(data);
	}

	pasteText(text: string): void {
		this.#fields[this.#activeIndex]?.pasteText(text);
	}

	routeMouse(event: SgrMouseEvent, line: number, col: number): void {
		const index = this.#bounds.findIndex(bounds => line >= bounds.start && line < bounds.end);
		if (index === -1) return;
		if (event.leftClick && index !== this.#activeIndex) {
			this.#activeIndex = index;
			this.#syncFocus();
		}
		const bounds = this.#bounds[index]!;
		this.#fields[index]!.routeMouse(event, line - bounds.start, col);
	}

	render(width: number): readonly string[] {
		const renderWidth = Math.max(1, width);
		const fieldLines = this.#fields.map(field => field.render(renderWidth));
		this.#bounds = [];
		let line = 0;
		for (const lines of fieldLines) {
			this.#bounds.push({ start: line, end: line + lines.length });
			line += lines.length;
		}
		if (
			this.#memoWidth === renderWidth &&
			fieldLines.length === this.#memoFieldLines.length &&
			fieldLines.every((lines, index) => lines === this.#memoFieldLines[index])
		) {
			return this.#memoLines;
		}
		this.#memoWidth = renderWidth;
		this.#memoFieldLines = fieldLines;
		this.#memoLines = fieldLines.flat();
		return this.#memoLines;
	}

	setIgnoreTight(ignore: boolean): this {
		for (const field of this.#fields) field.setIgnoreTight(ignore);
		this.#memoWidth = -1;
		return this;
	}

	invalidate(): void {
		for (const field of this.#fields) field.invalidate();
		this.#memoWidth = -1;
	}

	dispose(): void {
		for (const field of this.#fields) field.dispose();
	}

	#syncFocus(): void {
		for (let index = 0; index < this.#fields.length; index++) {
			this.#fields[index]!.focused = this.#focused && index === this.#activeIndex;
		}
	}
}
