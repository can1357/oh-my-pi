import { renderProgressBar } from "../components/progress-bar";
import { shimmerText } from "../theme/shimmer";
import { theme as currentTheme, type Theme } from "../theme/theme";

/** Title-case a provider id for display (`openai-codex` → `Openai Codex`). */
export function formatProviderName(provider: string): string {
	return provider
		.split(/[-_]/g)
		.map(part => (part ? part[0].toUpperCase() + part.slice(1) : ""))
		.join(" ");
}

/** Format a millisecond duration as a coarse-grained human label. */
export function formatDuration(ms: number): string {
	const seconds = Math.max(0, Math.round(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.round(minutes / 60);
	if (hours < 48) return `${hours}h`;
	const days = Math.round(hours / 24);
	return `${days}d`;
}

type ProgressBarTheme = Pick<Theme, "bold" | "fg" | "getFgAnsi">;

const unstyledProgressBarTheme: ProgressBarTheme = {
	fg(_color, text) {
		return text;
	},
	bold(text) {
		return text;
	},
	getFgAnsi() {
		return "";
	},
};

function resolveProgressBarTheme(uiTheme: ProgressBarTheme | undefined): ProgressBarTheme {
	return uiTheme ?? currentTheme ?? unstyledProgressBarTheme;
}

/**
 * Render an ASCII progress bar with a trailing percent label.
 * `fraction` is clamped to `[0, 1]`. `undefined` renders a dotted placeholder.
 */
export function renderAsciiBar(fraction: number | undefined, width = 24, uiTheme?: ProgressBarTheme): string {
	const progressBarTheme = resolveProgressBarTheme(uiTheme);
	const shimmer = (text: string): string => shimmerText(text, progressBarTheme);
	if (fraction === undefined) {
		return renderProgressBar(undefined, width, {
			prefix: "[",
			suffix: "]",
			style: { filled: "·", empty: "·", indeterminate: "·", styleBar: shimmer },
		});
	}
	return renderProgressBar(fraction, width, {
		min: 0,
		max: 1,
		prefix: "[",
		suffix: "]",
		showPercentage: true,
		formatPercentage: value => `${Math.round(value * 100)}%`,
		style: { filled: "█", empty: "░", styleBar: shimmer },
	});
}
