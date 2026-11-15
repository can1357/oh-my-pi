/**
 * Time Traveling Stream Rules (TTSR) Manager
 *
 * Manages rules that get injected mid-stream when their condition pattern matches
 * the agent's output. When a match occurs, the stream is aborted, the rule is
 * injected as a system reminder, and the request is retried.
 *
 * Judged rules (`question`) never match mid-stream: the session asks the judge
 * model about each completed output ({@link TtsrManager.judgedCandidates}) and
 * delivers a yes as a non-interrupting warning.
 */
import * as path from "node:path";
import type { Judge, JudgeOptions, NoulQuestion } from "@oh-my-pi/pi-ai";
import { AstMatchStrictness, astMatch, countTokens, Encoding } from "@oh-my-pi/pi-natives";
import { logger } from "@oh-my-pi/pi-utils";
import { BUILTIN_DEFAULTS_PROVIDER_ID, compileRuleCondition, type Rule } from "../capability/rule";
import { ensureGrammar } from "../utils/grammars";
import {
	evaluateRegexConditionsSandbox,
	type SandboxVerdict,
	TTSR_REGEX_SANDBOX_TIMEOUT_MS,
	TTSR_REGEX_SLOW_CONDITION_MS,
} from "./ttsr-regex-sandbox";
import type { TtsrSettings } from "./ttsr-settings";

export type TtsrMatchSource = "text" | "thinking" | "tool";

/** Context about the stream content currently being checked against TTSR rules. */
export interface TtsrMatchContext {
	source: TtsrMatchSource;
	/** Tool name for tool argument deltas, e.g. "edit" or "write". */
	toolName?: string;
	/** Candidate file paths associated with the current stream chunk. */
	filePaths?: string[];
	/** Stable key to isolate buffering (for example a tool call ID). */
	streamKey?: string;
}

/** Options for {@link TtsrManager.checkDelta} and {@link TtsrManager.checkSnapshot}. */
export interface TtsrCheckOptions {
	/**
	 * Whether the stream is complete. A non-final check may defer conditions that can match across
	 * lines until the buffer has grown enough; a final check evaluates every condition against the
	 * whole buffer. Defaults: `false` for `checkDelta`, `true` for `checkSnapshot`.
	 */
	final?: boolean;
}

/** One completed assistant output (reply, reasoning, or one file of a tool call) as rules see it. */
export interface TtsrOutput {
	content: string;
	context: TtsrMatchContext;
	/** How warnings name the output, e.g. "reply" or "`edit` call on `src/a.ts`". */
	subject: string;
}

/** A judged rule eligible for one output, with its question. */
export interface JudgedCandidate {
	rule: Rule;
	question: string;
}

/** Yes-probability at or above which a judged rule counts as violated. */
export const JUDGED_RULE_THRESHOLD = 0.7;
/**
 * Jev tokens of output content sent per judgment. Jev rejects a judgment branch
 * past ~33k tokens (`max_tokens_exceeded`), and each branch also carries the
 * request template, the state keys, the subject and one question.
 */
export const JUDGED_CONTENT_MAX_TOKENS = 32_000;

/** Longest prefix of `text` within `maxTokens` Jev tokens, never ending on half a surrogate pair. */
function jevPrefix(text: string, maxTokens: number): string {
	if (countTokens(text, Encoding.Jev) <= maxTokens) return text;
	// Counts grow with length up to whole-word jitter, so bisect; `lo` always fits, `hi` never does.
	let lo = 0;
	let hi = text.length;
	while (hi - lo > 1) {
		const mid = (lo + hi) >>> 1;
		if (countTokens(text.slice(0, mid), Encoding.Jev) <= maxTokens) lo = mid;
		else hi = mid;
	}
	const last = text.charCodeAt(lo - 1);
	return text.slice(0, last >= 0xd800 && last <= 0xdbff ? lo - 1 : lo);
}

/**
 * Ask every candidate's question about `output` in one request — Jev bills the
 * shared state once — and return the rules judged violated. Judge failures
 * propagate to the caller.
 */
export async function judgeRules(
	judge: Judge,
	output: TtsrOutput,
	candidates: readonly JudgedCandidate[],
	options?: JudgeOptions,
): Promise<Rule[]> {
	const questions: Record<string, NoulQuestion> = {};
	for (const [index, candidate] of candidates.entries()) {
		questions[`q${index}`] = { type: "noul", instructions: candidate.question };
	}
	const { answers } = await judge.judge(
		{ state: { output: output.subject, content: jevPrefix(output.content, JUDGED_CONTENT_MAX_TOKENS) }, questions },
		options,
	);
	return candidates
		.filter((_, index) => answers[`q${index}`].noul >= JUDGED_RULE_THRESHOLD)
		.map(candidate => candidate.rule);
}

interface ToolScope {
	toolName?: string;
	pathGlob?: Bun.Glob;
	pathPattern?: string;
}

interface TtsrScope {
	allowText: boolean;
	allowThinking: boolean;
	allowAnyTool: boolean;
	toolScopes: ToolScope[];
}

interface TtsrEntry {
	rule: Rule;
	conditions: RegExp[];
	/** Incremental-matching traits of `conditions`, index for index. */
	conditionTraits: ConditionTraits[];
	/** ast-grep pattern strings; matched only against edit/write tool snapshots. */
	astConditions: string[];
	/** Judge question; set → conditions only prefilter completed output, never stream matches. */
	question?: string;
	scope: TtsrScope;
	globalPathGlobs?: Bun.Glob[];
}

/** Tracks when a rule was last injected (for repeat gating). */
interface InjectionRecord {
	/** Message count (turn index) when the rule was last injected. */
	lastInjectedAt: number;
}

const DEFAULT_SETTINGS: TtsrSettings = {
	enabled: true,
	judge: "auto",
	contextMode: "discard",
	interruptMode: "always",
	repeatMode: "once",
	repeatGap: 10,
	builtinRules: true,
	disabledRules: [],
};

/**
 * Fixed TTSR settings (omitted fields take the defaults), or a getter the manager reads on every
 * check so live setting changes apply immediately.
 */
export type TtsrSettingsSource = Partial<TtsrSettings> | (() => TtsrSettings);

/** Internal knobs; tests shorten the sandbox deadline. */
export interface TtsrManagerOptions {
	/** Wall-clock budget of one regex-sandbox call. Default {@link TTSR_REGEX_SANDBOX_TIMEOUT_MS}. */
	sandboxTimeoutMs?: number;
}

const DEFAULT_SCOPE: TtsrScope = {
	allowText: true,
	allowThinking: false,
	allowAnyTool: true,
	toolScopes: [],
};

/**
 * How a condition can be evaluated against a growing buffer without rescanning
 * all of it. Lines here end at `\n` only: `.` never matches it and `^`/`$` with
 * `m` treat it as a boundary, so a line followed by `\n` never changes again.
 */
interface ConditionTraits {
	/**
	 * Matching a suffix that starts at a line start finds exactly the whole-buffer
	 * matches that start in it: no sticky flag, lookbehind, or input-start `^`.
	 */
	sliceSafe: boolean;
	/** Slice-safe, and nothing in it can match `\n`, so no match leaves its line. */
	lineLocal: boolean;
	/** Appending text never removes a match: no `$`, `\b`, `\B`, or negative lookahead. */
	monotonic: boolean;
}

/** Traits for syntax the analysis does not model: whole-buffer scans only. */
const OPAQUE_CONDITION: ConditionTraits = { sliceSafe: false, lineLocal: false, monotonic: false };

/** Escape value: a class including `\n` (`\s`, `\W`, `\D`). */
const ESCAPE_ANY_LINE_BREAK = -1;
/** Escape value: never matches `\n` (`\S`, `\w`, `\d`, backreferences). */
const ESCAPE_NO_LINE_BREAK = -2;
/** Escape value: `\b` or `\B` outside a class. */
const ESCAPE_BOUNDARY = -3;

interface RegexEscape {
	/** Code unit the escape matches, or an `ESCAPE_*` kind. */
	value: number;
	/** Index just past the escape. */
	next: number;
}

function isDecimalDigit(code: number): boolean {
	return code >= 0x30 && code <= 0x39;
}

function readHexEscape(source: string, start: number, digits: number, literal: number): RegexEscape {
	const hex = source.slice(start, start + digits);
	return hex.length === digits && /^[0-9a-f]+$/i.test(hex)
		? { value: Number.parseInt(hex, 16), next: start + digits }
		: { value: literal, next: start };
}

/** `\` followed by a digit at `start`: a backreference, or (Annex B) a legacy octal or literal digit. */
function readDecimalEscape(source: string, start: number, groupCount: number, inClass: boolean): RegexEscape {
	if (!inClass && source[start] !== "0") {
		let end = start;
		while (end < source.length && isDecimalDigit(source.charCodeAt(end))) end++;
		if (Number(source.slice(start, end)) <= groupCount) return { value: ESCAPE_NO_LINE_BREAK, next: end };
	}
	let value = 0;
	let next = start;
	while (next - start < 3 && next < source.length) {
		const digit = source.charCodeAt(next) - 0x30;
		if (digit < 0 || digit > 7 || value * 8 + digit > 0o377) break;
		value = value * 8 + digit;
		next++;
	}
	return next === start ? { value: source.charCodeAt(start), next: start + 1 } : { value, next };
}

/** Reads the escape whose backslash precedes `start` (non-unicode syntax). */
function readEscape(source: string, start: number, groupCount: number, inClass: boolean): RegexEscape {
	// A trailing backslash is invalid syntax; treat it as the most permissive escape.
	if (start >= source.length) return { value: ESCAPE_ANY_LINE_BREAK, next: start };
	switch (source[start]) {
		case "s":
		case "W":
		case "D":
			return { value: ESCAPE_ANY_LINE_BREAK, next: start + 1 };
		case "S":
		case "w":
		case "d":
			return { value: ESCAPE_NO_LINE_BREAK, next: start + 1 };
		case "b":
			return { value: inClass ? 0x08 : ESCAPE_BOUNDARY, next: start + 1 };
		case "B":
			return { value: inClass ? 0x42 : ESCAPE_BOUNDARY, next: start + 1 };
		case "t":
			return { value: 0x09, next: start + 1 };
		case "n":
			return { value: 0x0a, next: start + 1 };
		case "v":
			return { value: 0x0b, next: start + 1 };
		case "f":
			return { value: 0x0c, next: start + 1 };
		case "r":
			return { value: 0x0d, next: start + 1 };
		case "x":
			return readHexEscape(source, start + 1, 2, 0x78);
		case "u":
			return readHexEscape(source, start + 1, 4, 0x75);
		case "c": {
			const code = source.charCodeAt(start + 1);
			const letter = (code >= 0x41 && code <= 0x5a) || (code >= 0x61 && code <= 0x7a);
			const classControl = inClass && (isDecimalDigit(code) || code === 0x5f);
			// Without a control letter `\c` is a literal backslash; the `c` is read next.
			return letter || classControl ? { value: code % 32, next: start + 2 } : { value: 0x5c, next: start };
		}
		case "k": {
			const close = !inClass && source[start + 1] === "<" ? source.indexOf(">", start + 2) : -1;
			return close === -1 ? { value: 0x6b, next: start + 1 } : { value: ESCAPE_NO_LINE_BREAK, next: close + 1 };
		}
	}
	const code = source.charCodeAt(start);
	return isDecimalDigit(code)
		? readDecimalEscape(source, start, groupCount, inClass)
		: { value: code, next: start + 1 };
}

/** Parses a character class body starting after `[`; reports whether the class matches `\n`. */
function readClass(source: string, start: number): { matchesLineBreak: boolean; next: number } {
	let index = start;
	const negated = source[index] === "^";
	if (negated) index++;
	let includesLineBreak = false;
	while (index < source.length && source[index] !== "]") {
		const low =
			source[index] === "\\"
				? readEscape(source, index + 1, 0, true)
				: { value: source.charCodeAt(index), next: index + 1 };
		index = low.next;
		if (source[index] === "-" && index + 1 < source.length && source[index + 1] !== "]") {
			index++;
			const high =
				source[index] === "\\"
					? readEscape(source, index + 1, 0, true)
					: { value: source.charCodeAt(index), next: index + 1 };
			index = high.next;
			if (low.value >= 0 && high.value >= 0) {
				if (low.value <= 0x0a && high.value >= 0x0a) includesLineBreak = true;
				continue;
			}
			// A class escape at either end makes the `-` literal.
			if (high.value === ESCAPE_ANY_LINE_BREAK || high.value === 0x0a) includesLineBreak = true;
		}
		if (low.value === ESCAPE_ANY_LINE_BREAK || low.value === 0x0a) includesLineBreak = true;
	}
	return { matchesLineBreak: negated !== includesLineBreak, next: index + 1 };
}

/** Capturing groups in `source`; decides whether `\N` is a backreference or an octal escape. */
function countCapturingGroups(source: string): number {
	let count = 0;
	let inClass = false;
	for (let index = 0; index < source.length; index++) {
		const char = source[index];
		if (char === "\\") {
			index++;
		} else if (inClass) {
			if (char === "]") inClass = false;
		} else if (char === "[") {
			inClass = true;
		} else if (char === "(") {
			const named = source[index + 2] === "<" && source[index + 3] !== "=" && source[index + 3] !== "!";
			if (source[index + 1] !== "?" || named) count++;
		}
	}
	return count;
}

/** Classifies a compiled condition for incremental matching; unmodeled syntax stays opaque. */
function analyzeCondition(condition: RegExp): ConditionTraits {
	if (condition.unicode || condition.unicodeSets) return OPAQUE_CONDITION;
	const { source } = condition;
	const groupCount = countCapturingGroups(source);
	let sliceSafe = !condition.sticky;
	let crossesLines = false;
	let monotonic = true;
	let index = 0;
	while (index < source.length) {
		const char = source[index];
		if (char === "\\") {
			const escape = readEscape(source, index + 1, groupCount, false);
			if (escape.value === ESCAPE_ANY_LINE_BREAK || escape.value === 0x0a) crossesLines = true;
			else if (escape.value === ESCAPE_BOUNDARY) monotonic = false;
			index = escape.next;
			continue;
		}
		if (char === "[") {
			const charClass = readClass(source, index + 1);
			if (charClass.matchesLineBreak) crossesLines = true;
			index = charClass.next;
			continue;
		}
		if (char === "(" && source[index + 1] === "?") {
			const kind = source[index + 2];
			const lookbehind = kind === "<" && (source[index + 3] === "=" || source[index + 3] === "!");
			if (lookbehind) sliceSafe = false;
			else if (kind === "!") monotonic = false;
			else if (kind !== ":" && kind !== "=" && kind !== "<") return OPAQUE_CONDITION;
			index += lookbehind ? 4 : 3;
			continue;
		}
		if (char === "." && condition.dotAll) crossesLines = true;
		else if (char === "^" && !condition.multiline) sliceSafe = false;
		else if (char === "$") monotonic = false;
		else if (char === "\n") crossesLines = true;
		index++;
	}
	return { sliceSafe, lineLocal: sliceSafe && !crossesLines, monotonic };
}

/** One open group while scanning a pattern for backtracking. */
interface BacktrackFrame {
	/** The group can match one text in more than one way: a variable-length quantifier or an alternation. */
	ambiguous: boolean;
	/** Lookahead: its body runs atomically and never makes the enclosing group ambiguous. */
	look: boolean;
}

/**
 * True when `condition` can backtrack exponentially: it has a backreference, a
 * lookbehind, or a group that can match one text in more than one way repeated
 * by a quantifier (`(?:\1[ \t]+[^\n]*\n)*`, `(?:a{1,2})+`). Syntax the scan
 * does not model fails closed.
 */
export function isBacktrackProne(condition: RegExp): boolean {
	return condition.unicodeSets || new BacktrackScan(condition.source).isProne();
}

class BacktrackScan {
	readonly #source: string;
	readonly #open: BacktrackFrame[] = [{ ambiguous: false, look: false }];
	#index = 0;

	constructor(source: string) {
		this.#source = source;
	}

	isProne(): boolean {
		while (this.#index < this.#source.length) {
			if (this.#step()) return true;
		}
		return this.#open.length !== 1;
	}

	get #enclosing(): BacktrackFrame {
		return this.#open[this.#open.length - 1];
	}

	/** Consume one pattern element; true once the pattern is known prone. */
	#step(): boolean {
		switch (this.#source[this.#index]) {
			case "\\":
				return this.#escape();
			case "(":
				return this.#openGroup();
			case ")":
				return this.#closeGroup();
			case "|":
				this.#enclosing.ambiguous = true;
				this.#index++;
				return false;
			case "[":
				this.#index = readClass(this.#source, this.#index + 1).next;
				return this.#quantify(undefined);
			default:
				this.#index++;
				return this.#quantify(undefined);
		}
	}

	#escape(): boolean {
		const next = this.#source[this.#index + 1];
		if (
			next !== undefined &&
			((next >= "1" && next <= "9") || (next === "k" && this.#source[this.#index + 2] === "<"))
		) {
			return true;
		}
		this.#index += 2;
		return this.#quantify(undefined);
	}

	#openGroup(): boolean {
		const group = backtrackGroupOpener(this.#source, this.#index);
		if (group === undefined) return true;
		this.#open.push({ ambiguous: false, look: group.look });
		this.#index = group.next;
		return false;
	}

	#closeGroup(): boolean {
		const closed = this.#open.length > 1 ? this.#open.pop() : undefined;
		this.#index++;
		return closed === undefined ? true : this.#quantify(closed);
	}

	/** Apply a quantifier that may follow the atom just read (`closed` when the atom was a group). */
	#quantify(closed: BacktrackFrame | undefined): boolean {
		const quantifier = readQuantifier(this.#source, this.#index);
		if (quantifier !== undefined) this.#index += quantifier.length;
		const ambiguous = closed?.ambiguous === true && !closed.look;
		if (ambiguous && quantifier !== undefined && quantifier.max >= 2) return true;
		if (ambiguous || (quantifier !== undefined && quantifier.min !== quantifier.max)) {
			this.#enclosing.ambiguous = true;
		}
		return false;
	}
}

/** Index past a group opener and whether it is a lookahead; undefined for a lookbehind or syntax the scan does not model. */
function backtrackGroupOpener(source: string, start: number): { next: number; look: boolean } | undefined {
	if (source[start + 1] !== "?") return { next: start + 1, look: false };
	const kind = source[start + 2];
	if (kind === ":") return { next: start + 3, look: false };
	if (kind === "=" || kind === "!") return { next: start + 3, look: true };
	if (kind !== "<" || source[start + 3] === "=" || source[start + 3] === "!") return undefined;
	const close = source.indexOf(">", start + 3);
	return close === -1 ? undefined : { next: close + 1, look: false };
}

const BRACE_QUANTIFIER = /\{(\d+)(,(\d*))?\}/y;

/** The quantifier at `index`: its source length and repeat bounds (`max` is Infinity when unbounded). */
function readQuantifier(source: string, index: number): { length: number; min: number; max: number } | undefined {
	const lazy = (end: number) => (source[end] === "?" ? 1 : 0);
	switch (source[index]) {
		case "*":
			return { length: 1 + lazy(index + 1), min: 0, max: Infinity };
		case "+":
			return { length: 1 + lazy(index + 1), min: 1, max: Infinity };
		case "?":
			return { length: 1 + lazy(index + 1), min: 0, max: 1 };
		case "{": {
			BRACE_QUANTIFIER.lastIndex = index;
			const match = BRACE_QUANTIFIER.exec(source);
			if (!match) return undefined;
			const min = Number(match[1]);
			const max = match[2] === undefined ? min : match[3] === "" ? Infinity : Number(match[3]);
			return { length: match[0].length + lazy(index + match[0].length), min, max };
		}
	}
	return undefined;
}

/** A condition's progress through one stream buffer. */
interface ConditionScan {
	/** Buffer length at the last line-region scan, or -1 before the first. */
	scannedTo: number;
	/** Start of the line holding `scannedTo`; the next region scan starts there. */
	lineStart: number;
	/**
	 * Result at `scannedTo`, or `false` while a region rescan is deferred; `false` is exact only for
	 * line-local conditions scanned at the current length or after a full scan at that length.
	 */
	matched: boolean;
	/** A match appending can no longer remove. */
	settled: boolean;
	/** Buffer length at the last whole-buffer scan of the current text, or -1. */
	fullScannedTo: number;
	/** Buffer length at the last whole-buffer scan, kept across rewrites to pace rescans; -1 before the first. */
	paceFrom: number;
}

/**
 * A cross-line condition rescans the whole buffer once it has grown by this fraction since its
 * last full scan; any condition rescans a long region (an unterminated line) at the same pace.
 */
const FULL_RESCAN_GROWTH = 0.25;
/** Buffers and regions up to this length are cheap enough to rescan whole on every check. */
const FULL_RESCAN_ALWAYS_BELOW = 4096;
/** Characters of surrounding context and matched text retained in an interrupt excerpt. */
const EXCERPT_CONTEXT = 60;
const EXCERPT_MATCH_MAX = 120;

/** Called when one in-process regex call exceeds {@link TTSR_REGEX_SLOW_CONDITION_MS}. */
type SlowConditionListener = (condition: RegExp, elapsedMs: number, bufferChars: number) => void;

/** One bounded line of text around a regex match, with whitespace runs collapsed. */
function matchExcerpt(text: string, index: number, length: number): string {
	const matchEnd = index + Math.min(length, EXCERPT_MATCH_MAX);
	const start = Math.max(0, index - EXCERPT_CONTEXT);
	const end = Math.min(text.length, matchEnd + EXCERPT_CONTEXT);
	const body = text.slice(start, end).replace(/\s+/g, " ").trim();
	return `${start > 0 ? "…" : ""}${body}${end < text.length ? "…" : ""}`;
}

/** First match of `condition` in `text`, or undefined. */
function firstMatch(condition: RegExp, text: string): { index: number; length: number } | undefined {
	condition.lastIndex = 0;
	const match = condition.exec(text);
	return match ? { index: match.index, length: match[0].length } : undefined;
}

/** `condition.test(text)`, reporting a call slow enough to warrant the sandbox. */
function testTimed(condition: RegExp, text: string, onSlow: SlowConditionListener | undefined): boolean {
	condition.lastIndex = 0;
	const started = performance.now();
	const hit = condition.test(text);
	const elapsed = performance.now() - started;
	if (elapsed >= TTSR_REGEX_SLOW_CONDITION_MS) onSlow?.(condition, elapsed, text.length);
	return hit;
}

/** A condition's identity across recompiles: isolation decisions follow it through rule rebuilds. */
function conditionKey(condition: RegExp): string {
	return `${condition.flags}/${condition.source}`;
}

/** Verdict for a sandboxed condition whose child could not report one. */
const NO_SANDBOX_MATCH: SandboxVerdict = { matched: false, index: -1, length: 0 };

/**
 * One stream's accumulated text and how far each condition has scanned it.
 * Line-local conditions scan only from the start of the line holding the
 * previous end; cross-line conditions scan that region too (a match there is a
 * whole-buffer match) and rescan the whole buffer geometrically, or on a final
 * check. A long region — a line that never ends, like raw tool-argument JSON
 * whose newlines are escaped — is rescanned geometrically too, so a non-final
 * check may report its matches late. Deltas stay in `#parts` until a scan
 * needs the text.
 */
class StreamBuffer {
	readonly #scans = new Map<RegExp, ConditionScan>();
	readonly excerpts = new Map<string, string | undefined>();
	#parts: string[] = [];
	#joined = "";
	#length = 0;
	/** Start of the last, unterminated line. */
	#lineStart = 0;
	/** Text of the last, unterminated line. */
	#tail = "";
	/** Length before the latest update; conditions scanned at this length next scan `#region`. */
	#previousLength = 0;
	/** Start of the line that held the end before the latest update. */
	#regionStart = 0;
	/** Text from `#regionStart` to the end. */
	#region = "";
	readonly #onSlow: SlowConditionListener | undefined;
	/** Sandbox verdicts; each holds only while the buffer keeps the length it was computed at. */
	readonly #verdicts = new Map<RegExp, { length: number; verdict: SandboxVerdict }>();

	constructor(onSlow?: SlowConditionListener) {
		this.#onSlow = onSlow;
	}

	append(delta: string): void {
		if (delta.length > 0) this.#parts.push(delta);
		this.#advance(delta);
	}

	/** Replace the text; a snapshot that extends the current text keeps scan progress. */
	replace(snapshot: string): void {
		const current = this.#text();
		if (snapshot === current || snapshot.startsWith(current)) {
			this.#advance(snapshot.slice(current.length));
			this.#joined = snapshot;
			return;
		}
		this.excerpts.clear();
		this.#verdicts.clear();
		for (const scan of this.#scans.values()) {
			scan.scannedTo = -1;
			scan.lineStart = 0;
			scan.matched = false;
			scan.settled = false;
			scan.fullScannedTo = -1;
		}
		this.#length = 0;
		this.#lineStart = 0;
		this.#tail = "";
		this.#advance(snapshot);
		this.#joined = snapshot;
	}

	/** Whether `condition` matches the text; a non-final check may defer whole-buffer rescans. */
	matches(condition: RegExp, traits: ConditionTraits, final: boolean): boolean {
		let scan = this.#scans.get(condition);
		if (!scan) {
			scan = { scannedTo: -1, lineStart: 0, matched: false, settled: false, fullScannedTo: -1, paceFrom: -1 };
			this.#scans.set(condition, scan);
		}
		if (scan.settled) return true;
		const length = this.#length;
		if (scan.scannedTo !== length) {
			if (final || this.#regionRescanDue(scan)) this.#scanRegion(condition, traits, scan);
			else scan.matched = false;
		}
		if (scan.matched || traits.lineLocal || scan.fullScannedTo === length) return scan.matched;
		const rescanDue =
			final ||
			scan.paceFrom < 0 ||
			length <= FULL_RESCAN_ALWAYS_BELOW ||
			length - scan.paceFrom >= scan.paceFrom * FULL_RESCAN_GROWTH;
		if (!rescanDue) return false;
		scan.matched = testTimed(condition, this.#text(), this.#onSlow);
		scan.settled = scan.matched && traits.monotonic;
		scan.fullScannedTo = length;
		scan.paceFrom = length;
		return scan.matched;
	}

	/** The buffered text. */
	snapshot(): string {
		return this.#text();
	}

	/** The sandbox verdict for `condition` on the current text, if one was computed. */
	verdictFor(condition: RegExp): SandboxVerdict | undefined {
		const entry = this.#verdicts.get(condition);
		return entry !== undefined && entry.length === this.#length ? entry.verdict : undefined;
	}

	settle(condition: RegExp, verdict: SandboxVerdict): void {
		this.#verdicts.set(condition, { length: this.#length, verdict });
	}

	/**
	 * Bounded one-line excerpt around the first matching condition. Conditions for
	 * which `inProcess` is false are never run here; their settled sandbox verdict is used.
	 */
	excerpt(
		ruleName: string,
		conditions: readonly RegExp[],
		inProcess: (condition: RegExp) => boolean,
	): string | undefined {
		if (this.excerpts.has(ruleName)) return this.excerpts.get(ruleName);
		const text = this.#text();
		let excerpt: string | undefined;
		for (const condition of conditions) {
			const found = inProcess(condition) ? firstMatch(condition, text) : this.#settledMatch(condition);
			if (found !== undefined && found.length > 0) {
				excerpt = matchExcerpt(text, found.index, found.length);
				break;
			}
		}
		this.excerpts.set(ruleName, excerpt);
		return excerpt;
	}

	#settledMatch(condition: RegExp): { index: number; length: number } | undefined {
		const verdict = this.verdictFor(condition);
		return verdict?.matched ? { index: verdict.index, length: verdict.length } : undefined;
	}

	/** Whether a non-final check should rescan the region from the condition's last line start. */
	#regionRescanDue(scan: ConditionScan): boolean {
		if (scan.scannedTo < 0) return true;
		const region = this.#length - scan.lineStart;
		const scanned = scan.scannedTo - scan.lineStart;
		return region <= FULL_RESCAN_ALWAYS_BELOW || region - scanned >= scanned * FULL_RESCAN_GROWTH;
	}

	/** Scan from the start of the line holding the condition's last scanned end. */
	#scanRegion(condition: RegExp, traits: ConditionTraits, scan: ConditionScan): void {
		scan.matched = false;
		if (traits.sliceSafe) {
			const inSync = scan.scannedTo === this.#previousLength;
			const start = inSync ? this.#regionStart : scan.lineStart;
			const region = inSync ? this.#region : this.#text().slice(start);
			if (testTimed(condition, region, this.#onSlow)) {
				scan.matched = true;
				// A line-local match starting on a line already followed by `\n` can never change.
				scan.settled = traits.monotonic || (traits.lineLocal && region.search(condition) < this.#lineStart - start);
			}
			// From offset 0 the region is the whole buffer: this was the full scan too.
			if (start === 0) {
				scan.fullScannedTo = this.#length;
				scan.paceFrom = this.#length;
			}
		}
		scan.scannedTo = this.#length;
		scan.lineStart = this.#lineStart;
	}

	#advance(delta: string): void {
		this.#previousLength = this.#length;
		this.#regionStart = this.#lineStart;
		this.#region = this.#tail + delta;
		const lastBreak = delta.lastIndexOf("\n");
		if (lastBreak === -1) {
			this.#tail = this.#region;
		} else {
			this.#lineStart = this.#length + lastBreak + 1;
			this.#tail = delta.slice(lastBreak + 1);
		}
		this.#length += delta.length;
	}

	#text(): string {
		if (this.#parts.length > 0) {
			this.#joined += this.#parts.join("");
			this.#parts.length = 0;
		}
		return this.#joined;
	}
}

export class TtsrManager {
	readonly #settingsSource: () => TtsrSettings;
	readonly #rules = new Map<string, TtsrEntry>();
	readonly #injectionRecords = new Map<string, InjectionRecord>();
	readonly #buffers = new Map<string, StreamBuffer>();
	/** Last snapshot evaluated for AST conditions, keyed by stream key, to dedupe matcher runs. */
	readonly #lastAstSnapshots = new Map<string, string>();
	/** Non-builtin conditions, mapped to their rule name for diagnostics. */
	readonly #userConditions = new Map<RegExp, string>();
	/** Conditions evaluated only by the killable regex sandbox, when a stream block ends. */
	readonly #sandboxed = new Set<RegExp>();
	/** Conditions that outlived the sandbox deadline; never evaluated again this session. */
	readonly #quarantined = new Set<RegExp>();
	readonly #sandboxTimeoutMs: number;
	readonly #onSlow: SlowConditionListener = (condition, elapsedMs, bufferChars) =>
		this.#demote(condition, elapsedMs, bufferChars);
	#messageCount = 0;
	#canMatchText = false;
	#canMatchThinking = false;
	#hasJudgedRules = false;

	constructor(settings?: TtsrSettingsSource, options?: TtsrManagerOptions) {
		if (typeof settings === "function") {
			this.#settingsSource = settings;
		} else {
			const snapshot: TtsrSettings = { ...DEFAULT_SETTINGS, ...settings };
			this.#settingsSource = () => snapshot;
		}
		this.#sandboxTimeoutMs = options?.sandboxTimeoutMs ?? TTSR_REGEX_SANDBOX_TIMEOUT_MS;
	}

	/** Current settings; resolved per call so a live source is never cached. */
	get #settings(): TtsrSettings {
		return this.#settingsSource();
	}

	/** Check if a rule can be triggered: its own `repeatMode` frontmatter wins over the global setting. */
	#canTrigger(rule: Rule): boolean {
		const record = this.#injectionRecords.get(rule.name);
		if (!record) {
			return true;
		}

		const repeatMode = rule.repeatMode ?? this.#settings.repeatMode;
		if (repeatMode === "once") {
			return false;
		}

		// `always` is the minimal gap: eligible again once a turn ends after the turn the reminder landed in.
		// Interrupt and deferred reminders land in the turn they spawn, so that turn cannot re-fire the rule
		// and feed itself another retry or continuation.
		const repeatGap = repeatMode === "always" ? 1 : this.#settings.repeatGap;
		return this.#messageCount - record.lastInjectedAt >= repeatGap;
	}

	#compileConditions(rule: Rule): RegExp[] {
		const compiled: RegExp[] = [];
		for (const pattern of rule.condition ?? []) {
			try {
				compiled.push(compileRuleCondition(pattern));
			} catch (error) {
				logger.warn("TTSR condition has invalid regex pattern, skipping condition", {
					ruleName: rule.name,
					pattern,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}

		return compiled;
	}

	#compileGlobalPathGlobs(globs: Rule["globs"]): Bun.Glob[] | undefined {
		if (!globs || globs.length === 0) {
			return undefined;
		}

		const compiled = globs
			.map(glob => glob.trim())
			.filter(glob => glob.length > 0)
			.map(glob => new Bun.Glob(glob));
		return compiled.length > 0 ? compiled : undefined;
	}

	#parseToolScopeToken(token: string): ToolScope | undefined {
		const match = /^(?:(?<prefix>tool)(?::(?<tool>[a-z0-9_-]+))?|(?<bare>[a-z0-9_-]+))(?:\((?<path>[^)]+)\))?$/i.exec(
			token,
		);
		if (!match) {
			return undefined;
		}

		const groups = match.groups;
		const hasToolPrefix = groups?.prefix !== undefined;
		const toolName = (groups?.tool ?? (hasToolPrefix ? undefined : groups?.bare))?.trim().toLowerCase();
		const pathPattern = groups?.path?.trim();

		if (!pathPattern) {
			return { toolName };
		}

		return {
			toolName,
			pathPattern,
			pathGlob: new Bun.Glob(pathPattern),
		};
	}

	#buildScope(rule: Rule): TtsrScope {
		if (!rule.scope || rule.scope.length === 0) {
			return {
				allowText: DEFAULT_SCOPE.allowText,
				allowThinking: DEFAULT_SCOPE.allowThinking,
				allowAnyTool: DEFAULT_SCOPE.allowAnyTool,
				toolScopes: [...DEFAULT_SCOPE.toolScopes],
			};
		}

		const scope: TtsrScope = {
			allowText: false,
			allowThinking: false,
			allowAnyTool: false,
			toolScopes: [],
		};

		for (const rawToken of rule.scope) {
			const token = rawToken.trim();
			const normalizedToken = token.toLowerCase();
			if (token.length === 0) {
				continue;
			}

			if (normalizedToken === "text") {
				scope.allowText = true;
				continue;
			}

			if (normalizedToken === "thinking") {
				scope.allowThinking = true;
				continue;
			}

			if (normalizedToken === "tool" || normalizedToken === "toolcall") {
				scope.allowAnyTool = true;
				continue;
			}

			const toolScope = this.#parseToolScopeToken(token);
			if (!toolScope) {
				logger.warn("TTSR scope token is invalid, skipping token", {
					ruleName: rule.name,
					token: rawToken,
				});
				continue;
			}

			if (!toolScope.toolName && !toolScope.pathGlob) {
				scope.allowAnyTool = true;
				continue;
			}

			scope.toolScopes.push(toolScope);
		}

		return scope;
	}

	#hasReachableScope(scope: TtsrScope): boolean {
		return scope.allowText || scope.allowThinking || scope.allowAnyTool || scope.toolScopes.length > 0;
	}

	#bufferKey(context: TtsrMatchContext): string {
		if (context.streamKey && context.streamKey.trim().length > 0) {
			return context.streamKey;
		}
		if (context.source !== "tool") {
			return context.source;
		}
		const toolName = context.toolName?.trim().toLowerCase();
		return toolName ? `tool:${toolName}` : "tool";
	}

	#normalizePath(pathValue: string): string {
		return pathValue.replaceAll("\\", "/");
	}

	#matchesGlob(glob: Bun.Glob, filePaths: string[] | undefined): boolean {
		if (!filePaths || filePaths.length === 0) {
			return false;
		}
		for (const filePath of filePaths) {
			const normalized = this.#normalizePath(filePath);
			if (glob.match(normalized)) {
				return true;
			}
			const slashIndex = normalized.lastIndexOf("/");
			const basename = slashIndex === -1 ? normalized : normalized.slice(slashIndex + 1);
			if (basename !== normalized && glob.match(basename)) {
				return true;
			}
		}

		return false;
	}

	#matchesGlobalPaths(entry: TtsrEntry, context: TtsrMatchContext): boolean {
		if (!entry.globalPathGlobs || entry.globalPathGlobs.length === 0) {
			return true;
		}

		for (const glob of entry.globalPathGlobs) {
			if (this.#matchesGlob(glob, context.filePaths)) {
				return true;
			}
		}

		return false;
	}

	#matchesScope(entry: TtsrEntry, context: TtsrMatchContext): boolean {
		if (context.source === "text") {
			return entry.scope.allowText;
		}

		if (context.source === "thinking") {
			return entry.scope.allowThinking;
		}

		if (entry.scope.allowAnyTool) {
			return true;
		}

		const toolName = context.toolName?.trim().toLowerCase();
		for (const toolScope of entry.scope.toolScopes) {
			if (toolScope.toolName && toolScope.toolName !== toolName) {
				continue;
			}
			if (toolScope.pathGlob && !this.#matchesGlob(toolScope.pathGlob, context.filePaths)) {
				continue;
			}
			return true;
		}

		return false;
	}

	/**
	 * Prefilter test of completed content. `verdicts` holds every condition this call routed away from the
	 * main thread, so a rule rebuild during an awaited prefilter cannot move one back in process.
	 */
	#matchesCondition(entry: TtsrEntry, content: string, verdicts: ReadonlyMap<RegExp, SandboxVerdict>): boolean {
		for (const condition of entry.conditions) {
			const verdict = verdicts.get(condition);
			if (verdict !== undefined) {
				if (verdict.matched) return true;
				continue;
			}
			if (testTimed(condition, content, this.#onSlow)) return true;
		}
		return false;
	}

	/** Route a non-builtin rule's backtrack-prone conditions to the sandbox; builtin conditions are tested linear and stay in process. */
	#classifyConditions(rule: Rule, conditions: readonly RegExp[]): void {
		if (rule._source?.provider === BUILTIN_DEFAULTS_PROVIDER_ID) return;
		const interrupting = (rule.interruptMode ?? this.#settings.interruptMode) !== "never";
		for (const condition of conditions) {
			this.#userConditions.set(condition, rule.name);
			if (!isBacktrackProne(condition)) continue;
			this.#sandboxed.add(condition);
			const message =
				"TTSR condition can backtrack exponentially: it runs in the regex sandbox when a stream block ends, not on every delta";
			const detail = { ruleName: rule.name, condition: condition.source };
			if (interrupting) logger.warn(message, detail);
			else logger.debug(message, detail);
		}
	}

	/** Move a user condition whose in-process scan was slow to the sandbox. The slow call itself was not bounded. */
	#demote(condition: RegExp, elapsedMs: number, bufferChars: number): void {
		const ruleName = this.#userConditions.get(condition);
		if (ruleName === undefined || this.#sandboxed.has(condition)) return;
		this.#sandboxed.add(condition);
		logger.warn("TTSR condition moved to the regex sandbox: one in-process scan was slow", {
			ruleName,
			condition: condition.source,
			elapsedMs: Math.round(elapsedMs),
			bufferChars,
		});
	}

	#quarantine(condition: RegExp, bufferChars: number): void {
		this.#quarantined.add(condition);
		logger.warn("TTSR condition quarantined: it did not finish within the regex sandbox deadline", {
			ruleName: this.#userConditions.get(condition),
			condition: condition.source,
			deadlineMs: this.#sandboxTimeoutMs,
			bufferChars,
			fix: "Rewrite the pattern so it cannot backtrack exponentially; `omp ttsr test` runs it against a sample.",
		});
	}

	/** Run `conditions` against `text` in the sandbox; only quarantined conditions come back without a verdict. */
	#evaluateInSandbox(text: string, conditions: readonly RegExp[]): Map<RegExp, SandboxVerdict> {
		const result = evaluateRegexConditionsSandbox(
			text,
			conditions.map(condition => ({ source: condition.source, flags: condition.flags })),
			this.#sandboxTimeoutMs,
		);
		for (const index of result.culprits) this.#quarantine(conditions[index], text.length);
		const verdicts = new Map<RegExp, SandboxVerdict>();
		for (const [index, verdict] of result.verdicts) verdicts.set(conditions[index], verdict);
		if (result.error !== undefined) {
			logger.warn("TTSR regex sandbox failed; its conditions count as no match for this check", {
				error: result.error,
			});
			for (const condition of conditions) {
				if (!verdicts.has(condition)) verdicts.set(condition, NO_SANDBOX_MATCH);
			}
		}
		return verdicts;
	}

	/** Evaluate, in one child call, every sandboxed condition of the eligible rules that has no verdict on `buffer` yet. */
	#settleSandboxed(buffer: StreamBuffer, context: TtsrMatchContext): void {
		const pending: RegExp[] = [];
		for (const entry of this.#rules.values()) {
			if (!this.#isEligible(entry, context)) continue;
			for (const condition of entry.conditions) {
				if (
					this.#sandboxed.has(condition) &&
					!this.#quarantined.has(condition) &&
					buffer.verdictFor(condition) === undefined
				) {
					pending.push(condition);
				}
			}
		}
		if (pending.length === 0) return;
		for (const [condition, verdict] of this.#evaluateInSandbox(buffer.snapshot(), pending)) {
			buffer.settle(condition, verdict);
		}
	}

	#conditionMatches(buffer: StreamBuffer, condition: RegExp, traits: ConditionTraits, final: boolean): boolean {
		if (this.#quarantined.has(condition)) return false;
		if (this.#sandboxed.has(condition)) return final && buffer.verdictFor(condition)?.matched === true;
		return buffer.matches(condition, traits, final);
	}

	/** A regex rule that may trigger on this stream now: not judged, repeat gate open, scope and paths match. */
	#isEligible(entry: TtsrEntry, context: TtsrMatchContext): boolean {
		return (
			!entry.question &&
			this.#canTrigger(entry.rule) &&
			this.#matchesScope(entry, context) &&
			this.#matchesGlobalPaths(entry, context)
		);
	}

	/** Add a TTSR rule to be monitored. */
	addRule(rule: Rule): boolean {
		if (!this.#settings.enabled) {
			return false;
		}
		if (this.#rules.has(rule.name)) {
			return false;
		}

		const conditions = this.#compileConditions(rule);
		const astConditions = (rule.astCondition ?? []).map(pattern => pattern.trim()).filter(p => p.length > 0);
		const question = rule.question?.trim() || undefined;
		if (conditions.length === 0 && astConditions.length === 0 && !question) {
			return false;
		}

		const scope = this.#buildScope(rule);
		if (!this.#hasReachableScope(scope)) {
			logger.warn("TTSR scope excludes all streams, skipping rule", {
				ruleName: rule.name,
				scope: rule.scope,
			});
			return false;
		}
		const globalPathGlobs = this.#compileGlobalPathGlobs(rule.globs);
		this.#rules.set(rule.name, {
			rule,
			conditions,
			conditionTraits: conditions.map(analyzeCondition),
			astConditions,
			question,
			scope,
			globalPathGlobs,
		});
		this.#classifyConditions(rule, conditions);
		if (question) {
			this.#hasJudgedRules = true;
		} else {
			if (scope.allowText) this.#canMatchText = true;
			if (scope.allowThinking) this.#canMatchThinking = true;
		}

		return true;
	}

	/**
	 * Add a stream chunk to its scoped buffer and return matching rules.
	 *
	 * Buffers are isolated by source/tool key so matches don't bleed across
	 * assistant prose, thinking text, and unrelated tool argument streams.
	 * Conditions confined to one line are matched exactly on every delta;
	 * conditions that can span lines may wait for the buffer to grow until
	 * `options.final` (default `false`) asks for the whole buffer.
	 */
	checkDelta(delta: string, context: TtsrMatchContext, options?: TtsrCheckOptions): Rule[] {
		if (context.source === "text" && !this.#canMatchText) {
			return [];
		}
		if (context.source === "thinking" && !this.#canMatchThinking) {
			return [];
		}
		const buffer = this.#streamBuffer(context);
		buffer.append(delta);
		return this.#matchBuffer(buffer, context, options?.final ?? false);
	}

	/**
	 * Replace the scoped buffer with a tool-provided normalized snapshot and
	 * return matching rules.
	 *
	 * Used for tools exposing `matcherDigest`: the digest is recomputed from the
	 * full (partial) arguments on every delta, so it replaces the buffer instead
	 * of being appended to it. A snapshot extending the previous one is scanned
	 * incrementally. Pass `{ final: false }` while the arguments still stream to
	 * let conditions that can span lines wait for the buffer to grow.
	 */
	checkSnapshot(snapshot: string, context: TtsrMatchContext, options?: TtsrCheckOptions): Rule[] {
		const buffer = this.#streamBuffer(context);
		buffer.replace(snapshot);
		return this.#matchBuffer(buffer, context, options?.final ?? true);
	}

	#streamBuffer(context: TtsrMatchContext): StreamBuffer {
		const bufferKey = this.#bufferKey(context);
		let buffer = this.#buffers.get(bufferKey);
		if (!buffer) {
			buffer = new StreamBuffer(this.#onSlow);
			this.#buffers.set(bufferKey, buffer);
		}
		return buffer;
	}

	/** Derive an ast-grep language alias from candidate paths (bare extension, e.g. "ts"), if any. */
	#deriveLang(filePaths: string[] | undefined): string | undefined {
		for (const filePath of filePaths ?? []) {
			const ext = path.extname(this.#normalizePath(filePath));
			if (ext.length > 1) {
				return ext.slice(1).toLowerCase();
			}
		}
		return undefined;
	}

	/**
	 * Evaluate ast-grep `astCondition` rules against a reconstructed tool snapshot.
	 *
	 * Only edit/write tool streams reach here (AST conditions need a language, which
	 * we infer from the file extension on the tool's path argument). The snapshot is
	 * matched in memory by the native engine (`astMatch`), so this is async and
	 * intentionally throttled: identical consecutive snapshots (the common case when
	 * only non-source arguments change between deltas) are skipped.
	 */
	async checkAstSnapshot(snapshot: string, context: TtsrMatchContext): Promise<Rule[]> {
		if (!this.#settings.enabled || context.source !== "tool") {
			return [];
		}

		const lang = this.#deriveLang(context.filePaths);
		if (!lang) {
			return [];
		}

		const candidates: TtsrEntry[] = [];
		for (const entry of this.#rules.values()) {
			if (entry.astConditions.length === 0 || entry.question) {
				continue;
			}
			if (
				!this.#canTrigger(entry.rule) ||
				!this.#matchesScope(entry, context) ||
				!this.#matchesGlobalPaths(entry, context)
			) {
				continue;
			}
			candidates.push(entry);
		}
		if (candidates.length === 0) {
			return [];
		}

		// Throttle: skip re-running the matcher when the source content is unchanged.
		const bufferKey = this.#bufferKey(context);
		if (this.#lastAstSnapshots.get(bufferKey) === snapshot) {
			return [];
		}
		this.#lastAstSnapshots.set(bufferKey, snapshot);

		const matches: Rule[] = [];
		for (const entry of candidates) {
			if (await this.#astConditionsMatch(entry.astConditions, snapshot, lang)) {
				matches.push(entry.rule);
				logger.debug("TTSR ast condition matched", {
					ruleName: entry.rule.name,
					astConditions: entry.rule.astCondition,
					toolName: context.toolName,
					filePaths: context.filePaths,
				});
			}
		}
		return matches;
	}

	async #astConditionsMatch(patterns: string[], source: string, lang: string): Promise<boolean> {
		try {
			await ensureGrammar({ lang });
			const result = await astMatch({
				patterns,
				source,
				lang,
				strictness: AstMatchStrictness.Smart,
				limit: 1,
			});
			return result.totalMatches > 0;
		} catch (error) {
			logger.warn("TTSR ast match failed, treating as no match", {
				patterns,
				lang,
				error: error instanceof Error ? error.message : String(error),
			});
			return false;
		}
	}

	/** True when any stream-matched rule carries ast-grep conditions. */
	hasAstRules(): boolean {
		if (!this.#settings.enabled) {
			return false;
		}
		for (const entry of this.#rules.values()) {
			if (entry.astConditions.length > 0 && !entry.question) {
				return true;
			}
		}
		return false;
	}

	/** True when any registered rule is judged (`question`). */
	hasJudgedRules(): boolean {
		return this.#settings.enabled && this.#hasJudgedRules;
	}

	/**
	 * Judged rules to ask about one completed output: in scope, inside the rule's
	 * path globs, past the repeat gate, and — when the rule also declares
	 * `condition`/`astCondition` — passing that cheap prefilter first.
	 */
	async judgedCandidates(content: string, context: TtsrMatchContext): Promise<JudgedCandidate[]> {
		if (!this.hasJudgedRules()) {
			return [];
		}
		const eligible: { entry: TtsrEntry; question: string }[] = [];
		const isolated: RegExp[] = [];
		const quarantined: RegExp[] = [];
		for (const entry of this.#rules.values()) {
			if (
				!entry.question ||
				!this.#canTrigger(entry.rule) ||
				!this.#matchesScope(entry, context) ||
				!this.#matchesGlobalPaths(entry, context)
			) {
				continue;
			}
			eligible.push({ entry, question: entry.question });
			for (const condition of entry.conditions) {
				if (this.#quarantined.has(condition)) quarantined.push(condition);
				else if (this.#sandboxed.has(condition)) isolated.push(condition);
			}
		}
		const verdicts = this.#evaluateInSandbox(content, isolated);
		for (const condition of [...isolated, ...quarantined]) {
			if (!verdicts.has(condition)) verdicts.set(condition, NO_SANDBOX_MATCH);
		}
		const candidates: JudgedCandidate[] = [];
		for (const { entry, question } of eligible) {
			if (await this.#passesPrefilter(entry, content, context, verdicts)) {
				candidates.push({ rule: entry.rule, question });
			}
		}
		return candidates;
	}

	async #passesPrefilter(
		entry: TtsrEntry,
		content: string,
		context: TtsrMatchContext,
		verdicts: ReadonlyMap<RegExp, SandboxVerdict>,
	): Promise<boolean> {
		if (entry.conditions.length === 0 && entry.astConditions.length === 0) {
			return true;
		}
		if (this.#matchesCondition(entry, content, verdicts)) {
			return true;
		}
		const lang = context.source === "tool" ? this.#deriveLang(context.filePaths) : undefined;
		return lang !== undefined && entry.astConditions.length > 0
			? this.#astConditionsMatch(entry.astConditions, content, lang)
			: false;
	}

	/**
	 * Claim judged verdicts for delivery: drop rules another verdict already
	 * claimed or that cannot repeat yet, and mark the rest injected so
	 * concurrent judgments cannot deliver them twice.
	 */
	claim(rules: readonly Rule[]): Rule[] {
		const claimed = rules.filter(rule => this.#canTrigger(rule));
		this.markInjected(claimed);
		return claimed;
	}

	#matchBuffer(buffer: StreamBuffer, context: TtsrMatchContext, final: boolean): Rule[] {
		if (!this.#settings.enabled) {
			return [];
		}
		if (final) this.#settleSandboxed(buffer, context);
		const matches: Rule[] = [];
		for (const [name, entry] of this.#rules) {
			if (!this.#isEligible(entry, context)) {
				continue;
			}
			if (
				!entry.conditions.some((condition, index) =>
					this.#conditionMatches(buffer, condition, entry.conditionTraits[index], final),
				)
			) {
				continue;
			}

			const excerpt = buffer.excerpt(
				name,
				entry.conditions,
				condition => !this.#sandboxed.has(condition) && !this.#quarantined.has(condition),
			);
			matches.push(entry.rule);
			logger.debug("TTSR condition matched", {
				ruleName: name,
				conditions: entry.rule.condition,
				excerpt,
				source: context.source,
				toolName: context.toolName,
				filePaths: context.filePaths,
			});
		}

		return matches;
	}

	/** Text that matched this rule in this stream; AST-only and zero-width matches have no excerpt. */
	matchExcerpt(ruleName: string, context: TtsrMatchContext): string | undefined {
		const key = this.#bufferKey(context);
		for (const [bufferKey, buffer] of this.#buffers) {
			if (bufferKey !== key && !bufferKey.startsWith(`${key}#`)) continue;
			const excerpt = buffer.excerpts.get(ruleName);
			if (excerpt !== undefined) return excerpt;
		}
		return undefined;
	}

	/** Mark rules as injected (won't trigger again until conditions allow). */
	markInjected(rulesToMark: Rule[]): void {
		this.markInjectedByNames(rulesToMark.map(rule => rule.name));
	}

	/**
	 * Mark rule names as injected (won't trigger again until conditions allow). `deliveryTurn` is the
	 * turn the reminder lands in when that is a later turn than the current one (an interrupt's retry).
	 */
	markInjectedByNames(ruleNames: string[], deliveryTurn = this.#messageCount): void {
		const lastInjectedAt = Math.max(deliveryTurn, this.#messageCount);
		for (const rawName of ruleNames) {
			const ruleName = rawName.trim();
			if (ruleName.length === 0) {
				continue;
			}
			const record = this.#injectionRecords.get(ruleName);
			if (!record) {
				this.#injectionRecords.set(ruleName, { lastInjectedAt });
			} else {
				// Never lower a record: a later-landing reminder (an interrupt's retry) must keep its exemption.
				record.lastInjectedAt = Math.max(record.lastInjectedAt, lastInjectedAt);
			}
			logger.debug("TTSR rule marked as injected", { ruleName, lastInjectedAt });
		}
	}

	/** Get names of all injected rules (for persistence). */
	getInjectedRuleNames(): string[] {
		return Array.from(this.#injectionRecords.keys());
	}

	/** Restore injected state from a list of rule names. */
	restoreInjected(ruleNames: string[]): void {
		for (const name of ruleNames) {
			this.#injectionRecords.set(name, { lastInjectedAt: 0 });
		}
		if (ruleNames.length > 0) {
			logger.debug("TTSR injected state restored", { ruleNames });
		}
	}

	/**
	 * Reset stream buffers. Called at every stream boundary: a new turn, a new
	 * assistant message within a turn, and a restarted response. Buffers never
	 * span two assistant messages; repeat-after-gap counters are untouched.
	 */
	resetBuffer(): void {
		this.#buffers.clear();
		this.#lastAstSnapshots.clear();
	}

	/**
	 * Give quarantined conditions a fresh sandbox run. Called when the logical
	 * session changes; a same-session rule rebuild keeps them. Slow-scan
	 * demotions stay, because a demoted condition's in-process scan is unbounded.
	 */
	clearQuarantine(): void {
		this.#quarantined.clear();
	}

	/** Clear only one tool stream's transient matcher state. */
	clearStream(streamKey: string): void {
		const prefix = `${streamKey}#`;
		for (const key of this.#buffers.keys()) {
			if (key === streamKey || key.startsWith(prefix)) this.#buffers.delete(key);
		}
		for (const key of this.#lastAstSnapshots.keys()) {
			if (key === streamKey || key.startsWith(prefix)) this.#lastAstSnapshots.delete(key);
		}
	}

	/** Check if any TTSR rules are registered. */
	hasRules(): boolean {
		if (!this.#settings.enabled) {
			return false;
		}
		return this.#rules.size > 0;
	}

	/**
	 * Atomically replace monitored rules while retaining injection state for names
	 * that remain registered. While TTSR is disabled nothing registers, so injection
	 * state is kept intact for when it is re-enabled.
	 *
	 * Returns the names accepted for TTSR monitoring so the caller can bucket
	 * rejected conditional rules through its normal fallback path.
	 */
	replaceRules(rules: readonly Rule[]): Set<string> {
		const replacement = new TtsrManager(this.#settingsSource);
		for (const rule of rules) {
			replacement.addRule(rule);
		}

		const registered = new Set(replacement.#rules.keys());
		this.#rules.clear();
		for (const [name, entry] of replacement.#rules) {
			this.#rules.set(name, entry);
		}
		this.#canMatchText = replacement.#canMatchText;
		this.#canMatchThinking = replacement.#canMatchThinking;
		this.#hasJudgedRules = replacement.#hasJudgedRules;
		const sandboxedKeys = new Set(Array.from(this.#sandboxed, conditionKey));
		const quarantinedKeys = new Set(Array.from(this.#quarantined, conditionKey));
		this.#userConditions.clear();
		this.#sandboxed.clear();
		this.#quarantined.clear();
		for (const [condition, ruleName] of replacement.#userConditions) {
			this.#userConditions.set(condition, ruleName);
			const key = conditionKey(condition);
			if (replacement.#sandboxed.has(condition) || sandboxedKeys.has(key)) this.#sandboxed.add(condition);
			if (quarantinedKeys.has(key)) this.#quarantined.add(condition);
		}
		this.resetBuffer();

		if (!this.#settings.enabled) return registered;
		for (const name of this.#injectionRecords.keys()) {
			if (!registered.has(name)) this.#injectionRecords.delete(name);
		}
		return registered;
	}

	/** All rules currently registered for TTSR monitoring, in registration order. */
	getRules(): Rule[] {
		return Array.from(this.#rules.values(), entry => entry.rule);
	}

	/** Increment message counter (call after each turn). */
	incrementMessageCount(): void {
		this.#messageCount++;
	}

	/** Get current message count. */
	getMessageCount(): number {
		return this.#messageCount;
	}

	/** Current settings, read live from the manager's source. */
	getSettings(): TtsrSettings {
		return this.#settings;
	}
}
