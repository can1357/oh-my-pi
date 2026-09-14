/**
 * Shared `% free` gauge for `/usage`: a truecolor bar whose hue walks red →
 * orange → yellow → green with the remaining fraction, with the label embedded
 * inside the bar (inverse video over the filled part, plain colored text over
 * the empty part). Used by both the classic per-account report and the
 * dashboard cards so the two never disagree on colors.
 */
import { visibleWidth } from "@oh-my-pi/pi-tui";
import { rgbToHex } from "@oh-my-pi/pi-utils";
import { bgAnsi, colorToAnsi } from "../theme/color";
import { theme } from "../theme/theme";
const PERCENT_FORMAT = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });

/** `r;g;b` for a remaining fraction: 0 → red, 0.5 → orange, 0.75 → yellow, 1 → green. */
export function resolveUsageGradientRgb(remainingFraction: number): string {
	const clamped = Math.min(Math.max(remainingFraction, 0), 1);
	let progress: number;
	let start: [number, number, number];
	let end: [number, number, number];
	if (clamped <= 0.5) {
		progress = clamped * 2;
		start = [255, 69, 58];
		end = [255, 159, 10];
	} else if (clamped <= 0.75) {
		progress = (clamped - 0.5) * 4;
		start = [255, 159, 10];
		end = [255, 214, 10];
	} else {
		progress = (clamped - 0.75) * 4;
		start = [255, 214, 10];
		end = [48, 209, 88];
	}
	const mix = (i: number) => Math.round(start[i] + (end[i] - start[i]) * progress);
	return `${mix(0)};${mix(1)};${mix(2)}`;
}

export type UsageLabelPlacement = "moving" | "right";

/** Render a `barWidth`-cell gauge for `remainingFraction` (0..1) with the `N% free` label inside. */
export function renderFractionBar(
	remainingFraction: number,
	barWidth: number,
	uiTheme: typeof theme = theme,
	labelPlacement: UsageLabelPlacement = "moving",
): string {
	const remaining = Math.min(Math.max(remainingFraction, 0), 1);
	const label = `${PERCENT_FORMAT.format(remaining * 100)}% free`;
	const labelWidth = visibleWidth(label);
	const filledCells = Math.min(barWidth, Math.max(remaining > 0 ? 1 : 0, Math.round(remaining * barWidth)));
	const rgb = resolveUsageGradientRgb(remaining).split(";").map(Number);
	const hex = rgbToHex({ r: rgb[0]!, g: rgb[1]!, b: rgb[2]! });
	const foreground = colorToAnsi(hex, uiTheme.getColorMode());
	const background = bgAnsi(hex, uiTheme.getColorMode());
	if (labelWidth > barWidth) {
		const filled = "█".repeat(filledCells);
		const empty = "░".repeat(Math.max(0, barWidth - filledCells));
		return `${foreground}${filled}\x1b[39m${uiTheme.fg("dim", empty)}`;
	}
	const labelStart =
		labelPlacement === "right"
			? barWidth - labelWidth
			: Math.max(0, Math.min(filledCells - labelWidth, barWidth - labelWidth));
	const filledBeforeLabel = Math.min(filledCells, labelStart);
	const emptyBeforeLabel = labelStart - filledBeforeLabel;
	const filledLabelWidth = Math.max(0, Math.min(labelWidth, filledCells - labelStart));
	const inverse = `\x1b[30m${background}`;
	const filledBefore = filledBeforeLabel > 0 ? `${foreground}${"█".repeat(filledBeforeLabel)}\x1b[39m` : "";
	const emptyBefore = emptyBeforeLabel > 0 ? uiTheme.fg("dim", "░".repeat(emptyBeforeLabel)) : "";
	const filledLabel = filledLabelWidth > 0 ? `${inverse}${label.slice(0, filledLabelWidth)}\x1b[39;49m` : "";
	const emptyLabel = filledLabelWidth < labelWidth ? `${foreground}${label.slice(filledLabelWidth)}\x1b[39m` : "";
	const filledAfterWidth = Math.max(0, filledCells - labelStart - labelWidth);
	const filledAfter = filledAfterWidth > 0 ? `${foreground}${"█".repeat(filledAfterWidth)}\x1b[39m` : "";
	const content = `${filledBefore}${emptyBefore}${filledLabel}${emptyLabel}${filledAfter}`;
	return `${content}${uiTheme.fg("dim", "░".repeat(Math.max(0, barWidth - visibleWidth(content))))}`;
}
