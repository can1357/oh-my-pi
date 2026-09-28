/**
 * Simple text input component for hooks.
 */
import { Spacer, type TUI } from "../index";
import { matchesAppInterrupt } from "../keybinding-matchers";
import { CountdownTimer } from "../chrome/countdown-timer";
import { formTheme } from "../chrome/form-theme";
import { OverlayPanel } from "../chrome/overlay-box";
import { Form, TextFormField } from "../components/form";
import { editorKey, interruptKey } from "../chrome/keybinding-hints";

export interface HookInputOptions {
	tui?: TUI;
	timeout?: number;
	onTimeout?: () => void;
}

export class HookInputComponent extends OverlayPanel {
	#field: TextFormField;
	#form: Form;
	#onSubmitCallback: (value: string) => void;
	#onCancelCallback: () => void;
	#baseTitle: string;
	#countdown: CountdownTimer | undefined;

	constructor(
		title: string,
		_placeholder: string | undefined,
		onSubmit: (value: string) => void,
		onCancel: () => void,
		opts?: HookInputOptions,
	) {
		super(title);

		this.#onSubmitCallback = onSubmit;
		this.#onCancelCallback = onCancel;
		this.#baseTitle = title;

		if (opts?.timeout && opts.timeout > 0 && opts.tui) {
			this.#countdown = new CountdownTimer(
				opts.timeout,
				opts.tui,
				s => (this.title = `${this.#baseTitle} (${s}s)`),
				() => {
					opts.onTimeout?.();
					this.#onCancelCallback();
				},
			);
		}

		this.#field = new TextFormField({
			theme: formTheme,
			hint: `${editorKey("tui.input.submit")} submit  ${interruptKey()} cancel`,
			empty: "submit",
			onSubmit: value => this.#onSubmitCallback(value),
			onCancel: () => this.#onCancelCallback(),
		});
		this.#form = new Form({
			fields: [this.#field],
			onCancel: () => this.#onCancelCallback(),
			isCancel: matchesAppInterrupt,
		});
		this.addChild(this.#form);
		this.addChild(new Spacer(1));
	}

	handleInput(keyData: string): void {
		// Reset countdown on any interaction
		this.#countdown?.reset();
		this.#form.handleInput(keyData);
	}

	/** Route non-bracketed paste transports (e.g. kitty's OSC 5522 enhanced clipboard)
	 *  into the inner field, mirroring bracketed-paste semantics. Pasting counts as
	 *  interaction, so the timeout countdown resets like any keystroke. */
	pasteText(text: string): void {
		this.#countdown?.reset();
		this.#form.pasteText(text);
	}

	override dispose(): void {
		this.#countdown?.dispose();
		super.dispose();
	}
}
