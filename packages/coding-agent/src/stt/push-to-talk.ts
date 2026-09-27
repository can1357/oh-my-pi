import type { Component, TUI } from "@oh-my-pi/pi-tui";
import { theme } from "@oh-my-pi/pi-tui/theme";
import { hsvToRgb, type RGB } from "@oh-my-pi/pi-utils";
import type { SttTarget } from "./stt-controller";

/** The cursor surface of a text input that push-to-talk paints its mic glyph onto. */
export interface MicCursorTarget extends Component {
	cursorOverride: string | undefined;
	getUseTerminalCursor(): boolean;
	setUseTerminalCursor(useTerminalCursor: boolean): void;
}

/** A text input push-to-talk dictates into: the text the STT controller writes and the cursor the
 *  mic glyph replaces. */
export type DictationTarget = SttTarget & MicCursorTarget;

const TRANSCRIBING_COLOR: RGB = { r: 200, g: 200, b: 200 };

/** Replaces a text input's cursor with a hue-cycling mic glyph while speech is recorded, holds it
 *  grey while the recording is transcribed, and restores the cursor state it found on {@link dispose}. */
export class MicCursor {
	readonly #ui: TUI;
	readonly #target: MicCursorTarget;
	readonly #previousShowHardwareCursor: boolean;
	readonly #previousUseTerminalCursor: boolean;
	#hue = 0;
	#animation: NodeJS.Timeout | undefined;

	constructor(ui: TUI, target: MicCursorTarget) {
		this.#ui = ui;
		this.#target = target;
		this.#previousShowHardwareCursor = ui.getShowHardwareCursor();
		this.#previousUseTerminalCursor = target.getUseTerminalCursor();
		ui.setShowHardwareCursor(false);
		target.setUseTerminalCursor(false);
		this.#paintHue();
		this.#animation = setInterval(() => {
			this.#hue = (this.#hue + 8) % 360;
			this.#paintHue();
			// Component-scoped: the hue sweep only recolors the input's cursor
			// glyph, so the transcript subtree is reused per animation frame.
			ui.requestComponentRender(target);
		}, 60);
	}

	/** Stop cycling and hold the glyph grey while the recording is transcribed. */
	showTranscribing(): void {
		this.#stopAnimation();
		this.#paint(TRANSCRIBING_COLOR);
	}

	dispose(): void {
		this.#stopAnimation();
		this.#target.cursorOverride = undefined;
		this.#ui.setShowHardwareCursor(this.#previousShowHardwareCursor);
		this.#target.setUseTerminalCursor(this.#previousUseTerminalCursor);
	}

	#stopAnimation(): void {
		clearInterval(this.#animation);
		this.#animation = undefined;
	}

	#paintHue(): void {
		this.#paint(hsvToRgb({ h: this.#hue, s: 0.9, v: 1.0 }));
	}

	#paint({ r, g, b }: RGB): void {
		this.#target.cursorOverride = `\x1b[38;2;${r};${g};${b}m${theme.icon.mic}\x1b[0m`;
	}
}
