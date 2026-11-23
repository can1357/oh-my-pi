import { type } from "@oh-my-pi/omptype";
import type { Tool } from "@oh-my-pi/pi-ai";
import { fileLines, numberedLines } from "./magic-view";
import { normalizeToLF } from "./normalize";

const MAX_READ_LINES = 160;
const MAX_TEXT_CHARS = 8_000;
const MAX_SEARCH_HITS = 20;
const REPLACE_CONTEXT_LINES = 2;
const MAX_REPLACE_PREVIEW_LINES = 9;
const MAX_REPLACE_PREVIEW_CHARS = 1_600;
const MAX_REPLACE_MATCH_LINES = 10;
const EXPLICIT_GUTTER = /^\d*│|^\d+\t/;

const read = type({
	start_line: type("number.integer >= 1").describe("First line, 1-based."),
	end_line: type("number.integer >= 1").describe("Last line, inclusive."),
});
const search = type({ query: type("string > 0").describe("Literal substring to find.") });
const replace = type({
	old_string: type("string > 0").describe("Exact text, including any whitespace you want to match."),
	new_string: type("string").describe("Replacement text; empty to delete."),
	"replace_all?": type("boolean").describe("Default false. Set true only to replace every occurrence in the draft."),
});

/** Tools scoped to one file's in-memory draft; none can touch the filesystem. */
export const APPLY_TOOLS: Tool[] = [
	{ name: "read", description: "Read numbered lines from the current draft.", parameters: read },
	{
		name: "search",
		description: "Find lines containing a literal substring in the current draft.",
		parameters: search,
	},
	{ name: "replace", description: "Replace exact text in the current draft.", parameters: replace },
];

/** Replayable exact replacement and its first affected line in the pre-edit draft. */
export interface AppliedReplace {
	old: string;
	replacement: string;
	all: boolean;
	at: number;
	line: number;
}

/**
 * Apply a validated literal replacement, including literal dollar signs in the payload.
 * `onMatch` optionally receives the offset of each original match in `text`.
 */
export function spliceReplacement(text: string, edit: AppliedReplace, onMatch?: (offset: number) => void): string {
	if (edit.all) {
		return text.replaceAll(edit.old, (_match, offset: number) => {
			onMatch?.(offset);
			return edit.replacement;
		});
	}
	onMatch?.(edit.at);
	return text.slice(0, edit.at) + edit.replacement + text.slice(edit.at + edit.old.length);
}

/** Count pre-edit newlines before `offset` to report a 1-based line number. */
function lineNumberAt(text: string, offset: number): number {
	let line = 1;
	for (let nl = text.indexOf("\n"); nl >= 0 && nl < offset; nl = text.indexOf("\n", nl + 1)) line++;
	return line;
}

/** Locate `old` in `text` when its leading line-number gutter was accidentally copied from a view. */
function findGutterMatch(text: string, old: string): { at: number; length: number } | undefined {
	if (!/^(?:\d*│|\d*\t)/m.test(old)) return undefined;
	const pattern = old
		.split("\n")
		.map((line, i) => {
			const gutter = EXPLICIT_GUTTER.exec(line);
			// A bare tab may be real indentation on one line and leaked on the next.
			const tab = !gutter && line.startsWith("\t");
			const boundary = i === 0 && (gutter || tab) ? "(?<![^\\n])" : "";
			return boundary + (tab ? "\\t?" : "") + RegExp.escape(line.slice(gutter?.[0].length ?? (tab ? 1 : 0)));
		})
		.join("\\n");
	const regex = new RegExp(pattern, "g");
	const match = regex.exec(text);
	if (!match || match[0].length === 0) return undefined;
	regex.lastIndex = match.index + 1;
	if (regex.exec(text) !== null) return undefined;
	return { at: match.index, length: match[0].length };
}

/** Numbered draft lines around a 1-based inclusive window, bounded for previews. */
function draftAnchor(lines: readonly string[], from: number, to: number): string {
	const start = from - 1;
	const end = Math.min(lines.length, to, start + MAX_READ_LINES);
	const out = numberedLines(lines, start, end - 1, MAX_TEXT_CHARS);
	return out.length < to - from + 1 ? `${out.join("\n")}\n⋮ Use read for more draft lines.` : out.join("\n");
}

/** Find a unique whitespace-insensitive match and map it back to the original draft lines. */
function whitespaceLead(text: string, old: string): string | undefined {
	const compact = old.replace(/\s+/g, "");
	if (compact === "") return undefined;
	const flat = text.replace(/\s+/g, "");
	const at = flat.indexOf(compact);
	if (at < 0 || flat.indexOf(compact, at + 1) >= 0) return undefined;
	// The compact match offset does not map to `text`, so a second traversal counts
	// non-whitespace characters per original line until the match is covered.
	const lines = fileLines(text);
	let offset = 0;
	let from = 0;
	for (let i = 0; i < lines.length; i++) {
		offset += lines[i].replace(/\s+/g, "").length;
		if (from === 0 && offset > at) from = i + 1;
		if (offset >= at + compact.length) return draftAnchor(lines, from, i + 1);
	}
	return undefined;
}

/** Explain the likeliest reason an exact `old_string` lookup failed. */
function missingAnchor(text: string, old: string, replacement: string): string {
	const gutter = findGutterMatch(text, old);
	if (gutter) {
		const lines = fileLines(text);
		const from = lineNumberAt(text, gutter.at);
		return `old_string not found. The line-number gutter was copied. Remove it from both strings and copy only the text after │:\n${draftAnchor(lines, from, lineNumberAt(text, gutter.at + gutter.length - 1))}`;
	}
	const lead = whitespaceLead(text, old);
	if (lead) return `old_string not found. Whitespace differs. Copy the exact text after │:\n${lead}`;
	if (replacement !== "") {
		const at = text.indexOf(replacement);
		if (at >= 0)
			return `old_string not found. new_string is already present on line ${lineNumberAt(text, at)}. Check if this change was already applied.`;
	}
	return "old_string not found. Search for a short fragment, then read and copy the exact text.";
}

/** Replace every match while collecting the original line numbers of the first few. */
function replaceAllWithLocations(text: string, step: AppliedReplace): { content: string; message: string } {
	let count = 0;
	let line = step.line;
	let newline = text.indexOf("\n", step.at);
	const lines: number[] = [];
	const content = spliceReplacement(text, step, offset => {
		count++;
		if (lines.length > MAX_REPLACE_MATCH_LINES) return;
		while (newline >= 0 && newline < offset) {
			line++;
			newline = text.indexOf("\n", newline + 1);
		}
		if (lines.at(-1) !== line) lines.push(line);
	});
	const capped = lines.length > MAX_REPLACE_MATCH_LINES;
	if (capped) lines.pop();
	return {
		content,
		message: `Replaced ${count} ${count === 1 ? "match" : "matches"} (original ${lines.length === 1 ? "line" : "lines"} ${lines.join(", ")}${capped ? ", …" : ""}).`,
	};
}

/** Numbered preview of the first edited region in the post-edit draft. */
function replacementPreview(content: string, step: AppliedReplace): string {
	if (content === "") return "The draft is empty.";
	const { at, line, replacement } = step;
	const editedLineStart = at === 0 ? 0 : content.lastIndexOf("\n", at - 1) + 1;
	// Crop huge leading indentation on very long lines so the edit stays visible.
	const cropped = at - editedLineStart > MAX_REPLACE_PREVIEW_CHARS / 2;
	let from = cropped ? at - MAX_REPLACE_PREVIEW_CHARS / 4 : editedLineStart;
	let first = line - 1;
	for (let i = 0; i < REPLACE_CONTEXT_LINES && from > 0 && !cropped; i++) {
		const previous = from > 1 ? content.lastIndexOf("\n", from - 2) + 1 : 0;
		if (editedLineStart - previous > MAX_REPLACE_PREVIEW_CHARS / 3) break;
		from = previous;
		first--;
	}
	let to = from;
	let after = 0;
	const limit = Math.min(content.length, from + MAX_REPLACE_PREVIEW_CHARS + 1);
	for (let i = 0; i < MAX_REPLACE_PREVIEW_LINES && to < limit; i++) {
		if (to > at && to >= at + replacement.length && after++ >= REPLACE_CONTEXT_LINES) break;
		const newline = content.indexOf("\n", to);
		to = newline < 0 ? limit : Math.min(newline + 1, limit);
	}
	const lines = fileLines(content.slice(from, to));
	if (cropped && lines.length > 0) lines[0] = `…${lines[0]}`;
	return numberedLines(lines, 0, lines.length - 1, MAX_REPLACE_PREVIEW_CHARS, first).join("\n");
}

/** Stage an exact match or return a model-facing error without changing the draft. */
export function applyReplace(
	text: string,
	args: Record<string, unknown>,
): { content: string; step: AppliedReplace; message: string } | { error: string } {
	if (args.new_string === undefined || args.new_string === null)
		return { error: 'new_string is required; pass "" to delete.' };
	const input = replace(args);
	if (input instanceof type.errors) return { error: input.summary };
	const old = normalizeToLF(input.old_string);
	const replacement = normalizeToLF(input.new_string);
	if (old.includes("\0") || replacement.includes("\0")) return { error: "NUL bytes are not allowed in text edits." };
	const all = input.replace_all ?? false;
	if (all && old.trim() === "") return { error: "replace_all cannot be used on whitespace-only old_string." };
	if (old === replacement) return { error: "old_string and new_string are identical." };
	const at = text.indexOf(old);
	if (at < 0) return { error: missingAnchor(text, old, replacement) };
	const line = lineNumberAt(text, at);
	if (!all && text.indexOf(old, at + old.length) >= 0) {
		return {
			error: `old_string matches more than once (first on line ${line}). Include more context or pass replace_all: true.`,
		};
	}
	const step = { old, replacement, all, at, line };
	const { content, message } = all
		? replaceAllWithLocations(text, step)
		: { content: spliceReplacement(text, step), message: `Replaced text on line ${line}.` };
	return {
		content,
		step,
		message: `${message}\nDraft near the ${all ? "first " : ""}edit:\n${replacementPreview(content, step)}`,
	};
}

/** Read a bounded line window from the current draft, not the original snapshot. */
export function readBufferLines(text: string, args: Record<string, unknown>): { text: string } | { error: string } {
	const input = read(args);
	if (input instanceof type.errors) return { error: input.summary };
	const lines = fileLines(text);
	if (text === "") return { text: "The draft is empty." };
	const start = input.start_line - 1;
	if (start >= lines.length || input.end_line <= start) return { error: `Invalid range for ${lines.length} lines.` };
	const end = Math.min(lines.length, input.end_line, start + MAX_READ_LINES);
	const out = numberedLines(lines, start, end - 1, MAX_TEXT_CHARS);
	const last = start + out.length;
	return {
		text: `Lines ${start + 1}-${last} of ${lines.length}:\n${out.join("\n")}${last < Math.min(input.end_line, lines.length) ? `\n⋮ Read again starting at line ${last + 1}.` : ""}`,
	};
}

/** Search literal text in the current draft and return bounded numbered matches. */
export function searchBuffer(text: string, args: Record<string, unknown>): { text: string } | { error: string } {
	const input = search(args);
	if (input instanceof type.errors) return { error: input.summary };
	const lines = fileLines(text);
	const matches: string[] = [];
	let total = 0;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const at = line.indexOf(input.query);
		if (at < 0) continue;
		total++;
		if (matches.length >= MAX_SEARCH_HITS) continue;
		const from = Math.max(0, at - 100);
		const to = Math.min(line.length, from + 300);
		matches.push(`${i + 1}│${from > 0 ? "…" : ""}${line.slice(from, to)}${to < line.length ? "…" : ""}`);
	}
	return { text: total ? `${total} matches:\n${matches.join("\n")}` : "No matches." };
}

/** Give the model the last syntax regression in the draft's edit history as a repair lead. */
export function diagnoseBufferSyntax(
	original: string,
	working: string,
	applied: readonly AppliedReplace[],
	parses: (code: string) => boolean,
): string {
	let draft = original;
	let lastGood = -1;
	for (let i = 0; i + 1 < applied.length; i++) {
		draft = spliceReplacement(draft, applied[i]);
		if (parses(draft)) lastGood = i;
	}
	const step = applied[lastGood + 1];
	const lines = fileLines(working);
	const near = Math.min(step.line - 1, lines.length - 1);
	const context = numberedLines(lines, Math.max(0, near - 3), Math.min(lines.length - 1, near + 5), MAX_TEXT_CHARS);
	return `The draft first stopped parsing after replace #${lastGood + 2} (then at line ${step.line}). Current lines near that location:\n${context.join("\n")}`;
}
