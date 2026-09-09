/**
 * Fuzzy matching utilities.
 *
 * Matching is deliberately word-local for normal words. This keeps a query like
 * "image provider" from matching a long setting description only because the
 * letters i-m-a-g-e appear somewhere in order across unrelated words.
 *
 * Lower score = better match.
 */

export interface FuzzyMatch {
	matches: boolean;
	score: number;
}

export interface FuzzyFilterResult<T> {
	item: T;
	score: number;
}

interface CharacterMatch {
	matches: boolean;
	score: number;
	span: number;
}

interface SearchWord {
	text: string;
	index: number;
	ordinal: number;
}

interface SearchIndex {
	normalized: string;
	compact: string;
	/** Start offsets of each word within `compact` (cumulative word lengths). */
	compactWordStarts: Set<number>;
	words: SearchWord[];
}

const ALPHANUMERIC_SWAP_PENALTY = 5;
const COMPACT_PHRASE_BONUS = 1200;
const PHRASE_BONUS = 1000;

/**
 * Shortest needle worth scanning past its leading occurrence for.
 *
 * One or two characters sit mid-word in nearly every candidate — "im" is inside
 * "experimental" — so rescanning that short would hand the word-start bonus to
 * the whole corpus at once and reshuffle the list on the opening keystrokes of a
 * search instead of narrowing it. Shadowing only misleads for real phrases.
 */
const MIN_SHADOW_RESCAN_LENGTH = 3;

function normalizeForSearch(value: string): string {
	return value
		.replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
		.replace(/([a-z0-9])([A-Z])/g, "$1 $2")
		.toLowerCase()
		.replace(/[^\p{Letter}\p{Mark}\p{Number}]+/gu, " ")
		.trim()
		.replace(/\s+/g, " ");
}

// Module-level memo of the per-text search index. `buildSearchIndex` is a pure
// function of `text`, but selectors call it once per candidate per keystroke —
// the same stable candidate list is re-filtered as the user types. Caching the
// index across keystrokes eliminates the redundant normalize + word-split + Set
// build on every character. Consumers only read the result, so sharing is safe.
//
// Admission is conservative so the cache helps the repeated-filter hot path
// without paying for one-off text: only short texts are cached (long inputs —
// pasted prompts, transcripts searched via the message selector — would bloat
// memory), and admission stops at the cap instead of evicting, so a stream of
// unique texts (message/session search) can't churn the map.
const INDEX_CACHE_MAX = 4096;
const MAX_CACHED_TEXT_LEN = 4096;
const indexCache = new Map<string, SearchIndex>();

function buildSearchIndex(text: string): SearchIndex {
	// Long inputs (pasted prompts, transcripts) are never cached; bypass the Map
	// entirely so they don't pay a hash lookup on every search.
	if (text.length > MAX_CACHED_TEXT_LEN) return buildUncachedSearchIndex(text);

	const cached = indexCache.get(text);
	if (cached !== undefined) return cached;

	const result = buildUncachedSearchIndex(text);
	if (indexCache.size < INDEX_CACHE_MAX) {
		indexCache.set(text, result);
	}
	return result;
}

function buildUncachedSearchIndex(text: string): SearchIndex {
	const normalized = normalizeForSearch(text);
	if (normalized.length === 0) {
		return { normalized, compact: "", compactWordStarts: new Set(), words: [] };
	}

	const words: SearchWord[] = [];
	const compactWordStarts = new Set<number>();
	let index = 0;
	let compactIndex = 0;
	let ordinal = 0;
	for (const word of normalized.split(" ")) {
		words.push({ text: word, index, ordinal });
		compactWordStarts.add(compactIndex);
		index += word.length + 1;
		compactIndex += word.length;
		ordinal++;
	}

	return { normalized, compact: normalized.replaceAll(" ", ""), compactWordStarts, words };
}

function scoreCharacters(queryLower: string, textLower: string): CharacterMatch {
	if (queryLower.length === 0) {
		return { matches: true, score: 0, span: 0 };
	}

	if (queryLower.length > textLower.length) {
		return { matches: false, score: 0, span: 0 };
	}

	let queryIndex = 0;
	let score = 0;
	let firstMatchIndex = -1;
	let lastMatchIndex = -1;
	let consecutiveMatches = 0;

	for (let i = 0; i < textLower.length && queryIndex < queryLower.length; i++) {
		if (textLower[i] === queryLower[queryIndex]) {
			if (firstMatchIndex < 0) firstMatchIndex = i;

			if (lastMatchIndex === i - 1) {
				consecutiveMatches++;
				score -= consecutiveMatches * 5;
			} else {
				consecutiveMatches = 0;
				if (lastMatchIndex >= 0) {
					score += (i - lastMatchIndex - 1) * 2;
				}
			}

			score += i * 0.1;
			lastMatchIndex = i;
			queryIndex++;
		}
	}

	if (queryIndex < queryLower.length) {
		return { matches: false, score: 0, span: 0 };
	}

	return { matches: true, score, span: lastMatchIndex - firstMatchIndex + 1 };
}

function buildAlphanumericSwapQueries(queryLower: string): string[] {
	const variants = new Set<string>();
	for (let i = 0; i < queryLower.length - 1; i++) {
		const current = queryLower[i];
		const next = queryLower[i + 1];
		const isAlphaNumSwap =
			(current && /[a-z]/.test(current) && next && /\d/.test(next)) ||
			(current && /\d/.test(current) && next && /[a-z]/.test(next));
		if (!isAlphaNumSwap) continue;
		const swapped = queryLower.slice(0, i) + next + current + queryLower.slice(i + 2);
		variants.add(swapped);
	}
	return [...variants];
}

function withPosition(score: number, index: number): number {
	return score + index * 0.01;
}

function isWordBoundaryPhrase(normalized: string, index: number, length: number): boolean {
	const before = index === 0 || normalized[index - 1] === " ";
	const afterIndex = index + length;
	const after = afterIndex === normalized.length || normalized[afterIndex] === " ";
	return before && after;
}

/**
 * Offset of the first whole-word occurrence of `phrase` in `normalized`, or -1.
 *
 * A bare `indexOf` reports only the leading occurrence, so a qualifying match is
 * dropped whenever an earlier non-qualifying one shadows it — the whole word
 * "image" in "reimage image provider" loses to the "image" inside "reimage".
 * Occurrences are scanned left to right, so the first qualifying hit is also the
 * best-scoring one: the caller's position tiebreak grows with the offset.
 *
 * Only a hit buried inside a word can shadow. A leading hit that already starts
 * a word is an ordinary prefix match — the query is "image" and the text says
 * "images" — and it is scored exactly as before rather than borrowing a
 * whole-word bonus from some later occurrence; `findCompactWordStart` treats its
 * leading word-start hit the same way. The rescan is additionally limited to
 * {@link MIN_SHADOW_RESCAN_LENGTH} and longer needles.
 */
function findWordBoundaryPhrase(normalized: string, phrase: string): number {
	if (phrase.length === 0) return -1;
	const first = normalized.indexOf(phrase);
	if (first < 0) return -1;
	if (isWordBoundaryPhrase(normalized, first, phrase.length)) return first;
	if (first === 0 || normalized[first - 1] === " ") return -1;
	if (phrase.length < MIN_SHADOW_RESCAN_LENGTH) return -1;
	for (let at = normalized.indexOf(phrase, first + 1); at >= 0; at = normalized.indexOf(phrase, at + 1)) {
		if (isWordBoundaryPhrase(normalized, at, phrase.length)) return at;
	}
	return -1;
}

/**
 * Offset of the first occurrence of `needle` that starts a word in `index.compact`,
 * or -1. Same shadowing hazard, and the same length floor, as
 * {@link findWordBoundaryPhrase}.
 */
function findCompactWordStart(index: SearchIndex, needle: string): number {
	if (needle.length === 0) return -1;
	const { compact, compactWordStarts } = index;
	const first = compact.indexOf(needle);
	if (first < 0) return -1;
	if (compactWordStarts.has(first)) return first;
	if (needle.length < MIN_SHADOW_RESCAN_LENGTH) return -1;
	for (let at = compact.indexOf(needle, first + 1); at >= 0; at = compact.indexOf(needle, at + 1)) {
		if (compactWordStarts.has(at)) return at;
	}
	return -1;
}

function scoreTokenAgainstWord(token: string, word: SearchWord): FuzzyMatch | null {
	if (word.text === token) {
		return { matches: true, score: withPosition(-200, word.index) };
	}

	if (word.text.startsWith(token)) {
		return { matches: true, score: withPosition(-170 + (word.text.length - token.length) * 0.5, word.index) };
	}

	if (token.startsWith(word.text) && token.length - word.text.length <= 2) {
		return { matches: true, score: withPosition(-150 + token.length - word.text.length, word.index) };
	}

	const substringIndex = word.text.indexOf(token);
	if (substringIndex >= 0) {
		return { matches: true, score: withPosition(-20 + substringIndex, word.index) };
	}

	const characterMatch = scoreCharacters(token, word.text);
	if (!characterMatch.matches) return null;

	const maxSpan = Math.max(token.length + 2, Math.ceil(token.length * 1.8));
	if (characterMatch.span > maxSpan) return null;

	return { matches: true, score: withPosition(-40 + characterMatch.score, word.index) };
}

function scoreAcronym(token: string, index: SearchIndex): FuzzyMatch | null {
	if (token.length < 2 || token.length > 4 || index.words.length === 0) return null;

	let queryIndex = 0;
	let firstOrdinal = -1;
	let lastOrdinal = -1;
	let firstTextIndex = 0;

	for (const word of index.words) {
		if (word.text[0] !== token[queryIndex]) continue;
		if (firstOrdinal < 0) {
			firstOrdinal = word.ordinal;
			firstTextIndex = word.index;
		}
		lastOrdinal = word.ordinal;
		queryIndex++;
		if (queryIndex === token.length) break;
	}

	if (queryIndex < token.length || firstOrdinal < 0 || lastOrdinal < 0) return null;

	const wordSpan = lastOrdinal - firstOrdinal + 1;
	if (wordSpan > token.length + 2) return null;

	return { matches: true, score: withPosition(-30 + wordSpan * 4 - token.length * 2, firstTextIndex) };
}

function scoreTokenDirect(token: string, index: SearchIndex): FuzzyMatch {
	if (token.length === 0) return { matches: true, score: 0 };

	let best: FuzzyMatch | null = null;
	const compactIndex = findCompactWordStart(index, token);
	if (compactIndex >= 0) {
		best = { matches: true, score: withPosition(-140, compactIndex) };
	}

	for (const word of index.words) {
		const match = scoreTokenAgainstWord(token, word);
		if (match && (!best || match.score < best.score)) {
			best = match;
		}
	}

	const acronym = scoreAcronym(token, index);
	if (acronym && (!best || acronym.score < best.score)) {
		best = acronym;
	}

	return best ?? { matches: false, score: 0 };
}

function scoreToken(token: string, index: SearchIndex): FuzzyMatch {
	let best = scoreTokenDirect(token, index);
	if (best.matches) return best;

	for (const variant of buildAlphanumericSwapQueries(token)) {
		const match = scoreTokenDirect(variant, index);
		if (!match.matches) continue;
		const score = match.score + ALPHANUMERIC_SWAP_PENALTY;
		if (!best.matches || score < best.score) {
			best = { matches: true, score };
		}
	}

	return best;
}

/** A query normalized and split once, so `fuzzyRank` doesn't re-normalize the
 * same query for every candidate in the list. */
interface PreparedQuery {
	normalized: string;
	tokens: string[];
	compact: string;
}

function prepareQuery(query: string): PreparedQuery | null {
	const normalized = normalizeForSearch(query);
	if (normalized.length === 0) return null;
	return { normalized, tokens: normalized.split(" "), compact: normalized.replaceAll(" ", "") };
}

function fuzzyMatchCore(pq: PreparedQuery | null, index: SearchIndex): FuzzyMatch {
	if (pq === null) {
		return { matches: true, score: 0 };
	}

	if (index.words.length === 0) {
		return { matches: false, score: 0 };
	}

	let totalScore = 0;
	const phraseIndex = findWordBoundaryPhrase(index.normalized, pq.normalized);
	if (phraseIndex >= 0) {
		totalScore -= PHRASE_BONUS;
		totalScore += phraseIndex * 0.01;
	}

	const compactPhraseIndex = findCompactWordStart(index, pq.compact);
	if (compactPhraseIndex >= 0) {
		totalScore -= COMPACT_PHRASE_BONUS;
		totalScore += compactPhraseIndex * 0.01;
	}

	for (const token of pq.tokens) {
		const match = scoreToken(token, index);
		if (!match.matches) {
			return { matches: false, score: 0 };
		}
		totalScore += match.score;
	}

	return { matches: true, score: totalScore };
}

export function fuzzyMatch(query: string, text: string): FuzzyMatch {
	const pq = prepareQuery(query);
	if (pq === null) return { matches: true, score: 0 };
	return fuzzyMatchCore(pq, buildSearchIndex(text));
}

/**
 * A text prepared once for repeated fuzzy matching.
 *
 * `fuzzyMatch` builds a search index per call; the module cache only admits
 * texts up to {@link MAX_CACHED_TEXT_LEN}, so long corpora (session or
 * transcript search) rebuild the index on every keystroke — the dominant cost
 * when a selector re-filters a stable candidate list as the user types. Build
 * one `FuzzyText` per candidate and call {@link match} per query instead; the
 * index lives exactly as long as the caller's reference.
 */
export class FuzzyText {
	readonly #index: SearchIndex;

	constructor(text: string) {
		this.#index = buildUncachedSearchIndex(text);
	}

	/** Match `query` (space-separated tokens; all must match) against the prepared text. */
	match(query: string): FuzzyMatch {
		return fuzzyMatchCore(prepareQuery(query), this.#index);
	}
}

/**
 * Filter and sort items by fuzzy match quality (best matches first).
 * Supports space-separated tokens: all tokens must match.
 */
export function fuzzyRank<T>(items: T[], query: string, getText: (item: T) => string): FuzzyFilterResult<T>[] {
	if (!query.trim()) {
		return items.map(item => ({ item, score: 0 }));
	}

	// A non-blank query that normalizes to empty (pure punctuation) matches
	// everything with score 0, but still calls getText per item — consumers rely
	// on its side effects (see fuzzy-cache.test.ts).
	const pq = prepareQuery(query);
	const results: FuzzyFilterResult<T>[] = [];
	for (const item of items) {
		const text = getText(item);
		const match = pq === null ? { matches: true, score: 0 } : fuzzyMatchCore(pq, buildSearchIndex(text));
		if (match.matches) {
			results.push({ item, score: match.score });
		}
	}

	results.sort((a, b) => a.score - b.score);
	return results;
}

export function fuzzyFilter<T>(items: T[], query: string, getText: (item: T) => string): T[] {
	return fuzzyRank(items, query, getText).map(result => result.item);
}

/**
 * Clear the fuzzy search-index cache. Intended for tests/benchmarks so a fresh
 * cold-start typing session can be measured on demand; not part of the supported
 * TUI API.
 *
 * @internal
 */
export function resetFuzzyIndexCache(): void {
	indexCache.clear();
}
