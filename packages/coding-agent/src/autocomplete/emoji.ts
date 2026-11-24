import { findEmojiNameStart, hasEmojiLeftBoundary } from "./tokens";
import type { AutocompleteItem } from "./autocomplete";
import buckets from "./data/emojis.json" with { type: "json" };

// Bucket layout: `{ "<first-char>": [["<name>", "<emoji>"], ...] }`, with each
// bucket pre-sorted by name. Built offline by scripts/build-emojis.py
// so the runtime never has to allocate sorted arrays or filter flag sequences.
type Entry = readonly [name: string, char: string];
const BUCKETS = buckets as unknown as Readonly<Record<string, readonly Entry[]>>;

// Western text emoticons (`:D`, `;)`, `<3`, …) sit outside the `:name:`
// shortcode grammar, so they live in a hand-maintained table here rather than
// in `emojis.json`. Sorted longest-first so `:-)` wins over `:)` when both
// would match.
const EMOTICONS: ReadonlyArray<readonly [pattern: string, char: string]> = [
	[":'-(", "😢"],
	[">:-(", "😠"],
	[":-)", "🙂"],
	[":-(", "🙁"],
	[":-D", "😃"],
	[":-P", "😛"],
	[":-p", "😛"],
	[":-O", "😮"],
	[":-o", "😮"],
	[":-|", "😐"],
	[":-/", "😕"],
	[":-\\", "😕"],
	[":-*", "😘"],
	[";-)", "😉"],
	[";-P", "😜"],
	[":')", "🥲"],
	[":'D", "😂"],
	[":'(", "😢"],
	["</3", "💔"],
	[">:(", "😠"],
	["B-)", "😎"],
	["8-)", "😎"],
	["o.O", "😳"],
	["O.o", "😳"],
	[":)", "🙂"],
	[":(", "🙁"],
	[":D", "😃"],
	[":P", "😛"],
	[":p", "😛"],
	[":O", "😮"],
	[":o", "😮"],
	[":|", "😐"],
	[":/", "😕"],
	[":\\", "😕"],
	[":*", "😘"],
	[";)", "😉"],
	[":3", "😺"],
	["<3", "❤️"],
	["xD", "😆"],
	["XD", "😆"],
];

const MAX_SUGGESTIONS = 12;

function lowerBound(arr: readonly Entry[], target: string): number {
	let lo = 0;
	let hi = arr.length;
	while (lo < hi) {
		const mid = (lo + hi) >>> 1;
		if (arr[mid]![0] < target) lo = mid + 1;
		else hi = mid;
	}
	return lo;
}

function lookupExact(name: string): string | undefined {
	const bucket = BUCKETS[name[0] ?? ""];
	if (!bucket) return undefined;
	const i = lowerBound(bucket, name);
	const hit = bucket[i];
	return hit && hit[0] === name ? hit[1] : undefined;
}

export function getEmojiSuggestions(textBeforeCursor: string): { items: AutocompleteItem[]; prefix: string } | null {
	const start = findEmojiNameStart(textBeforeCursor);
	if (start < 0 || start === textBeforeCursor.length) return null;
	const query = textBeforeCursor.slice(start).toLowerCase();
	const items: AutocompleteItem[] = [];

	// Surface emoticon literals (`:D`, `:-)`, …) whose pattern starts with
	// `:<query>` (case-insensitive). These come first so the user sees the
	// emoticon they're literally typing at the top of the popup.
	const wanted = `:${query}`;
	for (const [pattern, char] of EMOTICONS) {
		if (items.length >= MAX_SUGGESTIONS) break;
		if (pattern.length < wanted.length) continue;
		if (pattern.toLowerCase().slice(0, wanted.length) !== wanted) continue;
		items.push({ value: char, label: `${char}  ${pattern}` });
	}

	const bucket = BUCKETS[query[0]!];
	if (bucket) {
		for (let i = lowerBound(bucket, query); i < bucket.length && items.length < MAX_SUGGESTIONS; i++) {
			const [name, char] = bucket[i]!;
			if (!name.startsWith(query)) break;
			items.push({
				value: char,
				label: `${char}  :${name}:`,
			});
		}
	}

	if (items.length === 0) return null;
	return { items, prefix: textBeforeCursor.slice(start - 1) };
}

export function applyEmojiCompletion(
	lines: string[],
	cursorLine: number,
	cursorCol: number,
	item: AutocompleteItem,
	prefix: string,
): { lines: string[]; cursorLine: number; cursorCol: number } {
	const currentLine = lines[cursorLine] ?? "";
	const before = currentLine.slice(0, cursorCol - prefix.length);
	const after = currentLine.slice(cursorCol);
	const newLines = [...lines];
	newLines[cursorLine] = before + item.value + after;
	return { lines: newLines, cursorLine, cursorCol: before.length + item.value.length };
}

function tryShortcodeInlineReplace(textBeforeCursor: string): { replaceLen: number; insert: string } | null {
	const len = textBeforeCursor.length;
	// Cheap early-out: shortcode replace only fires on a trailing `:`.
	if (len === 0 || textBeforeCursor.charCodeAt(len - 1) !== 0x3a) return null;

	// Walk back over the candidate name, then require an opening `:` with a
	// left boundary.
	const closeIdx = len - 1;
	const nameStart = findEmojiNameStart(textBeforeCursor, closeIdx);
	if (nameStart < 0 || nameStart === closeIdx) return null;

	const name = textBeforeCursor.slice(nameStart, closeIdx).toLowerCase();
	const char = lookupExact(name);
	if (!char) return null;
	// Replace `:name:` (name + 2 colons) with the emoji character.
	return { replaceLen: name.length + 2, insert: char };
}

// A trailing delimiter (space/tab/newline) confirms the user is done with the
// token — that way typing `:PATH` doesn't turn into `😛ATH` halfway through.
function isEmoticonTerminator(c: number): boolean {
	return c === 0x20 || c === 0x09 || c === 0x0a || c === 0x0d;
}

// Western text emoticons fire only once a terminator follows the pattern
// (e.g. typing space after `;)` rewrites `;) ` to `😉 `). The terminator is
// preserved in the replacement so the user keeps typing without losing it.
// EMOTICONS is sorted longest-first so `:-) ` wins over `:) `.
function tryEmoticonInlineReplace(textBeforeCursor: string): { replaceLen: number; insert: string } | null {
	const len = textBeforeCursor.length;
	if (len < 2) return null;
	const terminator = textBeforeCursor.charCodeAt(len - 1);
	if (!isEmoticonTerminator(terminator)) return null;
	const term = textBeforeCursor[len - 1]!;
	const tail = len - 1;
	for (const [pattern, char] of EMOTICONS) {
		const plen = pattern.length;
		if (tail < plen) continue;
		const start = tail - plen;
		let match = true;
		for (let j = 0; j < plen; j++) {
			if (textBeforeCursor.charCodeAt(start + j) !== pattern.charCodeAt(j)) {
				match = false;
				break;
			}
		}
		if (!match) continue;
		// Same left-boundary rule as shortcodes: emoticons embedded in
		// identifiers / URLs / code stay untouched.
		if (start > 0 && !hasEmojiLeftBoundary(textBeforeCursor, start)) continue;
		return { replaceLen: plen + 1, insert: char + term };
	}
	return null;
}

export function tryEmojiInlineReplace(textBeforeCursor: string): { replaceLen: number; insert: string } | null {
	return tryShortcodeInlineReplace(textBeforeCursor) ?? tryEmoticonInlineReplace(textBeforeCursor);
}

export function isEmojiPrefix(prefix: string): boolean {
	return prefix.startsWith(":");
}

// Submit-time expansion: scan a whole message for emoticons sitting at token
// boundaries (preceded by a left boundary, followed by whitespace or EOS) and
// rewrite them. Catches the case where the user pressed Enter without typing a
// trailing space after the emoticon. EMOTICONS sorted longest-first means the
// first `startsWith` hit is always the maximal match.
export function expandEmoticons(text: string): string {
	if (text.length < 2) return text;
	let out = "";
	let cursor = 0;
	let i = 0;
	while (i < text.length) {
		if (hasEmojiLeftBoundary(text, i)) {
			let matched = false;
			for (const [pattern, char] of EMOTICONS) {
				if (!text.startsWith(pattern, i)) continue;
				const end = i + pattern.length;
				if (end !== text.length) {
					const next = text.charCodeAt(end);
					if (!isEmoticonTerminator(next)) continue;
				}
				out += text.slice(cursor, i) + char;
				cursor = end;
				i = end;
				matched = true;
				break;
			}
			if (matched) continue;
		}
		i++;
	}
	if (cursor === 0) return text;
	return out + text.slice(cursor);
}
