/**
 * macOS spelling in the composer (`spelling.typoDetection`, `spelling.autocorrect`):
 * misspelled prose words are underlined (`typo`) once the caret has left them,
 * a confident correction replaces a word when a space or punctuation completes
 * it, and the suggestions key lists replacement guesses for the word at the
 * caret in the completion popup.
 */
import type { KeyEvent } from "@oh-my-pi/pi-tui";
import { signal } from "@oh-my-pi/pi-tui";
import type { MacOSSpellingFeatures, MacOSSpellingProvider } from "../../modes/view-model/prompt/macos-spelling";
import type { TypingWord } from "../../modes/view-model/prompt/typing-word";
import type { Composer, ComposerDecoration } from "./composer";

/** What the composer needs of the spelling service. */
export type SpellingService = Pick<
	MacOSSpellingProvider,
	"setFeatures" | "typoRanges" | "tryAutocorrect" | "getWordReplacements" | "onUpdate"
>;

export interface ComposerSpellingOptions {
	/** The enabled features (read on every draft change, so settings toggles apply at the next edit). */
	features(): MacOSSpellingFeatures;
	/** The key that lists replacement guesses (`tui.editor.spellingSuggestions`). */
	isSuggestionsKey(key: KeyEvent): boolean;
}

/** A character that completes a word (autocorrect runs after it). */
const WORD_END = /^[\s.,;:!?"\])}]$/u;
const WORD_CHAR = /[\p{L}\p{M}']/u;

/** Lines of `text` and the caret's line and column. */
function position(text: string, cursor: number): { lines: string[]; line: number; col: number } {
	const before = text.slice(0, cursor).split("\n");
	return { lines: text.split("\n"), line: before.length - 1, col: before.at(-1)!.length };
}

/** Offset of `line`:`col` in `lines` joined by newlines. */
function offsetOf(lines: readonly string[], line: number, col: number): number {
	let offset = col;
	for (let i = 0; i < line; i++) offset += lines[i]!.length + 1;
	return offset;
}

/** The word the caret touches on its line (typo marks wait until the caret leaves it). */
function typingWord(lines: readonly string[], line: number, col: number): TypingWord | undefined {
	const text = lines[line] ?? "";
	let start = col;
	while (start > 0 && WORD_CHAR.test(text[start - 1]!)) start--;
	let end = col;
	while (end < text.length && WORD_CHAR.test(text[end]!)) end++;
	return start < end ? { line, start, end } : undefined;
}

/** Attach `service` to `composer`; returns the detach. */
export function attachSpelling(
	composer: Composer,
	service: SpellingService,
	options: ComposerSpellingOptions,
): () => void {
	// Bumped when an answer arrives that changes the marks.
	const revision = signal(0);
	service.onUpdate = () => revision.set(revision.peek() + 1);

	const decorate = (text: string): ComposerDecoration[] => {
		service.setFeatures(options.features());
		revision();
		if (text === "") return [];
		const { lines, line, col } = position(text, composer.cursor());
		const typing = typingWord(lines, line, col);
		const out: ComposerDecoration[] = [];
		lines.forEach((content, index) => {
			if (content === "") return;
			const offset = offsetOf(lines, index, 0);
			for (const range of service.typoRanges(content, { editorText: text, lines, line: index, startCol: 0, typing }))
				out.push({ from: offset + range.start, to: offset + range.start + range.length, s: "typo" });
		});
		return out;
	};

	const autocorrect = (edit: { readonly insert: string; readonly typed: boolean }): void => {
		if (!edit.typed || !WORD_END.test(edit.insert)) return;
		const text = composer.text();
		const cursor = composer.cursor();
		const { lines, line, col } = position(text, cursor);
		void service.tryAutocorrect(lines, line, col).then(
			replacement => {
				// Typing on since the word ended leaves the correction stale.
				if (!replacement || composer.text() !== text || composer.cursor() !== cursor) return;
				composer.replaceRange(cursor - replacement.replaceLen, cursor, replacement.insert);
			},
			() => {},
		);
	};

	const suggest = (key: KeyEvent): boolean => {
		if (key.kind === "release" || !options.isSuggestionsKey(key) || !options.features().typoDetection) return false;
		const text = composer.text();
		const cursor = composer.cursor();
		const { lines, line, col } = position(text, cursor);
		void service.getWordReplacements(lines, line, col).then(
			found => {
				if (!found || composer.text() !== text || composer.cursor() !== cursor) return;
				const from = offsetOf(lines, found.line, found.startCol);
				composer.showReplacements(from, from + (found.endCol - found.startCol), found.items);
			},
			() => {},
		);
		return true;
	};

	const removals = [
		composer.addDecorator(decorate),
		composer.addEditListener(autocorrect),
		composer.addKeyHandler(suggest),
	];
	return () => {
		for (const remove of removals) remove();
		service.onUpdate = undefined;
	};
}
