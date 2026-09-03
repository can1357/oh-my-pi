/**
 * Untrusted display strings for `/extensions`.
 *
 * MCP `serverInfo`, tool/resource/prompt catalogs, custom-tool schemas, and
 * discovered file content can carry ANSI, OSC/BEL, C0/C1 controls, or tabs.
 * Theme helpers wrap whatever they are given, so those sequences must be
 * stripped *before* SGR is applied.
 */
import { replaceTabs } from "@oh-my-pi/pi-tui";
import { sanitizeText } from "@oh-my-pi/pi-utils";

/** Strip ANSI/C0/C1/malformed unicode, then expand tabs. Call before theming. */
export function sanitizeDisplayText(text: string): string {
	return replaceTabs(sanitizeText(text));
}

/** Collapse newlines so a hostile title cannot inject extra TUI rows. */
export function sanitizeDisplayLine(text: string): string {
	return sanitizeDisplayText(text)
		.replace(/[\r\n]+/g, " ")
		.trim();
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
