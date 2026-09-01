import type { Component } from "../tui";

/**
 * Spacer component that renders empty lines
 */
export class Spacer implements Component {
	#lines: number;
	#cached: string[] | undefined;

	constructor(lines: number = 1) {
		this.#lines = lines;
	}
	/** Return the spacer height for debug inspection. */
	debugState(): Record<string, unknown> {
		return { height: this.#lines };
	}

	setLines(lines: number): void {
		if (lines === this.#lines) return;
		this.#lines = lines;
		this.#cached = undefined;
	}

	invalidate(): void {
		// No cached state to invalidate currently
	}

	render(_width: number): readonly string[] {
		let cached = this.#cached;
		if (cached === undefined) {
			cached = new Array(this.#lines).fill("");
			this.#cached = cached;
		}
		return cached;
	}
}
