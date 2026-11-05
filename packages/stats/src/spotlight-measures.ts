/**
 * The Spotlight dashboard's round-2 measures over the analyzed sessions of `spotlight-aggregator.ts`: the
 * holdout-adjusted net, ranking quality against the lines the agent needed later, step × size economics, time cost
 * and tool-output coverage. Metric definitions live on the types in `shared-types.ts`.
 */

import type { Database } from "bun:sqlite";
import type {
	SpotlightAdjusted,
	SpotlightAdjustedTool,
	SpotlightCompounding,
	SpotlightCoverageRow,
	SpotlightEstimate,
	SpotlightHeatPosition,
	SpotlightRanking,
	SpotlightRankingCell,
	SpotlightSizeBin,
	SpotlightStepCell,
	SpotlightTimeCost,
	SpotlightTool,
} from "./shared-types";
import type { Call, Evaluated, Result, SessionAnalysis } from "./spotlight-aggregator";
import {
	BOOTSTRAP_MIN_SESSIONS,
	bootstrapRatio,
	bootstrapRounds,
	jointSamples,
	percentileInterval,
} from "./spotlight-bootstrap";
import { mergeRanges } from "./spotlight-ingest";

const CHARS_PER_TOKEN = 4;
/** Holdouts per tool below which its baseline is too thin to trust. */
const MIN_HOLDOUTS = 30;
/** Step combinations with fewer cuts in the range fold into `other`. */
const MIN_STEP_CUTS = 10;
/** Original lines a trace's heat covers at most (pi's `SPOTLIGHT_VIEW_LINES`); later lines are unscored. */
const HEAT_LINES = 5_000;
/** The hottest share of a result's lines the top lift compares. */
const TOP_SHARE = 0.1;
/** Shortest shaped result the position profile reads. */
const POSITION_MIN_LINES = 40;
const SIZE_BINS: readonly { bin: SpotlightSizeBin; below: number }[] = [
	{ bin: "<250", below: 250 },
	{ bin: "250–1k", below: 1000 },
	{ bin: "1k–4k", below: 4000 },
	{ bin: "≥4k", below: Number.POSITIVE_INFINITY },
];

const NO_ESTIMATE: SpotlightEstimate = { value: null, lo: null, hi: null };

/** Recovered tokens of a cut: every recovery attributed to it. */
function recoveredTokens(call: Call): number {
	let tokens = 0;
	for (const recovered of call.recoveredBy) tokens += recovered.tokens;
	return tokens;
}

// ---------------------------------------------------------------------------
// Holdout-adjusted net
// ---------------------------------------------------------------------------

/** One experiment session's share of the range's savings and costs, for the adjusted net's joint bootstrap. */
export interface SessionMoney {
	sessionFile: string;
	savedTokens: number;
	savedUsd: number;
	/** Recovery tokens carried and priced plus extra-turn cost (its share of compounding.recoveryUsd). */
	recoveryUsd: number;
	spotlightUsd: number;
}

/** One tool's cuts and holdouts. */
interface ToolCell {
	cuts: number;
	recovered: number;
	holdouts: number;
	/** Would-be recovered tokens of the held-out results. */
	baseline: number;
}

/** Cells by tool. */
type ToolCells = Map<SpotlightTool, ToolCell>;

interface AdjustedSession {
	money: SessionMoney;
	tools: ToolCells;
}

/** Intervals of the adjusted net's statistics; `excess` by tool, in the order the tools were given. */
interface AdjustedIntervals {
	total: Pick<SpotlightEstimate, "lo" | "hi">;
	net: Pick<SpotlightEstimate, "lo" | "hi">;
	netUsd: Pick<SpotlightEstimate, "lo" | "hi">;
	excess: Pick<SpotlightEstimate, "lo" | "hi">[];
}

function emptyToolCell(): ToolCell {
	return { cuts: 0, recovered: 0, holdouts: 0, baseline: 0 };
}

/** The cell of `tool` in `cells`, created empty when missing. */
function toolCell(cells: ToolCells, tool: SpotlightTool): ToolCell {
	let cell = cells.get(tool);
	if (!cell) {
		cell = emptyToolCell();
		cells.set(tool, cell);
	}
	return cell;
}

/** Would-be recovered tokens per held-out cut of a cell: its holdouts' rate, 0 without any. */
function baselinePerCut(cell: ToolCell): number {
	return cell.holdouts > 0 ? cell.baseline / cell.holdouts : 0;
}

/**
 * Per-cut holdout baselines of the range's evaluated results (see {@link baselinePerCut}): what a cut of `tool`
 * gets fetched back anyway.
 */
export function holdoutBaselines(evaluated: readonly Evaluated[]): (tool: SpotlightTool) => number {
	const cells: ToolCells = new Map();
	for (const { call, result, tool } of evaluated) {
		if (!result.holdout) continue;
		const cell = toolCell(cells, tool);
		cell.holdouts++;
		cell.baseline += call.baselineTokens;
	}
	return tool => {
		const cell = cells.get(tool);
		return cell ? baselinePerCut(cell) : 0;
	};
}

export function emptyAdjusted(): SpotlightAdjusted {
	return {
		byTool: [],
		excessTokens: NO_ESTIMATE,
		netTokens: NO_ESTIMATE,
		netUsd: NO_ESTIMATE,
		minHoldouts: MIN_HOLDOUTS,
	};
}

/** Excess per tool of summed cells: max(0, recovered − baseline per cut × cuts). */
function excessOf(cells: ToolCells): Map<SpotlightTool, number> {
	const excess = new Map<SpotlightTool, number>();
	for (const [tool, cell] of cells) excess.set(tool, Math.max(0, cell.recovered - baselinePerCut(cell) * cell.cuts));
	return excess;
}

/** Add `cells` into `into`, tool by tool. */
function addCells(into: ToolCells, cells: ToolCells): void {
	for (const [tool, cell] of cells) {
		const sum = toolCell(into, tool);
		sum.cuts += cell.cuts;
		sum.recovered += cell.recovered;
		sum.holdouts += cell.holdouts;
		sum.baseline += cell.baseline;
	}
}

function sumOf(values: Iterable<number>): number {
	let sum = 0;
	for (const value of values) sum += value;
	return sum;
}

function recoveredOf(cells: ToolCells): number {
	let recovered = 0;
	for (const cell of cells.values()) recovered += cell.recovered;
	return recovered;
}

/**
 * Holdout-adjusted net savings: each tool's applied cuts (scored and score-free) recover tokens; held-out would-be
 * cuts of the same tool show how many the agent fetches back anyway. Intervals resample experiment sessions
 * jointly. `byTool` lists `tools` in their order.
 */
export function computeAdjusted(
	evaluated: readonly Evaluated[],
	money: readonly SessionMoney[],
	grossSavedTokens: number,
	compounding: SpotlightCompounding,
	tools: readonly SpotlightTool[],
): SpotlightAdjusted {
	const sessions = new Map<string, AdjustedSession>();
	for (const entry of money) sessions.set(entry.sessionFile, { money: entry, tools: new Map() });
	for (const { call, result, analysis, tool } of evaluated) {
		const session = sessions.get(analysis.session.session_file);
		if (!session || (!result.shortened && !result.holdout)) continue;
		const cell = toolCell(session.tools, tool);
		if (result.shortened) {
			cell.cuts++;
			cell.recovered += recoveredTokens(call);
		} else if (result.holdout) {
			cell.holdouts++;
			cell.baseline += call.baselineTokens;
		}
	}
	const list = [...sessions.values()];
	const totals: ToolCells = new Map();
	for (const session of list) addCells(totals, session.tools);
	const excess = excessOf(totals);
	const excessTotal = sumOf(excess.values());
	const recoveredTotal = recoveredOf(totals);
	const intervals = list.length >= BOOTSTRAP_MIN_SESSIONS ? adjustedIntervals(list, tools) : null;
	const estimate = (value: number, interval: Pick<SpotlightEstimate, "lo" | "hi"> | undefined): SpotlightEstimate =>
		interval ? { value, ...interval } : { value, lo: null, hi: null };

	const byTool: SpotlightAdjustedTool[] = tools.map((tool, k) => {
		const cell = totals.get(tool) ?? emptyToolCell();
		const pairs: [number, number][] = [];
		for (const session of list) {
			const own = session.tools.get(tool);
			if (own && own.holdouts > 0) pairs.push([own.baseline, own.holdouts]);
		}
		return {
			tool,
			cuts: cell.cuts,
			recoveredTokens: cell.recovered,
			holdouts: cell.holdouts,
			baselinePerCut: bootstrapRatio(pairs, `adjusted:baseline:${tool}`),
			excessTokens: estimate(excess.get(tool) ?? 0, intervals?.excess[k]),
		};
	});
	const ratio = recoveredTotal > 0 ? excessTotal / recoveredTotal : 0;
	return {
		byTool,
		excessTokens: estimate(excessTotal, intervals?.total),
		netTokens: estimate(grossSavedTokens - excessTotal, intervals?.net),
		netUsd: estimate(
			compounding.savedUsd - compounding.recoveryUsd * ratio - compounding.spotlightUsd,
			intervals?.netUsd,
		),
		minHoldouts: MIN_HOLDOUTS,
	};
}

/** Numbers per cell in {@link adjustedIntervals}' flat cell runs: tool index, cuts, recovered, holdouts, baseline. */
const RUN_FIELDS = 5;

/**
 * Intervals of the adjusted net's statistics from one joint bootstrap over the sessions: each round resamples them
 * and applies {@link excessOf}'s rule to the summed cells. Tools are indices and each session's cells one flat run,
 * so a round adds numbers instead of merging maps.
 */
function adjustedIntervals(list: readonly AdjustedSession[], tools: readonly SpotlightTool[]): AdjustedIntervals {
	const toolIndex = new Map<SpotlightTool, number>();
	const runs: number[] = [];
	const starts = new Uint32Array(list.length + 1);
	list.forEach((session, i) => {
		starts[i] = runs.length;
		for (const [tool, cell] of session.tools) {
			let index = toolIndex.get(tool);
			if (index === undefined) {
				index = toolIndex.size;
				toolIndex.set(tool, index);
			}
			runs.push(index, cell.cuts, cell.recovered, cell.holdouts, cell.baseline);
		}
	});
	starts[list.length] = runs.length;
	const toolSlot = tools.map(tool => toolIndex.get(tool) ?? -1);

	// cuts, recovered, holdouts, baseline per tool.
	const cells = new Float64Array(toolIndex.size * 4);
	const toolExcess = new Float64Array(toolIndex.size);
	const total = jointSamples();
	const net = jointSamples();
	const netUsd = jointSamples();
	const excess = tools.map(() => jointSamples());
	bootstrapRounds("adjusted", (random, r) => {
		cells.fill(0);
		let saved = 0;
		let savedUsd = 0;
		let recoveryUsd = 0;
		let spotlightUsd = 0;
		for (let i = 0; i < list.length; i++) {
			const pick = Math.floor(random() * list.length);
			const money = list[pick].money;
			saved += money.savedTokens;
			savedUsd += money.savedUsd;
			recoveryUsd += money.recoveryUsd;
			spotlightUsd += money.spotlightUsd;
			for (let at = starts[pick]; at < starts[pick + 1]; at += RUN_FIELDS) {
				const cell = runs[at] * 4;
				cells[cell] += runs[at + 1];
				cells[cell + 1] += runs[at + 2];
				cells[cell + 2] += runs[at + 3];
				cells[cell + 3] += runs[at + 4];
			}
		}
		let sum = 0;
		let recovered = 0;
		for (let t = 0; t < toolIndex.size; t++) {
			const holdouts = cells[t * 4 + 2];
			const perCut = holdouts > 0 ? cells[t * 4 + 3] / holdouts : 0;
			const toolSum = Math.max(0, cells[t * 4 + 1] - perCut * cells[t * 4]);
			toolExcess[t] = toolSum;
			sum += toolSum;
			recovered += cells[t * 4 + 1];
		}
		total[r] = sum;
		net[r] = saved - sum;
		netUsd[r] = savedUsd - recoveryUsd * (recovered > 0 ? sum / recovered : 0) - spotlightUsd;
		for (let k = 0; k < toolSlot.length; k++) excess[k][r] = toolSlot[k] < 0 ? 0 : toolExcess[toolSlot[k]];
	});
	return {
		total: percentileInterval(total),
		net: percentileInterval(net),
		netUsd: percentileInterval(netUsd),
		excess: excess.map(samples => percentileInterval(samples)),
	};
}

// ---------------------------------------------------------------------------
// Ranking quality
// ---------------------------------------------------------------------------

type RankingGroup = SpotlightRankingCell["group"];
const RANKING_GROUPS: readonly RankingGroup[] = ["applied", "holdout", "scoreFree"];

/** A shaped read's ranking group; null for a cut the no-score fallback made because Spotlight's calls failed. */
function rankingGroup(result: Result): RankingGroup | null {
	if (result.holdout) return "holdout";
	if (!result.shortened) return null;
	if (result.scoreFree) return "scoreFree";
	return result.failed ? null : "applied";
}

/** A line's heat digit (0–9); 0 for a line Spotlight never scored. */
function heatDigit(heat: string, i: number): number {
	const c = heat.charCodeAt(i);
	return c >= 48 && c <= 57 ? c - 48 : 0;
}

/** Per-session sums of one ranking cell (ratios of sums bootstrap over sessions). */
interface RankingSums {
	results: number;
	neededLines: number;
	aucSum: number;
	aucCount: number;
	topObserved: number;
	topExpected: number;
	keptObserved: number;
	keptExpected: number;
}

/** A mask over positions 1..n of the given 1-based ranges (index = position). */
function lineMask(n: number, ranges: readonly [number, number][]): Uint8Array {
	const mask = new Uint8Array(n + 1);
	for (const [a, b] of ranges) mask.fill(1, Math.max(1, a), Math.min(n, b) + 1);
	return mask;
}

export function emptyRanking(): SpotlightRanking {
	return { cells: [], position: [], sources: { reread: 0, edit: 0 } };
}

const POSITION_LABELS: readonly string[] = [
	"line 1",
	"lines 2–3",
	...Array.from({ length: 10 }, (_, d) => `${d * 10}–${(d + 1) * 10}%`),
];

/**
 * Ranking quality per group over shaped reads with needed lines (see {@link SpotlightRankingCell}), mean heat by
 * line position over every scored cut or would-be cut, and how the needs were observed.
 */
export function computeRanking(evaluated: readonly Evaluated[]): SpotlightRanking {
	const cells = new Map<RankingGroup, Map<string, RankingSums>>();
	const sources = { reread: 0, edit: 0 };
	const positionSum = new Float64Array(POSITION_LABELS.length);
	const positionLines = new Float64Array(POSITION_LABELS.length);
	for (const { result, analysis } of evaluated) {
		const n = result.lines;
		if ((result.shortened || result.holdout) && !result.scoreFree && n >= POSITION_MIN_LINES) {
			const m = Math.min(n, HEAT_LINES);
			for (let i = 0; i < Math.min(m, result.heat.length); i++) {
				const c = result.heat.charCodeAt(i);
				if (c < 48 || c > 57) continue;
				const slot = i === 0 ? 0 : i <= 2 ? 1 : 2 + Math.min(9, Math.floor((10 * i) / m));
				positionSum[slot] += c - 48;
				positionLines[slot]++;
			}
		}
		const group = rankingGroup(result);
		if (result.tool !== "read" || n <= 0 || !result.needs || !group) continue;
		const needed = lineMask(n, mergeRanges([...result.needs.reread, ...result.needs.edit]));
		let neededCount = 0;
		for (let p = 1; p <= n; p++) neededCount += needed[p];
		if (neededCount === 0) continue;
		if (result.needs.reread.some(([a, b]) => a <= n && b >= 1)) sources.reread++;
		if (result.needs.edit.some(([a, b]) => a <= n && b >= 1)) sources.edit++;

		let bySession = cells.get(group);
		if (!bySession) {
			bySession = new Map();
			cells.set(group, bySession);
		}
		const file = analysis.session.session_file;
		let sums = bySession.get(file);
		if (!sums) {
			sums = {
				results: 0,
				neededLines: 0,
				aucSum: 0,
				aucCount: 0,
				topObserved: 0,
				topExpected: 0,
				keptObserved: 0,
				keptExpected: 0,
			};
			bySession.set(file, sums);
		}
		sums.results++;
		sums.neededLines += neededCount;

		const kept = lineMask(n, result.kept);
		let keptCount = 0;
		let neededKept = 0;
		for (let p = 1; p <= n; p++) {
			keptCount += kept[p];
			neededKept += kept[p] & needed[p];
		}
		sums.keptObserved += neededKept;
		sums.keptExpected += (neededCount * keptCount) / n;

		if (group === "scoreFree") continue;
		const m = Math.min(n, HEAT_LINES);
		const all = new Float64Array(10);
		const need = new Float64Array(10);
		for (let i = 0; i < m; i++) {
			const d = heatDigit(result.heat, i);
			all[d]++;
			need[d] += needed[i + 1];
		}
		let neededIn = 0;
		for (const count of need) neededIn += count;
		const unneededIn = m - neededIn;
		if (neededIn > 0 && unneededIn > 0) {
			let below = 0;
			let concordant = 0;
			for (let d = 0; d < 10; d++) {
				const unneeded = all[d] - need[d];
				concordant += need[d] * below + 0.5 * need[d] * unneeded;
				below += unneeded;
			}
			sums.aucSum += concordant / (neededIn * unneededIn);
			sums.aucCount++;
		}
		if (neededIn > 0) {
			// The hottest k lines; ties at the boundary digit share the remaining places evenly.
			const k = Math.ceil(TOP_SHARE * m);
			let remaining = k;
			let observed = 0;
			for (let d = 9; d >= 0 && remaining > 0; d--) {
				const take = Math.min(remaining, all[d]);
				if (take > 0) observed += (take * need[d]) / all[d];
				remaining -= take;
			}
			sums.topObserved += observed;
			sums.topExpected += (k * neededIn) / m;
		}
	}

	const out: SpotlightRankingCell[] = RANKING_GROUPS.map(group => {
		const sessions = [...(cells.get(group)?.values() ?? [])];
		const scored = group !== "scoreFree";
		return {
			group,
			results: sessions.reduce((sum, s) => sum + s.results, 0),
			neededLines: sessions.reduce((sum, s) => sum + s.neededLines, 0),
			auc: scored
				? bootstrapRatio(
						sessions.map(s => [s.aucSum, s.aucCount]),
						`ranking:${group}:auc`,
					)
				: NO_ESTIMATE,
			topLift: scored
				? bootstrapRatio(
						sessions.map(s => [s.topObserved, s.topExpected]),
						`ranking:${group}:top`,
					)
				: NO_ESTIMATE,
			keptLift: bootstrapRatio(
				sessions.map(s => [s.keptObserved, s.keptExpected]),
				`ranking:${group}:kept`,
			),
		};
	});
	const position: SpotlightHeatPosition[] = POSITION_LABELS.map((label, slot) => ({
		label,
		meanHeat: positionLines[slot] > 0 ? positionSum[slot] / positionLines[slot] : 0,
		lines: positionLines[slot],
	}));
	return { cells: out, position, sources };
}

// ---------------------------------------------------------------------------
// Step economics
// ---------------------------------------------------------------------------

function sizeBin(savedTokens: number): SpotlightSizeBin {
	return (SIZE_BINS.find(({ below }) => savedTokens < below) ?? SIZE_BINS[SIZE_BINS.length - 1]).bin;
}

interface StepSums {
	tool: SpotlightTool;
	steps: string;
	size: SpotlightSizeBin;
	cuts: number;
	savedTokens: number;
	recoveredTokens: number;
	/** Σ each cut's holdout baseline: what its cuts get fetched back anyway. */
	anyway: number;
	/** Per session: [fetched, measured] (cuts with a recorded call). */
	fetchBacks: Map<string, [number, number]>;
}

/**
 * What each step combination earns per tool and saved-token bin over the range's cuts; combinations with
 * under {@link MIN_STEP_CUTS} cuts of a tool fold into `other`. The excess subtracts each cut's holdout baseline
 * ({@link holdoutBaselines}). Cells follow `tools`' order, then the most common combination first.
 */
export function computeSteps(
	evaluated: readonly Evaluated[],
	baselineOf: (tool: SpotlightTool) => number,
	tools: readonly SpotlightTool[],
): SpotlightStepCell[] {
	const cuts = evaluated.filter(item => item.result.shortened);
	const combos = new Map<string, number>();
	const comboOf = (item: Evaluated) => `${item.tool}\0${item.result.steps.join("+") || "none"}`;
	for (const item of cuts) combos.set(comboOf(item), (combos.get(comboOf(item)) ?? 0) + 1);
	const cells = new Map<string, StepSums>();
	for (const item of cuts) {
		const combo = comboOf(item);
		const steps = (combos.get(combo) ?? 0) >= MIN_STEP_CUTS ? combo.slice(item.tool.length + 1) : "other";
		const size = sizeBin(item.result.savedTokens);
		const key = `${item.tool}\0${steps}\0${size}`;
		let cell = cells.get(key);
		if (!cell) {
			cell = {
				tool: item.tool,
				steps,
				size,
				cuts: 0,
				savedTokens: 0,
				recoveredTokens: 0,
				anyway: 0,
				fetchBacks: new Map(),
			};
			cells.set(key, cell);
		}
		cell.cuts++;
		cell.savedTokens += item.result.savedTokens;
		cell.recoveredTokens += recoveredTokens(item.call);
		cell.anyway += baselineOf(item.tool);
		if (Number.isFinite(item.call.seq)) {
			const file = item.analysis.session.session_file;
			const pair = cell.fetchBacks.get(file) ?? [0, 0];
			if (item.call.fetchBackGap !== null) pair[0]++;
			pair[1]++;
			cell.fetchBacks.set(file, pair);
		}
	}
	const toolIndex = new Map(tools.map((tool, index) => [tool, index]));
	const toolOrder = (tool: SpotlightTool) => toolIndex.get(tool) ?? tools.length;
	const comboCuts = (cell: StepSums) =>
		cell.steps === "other" ? -1 : (combos.get(`${cell.tool}\0${cell.steps}`) ?? 0);
	const sizeOrder = (size: SpotlightSizeBin) => SIZE_BINS.findIndex(entry => entry.bin === size);
	return [...cells.values()]
		.sort(
			(a, b) =>
				toolOrder(a.tool) - toolOrder(b.tool) ||
				comboCuts(b) - comboCuts(a) ||
				a.steps.localeCompare(b.steps) ||
				sizeOrder(a.size) - sizeOrder(b.size),
		)
		.map(cell => {
			const excess = Math.max(0, cell.recoveredTokens - cell.anyway);
			return {
				tool: cell.tool,
				steps: cell.steps,
				size: cell.size,
				cuts: cell.cuts,
				fetchBackRate: bootstrapRatio(
					[...cell.fetchBacks.values()],
					`steps:${cell.tool}:${cell.steps}:${cell.size}`,
				),
				savedTokens: cell.savedTokens,
				recoveredTokens: cell.recoveredTokens,
				excessTokens: excess,
				keptShare: cell.savedTokens > 0 ? (cell.savedTokens - excess) / cell.savedTokens : null,
			};
		});
}

// ---------------------------------------------------------------------------
// Time cost and coverage
// ---------------------------------------------------------------------------

/**
 * Agent time of the experiment sessions in the range: the model time of their requests, of the requests that did
 * nothing but fetch back cut output, and the time tool calls spent shaping.
 */
export function computeTimeCost(active: readonly SessionAnalysis[], cutoff: number): SpotlightTimeCost {
	const cell: SpotlightTimeCost = { agentMs: 0, fetchBackTurns: 0, fetchBackMs: 0, shapeMs: 0, share: null };
	for (const analysis of active) {
		const requests = new Map(analysis.requests.map(request => [request.entryId, request]));
		for (const request of analysis.requests) if (request.timestamp >= cutoff) cell.agentMs += request.durationMs;
		const fetchBackCalls = new Map<string, { calls: number; callsInTurn: number }>();
		for (const call of analysis.calls) {
			const result = call.result;
			if (result && result.timestamp >= cutoff) cell.shapeMs += result.shapeMs ?? 0;
			if (!call.entryId || !call.recovery?.source.result?.shortened) continue;
			const entry = fetchBackCalls.get(call.entryId) ?? { calls: 0, callsInTurn: call.callsInTurn };
			entry.calls++;
			fetchBackCalls.set(call.entryId, entry);
		}
		for (const [entryId, entry] of fetchBackCalls) {
			const request = requests.get(entryId);
			if (entry.calls !== entry.callsInTurn || !request || request.timestamp < cutoff) continue;
			cell.fetchBackTurns++;
			cell.fetchBackMs += request.durationMs;
		}
	}
	cell.share = cell.agentMs > 0 ? (cell.fetchBackMs + cell.shapeMs) / cell.agentMs : null;
	return cell;
}

/**
 * Each tool's share of the tool output experiment sessions' models saw from their marker (and the range) on;
 * `shaped` marks the tools with evaluated results in the range.
 */
export function computeCoverage(
	database: Database,
	active: readonly SessionAnalysis[],
	cutoff: number,
	shaped: ReadonlySet<SpotlightTool>,
): SpotlightCoverageRow[] {
	const query = database.query<{ tool_name: string; calls: number; chars: number }, [string, number]>(
		`SELECT tool_name, COUNT(*) AS calls, TOTAL(result_chars) AS chars
		 FROM tool_calls WHERE session_file = ? AND timestamp >= ? GROUP BY tool_name`,
	);
	const byTool = new Map<string, { calls: number; chars: number }>();
	for (const analysis of active) {
		for (const row of query.all(analysis.session.session_file, Math.max(cutoff, analysis.session.marked_at))) {
			const entry = byTool.get(row.tool_name) ?? { calls: 0, chars: 0 };
			entry.calls += row.calls;
			entry.chars += row.chars;
			byTool.set(row.tool_name, entry);
		}
	}
	let total = 0;
	for (const entry of byTool.values()) total += entry.chars;
	return [...byTool]
		.map(([tool, entry]) => ({
			tool,
			shaped: shaped.has(tool),
			calls: entry.calls,
			tokens: Math.round(entry.chars / CHARS_PER_TOKEN),
			share: total > 0 ? entry.chars / total : 0,
		}))
		.sort((a, b) => b.tokens - a.tokens || a.tool.localeCompare(b.tool));
}
