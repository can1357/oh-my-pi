/**
 * One run of a buffer a host hands to {@link Editor.setRuns}: the person's characters, or a
 * token this editor is to own. Text runs are never searched for tokens.
 */
export type EditorRun = string | { atom: string; expansion: string };

/** Where one of the editor's tokens sits in the text handed to an external editor. */
export interface ExternalEditToken {
	/** Offset of the token's first character in the handed-out text. */
	start: number;
	/** The token's buffer characters (its atom label). */
	text: string;
	/** What the token expands to on submit. */
	expansion: string;
}

/** The text handed to an external editor, and where this editor's tokens sit in it. */
export interface ExternalEditPayload {
	text: string;
	tokens: readonly ExternalEditToken[];
}

/**
 * What an external editor's return maps to: the buffer runs to apply, or the reason the mapping
 * is ambiguous. Ambiguity is never resolved by guessing — the caller keeps the pre-edit buffer
 * and tells the person why.
 */
export type ExternalEditMapping = { ok: true; runs: EditorRun[] } | { ok: false; reason: string };

/** A stretch of text present in both the handed-out and the returned text, at these offsets. */
interface Region {
	oldStart: number;
	newStart: number;
	length: number;
}

/** Whitespace runs and non-whitespace runs, covering the text exactly and in order. */
function splitWords(text: string): { text: string; start: number }[] {
	const words: { text: string; start: number }[] = [];
	for (const match of text.matchAll(/\s+|\S+/g)) words.push({ text: match[0], start: match.index });
	return words;
}

/** Most word pairs the alignment will score; past this the edit is reported as unattributable
 *  rather than silently approximated. */
const MAX_ALIGN_CELLS = 4_000_000;

/**
 * Longest common subsequence of two word lists, as index pairs in order. Words, not characters:
 * an edit beside a token leaves the token's own words matched, and it keeps the table small
 * enough to be exact rather than heuristic.
 */
function matchWords(
	before: readonly { text: string }[],
	after: readonly { text: string }[],
): { before: number; after: number }[] | undefined {
	const n = before.length;
	const m = after.length;
	if ((n + 1) * (m + 1) > MAX_ALIGN_CELLS) return undefined;
	// table[i][j] = matched length of before[i..] against after[j..].
	const width = m + 1;
	const table = new Int32Array((n + 1) * width);
	for (let i = n - 1; i >= 0; i--) {
		for (let j = m - 1; j >= 0; j--) {
			table[i * width + j] =
				before[i]!.text === after[j]!.text
					? table[(i + 1) * width + j + 1]! + before[i]!.text.length
					: Math.max(table[(i + 1) * width + j]!, table[i * width + j + 1]!);
		}
	}
	const pairs: { before: number; after: number }[] = [];
	let i = 0;
	let j = 0;
	while (i < n && j < m) {
		if (before[i]!.text === after[j]!.text) {
			pairs.push({ before: i, after: j });
			i++;
			j++;
		} else if (table[(i + 1) * width + j]! >= table[i * width + j + 1]!) i++;
		else j++;
	}
	return pairs;
}

/**
 * Align `before` and `after`: the stretches both texts share, and the stretches `after` only
 * dropped. A dropped stretch is told apart from a rewritten one so a token the person deleted
 * can be honoured as deleted, while one whose characters they changed cannot be placed at all.
 */
function alignTexts(before: string, after: string): { equal: Region[]; removed: Region[]; aligned: boolean } {
	const min = Math.min(before.length, after.length);
	let prefix = 0;
	while (prefix < min && before.charCodeAt(prefix) === after.charCodeAt(prefix)) prefix++;
	let suffix = 0;
	while (
		suffix < min - prefix &&
		before.charCodeAt(before.length - 1 - suffix) === after.charCodeAt(after.length - 1 - suffix)
	) {
		suffix++;
	}
	const equal: Region[] = [];
	const removed: Region[] = [];
	if (prefix > 0) equal.push({ oldStart: 0, newStart: 0, length: prefix });
	if (suffix > 0) {
		equal.push({ oldStart: before.length - suffix, newStart: after.length - suffix, length: suffix });
	}
	const oldMiddle = before.slice(prefix, before.length - suffix);
	const newMiddle = after.slice(prefix, after.length - suffix);
	if (oldMiddle === "" || newMiddle === "") {
		if (oldMiddle !== "") removed.push({ oldStart: prefix, newStart: prefix, length: oldMiddle.length });
		return { equal, removed, aligned: true };
	}
	const oldWords = splitWords(oldMiddle);
	const newWords = splitWords(newMiddle);
	const pairs = matchWords(oldWords, newWords);
	if (pairs === undefined) return { equal, removed, aligned: false };
	// Walk the matches: runs of adjacent pairs are one shared stretch, and a gap with nothing
	// inserted against it is a pure removal.
	let oldAt = 0;
	let newAt = 0;
	let run: Region | undefined;
	const flush = () => {
		if (run) equal.push(run);
		run = undefined;
	};
	for (const pair of pairs) {
		const oldWord = oldWords[pair.before]!;
		const newWord = newWords[pair.after]!;
		if (pair.before !== oldAt || pair.after !== newAt) {
			flush();
			const oldGap = oldWords.slice(oldAt, pair.before).reduce((sum, word) => sum + word.text.length, 0);
			const newGap = newWords.slice(newAt, pair.after).reduce((sum, word) => sum + word.text.length, 0);
			if (oldGap > 0 && newGap === 0) {
				removed.push({
					oldStart: prefix + oldWords[oldAt]!.start,
					newStart: prefix + newWord.start,
					length: oldGap,
				});
			}
		}
		if (
			run &&
			run.oldStart + run.length === prefix + oldWord.start &&
			run.newStart + run.length === prefix + newWord.start
		) {
			run.length += oldWord.text.length;
		} else {
			flush();
			run = { oldStart: prefix + oldWord.start, newStart: prefix + newWord.start, length: oldWord.text.length };
		}
		oldAt = pair.before + 1;
		newAt = pair.after + 1;
	}
	flush();
	const oldTail = oldWords.slice(oldAt).reduce((sum, word) => sum + word.text.length, 0);
	const newTail = newWords.slice(newAt).reduce((sum, word) => sum + word.text.length, 0);
	if (oldTail > 0 && newTail === 0) {
		removed.push({
			oldStart: prefix + oldWords[oldAt]!.start,
			newStart: after.length - suffix,
			length: oldTail,
		});
	}
	return { equal, removed, aligned: true };
}

/** The stretches of `after` no shared region covers: what the editing session put there. */
function insertedChunks(after: string, equal: readonly Region[]): string[] {
	const covered = [...equal].sort((a, b) => a.newStart - b.newStart);
	const inserted: string[] = [];
	let at = 0;
	for (const region of covered) {
		if (region.newStart > at) inserted.push(after.slice(at, region.newStart));
		at = Math.max(at, region.newStart + region.length);
	}
	if (at < after.length) inserted.push(after.slice(at));
	return inserted;
}

/** How many times `needle` occurs in `haystack`. */
function countOccurrences(haystack: string, needle: string): number {
	let count = 0;
	for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + needle.length)) count++;
	return count;
}

/**
 * Map the editor's tokens from the text it handed out onto the text an external editor returned.
 *
 * A token is kept only where the alignment puts its own characters: inside a stretch both texts
 * share. A token inside a stretch the session only removed is taken as deleted, and its
 * attachment goes, exactly as deleting the token in the prompt does. Anything else — a token
 * whose characters were edited, moved, duplicated, or written out by hand — cannot be
 * attributed, so the mapping is refused and the caller keeps what it had.
 */
export function mapExternalEdit(payload: ExternalEditPayload, returned: string): ExternalEditMapping {
	if (payload.tokens.length === 0) return { ok: true, runs: returned === "" ? [] : [returned] };
	const { equal, removed, aligned } = alignTexts(payload.text, returned);
	if (!aligned) {
		return {
			ok: false,
			reason: "the returned text differs too widely from what the editor was given to place its attachments in it",
		};
	}
	const inserted = insertedChunks(returned, equal);
	for (const token of payload.tokens) {
		// Characters the session put there that read exactly like a token cannot be told from the
		// token itself — a copy, a move, or something written out by hand.
		if (inserted.some(chunk => chunk.includes(token.text))) {
			return {
				ok: false,
				reason: `the editor returned ${token.text} in text it was not given, so the attachment it stands for cannot be told from the same characters written by hand`,
			};
		}
		if (countOccurrences(returned, token.text) > countOccurrences(payload.text, token.text)) {
			return {
				ok: false,
				reason: `${token.text} came back more times than it was given, so neither copy can be placed`,
			};
		}
	}
	const placed: { start: number; token: ExternalEditToken }[] = [];
	for (const token of payload.tokens) {
		const end = token.start + token.text.length;
		const shared = equal.find(region => token.start >= region.oldStart && end <= region.oldStart + region.length);
		if (shared) {
			placed.push({ start: shared.newStart + (token.start - shared.oldStart), token });
			continue;
		}
		if (removed.some(region => token.start >= region.oldStart && end <= region.oldStart + region.length)) continue;
		return {
			ok: false,
			reason: `${token.text} was neither kept nor removed whole, so the attachment it stands for can no longer be placed`,
		};
	}
	placed.sort((a, b) => a.start - b.start);
	const runs: EditorRun[] = [];
	let at = 0;
	for (const { start, token } of placed) {
		if (start < at || returned.slice(start, start + token.text.length) !== token.text) {
			return {
				ok: false,
				reason: `${token.text} came back where another token already stands, so neither can be placed`,
			};
		}
		if (start > at) runs.push(returned.slice(at, start));
		runs.push({ atom: token.text, expansion: token.expansion });
		at = start + token.text.length;
	}
	if (at < returned.length) runs.push(returned.slice(at));
	return { ok: true, runs };
}
