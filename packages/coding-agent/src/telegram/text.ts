/**
 * Small text-shaping helpers shared by the turn-conveyor rendering modules.
 *
 * They exist so `activity.ts`, `dialogs.ts` and `turn-conveyor.ts` clip and
 * quote dynamic text the same way; escaping belongs to `rich.ts` (`mdText`),
 * which the quote helpers here apply themselves.
 */
import { mdText } from "./rich";

/** Hard-clips `value` to `width` characters, ellipsising a clipped tail. */
export function clip(value: unknown, width: number): string {
	const text = String(value ?? "");
	return text.length <= width ? text : `${text.slice(0, Math.max(0, width - 1))}…`;
}

/**
 * Collapses a free-form passage (title, message, hint) into a single bounded
 * block: CRLF normalised, runs of spaces trimmed per line, blank-line runs
 * squeezed, then clipped.
 */
export function passage(value: unknown, width: number): string {
	const text = String(value ?? "")
		.replace(/\r\n?/gu, "\n")
		.split("\n")
		.map(line => line.replace(/[ \t]+/gu, " ").trim())
		.join("\n")
		.replace(/\n{3,}/gu, "\n\n")
		.trim();
	return clip(text, width);
}

/** Message of a thrown value, for logs that must never carry a stack. */
export function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/** Renders `text` as a blockquote: every line prefixed with `> `. */
export function quoteBlock(value: unknown): string {
	return String(value ?? "")
		.replace(/\r\n?/gu, "\n")
		.split("\n")
		.map(line => `> ${line}`)
		.join("\n");
}

/**
 * Blockquote of a message attributed to `label`: the first line rides the
 * attribution, the rest keep their own `>` marker. Matches the mirror-topic
 * rendering so a human prompt looks the same wherever it is relayed.
 */
export function speakerQuote(label: string, value: unknown): string {
	const lines = String(value ?? "")
		.replace(/\r\n?/gu, "\n")
		.split("\n")
		.map(line => mdText(line));
	const head = `> 👤 **${label}:**`;
	const first = lines.shift() ?? "";
	return [first === "" ? head : `${head} ${first}`, ...lines.map(line => `> ${line}`)].join("\n");
}
