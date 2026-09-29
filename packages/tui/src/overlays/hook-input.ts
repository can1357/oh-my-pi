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
import { node } from "../native/describe";
import type { DescribeContext, NativeNode } from "../native/node";
import { overlayCard } from "../native/overlay";
import { plainText } from "../native/spans";

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
	#nativeMemo: { countdown: NativeNode | undefined; node: NativeNode } | undefined;

	constructor(
		title: string,
		_placeholder: string | undefined,
		onSubmit: (value: string) => void,
		onCancel: () => void,
		opts?: HookInputOptions,
	) {
		super(title, "omp.overlay.hook-input");

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

	/** A card over the form, headed by the title plus the countdown `elapsed` while a timeout runs. */
	override describe(_cx: DescribeContext): NativeNode {
		const countdown = this.#countdown?.describe();
		const memo = this.#nativeMemo;
		if (memo && memo.countdown === countdown) return memo.node;
		const title = plainText(this.#baseTitle);
		const root = countdown
			? overlayCard(this.nativeRole, undefined, [
					node("row", { gap: "sm", align: "baseline" }, [node("text", { text: title }), countdown], "head"),
					this.#form,
				])
			: overlayCard(this.nativeRole, title, [this.#form]);
		this.#nativeMemo = { countdown, node: root };
		return root;
	}
}
