import { hsvToRgb, type RGB } from "@oh-my-pi/pi-utils";
import { currentTheme } from "@oh-my-pi/pi-tui/theme/runtime";
import type { SttTarget } from "./stt-controller";

/** The caret of a text input that push-to-talk paints its mic glyph onto. */
export interface MicCursorTarget {
	/**
	 * Draw `glyph` (one cell, ANSI-styled) in place of the caret; `undefined`
	 * restores the input's own caret (and the hardware cursor it hid).
	 */
	setCaretGlyph(glyph: string | undefined): void;
}

/** A text input push-to-talk dictates into: the text the STT controller writes and the caret the
 *  mic glyph replaces. */
export type DictationTarget = SttTarget & MicCursorTarget;

const TRANSCRIBING_COLOR: RGB = { r: 200, g: 200, b: 200 };

/** Replaces a text input's caret with a hue-cycling mic glyph while speech is recorded, holds it
 *  grey while the recording is transcribed, and restores the caret on {@link dispose}. */
export class MicCursor {
	readonly #target: MicCursorTarget;
	#hue = 0;
	#animation: NodeJS.Timeout | undefined;

	constructor(target: MicCursorTarget) {
		this.#target = target;
		this.#paintHue();
		this.#animation = setInterval(() => {
			this.#hue = (this.#hue + 8) % 360;
			this.#paintHue();
		}, 60);
	}

	/** Stop cycling and hold the glyph grey while the recording is transcribed. */
	showTranscribing(): void {
		this.#stopAnimation();
		this.#paint(TRANSCRIBING_COLOR);
	}

	dispose(): void {
		this.#stopAnimation();
		this.#target.setCaretGlyph(undefined);
	}

	#stopAnimation(): void {
		clearInterval(this.#animation);
		this.#animation = undefined;
	}

	#paintHue(): void {
		this.#paint(hsvToRgb({ h: this.#hue, s: 0.9, v: 1.0 }));
	}

	#paint({ r, g, b }: RGB): void {
		this.#target.setCaretGlyph(`\x1b[38;2;${r};${g};${b}m${currentTheme().symbols.symbol("icon.mic")}\x1b[0m`);
	}
}
