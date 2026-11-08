/**
 * The Spotlight dashboard: what tool-output shaping saved, measured four ways (see the doc comments of
 * {@link SpotlightDashboardStats} and the types it references), from the tables `spotlight-ingest.ts` fills.
 *
 * Approximations, all named in the UI's captions:
 * - token counts of results without a Spotlight trace are result characters / 4;
 * - what pi would have shown unshaped (`plain`), on read/bash/eval traces written before pi recorded it, is the input
 *   scaled to pi's inline cap (see {@link estimatedPlainTokens});
 * - a compaction is a request whose prompt (input + cache read + cache write) is under 60% of the previous one's;
 * - a rerun is a bash command equal to, extending (pipe, redirect, `&&`), or ≥ 60% token-similar to a recent one;
 *   for any other tool but `read`, a call of the same tool whose argument tokens (`argumentTokens`) are ≥ 60%
 *   similar.
 */

import type { Database, Statement } from "bun:sqlite";
import * as path from "node:path";
import { getTimeRangeConfig } from "./aggregator";
import { initDb } from "./db";
import { classifyAgentType } from "./parser";
import { getContextFactSeries, getSessionSpans, type RangeWindow } from "./rollup";
import type {
	AgentType,
	SpotlightBucket,
	SpotlightClawback,
	SpotlightContextPoint,
	SpotlightCutEconomics,
	SpotlightCutGroup,
	SpotlightDashboardStats,
	SpotlightEstimate,
	SpotlightFetchBackCell,
	SpotlightGapBin,
	SpotlightGapCount,
	SpotlightOverhead,
	SpotlightRecovery,
	SpotlightRecoveryKind,
	SpotlightAgentScope,
	SpotlightRecoveryTotals,
	SpotlightResultRow,
	SpotlightSessionContext,
	SpotlightSessionSummary,
	SpotlightSharePoint,
	SpotlightTool,
	SpotlightToolRow,
	SpotlightToolTotals,
} from "./shared-types";
import { BOOTSTRAP_MIN_SESSIONS, bootstrapInterval, bootstrapRatio, quantile } from "./spotlight-bootstrap";
import { artifactIds, parseReadSelection, resolveReadPath, selectedLines } from "./spotlight-ingest";
import {
	computeAdjusted,
	computeCoverage,
	computeRanking,
	computeSteps,
	computeTimeCost,
	emptyAdjusted,
	emptyRanking,
	holdoutBaselines,
	type SessionMoney,
} from "./spotlight-measures";

const CHARS_PER_TOKEN = 4;
/** A request whose prompt is under this share of the previous request's follows a compaction. */
const COMPACTION_RATIO = 0.6;
/** A rerun follows the result it repeats within this many tool calls. */
const RERUN_WINDOW = 12;
/**
 * Token Jaccard similarity at which two commands of the same program, or two calls of another tool (their argument
 * tokens), count as a rerun.
 */
const RERUN_JACCARD = 0.6;
const RECENT_LIMIT = 60;
const SESSION_LIST_LIMIT = 30;
const DISPLAY_TARGET_CHARS = 200;
/**
 * What `plain` shows of an output at most, in bytes, for read/bash/eval traces without `plainTokens` (written before
 * pi recorded it; every other tool's trace always has it): bash and eval inline up to pi's spill threshold
 * (`tools.artifactSpillThreshold`, default 50 KiB) plus the 2 KiB notice slack of `resolveInlineByteCapBudget`
 * (coding-agent `tools/output-meta.ts`); `read` pages at the spill threshold.
 */
const PLAIN_CAP_BYTES: Readonly<Record<string, number>> = { read: 50 * 1024, bash: 52 * 1024, eval: 52 * 1024 };
/** Upper bounds (tokens) of the original-size bins the fetch-back reference is standardized over; the last is open. */
const SIZE_BIN_BOUNDS: readonly number[] = [1000, 2000, 4000];
const GAP_BINS: readonly SpotlightGapBin[] = ["1", "2", "3", "4–6", "7–12"];

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

export interface SessionRow {
	session_file: string;
	folder: string;
	marked_at: number;
	cwd: string | null;
	title: string | null;
}

interface CallRow {
	tool_call_id: string;
	entry_id: string;
	timestamp: number;
	seq: number;
	tool_name: string;
	calls_in_turn: number;
	target: string;
	result_chars: number | null;
	artifacts: string | null;
	edits: string | null;
	arg_tokens: string | null;
}

interface ResultRow {
	tool_call_id: string;
	timestamp: number;
	tool: string;
	in_chars: number;
	out_chars: number;
	in_tokens: number;
	out_tokens: number;
	steps: string;
	holdout: number;
	path: string | null;
	start_line: number | null;
	lines: number | null;
	hidden: string | null;
	hidden_lines: number;
	artifacts: string | null;
	sp_calls: number | null;
	sp_failures: number | null;
	sp_ms: number | null;
	sp_cost: number | null;
	shape_ms: number | null;
	plain_chars: number | null;
	plain_tokens: number | null;
	capped_tokens: number | null;
	score_free: number;
	gated: number;
	heat: string | null;
	kept: string | null;
	need_reread: string | null;
	need_edit: string | null;
}

interface RequestRow {
	entry_id: string;
	timestamp: number;
	duration: number;
	input_tokens: number;
	cache_read_tokens: number;
	cache_write_tokens: number;
	cost_input: number;
	cost_cache_read: number;
	cost_cache_write: number;
	cost_total: number;
}

// ---------------------------------------------------------------------------
// Per-session analysis
// ---------------------------------------------------------------------------

export interface Result {
	timestamp: number;
	tool: string;
	inTokens: number;
	outTokens: number;
	/** What `plain` would have shown: the trace's count, else {@link estimatedPlainTokens}. */
	plainTokens: number;
	plainEstimated: boolean;
	/** plain − out of a cut or would-be cut (held out), negative when the cut was wider than plain; 0 if unchanged. */
	savedTokens: number;
	/** in − out of a cut or would-be cut: the saving against the full output. */
	fullSavedTokens: number;
	steps: string[];
	/** Shaping changed it and the model saw the changed text (an applied cut). */
	shortened: boolean;
	/** Shaping would have shortened it, but it was held out: the model saw it unshaped. */
	holdout: boolean;
	/** The score-free coin skipped Spotlight: the no-score fallback rules shaped it. */
	scoreFree: boolean;
	/**
	 * A read pi's former edit gate (removed) kept whole: the model saw `plain`'s page, the counts describe the
	 * would-be cut. Only in transcripts journaled while the gate ran.
	 */
	gated: boolean;
	/**
	 * The cut (shown, or not applied because pi capped it at `plain`'s text) was wider than what `plain` would have
	 * shown.
	 */
	widerThanPlain: boolean;
	/** Some Spotlight call failed: the no-score fallback rules shaped it. */
	failed: boolean;
	/** Per-line heat (`0`–`9`, else unscored) and kept runs (1-based positions) of the original; see the trace. */
	heat: string;
	kept: [number, number][];
	/** Original lines (1-based positions) later calls needed; null for results that collect none. */
	needs: { reread: [number, number][]; edit: [number, number][] } | null;
	path: string | null;
	/** The original window (`details.spotlight.original`): first line and line count; 0 lines without one. */
	start: number;
	lines: number;
	hidden: [number, number][];
	hiddenLines: number;
	spotlightCalls: number;
	spotlightFailures: number;
	spotlightMs: number;
	spotlightUsd: number;
	/** Wall time shaping took; null before its shape entry landed. */
	shapeMs: number | null;
}

export interface Recovery {
	kind: SpotlightRecoveryKind;
	source: Call;
	/** Tool calls between the source result and this call. */
	after: number;
	/** Every call of this call's request is a recovery. */
	turn: boolean;
}

export interface Call {
	id: string;
	entryId: string;
	timestamp: number;
	seq: number;
	tool: string;
	target: string;
	callsInTurn: number;
	/** Tokens the result added to the context: the trace's `outTokens`, else result characters / 4. */
	tokens: number;
	artifacts: Set<number>;
	result: Result | null;
	recovery: Recovery | null;
	/** Recoveries this call's result was the source of. */
	recoveredBy: Call[];
	/** Files the call edits, resolved against the session's working directory; empty for other calls. */
	edits: string[];
	/** The call's argument tokens (generic rerun rule); empty for `read`, `bash` and unrecorded calls. */
	argTokens: Set<string>;
	/** Calls from an evaluated result to the first call fetching more of it (the uniform rule); null for none. */
	fetchBackGap: number | null;
	/** Evaluated results this call is the first fetch-back of (the uniform rule). */
	fetchesBack: Call[];
	/** A held-out result's would-be recoveries: tokens of later calls that would have recovered the cut. */
	baselineTokens: number;
	/** A shortened result's saved tokens × the requests that carried them, and their price. */
	savedCarry: number;
	savedCarryUsd: number;
	/** A recovery's tokens × the requests that carried them, and their price. */
	recoveryCarry: number;
	recoveryCarryUsd: number;
}

export interface Request {
	entryId: string;
	timestamp: number;
	/** Model time of the request (ms). */
	durationMs: number;
	context: number;
	costTotal: number;
	compacted: boolean;
	readRate: number;
	writeRate: number;
}

export interface SessionAnalysis {
	session: SessionRow;
	cwd: string | null;
	calls: Call[];
	requests: Request[];
	/** Request cost by assistant entry id (main-loop requests). */
	costByEntry: Map<string, number>;
	agentType: AgentType;
	edits: EditLog;
}

function parseIds(json: string | null): number[] {
	if (!json) return [];
	try {
		const value: unknown = JSON.parse(json);
		return Array.isArray(value) ? value.filter((id): id is number => typeof id === "number") : [];
	} catch {
		return [];
	}
}

function parseStrings(json: string | null): string[] {
	if (!json) return [];
	try {
		const value: unknown = JSON.parse(json);
		return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
	} catch {
		return [];
	}
}

function parseRanges(json: string | null): [number, number][] {
	if (!json) return [];
	try {
		const value: unknown = JSON.parse(json);
		if (!Array.isArray(value)) return [];
		return value.filter(
			(pair): pair is [number, number] =>
				Array.isArray(pair) && typeof pair[0] === "number" && typeof pair[1] === "number",
		);
	} catch {
		return [];
	}
}

/**
 * What `plain` would have shown of a read/bash/eval result whose trace predates `plainTokens`: its input scaled to
 * the inline cap ({@link PLAIN_CAP_BYTES}), in × min(1, cap / inChars). Null for any other tool: the generic path
 * shapes the text `plain` shows, so its input is that text.
 */
export function estimatedPlainTokens(tool: string, inTokens: number, inChars: number): number | null {
	const cap = PLAIN_CAP_BYTES[tool];
	if (cap === undefined) return null;
	return inChars > cap ? Math.round((inTokens * cap) / inChars) : inTokens;
}

function parseSteps(json: string): string[] {
	try {
		const value: unknown = JSON.parse(json);
		return Array.isArray(value) ? value.filter((step): step is string => typeof step === "string") : [];
	} catch {
		return [];
	}
}

function toResult(row: ResultRow): Result {
	const hidden = parseRanges(row.hidden);
	const steps = parseSteps(row.steps);
	// A cut wider than plain pi did not apply: the model got plain's text, as for a result shaping kept.
	const capped = row.capped_tokens !== null || steps.at(-1) === "plain-cap";
	// Traces that log plain sizes give the model plain's text for a kept result: only a text unlike it is a cut.
	const shown = row.plain_chars ?? row.in_chars;
	const shortened = row.holdout === 0 && row.gated === 0 && !capped && (row.lines !== null || row.out_chars !== shown);
	const holdout = row.holdout !== 0;
	const gated = row.gated !== 0;
	const estimated = row.plain_tokens === null ? estimatedPlainTokens(row.tool, row.in_tokens, row.in_chars) : null;
	const plainTokens = row.plain_tokens ?? estimated ?? row.in_tokens;
	const cut = shortened || holdout;
	return {
		timestamp: row.timestamp,
		tool: row.tool,
		inTokens: row.in_tokens,
		outTokens: row.out_tokens,
		plainTokens,
		plainEstimated: estimated !== null,
		savedTokens: cut ? plainTokens - row.out_tokens : 0,
		fullSavedTokens: cut ? row.in_tokens - row.out_tokens : 0,
		steps,
		shortened,
		holdout,
		scoreFree: row.score_free !== 0,
		gated,
		widerThanPlain: capped || (shortened && row.out_tokens > plainTokens),
		failed: (row.sp_failures ?? 0) > 0,
		heat: row.heat ?? "",
		kept: parseRanges(row.kept),
		needs:
			row.need_reread !== null || row.need_edit !== null
				? { reread: parseRanges(row.need_reread), edit: parseRanges(row.need_edit) }
				: null,
		path: row.path,
		start: row.start_line ?? 1,
		lines: row.lines ?? 0,
		hidden,
		hiddenLines: row.hidden_lines,
		spotlightCalls: row.sp_calls ?? 0,
		spotlightFailures: row.sp_failures ?? 0,
		spotlightMs: row.sp_ms ?? 0,
		spotlightUsd: row.sp_cost ?? 0,
		shapeMs: row.shape_ms,
	};
}

/**
 * Tokens a result added to the context: what the model saw (a held-out or gated result's `plain` text, not the
 * would-be cut).
 */
function seenTokens(result: Result | null, resultChars: number | null): number {
	if (result && !result.holdout && !result.gated) return result.outTokens;
	if (resultChars !== null) return Math.round(resultChars / CHARS_PER_TOKEN);
	return result?.plainTokens ?? 0;
}

function toRequest(row: RequestRow): Request {
	const inputRate = row.input_tokens > 0 ? row.cost_input / row.input_tokens : 0;
	return {
		entryId: row.entry_id,
		timestamp: row.timestamp,
		durationMs: row.duration,
		context: row.input_tokens + row.cache_read_tokens + row.cache_write_tokens,
		costTotal: row.cost_total,
		compacted: false,
		readRate: row.cache_read_tokens > 0 ? row.cost_cache_read / row.cache_read_tokens : inputRate,
		writeRate: row.cache_write_tokens > 0 ? row.cost_cache_write / row.cache_write_tokens : inputRate,
	};
}

/** Loads and analyzes experiment sessions with one set of prepared statements. */
class SessionLoader {
	readonly #calls: Statement<CallRow, [string]>;
	readonly #results: Statement<ResultRow, [string]>;
	readonly #requests: Statement<RequestRow, [string]>;

	constructor(database: Database) {
		this.#calls = database.query<CallRow, [string]>(
			`SELECT tool_call_id, entry_id, timestamp, seq, tool_name, calls_in_turn, target, result_chars, artifacts,
			 edits, arg_tokens
			 FROM spotlight_calls WHERE session_file = ? ORDER BY seq`,
		);
		this.#results = database.query<ResultRow, [string]>(
			`SELECT r.tool_call_id, r.timestamp, r.tool, r.in_chars, r.out_chars, r.in_tokens, r.out_tokens,
			 r.steps, r.holdout, r.path, r.start_line, r.lines, r.hidden, r.hidden_lines, r.artifacts, r.sp_calls,
			 r.sp_failures, r.sp_ms, r.sp_cost, r.shape_ms, r.plain_chars, r.plain_tokens, r.capped_tokens, r.score_free,
			 r.gated, r.heat, r.kept,
			 n.reread AS need_reread, n.edit AS need_edit
			 FROM spotlight_results r
			 LEFT JOIN spotlight_needs n ON n.session_file = r.session_file AND n.tool_call_id = r.tool_call_id
			 WHERE r.session_file = ?`,
		);
		this.#requests = database.query<RequestRow, [string]>(
			`SELECT m.entry_id, m.timestamp, m.duration, m.input_tokens, m.cache_read_tokens, m.cache_write_tokens,
			 m.cost_input, m.cost_cache_read, m.cost_cache_write, m.cost_total
			 FROM spotlight_requests r JOIN messages m ON m.session_file = r.session_file AND m.entry_id = r.entry_id
			 WHERE r.session_file = ? ORDER BY m.timestamp, m.entry_id`,
		);
	}

	analyze(session: SessionRow): SessionAnalysis {
		const cwd = session.cwd;
		const results = new Map<string, ResultRow>();
		for (const row of this.#results.all(session.session_file)) results.set(row.tool_call_id, row);
		const calls: Call[] = this.#calls.all(session.session_file).map(row => {
			const resultRow = results.get(row.tool_call_id);
			results.delete(row.tool_call_id);
			const result = resultRow ? toResult(resultRow) : null;
			const artifacts = new Set([...parseIds(row.artifacts), ...parseIds(resultRow?.artifacts ?? null)]);
			return {
				id: row.tool_call_id,
				entryId: row.entry_id,
				timestamp: row.timestamp,
				seq: row.seq,
				tool: row.tool_name,
				target: row.target,
				callsInTurn: row.calls_in_turn,
				tokens: seenTokens(result, row.result_chars),
				artifacts,
				result,
				recovery: null,
				recoveredBy: [],
				edits: parseStrings(row.edits).map(file => resolveReadPath(file, cwd)),
				argTokens: new Set(parseStrings(row.arg_tokens)),
				fetchBackGap: null,
				fetchesBack: [],
				baselineTokens: 0,
				savedCarry: 0,
				savedCarryUsd: 0,
				recoveryCarry: 0,
				recoveryCarryUsd: 0,
			};
		});
		// Results whose call was not recorded (issued before the session's marker) still count as savings.
		for (const row of results.values()) {
			const result = toResult(row);
			calls.push({
				id: row.tool_call_id,
				entryId: "",
				timestamp: row.timestamp,
				seq: Number.NEGATIVE_INFINITY,
				tool: row.tool,
				target: row.path ?? "",
				callsInTurn: 1,
				tokens: seenTokens(result, null),
				artifacts: new Set(parseIds(row.artifacts)),
				result,
				recovery: null,
				recoveredBy: [],
				edits: [],
				argTokens: new Set(),
				fetchBackGap: null,
				fetchesBack: [],
				baselineTokens: 0,
				savedCarry: 0,
				savedCarryUsd: 0,
				recoveryCarry: 0,
				recoveryCarryUsd: 0,
			});
		}
		calls.sort((a, b) => a.seq - b.seq || a.timestamp - b.timestamp);

		const requests: Request[] = [];
		for (const row of this.#requests.all(session.session_file)) {
			const request = toRequest(row);
			// Failed requests report no prompt; they neither carry context nor mark a compaction. Requests before
			// the marker (a resumed pre-experiment session) are not the experiment's.
			if (request.context <= 0 || request.timestamp < session.marked_at) continue;
			const previous = requests.at(-1);
			request.compacted = previous !== undefined && request.context < previous.context * COMPACTION_RATIO;
			requests.push(request);
		}
		const costByEntry = new Map(requests.map(request => [request.entryId, request.costTotal]));
		const analysis: SessionAnalysis = {
			session,
			cwd: session.cwd,
			calls,
			requests,
			costByEntry,
			agentType: classifyAgentType(session.session_file),
			edits: new EditLog(calls),
		};
		detectRecoveries(analysis);
		detectHoldoutBaselines(analysis);
		detectFetchBacks(analysis);
		compound(analysis);
		return analysis;
	}
}

// ---------------------------------------------------------------------------
// Recovery detection
// ---------------------------------------------------------------------------

function overlaps(ranges: readonly [number, number][], hidden: readonly [number, number][]): boolean {
	for (const [a, b] of ranges) {
		for (const [h1, h2] of hidden) if (a <= h2 && h1 <= b) return true;
	}
	return false;
}

const ENV_ASSIGNMENT = /^[A-Za-z_]\w*=/;
const COMMAND_EXTENSION = /^\s*(?:\||>|2>|&>|&&)/;
/** A leading `cd <dir> &&` / `cd <dir>;` says where, not what: similarity compares what follows. */
const CD_PREFIX = /^cd\s+\S+?\s*(?:&&|;)\s*/;

function commandTokens(command: string): string[] {
	return command.trim().split(/\s+/).filter(Boolean);
}

function commandBody(command: string): string[] {
	let body = command.trim();
	while (CD_PREFIX.test(body)) body = body.replace(CD_PREFIX, "");
	return commandTokens(body);
}

function commandProgram(tokens: readonly string[]): string | null {
	const head = tokens.find(token => !ENV_ASSIGNMENT.test(token));
	return head ? path.basename(head) : null;
}

/** Whether bash command `next` repeats `previous`: equal, extended by a pipe/redirect/`&&`, or similar enough. */
export function isRerun(previous: string, next: string): boolean {
	const a = commandTokens(previous);
	const b = commandTokens(next);
	if (a.length === 0 || b.length === 0) return false;
	const normalizedA = a.join(" ");
	const normalizedB = b.join(" ");
	if (normalizedA === normalizedB) return true;
	if (normalizedB.startsWith(normalizedA) && COMMAND_EXTENSION.test(normalizedB.slice(normalizedA.length)))
		return true;
	const bodyA = commandBody(previous);
	const bodyB = commandBody(next);
	const program = commandProgram(bodyA);
	if (program === null || program !== commandProgram(bodyB)) return false;
	return jaccard(new Set(bodyA), new Set(bodyB)) >= RERUN_JACCARD;
}

const GLOB_CHARS = /[*?[{]/;

/** The session's file edits in call order: whether a file (or any file) changed between two calls. */
export class EditLog {
	readonly #edits: { seq: number; exact: Set<string>; globs: Bun.Glob[] }[] = [];

	/** `calls` sorted by seq, their `edits` resolved. */
	constructor(calls: readonly Call[]) {
		for (const call of calls) {
			if (call.edits.length === 0) continue;
			const exact = new Set<string>();
			const globs: Bun.Glob[] = [];
			for (const file of call.edits) {
				if (GLOB_CHARS.test(file)) globs.push(new Bun.Glob(file));
				else exact.add(file);
			}
			this.#edits.push({ seq: call.seq, exact, globs });
		}
	}

	/** An edit strictly between calls `after` and `before`, of `file` (resolved) when given, else of any file. */
	between(after: number, before: number, file?: string): boolean {
		let lo = 0;
		let hi = this.#edits.length;
		while (lo < hi) {
			const mid = (lo + hi) >> 1;
			if (this.#edits[mid].seq > after) hi = mid;
			else lo = mid + 1;
		}
		for (let i = lo; i < this.#edits.length && this.#edits[i].seq < before; i++) {
			const edit = this.#edits[i];
			if (file === undefined || edit.exact.has(file) || edit.globs.some(glob => glob.match(file))) return true;
		}
		return false;
	}
}

/**
 * Whether `call` re-reads the file `source` read, unless that file was edited in between: `hidden` given, the
 * later selection must overlap it (a recovery of a cut); else it must overlap the source's own window (the
 * fetch-back rule, where a whole-file read overlaps everything).
 */
function rereads(call: Call, source: Call, analysis: SessionAnalysis, hidden?: [number, number][]): boolean {
	const result = source.result;
	const sourceSelection = parseReadSelection(source.target);
	const sourcePath = result?.path ?? sourceSelection.path;
	const selection = parseReadSelection(call.target);
	if (!sourcePath) return false;
	const file = resolveReadPath(selection.path, analysis.cwd);
	if (file !== resolveReadPath(sourcePath, analysis.cwd)) return false;
	if (analysis.edits.between(source.seq, call.seq, file)) return false;
	const later = selectedLines(selection);
	if (later === null) return true;
	if (hidden) {
		if (!result) return false;
		const end = result.start + result.lines - 1;
		const ranges = selection.tail === null ? later : [...later, [end - selection.tail + 1, end] as [number, number]];
		return overlaps(ranges, hidden);
	}
	// A tail read lands somewhere unknown in a windowed read.
	const window = selectedLines(sourceSelection);
	if (window === null) return true;
	const own: [number, number][] =
		result && result.lines > 0 ? [[result.start, result.start + result.lines - 1]] : window;
	return overlaps(later, own);
}

/** Jaccard similarity of two token sets; 0 when both are empty. */
function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
	if (a.size === 0 && b.size === 0) return 0;
	let shared = 0;
	for (const token of a) if (b.has(token)) shared++;
	return shared / (a.size + b.size - shared);
}

/**
 * Whether `call` repeats `source`, a call of the same tool, within the rerun window, with no file edited in between:
 * bash by {@link isRerun}; any other tool but `read` (which re-reads instead) by its argument tokens' Jaccard
 * similarity.
 */
function reruns(call: Call, source: Call, analysis: SessionAnalysis): boolean {
	if (call.tool !== source.tool || call.tool === "read" || call.seq - source.seq > RERUN_WINDOW) return false;
	const similar =
		call.tool === "bash"
			? isRerun(source.target, call.target)
			: jaccard(source.argTokens, call.argTokens) >= RERUN_JACCARD;
	return similar && !analysis.edits.between(source.seq, call.seq);
}

function namesArtifactOf(call: Call, source: Call): boolean {
	if (source.artifacts.size === 0) return false;
	for (const id of artifactIds(call.target)) if (source.artifacts.has(id)) return true;
	return false;
}

/**
 * The kind of recovery `call` is of the earlier `source`, if any; rules in order, first wins. With `wouldBe`, a
 * held-out source is judged as its would-be cut (its hidden lines), for {@link detectHoldoutBaselines}.
 */
function recoveryKind(
	call: Call,
	source: Call,
	analysis: SessionAnalysis,
	wouldBe = false,
): SpotlightRecoveryKind | null {
	if (namesArtifactOf(call, source)) return "artifact";
	const result = source.result;
	if (
		call.tool === "read" &&
		(result?.shortened || (wouldBe && (result?.holdout || result?.gated))) &&
		result.tool === "read"
	) {
		if (rereads(call, source, analysis, result.hidden)) return "reread";
	}
	if (reruns(call, source, analysis)) return "rerun";
	return null;
}

/**
 * What held-out (and gated) results would have cost had they been cut: each later call (of another request) that
 * would recover such a result by the recovery rules, judged against its would-be hidden lines, adds its tokens to the
 * latest such result's {@link Call.baselineTokens}. The model saw these results whole, so this is what the agent
 * fetches of a would-be cut's output regardless.
 */
function detectHoldoutBaselines(analysis: SessionAnalysis): void {
	const sources: Call[] = [];
	for (const call of analysis.calls) {
		for (let i = sources.length - 1; i >= 0; i--) {
			const source = sources[i];
			if (call.entryId !== "" && call.entryId === source.entryId) continue;
			if (!recoveryKind(call, source, analysis, true)) continue;
			source.baselineTokens += call.tokens;
			break;
		}
		if (call.result?.holdout || call.result?.gated) sources.push(call);
	}
}

/**
 * The uniform fetch-back rule every evaluated result is measured by, whatever the model saw: within
 * {@link RERUN_WINDOW} calls, a call of another request reading an artifact the result named, re-reading its
 * file over its window, or rerunning its call (edits in between excuse re-reads and reruns, as for recoveries).
 * Sets each evaluated result's {@link Call.fetchBackGap}.
 */
function detectFetchBacks(analysis: SessionAnalysis): void {
	const { calls } = analysis;
	for (let i = 0; i < calls.length; i++) {
		const source = calls[i];
		if (!source.result || !Number.isFinite(source.seq)) continue;
		for (let j = i + 1; j < calls.length && calls[j].seq - source.seq <= RERUN_WINDOW; j++) {
			const call = calls[j];
			if (call.entryId === source.entryId) continue;
			if (
				namesArtifactOf(call, source) ||
				(call.tool === "read" && source.tool === "read" && rereads(call, source, analysis)) ||
				reruns(call, source, analysis)
			) {
				source.fetchBackGap = call.seq - source.seq;
				call.fetchesBack.push(source);
				break;
			}
		}
	}
}

/**
 * Attribute each call to the latest earlier result it fetches hidden output from: a shortened result, or one whose
 * text names artifacts (a native truncation notice included).
 */
function detectRecoveries(analysis: SessionAnalysis): void {
	const sources: Call[] = [];
	for (const call of analysis.calls) {
		for (let i = sources.length - 1; i >= 0; i--) {
			const source = sources[i];
			// A parallel call of the same request was issued before the model saw the cut.
			if (call.entryId !== "" && call.entryId === source.entryId) continue;
			const kind = recoveryKind(call, source, analysis);
			if (!kind) continue;
			call.recovery = {
				kind,
				source,
				after: Number.isFinite(source.seq) ? Math.max(0, call.seq - source.seq - 1) : 0,
				turn: false,
			};
			source.recoveredBy.push(call);
			break;
		}
		if (call.result?.shortened || call.artifacts.size > 0) sources.push(call);
	}
	const recoveriesByEntry = new Map<string, number>();
	for (const call of analysis.calls) {
		if (call.recovery) recoveriesByEntry.set(call.entryId, (recoveriesByEntry.get(call.entryId) ?? 0) + 1);
	}
	for (const call of analysis.calls) {
		if (call.recovery && call.entryId) call.recovery.turn = recoveriesByEntry.get(call.entryId) === call.callsInTurn;
	}
}

// ---------------------------------------------------------------------------
// Compounding
// ---------------------------------------------------------------------------

/**
 * Carry each shortened result's saving and each recovery's tokens through the session's later requests until the
 * next compaction, pricing them at those requests' own cache rates.
 */
function compound(analysis: SessionAnalysis): void {
	const { requests } = analysis;
	const n = requests.length;
	// readPrefix[i] = Σ readRate of requests[0..i-1]; nextCompaction[i] = first j ≥ i that is compacted.
	const readPrefix = new Float64Array(n + 1);
	for (let i = 0; i < n; i++) readPrefix[i + 1] = readPrefix[i] + requests[i].readRate;
	const nextCompaction = new Int32Array(n + 1);
	nextCompaction[n] = n;
	for (let i = n - 1; i >= 0; i--) nextCompaction[i] = requests[i].compacted ? i : nextCompaction[i + 1];
	const firstAfter = (timestamp: number): number => {
		let lo = 0;
		let hi = n;
		while (lo < hi) {
			const mid = (lo + hi) >> 1;
			if (requests[mid].timestamp > timestamp) hi = mid;
			else lo = mid + 1;
		}
		return lo;
	};
	/** Requests carrying something that entered the context at `timestamp`, and the price of one token over them. */
	const carry = (timestamp: number): [number, number] => {
		const first = firstAfter(timestamp);
		const end = first < n ? nextCompaction[first] : n;
		if (end <= first) return [0, 0];
		return [end - first, requests[first].writeRate + readPrefix[end] - readPrefix[first]];
	};
	for (const call of analysis.calls) {
		const timestamp = call.result?.timestamp ?? call.timestamp;
		if (call.result?.shortened && call.result.savedTokens !== 0) {
			const [requestsCarried, rate] = carry(timestamp);
			call.savedCarry = call.result.savedTokens * requestsCarried;
			call.savedCarryUsd = call.result.savedTokens * rate;
		}
		if (call.recovery && call.tokens > 0) {
			const [requestsCarried, rate] = carry(timestamp);
			call.recoveryCarry = call.tokens * requestsCarried;
			call.recoveryCarryUsd = call.tokens * rate;
		}
	}
}

// ---------------------------------------------------------------------------
// Range aggregation
// ---------------------------------------------------------------------------

function emptyToolTotals(): SpotlightToolTotals {
	return { results: 0, shaped: 0, inTokens: 0, plainTokens: 0, outTokens: 0, savedTokens: 0, fullSavedTokens: 0 };
}

function emptyRecoveryTotals(): SpotlightRecoveryTotals {
	return { events: 0, tokens: 0, turns: 0, turnsUsd: 0, usd: 0 };
}

function emptyBucket(timestamp: number): SpotlightBucket {
	return {
		timestamp,
		results: 0,
		shaped: 0,
		savedTokens: 0,
		recoveries: 0,
		recoveredTokens: 0,
		netTokens: 0,
		savedUsd: 0,
		netUsd: 0,
	};
}

function displayTarget(call: Call): string {
	return call.target.slice(0, DISPLAY_TARGET_CHARS);
}

function toRecovery(call: Call, recovery: Recovery): SpotlightRecovery {
	return {
		kind: recovery.kind,
		toolCallId: call.id,
		tool: call.tool,
		target: displayTarget(call),
		timestamp: call.timestamp,
		tokens: call.tokens,
		after: recovery.after,
		turn: recovery.turn,
	};
}

/** Raw per-bucket facts of one session over the range. */
interface SessionFacts {
	/** bucket → [result chars, output tokens, user chars] */
	buckets: Map<number, [number, number, number]>;
	totalTokens: number;
	promptTokens: number;
}

function loadSessionFacts(database: Database, sessionFile: string, cutoff: number, bucketMs: number): SessionFacts {
	const buckets = new Map<number, [number, number, number]>();
	const bucket = (timestamp: number) => {
		let entry = buckets.get(timestamp);
		if (!entry) {
			entry = [0, 0, 0];
			buckets.set(timestamp, entry);
		}
		return entry;
	};
	const tools = database
		.query<{ bucket: number; chars: number }, [string, number]>(
			`SELECT (timestamp / ${bucketMs}) * ${bucketMs} AS bucket, TOTAL(result_chars) AS chars
			 FROM tool_calls WHERE session_file = ? AND timestamp >= ? GROUP BY 1`,
		)
		.all(sessionFile, cutoff);
	for (const row of tools) bucket(row.bucket)[0] += row.chars;
	const messages = database
		.query<{ bucket: number; output: number; total: number; prompt: number }, [string, number]>(
			`SELECT (timestamp / ${bucketMs}) * ${bucketMs} AS bucket, TOTAL(output_tokens) AS output,
			 TOTAL(total_tokens) AS total, TOTAL(input_tokens + cache_read_tokens + cache_write_tokens) AS prompt
			 FROM messages WHERE session_file = ? AND timestamp >= ? GROUP BY 1`,
		)
		.all(sessionFile, cutoff);
	let totalTokens = 0;
	let promptTokens = 0;
	for (const row of messages) {
		bucket(row.bucket)[1] += row.output;
		totalTokens += row.total;
		promptTokens += row.prompt;
	}
	const users = database
		.query<{ bucket: number; chars: number }, [string, number]>(
			`SELECT (timestamp / ${bucketMs}) * ${bucketMs} AS bucket, TOTAL(chars) AS chars
			 FROM user_messages WHERE session_file = ? AND timestamp >= ? GROUP BY 1`,
		)
		.all(sessionFile, cutoff);
	for (const row of users) bucket(row.bucket)[2] += row.chars;
	return { buckets, totalTokens, promptTokens };
}

type ShareGroup = SpotlightSharePoint["group"];
const SHARE_GROUPS: readonly ShareGroup[] = ["shaped", "outside"];

interface ShareCell {
	sessions: number;
	toolTokens: number;
	contextTokens: number;
}

/** An experiment session as the share trend splits it: its activity from `markedAt` on is `shaped`. */
export interface ShareExperiment {
	markedAt: number;
	/** Prompt of its first request at or after the marker: the context shaping started from. */
	firstPrompt: number;
	/** Its facts from the marker (or the window start, if later) on. */
	facts: SessionFacts;
}

/** Whether a transcript of `agentType` is in `scope`; advisors only count under `all`. */
export function inAgentScope(scope: SpotlightAgentScope, agentType: AgentType): boolean {
	return scope === "all" || scope === agentType;
}

/**
 * Strategy 4 over every transcript of `scope` in the window. Totals come from the rollups; experiment sessions are
 * read raw (they are few) and subtracted to leave `outside`, so the cost does not grow with history. A transcript's
 * activity before its marker stays `outside`.
 */
export function computeShareSeries(
	database: Database,
	window: RangeWindow,
	experiments: ReadonlyMap<string, ShareExperiment>,
	scope: SpotlightAgentScope = "all",
	now = Date.now(),
): SpotlightSharePoint[] {
	const { bucketMs } = window;
	const cutoff = window.cutoff ?? 0;
	const agentTypes = new Map<string, AgentType>();
	const inScope = (sessionFile: string): boolean => {
		if (scope === "all") return true;
		let agentType = agentTypes.get(sessionFile);
		if (!agentType) {
			agentType = classifyAgentType(sessionFile);
			agentTypes.set(sessionFile, agentType);
		}
		return agentType === scope;
	};
	const cells = new Map<number, Record<ShareGroup, ShareCell>>();
	const cell = (bucket: number, group: ShareGroup): ShareCell => {
		let row = cells.get(bucket);
		if (!row) {
			row = {
				shaped: { sessions: 0, toolTokens: 0, contextTokens: 0 },
				outside: { sessions: 0, toolTokens: 0, contextTokens: 0 },
			};
			cells.set(bucket, row);
		}
		return row[group];
	};
	const bucketOf = (timestamp: number) => Math.floor(timestamp / bucketMs) * bucketMs;

	// Everything lands in `outside` first; experiment sessions are moved out below.
	for (const point of getContextFactSeries(database, window)) {
		if (!inAgentScope(scope, point.agentType)) continue;
		const tool = point.resultChars / CHARS_PER_TOKEN;
		const target = cell(point.bucket, "outside");
		target.toolTokens += tool;
		target.contextTokens += tool + point.outputTokens;
	}
	// User messages carry no agent type: a scoped trend classifies their transcripts.
	const users =
		scope === "all"
			? database
					.query<{ bucket: number; session_file: string; chars: number }, [number]>(
						`SELECT (timestamp / ${bucketMs}) * ${bucketMs} AS bucket, '' AS session_file, TOTAL(chars) AS chars
						 FROM user_messages WHERE timestamp >= ? GROUP BY 1`,
					)
					.all(cutoff)
			: database
					.query<{ bucket: number; session_file: string; chars: number }, [number]>(
						`SELECT (timestamp / ${bucketMs}) * ${bucketMs} AS bucket, session_file, TOTAL(chars) AS chars
						 FROM user_messages WHERE timestamp >= ? GROUP BY 1, 2`,
					)
					.all(cutoff);
	for (const row of users) {
		if (inScope(row.session_file)) cell(row.bucket, "outside").contextTokens += row.chars / CHARS_PER_TOKEN;
	}
	for (const [sessionFile, experiment] of experiments) {
		if (!inScope(sessionFile)) continue;
		for (const [bucket, [resultChars, output, userChars]] of experiment.facts.buckets) {
			const tool = resultChars / CHARS_PER_TOKEN;
			const context = tool + output + userChars / CHARS_PER_TOKEN;
			const into = cell(bucket, "shaped");
			into.toolTokens += tool;
			into.contextTokens += context;
			const from = cell(bucket, "outside");
			from.toolTokens = Math.max(0, from.toolTokens - tool);
			from.contextTokens = Math.max(0, from.contextTokens - context);
		}
	}
	const lastBucket = bucketOf(now);
	/** Count a session active in every bucket `[start, end]` overlaps within the window, starting from `prompt`. */
	const addSpan = (group: ShareGroup, start: number, end: number, prompt: number) => {
		if (start >= cutoff) cell(bucketOf(start), group).contextTokens += prompt;
		const to = Math.min(bucketOf(end), lastBucket);
		for (let bucket = bucketOf(Math.max(start, cutoff)); bucket <= to; bucket += bucketMs)
			cell(bucket, group).sessions++;
	};
	for (const span of getSessionSpans(database, window.cutoff)) {
		if (!inScope(span.sessionFile)) continue;
		const experiment = experiments.get(span.sessionFile);
		if (!experiment || span.startedAt >= experiment.markedAt) {
			addSpan(experiment ? "shaped" : "outside", span.startedAt, span.endedAt, span.firstPrompt);
			continue;
		}
		// A resumed pre-experiment session: its history before the marker is outside the experiment.
		if (experiment.markedAt > cutoff) {
			addSpan("outside", span.startedAt, Math.min(span.endedAt, experiment.markedAt - 1), span.firstPrompt);
		}
		if (span.endedAt >= experiment.markedAt) {
			addSpan("shaped", experiment.markedAt, span.endedAt, experiment.firstPrompt);
		}
	}

	const points: SpotlightSharePoint[] = [];
	for (const bucket of [...cells.keys()].sort((a, b) => a - b)) {
		const row = cells.get(bucket);
		if (!row) continue;
		for (const group of SHARE_GROUPS) {
			const c = row[group];
			points.push({
				timestamp: bucket,
				group,
				sessions: c.sessions,
				toolTokens: Math.round(c.toolTokens),
				contextTokens: Math.round(c.contextTokens),
			});
		}
	}
	return points;
}

function loadSessions(database: Database): SessionRow[] {
	return database
		.query<SessionRow, []>(
			"SELECT session_file, folder, marked_at, cwd, title FROM spotlight_sessions ORDER BY marked_at",
		)
		.all();
}

function summarize(analysis: SessionAnalysis): SpotlightSessionSummary {
	let savedTokens = 0;
	let savedUsd = 0;
	let recoveryUsd = 0;
	let spotlightUsd = 0;
	const turnEntries = new Set<string>();
	for (const call of analysis.calls) {
		if (call.result) spotlightUsd += call.result.spotlightUsd;
		if (call.result?.shortened) {
			savedTokens += call.result.savedTokens;
			savedUsd += call.savedCarryUsd;
		}
		if (call.recovery) {
			recoveryUsd += call.recoveryCarryUsd;
			if (call.recovery.turn) turnEntries.add(call.entryId);
		}
	}
	for (const entry of turnEntries) recoveryUsd += analysis.costByEntry.get(entry) ?? 0;
	return {
		sessionFile: analysis.session.session_file,
		title: analysis.session.title,
		folder: analysis.session.folder,
		agentType: analysis.agentType,
		startedAt: analysis.session.marked_at,
		requests: analysis.requests.length,
		savedTokens,
		netUsd: savedUsd - recoveryUsd - spotlightUsd,
	};
}

/** Latest request or tool call of the session; 0 for none (a fork holding only copied entries). */
function lastActivity(analysis: SessionAnalysis): number {
	let last = analysis.requests.at(-1)?.timestamp ?? 0;
	for (const call of analysis.calls) last = Math.max(last, call.result?.timestamp ?? call.timestamp);
	return last;
}

function emptyDashboard(experimentStart: number | null): SpotlightDashboardStats {
	return {
		sessions: 0,
		experimentStart,
		gross: {
			...emptyToolTotals(),
			ofToolOutput: null,
			ofSessionTokens: null,
			byTool: [],
			estimatedPlain: 0,
			widerThanPlain: 0,
		},
		clawback: emptyClawback(),
		compounding: {
			avoidedTokens: 0,
			recoveredCarriedTokens: 0,
			promptTokens: 0,
			avoidedShare: null,
			savedUsd: 0,
			recoveryUsd: 0,
			spotlightUsd: 0,
			netUsd: 0,
			shapeMs: 0,
		},
		series: [],
		share: [],
		recent: [],
		sessionList: [],
		holdouts: 0,
		scoreFree: 0,
		adjusted: emptyAdjusted(),
		ranking: emptyRanking(),
		steps: [],
		timeCost: computeTimeCost([], 0),
		coverage: [],
		fetchBack: [],
		economics: [],
		gaps: [],
		overhead: computeOverhead([]),
	};
}

/** Per-tool totals as rows, the largest saving first (then the most results, then by name). */
function toolRows(byTool: ReadonlyMap<SpotlightTool, SpotlightToolTotals>): SpotlightToolRow[] {
	return [...byTool]
		.map(([tool, totals]) => ({ tool, ...totals }))
		.sort((a, b) => b.savedTokens - a.savedTokens || b.results - a.results || a.tool.localeCompare(b.tool));
}

function emptyClawback(): SpotlightClawback {
	return {
		...emptyRecoveryTotals(),
		withHidden: 0,
		recovered: 0,
		byKind: { artifact: emptyRecoveryTotals(), reread: emptyRecoveryTotals(), rerun: emptyRecoveryTotals() },
		netTokens: 0,
	};
}

/** Count an evaluated result; a held-out or gated one as the model saw it, `plain`'s text, saving nothing. */
function addTotals(into: SpotlightToolTotals, result: Result): void {
	into.results++;
	into.inTokens += result.inTokens;
	into.plainTokens += result.plainTokens;
	if (result.holdout || result.gated) {
		into.outTokens += result.plainTokens;
		return;
	}
	into.outTokens += result.outTokens;
	if (!result.shortened) return;
	into.shaped++;
	into.savedTokens += result.savedTokens;
	into.fullSavedTokens += result.fullSavedTokens;
}

/** Build the dashboard payload for a window and agent scope; `now` pins the series end (tests). */
export function buildSpotlightDashboard(
	database: Database,
	window: RangeWindow,
	scope: SpotlightAgentScope = "all",
	now = Date.now(),
): SpotlightDashboardStats {
	const sessions = loadSessions(database);
	const experimentStart = sessions.length > 0 ? sessions[0].marked_at : null;
	const cutoff = window.cutoff ?? 0;
	const { bucketMs } = window;
	const bucketOf = (timestamp: number) => Math.floor(timestamp / bucketMs) * bucketMs;
	const stats = emptyDashboard(experimentStart);

	const loader = new SessionLoader(database);
	const active: SessionAnalysis[] = [];
	for (const session of sessions) {
		const analysis = loader.analyze(session);
		if (!inAgentScope(scope, analysis.agentType)) continue;
		const last = lastActivity(analysis);
		if (last > 0 && last >= cutoff) active.push(analysis);
	}

	// Only activity from the marker on is the experiment's.
	const experiments = new Map<string, ShareExperiment>();
	for (const analysis of active) {
		const file = analysis.session.session_file;
		experiments.set(file, {
			markedAt: analysis.session.marked_at,
			firstPrompt: analysis.requests[0]?.context ?? 0,
			facts: loadSessionFacts(database, file, Math.max(cutoff, analysis.session.marked_at), bucketMs),
		});
	}
	stats.share = computeShareSeries(database, window, experiments, scope, now);
	if (active.length === 0) return stats;

	const series = new Map<number, SpotlightBucket>();
	const seriesStart = bucketOf(window.cutoff ?? experimentStart ?? now);
	for (let bucket = seriesStart; bucket <= bucketOf(now); bucket += bucketMs) series.set(bucket, emptyBucket(bucket));
	const bucket = (timestamp: number): SpotlightBucket => {
		const key = bucketOf(timestamp);
		let point = series.get(key);
		if (!point) {
			point = emptyBucket(key);
			series.set(key, point);
		}
		return point;
	};

	const { gross, clawback, compounding } = stats;
	const recent: { call: Call; analysis: SessionAnalysis }[] = [];
	const evaluated: Evaluated[] = [];
	const byTool = new Map<SpotlightTool, SpotlightToolTotals>();
	const money: SessionMoney[] = [];
	let toolTokens = 0;
	let sessionTokens = 0;

	for (const analysis of active) {
		stats.sessions++;
		const sessionFacts = experiments.get(analysis.session.session_file)?.facts;
		sessionTokens += sessionFacts?.totalTokens ?? 0;
		compounding.promptTokens += sessionFacts?.promptTokens ?? 0;

		const turnsCounted = new Set<string>();
		const sessionMoney: SessionMoney = {
			sessionFile: analysis.session.session_file,
			savedTokens: 0,
			savedUsd: 0,
			recoveryUsd: 0,
			spotlightUsd: 0,
		};
		money.push(sessionMoney);
		for (const call of analysis.calls) {
			const inRange = call.timestamp >= cutoff;
			if (inRange && Number.isFinite(call.seq)) toolTokens += call.tokens;
			const result = call.result;
			if (result && result.timestamp >= cutoff) {
				addTotals(gross, result);
				let toolTotals = byTool.get(result.tool);
				if (!toolTotals) {
					toolTotals = emptyToolTotals();
					byTool.set(result.tool, toolTotals);
				}
				addTotals(toolTotals, result);
				evaluated.push({ call, result, analysis, tool: result.tool });
				if (result.shortened && result.plainEstimated) gross.estimatedPlain++;
				if (result.widerThanPlain) gross.widerThanPlain++;
				if (result.shortened && result.scoreFree) stats.scoreFree++;
				compounding.spotlightUsd += result.spotlightUsd;
				sessionMoney.spotlightUsd += result.spotlightUsd;
				compounding.shapeMs += result.shapeMs ?? 0;
				const point = bucket(result.timestamp);
				point.results++;
				point.netUsd -= result.spotlightUsd;
				if (result.holdout) {
					stats.holdouts++;
					recent.push({ call, analysis });
				}
				if (result.shortened) {
					point.shaped++;
					point.savedTokens += result.savedTokens;
					point.netTokens += result.savedTokens;
					point.savedUsd += call.savedCarryUsd;
					point.netUsd += call.savedCarryUsd;
					compounding.avoidedTokens += call.savedCarry;
					compounding.savedUsd += call.savedCarryUsd;
					sessionMoney.savedTokens += result.savedTokens;
					sessionMoney.savedUsd += call.savedCarryUsd;
					recent.push({ call, analysis });
					if (result.hiddenLines > 0) {
						clawback.withHidden++;
						if (call.recoveredBy.length > 0) clawback.recovered++;
					}
				}
			}
			const recovery = call.recovery;
			if (!recovery || !inRange) continue;
			const kind = clawback.byKind[recovery.kind];
			for (const totals of [clawback, kind]) {
				totals.events++;
				totals.tokens += call.tokens;
				totals.usd += call.recoveryCarryUsd;
			}
			compounding.recoveredCarriedTokens += call.recoveryCarry;
			compounding.recoveryUsd += call.recoveryCarryUsd;
			sessionMoney.recoveryUsd += call.recoveryCarryUsd;
			const point = bucket(call.timestamp);
			point.recoveries++;
			point.recoveredTokens += call.tokens;
			point.netTokens -= call.tokens;
			point.netUsd -= call.recoveryCarryUsd;
			if (recovery.turn && !turnsCounted.has(call.entryId)) {
				turnsCounted.add(call.entryId);
				const turnUsd = analysis.costByEntry.get(call.entryId) ?? 0;
				for (const totals of [clawback, kind]) {
					totals.turns++;
					totals.turnsUsd += turnUsd;
				}
				compounding.recoveryUsd += turnUsd;
				sessionMoney.recoveryUsd += turnUsd;
				point.netUsd -= turnUsd;
			}
		}
	}

	gross.byTool = toolRows(byTool);
	const tools = gross.byTool.map(row => row.tool);
	gross.ofToolOutput =
		gross.savedTokens + toolTokens > 0 ? gross.savedTokens / (gross.savedTokens + toolTokens) : null;
	gross.ofSessionTokens = sessionTokens > 0 ? gross.savedTokens / sessionTokens : null;
	clawback.netTokens = gross.savedTokens - clawback.tokens;
	const avoidedNet = compounding.avoidedTokens - compounding.recoveredCarriedTokens;
	const shareDen = compounding.promptTokens + avoidedNet;
	compounding.avoidedShare = shareDen > 0 ? avoidedNet / shareDen : null;
	compounding.netUsd = compounding.savedUsd - compounding.recoveryUsd - compounding.spotlightUsd;

	stats.series = [...series.values()].sort((a, b) => a.timestamp - b.timestamp);
	recent.sort((a, b) => (b.call.result?.timestamp ?? 0) - (a.call.result?.timestamp ?? 0));
	stats.recent = recent.slice(0, RECENT_LIMIT).map(({ call, analysis }) => toResultRow(call, analysis));
	stats.sessionList = active
		.toSorted((a, b) => lastActivity(b) - lastActivity(a))
		.slice(0, SESSION_LIST_LIMIT)
		.map(summarize);
	stats.fetchBack = computeFetchBack(evaluated, tools);
	stats.economics = computeEconomics(evaluated, active, tools);
	stats.gaps = computeGaps(evaluated, tools);
	stats.overhead = computeOverhead(evaluated);
	stats.adjusted = computeAdjusted(evaluated, money, gross.savedTokens, compounding, tools);
	stats.ranking = computeRanking(evaluated);
	stats.steps = computeSteps(evaluated, holdoutBaselines(evaluated), tools);
	stats.timeCost = computeTimeCost(active, cutoff);
	stats.coverage = computeCoverage(database, active, cutoff, new Set(tools));
	return stats;
}

// ---------------------------------------------------------------------------
// Fetch-backs, economics, gaps, overhead
// ---------------------------------------------------------------------------

/** An evaluated result in the range. */
export interface Evaluated {
	call: Call;
	result: Result;
	analysis: SessionAnalysis;
	tool: SpotlightTool;
}

function sizeBin(tokens: number): number {
	const bin = SIZE_BIN_BOUNDS.findIndex(bound => tokens < bound);
	return bin === -1 ? SIZE_BIN_BOUNDS.length : bin;
}

/** Per-session fetch-back counts of one group, by original-size bin. */
interface FetchBackCluster {
	fetched: number[];
	results: number[];
}

/**
 * Σ weight × bin rate / Σ weight over the bins with results; null without any. `weights` is the applied cuts' size
 * mix, so a reference standardized this way compares like with like.
 */
function standardizedRate(
	fetched: readonly number[],
	results: readonly number[],
	weights: readonly number[],
): number | null {
	let rate = 0;
	let weight = 0;
	for (let bin = 0; bin < weights.length; bin++) {
		if (results[bin] === 0 || weights[bin] === 0) continue;
		rate += (weights[bin] * fetched[bin]) / results[bin];
		weight += weights[bin];
	}
	return weight > 0 ? rate / weight : null;
}

/**
 * The reference group's fetch-back rate standardized to `weights`, bootstrapped over sessions (bins a resample
 * lacks drop from both sides).
 */
function standardizedEstimate(
	clusters: readonly FetchBackCluster[],
	weights: readonly number[],
	key: string,
): SpotlightEstimate {
	const bins = weights.length;
	const sum = (sample: readonly FetchBackCluster[]): [number[], number[]] => {
		const fetched = Array.from({ length: bins }, () => 0);
		const results = Array.from({ length: bins }, () => 0);
		for (const cluster of sample) {
			for (let bin = 0; bin < bins; bin++) {
				fetched[bin] += cluster.fetched[bin];
				results[bin] += cluster.results[bin];
			}
		}
		return [fetched, results];
	};
	const value = standardizedRate(...sum(clusters), weights);
	if (value === null || clusters.length < BOOTSTRAP_MIN_SESSIONS) return { value, lo: null, hi: null };
	return {
		value,
		...bootstrapInterval(key, random => {
			const sample = Array.from(clusters, () => clusters[Math.floor(random() * clusters.length)]);
			return standardizedRate(...sum(sample), weights);
		}),
	};
}

/** A result's fetch-back group; null for a cut the no-score fallback made because Spotlight's calls failed. */
function cutGroup(result: Result): SpotlightCutGroup | null {
	if (result.holdout) return "holdout";
	if (result.gated) return "gated";
	if (!result.shortened) return "reference";
	if (result.scoreFree) return "scoreFree";
	return result.failed ? null : "applied";
}

/**
 * Fetch-back rates per tool (in `tools` order): applied (Spotlight-scored) cuts, score-free cuts, held-out results,
 * unchanged results standardized to the applied cuts' original-size mix (bins without unchanged results drop from
 * both; with no applied cuts, the reference keeps its own mix), and reads pi's former edit gate kept whole (only
 * where there are any). Results without a recorded call (issued before the session's marker) and cuts whose
 * Spotlight calls failed are not measured.
 */
function computeFetchBack(evaluated: readonly Evaluated[], tools: readonly SpotlightTool[]): SpotlightFetchBackCell[] {
	const cells: SpotlightFetchBackCell[] = [];
	const bins = SIZE_BIN_BOUNDS.length + 1;
	for (const tool of tools) {
		const groups: Record<SpotlightCutGroup, Map<string, FetchBackCluster>> = {
			applied: new Map(),
			holdout: new Map(),
			reference: new Map(),
			scoreFree: new Map(),
			gated: new Map(),
		};
		let measured = 0;
		for (const item of evaluated) {
			if (item.tool !== tool || !Number.isFinite(item.call.seq)) continue;
			const group = cutGroup(item.result);
			if (!group) continue;
			const file = item.analysis.session.session_file;
			let cluster = groups[group].get(file);
			if (!cluster) {
				cluster = {
					fetched: Array.from({ length: bins }, () => 0),
					results: Array.from({ length: bins }, () => 0),
				};
				groups[group].set(file, cluster);
			}
			const bin = sizeBin(item.result.inTokens);
			cluster.results[bin]++;
			if (item.call.fetchBackGap !== null) cluster.fetched[bin]++;
			measured++;
		}
		if (measured === 0) continue;
		const total = (cluster: FetchBackCluster, keep: (bin: number) => boolean): [number, number] => {
			let fetched = 0;
			let results = 0;
			for (let bin = 0; bin < bins; bin++) {
				if (!keep(bin)) continue;
				fetched += cluster.fetched[bin];
				results += cluster.results[bin];
			}
			return [fetched, results];
		};
		for (const group of ["applied", "holdout", "scoreFree", "gated"] as const) {
			// Only reads are gated: the group is listed where it has results.
			if (group === "gated" && groups.gated.size === 0) continue;
			const clusters = [...groups[group].values()];
			const pairs = clusters.map(cluster => total(cluster, () => true));
			cells.push({
				tool,
				group,
				results: pairs.reduce((sum, [, results]) => sum + results, 0),
				sessions: clusters.length,
				rate: bootstrapRatio(pairs, `fetchBack:${tool}:${group}`),
			});
		}
		const appliedMix = Array.from({ length: bins }, () => 0);
		for (const cluster of groups.applied.values()) {
			for (let bin = 0; bin < bins; bin++) appliedMix[bin] += cluster.results[bin];
		}
		const referenceMix = Array.from({ length: bins }, () => 0);
		for (const cluster of groups.reference.values()) {
			for (let bin = 0; bin < bins; bin++) referenceMix[bin] += cluster.results[bin];
		}
		const weights = appliedMix.some(count => count > 0) ? appliedMix : referenceMix;
		const kept = [...groups.reference.values()].filter(cluster => total(cluster, bin => weights[bin] > 0)[1] > 0);
		cells.push({
			tool,
			group: "reference",
			results: kept.reduce((sum, cluster) => sum + total(cluster, bin => weights[bin] > 0)[1], 0),
			sessions: kept.length,
			rate: standardizedEstimate(kept, weights, `fetchBack:${tool}:reference`),
		});
	}
	return cells;
}

/**
 * Requests that did nothing but recover output applied cuts hid, shared among their calls' sources: a request of
 * two such calls adds half a turn (and half its cost) to each call's cut.
 */
function extraTurnShares(analysis: SessionAnalysis): Map<Call, { turns: number; usd: number }> {
	const byEntry = new Map<string, Call[]>();
	for (const call of analysis.calls) {
		if (!call.recovery?.source.result?.shortened || !call.entryId) continue;
		const calls = byEntry.get(call.entryId);
		if (calls) calls.push(call);
		else byEntry.set(call.entryId, [call]);
	}
	const shares = new Map<Call, { turns: number; usd: number }>();
	for (const [entryId, calls] of byEntry) {
		if (calls.length !== calls[0].callsInTurn) continue;
		const usd = analysis.costByEntry.get(entryId) ?? 0;
		for (const call of calls) {
			const source = call.recovery?.source;
			if (!source) continue;
			const share = shares.get(source) ?? { turns: 0, usd: 0 };
			share.turns += 1 / calls.length;
			share.usd += usd / calls.length;
			shares.set(source, share);
		}
	}
	return shares;
}

/** What the cuts of each tool (in `tools` order) earned; tools without applied cuts are left out. */
function computeEconomics(
	evaluated: readonly Evaluated[],
	active: readonly SessionAnalysis[],
	tools: readonly SpotlightTool[],
): SpotlightCutEconomics[] {
	const shares = new Map<Call, { turns: number; usd: number }>();
	for (const analysis of active) {
		for (const [source, share] of extraTurnShares(analysis)) shares.set(source, share);
	}
	const cells: SpotlightCutEconomics[] = [];
	for (const tool of tools) {
		const cell: SpotlightCutEconomics = {
			tool,
			cuts: 0,
			savedTokens: 0,
			recoveredTokens: 0,
			extraTurns: 0,
			savedUsd: 0,
			recoveryUsd: 0,
			turnUsd: 0,
			netUsd: 0,
			extraTurnsPer100Cuts: 0,
			netUsdPer100Cuts: 0,
		};
		let spotlightUsd = 0;
		for (const { call, result, ...item } of evaluated) {
			if (item.tool !== tool) continue;
			// The bill covers every evaluated result: the cuts cannot be had without evaluating the rest.
			spotlightUsd += result.spotlightUsd;
			if (!result.shortened) continue;
			cell.cuts++;
			cell.savedTokens += result.savedTokens;
			cell.savedUsd += call.savedCarryUsd;
			for (const recovered of call.recoveredBy) {
				cell.recoveredTokens += recovered.tokens;
				cell.recoveryUsd += recovered.recoveryCarryUsd;
			}
			const share = shares.get(call);
			if (share) {
				cell.extraTurns += share.turns;
				cell.turnUsd += share.usd;
			}
		}
		if (cell.cuts === 0) continue;
		cell.netUsd = cell.savedUsd - cell.recoveryUsd - cell.turnUsd - spotlightUsd;
		cell.extraTurnsPer100Cuts = (cell.extraTurns * 100) / cell.cuts;
		cell.netUsdPer100Cuts = (cell.netUsd * 100) / cell.cuts;
		cells.push(cell);
	}
	return cells;
}

function gapBin(gap: number): SpotlightGapBin {
	if (gap <= 3) return GAP_BINS[Math.max(0, gap - 1)];
	return gap <= 6 ? "4–6" : "7–12";
}

/**
 * First fetch-backs of applied cuts and held-out results per tool (in `tools` order) and gap bin: every bin of each
 * tool with at least one.
 */
function computeGaps(evaluated: readonly Evaluated[], tools: readonly SpotlightTool[]): SpotlightGapCount[] {
	const counts = new Map<SpotlightTool, SpotlightGapCount[]>();
	for (const { call, result, tool } of evaluated) {
		if (call.fetchBackGap === null || !Number.isFinite(call.seq)) continue;
		const group = result.shortened ? "applied" : result.holdout ? "holdout" : null;
		if (!group) continue;
		let bins = counts.get(tool);
		if (!bins) {
			bins = GAP_BINS.map(gap => ({ tool, gap, applied: 0, holdout: 0 }));
			counts.set(tool, bins);
		}
		bins[GAP_BINS.indexOf(gapBin(call.fetchBackGap))][group]++;
	}
	return tools.flatMap(tool => counts.get(tool) ?? []);
}

/** Shaping time, Spotlight latency, failures and bill over every evaluated result. */
function computeOverhead(evaluated: readonly Evaluated[]): SpotlightOverhead {
	const shapeMs: number[] = [];
	const spotlightMs: number[] = [];
	let failed = 0;
	let failedWaitMs = 0;
	let called = 0;
	let spotlightUsd = 0;
	for (const { result } of evaluated) {
		spotlightUsd += result.spotlightUsd;
		if (result.shapeMs !== null) shapeMs.push(result.shapeMs);
		if (result.spotlightCalls > 0) {
			called++;
			if (result.spotlightFailures > 0) {
				// A failed call records no Spotlight time; its wait shows in the shaping time instead.
				failed++;
				failedWaitMs += result.shapeMs ?? 0;
			} else {
				spotlightMs.push(result.spotlightMs);
			}
		}
	}
	shapeMs.sort((a, b) => a - b);
	spotlightMs.sort((a, b) => a - b);
	const at = (sorted: readonly number[], p: number) => (sorted.length > 0 ? quantile(sorted, p) : null);
	return {
		results: evaluated.length,
		shapeMsP50: at(shapeMs, 0.5),
		shapeMsP90: at(shapeMs, 0.9),
		spotlightMsP50: at(spotlightMs, 0.5),
		spotlightMsP90: at(spotlightMs, 0.9),
		failureRate: called > 0 ? failed / called : null,
		failedWaitMs,
		spotlightUsd,
	};
}

function toResultRow(call: Call, analysis: SessionAnalysis): SpotlightResultRow {
	const result = call.result;
	if (!result) throw new Error("spotlight: result row without a result");
	const recoveries = call.recoveredBy.flatMap(recovered =>
		recovered.recovery ? [toRecovery(recovered, recovered.recovery)] : [],
	);
	return {
		sessionFile: analysis.session.session_file,
		toolCallId: call.id,
		timestamp: result.timestamp,
		tool: result.tool,
		holdout: result.holdout,
		target: displayTarget(call),
		inTokens: result.inTokens,
		outTokens: result.outTokens,
		savedTokens: result.savedTokens,
		hiddenLines: result.hiddenLines,
		steps: result.steps,
		spotlightUsd: result.spotlightUsd,
		shapeMs: result.shapeMs ?? 0,
		plainTokens: result.plainTokens,
		scoreFree: result.scoreFree,
		recoveries,
		netTokens: result.savedTokens - recoveries.reduce((total, r) => total + r.tokens, 0),
	};
}

/** Per-request context of one session with and without its net savings. */
function contextPoints(analysis: SessionAnalysis): SpotlightContextPoint[] {
	const landed = analysis.calls
		.map(call => ({
			timestamp: call.result?.timestamp ?? call.timestamp,
			saved: call.result?.shortened ? call.result.savedTokens : 0,
			recovered: call.recovery ? call.tokens : 0,
		}))
		.filter(item => item.saved !== 0 || item.recovered !== 0)
		.sort((a, b) => a.timestamp - b.timestamp);
	const points: SpotlightContextPoint[] = [];
	let next = 0;
	let net = 0;
	for (const request of analysis.requests) {
		let saved = 0;
		let recovered = 0;
		while (next < landed.length && landed[next].timestamp < request.timestamp) {
			saved += landed[next].saved;
			recovered += landed[next].recovered;
			next++;
		}
		net = request.compacted ? 0 : net + saved - recovered;
		points.push({
			timestamp: request.timestamp,
			contextTokens: request.context,
			withoutTokens: request.context + net,
			compacted: request.compacted,
			saved,
			recovered,
		});
	}
	return points;
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

/** `GET /api/stats/spotlight?range=&agent=`; an unknown `agent` measures every transcript. */
export async function getSpotlightDashboardStats(
	range?: string | null,
	agent?: string | null,
): Promise<SpotlightDashboardStats> {
	const database = await initDb();
	const scope: SpotlightAgentScope = agent === "main" || agent === "subagent" ? agent : "all";
	return buildSpotlightDashboard(database, getTimeRangeConfig(range), scope);
}

/** `GET /api/stats/spotlight/session?file=`; null when the file is not an experiment session. */
export async function getSpotlightSessionContext(sessionFile: string): Promise<SpotlightSessionContext | null> {
	const database = await initDb();
	const session = database
		.query<SessionRow, [string]>(
			"SELECT session_file, folder, marked_at, cwd, title FROM spotlight_sessions WHERE session_file = ?",
		)
		.get(sessionFile);
	if (!session) return null;
	const analysis = new SessionLoader(database).analyze(session);
	return { session: summarize(analysis), points: contextPoints(analysis) };
}
