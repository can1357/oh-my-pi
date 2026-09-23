import type { Component, Focusable } from "../index";
import { truncateToWidth } from "../index";
import { matchesSelectCancel } from "../keybinding-matchers";
import { theme } from "../theme/theme";
import { OverlayPanel, PanelRows } from "../chrome/overlay-box";

/**
 * Modal placeholder shown while an extension owns the plan-review decision.
 *
 * It holds focus for the whole wait, so the operator cannot start a turn that
 * would race the external reviewer's answer, and it gives the wait a visible
 * owner instead of a status line lost in the transcript. Cancelling returns the
 * decision to the built-in plan-review picker.
 */
export class PlanReviewWaitingOverlay implements Component, Focusable {
	#reviewer: string;
	#focused = false;
	readonly #onCancel: () => void;
	readonly #panel: OverlayPanel;
	readonly #body: PanelRows;

	constructor(reviewer: string, onCancel: () => void) {
		this.#reviewer = reviewer;
		this.#onCancel = onCancel;
		this.#panel = new OverlayPanel("Plan review");
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

	/** Name the extension that currently holds the decision. */
	setReviewer(reviewer: string): void {
		this.#reviewer = reviewer;
	}

	handleInput(data: string): void {
		if (matchesSelectCancel(data)) this.#onCancel();
	}

	invalidate(): void {
		this.#panel.invalidate();
	}

	render(width: number): readonly string[] {
		const innerWidth = Math.max(0, width - 4);
		this.#body.setLines([
			truncateToWidth(`Waiting for plan review — ${this.#reviewer}`, innerWidth),
			theme.fg("dim", truncateToWidth("Esc review here instead", innerWidth)),
		]);
		return this.#panel.render(width);
	}
}
