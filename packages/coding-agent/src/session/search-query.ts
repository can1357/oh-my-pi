/**
 * Word-search queries shared by the FTS5 indexes over local history (prompt
 * history, session transcripts) and the text matched outside them (queued
 * prompts, session titles, recaps), so every source answers a query alike.
 *
 * Each whitespace-delimited term is one phrase of its letter and digit runs,
 * matched as consecutive words with the last run as a word prefix, case- and
 * Latin-accent-insensitive: `git-commit` finds "git commit" and "Git
 * commits", never "commit to git"; `arch` finds "archive", `chiv` does not.
 */

/** A parsed word-search query. */
export interface WordQuery {
	/** FTS5 MATCH expression: every term as a prefix phrase (`git-commit` → `"git commit"*`). */
	match: string;
	/** Whether `text` holds every term the way the FTS5 index matches {@link match}. */
	test(text: string): boolean;
	/** Character range of the first place a term matches in `text`; `undefined` when none does. */
	locate(text: string): { start: number; end: number } | undefined;
}

/** A letter-and-digit run with its place in the text it came from. */
interface PlacedToken {
	token: string;
	start: number;
	end: number;
}

const TOKEN = /[\p{L}\p{N}]+/gu;
const ASCII = /^[\x00-\x7f]*$/;

/** A term's letter and digit runs, as FTS5's unicode61 tokenizer splits indexed text. */
function ftsTokens(term: string): string[] {
	return term.split(/[^\p{L}\p{N}]+/u).filter(token => token.length > 0);
}

/** `text` case-folded with Latin diacritics removed, as the unicode61 tokenizer indexes it. */
function ftsFold(text: string): string {
	return text
		.toLowerCase()
		.normalize("NFD")
		.replace(/(\p{Script=Latin})\p{M}+/gu, "$1")
		.normalize("NFC");
}

/** Whether `phrase` occurs as consecutive `tokens`, its last token as a prefix: an FTS5 `"…"*` phrase. */
function hasPhrasePrefix(tokens: string[], phrase: string[]): boolean {
	const last = phrase.length - 1;
	if (last < 0) return false;
	for (let start = 0; start + last < tokens.length; start++) {
		if (!tokens[start + last].startsWith(phrase[last])) continue;
		let index = 0;
		while (index < last && tokens[start + index] === phrase[index]) index++;
		if (index === last) return true;
	}
	return false;
}

/** One token folded as {@link ftsFold} folds text; ASCII, nearly every token, only needs lowercasing. */
function foldToken(token: string): string {
	return ASCII.test(token) ? token.toLowerCase() : ftsFold(token);
}

/** Parses `query`; `undefined` when no term holds a letter or digit, which matches nothing. */
export function wordQuery(query: string): WordQuery | undefined {
	const terms = query.split(/\s+/u);
	// FTS5 folds the MATCH expression with its own tokenizer; JS matching folds both sides here.
	const phrases = terms.map(ftsTokens).filter(phrase => phrase.length > 0);
	if (phrases.length === 0) return undefined;
	const folded = terms.map(term => ftsTokens(ftsFold(term))).filter(phrase => phrase.length > 0);
	return {
		match: phrases.map(phrase => `"${phrase.join(" ")}"*`).join(" "),
		test: text => {
			const tokens = ftsTokens(ftsFold(text));
			return folded.every(phrase => hasPhrasePrefix(tokens, phrase));
		},
		locate: text => {
			const longest = Math.max(...folded.map(phrase => phrase.length));
			// The newest `longest` tokens: a hit is a phrase ending at the newest one.
			const recent: PlacedToken[] = [];
			for (const run of text.matchAll(TOKEN)) {
				recent.push({ token: foldToken(run[0]), start: run.index, end: run.index + run[0].length });
				if (recent.length > longest) recent.shift();
				for (const phrase of folded) {
					const first = recent.length - phrase.length;
					if (
						first < 0 ||
						!hasPhrasePrefix(
							recent.slice(first).map(placed => placed.token),
							phrase,
						)
					)
						continue;
					return { start: recent[first].start, end: recent[recent.length - 1].end };
				}
			}
			return undefined;
		},
	};
}
