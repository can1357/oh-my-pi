import type { Database } from "bun:sqlite";
import { type Env, polyphonicRecallEnabled } from "../config";
import { closeQuietly, type DatabasePath, openDatabase } from "../db";
import { clipRecallContent, normalizeRecallScore, RECALL_CONTENT_PREVIEW_CHARS, STOP_WORDS } from "./beam/recall";
import type { BeamMemoryState, JsonValue, Metadata, RecallLengthNormalization, RecallResult } from "./beam/types";
import { EpisodicGraph, isPlausibleFactSubject } from "./episodic-graph";
import { mmrRerank } from "./mmr";
import { VeracityConsolidator } from "./veracity-consolidation";

export type PolyphonicVoice = "vector" | "graph" | "fact" | "temporal";

export interface VoiceRecallResult {
	readonly memoryId: string;
	readonly score: number;
	readonly voice: PolyphonicVoice;
	readonly metadata: Metadata;
}

export interface PolyphonicResult {
	readonly memoryId: string;
	combinedScore: number;
	readonly voiceScores: Partial<Record<PolyphonicVoice, number>>;
	readonly metadata: Metadata;
}

/**
 * `id`/`content` are re-declared because `RecallResult` carries a
 * `[key: string]: unknown` index signature, which makes `Omit<RecallResult, K>`
 * collapse to `{ [x: string]: unknown }` and drop every named property. Without
 * them this type is not assignable to `RecallResult`. `hydrateResults()` always
 * populates both.
 */
export interface PolyphonicMemoryResult extends Omit<RecallResult, "metadata" | "score" | "tier"> {
	id: string;
	content: string;
	score: number;
	combined_score: number;
	voice_scores: Partial<Record<PolyphonicVoice, number>>;
	metadata: Metadata;
	tier: "working" | "episodic";
}

export interface PolyphonicRecallOptions {
	readonly queryEmbedding?: readonly number[] | Float32Array | null;
	readonly lengthNormalization?: RecallLengthNormalization;
	readonly scoreFloor?: number;
	readonly poolFloor?: number;
}

/** Options accepted by {@link PolyphonicRecallEngine.recall}'s fourth argument. */
export interface PolyphonicRecallEngineOptions {
	readonly lengthNormalization?: RecallLengthNormalization;
	/** Abstention floor: fused results below it are dropped; everything below -> empty return. */
	readonly scoreFloor?: number;
	/**
	 * Pool-cleaning floor (round-4 A/B evaluation knob): fused candidates below it are kept out
	 * of the diversity (MMR) pool so weak rows cannot crowd selection, while the RETURNED COUNT
	 * stays identical to `poolFloor: 0`. It never abstains and never truncates: if fewer than
	 * `topK` candidates clear the floor, the pool is topped up with the best below-floor
	 * candidates as filler. That invariance is deliberate — a floor that could shrink the
	 * result set would let a metric gain come from dropping weak rows (abstention) rather than
	 * from better selection, making the two effects inseparable.
	 * {@link PolyphonicRecallEngineOptions.scoreFloor} remains the only knob that may change
	 * how many rows are returned. Absent/0 = inert; production callers never pass this.
	 */
	readonly poolFloor?: number;
}

/**
 * Measured production default; see the field doc on {@link PolyphonicRecallEngine.voiceWeights}.
 *
 * Round-3 adoption (2026-08-25): `.2/.4/.4/0` replaced the Phase-1 `.15/.55/.2/.1` after a
 * pre-registered paired holdout evaluation on a 443-case labelled benchmark (165 never-tuned
 * holdout cases, both configs through this exact production path): aggregate nDCG@8
 * .3943 → .4044 (+1.01pts, paired mean +0.64 ± 0.42 SE), every per-class R@8 delta within
 * the frozen −5pt bound (worst: graph −1.87pts), negative FPR unchanged. Selection rule:
 * validation-argmax among configs improving BOTH dev and validation splits. Receipts:
 * work/r3-holdout-verdict.json, work/r3-weight-receipt.json, work/r3-paired-bundle.json.
 */
const DEFAULT_VOICE_WEIGHTS: Readonly<Record<PolyphonicVoice, number>> = Object.freeze({
	vector: 0.2,
	graph: 0.4,
	fact: 0.4,
	temporal: 0,
});

interface PolyphonicEngineOptions {
	readonly dbPath?: DatabasePath;
	readonly db?: Database;
	readonly graph?: EpisodicGraph;
	readonly consolidator?: VeracityConsolidator;
	readonly sessionId?: string | null;
	readonly channelId?: string | null;
	/**
	 * Per-voice RRF weight override for A/B evaluation harnesses, so a CHALLENGER weight
	 * config runs through the exact production path (combineVoices + diversityRerank +
	 * hydration) instead of a re-implementation. Absent = the measured production default;
	 * production callers never pass this.
	 */
	readonly voiceWeights?: Readonly<Record<PolyphonicVoice, number>>;
}

interface MemoryHydrationRow {
	readonly id: string;
	readonly content: string;
	readonly source: string | null;
	readonly timestamp: string | null;
	readonly session_id: string;
	readonly importance: number;
	readonly metadata_json: string | null;
	readonly veracity: string;
	readonly memory_type: string | null;
	readonly recall_count: number | null;
	readonly last_recalled: string | null;
	readonly valid_until: string | null;
	readonly superseded_by: string | null;
	readonly scope: string | null;
	readonly author_id: string | null;
	readonly author_type: string | null;
	readonly channel_id: string | null;
	readonly trust_tier: string | null;
	readonly created_at: string;
	readonly rowid?: number;
	readonly summary_of?: string;
	readonly tier?: number;
	readonly tier_name: "working" | "episodic";
}

interface EmbeddingRow {
	readonly memory_id: string;
	readonly embedding_json: string;
	readonly embedding_tier: "working" | "episodic";
}

interface TemporalRow {
	readonly id: string;
	readonly timestamp: string | null;
	readonly importance: number;
}

interface ContentRow {
	readonly id: string;
	readonly content: string | null;
}

const RRF_K = 60;
const POLYPHONIC_VOICES: readonly PolyphonicVoice[] = ["vector", "graph", "fact", "temporal"];
/**
 * MMR tradeoff between relevance and novelty, matching the linear path's default
 * (`recallEnhanced` uses `options.mmrLambda ?? 0.7` — see `beam/recall.ts`).
 */
const MMR_LAMBDA = 0.7;
/**
 * Candidates hydrated and considered per requested result before diversity selection.
 *
 * The voices can nominate far more candidates than `topK` (the graph voice walks `ctx`
 * edges depth-2 and is not intrinsically bounded), so the ranked candidate list is
 * clipped to this window before the point-lookup hydration. Mirrors the linear path's
 * `Math.max(topK * 2, topK)` overfetch, with more headroom because MMR needs a pool of
 * alternatives to trade relevance against novelty.
 */
const DIVERSITY_OVERFETCH = 8;
const DIVERSITY_MIN_WINDOW = 64;

export function polyphonicRecallIsEnabled(env: Env = process.env): boolean {
	return polyphonicRecallEnabled(env);
}
function envDisabled(name: string, env: Env = process.env): boolean {
	const value = env[name];
	if (value === undefined) return false;
	return ["0", "false", "no", "off"].includes(value.trim().toLowerCase());
}

function metadataValue(value: unknown): JsonValue {
	if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
		return value;
	}
	if (Array.isArray(value)) return value.map(metadataValue);
	if (typeof value === "object") {
		const out: Record<string, JsonValue> = {};
		const record = value as Record<string, unknown>;
		for (const key in record) {
			out[key] = metadataValue(record[key]);
		}
		return out;
	}
	return String(value);
}

function parseMetadata(raw: string | null): Metadata {
	if (raw === null || raw.length === 0) return {};
	try {
		const parsed = JSON.parse(raw) as unknown;
		if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
			return metadataValue(parsed) as Metadata;
		}
	} catch {
		// Malformed metadata must not make recall fail.
	}
	return {};
}

function normalizeVector(vector: readonly number[] | Float32Array): Float32Array | null {
	if (vector.length === 0) return null;
	let normSq = 0;
	for (let i = 0; i < vector.length; i++) {
		const value = vector[i];
		if (value === undefined || !Number.isFinite(value)) return null;
		normSq += value * value;
	}
	if (normSq === 0) return null;
	const norm = Math.sqrt(normSq);
	const out = new Float32Array(vector.length);
	for (let i = 0; i < vector.length; i++) out[i] = (vector[i] as number) / norm;
	return out;
}

function cosineAgainstUnit(unit: Float32Array, raw: unknown): number | null {
	if (!Array.isArray(raw) || raw.length !== unit.length) return null;
	let normSq = 0;
	let dot = 0;
	for (let i = 0; i < raw.length; i++) {
		const value = raw[i];
		if (typeof value !== "number" || !Number.isFinite(value)) return null;
		normSq += value * value;
		const unitValue = unit[i];
		if (unitValue === undefined) return null;
		dot += unitValue * value;
	}
	if (normSq === 0) return null;
	return dot / Math.sqrt(normSq);
}

/**
 * Writer placeholders that must never be treated as entity names.
 *
 * `storeFactStrings` stores flat statements as `subject='fact', predicate='entity'` (154 of
 * 185 rows in the reference bank) and the metrics writer uses `version`. These are field
 * labels, not entities.
 */
const SUBJECT_PLACEHOLDERS: Record<string, true> = {
	entities: true,
	entity: true,
	fact: true,
	facts: true,
	version: true,
	versions: true,
};

/**
 * Common words that a sentence-initial-capitalisation extractor mistakes for entities.
 *
 * Seeded from measured leakage on a real bank: 13 words that survived
 * `ENTITY_EXTRACTION_STOP_WORDS` (applied inside `isPlausibleFactSubject`) and still polluted
 * the graph voice. Removing them cost none of that bank's 12 real single-word entities.
 * Extend as more are observed; it is a heuristic backstop, not a claim to completeness.
 */
const COMMON_SENTENCE_WORDS: Record<string, true> = {
	after: true,
	also: true,
	always: true,
	aug: true,
	call: true,
	document: true,
	high: true,
	low: true,
	never: true,
	note: true,
	only: true,
	read: true,
	real: true,
	reply: true,
	same: true,
	use: true,
	visual: true,
	wrong: true,
};

/**
 * Curated common-word lexicon: the general English function and high-frequency words that a
 * capitalisation-based participant extractor mistakes for entity names.
 *
 * {@link COMMON_SENTENCE_WORDS} is a MEASURED backstop -- the leakers actually observed on
 * one bank -- so it necessarily lags whatever the next bank's gists happen to capitalise
 * ("Should", "Which", "People", "Something" all survive it). This list generalises it:
 * 580 hand-curated articles, determiners, pronouns, prepositions, conjunctions,
 * auxiliaries and modals, adverbs, quantifiers and sentence starters. None of them can
 * usefully seed the graph voice, which carries the highest fusion weight.
 *
 * Curation rules, because the real hazard is over-filtering a genuine entity:
 * - NO domain nouns. `ENTITY_EXTRACTION_STOP_WORDS` already carries `memory`, `system`,
 *   `work`, `data`, `user` and `fact`, and `beam/recall.ts` documents what reusing that
 *   list as a search-term filter cost ("how does the memory system work" produced ZERO
 *   terms). A coding-agent bank legitimately stores `Bash`, `Config`, `Session`, `Cache`,
 *   `Token`, so no such noun appears here.
 * - NO word that also names a shell command, git subcommand, HTTP verb or omp tool:
 *   `find`, `put`, `set`, `open`, `write`, `show`, `list`, `move`, `run`, `wait`,
 *   `watch`, `left`, `right` are deliberately absent despite being common English words.
 * - NO numerals, and nothing shorter than 3 characters ({@link
 *   PolyphonicRecallEngine.subjectDictionary} already drops those).
 * - Contraction stems a tokenizer emits from "doesn't"/"wasn't" are included, but only the
 *   ones that are not themselves words or names: `don`, `won`, `haven` and `shan` are out.
 *
 * Kill switch: `MNEMOPI_GRAPH_LEXICON=0` (same "0"/"false"/"no"/"off" semantics as the
 * `MNEMOPI_VOICE_*` switches) bypasses this list and leaves the measured backstop alone, so
 * a negative control can attribute a recall difference to the lexicon. It is read when the
 * dictionary is REBUILT, so flipping it inside a live process also needs
 * {@link PolyphonicRecallEngine.invalidateDictionary}.
 *
 * Applied under exactly the same guards as the measured backstop -- single-word participants
 * only, never one corroborated by a `facts.subject` -- because it is an additive word
 * filter, not a structural rule. The three structural alternatives that measurement rejected
 * stay rejected; see {@link PolyphonicRecallEngine.subjectDictionary}.
 */
const GRAPH_COMMON_WORD_LEXICON: Record<string, true> = {
	about: true,
	above: true,
	across: true,
	afterward: true,
	afterwards: true,
	again: true,
	against: true,
	ago: true,
	ahead: true,
	albeit: true,
	alike: true,
	all: true,
	almost: true,
	alone: true,
	along: true,
	alongside: true,
	already: true,
	alright: true,
	also: true,
	although: true,
	altogether: true,
	always: true,
	amid: true,
	amidst: true,
	among: true,
	amongst: true,
	amount: true,
	another: true,
	any: true,
	anybody: true,
	anyhow: true,
	anymore: true,
	anyone: true,
	anything: true,
	anytime: true,
	anyway: true,
	anyways: true,
	anywhere: true,
	apart: true,
	apparently: true,
	approximately: true,
	are: true,
	aren: true,
	arguably: true,
	around: true,
	aside: true,
	asked: true,
	asking: true,
	away: true,
	back: true,
	backward: true,
	backwards: true,
	barely: true,
	basically: true,
	because: true,
	become: true,
	becomes: true,
	becoming: true,
	been: true,
	before: true,
	beforehand: true,
	began: true,
	begin: true,
	beginning: true,
	begun: true,
	behind: true,
	being: true,
	believe: true,
	believed: true,
	below: true,
	beneath: true,
	beside: true,
	besides: true,
	best: true,
	better: true,
	between: true,
	beyond: true,
	both: true,
	bring: true,
	brings: true,
	broadly: true,
	brought: true,
	came: true,
	can: true,
	cannot: true,
	certain: true,
	certainly: true,
	clearly: true,
	come: true,
	comes: true,
	coming: true,
	completely: true,
	concerning: true,
	consequently: true,
	consider: true,
	considered: true,
	considering: true,
	could: true,
	couldn: true,
	currently: true,
	daily: true,
	day: true,
	days: true,
	decide: true,
	decided: true,
	definitely: true,
	despite: true,
	did: true,
	didn: true,
	does: true,
	doesn: true,
	doing: true,
	done: true,
	down: true,
	downward: true,
	due: true,
	during: true,
	each: true,
	earlier: true,
	early: true,
	easily: true,
	either: true,
	else: true,
	elsewhere: true,
	enough: true,
	entire: true,
	entirely: true,
	equally: true,
	especially: true,
	essentially: true,
	etc: true,
	even: true,
	eventually: true,
	ever: true,
	every: true,
	everybody: true,
	everyone: true,
	everything: true,
	everywhere: true,
	evidently: true,
	exactly: true,
	except: true,
	explain: true,
	explained: true,
	explicitly: true,
	extremely: true,
	fairly: true,
	far: true,
	few: true,
	fewer: true,
	finally: true,
	first: true,
	following: true,
	forever: true,
	forget: true,
	forgot: true,
	former: true,
	formerly: true,
	forth: true,
	fortunately: true,
	forward: true,
	frequently: true,
	from: true,
	full: true,
	fully: true,
	further: true,
	furthermore: true,
	gave: true,
	general: true,
	generally: true,
	get: true,
	gets: true,
	getting: true,
	give: true,
	given: true,
	gives: true,
	giving: true,
	goes: true,
	going: true,
	gone: true,
	got: true,
	gotten: true,
	gradually: true,
	greatly: true,
	guess: true,
	had: true,
	hadn: true,
	half: true,
	happen: true,
	happened: true,
	happens: true,
	hardly: true,
	has: true,
	hasn: true,
	have: true,
	having: true,
	hence: true,
	henceforth: true,
	her: true,
	here: true,
	hereafter: true,
	hereby: true,
	herein: true,
	hers: true,
	herself: true,
	him: true,
	himself: true,
	his: true,
	hitherto: true,
	hopefully: true,
	hour: true,
	hours: true,
	how: true,
	however: true,
	ideally: true,
	immediately: true,
	implicitly: true,
	importantly: true,
	inasmuch: true,
	indeed: true,
	inevitably: true,
	initially: true,
	inside: true,
	insofar: true,
	instead: true,
	into: true,
	isn: true,
	its: true,
	itself: true,
	just: true,
	keep: true,
	keeps: true,
	kept: true,
	kind: true,
	kinds: true,
	knew: true,
	know: true,
	known: true,
	knows: true,
	largely: true,
	last: true,
	lastly: true,
	lately: true,
	later: true,
	latter: true,
	latterly: true,
	least: true,
	less: true,
	lest: true,
	let: true,
	lets: true,
	likely: true,
	likewise: true,
	literally: true,
	little: true,
	look: true,
	looked: true,
	looking: true,
	looks: true,
	lot: true,
	lots: true,
	made: true,
	mainly: true,
	make: true,
	makes: true,
	making: true,
	many: true,
	matter: true,
	may: true,
	maybe: true,
	mean: true,
	means: true,
	meant: true,
	meanwhile: true,
	merely: true,
	met: true,
	might: true,
	mightn: true,
	mine: true,
	minute: true,
	minutes: true,
	moment: true,
	month: true,
	months: true,
	more: true,
	moreover: true,
	most: true,
	mostly: true,
	much: true,
	must: true,
	mustn: true,
	mutually: true,
	myself: true,
	namely: true,
	naturally: true,
	nearly: true,
	necessarily: true,
	need: true,
	needed: true,
	needs: true,
	neither: true,
	nevermore: true,
	nevertheless: true,
	next: true,
	nobody: true,
	none: true,
	nonetheless: true,
	nope: true,
	nor: true,
	normally: true,
	not: true,
	notably: true,
	nothing: true,
	notwithstanding: true,
	now: true,
	nowadays: true,
	nowhere: true,
	obviously: true,
	occasionally: true,
	off: true,
	officially: true,
	often: true,
	okay: true,
	once: true,
	one: true,
	ones: true,
	oneself: true,
	onto: true,
	ordinarily: true,
	originally: true,
	other: true,
	others: true,
	otherwise: true,
	ought: true,
	ours: true,
	ourselves: true,
	out: true,
	outside: true,
	over: true,
	overall: true,
	overly: true,
	own: true,
	particularly: true,
	partly: true,
	past: true,
	people: true,
	per: true,
	perhaps: true,
	person: true,
	personally: true,
	persons: true,
	plainly: true,
	please: true,
	plenty: true,
	possibly: true,
	potentially: true,
	practically: true,
	precisely: true,
	predominantly: true,
	presently: true,
	presumably: true,
	pretty: true,
	previously: true,
	primarily: true,
	probably: true,
	properly: true,
	purely: true,
	quickly: true,
	quite: true,
	rarely: true,
	rather: true,
	readily: true,
	really: true,
	reasonably: true,
	recently: true,
	regarding: true,
	regardless: true,
	relatively: true,
	remain: true,
	remained: true,
	remains: true,
	repeatedly: true,
	rightly: true,
	roughly: true,
	routinely: true,
	said: true,
	saw: true,
	say: true,
	says: true,
	see: true,
	seeing: true,
	seem: true,
	seemed: true,
	seemingly: true,
	seems: true,
	seen: true,
	sees: true,
	seldom: true,
	separately: true,
	seriously: true,
	several: true,
	shall: true,
	she: true,
	should: true,
	shouldn: true,
	similarly: true,
	simply: true,
	simultaneously: true,
	since: true,
	slightly: true,
	slowly: true,
	small: true,
	smaller: true,
	solely: true,
	some: true,
	somebody: true,
	somehow: true,
	someone: true,
	something: true,
	sometime: true,
	sometimes: true,
	somewhat: true,
	somewhere: true,
	soon: true,
	sorry: true,
	specifically: true,
	steadily: true,
	still: true,
	strictly: true,
	subsequently: true,
	substantially: true,
	successfully: true,
	such: true,
	suddenly: true,
	sufficiently: true,
	suppose: true,
	supposed: true,
	supposedly: true,
	sure: true,
	surely: true,
	take: true,
	taken: true,
	takes: true,
	taking: true,
	technically: true,
	tell: true,
	telling: true,
	tells: true,
	temporarily: true,
	than: true,
	thank: true,
	thanks: true,
	that: true,
	thats: true,
	the: true,
	their: true,
	theirs: true,
	them: true,
	themselves: true,
	// biome-ignore lint/suspicious/noThenProperty: module-local lookup table, never crosses an await boundary; "then" is a genuine junk sentence-starter that must be filterable.
	then: true,
	thence: true,
	there: true,
	thereafter: true,
	thereby: true,
	therefore: true,
	therein: true,
	thereof: true,
	thereupon: true,
	these: true,
	they: true,
	thing: true,
	things: true,
	think: true,
	thinking: true,
	thinks: true,
	this: true,
	thorough: true,
	thoroughly: true,
	those: true,
	though: true,
	thought: true,
	through: true,
	throughout: true,
	thus: true,
	till: true,
	time: true,
	times: true,
	today: true,
	together: true,
	tomorrow: true,
	tonight: true,
	too: true,
	took: true,
	totally: true,
	toward: true,
	towards: true,
	truly: true,
	try: true,
	trying: true,
	twice: true,
	typically: true,
	ultimately: true,
	unable: true,
	under: true,
	underneath: true,
	undoubtedly: true,
	unfortunately: true,
	universally: true,
	unless: true,
	unlike: true,
	unlikely: true,
	until: true,
	unto: true,
	unusually: true,
	upon: true,
	upward: true,
	upwards: true,
	usually: true,
	vaguely: true,
	various: true,
	vastly: true,
	versus: true,
	very: true,
	via: true,
	virtually: true,
	want: true,
	wanted: true,
	wants: true,
	was: true,
	wasn: true,
	way: true,
	ways: true,
	week: true,
	weeks: true,
	well: true,
	were: true,
	weren: true,
	what: true,
	whatever: true,
	whatsoever: true,
	when: true,
	whenever: true,
	where: true,
	whereas: true,
	whereby: true,
	wherein: true,
	whereupon: true,
	wherever: true,
	whether: true,
	which: true,
	whichever: true,
	while: true,
	whilst: true,
	whither: true,
	who: true,
	whoever: true,
	whole: true,
	wholly: true,
	whom: true,
	whose: true,
	why: true,
	widely: true,
	will: true,
	willing: true,
	wish: true,
	with: true,
	within: true,
	without: true,
	wonder: true,
	worse: true,
	worst: true,
	would: true,
	wouldn: true,
	year: true,
	years: true,
	yes: true,
	yesterday: true,
	yet: true,
	you: true,
	your: true,
	yours: true,
	yourself: true,
	yourselves: true,
};

function queryWords(query: string): string[] {
	const seen = new Set<string>();
	for (const match of query.toLowerCase().matchAll(/[\p{L}\p{N}_-]+/gu)) {
		const word = match[0];
		if (word.length >= 3) seen.add(word);
	}
	return [...seen];
}

function looksTemporal(query: string): boolean {
	const lower = query.toLowerCase();
	return ["yesterday", "today", "recent", "last", "latest", "this week", "this month", "ago", "before"].some(keyword =>
		lower.includes(keyword),
	);
}

/**
 * Batch-load the visible content for candidate memory ids.
 *
 * Applies the same visibility predicates as `PolyphonicRecallEngine.lookupMemory` so
 * diversity selection and hydration agree on which rows exist: a candidate filtered out
 * here can no longer consume a result slot and shrink the response at hydration time.
 * Working memory wins over episodic for the same id, matching `lookupMemory`'s order.
 */
function candidateContents(db: Database, ids: readonly string[], sessionId: string, now: string): Map<string, string> {
	const contents = new Map<string, string>();
	if (ids.length === 0) return contents;
	const placeholders = ids.map(() => "?").join(",");
	let rows: ContentRow[] = [];
	try {
		rows = db
			.query(`
				SELECT id, content FROM working_memory
				WHERE id IN (${placeholders})
					AND superseded_by IS NULL
					AND (valid_until IS NULL OR valid_until > ?)
					AND (session_id = ? OR scope = 'global')
				UNION ALL
				SELECT id, content FROM episodic_memory
				WHERE id IN (${placeholders})
					AND superseded_by IS NULL
					AND (valid_until IS NULL OR valid_until > ?)
					AND (session_id = ? OR scope = 'global')
			`)
			.all(...ids, now, sessionId, ...ids, now, sessionId) as ContentRow[];
	} catch {
		return contents;
	}
	for (const row of rows) {
		if (!contents.has(row.id)) contents.set(row.id, row.content ?? "");
	}
	return contents;
}

/**
 * Id-only variant of {@link candidateContents}' visibility predicate, for filtering a
 * candidate pool BEFORE the diversity window is cut: an invisible candidate (superseded,
 * expired, out of session scope) must never occupy a window slot, or a flood of dead
 * high-scorers evicts live rows from selection entirely (measured on post-chunk-migration
 * banks, where every migrated parent is a broad-matching dead candidate). Chunked so a
 * graph-walk-sized pool can never exceed SQLite's bound-variable limit.
 */
function visibleCandidateIds(db: Database, ids: readonly string[], sessionId: string, now: string): Set<string> {
	const visible = new Set<string>();
	for (let offset = 0; offset < ids.length; offset += 900) {
		const chunk = ids.slice(offset, offset + 900);
		const placeholders = chunk.map(() => "?").join(",");
		try {
			const rows = db
				.query(`
					SELECT id FROM working_memory
					WHERE id IN (${placeholders})
						AND superseded_by IS NULL
						AND (valid_until IS NULL OR valid_until > ?)
						AND (session_id = ? OR scope = 'global')
					UNION
					SELECT id FROM episodic_memory
					WHERE id IN (${placeholders})
						AND superseded_by IS NULL
						AND (valid_until IS NULL OR valid_until > ?)
						AND (session_id = ? OR scope = 'global')
				`)
				.all(...chunk, now, sessionId, ...chunk, now, sessionId) as Array<{ id: string }>;
			for (const row of rows) visible.add(row.id);
		} catch {
			// A failed chunk keeps its candidates OUT of the visible set: fail toward fewer
			// candidates, never toward letting an unverified id occupy a slot.
		}
	}
	return visible;
}

export class PolyphonicRecallEngine {
	readonly dbPath: DatabasePath;
	readonly db: Database;
	readonly ownsConnection: boolean;
	readonly graph: EpisodicGraph;
	readonly consolidator: VeracityConsolidator;
	readonly sessionId: string;
	readonly channelId: string | null;
	/**
	 * Per-voice RRF weights, applied in {@link combineVoices}.
	 *
	 * Graph-favouring by measurement, not by intuition. On a 250-topic labelled evaluation the
	 * previously-declared (and never-applied) `.35/.25/.25/.15` was a regression versus
	 * unweighted fusion on multi-topic queries (P@20 0.630 -> 0.450, nDCG 0.576 vs 0.701),
	 * because one query embedding cannot sit near several topic clusters at once, so tilting
	 * toward the vector voice hurts exactly the queries that need the graph voice's breadth.
	 * These weights scored best in that sweep (multi-topic P@20 0.805, nDCG 0.819) while
	 * leaving single-topic results unchanged.
	 *
	 * Overridable ONLY via {@link PolyphonicEngineOptions.voiceWeights} (A/B evaluation
	 * harnesses); every production construction path leaves it at this default.
	 */
	readonly voiceWeights: Readonly<Record<PolyphonicVoice, number>>;
	/** Memoised subject dictionary. See {@link subjectDictionary} and {@link invalidateDictionary}. */
	#dictionary: readonly string[] | null = null;
	#dictionaryStamp = "";
	/** Memoised `PRAGMA table_info(facts)` probe for the optional `scope` column. */
	#factsScopeColumn: boolean | null = null;
	/** Last `fts_facts` failure, surfaced through {@link getStats} so it cannot hide as "no matches". */
	#factObjectError: string | null = null;

	/**
	 * Drop the memoised subject dictionary.
	 *
	 * Called by `invalidateCaches()` in `beam/store.ts` (duck-typed, so no import cycle) on
	 * every store/forget/invalidate, and by the consolidation path. This is the authoritative
	 * mechanism: {@link subjectDictionary}'s `MAX(rowid)` stamp only catches APPENDS — it
	 * cannot see a deleted non-maximal row, an in-place subject UPDATE, or SQLite rowid REUSE
	 * (neither `facts` nor `gists` uses AUTOINCREMENT, so delete-max-then-insert leaves
	 * `MAX(rowid)` unchanged). The stamp is kept only as a cheap catch for writes made by
	 * ANOTHER process, which cannot call this method.
	 */
	invalidateDictionary(): void {
		this.#dictionary = null;
		this.#dictionaryStamp = "";
	}

	constructor(options: PolyphonicEngineOptions = {}) {
		this.dbPath = options.dbPath ?? ":memory:";
		this.db = options.db ?? openDatabase(this.dbPath);
		this.ownsConnection = options.db === undefined;
		this.graph = options.graph ?? new EpisodicGraph({ db: this.db, dbPath: this.dbPath });
		this.consolidator = options.consolidator ?? new VeracityConsolidator(this.dbPath, this.db);
		this.sessionId = options.sessionId ?? "default";
		this.channelId = options.channelId ?? null;
		if (options.voiceWeights !== undefined) {
			for (const voice of ["vector", "graph", "fact", "temporal"] as const) {
				const weight = options.voiceWeights[voice];
				if (typeof weight !== "number" || !Number.isFinite(weight) || weight < 0) {
					throw new Error(`voiceWeights.${voice} must be a finite non-negative number, got ${String(weight)}`);
				}
			}
			this.voiceWeights = Object.freeze({ ...options.voiceWeights });
		} else {
			this.voiceWeights = DEFAULT_VOICE_WEIGHTS;
		}
	}

	/**
	 * Fuse the four voices and return a diverse top-`topK`.
	 *
	 * There is deliberately no engine-side character budget: the previous `assembleContext`
	 * clip measured `JSON.stringify(metadata)` rather than the content that actually reaches
	 * the prompt, so it never bound at omp's real `recallLimit` and did not bind at larger
	 * topK either (measured: 20 rows / 74503 chars passed straight through). The host already
	 * clips the rendered block via `mnemopi.injectionTokenLimit`, which was doing 100% of the
	 * real work.
	 */
	recall(
		query: string,
		queryEmbedding: readonly number[] | Float32Array | null = null,
		topK = 10,
		options: PolyphonicRecallEngineOptions = {},
	): PolyphonicMemoryResult[] {
		const vectorResults = this.vectorVoice(queryEmbedding);
		const graphResults = this.graphVoice(query);
		const factResults = this.factVoice(query);
		const temporalResults = this.temporalVoice(query);
		const combined = this.combineVoices(vectorResults, graphResults, factResults, temporalResults);
		return this.hydrateResults(
			this.diversityRerank(
				combined,
				topK,
				options.lengthNormalization ?? "none",
				options.scoreFloor,
				options.poolFloor,
			),
		);
	}

	vectorVoice(queryEmbedding: readonly number[] | Float32Array | null): VoiceRecallResult[] {
		if (envDisabled("MNEMOPI_VOICE_VECTOR") || queryEmbedding === null) return [];
		const queryUnit = normalizeVector(queryEmbedding);
		if (queryUnit === null) return [];
		const now = new Date().toISOString();
		let rows: EmbeddingRow[] = [];
		try {
			rows = this.db
				.query(`
					SELECT me.memory_id, me.embedding_json, 'working' AS embedding_tier
					FROM memory_embeddings me
					JOIN working_memory wm ON wm.id = me.memory_id
					WHERE wm.superseded_by IS NULL
						AND (wm.valid_until IS NULL OR wm.valid_until > ?)
						AND (wm.session_id = ? OR wm.scope = 'global')
					UNION ALL
					SELECT me.memory_id, me.embedding_json, 'episodic' AS embedding_tier
					FROM memory_embeddings me
					JOIN episodic_memory em ON em.id = me.memory_id
					WHERE em.superseded_by IS NULL
						AND (em.valid_until IS NULL OR em.valid_until > ?)
						AND (em.session_id = ? OR em.scope = 'global')
					LIMIT 50000
				`)
				.all(now, this.sessionId, now, this.sessionId) as EmbeddingRow[];
		} catch {
			return [];
		}

		const byId = new Map<string, VoiceRecallResult>();
		for (const row of rows) {
			let parsed: unknown;
			try {
				parsed = JSON.parse(row.embedding_json) as unknown;
			} catch {
				continue;
			}
			const cosine = cosineAgainstUnit(queryUnit, parsed);
			if (cosine === null) continue;
			const similarity = (cosine + 1) / 2;
			const existing = byId.get(row.memory_id);
			if (existing === undefined || similarity > existing.score) {
				byId.set(row.memory_id, {
					memoryId: row.memory_id,
					score: similarity,
					voice: "vector",
					metadata: {
						similarity,
						cosine_similarity: cosine,
						embedding_tier: row.embedding_tier,
						backend: "memory_embeddings",
					},
				});
			}
		}
		return [...byId.values()].sort((a, b) => b.score - a.score || a.memoryId.localeCompare(b.memoryId)).slice(0, 20);
	}
	/**
	 * Subjects and gist participants that this bank actually stores, filtered to plausible
	 * entities and ordered longest-first for greedy non-overlapping matching.
	 *
	 * Replaces query-side proper-case regex extraction, which could only recover 3 of this
	 * bank's 25 stored subjects: the regex requires every word to be `[A-Z][a-z]+`, so
	 * `CLI`, `Bash tool` and `Kitty APC graphics upload` were unreachable from any query.
	 * Matching against what is stored instead recovers every guard-approved subject AND
	 * cannot invent an entity that no row uses, which measured 0 junk lookups per query
	 * versus 0.75-1.10 for the regex.
	 *
	 * Memoised per engine (one engine per beam) and rebuilt when either source table grows.
	 * `MAX(rowid)` is an O(1) index lookup, unlike `COUNT(*)`.
	 */
	subjectDictionary(): readonly string[] {
		let stamp = "";
		try {
			const row: unknown = this.db
				.query("SELECT (SELECT MAX(rowid) FROM facts) AS f, (SELECT MAX(rowid) FROM gists) AS g")
				.get();
			if (row !== null && typeof row === "object" && "f" in row && "g" in row) {
				stamp = `${String(row.f)}:${String(row.g)}`;
			}
		} catch {
			stamp = "";
		}
		const cached = this.#dictionary;
		if (cached !== null && stamp === this.#dictionaryStamp) return cached;

		const seen = new Map<string, string>();
		const consider = (raw: unknown): void => {
			if (typeof raw !== "string") return;
			const value = raw.trim();
			if (value.length < 3) return;
			const key = value.toLowerCase();
			// Writer placeholders are not entity names and MUST NOT enter the dictionary. A
			// generic plausibility guard passes `fact` (a single common noun, not a stop word),
			// which would let any query containing "fact" seed every flat placeholder row —
			// 154 of 185 rows in the reference bank, i.e. exactly the unguarded-dictionary
			// behaviour (473 candidates vs 170) that was measured and rejected.
			if (SUBJECT_PLACEHOLDERS[key] === true) return;
			// Snake_case identifiers are metric keys, not prose entities; they can never appear
			// in a natural query, so excluding them only keeps the dictionary clean.
			if (value.includes("_")) return;
			if (!isPlausibleFactSubject(value)) return;
			if (!seen.has(key)) seen.set(key, value);
		};
		try {
			for (const row of this.db.query("SELECT DISTINCT subject FROM facts").iterate()) {
				if (row !== null && typeof row === "object" && "subject" in row) consider(row.subject);
			}
			// Gist participants come from a crude regex that captures any capitalised token, so
			// they mix real entities ("Kitty", "Mnemopi", "Chromium") with words that are only
			// capitalised because they began a sentence ("Read", "Only", "Never", "Visual").
			// `isPlausibleFactSubject` already drops the ones in ENTITY_EXTRACTION_STOP_WORDS
			// (measured: 13 of 27 junk words on the reference bank) but not the rest, and the
			// survivors fed the graph voice — which carries the highest fusion weight — with
			// 16-23 junk candidates for an ordinary sentence.
			//
			// Filtered by two word lists under identical guards: {@link COMMON_SENTENCE_WORDS},
			// the always-on measured backstop that removes the remaining 13 leakers at zero
			// cost to the 12 real entities, and {@link GRAPH_COMMON_WORD_LEXICON}, a curated
			// general English function-word list that generalises past the words one bank
			// happened to leak (`Should`, `Which`, `People`, `Something` all survive the
			// measured list). The lexicon is killable with `MNEMOPI_GRAPH_LEXICON=0`; the
			// backstop is not, because it carries domain-adjacent words (`read`, `call`,
			// `note`, `document`, `use`) that a general lexicon must not contain.
			//
			// Both apply to SINGLE-WORD participants only: multi-word ones and anything
			// corroborated by a `facts.subject` cannot be an artifact of sentence-initial
			// capitalisation, so they bypass both lists.
			//
			// Three structural alternatives were tried and REJECTED by measurement, so do not
			// reintroduce them: requiring corroboration by a `facts.subject` drops real
			// single-word entities (it broke `Alice` in the fixtures); frequency across gists
			// does not separate at all (`Kitty` appears in 7 gists, `The` in 9); and requiring
			// the token to appear capitalised mid-sentence drops 7 of 12 real entities when
			// measured over gist text, and still leaks 8 of 13 junk words over full memory text.
			// A word list is additive and reversible; those three were not.
			const corroborated = new Set(seen.keys());
			const participants = new Map<string, string>();
			for (const row of this.db.query("SELECT participants_json FROM gists").iterate()) {
				if (row === null || typeof row !== "object" || !("participants_json" in row)) continue;
				const raw = row.participants_json;
				if (typeof raw !== "string") continue;
				try {
					const parsed: unknown = JSON.parse(raw);
					if (!Array.isArray(parsed)) continue;
					for (const entry of parsed) {
						if (typeof entry !== "string") continue;
						const trimmed = entry.trim();
						if (trimmed.length > 0) participants.set(trimmed.toLowerCase(), trimmed);
					}
				} catch {
					// A malformed participants blob is skipped, not fatal.
				}
			}
			const lexiconActive = !envDisabled("MNEMOPI_GRAPH_LEXICON");
			for (const [key, display] of participants) {
				// Single-word, uncorroborated participants are the only ones either list may
				// touch; see the guard rationale above.
				if (!display.includes(" ") && !corroborated.has(key)) {
					if (COMMON_SENTENCE_WORDS[key] === true) continue;
					if (lexiconActive && GRAPH_COMMON_WORD_LEXICON[key] === true) continue;
				}
				consider(display);
			}
		} catch {
			// Missing tables (a fresh bank) simply yield an empty dictionary.
		}
		const dictionary = [...seen.values()].sort((a, b) => b.length - a.length || a.localeCompare(b));
		this.#dictionary = dictionary;
		this.#dictionaryStamp = stamp;
		return dictionary;
	}

	/** Greedy longest-first, whole-word, case-insensitive dictionary matches in `query`. */
	matchStoredSubjects(query: string): string[] {
		const dictionary = this.subjectDictionary();
		if (dictionary.length === 0 || query.length === 0) return [];
		const lowered = query.toLowerCase();
		// Tracks which characters are already consumed so `Bash tool` wins over a nested match.
		const taken = new Array<boolean>(lowered.length).fill(false);
		const matches: string[] = [];
		for (const subject of dictionary) {
			const needle = subject.toLowerCase();
			let from = 0;
			for (;;) {
				const at = lowered.indexOf(needle, from);
				if (at < 0) break;
				from = at + 1;
				const before = at === 0 ? "" : (lowered[at - 1] ?? "");
				const afterIndex = at + needle.length;
				const after = afterIndex >= lowered.length ? "" : (lowered[afterIndex] ?? "");
				const isWordChar = (char: string): boolean => char.length > 0 && /[\p{L}\p{N}_]/u.test(char);
				if (isWordChar(before) || isWordChar(after)) continue;
				let overlaps = false;
				for (let i = at; i < afterIndex; i++) {
					if (taken[i] === true) {
						overlaps = true;
						break;
					}
				}
				if (overlaps) continue;
				for (let i = at; i < afterIndex; i++) taken[i] = true;
				matches.push(subject);
				break;
			}
		}
		return matches;
	}

	/**
	 * Lexical fact matches on flat-statement text.
	 *
	 * Flat extracted statements have no subject, so subject lookup can never reach them (and
	 * admitting the old `fact` placeholder to the dictionary would fire on any query
	 * containing that common word). Their text is reachable through two indexes, and BOTH
	 * must be searched:
	 *  - `fts_facts` — LEGACY rows, written before the writer stopped fabricating a subject,
	 *    which still carry `subject='fact', predicate='entity'` (154 of 185 in the reference
	 *    bank). Mapped back through `facts.source_msg_id`.
	 *  - `fts_memoria_facts` — flat statements written now, which live only in
	 *    `memoria_facts`. Mapped back through `memoria_facts.source_memory_id`.
	 *
	 * Reported as the `fact` voice, not `graph`: these are lexical matches, and the graph
	 * weight was measured for structural graph signal, not for text hits.
	 *
	 * Query shapes copy the proven `factRecall` form in `beam/recall.ts` — the FTS5 table is
	 * NOT aliased, because `MATCH`/`rank` must reference it by the same name used in `FROM`,
	 * and aliasing it throws.
	 */
	factObjectMatches(query: string): VoiceRecallResult[] {
		const hasLegacy = this.#hasTable("fts_facts");
		const hasMemoria = this.#hasTable("fts_memoria_facts");
		if (!hasLegacy && !hasMemoria) return [];
		// Feed FTS5 quoted word tokens only, so punctuation in a user query can never become
		// an operator or a syntax error. The token class excludes quotes, so no escaping.
		//
		// Filtered with the LINEAR path's grammatical stop words, not
		// `ENTITY_EXTRACTION_STOP_WORDS`. That list is an extraction-side junk-ENTITY filter
		// containing domain nouns (`memory`, `system`, `work`, `data`, `user`, `fact`), so
		// using it here made ordinary questions unsearchable: measured, "how does the memory
		// system work" produced ZERO terms and the fact voice was silent.
		const terms = [...new Set(query.toLowerCase().match(/[\p{L}\p{N}_]{3,}/gu) ?? [])]
			.filter(term => !STOP_WORDS.has(term))
			.slice(0, 8);
		if (terms.length === 0) return [];
		const expression = terms.map(term => `"${term}"`).join(" OR ");
		// Column-scoped: an unqualified FTS5 MATCH searches EVERY indexed column, so it also
		// matched `subject`/`predicate` despite this method being about object text — letting
		// terms like "facts" or "entity" hit legacy placeholder rows through the subject.
		const legacyMatch = `object : (${expression})`;
		const seeds: VoiceRecallResult[] = [];
		// Rank-aware: `fts_facts.rank` is BM25 (more negative = better). Without it every hit
		// scored `confidence * 0.45`, so a common word returned dozens of near-tied candidates
		// in arbitrary order. Blend relevance rank with the stored confidence.
		const push = (memoryId: string, weight: number, text: string, kind: string, position: number): void => {
			const trimmed = memoryId.trim();
			if (trimmed.length === 0) return;
			const rankDecay = 1 / (1 + position);
			seeds.push({
				memoryId: trimmed,
				score: weight * 0.45 * rankDecay,
				voice: "fact",
				metadata: { match_kind: kind, fact_rank: position, fact_text: text.slice(0, 120) },
			});
		};
		try {
			if (hasLegacy) {
				// Same visibility predicate the linear `factRecall` enforces. Without it, rows
				// from OTHER sessions filled the LIMIT window: measured 50 of 50 seeds foreign,
				// starving the legitimate session's own facts out of the candidate set.
				const scope = this.#factsHaveScope()
					? "(facts.session_id = ? OR facts.scope = 'global')"
					: "facts.session_id = ?";
				const rows = this.db
					.query(`
						SELECT facts.source_msg_id AS memory_id, facts.confidence AS confidence, facts.object AS object
						FROM fts_facts
						JOIN facts ON facts.rowid = fts_facts.rowid
						WHERE fts_facts MATCH ? AND facts.source_msg_id IS NOT NULL AND ${scope}
						ORDER BY fts_facts.rank, fts_facts.rowid
						LIMIT 25
					`)
					.all(legacyMatch, this.sessionId) as Array<{
					memory_id: string | null;
					confidence: number | null;
					object: string | null;
				}>;
				rows.forEach((row, index) => {
					push(row.memory_id ?? "", row.confidence ?? 0.5, row.object ?? "", "fact_object", index);
				});
			}
			if (hasMemoria) {
				const rows = this.db
					.query(`
						SELECT memoria_facts.source_memory_id AS memory_id, memoria_facts.value AS value,
							memoria_facts.importance AS importance
						FROM fts_memoria_facts
						JOIN memoria_facts ON memoria_facts.id = fts_memoria_facts.rowid
						WHERE fts_memoria_facts MATCH ? AND memoria_facts.source_memory_id IS NOT NULL
							AND memoria_facts.session_id = ?
						ORDER BY fts_memoria_facts.rank, fts_memoria_facts.rowid
						LIMIT 25
					`)
					.all(expression, this.sessionId) as Array<{
					memory_id: string | null;
					value: string | null;
					importance: number | null;
				}>;
				rows.forEach((row, index) => {
					push(row.memory_id ?? "", row.importance ?? 0.5, row.value ?? "", "memoria_fact", index);
				});
			}
			this.#factObjectError = null;
		} catch (error) {
			// Recorded rather than swallowed: a silent empty result here is indistinguishable
			// from "no matches", which is exactly how this class of bug hides. Surfaced via
			// getStats().fact_object_error.
			this.#factObjectError = error instanceof Error ? error.message : String(error);
		}
		return seeds;
	}

	/** Mirrors `factsHaveScopeColumn` in `beam/recall.ts`: older banks have no `facts.scope`. */
	#factsHaveScope(): boolean {
		if (this.#factsScopeColumn === null) {
			let present = false;
			try {
				for (const row of this.db.query("PRAGMA table_info(facts)").iterate()) {
					if (row !== null && typeof row === "object" && "name" in row && String(row.name) === "scope") {
						present = true;
						break;
					}
				}
			} catch {
				present = false;
			}
			this.#factsScopeColumn = present;
		}
		return this.#factsScopeColumn;
	}

	#hasTable(table: string): boolean {
		using statement = this.db.prepare(
			"SELECT 1 FROM sqlite_master WHERE type IN ('table','virtual table') AND name = ? LIMIT 1",
		);
		return statement.get(table) !== null;
	}

	graphVoice(query: string): VoiceRecallResult[] {
		if (envDisabled("MNEMOPI_VOICE_GRAPH")) return [];
		const results: VoiceRecallResult[] = [];
		const seedIds = new Set<string>();
		for (const entity of this.matchStoredSubjects(query)) {
			for (const gist of this.graph.findGistsByParticipant(entity)) {
				const memoryId = gist.id.startsWith("gist_") ? gist.id.slice(5) : gist.id;
				seedIds.add(memoryId);
				results.push({
					memoryId,
					score: 0.6,
					voice: "graph",
					metadata: { entity, gist: gist.text },
				});
			}
			for (const fact of this.graph.findFactsBySubject(entity)) {
				// `facts.fact_id` is a fact identifier, never a memory id: real ids are either
				// bare hex or `fact_<memoryId>_<index>`. Parsing it previously took the LAST
				// underscore segment, which is the extraction INDEX ("0"), so every
				// fact-derived seed pointed at a row that does not exist. `sourceMemoryId`
				// (`facts.source_msg_id`) is the actual link; skip facts that lack one rather
				// than seeding the traversal from a bogus node.
				const memoryId = fact.sourceMemoryId;
				if (memoryId === undefined || memoryId === null || memoryId.length === 0) continue;
				seedIds.add(memoryId);
				results.push({
					memoryId,
					score: fact.confidence * 0.5,
					voice: "graph",
					metadata: { entity, fact: `${fact.subject} ${fact.predicate} ${fact.object}` },
				});
			}
		}
		const traversed = new Set<string>();
		for (const seedId of seedIds) {
			for (const related of this.graph.findRelatedMemories(seedId, 2, "ctx", 0.3)) {
				// `ctx` edges link a memory to its own gist node, so the walk surfaces
				// `gist_<memoryId>` ids. Normalise to the underlying memory the same way the
				// gist seeding above does; otherwise these candidates never hydrate. Dedupe on
				// the normalised id so a gist and its memory cannot both be emitted.
				const memoryId = related.memoryId.startsWith("gist_") ? related.memoryId.slice(5) : related.memoryId;
				if (seedIds.has(memoryId) || traversed.has(memoryId)) continue;
				traversed.add(memoryId);
				results.push({
					memoryId,
					score: 0.4 / Math.max(1, related.depth),
					voice: "graph",
					metadata: {
						seed: seedId,
						edge_type: related.edgeType,
						depth: related.depth,
						weight: related.weight,
					},
				});
			}
		}
		return results;
	}
	factVoice(query: string): VoiceRecallResult[] {
		if (envDisabled("MNEMOPI_VOICE_FACT")) return [];
		const byId = new Map<string, VoiceRecallResult>();
		// Lexical object-text matches first: `consolidated_facts` is empty on every real bank
		// (nothing calls `consolidateFact`), so without these the fact voice returns nothing.
		for (const seed of this.factObjectMatches(query)) {
			const existing = byId.get(seed.memoryId);
			if (existing === undefined || existing.score < seed.score) byId.set(seed.memoryId, seed);
		}
		for (const word of queryWords(query)) {
			const subject = word[0] === undefined ? word : word[0].toUpperCase() + word.slice(1);
			for (const fact of this.consolidator.getConsolidatedFacts(subject, 0.5)) {
				for (const source of fact.sources) {
					const memoryId = source.trim();
					if (memoryId.length === 0) continue;
					const existing = byId.get(memoryId);
					if (existing !== undefined && existing.score >= fact.confidence) continue;
					byId.set(memoryId, {
						memoryId,
						score: fact.confidence,
						voice: "fact",
						metadata: {
							fact_id: fact.id ?? "",
							subject: fact.subject,
							predicate: fact.predicate,
							object: fact.object,
							mentions: fact.mention_count,
						},
					});
				}
			}
		}
		return [...byId.values()].sort((a, b) => b.score - a.score || a.memoryId.localeCompare(b.memoryId));
	}
	temporalVoice(query: string): VoiceRecallResult[] {
		if (envDisabled("MNEMOPI_VOICE_TEMPORAL") || !looksTemporal(query)) return [];
		const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
		let rows: TemporalRow[] = [];
		try {
			rows = this.db
				.query(`
					SELECT id, timestamp, importance
					FROM working_memory
					WHERE timestamp > ?
						AND superseded_by IS NULL
						AND (valid_until IS NULL OR valid_until > ?)
						AND (session_id = ? OR scope = 'global')
					ORDER BY timestamp DESC
					LIMIT 20
				`)
				.all(weekAgo, new Date().toISOString(), this.sessionId) as TemporalRow[];
		} catch {
			return [];
		}
		const now = Date.now();
		const results: VoiceRecallResult[] = [];
		for (const row of rows) {
			if (row.timestamp === null) continue;
			const then = Date.parse(row.timestamp);
			if (!Number.isFinite(then)) continue;
			const ageDays = Math.max(0, (now - then) / 86_400_000);
			const temporalScore = Math.exp(-ageDays / 7) * row.importance;
			results.push({
				memoryId: row.id,
				score: temporalScore,
				voice: "temporal",
				metadata: { age_days: ageDays, importance: row.importance },
			});
		}
		return results;
	}
	combineVoices(...voiceResults: readonly VoiceRecallResult[][]): Map<string, PolyphonicResult> {
		const combined = new Map<string, PolyphonicResult>();
		for (const results of voiceResults) {
			if (results.length === 0) continue;
			const sorted = [...results].sort((a, b) => b.score - a.score || a.memoryId.localeCompare(b.memoryId));
			for (let i = 0; i < sorted.length; i++) {
				const result = sorted[i];
				if (result === undefined) continue;
				const rank = i + 1;
				let existing = combined.get(result.memoryId);
				if (existing === undefined) {
					existing = { memoryId: result.memoryId, combinedScore: 0, voiceScores: {}, metadata: {} };
					combined.set(result.memoryId, existing);
				}
				// Weighted RRF. `voiceWeights` was previously declared and never applied; the
				// weights in use now are the ones that measured best on a labelled evaluation.
				const contribution = this.voiceWeights[result.voice] / (RRF_K + rank);
				existing.voiceScores[result.voice] = (existing.voiceScores[result.voice] ?? 0) + contribution;
				existing.combinedScore += contribution;
				Object.assign(existing.metadata, result.metadata);
			}
		}
		return combined;
	}
	/**
	 * Select a diverse top-`topK` from the fused candidate set.
	 *
	 * Diversity is measured on memory CONTENT using the same helper the linear path uses
	 * (`mmrRerank` with `jaccardSimilarity`; compare `rerankRecallResults` in
	 * `beam/recall.ts`), so both recall paths share one notion of redundancy.
	 *
	 * This previously compared voice-MEMBERSHIP sets: two memories found by the same
	 * single voice scored Jaccard `1/(1+1-1) = 1.0`, above the `0.8` cutoff, so every
	 * candidate after the first was dropped as a duplicate. Whenever one voice dominated
	 * — the common case, e.g. a graph-only or vector-only match — an entire result set
	 * collapsed to a single row regardless of `topK` or of how different the memories
	 * actually were.
	 */
	diversityRerank(
		results: ReadonlyMap<string, PolyphonicResult>,
		topK: number,
		lengthNormalization: RecallLengthNormalization = "none",
		scoreFloor?: number,
		poolFloor?: number,
	): PolyphonicResult[] {
		const limit = Math.max(0, Math.trunc(topK));
		if (limit === 0) return [];
		// RRF score first, memory id as a stable tiebreak. `mmrRerank` re-sorts by score
		// with a stable sort, so this ordering survives it and selection is deterministic.
		const ranked = [...results.values()].sort(
			(a, b) => b.combinedScore - a.combinedScore || a.memoryId.localeCompare(b.memoryId),
		);
		// The voices can nominate far more candidates than `topK` (the graph voice walks
		// `ctx` edges depth-2 and is not intrinsically bounded), so bound the pool that
		// gets a content lookup and an MMR pass. Visibility is applied BEFORE the window is
		// cut: an invisible candidate (superseded/expired/out-of-scope) must never occupy a
		// window slot, or dead high-scorers evict live rows from selection entirely.
		const nowIso = new Date().toISOString();
		const visibleIds = visibleCandidateIds(
			this.db,
			ranked.map(candidate => candidate.memoryId),
			this.sessionId,
			nowIso,
		);
		const window = ranked
			.filter(candidate => visibleIds.has(candidate.memoryId))
			.slice(0, Math.max(limit * DIVERSITY_OVERFETCH, DIVERSITY_MIN_WINDOW));
		const contents = candidateContents(
			this.db,
			window.map(candidate => candidate.memoryId),
			this.sessionId,
			new Date().toISOString(),
		);
		const visible = window.filter(candidate => contents.has(candidate.memoryId));
		if (lengthNormalization !== "none" && visible.length > 0) {
			// Raw, un-clipped content lengths -- `contents` never truncates -- so the discount
			// reflects what a candidate actually costs, not what the caller sees after
			// `hydrateResults` clips it to RECALL_CONTENT_PREVIEW_CHARS.
			const meanLength =
				visible.reduce((sum, candidate) => sum + (contents.get(candidate.memoryId)?.length ?? 0), 0) /
				visible.length;
			for (const candidate of visible) {
				const length = contents.get(candidate.memoryId)?.length ?? 0;
				candidate.combinedScore = normalizeRecallScore(
					candidate.combinedScore,
					length,
					lengthNormalization,
					meanLength,
				);
			}
		}
		const floor = typeof scoreFloor === "number" && Number.isFinite(scoreFloor) ? Math.max(0, scoreFloor) : 0;
		const toItem = (candidate: PolyphonicResult) => ({
			candidate,
			content: contents.get(candidate.memoryId) ?? "",
			score: candidate.combinedScore,
		});
		// `scoreFloor` (abstention) gates everything and is the ONLY knob allowed to change how
		// many rows come back.
		const admitted = floor > 0 ? visible.filter(candidate => candidate.combinedScore >= floor) : visible;
		const baseline = () => mmrRerank(admitted.map(toItem), MMR_LAMBDA, limit).map(item => item.candidate);
		const cleaning = typeof poolFloor === "number" && Number.isFinite(poolFloor) ? Math.max(0, poolFloor) : 0;
		if (cleaning === 0) return baseline();
		/**
		 * Pool cleaning (round-4 knob). MMR runs over the above-floor candidates ONLY, so a weak
		 * row can never be selected ahead of a kept one on diversity grounds — that crowding is
		 * exactly the effect under test. The baseline result COUNT is then restored by appending
		 * the best below-floor rows AFTER selection: filler, never crowders. Count invariance
		 * matters because a floor that shrank the result set could raise a metric by dropping
		 * weak rows (abstention) rather than by selecting better, making the two inseparable.
		 */
		const kept = admitted.filter(candidate => candidate.combinedScore >= cleaning);
		if (kept.length === 0) return baseline();
		const selected = mmrRerank(kept.map(toItem), MMR_LAMBDA, limit).map(item => item.candidate);
		const baselineCount = Math.min(limit, admitted.length);
		if (selected.length >= baselineCount) return selected;
		const chosen = new Set(selected.map(candidate => candidate.memoryId));
		const filler = admitted
			.filter(candidate => candidate.combinedScore < cleaning && !chosen.has(candidate.memoryId))
			.sort((a, b) => b.combinedScore - a.combinedScore || a.memoryId.localeCompare(b.memoryId))
			.slice(0, baselineCount - selected.length);
		return [...selected, ...filler];
	}
	getStats(): Record<string, JsonValue> {
		let embeddedRows = 0;
		try {
			const row = this.db.query("SELECT COUNT(*) AS count FROM memory_embeddings").get() as {
				count: number;
			};
			embeddedRows = row.count;
		} catch {
			embeddedRows = 0;
		}
		return {
			voice_weights: {
				vector: this.voiceWeights.vector,
				graph: this.voiceWeights.graph,
				fact: this.voiceWeights.fact,
				temporal: this.voiceWeights.temporal,
			},
			vector_stats: { embedded_rows: embeddedRows },
			graph_stats: this.graph.getStats() as unknown as Record<string, JsonValue>,
			consolidation_stats: this.consolidator.getStats() as unknown as Record<string, JsonValue>,
			subject_dictionary_size: this.subjectDictionary().length,
			fact_object_error: this.#factObjectError,
		};
	}
	close(): void {
		if (this.ownsConnection) closeQuietly(this.db);
	}

	/**
	 * Hydrate selected candidates into full rows, clipping content the same way the linear
	 * path does.
	 *
	 * The clip is NOT cosmetic. Without it an 8-row selection on a real bank totalled 85,643
	 * characters, and the host's `truncateApproxTokens` is a blunt tail-chop over the whole
	 * rendered block with no row awareness — so only about ONE of the eight selected memories
	 * survived, cut mid-sentence, and everything the fusion and MMR diversity work chose was
	 * silently discarded. The linear path avoids this by clipping each row to
	 * {@link RECALL_CONTENT_PREVIEW_CHARS} in `scoreCandidate`; matching it keeps every
	 * selected row proportionate so the whole topK actually reaches the model. `truncated` /
	 * `full_length` are populated so the documented `memory://<id>` full-fetch still works.
	 */
	private hydrateResults(results: readonly PolyphonicResult[]): PolyphonicMemoryResult[] {
		const hydrated: PolyphonicMemoryResult[] = [];
		for (const result of results) {
			const row = this.lookupMemory(result.memoryId);
			if (row === null) continue;
			const rowMetadata = parseMetadata(row.metadata_json);
			const voiceScores = sortedVoiceScores(result.voiceScores);
			const clipped = clipRecallContent(row.content, RECALL_CONTENT_PREVIEW_CHARS);
			hydrated.push({
				...row,
				content: clipped.content,
				truncated: clipped.truncated,
				full_length: clipped.fullLength,
				metadata: { ...rowMetadata, polyphonic: result.metadata },
				recall_count: row.recall_count ?? undefined,
				score: result.combinedScore,
				combined_score: result.combinedScore,
				voice_scores: voiceScores,
				tier: row.tier_name,
				tier_label: row.tier_name,
			});
		}
		return hydrated;
	}

	private lookupMemory(memoryId: string): MemoryHydrationRow | null {
		const now = new Date().toISOString();
		const working = this.db
			.query(`
				SELECT id, content, source, timestamp, session_id, importance, metadata_json, veracity,
					memory_type, recall_count, last_recalled, valid_until, superseded_by, scope,
					author_id, author_type, channel_id, trust_tier, created_at, 'working' AS tier_name
				FROM working_memory
				WHERE id = ?
					AND superseded_by IS NULL
					AND (valid_until IS NULL OR valid_until > ?)
					AND (session_id = ? OR scope = 'global')
			`)
			.get(memoryId, now, this.sessionId) as MemoryHydrationRow | null;
		if (working !== null) return working;
		return this.db
			.query(`
				SELECT id, content, source, timestamp, session_id, importance, metadata_json, veracity,
					memory_type, recall_count, last_recalled, valid_until, superseded_by, scope,
					author_id, author_type, channel_id, trust_tier, created_at, rowid, summary_of,
					tier, 'episodic' AS tier_name
				FROM episodic_memory
				WHERE id = ?
					AND superseded_by IS NULL
					AND (valid_until IS NULL OR valid_until > ?)
					AND (session_id = ? OR scope = 'global')
			`)
			.get(memoryId, now, this.sessionId) as MemoryHydrationRow | null;
	}
}

function sortedVoiceScores(scores: Partial<Record<PolyphonicVoice, number>>): Partial<Record<PolyphonicVoice, number>> {
	const out: Partial<Record<PolyphonicVoice, number>> = {};
	for (const voice of POLYPHONIC_VOICES) {
		const score = scores[voice];
		if (score !== undefined && Number.isFinite(score)) out[voice] = score;
	}
	return out;
}

export function getPolyphonicEngine(beam: BeamMemoryState): PolyphonicRecallEngine {
	const cached = beam.caches.polyphonicEngine;
	if (cached instanceof PolyphonicRecallEngine) return cached;
	const engine = new PolyphonicRecallEngine({
		db: beam.db,
		dbPath: beam.dbPath,
		sessionId: beam.sessionId,
		channelId: beam.channelId,
	});
	beam.caches.polyphonicEngine = engine;
	return engine;
}
export function polyphonicRecall(
	beam: BeamMemoryState,
	query: string,
	topK = 10,
	options: PolyphonicRecallOptions = {},
): PolyphonicMemoryResult[] {
	return getPolyphonicEngine(beam).recall(query, options.queryEmbedding ?? null, topK, {
		lengthNormalization: options.lengthNormalization,
		scoreFloor: options.scoreFloor,
		poolFloor: options.poolFloor,
	});
}
