const RECALL_TOKEN_RE = /[a-z0-9][a-z0-9_.:/+-]*/g;
/** Token extractor preserving internal periods, hashes, pluses, and hyphens without sentence-final periods. */
export const RECALL_RAW_TOKEN_RE = /[\p{L}\p{N}_][\p{L}\p{N}_.#+\u3099\u309A-]*/gu;
export const CJK_CHAR_RE =
	/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\u30FC\u3005\uFF66-\uFF9F\u3099\u309A]/u;
const CJK_RE = CJK_CHAR_RE;
/** Regular expression matching contiguous runs of 2+ CJK characters, prolong marks, iteration marks, combining marks, or halfwidth Katakana. */
export const CJK_RUN_RE =
	/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\u30FC\u3005\uFF66-\uFF9F\u3099\u309A]{2,}/gu;
const NON_CJK_TOKEN_RUN_RE =
	/(?:(?![\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\u30FC\u3005\uFF66-\uFF9F])[\p{L}\p{N}])(?:(?![\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\u30FC\u3005\uFF66-\uFF9F])[\p{L}\p{N}_-])*/gu;
/** Regular expression for splitting CJK phrases on possessive, modal, and Japanese/Korean grammatical particles while preserving conjunction-bearing entity names (e.g. `大和銀行`). */
export const CJK_CLAUSE_PARTICLE_RE =
	/(?:是什麼意思|是什么意思|是什麼|是什么|是誰|是谁|在哪裡|在哪里|在哪兒|在哪儿|怎麼樣|怎么样|為什麼|为什么|為何|为何|多少|如何|是否|について|に関して|を確認|を調べ|에서|으로|에게|부터|까지|[的之了嗎呢吧啊呀嘛在從向由給對把被將のをがはにでともへや의])/u;
export const CJK_PARTICLE_SPLIT_RE =
	/(?:是什麼意思|是什么意思|是什麼|是什么|是誰|是谁|在哪裡|在哪里|在哪兒|在哪儿|怎麼樣|怎么样|為什麼|为什么|為何|为何|多少|如何|是否|について|に関して|を確認|を調べ|에서|으로|에게|부터|까지|[的之了嗎呢吧啊呀嘛和與及或對將把被從向由給為於在並而但卻又也還只就才已曾讓跟のをがはにでともへや은는이가을를의에로과와도만])/u;
const CJK_TRAILING_PARTICLE_RE =
	/(?:について|に関して|を確認|を調べ|에서|으로|에게|부터|까지|[のをがはにでともへや은는이가을를의에로과와도만])+$/u;
export const CJK_TEMPORAL_QUERY_RE =
	/(?:昨天|昨日|今天|今日|明天|明日|前天|大前天|後天|大後天|后天|大后天|前日|後日|最近(?![鄰邻公共點点對对小大優优佳近親亲似距離距离最少])|近期|最新|這週|本週|上週|上周|下週|下周|本周|这周|這個月|上個月|上个月|下個月|下个月|这个月|去年|今年|明年|之前|先前|以前|何時|什麼時候|何时|什么时候|剛剛|剛才|刚刚|刚才|(?:過去|过去|現在|现在)(?![式時时態态完成分詞词進行进行])|目前|截止(?![頻频點点電壓压波長长區区率])(?:日|日期|時間|时间|時限|时限|前|到|至|於|于|$)|いつ|何時|昨日|今日|明日|一昨日|明後日|先週|今週|来週|先月|今月|来月|去年|今年|来年|タイムライン|時系列|時期|日時|언제|어제|오늘|내일|그제|모레|지난주|이번주|다음주|지난달|이번달|다음달|작년|올해|내년|타임라인|연표|시기|일시)/u;
const HOMOGENEOUS_CJK_SUBRUN_RE =
	/[\p{Script=Katakana}\u30FC\uFF66-\uFF9F]{2,}|[\p{Script=Han}\u3005]{2,}|[\p{Script=Hangul}]{2,}/gu;
/** High-frequency CJK stop segments and question pronouns excluded from indexing and candidate shingles. */
export const CJK_STOP_SEGMENTS: ReadonlySet<string> = new Set([
	"什麼",
	"什么",
	"如何",
	"怎麼",
	"怎么",
	"哪些",
	"哪個",
	"哪个",
	"為什麼",
	"为什么",
	"是否",
	"可以",
	"一個",
	"一个",
	"這個",
	"这个",
	"那個",
	"那个",
	"我們",
	"我们",
	"你們",
	"你们",
	"他們",
	"他们",
	"檢查",
	"检查",
	"查看",
	"查詢",
	"查询",
	"請問",
	"请问",
]);
const CJK_QUESTION_PREFIXES = [
	"請問",
	"请问",
	"關於",
	"关于",
	"檢查",
	"检查",
	"查看",
	"查詢",
	"查询",
	"什麼是",
	"什么是",
	"是什麼",
	"是什么",
] as const;

export const FACT_MATCH_STOPWORDS = new Set([
	"a",
	"an",
	"and",
	"are",
	"as",
	"at",
	"be",
	"by",
	"can",
	"could",
	"did",
	"do",
	"does",
	"for",
	"from",
	"had",
	"has",
	"have",
	"how",
	"i",
	"in",
	"is",
	"it",
	"its",
	"me",
	"my",
	"of",
	"on",
	"or",
	"our",
	"related",
	"should",
	"that",
	"the",
	"their",
	"there",
	"this",
	"to",
	"totally",
	"unrelated",
	"use",
	"uses",
	"was",
	"we",
	"what",
	"when",
	"where",
	"which",
	"who",
	"why",
	"with",
	"you",
	"your",
]);

export const RECALL_SYNONYMS: Readonly<Record<string, readonly string[]>> = {
	branding: ["brand", "positioning", "identity", "wording"],
	preference: ["prefer", "prefers", "want", "wants", "reject", "rejects", "avoid", "grounded"],
	professional: ["software", "builder"],
	url: ["link", "profile"],
	current: ["now", "live", "latest"],
	feeling: ["feel", "feels"],
	imposter: ["self-doubt", "doubt", "insecure"],
};

export function isCjkChar(ch: string): boolean {
	return CJK_RE.test(ch);
}

export function hasCjk(text: string): boolean {
	return CJK_RE.test(text);
}

export const containsSpacelessCjk = hasCjk;

/** Endings that turn one form of a word into another: `backup`/`backups`, `deploy`/`deployment`. */
const WORD_FORM_ENDINGS: readonly string[] = ["s", "es", "d", "ed", "ing", "er", "ers", "ment", "ments"];
/** Endings that replace a final `e`: `cache`/`caching`, `create`/`creation`. */
const SILENT_E_ENDINGS: readonly string[] = ["ing", "ion", "ions"];
/** Endings that replace a final `y`: `story`/`stories`, `copy`/`copied`. */
const FINAL_Y_ENDINGS: readonly string[] = ["ies", "ied"];

/**
 * Weak match between two forms of one word, in either direction: the longer token is the shorter
 * one plus an inflectional or common derivational ending (`facts`/`fact`, `deploy`/`deployment`,
 * `caching`/`cache`, `stories`/`story`). The shorter token needs at least four characters. Any
 * other extension or fragment never matches, so `1password`, `password` and `passport` do not
 * find `pass`, and `redis` does not find `redistribution`. This is deliberately not a stemmer.
 */
export function matchesWordForm(left: string, right: string): boolean {
	const [shorter, longer] = left.length <= right.length ? [left, right] : [right, left];
	if (shorter.length < 4 || longer.length === shorter.length) return false;
	if (longer.startsWith(shorter) && WORD_FORM_ENDINGS.includes(longer.slice(shorter.length))) return true;
	const stem = shorter.slice(0, -1);
	if (!longer.startsWith(stem)) return false;
	const ending = longer.slice(stem.length);
	if (shorter.endsWith("e")) return SILENT_E_ENDINGS.includes(ending);
	if (shorter.endsWith("y")) return FINAL_Y_ENDINGS.includes(ending);
	return false;
}

export function recallTokens(text: string): string[] {
	RECALL_TOKEN_RE.lastIndex = 0;
	const tokens: string[] = [];
	const lower = text.toLowerCase();
	let match = RECALL_TOKEN_RE.exec(lower);
	while (match !== null) {
		const token = match[0];
		if (token.length >= 3 && !FACT_MATCH_STOPWORDS.has(token) && !isAsciiDigits(token)) tokens.push(token);
		match = RECALL_TOKEN_RE.exec(lower);
	}
	return tokens;
}

export function expandedQueryTokens(tokens: readonly string[]): string[] {
	const expanded: string[] = [];
	const seen = new Set<string>();
	for (const token of tokens) {
		if (!seen.has(token)) {
			seen.add(token);
			expanded.push(token);
		}
		const synonyms = RECALL_SYNONYMS[token];
		if (synonyms === undefined) continue;
		for (const synonym of synonyms) {
			if (seen.has(synonym)) continue;
			seen.add(synonym);
			expanded.push(synonym);
		}
	}
	return expanded;
}

export function minimumRecallRelevance(queryTokens: readonly string[]): number {
	if (queryTokens.length >= 4) return 0.3;
	if (queryTokens.length === 3) return 0.5;
	return 0.15;
}

export function cjkFtsTerms(text: string): string[] {
	const chars: string[] = [];
	for (const ch of text) {
		if (isCjkChar(ch)) chars.push(ch);
	}
	if (chars.length === 0) return [];
	const terms: string[] = [];
	const seen = new Set<string>();
	for (const ch of chars) {
		if (seen.has(ch)) continue;
		seen.add(ch);
		terms.push(ch);
	}
	for (let i = 1; i < chars.length; i++) {
		const previous = chars[i - 1];
		const current = chars[i];
		if (previous === undefined || current === undefined) continue;
		const bigram = `${previous}${current}`;
		if (seen.has(bigram)) continue;
		seen.add(bigram);
		terms.push(`"${bigram}"`);
	}
	return terms;
}

export function ftsQueryTerms(query: string): string[] {
	const terms: string[] = [];
	for (const term of expandedQueryTokens(recallTokens(query))) {
		const escaped = term.replaceAll('"', '""').trim();
		if (escaped) terms.push(`"${escaped}"`);
	}
	return terms;
}

function isAsciiDigits(value: string): boolean {
	for (let i = 0; i < value.length; i++) {
		const code = value.charCodeAt(i);
		if (code < 48 || code > 57) return false;
	}
	return value.length > 0;
}

/** Count Unicode code points in `value` so supplementary-plane Han characters count as 1. */
export function codePointLength(value: string): number {
	let count = 0;
	for (const _ of value) count++;
	return count;
}

/** Strip leading CJK question/command prefixes when at least 2 code points remain. */
export function stripCjkQuestionAffixes(segment: string): string {
	let current = segment;
	for (const prefix of CJK_QUESTION_PREFIXES) {
		if (current.startsWith(prefix)) {
			const rest = current.slice(prefix.length);
			if (codePointLength(rest) >= 2) {
				current = rest;
				break;
			}
		}
	}
	const strippedSuffix = current.replace(CJK_TRAILING_PARTICLE_RE, "");
	if (strippedSuffix !== current && codePointLength(strippedSuffix) >= 2) {
		current = strippedSuffix;
	}
	return current;
}

/**
 * Return case variants for tokens so comparisons against SQLite's ASCII-only `lower()`
 * match lowercase, original-case, title-case, and uppercase non-ASCII words (e.g. `москва` and `Москва`).
 */
export function unicodeCaseVariants(token: string): string[] {
	const lower = token.toLowerCase();
	if (/^[\x00-\x7f]*$/.test(token)) return [lower];
	const asciiLower = token.replace(/[A-Z]/g, ch => ch.toLowerCase());
	const out = new Set<string>([lower, asciiLower, token, token.toUpperCase()]);
	if (lower.length > 0) {
		const first = Array.from(lower)[0] ?? "";
		const rest = lower.slice(first.length);
		const title = first.toUpperCase() + rest;
		out.add(title);
		out.add(title.replace(/[A-Z]/g, ch => ch.toLowerCase()));
	}
	return [...out];
}

/**
 * Generate code-point-aligned character windows for `segment` across `sizes` (e.g. `[2, 3, 4]`),
 * skipping stop segments and never splitting supplementary-plane surrogate pairs.
 */
export function cjkCodePointShingles(segment: string, sizes: readonly number[] = [2, 3, 4]): string[] {
	const cps = Array.from(segment);
	const out: string[] = [];
	for (const size of sizes) {
		if (size <= 0 || cps.length < size) continue;
		for (let i = 0; i <= cps.length - size; i++) {
			const shingle = cps.slice(i, i + size).join("");
			if (!CJK_STOP_SEGMENTS.has(shingle)) out.push(shingle);
		}
	}
	return out;
}

/**
 * Split a mixed-script token (e.g. `PostgreSQL資料庫` or `TypeScript支援CJK`) into
 * its contiguous non-CJK alphanumeric runs and contiguous CJK runs.
 */
export function splitMixedScriptToken(token: string): { nonCjk: string[]; cjkRuns: string[] } {
	const nonCjkSet = new Set<string>();
	for (const match of token.matchAll(NON_CJK_TOKEN_RUN_RE)) {
		const rawRun = match[0] ?? "";
		if (rawRun.length > 0) {
			for (const variant of unicodeCaseVariants(rawRun)) nonCjkSet.add(variant);
		}
	}
	const cjkRuns: string[] = [];
	for (const match of token.matchAll(CJK_RUN_RE)) {
		const run = match[0] ?? "";
		if (run.length > 0) cjkRuns.push(run);
	}
	return { nonCjk: [...nonCjkSet], cjkRuns };
}

function addCandidateWithNfkc(value: string, seen: Set<string>, maxLen = 6): void {
	for (const form of [value, value.normalize("NFKC")]) {
		const len = codePointLength(form);
		if (len >= 2 && len <= maxLen && !CJK_STOP_SEGMENTS.has(form)) {
			seen.add(form);
		}
	}
}

/**
 * Expand a CJK-bearing token into candidate entity/subject segments and 2/3/4-code-point
 * shingles, preserving intact run shingles, particle-split sub-clauses, script-homogeneous subruns,
 * and NFKC normalizations for halfwidth Katakana.
 */
export function expandCjkCandidateSegments(token: string, seen: Set<string>, primaryOut?: Set<string>): void {
	const normalizedToken = token.normalize("NFC");
	for (const match of normalizedToken.matchAll(CJK_RUN_RE)) {
		const rawRun = match[0] ?? "";
		for (const run of new Set([rawRun, rawRun.normalize("NFKC")])) {
			const runLen = codePointLength(run);
			if (runLen < 2) continue;
			addCandidateWithNfkc(run, seen, Infinity);
			if (primaryOut) addCandidateWithNfkc(run, primaryOut, Infinity);
			const strippedRun = stripCjkQuestionAffixes(run);
			if (strippedRun !== run) {
				addCandidateWithNfkc(strippedRun, seen, Infinity);
				if (primaryOut) addCandidateWithNfkc(strippedRun, primaryOut, Infinity);
			}
			for (const shingle of cjkCodePointShingles(run, [2, 3, 4])) seen.add(shingle);

			for (const subMatch of run.matchAll(HOMOGENEOUS_CJK_SUBRUN_RE)) {
				const subRun = subMatch[0] ?? "";
				addCandidateWithNfkc(subRun, seen, Infinity);
				if (primaryOut) addCandidateWithNfkc(subRun, primaryOut, Infinity);
			}

			for (const clauseRaw of strippedRun.split(CJK_CLAUSE_PARTICLE_RE)) {
				const clause = stripCjkQuestionAffixes(clauseRaw);
				if (codePointLength(clause) >= 2 && !CJK_STOP_SEGMENTS.has(clause)) {
					addCandidateWithNfkc(clause, seen, Infinity);
					if (primaryOut) addCandidateWithNfkc(clause, primaryOut, Infinity);
				}
			}

			for (const rawSeg of run.split(CJK_PARTICLE_SPLIT_RE)) {
				for (const seg of [rawSeg, stripCjkQuestionAffixes(rawSeg)]) {
					const segLen = codePointLength(seg);
					if (segLen < 2 || CJK_STOP_SEGMENTS.has(seg)) continue;
					addCandidateWithNfkc(seg, seen, Infinity);
					if (primaryOut) addCandidateWithNfkc(seg, primaryOut, Infinity);
					for (const subMatch of seg.matchAll(HOMOGENEOUS_CJK_SUBRUN_RE)) {
						const subRun = subMatch[0] ?? "";
						addCandidateWithNfkc(subRun, seen, Infinity);
						if (primaryOut) addCandidateWithNfkc(subRun, primaryOut, Infinity);
					}
					if (segLen >= 3) {
						for (const shingle of cjkCodePointShingles(seg, [2, 3, 4])) seen.add(shingle);
					}
				}
			}
		}
	}
}
