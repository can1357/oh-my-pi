import type { Component } from "../tui";
import { padding, truncateToWidth, visibleWidth } from "../utils";

/**
 * Text component that truncates to fit viewport width
 */
export class TruncatedText implements Component {
	#text: string;
	#paddingX: number;
	#paddingY: number;
	#cachedWidth = -1;
	#cachedLines: string[] | undefined;

	constructor(text: string, paddingX: number = 0, paddingY: number = 0) {
		this.#text = text;
		this.#paddingX = paddingX;
		this.#paddingY = paddingY;
	}
	/** Return bounded source text and the last-known truncation state. */
	debugState(): Record<string, unknown> {
		const newlineIndex = this.#text.indexOf("\n");
		const firstLine = newlineIndex === -1 ? this.#text : this.#text.slice(0, newlineIndex);
		const availableWidth = Math.max(1, this.#cachedWidth - this.#paddingX * 2);
		return {
			textPreview: this.#text.slice(0, 120),
			textLength: this.#text.length,
			previewTruncated: this.#text.length > 120,
			truncated: newlineIndex !== -1 || (this.#cachedWidth >= 0 && visibleWidth(firstLine) > availableWidth),
			paddingX: this.#paddingX,
			paddingY: this.#paddingY,
		};
	}

	invalidate(): void {
		this.#cachedWidth = -1;
		this.#cachedLines = undefined;
	}

	render(width: number): readonly string[] {
		if (this.#cachedLines && this.#cachedWidth === width) {
			return this.#cachedLines;
		}
		const result: string[] = [];

		// Empty line padded to width
		const emptyLine = padding(width);

		// Add vertical padding above
		for (let i = 0; i < this.#paddingY; i++) {
			result.push(emptyLine);
		}

		// Calculate available width after horizontal padding
		const availableWidth = Math.max(1, width - this.#paddingX * 2);

		// Take only the first line (stop at newline)
		let singleLineText = this.#text;
		const newlineIndex = this.#text.indexOf("\n");
		if (newlineIndex !== -1) {
			singleLineText = this.#text.substring(0, newlineIndex);
		}

		// Truncate text if needed (accounting for ANSI codes)
		const displayText = truncateToWidth(singleLineText, availableWidth);

		// Add horizontal padding
		const leftPadding = padding(this.#paddingX);
		const rightPadding = padding(this.#paddingX);
		const lineWithPadding = leftPadding + displayText + rightPadding;

		// Don't pad to full width - avoids trailing spaces when copying
		result.push(lineWithPadding);

		// Add vertical padding below
		for (let i = 0; i < this.#paddingY; i++) {
			result.push(emptyLine);
		}

		this.#cachedWidth = width;
		this.#cachedLines = result;
		return result;
	}
}
