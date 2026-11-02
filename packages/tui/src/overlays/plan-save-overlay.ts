import { type Component, CURSOR_MARKER, type Focusable, Input, truncateToWidth, visibleWidth } from "../index";
import { theme } from "../theme/theme";
import { OverlayPanel, PanelRows } from "../chrome/overlay-box";
import { editorKey } from "../chrome/keybinding-hints";
import { col, keyed, span, text } from "../native/describe";
import type { NativeChild, NativeNode, NativeUiEvent } from "../native/node";
import { actionBar, actionButton } from "../native/overlay";
import { getKeybindings } from "../keybindings";

/** A confirmed destination chosen from {@link PlanSaveOverlay}. */
export interface PlanSaveOverlayResult {
	path: string;
}

/** Collects a destination path before saving a plan and starting a new session. */
export class PlanSaveOverlay implements Component, Focusable {
	#input = new Input();
	#suggestedPath: string;
	#done: (result: PlanSaveOverlayResult | undefined) => void;
	#focused = false;
	readonly #panel: OverlayPanel;
	readonly #body: PanelRows;
	#nativeSig = "";
	#nativeRoot: NativeNode | undefined;

	constructor(suggestedPath: string, done: (result: PlanSaveOverlayResult | undefined) => void) {
		this.#suggestedPath = suggestedPath;
		this.#done = done;
		this.#input.prompt = theme.fg("dim", "Path: ");
		this.#input.onSubmit = value => this.#done({ path: value.trim() || this.#suggestedPath });
		this.#input.onEscape = () => this.#done(undefined);
		this.#panel = new OverlayPanel("Save and quit");
		this.#body = new PanelRows();
		this.#body.setHeight(2);
		this.#panel.addChild(this.#body);
	}

	get focused(): boolean {
		return this.#focused;
	}

	set focused(value: boolean) {
		this.#focused = value;
	}

	/** Replaces the dimmed path accepted when the operator submits an empty input. */
	setSuggestedPath(path: string): void {
		this.#suggestedPath = path;
	}

	handleInput(data: string): void {
		this.#input.handleInput(data);
	}

	/** Routes enhanced clipboard pastes into the path input. */
	pasteText(text: string): void {
		this.#input.pasteText(text);
	}

	invalidate(): void {
		this.#input.invalidate();
		this.#panel.invalidate();
	}

	render(width: number): readonly string[] {
		const innerWidth = Math.max(0, width - 4);
		this.#input.focused = this.#focused;
		const hint = `${editorKey("tui.input.submit")} save and quit · ${editorKey("tui.select.cancel")} cancel`;
		this.#body.setLines([this.#renderInput(innerWidth), theme.fg("dim", hint)]);
		return this.#panel.render(width);
	}

	/** A small glass sheet titled "Save and quit". */
	readonly nativeOverlay = { role: "omp.overlay.planSave", size: "sm", head: "Save and quit" } as const;

	describe(): NativeNode {
		this.#input.focused = this.#focused;
		const showDefault = this.#input.getValue().length === 0;
		const bindings = getKeybindings();
		const submitKey = bindings.getKeys("tui.input.submit")[0];
		const cancelKey = bindings.getKeys("tui.select.cancel")[0];
		const sig = `${showDefault}|${this.#suggestedPath}|${submitKey}|${cancelKey}`;
		if (this.#nativeRoot && sig === this.#nativeSig) return this.#nativeRoot;
		const children: NativeChild[] = [this.#input];
		if (showDefault) {
			children.push(
				keyed(
					text([span("Empty saves to ", "dim"), span(this.#suggestedPath, "path")], { truncate: "middle" }),
					"default",
				),
			);
		}
		children.push(
			actionBar([
				null,
				actionButton("Cancel", "cancel", cancelKey ? { keys: cancelKey } : {}),
				actionButton("Save and quit", "save", { tone: "accent", ...(submitKey ? { keys: submitKey } : {}) }),
			]),
		);
		this.#nativeSig = sig;
		this.#nativeRoot = col(children, { gap: "md" });
		return this.#nativeRoot;
	}

	/** Save and Cancel run what the submit and cancel keys run. */
	handleNativeEvent(event: NativeUiEvent): void {
		if (event.type !== "action") return;
		if (event.act === "save") this.#input.onSubmit?.(this.#input.getValue());
		else if (event.act === "cancel") this.#input.onEscape?.();
	}

	#renderInput(width: number): string {
		if (this.#input.getValue().length > 0) return this.#input.render(width)[0] ?? "";
		const prompt = this.#input.prompt;
		const available = width - visibleWidth(prompt);
		if (available <= 0) return prompt;
		const marker = this.#focused ? CURSOR_MARKER : "";
		const suggested = truncateToWidth(this.#suggestedPath, Math.max(0, available - 1));
		return `${prompt}${marker}\x1b[7m \x1b[27m${theme.fg("dim", suggested)}`;
	}
}
