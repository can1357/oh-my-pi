/**
 * Graded matching of typed text against named candidates: slash commands,
 * skills, `#` prompt actions, internal URLs, and the searchable pickers
 * (settings, models, sessions, `/tree`, agents, extensions).
 *
 * A candidate offers names (its name, label, id or title, then aliases or
 * keywords) and optional details (description, value, transcript text). Each
 * typed word is lined up with a span of a name in one of three ways, and the
 * kind of match says which way and where the span starts:
 *
 * | span starts at   | letter for letter | with typos   | as an abbreviation |
 * | ---------------- | ----------------- | ------------ | ------------------ |
 * | the whole name   | `exact`           | `typo`       |                    |
 * | the name's start | `prefix`          | `prefixTypo` | `abbreviation`     |
 * | a later word     | `word`            | `wordTypo`   | `wordAbbreviation` |
 * | inside a word    | `substring`       |              |                    |
 *
 * plus `detail`: a word of the details starts with the typed word, and
 * `identifier`: the typed word occurs anywhere in an identifier, letter for letter.
 *
 * - Letter for letter, punctuation may also be left out on either side
 *   (`gpt5` → `gpt-5`, `statusline` → `status line`).
 * - A typo is one skipped, extra, wrong, or swapped adjacent letter, counted
 *   with punctuation left out on both sides, so a typo may span words
 *   (`claudfable` → `claude-fable`, `gtp5` → `gpt-5`, `dabl` → `claude-fable`).
 * - An abbreviation takes the typed letters as runs of the name, each later run
 *   either further inside the same word (`clr` → `clear`) or at a later word's
 *   start (`rp` → `reload-plugins`, `mrs` → `modelRoleStorage`), never both.
 *
 * Ranking: letter-for-letter matches first, by where they start; then typos and
 * abbreviations together, by how many letters are off (edits, or breaks between
 * runs), then by where they start; details, then identifiers, last. {@link compareTextMatches}
 * implements this as tier, then cost, then kind order. Remaining ties are the
 * caller's (usage, recency, registry order).
 *
 * A query of several words matches when every word does, ranking by its
 * weakest word, or when the whole query is found literally in a name (`dark
 * theme` in "Dark Theme"), ranking as that one match; the stronger wins.
 *
 * Text is compared after Unicode compatibility folding without accents or
 * invisible characters (`café` = `cafe`, `ｃｌａｕｄｅ` = `claude`).
 */

export const MATCH_KINDS = [
	"exact",
	"prefix",
	"word",
	"substring",
	"typo",
	"prefixTypo",
	"abbreviation",
	"wordTypo",
	"wordAbbreviation",
	"detail",
	"identifier",
] as const;

export type MatchKind = (typeof MATCH_KINDS)[number];

/** Kinds that found the typed text letter for letter, as opposed to a typo or an abbreviation of it. */
export const LITERAL_MATCH_KINDS: ReadonlySet<MatchKind> = new Set([
	"exact",
	"prefix",
	"word",
	"substring",
	"detail",
	"identifier",
]);

export interface TextMatch {
	readonly kind: MatchKind;
	/**
	 * Lower is closer: letters off for a typo (edits) or an abbreviation (breaks
	 * between runs); 1 for a letter-for-letter match found only with punctuation
	 * left out; the offset for details.
	 */
	readonly cost: number;
	/**
	 * Index into {@link MatchFields.names} of the matching name, for a several-word
	 * query the name its first word matched; -1 when the details or identifiers matched.
	 */
	readonly nameIndex: number;
}

export interface MatchFields {
	/** Names, labels, ids or titles, primary first; equal matches keep the earlier name. Typos and abbreviations apply. */
	readonly names: readonly string[];
	/** Descriptions, values or transcript text. Match only where one of their words starts with a typed word. */
	readonly details?: string;
	/**
	 * Ids, paths or hashes. Match wherever a typed word occurs in them, letter for
	 * letter and never with typos: people search them by fragments (`9c21` from a
	 * session id, `project` from `/work/myproject`).
	 */
	readonly identifiers?: readonly string[];
}

export interface MatchOptions {
	/**
	 * Whether typo kinds apply (default true). Turn them off where a near
	 * miss of ordinary prose (`#fix`) would open a popup.
	 */
	readonly typos?: boolean;
	/**
	 * Whether abbreviation kinds apply (default true). Turn them off, with typos,
	 * to keep only letter-for-letter matches: a name abbreviation otherwise
	 * outranks the same word found literally in the details or identifiers.
	 */
	readonly abbreviations?: boolean;
}

/** A typo of a whole name needs three typed letters: one- and two-letter words are a single edit from most names. */
const MIN_TYPO_LENGTH = 3;
/**
 * A typo of part of a name needs four: with three, random three-letter input
 * matched 88% of model ids and a third of slash commands, against half and a
 * tenth letter for letter.
 */
const MIN_PARTIAL_TYPO_LENGTH = 4;
/**
 * From six typed letters, a span ending where a word or the name ends
 * tolerates two edits (Elasticsearch's `AUTO` fuzziness). A span ending inside
 * a word stays at one: two doubled how often unrelated seven-letter words
 * matched some model id.
 */
const TWO_TYPO_LENGTH = 6;

/** Literal kinds each form a tier; typos and abbreviations share one, ranked by letters off before position. */
const TIER: Readonly<Record<MatchKind, number>> = {
	exact: 0,
	prefix: 1,
	word: 2,
	substring: 3,
	typo: 4,
	prefixTypo: 4,
	abbreviation: 4,
	wordTypo: 4,
	wordAbbreviation: 4,
	detail: 5,
	identifier: 6,
};
const KIND_ORDER = Object.fromEntries(MATCH_KINDS.map((kind, order) => [kind, order])) as Record<MatchKind, number>;

/** Orders matches strongest first: by tier, then cost, then kind. */
export function compareTextMatches(a: TextMatch, b: TextMatch): number {
	return TIER[a.kind] - TIER[b.kind] || a.cost - b.cost || KIND_ORDER[a.kind] - KIND_ORDER[b.kind];
}

interface PreparedName {
	readonly lower: string;
	/** The folded text, index-aligned with {@link lower}; word starts read its case (camelCase humps). */
	readonly cased: string;
	/** 1 at each offset into {@link lower} where a word starts. */
	readonly wordStarts: Uint8Array;
	/** Offset of the first word start, or -1 for a name without letters or digits. */
	readonly firstWordStart: number;
	/** {@link lower} without separators. */
	readonly compact: string;
	/** Offsets into {@link compact} where words start. */
	readonly compactWordStarts: readonly number[];
	/** 1 at each offset into {@link compact} where a word starts or the name ends. */
	readonly boundaries: Uint8Array;
	/** {@link letterMask} of {@link compact}. */
	readonly letters: number;
}

interface PreparedDetails {
	readonly lower: string;
	readonly cased: string;
}

/**
 * A candidate prepared once for matching many queries: folding, lowercasing,
 * word splitting and the punctuation-free form are computed here instead of per
 * keystroke. Hold one per stable candidate (see {@link MatchCorpus}).
 */
export class MatchTarget {
	readonly #names: readonly (PreparedName | null)[];
	readonly #details: PreparedDetails | null;
	/** Folded, lowercased identifiers joined by newlines, or null. */
	readonly #identifiers: string | null;

	constructor(fields: MatchFields) {
		this.#names = fields.names.map(name => (name ? prepareName(name) : null));
		const details = fields.details ? fold(fields.details) : "";
		if (details) {
			const lower = details.toLowerCase();
			this.#details = { lower, cased: alignedCase(details, lower) };
		} else {
			this.#details = null;
		}
		const identifiers = fields.identifiers?.filter(Boolean).join("\n");
		this.#identifiers = identifiers ? fold(identifiers).toLowerCase() : null;
	}

	/** {@link matchText} against this prepared candidate. */
	match(query: string, options?: MatchOptions): TextMatch | null {
		const typos = options?.typos ?? true;
		const abbreviations = options?.abbreviations ?? true;
		const words = splitQuery(query);
		if (words.length === 0) {
			const first = this.#names.findIndex(name => name !== null);
			return { kind: "prefix", cost: 0, nameIndex: first };
		}
		if (words.length === 1) return this.#matchWord(words[0]!, typos, abbreviations);
		const phrase = this.#matchPhrase(words.join(" "));
		let weakest: TextMatch | null = null;
		let cost = 0;
		let nameIndex = -1;
		for (let index = 0; index < words.length; index++) {
			const match = this.#matchWord(words[index]!, typos, abbreviations);
			if (!match) return phrase;
			if (index === 0) nameIndex = match.nameIndex;
			const order = weakest ? TIER[match.kind] - TIER[weakest.kind] : 1;
			if (order > 0) {
				weakest = match;
				cost = match.cost;
			} else if (order === 0) {
				cost += match.cost;
				if (KIND_ORDER[match.kind] > KIND_ORDER[weakest!.kind]) weakest = match;
			}
		}
		const separate = weakest && { kind: weakest.kind, cost, nameIndex };
		return phrase && (!separate || compareTextMatches(phrase, separate) <= 0) ? phrase : separate;
	}

	#matchWord(word: string, typos: boolean, abbreviations: boolean): TextMatch | null {
		const compactWord = compactOf(word);
		let best: TextMatch | null = null;
		for (let index = 0; index < this.#names.length; index++) {
			const name = this.#names[index];
			if (!name) continue;
			const match = matchName(word, compactWord, name, index, typos, abbreviations);
			if (match && (!best || compareTextMatches(match, best) < 0)) best = match;
			if (best?.kind === "exact" && best.cost === 0) break;
		}
		if (best) return best;
		if (this.#details) {
			const offset = indexOfWordStart(this.#details.cased, this.#details.lower, word, 0);
			if (offset >= 0) return { kind: "detail", cost: offset, nameIndex: -1 };
		}
		const at = this.#identifiers?.indexOf(word) ?? -1;
		return at < 0 ? null : { kind: "identifier", cost: at, nameIndex: -1 };
	}

	/** A several-word query found letter for letter in one name. */
	#matchPhrase(phrase: string): TextMatch | null {
		const compactPhrase = compactOf(phrase);
		let best: TextMatch | null = null;
		for (let index = 0; index < this.#names.length; index++) {
			const name = this.#names[index];
			if (!name) continue;
			const match = literalMatch(phrase, compactPhrase, name, index);
			if (match && (!best || compareTextMatches(match, best) < 0)) best = match;
		}
		return best;
	}
}

/**
 * The strongest match of `query` against `fields`, or null. Case-insensitive;
 * an empty query is a prefix of every name. Pass a {@link MatchTarget} to reuse
 * its preparation.
 */
export function matchText(query: string, fields: MatchFields | MatchTarget, options?: MatchOptions): TextMatch | null {
	return (fields instanceof MatchTarget ? fields : new MatchTarget(fields)).match(query, options);
}

/**
 * The items `query` matches, strongest first. The sort is stable, so equal
 * matches keep the input order.
 */
export function rankByText<T>(
	query: string,
	items: readonly T[],
	fieldsOf: (item: T) => MatchFields | MatchTarget,
	options?: MatchOptions,
): Array<{ item: T; match: TextMatch }> {
	const ranked: Array<{ item: T; match: TextMatch }> = [];
	for (const item of items) {
		const match = matchText(query, fieldsOf(item), options);
		if (match) ranked.push({ item, match });
	}
	return ranked.sort((a, b) => compareTextMatches(a.match, b.match));
}

/** Items prepared once for repeated {@link rankByText}-equivalent ranking; hold one per stable candidate list. */
export class MatchCorpus<T> {
	readonly #items: readonly T[];
	readonly #targets: readonly MatchTarget[];

	constructor(items: readonly T[], fieldsOf: (item: T) => MatchFields) {
		this.#items = items;
		this.#targets = items.map(item => new MatchTarget(fieldsOf(item)));
	}

	get items(): readonly T[] {
		return this.#items;
	}

	/** Same results as `rankByText(query, items, fieldsOf, options)`. */
	rank(query: string, options?: MatchOptions): Array<{ item: T; match: TextMatch }> {
		const ranked: Array<{ item: T; match: TextMatch }> = [];
		for (let index = 0; index < this.#items.length; index++) {
			const match = this.#targets[index]!.match(query, options);
			if (match) ranked.push({ item: this.#items[index]!, match });
		}
		return ranked.sort((a, b) => compareTextMatches(a.match, b.match));
	}
}

/**
 * Filters and sorts `items` by how well `getText(item)` matches `query`.
 * Kept for extensions written against upstream Pi's `pi-tui` API; new code
 * uses {@link rankByText} with separate names and details.
 */
export function fuzzyFilter<T>(items: T[], query: string, getText: (item: T) => string): T[] {
	if (!query.trim()) return items;
	return rankByText(query, items, item => ({ names: [getText(item)] })).map(({ item }) => item);
}

/**
 * Whether `query` matches `text`, with a score where lower sorts first. Kept
 * for extensions written against upstream Pi's `pi-tui` API; the score only
 * orders results like {@link compareTextMatches} and has no other meaning.
 */
export function fuzzyMatch(query: string, text: string): { matches: boolean; score: number } {
	const match = matchText(query, { names: [text] });
	if (!match) return { matches: false, score: 0 };
	const within = match.cost * MATCH_KINDS.length + KIND_ORDER[match.kind];
	return { matches: true, score: TIER[match.kind] + within / (within + 1) };
}

const NON_ASCII = /[^\x00-\x7f]/;
const IGNORABLE = /[\p{M}\p{Cf}]/gu;

/** Compatibility-decomposed `text` without combining marks or invisible format characters. */
function fold(text: string): string {
	return NON_ASCII.test(text) ? text.normalize("NFKD").replace(IGNORABLE, "") : text;
}

function splitQuery(query: string): string[] {
	return fold(query).toLowerCase().split(/\s+/).filter(Boolean);
}

/**
 * The letter-for-letter match (`exact`, `prefix`, `word`, `substring`) of `word`
 * in `name`, or null. Punctuation-free comparison (`gpt5` → `gpt-5`) counts only
 * from a word start, so a substring never spans word gaps (`mn` in
 * `rando·m n·otes`), and costs 1, so `app` puts "app" ahead of "a_p_p". A word
 * ending in punctuation promises more of the name, so it is never the whole name
 * (`gpt-5:` puts "gpt-5:batch" ahead of "gpt-5").
 */
function literalMatch(word: string, compactWord: string, name: PreparedName, nameIndex: number): TextMatch | null {
	const { lower, cased, compact } = name;
	// The punctuation-free forms only add matches when either side had punctuation.
	const viaCompact = compactWord.length > 0 && (compact !== lower || compactWord !== word);
	const continues = !isWordChar(word.charCodeAt(word.length - 1));
	if (word === lower) return { kind: "exact", cost: 0, nameIndex };
	if (viaCompact && !continues && compactWord === compact) return { kind: "exact", cost: 1, nameIndex };
	if (lower.startsWith(word)) return { kind: "prefix", cost: 0, nameIndex };
	if (viaCompact && compact.startsWith(compactWord)) return { kind: "prefix", cost: 1, nameIndex };
	if (indexOfWordStart(cased, lower, word, 1) > 0) return { kind: "word", cost: 0, nameIndex };
	if (viaCompact && compactWordStartIndex(name, compactWord) > 0) return { kind: "word", cost: 1, nameIndex };
	if (lower.includes(word)) return { kind: "substring", cost: 0, nameIndex };
	return null;
}

function matchName(
	word: string,
	compactWord: string,
	name: PreparedName,
	nameIndex: number,
	typos: boolean,
	abbreviations: boolean,
): TextMatch | null {
	const literal = literalMatch(word, compactWord, name, nameIndex);
	if (literal) return literal;
	const typo = typos ? typoMatch(compactWord, name, nameIndex) : null;
	const abbreviation = abbreviations ? abbreviationMatch(word, name, nameIndex) : null;
	if (!typo) return abbreviation;
	return abbreviation && compareTextMatches(abbreviation, typo) < 0 ? abbreviation : typo;
}

/**
 * The closest typo of `query` (punctuation-free) against a span of `name`'s
 * punctuation-free form that starts at a word start, or null. Within the edit
 * budget, a span is the whole name (`typo`, from three typed letters), or, from
 * four letters, any span from the name's start (`prefixTypo`) or a later word's
 * start (`wordTypo`); one ending inside a word allows a single edit.
 */
function typoMatch(query: string, name: PreparedName, nameIndex: number): TextMatch | null {
	const length = query.length;
	if (length < MIN_TYPO_LENGTH) return null;
	const maxEdits = length >= TWO_TYPO_LENGTH ? 2 : 1;
	if (missingLetters(query, name.letters) > maxEdits) return null;
	const { compact, compactWordStarts, boundaries } = name;
	const partial = length >= MIN_PARTIAL_TYPO_LENGTH;
	let best: TextMatch | null = null;
	for (const start of compactWordStarts) {
		// Zero edits from a word start is a letter-for-letter match, so one edit is the closest a typo
		// gets, and spans from later starts can no longer rank ahead.
		if (best?.cost === 1) break;
		const row = typoRow(query, compact, start, maxEdits);
		if (row === null) continue;
		// Spans shorter than the query by more than the budget are out of reach (see typoRow).
		for (let width = Math.max(1, length - maxEdits); width <= row.width; width++) {
			const edits = row.edits[width]!;
			if (edits > maxEdits) continue;
			const end = start + width;
			let kind: MatchKind;
			if (start === 0 && end === compact.length) kind = "typo";
			else if (!partial || (edits > 1 && boundaries[end] !== 1)) continue;
			else kind = start === 0 ? "prefixTypo" : "wordTypo";
			const match: TextMatch = { kind, cost: edits, nameIndex };
			if (!best || compareTextMatches(match, best) < 0) best = match;
		}
	}
	return best;
}

/** One bit per letter, a few for digits, one for every other character: shared bits only lower {@link missingLetters}. */
function letterMask(text: string): number {
	let mask = 0;
	for (let index = 0; index < text.length; index++) mask |= letterBit(text.charCodeAt(index));
	return mask;
}

function letterBit(code: number): number {
	if (code >= 97 && code <= 122) return 1 << (code - 97);
	if (code >= 48 && code <= 57) return 1 << (26 + ((code - 48) % 5));
	return 1 << 31;
}

/** Distinct characters of `query` absent from a name with mask `letters`: each needs its own edit. */
function missingLetters(query: string, letters: number): number {
	let missing = 0;
	for (let index = 0; index < query.length; index++) {
		const bit = letterBit(query.charCodeAt(index));
		if ((letters & bit) === 0) {
			missing++;
			letters |= bit;
		}
	}
	return missing;
}

const WORD_CHAR = /[\p{L}\p{M}\p{N}]/u;
/** Scripts whose compounds run together without spaces: each of their characters may start a word. */
const UNSPACED_SCRIPT =
	/[\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}\p{sc=Hangul}\p{sc=Thai}\p{sc=Lao}\p{sc=Khmer}\p{sc=Myanmar}]/u;
const SEPARATOR = 1;
const WORD = 2;
const UNSPACED_WORD = 3;
/** Class of each BMP code unit above ASCII, filled on first use (0 = not yet classified). */
let nonAsciiClasses: Uint8Array | undefined;

/**
 * Class of a code unit of lowercased text: letters, marks and digits continue
 * a word; punctuation, symbols and spaces separate words (`foo—bar` is two
 * words like `foo-bar`). Astral code units (emoji, mostly) separate words too.
 */
function charClass(code: number): number {
	if (code < 128) return (code >= 48 && code <= 57) || (code >= 97 && code <= 122) ? WORD : SEPARATOR;
	if (code >= 0xd800 && code <= 0xdfff) return SEPARATOR;
	nonAsciiClasses ??= new Uint8Array(0x10000);
	let wordClass = nonAsciiClasses[code]!;
	if (wordClass === 0) {
		const char = String.fromCharCode(code);
		wordClass = !WORD_CHAR.test(char) ? SEPARATOR : UNSPACED_SCRIPT.test(char) ? UNSPACED_WORD : WORD;
		nonAsciiClasses[code] = wordClass;
	}
	return wordClass;
}

function isWordChar(code: number): boolean {
	return charClass(code) !== SEPARATOR;
}

function isUpper(code: number): boolean {
	return code >= 65 && code <= 90;
}

/** `text` when lowercasing kept its length, else `lower`: word starts read case by index. */
function alignedCase(text: string, lower: string): string {
	return lower.length === text.length ? text : lower;
}

/**
 * Whether a word starts at `index`: at the start, after a separator, at an
 * uppercase letter after a lowercase one or a digit (`usage·Aware·Fallback`),
 * at the last capital of an uppercase run when a lowercase letter follows
 * (`WK·Web·View`, `MCP·Server`), or at any character of a script written
 * without spaces, or right after one (`文·件·搜·索`).
 * `lower` is the text lowercased; `cased` is the folded text, index-aligned with it.
 */
function isWordStart(cased: string, lower: string, index: number): boolean {
	if (index === 0) return true;
	const before = charClass(lower.charCodeAt(index - 1));
	if (before !== WORD) return true;
	if (charClass(lower.charCodeAt(index)) === UNSPACED_WORD) return true;
	if (!isUpper(cased.charCodeAt(index))) return false;
	if (!isUpper(cased.charCodeAt(index - 1))) return true;
	const next = cased.charCodeAt(index + 1);
	return next >= 97 && next <= 122;
}

/** First offset at or after `from` where `needle` occurs at the start of a word of `lower`, or -1. */
function indexOfWordStart(cased: string, lower: string, needle: string, from: number): number {
	for (let at = lower.indexOf(needle, from); at >= 0; at = lower.indexOf(needle, at + 1)) {
		if (isWordStart(cased, lower, at)) return at;
	}
	return -1;
}

/** First offset into the name's punctuation-free form where `compactWord` starts a word, or -1. */
function compactWordStartIndex(name: PreparedName, compactWord: string): number {
	for (let at = name.compact.indexOf(compactWord); at >= 0; at = name.compact.indexOf(compactWord, at + 1)) {
		if (name.boundaries[at] === 1) return at;
	}
	return -1;
}

function compactOf(text: string): string {
	let compact = "";
	for (let index = 0; index < text.length; index++) {
		if (isWordChar(text.charCodeAt(index))) compact += text[index];
	}
	return compact;
}

function prepareName(text: string): PreparedName {
	const folded = fold(text);
	const lower = folded.toLowerCase();
	const cased = alignedCase(folded, lower);
	const wordStarts = new Uint8Array(lower.length);
	const compactWordStarts: number[] = [];
	let firstWordStart = -1;
	let compact = "";
	for (let index = 0; index < lower.length; index++) {
		if (!isWordChar(lower.charCodeAt(index))) continue;
		if (isWordStart(cased, lower, index)) {
			wordStarts[index] = 1;
			if (firstWordStart < 0) firstWordStart = index;
			compactWordStarts.push(compact.length);
		}
		compact += lower[index];
	}
	const boundaries = new Uint8Array(compact.length + 1);
	for (const start of compactWordStarts) boundaries[start] = 1;
	boundaries[compact.length] = 1;
	return {
		lower,
		cased,
		wordStarts,
		firstWordStart,
		compact,
		compactWordStarts,
		boundaries,
		letters: letterMask(compact),
	};
}

const UNREACHABLE = 1 << 30;
/** Longer typed words are pasted text, not abbreviations. */
const MAX_ABBREVIATION_LENGTH = 32;
/** Bound on typed letters times name length: the search costs one cell per pair, twice. */
const MAX_ABBREVIATION_CELLS = MAX_ABBREVIATION_LENGTH * 512;
// Scratch rows reused across calls: matching runs once per candidate per keystroke.
let runsPrev = new Int32Array(64);
let runsNext = new Int32Array(64);

/**
 * The abbreviation of `word` in `name` with the fewest breaks, or null: its
 * letters as runs of the name, the first from a word start, each later one
 * either further inside the word the previous run ended in, or at a later
 * word's start. One match keeps to one of the two; mixing them lets random
 * letters line up in long names (`b·r` in "bedrock" then `d·p` in "deepseek").
 * A run may continue across a word start. Linear in the name per typed letter;
 * names too long for the typed word's cell budget get no abbreviation.
 */
function abbreviationMatch(word: string, name: PreparedName, nameIndex: number): TextMatch | null {
	if (word.length < 2 || word.length > MAX_ABBREVIATION_LENGTH) return null;
	if (word.length * name.lower.length > MAX_ABBREVIATION_CELLS || !isSubsequence(word, name.lower)) return null;
	const { lower, wordStarts, firstWordStart } = name;
	const length = lower.length;
	if (runsPrev.length < length) {
		runsPrev = new Int32Array(length);
		runsNext = new Int32Array(length);
	}
	// Cells hold breaks * 2, plus 1 when the first run starts after the name's first word.
	let best = UNREACHABLE;
	for (const resumeAtWordStart of [false, true]) {
		let prev = runsPrev;
		let next = runsNext;
		const first = word.charCodeAt(0);
		for (let at = 0; at < length; at++) {
			prev[at] =
				lower.charCodeAt(at) === first && wordStarts[at] === 1 ? (at === firstWordStart ? 0 : 1) : UNREACHABLE;
		}
		for (let index = 1; index < word.length; index++) {
			const code = word.charCodeAt(index);
			// Fewest over earlier cells a break may leave from: any, or only within the current word.
			let fromBreak = UNREACHABLE;
			for (let at = 0; at < length; at++) {
				if (!resumeAtWordStart && wordStarts[at] === 1) fromBreak = UNREACHABLE;
				let cell = UNREACHABLE;
				if (lower.charCodeAt(at) === code) {
					if (at > 0) cell = prev[at - 1]!;
					if (wordStarts[at] === (resumeAtWordStart ? 1 : 0) && fromBreak + 2 < cell) cell = fromBreak + 2;
				}
				// This cell's predecessor is a break source from the next cell on; in-word breaks stay inside its word.
				if (at > 0 && (resumeAtWordStart || wordStarts[at] === 0) && prev[at - 1]! < fromBreak) {
					fromBreak = prev[at - 1]!;
				}
				next[at] = cell;
			}
			[prev, next] = [next, prev];
		}
		for (let at = 0; at < length; at++) if (prev[at]! < best) best = prev[at]!;
	}
	const breaks = best >> 1;
	// No break means one run, which the letter-for-letter kinds already cover.
	if (best >= UNREACHABLE || breaks === 0) return null;
	return { kind: (best & 1) === 0 ? "abbreviation" : "wordAbbreviation", cost: breaks, nameIndex };
}

function isSubsequence(word: string, text: string): boolean {
	let found = 0;
	for (let at = 0; at < text.length && found < word.length; at++) {
		if (text.charCodeAt(at) === word.charCodeAt(found)) found++;
	}
	return found === word.length;
}

let rowBefore = new Int32Array(32);
let rowPrev = new Int32Array(32);
let rowNext = new Int32Array(32);

/**
 * Optimal-string-alignment edits from `query` to every prefix of
 * `text.slice(from)` up to `width` letters (`edits[j]` for `text[from, from + j)`),
 * or null once every prefix is more than `maxEdits` away. `width` stops at
 * `query.length + maxEdits`: longer prefixes are out of reach. Only cells within
 * `maxEdits` of the diagonal are computed, so a long query costs its length
 * times the budget, and `edits[j]` is meaningful only for
 * `j >= query.length - maxEdits`. The returned row is scratch, valid until the next call.
 */
function typoRow(
	query: string,
	text: string,
	from: number,
	maxEdits: number,
): { width: number; edits: Int32Array } | null {
	const width = Math.min(text.length - from, query.length + maxEdits);
	if (width < query.length - maxEdits) return null;
	if (rowPrev.length <= width + 1) {
		rowBefore = new Int32Array(width + 2);
		rowPrev = new Int32Array(width + 2);
		rowNext = new Int32Array(width + 2);
	}
	// Stands in for every cell off the band: all of them are out of reach.
	const beyond = maxEdits + 1;
	let before = rowBefore;
	let prev = rowPrev;
	let next = rowNext;
	for (let j = 0; j <= width; j++) prev[j] = Math.min(j, beyond);
	for (let i = 1; i <= query.length; i++) {
		const code = query.charCodeAt(i - 1);
		const low = Math.max(1, i - maxEdits);
		const high = Math.min(width, i + maxEdits);
		next[low - 1] = low === 1 ? Math.min(i, beyond) : beyond;
		let rowMin = next[low - 1]!;
		for (let j = low; j <= high; j++) {
			const at = from + j - 1;
			let edits = Math.min(prev[j]! + 1, next[j - 1]! + 1, prev[j - 1]! + (code === text.charCodeAt(at) ? 0 : 1));
			if (i > 1 && j > 1 && code === text.charCodeAt(at - 1) && query.charCodeAt(i - 2) === text.charCodeAt(at)) {
				edits = Math.min(edits, before[j - 2]! + 1);
			}
			next[j] = edits;
			if (edits < rowMin) rowMin = edits;
		}
		// The next row reads one cell past this band.
		if (high < width) next[high + 1] = beyond;
		// Row minimums never decrease, so no prefix can come back within reach.
		if (rowMin > maxEdits) return null;
		[before, prev, next] = [prev, next, before];
	}
	[rowBefore, rowPrev, rowNext] = [before, prev, next];
	return { width, edits: prev };
}
