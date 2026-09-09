/**
 * Behavioral metrics extracted from a single user message.
 *
 * Pure, side-effect free. Designed for batch use during session ingestion
 * and standalone testing.
 */

export interface UserMessageMetrics {
	/** Total characters of analyzed text. */
	chars: number;
	/** Whitespace-delimited word count. */
	words: number;
	/**
	 * Number of "yelling" sentences: sentences where more than half of the
	 * alphabetic characters are uppercase (and there are enough letters to
	 * make the ratio meaningful - short acronyms like "OK" don't count).
	 * A sentence also needs either two uppercase runs ("WHAT THE HELL") or
	 * one elongated run ("CMOOON") so a lone acronym/env var ("use JSON",
	 * "HOME=/tmp") doesn't register.
	 */
	yelling: number;
	/** Profanity hits (word-boundary, case-insensitive). */
	profanity: number;
	/**
	 * Catch-all "obviously upset" signal computed on a *prose-only* body
	 * (code fences, XML/HTML tags, URLs, file mentions, and quoted lines
	 * are stripped first; messages whose remaining prose is >=3 lines score
	 * zero because formatted prompts aren't tantrums).
	 *
	 * Sum of:
	 * - drama runs: 3+ `!` / `?` (with `1`-mishit fallout)
	 * - interjections, elongated where the short form is ambiguous:
	 *   `noooo`, `ahhh`, `ugh(h)`, `argh`, `grr`, `stooop`, `whyyy`,
	 *   `fuuu(ck)`, `wtfff`, `omggg`, `yesss`, `goddd`, `bruhh`
	 * - standalone `dude`
	 * - sad emoticons: `:(`, `;(`, `:-(((`
	 */
	anguish: number;
	/**
	 * Corrective negation: the user is telling us we got it wrong.
	 *
	 * Counted on the same prose-only body as {@link anguish}.
	 *
	 * - line-leading `nope` / `nah` / `nvm` / `wrong` / `incorrect`
	 *   (word-bounded, so `now`, `nobody`, `north` don't match)
	 * - line-leading `no` when used as an interjection - followed by
	 *   punctuation, end-of-text, or a discourse word (`no i meant`,
	 *   `no, wait`). Determiner `no` (`no extensions to the page`,
	 *   `no auto start`) doesn't count.
	 * - `that(?:'s)? not (what|right|it)` and `not what i (meant|asked|said|wanted)`
	 * - `makes (no|zero) sense`
	 */
	negation: number;
	/**
	 * The user is repeating themselves - strong signal the previous turn
	 * missed the ask. Counts hits for:
	 *
	 * - `i (meant|said|asked|told you|already (said|told|did|asked|wrote))`
	 * - `(like|as) i (said|told you|asked)`
	 * - `still (doesn't|isn't|not|broken|wrong|fails|failing|the same|same)`
	 *
	 * Bare `still` / `again` are too ambiguous to count alone (they show up
	 * in normal speech like "try again" or "still works").
	 */
	repetition: number;
	/**
	 * Direct second-person reproach pinned on the agent:
	 *
	 * - `you (didn't|did not|broke|missed|forgot|keep|always|never|still|ignored)`
	 * - `why (would|did) (you|u)`
	 * - sentence-leading `stop <verb>ing` imperatives
	 */
	blame: number;
}

/**
 * Words considered profane/aggressive. Word-boundary, case-insensitive.
 *
 * Broad English coverage: f-/s-word families and their censored variants,
 * mild swears, intelligence-based insults, body-part insults, British/
 * Australian/Irish slang, religious exclamations, and chat acronyms.
 * Curated to exclude racial, homophobic, and other identity slurs, and
 * words whose dominant use in a coding corpus is technical rather than
 * profane (`dummy` data, `blast` radius, config `knob`, `trash` bin,
 * CRUD, `garbage` files) or plain opinion (`useless`, `awful`, `meh`,
 * `hate`). Pure frustration interjections (`ugh`, `argh`, `grr`) are
 * scored as anguish instead.
 */
const PROFANITY: readonly string[] = [
	// f-word family
	"fuck",
	"fucks",
	"fucked",
	"fucking",
	"fuckin",
	"fucker",
	"fuckers",
	"fuckup",
	"fuckups",
	"fuckhead",
	"fuckheads",
	"fuckface",
	"fuckwit",
	"fuckwits",
	"fucktard",
	"fuckery",
	"fuckoff",
	"motherfucker",
	"motherfuckers",
	"motherfucking",
	"clusterfuck",
	"ratfuck",
	"unfuck",
	// censored / euphemistic f-word
	"fk",
	"fks",
	"fking",
	"fkin",
	"fker",
	"fck",
	"fcks",
	"fcking",
	"fckin",
	"fcker",
	"fuk",
	"fuking",
	"fukin",
	"eff",
	"effs",
	"effed",
	"effing",
	"frick",
	"fricks",
	"fricked",
	"fricking",
	"frickin",
	"freaking",
	"freakin",
	"freaked",
	// s-word family
	"shit",
	"shits",
	"shat",
	"shitty",
	"shittier",
	"shittiest",
	"shite",
	"shites",
	"shited",
	"shitting",
	"shitter",
	"shitters",
	"shithead",
	"shitheads",
	"shitshow",
	"shitstorm",
	"shitstain",
	"shitfaced",
	"shitload",
	"shitbag",
	"shitcan",
	"shitcanned",
	"shitpost",
	"shitposting",
	"bullshit",
	"bullshits",
	"bullshitting",
	"bullshitter",
	"horseshit",
	"batshit",
	"dogshit",
	"dipshit",
	"jackshit",
	"dumbshit",
	"holyshit",
	// mild swears
	"damn",
	"damns",
	"damned",
	"damning",
	"dammit",
	"goddamn",
	"goddamned",
	"goddamnit",
	"goddammit",
	"darn",
	"darns",
	"darned",
	"darnit",
	"dang",
	"danged",
	"dangit",
	"hell",
	"hells",
	"heck",
	"hecks",
	"heckin",
	"gosh",
	"bloody",
	"bollocks",
	"bollox",
	// crap family
	"crap",
	"craps",
	"crappy",
	"crappier",
	"crappiest",
	"crapped",
	"crapping",
	"crapload",
	"crapola",
	// piss family
	"piss",
	"pisses",
	"pissed",
	"pissing",
	"pisser",
	"pisspoor",
	"pisstake",
	"pisshead",
	// ass family
	"ass",
	"asses",
	"asshole",
	"assholes",
	"asshat",
	"asshats",
	"asswipe",
	"asswipes",
	"assclown",
	"assbag",
	"asskisser",
	"dumbass",
	"dumbasses",
	"jackass",
	"jackasses",
	"smartass",
	"smartasses",
	"badass",
	"badasses",
	"lazyass",
	"fatass",
	"hardass",
	"halfass",
	"halfassed",
	"arse",
	"arsed",
	"arsehole",
	"arseholes",
	"arsewipe",
	// bitch family
	"bitch",
	"bitches",
	"bitched",
	"bitching",
	"bitchy",
	"bitchier",
	"bitchiest",
	"sonofabitch",
	"biatch",
	"biotch",
	// strong vulgarity
	"cunt",
	"cunts",
	"cunty",
	"cuntish",
	"twat",
	"twats",
	"twatty",
	"bastard",
	"bastards",
	// body-part insults
	"dick",
	"dicks",
	"dickhead",
	"dickheads",
	"dickish",
	"dickwad",
	"dickwads",
	"dickface",
	"dickbag",
	"prick",
	"pricks",
	"prickish",
	"cock",
	"cocks",
	"cocky",
	"cockier",
	"cockiest",
	"cockhead",
	"cockblock",
	"cocksucker",
	"cocksuckers",
	"knobhead",
	"knobheads",
	"knobend",
	"wanker",
	"wankers",
	"wankery",
	"tosser",
	"tossers",
	"jerkoff",
	"jerkoffs",
	"douche",
	"douches",
	"douchebag",
	"douchebags",
	"douchey",
	"scumbag",
	"scumbags",
	"scum",
	"sleazebag",
	"sleazeball",
	"slimeball",
	"lowlife",
	"lowlifes",
	"deadbeat",
	// intelligence-based insults
	"idiot",
	"idiots",
	"idiotic",
	"idiocy",
	"stupid",
	"stupider",
	"stupidest",
	"stupidity",
	"moron",
	"morons",
	"moronic",
	"imbecile",
	"imbeciles",
	"retard",
	"retards",
	"retarded",
	"dumb",
	"dumber",
	"dumbest",
	"dumbo",
	"fool",
	"fools",
	"foolish",
	"foolery",
	"clown",
	"clowns",
	"clownish",
	"buffoon",
	"buffoons",
	"simpleton",
	"halfwit",
	"halfwits",
	"nitwit",
	"nitwits",
	"dimwit",
	"dimwits",
	"dolt",
	"dolts",
	"doltish",
	"knucklehead",
	"knuckleheads",
	"blockhead",
	"blockheads",
	"lamebrain",
	"airhead",
	"airheads",
	"scatterbrain",
	"numbnuts",
	"numbskull",
	"numpty",
	"numpties",
	"muppet",
	"muppets",
	"pillock",
	"pillocks",
	"plonker",
	"plonkers",
	"prat",
	"prats",
	"berk",
	"berks",
	"ninny",
	"ninnies",
	"dingbat",
	"dingbats",
	"putz",
	"putzes",
	"schmuck",
	"schmucks",
	"jerk",
	"jerks",
	"jerkface",
	"gits",
	"sod",
	"sodding",
	"bugger",
	"buggered",
	// generic aggression / dismissal
	"suck",
	"sucks",
	"sucked",
	"sucking",
	"sucky",
	"suckage",
	"trashy",
	// religious exclamations
	"jesus",
	"christ",
	"jeez",
	"jeezus",
	"sheesh",
	"godsake",
	// chat acronyms
	"wtf",
	"wth",
	"wtaf",
	"stfu",
	"gtfo",
	"omfg",
	"omg",
	"ffs",
	"jfc",
	"kys",
	"fml",
	"smh",
	"smdh",
	"smfh",
	"idgaf",
	"idfc",
	"lmfao",
	"fubar",
	"snafu",
];

const PROFANITY_RE = new RegExp(String.raw`\b(?:${PROFANITY.join("|")})\b`, "gi");
const SENTENCE_RE = /[^.!?\n]+/g;
const LETTER_RE = /\p{L}/gu;
const UPPER_LETTER_RE = /\p{Lu}/gu;
const YELLING_MIN_LETTERS = 4;
const YELLING_THRESHOLD = 0.5;
// Runs starting with `!` or `?` followed by 2+ of `!?1`. The `1` is the
// classic shift-key mishit ("!!!111" / "!?!??111") so we count those as
// part of the same drama burst.
const DRAMA_RE = /[!?][!?1]{2,}/g;
const WORD_RE = /\S+/g;

// Anguish/exasperation interjections. Each alternative is a case-insensitive
// word-bounded pattern. Interjections whose short form collides with normal
// prose ("no", "ahh", "why", "yes", "god") require *real* elongation;
// unambiguous ones ("ugh", "argh", "grr") match their plain form too.
// Picked to avoid hex / base64 contamination via the surrounding `\b` plus
// letter-only alternatives.
const ANGUISH_PATTERNS: readonly string[] = [
	"no{3,}", //          nooo, noooooo
	"a+h{2,}", //         ahh, aaaahhh
	"u+r?g+h+", //        ugh, ughh, urgh, uuugh
	"a+r+g+h+", //        argh, aaargh, arrgghhh
	"g+r{2,}", //         grr, grrrr
	"st+o{3,}p+", //      stooop, sttooopp
	"w+h+y{3,}", //       whyyy, whyyyyy
	"f+u{3,}c*k*", //     fuuu, fuuuck
	"wtf{3,}", //         wtfff
	"o+m+g{2,}", //       omgg, omggg
	"ye+s{3,}", //        yesss, yeessss
	"g+o+d{3,}", //       goddd, goddddd
	"br+u+h{2,}", //      bruhh, bruuuhh
];
const ANGUISH_RE = new RegExp(String.raw`\b(?:${ANGUISH_PATTERNS.join("|")})\b`, "gi");
const DUDE_RE = /\bdude\b/gi;
// Sad emoticons (`:(` and friends). Requires a leading boundary so pasted
// code/regex fragments like `foo:(bar)` don't fire; `\(+` folds `:(((` into
// one hit. 46 corpus hits, ~90% genuinely deflated.
const SAD_EMOTICON_RE = /(?<=^|[\s.!?])[:;]-?\(+/g;
// Dot runs (`..` / `...` / `....`) are deliberately NOT counted: on a real
// corpus they are dominated by neutral trail-offs, template placeholders
// (`{{href...}}`) and range syntax, not exasperation.

// --- Frustration signals ----------------------------------------------------
// Each set of patterns below is tuned against ~42k real user prompts so the
// short-prose hits are dominated by genuine frustration, not technical talk.

// Corrective negation. We deliberately anchor to the very start of the
// trimmed prose body (no `m` flag) - in practice mid-message lines that
// start with `no`/`Wrong`/`No JSDoc warning` are list items, pasted error
// text or descriptive statements, not actual corrections. Real frustration
// negation overwhelmingly opens the message. Bare `no` only counts as an
// interjection - followed by punctuation, end-of-text, or a discourse word -
// so determiner uses ("no extensions to the page", "no auto start") don't
// score. A hyphen only counts as a separator when it doesn't glue a compound
// (`no - not that` yes, `no-op change` no). Note: the bare-`no` branch
// deliberately has no trailing `\b`, so emphatic misspellings like `nou ...`
// / `nono ...` also count (via `no` + follower `u`/`no`) - on the real
// corpus every such hit is a genuine correction.
const NEGATION_LEAD_RE =
	/^[ \t]*(?:(?:nope|nah|nvm|wrong|incorrect)\b|no(?=\s*(?:[,.!?;:\u2013\u2014]|-(?!\w)|$|(?:i|im|u|you|ur|we|it|its|that|thats|this|the|they|theyre|he|she|man|dude|bro|wait|dont|not|stop|just|again|please|plz|but|actually|literally|seriously|sorry|no|never|nothing|wtf|why|what|wrong)\b)))/gi;
const NEGATION_PHRASE_RE =
	/\b(?:that['\u2019]?s\s+not\s+(?:what|right|it)|not\s+what\s+i\s+(?:meant|asked|said|wanted)|makes\s+(?:no|zero)\s+sense)\b/gi;

// User repeating themselves. The recall pattern accepts an optional
// `like ` / `as ` prefix so "like i said" doesn't double-count with bare
// "i said". Bare `i asked` is too noisy - it's overwhelmingly "i asked
// <some third party>" in this corpus (committee, experts, weaker LLM, ...) -
// so we require `i asked you` for that variant. Bare `still` / `again` are
// ambiguous so we only count `still` when followed by a negative or
// sameness marker.
const REPETITION_RECALL_RE =
	/\b(?:(?:like|as)\s+i\s+(?:said|told\s+you|asked)|i\s+(?:meant|said|told\s+you|asked\s+you|already\s+(?:said|told|did|asked|wrote)))\b/gi;
const REPETITION_STILL_RE =
	/\bstill\s+(?:doesn['\u2019]?t|doesnt|isn['\u2019]?t|isnt|not|broken|wrong|fails|failing|the\s+same|same)\b/gi;

// Direct second-person reproach. `you` alone is too generic (>7k hits in
// short prose), so we anchor it to a small set of accusatory verbs.
const BLAME_YOU_RE = /\byou\s+(?:didn['\u2019]?t|did\s+not|broke|missed|forgot|keep|always|never|still|ignored)\b/gi;
// `why would/did you ...` is reproach even when politely phrased. Bare
// `why you` / `why are you` are dominated by neutral how-does-this-work
// questions, so only the past/conditional forms count.
const BLAME_WHY_RE = /\bwhy\s+(?:would|did)\s+(?:you|u)\b/gi;
// `stop <verb>ing` is only frustration when it's an imperative - require it
// to start a sentence (line start or after a sentence-terminating punctuator).
const BLAME_STOP_RE = /(?:^|(?<=[.!?\n]))\s*stop\s+\w+ing\b/gim;

// Stripped from the analyzed body before scoring so that structured
// content (code, XML/HTML, URLs, file mentions, quoted blocks) doesn't
// pollute behavior signals. We replace with a newline so line counts
// reflect what was removed instead of merging neighbors.
const FENCED_CODE_RE = /```[\s\S]*?```/g;
const XML_TAG_PAIR_RE = /<([A-Za-z][\w-]*)\b[^>]*>[\s\S]*?<\/\1>/g;
const XML_TAG_BARE_RE = /<\/?[A-Za-z][\w-]*\b[^>]*\/?>/g;
const INLINE_CODE_RE = /`[^`\n]*`/g;
const URL_RE = /\bhttps?:\/\/\S+/gi;
const FILE_MENTION_RE = /(^|\s)@[\w./-]+/g;
// Dotted tokens: filenames (`AGENTS.md`), dotted identifiers (`Bun.file`),
// versions (`1.2.3`). Stripped so SENTENCE_RE doesn't split them into
// all-caps fragments ("Follow AGENTS.md and ..." -> "Follow AGENTS") that
// register as yelling.
const DOTTED_TOKEN_RE = /(?<=^|[\s("'[])[\w-]+(?:\.[\w-]+)+(?=$|[\s)"'\],:;!?]|\.(?!\w))/g;
const QUOTE_LINE_RE = /^[ \t]*>.*$/gm;
// Harness placeholders the TUI substitutes for binary/non-text user input.
// Strip them so real frustration signals on later lines aren't masked off
// by `[Image #1]` etc. consuming line 1.
const IMAGE_MARKER_RE = /\[Image #\d+\]/g;
// ANSI escape sequences sometimes leak in from terminal copy-paste
// (e.g. when the user pastes a bash transcript). Strip them.
const ANSI_ESCAPE_RE = /\x1b\[[0-9;]*[A-Za-z]/g;

// Users don't really get angry with super detailed and formatted prompts
// - if the remaining prose is this many lines or more, score zero.
const MAX_PROSE_LINES = 3;

/** Count regex hits without materializing the match array. */
function countMatches(text: string, re: RegExp): number {
	let count = 0;
	re.lastIndex = 0;
	while (re.exec(text) !== null) count++;
	return count;
}

// A sentence needs 2+ uppercase runs ("WHAT THE HELL"), or a single elongated
// run with a tripled letter ("CMOOON"), before its caps ratio can count as
// yelling. A lone acronym / identifier / env var ("Follow AGENTS", "use
// JSON", "HOME=/tmp") never does.
const UPPER_RUN_RE = /\p{Lu}{2,}/gu;
const TRIPLED_LETTER_RE = /(\p{Lu})\1\1/u;

function isShoutedSentence(sentence: string): boolean {
	const runs = sentence.match(UPPER_RUN_RE);
	if (!runs) return false;
	if (runs.length >= 2) return true;
	return runs[0].length >= YELLING_MIN_LETTERS && TRIPLED_LETTER_RE.test(runs[0]);
}

/**
 * Count sentences where the share of uppercase letters exceeds
 * {@link YELLING_THRESHOLD}. Sentences shorter than
 * {@link YELLING_MIN_LETTERS} alphabetic characters are ignored so that
 * short acronyms ("OK", "WIP", "TODO") don't register as yelling, and the
 * caps must span multiple words (or one elongated shout) - see
 * {@link isShoutedSentence}.
 */
function countYellingSentences(text: string): number {
	let count = 0;
	SENTENCE_RE.lastIndex = 0;
	let match: RegExpExecArray | null = SENTENCE_RE.exec(text);
	while (match !== null) {
		const sentence = match[0];
		const letters = countMatches(sentence, LETTER_RE);
		if (letters >= YELLING_MIN_LETTERS) {
			const upper = countMatches(sentence, UPPER_LETTER_RE);
			if (upper / letters > YELLING_THRESHOLD && isShoutedSentence(sentence)) count++;
		}
		match = SENTENCE_RE.exec(text);
	}
	return count;
}

/**
 * Strip structured content so that pasted code, harness wrappers, file
 * mentions and quoted blocks don't dilute or fake behavior signals.
 * Each strip is replaced with a newline so subsequent line counting
 * reflects what was removed instead of merging neighbors.
 */
function stripStructuredContent(text: string): string {
	return text
		.replace(FENCED_CODE_RE, "\n")
		.replace(XML_TAG_PAIR_RE, "\n")
		.replace(XML_TAG_BARE_RE, " ")
		.replace(INLINE_CODE_RE, " ")
		.replace(URL_RE, " ")
		.replace(FILE_MENTION_RE, "$1 ")
		.replace(DOTTED_TOKEN_RE, " ")
		.replace(QUOTE_LINE_RE, "")
		.replace(IMAGE_MARKER_RE, " ")
		.replace(ANSI_ESCAPE_RE, "");
}

function countNonEmptyLines(text: string): number {
	let count = 0;
	for (const line of text.split("\n")) {
		if (line.trim().length > 0) count++;
	}
	return count;
}

/**
 * Compute behavioral metrics for a user message.
 *
 * `text` may be empty or whitespace; in that case every metric is 0.
 */
export function computeUserMessageMetrics(text: string): UserMessageMetrics {
	const trimmed = text.trim();
	if (!trimmed) {
		return {
			chars: 0,
			words: 0,
			yelling: 0,
			profanity: 0,
			anguish: 0,
			negation: 0,
			repetition: 0,
			blame: 0,
		};
	}

	const chars = trimmed.length;
	const words = countMatches(trimmed, WORD_RE);

	// Behavior signals are computed on a stripped prose body; long /
	// well-formatted messages score zero because they are deliberate, not
	// emotional outbursts.
	const prose = stripStructuredContent(trimmed).trim();
	if (!prose || countNonEmptyLines(prose) >= MAX_PROSE_LINES) {
		return {
			chars,
			words,
			yelling: 0,
			profanity: 0,
			anguish: 0,
			negation: 0,
			repetition: 0,
			blame: 0,
		};
	}

	const anguish =
		countMatches(prose, DRAMA_RE) +
		countMatches(prose, ANGUISH_RE) +
		countMatches(prose, DUDE_RE) +
		countMatches(prose, SAD_EMOTICON_RE);

	const negation = countMatches(prose, NEGATION_LEAD_RE) + countMatches(prose, NEGATION_PHRASE_RE);
	const repetition = countMatches(prose, REPETITION_RECALL_RE) + countMatches(prose, REPETITION_STILL_RE);
	const blame =
		countMatches(prose, BLAME_YOU_RE) + countMatches(prose, BLAME_WHY_RE) + countMatches(prose, BLAME_STOP_RE);

	return {
		chars,
		words,
		yelling: countYellingSentences(prose),
		profanity: countMatches(prose, PROFANITY_RE),
		anguish,
		negation,
		repetition,
		blame,
	};
}

/** Empty metrics constant for callers that need a default. */
export const EMPTY_USER_METRICS: UserMessageMetrics = Object.freeze({
	chars: 0,
	words: 0,
	yelling: 0,
	profanity: 0,
	anguish: 0,
	negation: 0,
	repetition: 0,
	blame: 0,
});
