import { type Component, getPaddingX, Text } from "@oh-my-pi/pi-tui";

/**
 * Text whose content is (re)formatted against the actual render width.
 *
 * A plain `Text` receives an already-formatted string and only wraps it at
 * render time, so width-dependent layout (per-line truncation, inline previews)
 * has to be decided before the width is known. Renderers used to cope by
 * hard-capping output lines at a fixed column count (e.g. 80), which truncated
 * to roughly a third of a wide terminal. This defers formatting to
 * `render(width)`: it computes the same content width the inner `Text` uses
 * (mirroring its tight-layout flag so the budget can't desync), hands that to
 * the formatter, and delegates margins/background/vertical padding to the inner
 * `Text`. Lines the formatter caps at `contentWidth` fit exactly and so never
 * wrap.
 */
export class WidthAwareText implements Component {
	#format: (contentWidth: number) => string;
	readonly #paddingX: number;
	#inner: Text;
	#cachedContentWidth = -1;
	#cachedText: string | undefined;
	#ignoreTight = false;

	constructor(format: (contentWidth: number) => string, paddingX = 1, paddingY = 1) {
		this.#format = format;
		this.#paddingX = paddingX;
		this.#inner = new Text("", paddingX, paddingY);
	}

	setCustomBgFn(customBgFn?: (text: string) => string): void {
		this.#inner.setCustomBgFn(customBgFn);
	}

	setIgnoreTight(ignore: boolean): this {
		this.#ignoreTight = ignore;
		this.#inner.setIgnoreTight(ignore);
		this.invalidate();
		return this;
	}

	invalidate(): void {
		this.#cachedContentWidth = -1;
		this.#cachedText = undefined;
		this.#inner.invalidate();
	}

	render(width: number): readonly string[] {
		const paddingX = this.#ignoreTight ? this.#paddingX : getPaddingX(this.#paddingX);
		const contentWidth = Math.max(1, width - paddingX * 2);
		if (this.#cachedText === undefined || contentWidth !== this.#cachedContentWidth) {
			this.#cachedContentWidth = contentWidth;
			this.#cachedText = this.#format(contentWidth);
			this.#inner.setText(this.#cachedText);
		}
		return this.#inner.render(width);
	}
}
