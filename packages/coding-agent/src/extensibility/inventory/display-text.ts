import { replaceTabs, truncateToWidth } from "../../utils/text-width";
import { sanitizeText } from "@oh-my-pi/pi-utils";

/** Strip ANSI/C0/C1/malformed unicode, then expand tabs. Call before theming. */
export function sanitizeDisplayText(text: string): string {
	return replaceTabs(sanitizeText(text));
}

/** Collapse newlines to spaces so a hostile title cannot inject extra TUI rows (no trimming). */
export function sanitizeDisplaySingleLine(text: string): string {
	return sanitizeDisplayText(text).replace(/[\r\n]+/g, " ");
}

/** Collapse newlines so a hostile title cannot inject extra TUI rows. */
export function sanitizeDisplayLine(text: string): string {
	return sanitizeDisplaySingleLine(text).trim();
}

/**
 * One bounded display line from an externally sourced string (a bridged peer's id, a transport
 * error): {@link sanitizeDisplayLine} with whitespace runs collapsed, truncated to `max` cells.
 */
export function sanitizeInline(text: string, max = 200): string {
	return truncateToWidth(sanitizeDisplayLine(text).replace(/\s+/g, " "), max);
}

/** Like {@link sanitizeDisplayText}, dropping empty results. */
export function sanitizeDisplayField(text: string | undefined | null): string | undefined {
	if (typeof text !== "string" || text.length === 0) return undefined;
	const cleaned = sanitizeDisplayText(text);
	return cleaned.length > 0 ? cleaned : undefined;
}

/** Like {@link sanitizeDisplayLine}, dropping empty results. */
export function sanitizeDisplayLineField(text: string | undefined | null): string | undefined {
	if (typeof text !== "string" || text.length === 0) return undefined;
	const cleaned = sanitizeDisplayLine(text);
	return cleaned.length > 0 ? cleaned : undefined;
}
