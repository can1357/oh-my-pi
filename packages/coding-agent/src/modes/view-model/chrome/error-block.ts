import * as os from "node:os";
import { replaceTabs, truncateToWidth } from "../../../utils/text-width";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import { shortenEmbeddedPaths, TRUNCATE_LENGTHS } from "../../../utils/render-utils";

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
	const text = shortenEmbeddedPaths(replaceTabs(sanitizeText(message.replace(/\r\n?/g, "\n"))), homeDir, true);
	return truncateToWidth(text.replace(/\s+/g, " ").trim() || "Unknown error", Math.max(0, maxWidth));
}
