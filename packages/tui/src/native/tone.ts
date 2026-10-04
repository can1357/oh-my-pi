/**
 * omp theme colours → TSP tones. Components that only hold ANSI stylers
 * (`(text) => string`) sample them with a probe string to recover the theme
 * token behind the escape, then map the token to a card/text tone.
 */
import type { TspTone } from "@oh-my-pi/pi-wire";
import { isValidThemeColor, type ThemeBg, type ThemeColor } from "../theme/theme";
import { styledBackground, styledSpans } from "./spans";

/** Theme background token of an ANSI background styler, sampled with a probe string. */
export function sampleBackground(bgFn: ((text: string) => string) | undefined): ThemeBg | undefined {
	return bgFn ? styledBackground(bgFn("x")) : undefined;
}

/** Theme foreground token of an ANSI colour styler, sampled with a probe string. */
export function sampleForeground(color: ((text: string) => string) | undefined): ThemeColor | undefined {
	if (!color) return undefined;
	const first = styledSpans(color("x"))[0]?.s;
	if (first === undefined) return undefined;
	const token = first.split(" ")[0]!;
	return isValidThemeColor(token) ? token : undefined;
}

/** Card chrome derived from a background fill. */
export interface BackgroundChrome {
	tone?: TspTone;
	role?: string;
	selected?: boolean;
}

/** Map an omp background token to card tone/role. */
export function backgroundChrome(bg: ThemeBg | undefined): BackgroundChrome {
	switch (bg) {
		case "userMessageBg":
			return { tone: "user", role: "omp.user" };
		case "customMessageBg":
			return { tone: "info", role: "omp.custom" };
		case "toolPendingBg":
			return { tone: "pending", role: "omp.tool" };
		case "toolSuccessBg":
			return { tone: "success", role: "omp.tool" };
		case "toolErrorBg":
			return { tone: "error", role: "omp.tool" };
		case "selectedBg":
			return { tone: "accent", selected: true };
		case "statusLineBg":
			return { tone: "neutral", role: "omp.status" };
		default:
			return {};
	}
}

/**
 * Tone of an omp colour used as a severity or border colour; undefined for
 * colours that carry no tone (callers pick their own fallback).
 */
export function colorTone(color: ThemeColor | undefined): TspTone | undefined {
	switch (color) {
		case undefined:
			return undefined;
		case "border":
			return "neutral";
		case "borderAccent":
		case "accent":
			return "accent";
		case "borderMuted":
		case "muted":
		case "dim":
			return "muted";
		case "success":
			return "success";
		case "error":
			return "error";
		case "warning":
			return "warning";
		default:
			return color.startsWith("thinking") ? "accent" : undefined;
	}
}
