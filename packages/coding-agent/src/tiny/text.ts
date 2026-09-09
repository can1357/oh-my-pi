import { cleanTinyMessage, isPreformattedChatContext, stripChatScaffolding } from "./message-preproc";

/**
 * Greeting / acknowledgement / filler tokens. A first user message composed
 * entirely of these (or of bare numbers / punctuation / emoji) carries no
 * concrete task, so titling is deferred to a later message instead of latching
 * onto "hi". See {@link isLowSignalTitleInput}.
 */
const FILLER_TITLE_TOKENS = new Set<string>([
	// greetings
	"hi",
	"hii",
	"hiii",
	"hiya",
	"hey",
	"heya",
	"hello",
	"helo",
	"hullo",
	"yo",
	"ya",
	"sup",
	"wassup",
	"whatsup",
	"howdy",
	"greetings",
	"hola",
	"ciao",
	"aloha",
	"gm",
	"gn",
	"good",
	"morning",
	"afternoon",
	"evening",
	"night",
	"day",
	// politeness / acknowledgement
	"thanks",
	"thank",
	"thx",
	"ty",
	"tysm",
	"cheers",
	"please",
	"pls",
	"plz",
	"ok",
	"okay",
	"okey",
	"k",
	"kk",
	"yep",
	"yes",
	"yeah",
	"yup",
	"nope",
	"no",
	"nah",
	"sure",
	"cool",
	"nice",
	"great",
	"awesome",
	"perfect",
	"lol",
	"lmao",
	"haha",
	"hehe",
	// poking the agent / fillers
	"test",
	"tests",
	"testing",
	"ping",
	"pong",
	"there",
	"you",
	"u",
	"hmm",
	"hmmm",
	"um",
	"uh",
	"so",
	"well",
	"anyway",
]);

const TITLE_WORD = /[\p{L}\p{N}]+/gu;
const COMMON_TITLE_ACRONYMS = new Set<string>([
	"API",
	"CLI",
	"CPU",
	"CRUD",
	"CSS",
	"DNS",
	"ETL",
	"GPU",
	"HTML",
	"HTTP",
	"HTTPS",
	"ID",
	"JSON",
	"LLM",
	"REST",
	"SDK",
	"SSH",
	"TCP",
	"TLS",
	"TUI",
	"UI",
	"URI",
	"URL",
	"UX",
	"XML",
	"YAML",
]);

/**
 * True when a first user message is too low-signal to title (greeting, ack,
 * bare number, or empty once code/punctuation/emoji are stripped).
 *
 * Deterministic pre-filter: the default tiny title model (~350M local) cannot
 * reliably follow a "respond with none" instruction and tends to hallucinate a
 * title for trivial input, so we never ask it — the caller defers titling to
 * the next message instead.
 */
export function isLowSignalTitleInput(message: string): boolean {
	// Preformatted replan contexts are already cleaned per turn; only the
	// scaffolding tags are dropped so the turn text drives the signal check
	// (cleanTinyMessage would strip the paired <chat> envelope to nothing).
	const cleaned = isPreformattedChatContext(message) ? stripChatScaffolding(message) : cleanTinyMessage(message);
	const tokens = cleaned.toLowerCase().match(TITLE_WORD);
	if (!tokens) return true;
	return tokens.every(token => FILLER_TITLE_TOKENS.has(token) || /^\d+$/.test(token));
}

/**
 * Sentinel a capable title model may emit when a message carries no concrete
 * task. Treated as "no title yet" so the caller can defer titling. Backstop for
 * the deterministic {@link isLowSignalTitleInput} filter; kept in sync with the
 * `<title/>` instruction in `prompts/system/title-system.md`.
 */
export const NO_TITLE_SENTINEL = "none";

/**
 * Upper bounds on an accepted title. Titling is a 3-7 word task, so any output
 * past these limits is a model that ignored the task and answered the user's
 * message instead — its whole reply must not become the session title (issue
 * #7303). Rejecting (return null) lets the caller defer titling to the next
 * user turn; truncating would keep half an assistant blob, which is still an
 * assistant blob.
 */
const MAX_TITLE_CHARS = 80;
const MAX_TITLE_WORDS = 12;

export function normalizeGeneratedTitle(value: string | null | undefined, sourceText?: string): string | null {
	const firstLine = value?.trim().split(/\r?\n/, 1)[0]?.trim();
	if (!firstLine) return null;
	const unquoted = firstLine.replace(/^["']|["']$/g, "").trim();
	if (/^<title\s*\/>$/i.test(unquoted)) return null;
	const title = unquoted
		.replace(/^<title>/i, "")
		.replace(/<\/title>$/i, "")
		.replace(/^["']|["']$/g, "")
		.replace(/[.!?]$/, "")
		.trim();
	if (!title || title.toLowerCase() === NO_TITLE_SENTINEL) return null;
	// Zero word characters means pure punctuation/symbol junk (e.g. ".."), which
	// a sampling model occasionally emits instead of a title; reject so the
	// caller defers titling rather than naming the session "..".
	const words = title.match(TITLE_WORD)?.length ?? 0;
	if (words === 0 || title.length > MAX_TITLE_CHARS || words > MAX_TITLE_WORDS) return null;
	return sourceText === undefined ? title : reconcileTitleCasing(title, sourceText);
}

/**
 * Reconcile a generated title's casing against the user's own message.
 *
 * The title prompt asks for sentence case, but small title models still mangle
 * casing three ways: they sprout stray interior capitals on ordinary words
 * (`daemon` → `dAemon`), they flatten proper nouns the user cased distinctively
 * (`TinyVMM` → `tinyvmm`), and they title-case ALL-CAPS acronyms as if they
 * were sentence words (`CNPG` → `Cnpg`). The user's message is the source of
 * truth, so per title token:
 *  1. typed verbatim in the message → keep it (the user established the casing);
 *  2. else the message has the same word with *distinctive* mixed casing
 *     (`TinyVMM`, `iOS`, `IDs`) → adopt the user's casing (restoration);
 *  3. else the model produced a plain title-cased artifact (`Cnpg`) whose
 *     lowercased form is a likely ALL-CAPS acronym in a non-shouty source
 *     (`CNPG`, `API`, `ETL`) → restore the source acronym;
 *  4. else it's a camelCase artifact (lowercase word + stray interior capital,
 *     `dAemon`) the user never wrote → lowercase it;
 *  5. else leave it — preserves model-cased proper nouns like `GitHub`, `OAuth`.
 *
 * Restoration is limited to avoid three failure modes: a sentence that merely
 * *starts* with `For` can't force a mid-title `for` to `For` (distinctive
 * requires interior mixed casing); emphatic all-caps input (`ALL ERROR
 * HANDLING`, `FIX the BUG NOW`) is never re-shouted — see {@link isShoutySource};
 * and ordinary all-caps English words (`FIX`, `WORK`, `BUG`) are not treated as
 * restorable acronyms unless they carry a stronger acronym signal.
 */
function reconcileTitleCasing(title: string, sourceText: string): string {
	const verbatim = new Set<string>();
	const distinctive = new Map<string, string>();
	const acronyms = new Map<string, string>();
	const shouty = isShoutySource(sourceText);
	for (const [token] of sourceText.matchAll(TITLE_WORD)) {
		verbatim.add(token);
		if (isDistinctiveCasing(token)) {
			const lower = token.toLowerCase();
			if (!distinctive.has(lower)) distinctive.set(lower, token);
		} else if (!shouty && isAllCapsAcronym(token)) {
			const lower = token.toLowerCase();
			if (!acronyms.has(lower)) acronyms.set(lower, token);
		}
	}
	return title.replace(TITLE_WORD, token => {
		if (verbatim.has(token)) return token;
		const lower = token.toLowerCase();
		const restored = distinctive.get(lower);
		if (restored) return restored;
		if (isTitleCasedArtifact(token)) {
			const acronym = acronyms.get(lower);
			if (acronym) return acronym;
		}
		return isCamelArtifact(token) ? lower : token;
	});
}

/** Mixed-case identifier the user cased deliberately (`TinyVMM`, `iOS`, `IDs`):
 *  an interior/repeated capital plus at least one lowercase letter. Only these
 *  are restored when the model flattens them. */
function isDistinctiveCasing(token: string): boolean {
	return /\p{Ll}/u.test(token) && /\p{L}\p{Lu}/u.test(token);
}

/** Multi-letter ALL-CAPS source token with a stronger acronym signal than a
 *  plain emphasized word. Consonant-only tokens (`CNPG`, `SQL`, `JWT`) are
 *  restored, digit-bearing identifiers are restored, and common technical
 *  acronyms (`API`, `JSON`, `URL`) are allowlisted. Ordinary emphasized words
 *  (`FIX`, `WORK`, `BUG`) contain vowels and are not restored from source. */
function isAllCapsAcronym(token: string): boolean {
	if (!isAllCapsWord(token)) return false;
	const upper = token.toUpperCase();
	if (COMMON_TITLE_ACRONYMS.has(upper)) return true;
	if (/\p{N}/u.test(token)) return true;
	return !/[AEIOU]/.test(upper);
}

/** Multi-letter ALL-CAPS word in the source. Used for shout detection, not for
 *  acronym restoration — shouted English words (`FIX`, `WORK`) still count as
 *  shouty even though they are not restorable acronyms. Requires an actual
 *  uppercase letter so caseless scripts (CJK) never register as shouting and
 *  disable acronym restoration for those messages. */
function isAllCapsWord(token: string): boolean {
	const letters = token.match(/\p{L}/gu);
	if (!letters || letters.length < 2) return false;
	return /\p{Lu}/u.test(token) && !/\p{Ll}/u.test(token);
}

/** Plain title-cased word (`Cnpg`, `Etl`): starts uppercase, has one-or-more
 *  lowercase letters, no interior uppercase. This is the artifact a title model
 *  produces when it sentence-cases an unfamiliar ALL-CAPS acronym; PascalCase
 *  proper nouns like `GitHub`/`OAuth` have an interior capital and are
 *  excluded so we don't misidentify them. */
function isTitleCasedArtifact(token: string): boolean {
	if (!/^\p{Lu}/u.test(token)) return false;
	if (!/\p{Ll}/u.test(token)) return false;
	return !/\p{Lu}/u.test(token.slice(1));
}

/** True when the source text is shouting — ≥2 consecutive multi-letter
 *  ALL-CAPS tokens (`FIX the BUG NOW` has `BUG NOW`; `ALL ERROR HANDLING`
 *  has all three adjacent). Acronym restoration is disabled for shouty input
 *  so we don't re-shout emphatic prose the model correctly de-shouted. */
function isShoutySource(sourceText: string): boolean {
	let run = 0;
	for (const [token] of sourceText.matchAll(TITLE_WORD)) {
		if (isAllCapsWord(token)) {
			run += 1;
			if (run >= 2) return true;
		} else {
			run = 0;
		}
	}
	return false;
}

/** A lowercase word carrying a stray interior capital (`dAemon`, `cReate`): the
 *  model-mangled shape we flatten when the user never wrote it. PascalCase proper
 *  nouns (`GitHub`, `OAuth`) start uppercase and are left untouched. */
function isCamelArtifact(token: string): boolean {
	return /^\p{Ll}/u.test(token) && /\p{Lu}/u.test(token);
}
