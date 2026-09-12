import * as os from "node:os";
import { replaceTabs, truncateToWidth, wrapTextWithAnsi } from "@oh-my-pi/pi-tui";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import { expandKeyHint, shortenPath, TRUNCATE_LENGTHS } from "../../tools/render-utils";
import { theme } from "../theme/theme";

/** Indent for every row after the first, so continuations hang under the prefix. */
const CONTINUATION_INDENT = "  ";

/**
 * Plain, bounded error text to sanitize before applying terminal styles.
 * Match embedded home paths (including quoted names with spaces), not URL
 * paths or home-prefix siblings. Callers retain the original error for logs.
 */
export function sanitizeErrorLine(
	error: unknown,
	maxWidth: number = TRUNCATE_LENGTHS.LINE,
	homeDir: string = os.homedir(),
): string {
	const message = error instanceof Error ? error.message : String(error);
	let text = replaceTabs(sanitizeText(message.replace(/\r\n?/g, "\n")));
	if (homeDir) {
		const windowsStyle = /^[A-Za-z]:[\\/]/.test(homeDir) || homeDir.startsWith("\\\\");
		const home = windowsStyle ? homeDir.replaceAll("/", "\\") : homeDir;
		const homePattern = windowsStyle
			? home
					.split("\\")
					.map(part => RegExp.escape(part))
					.join("[\\\\/]")
			: RegExp.escape(home);
		// Consume URLs as a whole before considering any home-looking substring.
		const paths = new RegExp(
			`[a-zA-Z][a-zA-Z0-9+.-]*://[^\\s"'<>]+|(^|[\\s"'\\x60([{=,:])(${homePattern})(?=$|[\\\\/\\s"'\\x60)\\]},;:])`,
			windowsStyle ? "gi" : "g",
		);
		text = text.replace(paths, (match, boundary: string | undefined, candidate: string | undefined) =>
			candidate === undefined
				? match
				: `${boundary}${shortenPath(windowsStyle ? candidate.replaceAll("/", "\\") : candidate, home)}`,
		);
	}
	return truncateToWidth(text.replace(/\s+/g, " ").trim() || "Unknown error", Math.max(0, maxWidth));
}

/**
 * Format a provider error into at most `maxRows` wrapped rows for a
 * `WidthAwareText` of `contentWidth` cells. Lines wrap to the render width
 * instead of being cut at a fixed column, so a long single-line body — a raw
 * 400 JSON envelope, a `raw-http-request=` dump path — stays readable. Blank
 * lines are dropped. When rows are cut, a dim `… +N more lines (<key> to
 * expand)` row follows; pass `Infinity` to keep every row. `styleLine` colors
 * logical line `index` and supplies line 0's prefix (`Error: `, the banner
 * glyph). Shared by the inline transcript error and the pinned banner.
 */
export function formatErrorBlock(
	message: string,
	contentWidth: number,
	maxRows: number,
	styleLine: (line: string, index: number) => string,
): string {
	const lines = replaceTabs(message)
		.split("\n")
		.map(line => line.trim())
		.filter(line => line.length > 0);
	if (lines.length === 0) lines.push("Unknown error");
	const wrapWidth = Math.max(1, contentWidth - CONTINUATION_INDENT.length);
	const rows: string[] = [];
	for (let index = 0; index < lines.length; index++) {
		for (const row of wrapTextWithAnsi(styleLine(lines[index]!, index), wrapWidth)) {
			rows.push(rows.length === 0 ? row : `${CONTINUATION_INDENT}${row}`);
		}
	}
	if (rows.length > maxRows) {
		const hidden = rows.length - maxRows;
		rows.length = maxRows;
		rows.push(
			theme.fg(
				"dim",
				`${CONTINUATION_INDENT}… +${hidden} more line${hidden === 1 ? "" : "s"} (${expandKeyHint()} to expand)`,
			),
		);
	}
	return rows.join("\n");
}
