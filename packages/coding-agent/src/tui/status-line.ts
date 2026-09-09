/**
 * Standardized status header rendering for tool output.
 */
import type { Theme, ThemeColor } from "../modes/theme/theme";
import type { ToolUIStatus } from "../tools/render-utils";
import { formatStatusIcon } from "../tools/render-utils";

export interface StatusLineOptions {
	icon?: ToolUIStatus;
	/** Pre-rendered glyph that replaces the status icon (e.g. a magnifier for
	 * search-family tools). Takes precedence over `icon`. */
	iconOverride?: string;
	spinnerFrame?: number;
	title: string;
	titleColor?: ThemeColor;
	description?: string;
	badge?: { label: string; color: ThemeColor };
	meta?: string[];
}

/**
 * Flatten CR/LF runs in caller-supplied header fragments so a single newline
 * embedded in `description` or `meta` cannot expand the status line into
 * multiple rows — which would otherwise break the bordered output block the
 * header sits on. Tab characters are left alone; tool renderers that need
 * tab-safe text run `replaceTabs()` themselves.
 */
function flattenForHeader(text: string): string {
	return text.replace(/\r\n?|\n/g, " ");
}

export function renderStatusLine(options: StatusLineOptions, theme: Theme): string {
	const icon =
		options.iconOverride ?? (options.icon ? formatStatusIcon(options.icon, theme, options.spinnerFrame) : "");
	const titleColor = options.titleColor ?? "accent";
	const title = theme.fg(titleColor, flattenForHeader(options.title));
	let line = icon ? `${icon} ${title}` : title;

	if (options.description) {
		line += `: ${theme.fg("muted", flattenForHeader(options.description))}`;
	}

	if (options.badge) {
		const { label, color } = options.badge;
		line += ` ${theme.fg(color, `${theme.format.bracketLeft}${flattenForHeader(label)}${theme.format.bracketRight}`)}`;
	}

	const meta = options.meta?.map(flattenForHeader).filter(value => value.trim().length > 0) ?? [];
	if (meta.length > 0) {
		line += ` ${theme.fg("dim", meta.join(theme.sep.dot))}`;
	}

	return line;
}
