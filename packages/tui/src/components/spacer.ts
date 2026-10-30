import { node } from "../native/describe";
import type { DescribeContext, NativeNode } from "../native/node";
import type { Component } from "../tui";

/** Terminal spacing step for a count of blank rows. */
export function spaceForRows(rows: number): "none" | "sm" | "md" | "lg" {
	if (!(rows > 0)) return "none";
	if (rows <= 1) return "sm";
	if (rows <= 2) return "md";
	return "lg";
}

/**
 * Spacer component that renders empty lines
 */
export class Spacer implements Component {
	#lines: number;
	#cached: string[] | undefined;
	#native: NativeNode | undefined;

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
		this.#native = undefined;
	}
	invalidate(): void {
		// No cached state to invalidate currently
	}

	describe(_cx: DescribeContext): NativeNode {
		this.#native ??= node("spacer", { size: spaceForRows(this.#lines) });
		return this.#native;
	}

	render(_width: number): readonly string[] {
		let cached = this.#cached;
		if (cached === undefined) {
			// oxlint-disable-next-line unicorn/no-new-array -- cached line allocation
			cached = new Array(this.#lines).fill("");
			this.#cached = cached;
		}
		return cached;
	}
}
