/**
 * Diagnostics line rendered beneath the composer in the intent layout.
 *
 * Reuses the existing status-line renderer (model · reasoning effort · goal /
 * plan state · path · git · context usage · …) instead of duplicating any
 * model/context state: the same segments users already configure via
 * `statusLine.*` settings, with the same context-usage warning thresholds.
 * Only the placement changes — out of the editable frame, below the composer.
 *
 * On narrow widths the status line self-collapses (drops right-side segments,
 * shrinks the path) before truncating, so the line never overflows.
 */
import type { Component } from "@pk-nerdsaver-ai/pi-tui";

export interface ComposerDiagnosticsContext {
	/** Whether the intent composer layout is active. */
	isEnabled(): boolean;
	/** Fully styled status-line content sized for `width` (existing renderer). */
	getStatusLine(width: number): { content: string; width: number };
}

export class ComposerDiagnosticsComponent implements Component {
	constructor(private readonly ctx: ComposerDiagnosticsContext) {}

	invalidate(): void {}

	render(width: number): readonly string[] {
		if (!this.ctx.isEnabled()) return [];
		const { content } = this.ctx.getStatusLine(Math.max(0, width - 2));
		if (!content) return [];
		return [` ${content}`];
	}
	/** Number of external rows this diagnostics component occupies at the current width. */
	rowCount(width: number): number {
		return this.render(width).length;
	}
}
