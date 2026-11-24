/**
 * One-line summaries of a tool call's args (`query="retry", limit=10, nested={2 keys}`).
 *
 * Two budgets: a character budget for the `tool` node's target (data, not
 * layout; the terminal truncates it again), and a cell budget for terminal
 * rows, which shrinks long values first so later keys still show.
 */
import { INTENT_FIELD } from "@oh-my-pi/pi-wire";
import { truncate, visibleWidth } from "@oh-my-pi/pi-tui/text/width";

/** Arg keys that are call metadata, never shown. */
const HIDDEN_KEYS: ReadonlySet<string> = new Set([INTENT_FIELD, "__partialJson"]);

const PAIR_SEP = ", ";
const MORE = "…";
/** Cells each still-pending key keeps for a short value, so a long value can't starve later keys. */
const TAIL_VALUE_RESERVE = 4;
/** Character cap of one string value in a character-budget summary. */
const CHARACTER_VALUE_LEN = 24;

/** A scalar (or a container's size) as summary text, strings quoted and cut to `maxLen` cells. */
export function formatArgValue(value: unknown, maxLen: number): string {
	if (value === null) return "null";
	if (value === undefined) return "undefined";
	if (typeof value === "string") {
		const escaped = value.replace(/\n/g, "\\n").replace(/\t/g, "\\t");
		return `"${truncate(escaped, maxLen)}"`;
	}
	if (Array.isArray(value)) return `[${value.length} items]`;
	if (typeof value === "object") return `{${Object.keys(value).length} keys}`;
	return String(value);
}

/** The visible arg keys of `args`. */
export function visibleArgKeys(args: Readonly<Record<string, unknown>>): string[] {
	return Object.keys(args).filter(key => !HIDDEN_KEYS.has(key));
}

/** Summary within `maxChars` characters (the node target); later pairs give way to `…`. */
export function argsSummaryChars(args: Readonly<Record<string, unknown>>, maxChars: number): string {
	const pairs: string[] = [];
	let length = 0;
	for (const key of visibleArgKeys(args)) {
		const pair = `${key}=${formatArgValue(args[key], CHARACTER_VALUE_LEN)}`;
		const added = pair.length + (pairs.length > 0 ? PAIR_SEP.length : 0);
		if (length + added > maxChars && pairs.length > 0) {
			pairs.push(MORE);
			break;
		}
		pairs.push(pair);
		length += added;
	}
	return pairs.join(PAIR_SEP);
}

/** Summary within `maxWidth` cells (a terminal row). */
export function argsSummaryCells(args: Readonly<Record<string, unknown>>, maxWidth: number): string {
	const keys = visibleArgKeys(args);
	let out = "";
	let width = 0;
	for (let i = 0; i < keys.length; i++) {
		const key = keys[i]!;
		const sep = width > 0 ? PAIR_SEP : "";
		const current = width + sep.length;
		const cap = maxWidth - current - MORE.length;
		if (cap <= 0) return `${out}${MORE}`;
		let tailReserve = 0;
		for (let j = i + 1; j < keys.length; j++)
			tailReserve += PAIR_SEP.length + visibleWidth(keys[j]!) + 1 + TAIL_VALUE_RESERVE;
		const pieceBudget = Math.min(cap, maxWidth - current - tailReserve);
		const valueMax = Math.max(1, pieceBudget - visibleWidth(key) - 3);
		const piece = `${key}=${formatArgValue(args[key], valueMax)}`;
		const pieceWidth = visibleWidth(piece);
		if (pieceWidth > pieceBudget) return `${out}${sep}${truncate(piece, cap)}`;
		out += sep + piece;
		width = current + pieceWidth;
	}
	return out;
}
