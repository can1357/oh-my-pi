/**
 * Pure row builders for the composer's in-frame bottom section:
 * a context-chip row (body) and an execution rail (footer).
 *
 * Builders return already-styled single-line strings sized to fit `width`;
 * the editor truncates defensively but these never intentionally overflow,
 * so the composer can never force page-level horizontal scrolling.
 */
import { truncateToWidth, visibleWidth } from "@pk-nerdsaver-ai/pi-tui";
import { theme } from "../../../modes/theme/theme";

/** One active-context chip. `auto` = ambient context (repo/branch, plan file); `attached` = explicit (images, pastes). */
export interface ComposerChip {
	readonly label: string;
	readonly kind: "auto" | "attached";
}

function styleChip(chip: ComposerChip): string {
	const color = chip.kind === "attached" ? "accent" : "muted";
	return theme.fg("dim", "[") + theme.fg(color, chip.label) + theme.fg("dim", "]");
}

/**
 * Lay out chips left-to-right; chips that do not fit collapse into a muted
 * `+N more` summary so the row never overflows horizontally.
 */
export function buildChipsRow(chips: readonly ComposerChip[], width: number): string | undefined {
	if (chips.length === 0 || width <= 0) return undefined;

	const parts: string[] = [];
	let used = 0;
	let shown = 0;
	for (const chip of chips) {
		const remaining = chips.length - shown - 1;
		const moreReserve = remaining > 0 ? ` +${remaining} more`.length : 0;
		const chipWidth = visibleWidth(chip.label) + 2 + (shown > 0 ? 1 : 0);
		if (used + chipWidth + moreReserve > width) break;
		parts.push(styleChip(chip));
		used += chipWidth;
		shown++;
	}

	if (shown === 0) {
		// Not even one chip fits — summarize everything.
		return truncateToWidth(theme.fg("muted", `+${chips.length} context`), width);
	}

	const hidden = chips.length - shown;
	const summary = hidden > 0 ? theme.fg("muted", ` +${hidden} more`) : "";
	return parts.join(" ") + summary;
}

export interface ComposerRailState {
	/** Label of the active work mode (already localized, e.g. "Build"). */
	readonly modeLabel: string;
	/** Primary-action label for the active mode (e.g. "Run", "Send"). */
	readonly cta: string;
	/** A turn is currently streaming: show queue/stop semantics instead of the CTA. */
	readonly streaming: boolean;
	/** The editor has submittable input (text or attachments). */
	readonly hasInput: boolean;
	/** Messages queued behind the active turn. */
	readonly queuedCount: number;
	/** Key hint for interrupt/stop (e.g. "esc"); omit when cancellation is unavailable. */
	readonly stopKeyHint?: string;
}

/**
 * Build the execution-rail row: mode marker + context affordance on the left,
 * primary action on the right. The right side (CTA / stop) always survives
 * truncation — the left side is trimmed first.
 */
export function buildRailRow(state: ComposerRailState, width: number): string {
	if (width <= 0) return "";

	let left = theme.fg("accent", `◆ ${state.modeLabel}`) + theme.fg("dim", "  + @ context");

	let right: string;
	let rightPlainWidth: number;
	if (state.streaming) {
		const queueLabel = state.queuedCount > 0 ? `⏎ queue (${state.queuedCount})` : "⏎ queue";
		const stop = state.stopKeyHint ? `${state.stopKeyHint} stop` : "running…";
		right = `${theme.fg("muted", queueLabel)}  ${theme.fg("warning", stop)}`;
		rightPlainWidth = visibleWidth(queueLabel) + 2 + visibleWidth(stop);
	} else {
		const label = `${state.cta} ⏎`;
		right = state.hasInput ? theme.fg("accent", theme.bold(label)) : theme.fg("dim", label);
		rightPlainWidth = visibleWidth(label);
	}

	let leftWidth = visibleWidth(left);
	if (leftWidth + 1 + rightPlainWidth > width) {
		// Trim the left side to keep the primary action visible.
		const budget = Math.max(0, width - rightPlainWidth - 1);
		left = truncateToWidth(left, budget);
		leftWidth = visibleWidth(left);
	}
	if (rightPlainWidth > width) {
		return truncateToWidth(right, width);
	}

	const gap = Math.max(1, width - leftWidth - rightPlainWidth);
	return left + " ".repeat(gap) + right;
}
