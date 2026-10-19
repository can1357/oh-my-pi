/**
 * One-line text prompt an extension (hook) asks the user.
 */
import { type Component, Spacer, Text, type TUI } from "../index";
import { matchesAppInterrupt } from "../keybinding-matchers";
import { CountdownTimer } from "../chrome/countdown-timer";
import { formTheme } from "../chrome/form-theme";
import { OverlayPanel } from "../chrome/overlay-box";
import { Form, TextFormField } from "../components/form";
import { boundKeys, editorKey, interruptKey } from "../chrome/keybinding-hints";
import { getKeybindings } from "../keybindings";
import { col, node, span } from "../native/describe";
import type { DescribeContext, NativeChild, NativeNode, NativeUiEvent } from "../native/node";
import { actionBar, actionButton } from "../native/overlay";
import { plainText } from "../native/spans";

/** Role prefix of the sheet's parts (`omp.hook-input.head`, `.title`, `.timer`, `.detail`, `.field`). */
const PART = "omp.hook-input";

export interface HookInputOptions {
	tui?: TUI;
	timeout?: number;
	onTimeout?: () => void;
}

/** Terminal-only key legend under the field; a native terminal puts the keys in the buttons' tooltips. */
class KeyLegend implements Component {
	readonly #text = new Text("", 0, 0);

	constructor(private readonly legend: string) {
		this.invalidate();
	}

	render(width: number): readonly string[] {
		return this.#text.render(width);
	}

	invalidate(): void {
		this.#text.setText(formTheme.hint(this.legend));
		this.#text.invalidate();
	}
}

interface HookInputNativeMemo {
	countdown: NativeNode | undefined;
	error: boolean;
	node: NativeNode;
}

export class HookInputComponent extends OverlayPanel {
	#field: TextFormField;
	#form: Form;
	#onSubmitCallback: (value: string) => void;
	#onCancelCallback: () => void;
	#baseTitle: string;
	#countdown: CountdownTimer | undefined;
	#nativeMemo: HookInputNativeMemo | undefined;
	#nativeActions: NativeNode | undefined;

	constructor(
		title: string,
		placeholder: string | undefined,
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
			empty: "submit",
			onSubmit: value => this.#onSubmitCallback(value),
			onCancel: () => this.#onCancelCallback(),
		});
		// Native terminals draw it while the value is empty; the terminal row stays bare.
		this.#field.input.placeholder = placeholder?.trim() || undefined;
		this.#form = new Form({
			fields: [this.#field],
			onCancel: () => this.#onCancelCallback(),
			isCancel: matchesAppInterrupt,
		});
		this.addChild(this.#form);
		this.addChild(new KeyLegend(`${editorKey("tui.input.submit")} submit  ${interruptKey()} cancel`));
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

	/** Submit and Cancel run what Enter and the interrupt key run. */
	handleNativeEvent(event: NativeUiEvent): void {
		if (event.type !== "action") return;
		if (event.act === "submit") {
			this.#countdown?.reset();
			this.#field.submit();
		} else if (event.act === "cancel") {
			this.#onCancelCallback();
		}
	}

	override dispose(): void {
		this.#countdown?.dispose();
		super.dispose();
	}

	/**
	 * A sheet in the composer's place, built like the extension editor's: the
	 * title's first line (the countdown at its end while a timeout runs) over
	 * any further lines as detail, the field written on the sheet (tinted, the
	 * reason under it, while a submit was refused), and Cancel · Submit, whose
	 * keys live in their tooltips.
	 */
	override describe(_cx: DescribeContext): NativeNode {
		const countdown = this.#countdown?.describe();
		const error = this.#field.hasError;
		const memo = this.#nativeMemo;
		if (memo && memo.countdown === countdown && memo.error === error) return memo.node;
		const [titleLine = "", ...detailLines] = plainText(this.#baseTitle).trim().split(/\r?\n/);
		const titleRow: NativeChild[] = [
			node(
				"text",
				{ spans: [span(titleLine.trim())], role: `${PART}.title`, wrap: "word", grow: 1 },
				undefined,
				"title",
			),
		];
		if (countdown) {
			titleRow.push(
				node(
					"row",
					{ role: `${PART}.timer`, title: "Cancels when the time runs out; typing restarts it" },
					[countdown],
					"timer",
				),
			);
		}
		const head: NativeChild[] = [node("row", { gap: "md", align: "baseline" }, titleRow, "line")];
		const detail = detailLines.join("\n").trim();
		if (detail) {
			head.push(node("text", { spans: [span(detail)], role: `${PART}.detail`, wrap: "word" }, undefined, "detail"));
		}
		const root = col(
			[
				node("col", { role: `${PART}.head`, gap: "xs" }, head, "head"),
				node("col", { role: `${PART}.field`, ...(error ? { tone: "error" as const } : {}) }, [this.#form], "field"),
				this.#describeActions(),
			],
			{ role: this.nativeRole },
		);
		this.#nativeMemo = { countdown, error, node: root };
		return root;
	}

	#describeActions(): NativeNode {
		if (this.#nativeActions) return this.#nativeActions;
		const submitKey = getKeybindings().getKeys("tui.input.submit")[0];
		const cancelKey = boundKeys("app.interrupt", ["escape"])[0];
		this.#nativeActions = actionBar([
			null,
			actionButton("Cancel", "cancel", cancelKey ? { keys: cancelKey } : {}),
			actionButton("Submit", "submit", { tone: "accent", ...(submitKey ? { keys: submitKey } : {}) }),
		]);
		return this.#nativeActions;
	}
}
