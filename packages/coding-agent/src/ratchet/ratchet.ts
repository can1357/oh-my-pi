/**
 * Ratchet: host-side state, statistics, and keep/revert gate for the
 * `/ratchet` eval hillclimb. Everything the model must not be able to argue
 * with lives here — approval freshness (content hashes), the frozen split,
 * completeness and held-out leakage checks, and the round decision — so the
 * kernel facade only forwards arguments.
 *
 * On-disk layout (`.omp/ratchet/<flow>/`) follows the claude-api skill's eval
 * layout so its report builders can read it: `_state.json`, `baseline/`,
 * `v<N>/` each holding `results.jsonl`, optional `errors.jsonl`, and
 * `traces/<id>_rep<k>.json` (train cases only).
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { calculateUsageCost } from "@oh-my-pi/pi-catalog/models";
import type { ModelCost, Usage } from "@oh-my-pi/pi-catalog/types";
import { isEnoent, isRecord } from "@oh-my-pi/pi-utils";

export const RATCHET_ROOT = path.join(".omp", "ratchet");
export const RATCHET_STAGES = ["inputs", "grader", "plan"] as const;
export type RatchetStage = (typeof RATCHET_STAGES)[number];
export type Direction = "higher" | "lower";
export type RoundDecision = "baseline" | "keep" | "revert" | "rerun";
export type Verdict = "up" | "down" | "flat";

export interface RatchetGoal {
	/** Metric the loop optimizes: a `grade` key (`score` for scalar grades), `cost_usd`, `latency_s`, or a numeric row field. */
	target: string;
	direction: Direction;
	/** Guardrail metrics that must not regress outside noise. */
	hold: string[];
	/** Direction overrides for guardrails; `cost_usd`/`latency_s` default to lower, everything else to higher. */
	directions: Record<string, Direction>;
}

/** Per-million-token rates for a model the catalog cannot price. */
export interface RatchetPrice {
	in: number;
	out: number;
	cache_read?: number;
	cache_write?: number;
}

export interface SplitSummary {
	/** Cases with at least one scored rep. */
	n: number;
	mean: number | null;
	/** 95% CI half-width over case means; null below two cases. */
	half: number | null;
}

export interface PairedDelta extends SplitSummary {
	verdict: Verdict;
}

export interface RatchetRound {
	round: number;
	variant: string;
	change: string;
	decision: RoundDecision;
	reasons: string[];
	train: Record<string, SplitSummary>;
	test: Record<string, SplitSummary>;
	errors: number;
	truncated: number;
	at: string;
}

export interface RatchetState {
	version: 1;
	flow: string;
	cases_paths: string[];
	harness_paths: string[];
	change_paths: string[];
	off_limits: string[];
	/** Runner command; `{variant}` and `{flow_dir}` are substituted by `check`. */
	command?: string;
	goal?: RatchetGoal;
	reps?: number;
	stop: { plateau: number; rounds?: number };
	train_ids: string[];
	test_ids: string[];
	split_seed?: number;
	/** Inputs digest the baseline was run against; a different case set needs a new flow. */
	baseline_inputs_sha?: string;
	approvals: Partial<Record<RatchetStage, { sha: string; at: string }>>;
	rounds: RatchetRound[];
	best?: { round: number; variant: string; test_score: number | null };
	current_round: number;
	flat_rounds: number;
	prices: Record<string, RatchetPrice>;
}

/** Resolves a served model id to catalog rates; undefined when unknown or ambiguous. */
export type PriceLookup = (model: string) => ModelCost | undefined;

export interface GateResult {
	variant: string;
	decision: RoundDecision;
	reasons: string[];
	warnings: string[];
	deltas: Record<string, { train: PairedDelta; test: PairedDelta }>;
	best: RatchetState["best"];
	plateau: boolean;
	done: boolean;
	table: string;
}

const FLOW_NAME = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const VARIANT_NAME = /^(baseline|v[1-9][0-9]*)$/;
const LOWER_BY_DEFAULT: Record<string, true> = { cost_usd: true, latency_s: true };
// Two-sided 95% Student-t critical values for df 1..30; larger samples use the normal value.
const T_CRITICAL = [
	12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228, 2.201, 2.179, 2.16, 2.145, 2.131, 2.12, 2.11,
	2.101, 2.093, 2.086, 2.08, 2.074, 2.069, 2.064, 2.06, 2.056, 2.052, 2.048, 2.045, 2.042,
];

export class RatchetError extends Error {
	override name = "RatchetError";
}

function tCritical(df: number): number {
	return df >= 1 && df <= T_CRITICAL.length ? T_CRITICAL[df - 1]! : 1.96;
}

function meanAndHalf(values: readonly number[]): SplitSummary {
	const n = values.length;
	if (n === 0) return { n, mean: null, half: null };
	const mean = values.reduce((sum, value) => sum + value, 0) / n;
	if (n < 2) return { n, mean, half: null };
	const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (n - 1);
	return { n, mean, half: tCritical(n - 1) * Math.sqrt(variance / n) };
}

export function metricDirection(goal: RatchetGoal, metric: string): Direction {
	if (metric === goal.target) return goal.direction;
	return goal.directions[metric] ?? (LOWER_BY_DEFAULT[metric] ? "lower" : "higher");
}

// ---------------------------------------------------------------------------
// Paths and persistence
// ---------------------------------------------------------------------------

export function flowDir(cwd: string, flow: string): string {
	if (!FLOW_NAME.test(flow)) {
		throw new RatchetError(`Invalid flow name ${JSON.stringify(flow)}: use lowercase letters, digits, "-" or "_"`);
	}
	return path.join(cwd, RATCHET_ROOT, flow);
}

function toPosix(value: string): string {
	return value.split(path.sep).join("/");
}

/** Normalize a repo-relative path and reject anything that escapes the workspace. */
function normalizeRepoPath(cwd: string, value: string): string {
	const absolute = path.resolve(cwd, value);
	const relative = path.relative(cwd, absolute);
	if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
		throw new RatchetError(`Path must be inside the workspace: ${value}`);
	}
	return toPosix(relative);
}

async function pathExists(absolute: string): Promise<boolean> {
	try {
		await fs.stat(absolute);
		return true;
	} catch (err) {
		if (isEnoent(err)) return false;
		throw err;
	}
}

export async function loadState(cwd: string, flow: string): Promise<RatchetState | undefined> {
	try {
		return (await Bun.file(path.join(flowDir(cwd, flow), "_state.json")).json()) as RatchetState;
	} catch (err) {
		if (isEnoent(err)) return undefined;
		throw err;
	}
}

export async function requireState(cwd: string, flow: string): Promise<RatchetState> {
	const state = await loadState(cwd, flow);
	if (!state) throw new RatchetError(`Flow "${flow}" does not exist; call init() first`);
	return state;
}

export async function saveState(cwd: string, state: RatchetState): Promise<void> {
	await Bun.write(path.join(flowDir(cwd, state.flow), "_state.json"), `${JSON.stringify(state, null, 2)}\n`);
}

// ---------------------------------------------------------------------------
// Setup: init, plan, split
// ---------------------------------------------------------------------------

export interface InitOptions {
	cases: string[];
	harness: string[];
	change: string[];
	off_limits?: string[];
	command?: string;
}

export async function initFlow(cwd: string, flow: string, options: InitOptions): Promise<RatchetState> {
	const dir = flowDir(cwd, flow);
	const cases = options.cases.map(value => normalizeRepoPath(cwd, value));
	const harness = options.harness.map(value => normalizeRepoPath(cwd, value));
	const change = options.change.map(value => normalizeRepoPath(cwd, value));
	const offLimits = (options.off_limits ?? []).map(value => normalizeRepoPath(cwd, value));
	if (cases.length === 0) throw new RatchetError("init() needs at least one cases path");
	if (harness.length === 0) throw new RatchetError("init() needs at least one harness path (runner and grader)");
	if (change.length === 0) throw new RatchetError("init() needs at least one change path (the surface being tuned)");
	for (const file of [...cases, ...harness]) {
		if (!(await pathExists(path.join(cwd, file)))) throw new RatchetError(`Path does not exist: ${file}`);
	}
	const flowRel = toPosix(path.relative(cwd, dir));
	for (const target of change) {
		const frozen = [...cases, ...harness, ...offLimits, flowRel].find(
			other => target === other || target.startsWith(`${other}/`) || other.startsWith(`${target}/`),
		);
		if (frozen) {
			throw new RatchetError(
				`Change path ${target} overlaps ${frozen}; cases, harness, off-limits, and flow state must stay out of the tuned surface`,
			);
		}
	}
	const existing = await loadState(cwd, flow);
	const state: RatchetState = existing ?? {
		version: 1,
		flow,
		cases_paths: [],
		harness_paths: [],
		change_paths: [],
		off_limits: [],
		stop: { plateau: 3 },
		train_ids: [],
		test_ids: [],
		approvals: {},
		rounds: [],
		current_round: 0,
		flat_rounds: 0,
		prices: {},
	};
	state.cases_paths = cases;
	state.harness_paths = harness;
	state.change_paths = change;
	state.off_limits = offLimits;
	if (options.command !== undefined) state.command = options.command;
	await saveState(cwd, state);
	return state;
}

export interface PlanOptions {
	goal?: { target: string; direction?: Direction; hold?: string[]; directions?: Record<string, Direction> };
	reps?: number;
	stop?: { plateau?: number; rounds?: number };
	command?: string;
	prices?: Record<string, RatchetPrice>;
}

export function applyPlan(state: RatchetState, options: PlanOptions): void {
	const baselineTaken = state.rounds.length > 0;
	if (options.goal) {
		const goal: RatchetGoal = {
			target: options.goal.target,
			direction: options.goal.direction ?? (LOWER_BY_DEFAULT[options.goal.target] ? "lower" : "higher"),
			hold: options.goal.hold ?? [],
			directions: options.goal.directions ?? {},
		};
		if (goal.hold.includes(goal.target)) throw new RatchetError("goal.hold must not include the target metric");
		state.goal = goal;
	}
	if (options.reps !== undefined) {
		if (!Number.isInteger(options.reps) || options.reps < 1)
			throw new RatchetError("reps must be a positive integer");
		if (baselineTaken && state.reps !== undefined && options.reps < state.reps) {
			throw new RatchetError("reps cannot shrink after the baseline; rounds would stop being comparable");
		}
		state.reps = options.reps;
	}
	if (options.stop) {
		const plateau = options.stop.plateau ?? state.stop.plateau;
		if (!Number.isInteger(plateau) || plateau < 2) throw new RatchetError("stop.plateau must be an integer >= 2");
		const rounds = options.stop.rounds ?? state.stop.rounds;
		if (rounds !== undefined && (!Number.isInteger(rounds) || rounds < 1)) {
			throw new RatchetError("stop.rounds must be a positive integer");
		}
		state.stop = rounds === undefined ? { plateau } : { plateau, rounds };
	}
	if (options.command !== undefined) state.command = options.command;
	if (options.prices) state.prices = { ...state.prices, ...options.prices };
}

/** Seeded PRNG (mulberry32) so a recorded seed reproduces the split. */
function seededRandom(seed: number): () => number {
	let value = seed >>> 0;
	return () => {
		value = (value + 0x6d2b79f5) >>> 0;
		let t = value;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

/** Random train/test split stratified by primary tag; frozen once a baseline exists. */
export function splitCases(
	state: RatchetState,
	cases: Record<string, string>,
	testFraction = 0.4,
	seed: number = Math.floor(Math.random() * 2 ** 31),
): void {
	if (!(testFraction > 0 && testFraction < 1)) throw new RatchetError("test_fraction must be between 0 and 1");
	const ids = Object.keys(cases);
	if (ids.length < 4) throw new RatchetError("split() needs at least 4 cases; score the whole set instead");
	if (state.rounds.length > 0) {
		throw new RatchetError(
			"The split is frozen once the baseline is gated; re-splitting would invalidate every round",
		);
	}
	const random = seededRandom(seed);
	const byTag = new Map<string, string[]>();
	for (const id of ids.sort()) {
		const tag = cases[id] ?? "";
		const bucket = byTag.get(tag) ?? [];
		bucket.push(id);
		byTag.set(tag, bucket);
	}
	const train: string[] = [];
	const test: string[] = [];
	for (const bucket of byTag.values()) {
		for (let index = bucket.length - 1; index > 0; index--) {
			const swap = Math.floor(random() * (index + 1));
			[bucket[index], bucket[swap]] = [bucket[swap]!, bucket[index]!];
		}
		const testCount = Math.round(bucket.length * testFraction);
		test.push(...bucket.slice(0, testCount));
		train.push(...bucket.slice(testCount));
	}
	// Tiny tag buckets can round to an empty side; move one case so both splits exist.
	if (test.length === 0) test.push(train.pop()!);
	if (train.length === 0) train.push(test.pop()!);
	state.train_ids = train.sort();
	state.test_ids = test.sort();
	state.split_seed = seed;
}

// ---------------------------------------------------------------------------
// Approvals
// ---------------------------------------------------------------------------

async function listFiles(absolute: string): Promise<string[]> {
	const stat = await fs.stat(absolute);
	if (!stat.isDirectory()) return [absolute];
	const entries = await fs.readdir(absolute, { withFileTypes: true });
	const nested = await Promise.all(
		entries
			.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
			.map(entry => listFiles(path.join(absolute, entry.name))),
	);
	return nested.flat();
}

async function hashPaths(cwd: string, paths: readonly string[]): Promise<string> {
	const hasher = new Bun.CryptoHasher("sha256");
	for (const rel of [...paths].sort()) {
		const absolute = path.join(cwd, rel);
		if (!(await pathExists(absolute))) {
			hasher.update(`missing:${rel}\0`);
			continue;
		}
		for (const file of await listFiles(absolute)) {
			hasher.update(`${toPosix(path.relative(cwd, file))}\0`);
			hasher.update(new Uint8Array(await Bun.file(file).arrayBuffer()));
			hasher.update("\0");
		}
	}
	return hasher.digest("hex");
}

/** Content hash an approval of `stage` is bound to; any later edit makes the approval stale. */
export async function stageDigest(cwd: string, state: RatchetState, stage: RatchetStage): Promise<string> {
	switch (stage) {
		case "inputs":
			return hashPaths(cwd, state.cases_paths);
		case "grader":
			return hashPaths(cwd, state.harness_paths);
		case "plan": {
			if (!state.goal || state.reps === undefined || !state.command) {
				throw new RatchetError("The plan needs goal, reps, and command before it can be approved (call plan())");
			}
			if (state.train_ids.length === 0 || state.test_ids.length === 0) {
				throw new RatchetError("The plan needs a train/test split before it can be approved (call split())");
			}
			const plan = {
				goal: state.goal,
				reps: state.reps,
				stop: state.stop,
				command: state.command,
				change_paths: state.change_paths,
				off_limits: state.off_limits,
				train_ids: state.train_ids,
				test_ids: state.test_ids,
				// Price overrides decide cost guardrails, so changing them must re-open the plan.
				prices: Object.entries(state.prices)
					.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
					.map(([model, rate]) => [model, rate.in, rate.out, rate.cache_read ?? null, rate.cache_write ?? null]),
			};
			return new Bun.CryptoHasher("sha256").update(JSON.stringify(plan)).digest("hex");
		}
	}
}

export type ApprovalStatus = Record<RatchetStage, "missing" | "stale" | "current">;

export async function approvalStatus(cwd: string, state: RatchetState): Promise<ApprovalStatus> {
	const status = {} as ApprovalStatus;
	for (const stage of RATCHET_STAGES) {
		const recorded = state.approvals[stage];
		if (!recorded) {
			status[stage] = "missing";
			continue;
		}
		let digest: string | undefined;
		try {
			digest = await stageDigest(cwd, state, stage);
		} catch (err) {
			if (!(err instanceof RatchetError)) throw err;
		}
		status[stage] = digest === recorded.sha ? "current" : "stale";
	}
	return status;
}

export async function requireApprovals(cwd: string, state: RatchetState): Promise<void> {
	const status = await approvalStatus(cwd, state);
	const blocked = RATCHET_STAGES.filter(stage => status[stage] !== "current");
	if (blocked.length > 0) {
		const detail = blocked.map(stage => `${stage}: ${status[stage]}`).join(", ");
		throw new RatchetError(
			`Approvals are not current (${detail}). A stale approval means its files or plan changed after the user approved them; re-run approve() for each stage.`,
		);
	}
}

// ---------------------------------------------------------------------------
// Results, metrics, cost
// ---------------------------------------------------------------------------

interface ResultRow {
	prompt_id: string;
	rep: number;
	status?: string;
	[key: string]: unknown;
}

interface VariantData {
	rows: ResultRow[];
	errors: ResultRow[];
	traces: string[];
}

function parseJsonl(text: string, file: string): unknown[] {
	try {
		return Bun.JSONL.parse(text) as unknown[];
	} catch (err) {
		throw new RatchetError(`Malformed JSONL in ${file}: ${err instanceof Error ? err.message : String(err)}`);
	}
}

async function readJsonl(file: string): Promise<unknown[]> {
	try {
		return parseJsonl(await Bun.file(file).text(), file);
	} catch (err) {
		if (isEnoent(err)) return [];
		throw err;
	}
}

function asRow(value: unknown, file: string): ResultRow {
	if (!isRecord(value) || typeof value.prompt_id !== "string") {
		throw new RatchetError(`Every row in ${file} needs a string prompt_id`);
	}
	const rep = value.rep ?? 0;
	if (typeof rep !== "number" || !Number.isInteger(rep) || rep < 0) {
		throw new RatchetError(`Row ${value.prompt_id} in ${file} has an invalid rep`);
	}
	return { ...value, prompt_id: value.prompt_id, rep };
}

async function readVariant(dir: string, variant: string): Promise<VariantData> {
	const variantDir = path.join(dir, variant);
	const resultsFile = path.join(variantDir, "results.jsonl");
	if (!(await pathExists(resultsFile))) throw new RatchetError(`No results for ${variant}: ${resultsFile} is missing`);
	const rows = (await readJsonl(resultsFile)).map(value => asRow(value, resultsFile));
	const errorsFile = path.join(variantDir, "errors.jsonl");
	const errors = (await readJsonl(errorsFile)).map(value => asRow(value, errorsFile));
	let traces: string[] = [];
	try {
		traces = await fs.readdir(path.join(variantDir, "traces"));
	} catch (err) {
		if (!isEnoent(err)) throw err;
	}
	return { rows, errors, traces };
}

function firstNumber(record: Record<string, unknown>, keys: readonly string[]): number | undefined {
	for (const key of keys) {
		const value = record[key];
		if (typeof value === "number" && Number.isFinite(value)) return value;
	}
	return undefined;
}

/** Normalize Anthropic-, OpenAI-, and catalog-shaped usage blocks. */
export function normalizeUsage(raw: unknown): Usage | undefined {
	if (!isRecord(raw)) return undefined;
	let input = firstNumber(raw, ["input_tokens", "prompt_tokens", "input"]) ?? 0;
	const output = firstNumber(raw, ["output_tokens", "completion_tokens", "output"]) ?? 0;
	let cacheRead = firstNumber(raw, ["cache_read_input_tokens", "cache_read_tokens", "cacheRead"]) ?? 0;
	const cacheWrite = firstNumber(raw, ["cache_creation_input_tokens", "cache_write_tokens", "cacheWrite"]) ?? 0;
	// OpenAI counts cached prompt tokens inside prompt_tokens.
	const details = raw.prompt_tokens_details;
	if (typeof raw.prompt_tokens === "number" && isRecord(details) && typeof details.cached_tokens === "number") {
		cacheRead = details.cached_tokens;
		input = Math.max(0, input - details.cached_tokens);
	}
	if (input + output + cacheRead + cacheWrite === 0) return undefined;
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		totalTokens: input + output + cacheRead + cacheWrite,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function priceFor(state: RatchetState, lookup: PriceLookup, model: string): ModelCost | undefined {
	const override = state.prices[model];
	if (override) {
		return {
			input: override.in,
			output: override.out,
			cacheRead: override.cache_read ?? override.in,
			cacheWrite: override.cache_write ?? override.in,
		};
	}
	return lookup(model);
}

/** Row cost in USD: explicit `cost_usd`, else model × usage (+ judge); undefined when unpriceable. */
function rowCost(state: RatchetState, lookup: PriceLookup, row: ResultRow, unpriced: Set<string>): number | undefined {
	if (typeof row.cost_usd === "number" && Number.isFinite(row.cost_usd)) return row.cost_usd;
	let total = 0;
	for (const [modelKey, usageKey] of [
		["model", "usage"],
		["judge_model", "judge_usage"],
	] as const) {
		const model = row[modelKey];
		const usage = normalizeUsage(row[usageKey]);
		if (usage === undefined) {
			if (modelKey === "model") return undefined;
			continue;
		}
		if (typeof model !== "string") return undefined;
		const cost = priceFor(state, lookup, model);
		if (!cost) {
			unpriced.add(model);
			return undefined;
		}
		total += calculateUsageCost(cost, usage).total;
	}
	return total;
}

function rowMetrics(row: ResultRow, cost: number | undefined): Map<string, number> {
	const metrics = new Map<string, number>();
	const truncated = row.status === "truncated";
	for (const [key, value] of Object.entries(row)) {
		if (key === "rep" || key === "cost_usd") continue;
		if (typeof value === "number" && Number.isFinite(value)) metrics.set(key, value);
	}
	if (!truncated) {
		const grade = row.grade;
		if (typeof grade === "boolean") metrics.set("score", grade ? 1 : 0);
		else if (typeof grade === "number" && Number.isFinite(grade)) metrics.set("score", grade);
		else if (isRecord(grade)) {
			for (const [key, value] of Object.entries(grade)) {
				if (typeof value === "boolean") metrics.set(key, value ? 1 : 0);
				else if (typeof value === "number" && Number.isFinite(value)) metrics.set(key, value);
			}
		}
	}
	if (cost !== undefined) metrics.set("cost_usd", cost);
	return metrics;
}

/** Per-case mean of every metric over its reps. */
type CaseMeans = Map<string, Map<string, number>>;

function caseMeans(rows: readonly ResultRow[], costs: readonly (number | undefined)[]): CaseMeans {
	const sums = new Map<string, Map<string, { sum: number; count: number }>>();
	rows.forEach((row, index) => {
		const perCase = sums.get(row.prompt_id) ?? new Map<string, { sum: number; count: number }>();
		for (const [metric, value] of rowMetrics(row, costs[index])) {
			const entry = perCase.get(metric) ?? { sum: 0, count: 0 };
			entry.sum += value;
			entry.count += 1;
			perCase.set(metric, entry);
		}
		sums.set(row.prompt_id, perCase);
	});
	const means: CaseMeans = new Map();
	for (const [id, perCase] of sums) {
		means.set(id, new Map([...perCase].map(([metric, entry]) => [metric, entry.sum / entry.count])));
	}
	return means;
}

function summarize(means: CaseMeans, ids: readonly string[], metric: string): SplitSummary {
	const values: number[] = [];
	for (const id of ids) {
		const value = means.get(id)?.get(metric);
		if (value !== undefined) values.push(value);
	}
	return meanAndHalf(values);
}

function paired(
	candidate: CaseMeans,
	reference: CaseMeans,
	ids: readonly string[],
	metric: string,
	direction: Direction,
): PairedDelta {
	const diffs: number[] = [];
	for (const id of ids) {
		const a = candidate.get(id)?.get(metric);
		const b = reference.get(id)?.get(metric);
		if (a !== undefined && b !== undefined) diffs.push(a - b);
	}
	const summary = meanAndHalf(diffs);
	let verdict: Verdict = "flat";
	if (summary.mean !== null && summary.half !== null) {
		const gain = direction === "higher" ? summary.mean : -summary.mean;
		if (gain - summary.half > 0) verdict = "up";
		else if (gain + summary.half < 0) verdict = "down";
	}
	return { ...summary, verdict };
}

// ---------------------------------------------------------------------------
// Check and gate
// ---------------------------------------------------------------------------

function expectedVariant(state: RatchetState): string {
	const last = state.rounds.at(-1);
	if (!last) return "baseline";
	return `v${last.round + 1}`;
}

export interface CheckResult {
	variant: string;
	command: string;
	cases: number;
	reps: number;
	expected_rows: number;
	out_dir: string;
}

/** Preflight a round: approvals current, variant is next in sequence, command resolved. */
export async function checkVariant(cwd: string, state: RatchetState, variant: string): Promise<CheckResult> {
	if (!VARIANT_NAME.test(variant)) throw new RatchetError(`Variant must be "baseline" or v<N>, got ${variant}`);
	await requireApprovals(cwd, state);
	if (
		state.baseline_inputs_sha !== undefined &&
		(await stageDigest(cwd, state, "inputs")) !== state.baseline_inputs_sha
	) {
		throw new RatchetError(
			"The cases changed after the baseline was gated; the frozen split and baseline no longer cover them. Start a new flow with init() under a new name.",
		);
	}
	const last = state.rounds.at(-1);
	const rerun = last?.variant === variant && last.decision === "rerun";
	const expected = expectedVariant(state);
	if (!rerun && variant !== expected) {
		throw new RatchetError(`Next variant is ${expected}; got ${variant}`);
	}
	const dir = flowDir(cwd, state.flow);
	const outDir = toPosix(path.relative(cwd, path.join(dir, variant)));
	const cases = state.train_ids.length + state.test_ids.length;
	const reps = state.reps!;
	const command = state
		.command!.replaceAll("{variant}", variant)
		.replaceAll("{flow_dir}", toPosix(path.relative(cwd, dir)));
	return { variant, command, cases, reps, expected_rows: cases * reps, out_dir: outDir };
}

function formatSummary(summary: SplitSummary | undefined, metric: string): string {
	if (!summary || summary.mean === null) return "–";
	const digits = metric === "cost_usd" ? 4 : 3;
	const mean = summary.mean.toFixed(digits);
	return summary.half === null ? mean : `${mean} ±${summary.half.toFixed(digits)}`;
}

export function renderStatusTable(state: RatchetState): string {
	const goal = state.goal;
	if (!goal || state.rounds.length === 0) return "(no rounds gated yet)";
	const metrics = [goal.target, ...goal.hold.filter(metric => metric !== "cost_usd"), "cost_usd"];
	const header = ["round", "variant", "change", "decision"];
	for (const metric of metrics) header.push(`train ${metric}`, `test ${metric}`);
	const lines = [`| ${header.join(" | ")} |`, `|${header.map(() => "---").join("|")}|`];
	for (const round of state.rounds) {
		const best = state.best?.variant === round.variant ? " ★" : "";
		const cells = [String(round.round), round.variant + best, round.change.replaceAll("|", "\\|"), round.decision];
		for (const metric of metrics) {
			cells.push(formatSummary(round.train[metric], metric), formatSummary(round.test[metric], metric));
		}
		lines.push(`| ${cells.join(" | ")} |`);
	}
	return lines.join("\n");
}

export async function gateVariant(
	cwd: string,
	state: RatchetState,
	variant: string,
	change: string,
	lookup: PriceLookup,
): Promise<GateResult> {
	await checkVariant(cwd, state, variant);
	const goal = state.goal!;
	const reps = state.reps!;
	const dir = flowDir(cwd, state.flow);
	const data = await readVariant(dir, variant);
	const splitIds = [...state.train_ids, ...state.test_ids];
	const known = new Set(splitIds);
	const warnings: string[] = [];

	// Completeness: every (case, rep) must be scored or recorded as an infra error. A result row
	// supersedes earlier error rows for its slot (errors.jsonl is append-only across resumes), but
	// two result rows for one slot would be averaged as extra reps, so they are rejected.
	const slotKey = (row: ResultRow) => `${row.prompt_id}#${row.rep}`;
	const resultSlots = new Set<string>();
	const duplicates = new Set<string>();
	for (const row of data.rows) {
		const key = slotKey(row);
		if (resultSlots.has(key)) duplicates.add(key);
		resultSlots.add(key);
	}
	if (duplicates.size > 0) {
		throw new RatchetError(
			`${variant}/results.jsonl has duplicate (case, rep) rows (${[...duplicates].slice(0, 10).join(", ")}); keep one row per slot and re-gate`,
		);
	}
	const errorSlots = new Set(data.errors.map(slotKey));
	const missing: string[] = [];
	const erroredOnly: string[] = [];
	for (const id of splitIds) {
		for (let rep = 0; rep < reps; rep++) {
			const key = `${id}#${rep}`;
			if (resultSlots.has(key)) continue;
			if (errorSlots.has(key)) erroredOnly.push(key);
			else missing.push(key);
		}
	}
	if (missing.length > 0) {
		const shown = missing.slice(0, 10).join(", ");
		throw new RatchetError(
			`${variant} is incomplete: ${missing.length} (case, rep) slots have no result or error row (${shown}${missing.length > 10 ? ", …" : ""})`,
		);
	}
	if (variant === "baseline" && erroredOnly.length > 0) {
		throw new RatchetError(
			`baseline has ${erroredOnly.length} slots that only errored (${erroredOnly.slice(0, 10).join(", ")}); fix the harness and resume the run until every slot is scored`,
		);
	}
	// Held-out isolation: no transcript may exist for a test case.
	const testIds = new Set(state.test_ids);
	const leaked = data.traces.filter(file => {
		const match = /^(.*)_rep\d+\.json$/.exec(file);
		return match !== null && testIds.has(match[1]!);
	});
	if (leaked.length > 0) {
		throw new RatchetError(
			`${variant}/traces holds transcripts for test cases (${leaked.slice(0, 5).join(", ")}). The runner must write traces for train cases only; delete them, fix the runner, and re-run.`,
		);
	}
	const strays = new Set(data.rows.filter(row => !known.has(row.prompt_id)).map(row => row.prompt_id));
	if (strays.size > 0) warnings.push(`${strays.size} result ids are outside the split and were ignored`);

	const scored = data.rows.filter(row => known.has(row.prompt_id));
	const unpriced = new Set<string>();
	const costs = scored.map(row => rowCost(state, lookup, row, unpriced));
	if (unpriced.size > 0) {
		warnings.push(
			`No catalog price for ${[...unpriced].join(", ")}; add prices via plan(prices={model: {in, out}}) to report cost`,
		);
	}
	const means = caseMeans(scored, costs);
	const metrics = [...new Set([goal.target, ...goal.hold, "cost_usd"])];
	const train: Record<string, SplitSummary> = {};
	const test: Record<string, SplitSummary> = {};
	for (const metric of metrics) {
		train[metric] = summarize(means, state.train_ids, metric);
		test[metric] = summarize(means, state.test_ids, metric);
	}
	if (train[goal.target]!.n === 0 && test[goal.target]!.n === 0) {
		throw new RatchetError(
			`No row carries the target metric "${goal.target}". Targets are grade-dict keys, "score" for a bool/number grade, "cost_usd", or a numeric row field.`,
		);
	}
	const truncated = scored.filter(row => row.status === "truncated").length;
	if (truncated > 0) warnings.push(`${truncated} truncated rows excluded from quality means`);
	if (data.errors.length > 0) warnings.push(`${data.errors.length} infra error rows recorded in errors.jsonl`);
	// A guardrail with no measurement would read as "flat" and pass silently.
	const measured = (summary: SplitSummary | undefined) => summary !== undefined && summary.n >= 2;
	const unmeasured = goal.hold.filter(metric => !measured(train[metric]) || !measured(test[metric]));
	if (unmeasured.length > 0) {
		throw new RatchetError(
			`Guardrail ${unmeasured.join(", ")} has fewer than 2 measured cases on train or test in ${variant}${unpriced.size > 0 ? " (unpriced models; add plan(prices=…))" : ""}; the gate cannot hold a guardrail it cannot measure`,
		);
	}

	const last = state.rounds.at(-1);
	const rerun = last?.variant === variant && last.decision === "rerun";
	const roundNumber = rerun ? last.round : (last?.round ?? -1) + 1;
	const reasons: string[] = [];
	const deltas: GateResult["deltas"] = {};
	let decision: RoundDecision;

	if (variant === "baseline") {
		decision = "baseline";
		const target = test[goal.target]!;
		if (target.half !== null) reasons.push(`test noise floor on ${goal.target}: ±${target.half.toFixed(3)}`);
		const overall = summarize(means, splitIds, goal.target);
		const values = scored.map((row, index) => rowMetrics(row, costs[index]).get(goal.target));
		const unitInterval = values.every(value => value === undefined || (value >= 0 && value <= 1));
		if (goal.direction === "higher" && unitInterval && overall.mean !== null && overall.mean >= 0.95) {
			warnings.push(
				`Baseline ${goal.target} is ${overall.mean.toFixed(3)}: near ceiling; aim the goal at cost or latency, or add harder cases`,
			);
		}
		const trainTarget = train[goal.target]!;
		if (trainTarget.mean !== null && target.mean !== null && trainTarget.half !== null && target.half !== null) {
			const gap = Math.abs(trainTarget.mean - target.mean);
			if (gap > Math.hypot(trainTarget.half, target.half)) {
				warnings.push(`Train and test ${goal.target} means differ beyond noise; the split may be unrepresentative`);
			}
		}
	} else if (erroredOnly.length > 0) {
		decision = "rerun";
		reasons.push(
			`${erroredOnly.length} slots only errored (${erroredOnly.slice(0, 5).join(", ")}); resume ${variant} until every slot is scored, then gate it again`,
		);
	} else {
		const reference = state.best!.variant;
		const referenceData = await readVariant(dir, reference);
		const referenceRows = referenceData.rows.filter(row => known.has(row.prompt_id));
		const referenceMeans = caseMeans(
			referenceRows,
			referenceRows.map(row => rowCost(state, lookup, row, new Set())),
		);
		for (const metric of metrics) {
			const direction = metricDirection(goal, metric);
			deltas[metric] = {
				train: paired(means, referenceMeans, state.train_ids, metric, direction),
				test: paired(means, referenceMeans, state.test_ids, metric, direction),
			};
		}
		const unpaired = goal.hold.filter(metric => !measured(deltas[metric]!.train) || !measured(deltas[metric]!.test));
		if (unpaired.length > 0) {
			throw new RatchetError(
				`Guardrail ${unpaired.join(", ")} has fewer than 2 cases measured in both ${variant} and ${reference} on train or test; the gate cannot compare it`,
			);
		}
		const regressed = goal.hold.filter(
			metric => deltas[metric]!.train.verdict === "down" || deltas[metric]!.test.verdict === "down",
		);
		const target = deltas[goal.target]!;
		if (regressed.length > 0) {
			decision = "revert";
			reasons.push(`guardrail regressed vs ${reference}: ${regressed.join(", ")}`);
		} else if (target.train.verdict === "down" || target.test.verdict === "down") {
			decision = "revert";
			reasons.push(`${goal.target} regressed vs ${reference}`);
		} else if (target.train.verdict === "up" && target.test.verdict === "up") {
			decision = "keep";
			reasons.push(`${goal.target} improved on train and test vs ${reference}`);
		} else if (target.train.verdict === "up") {
			decision = "revert";
			reasons.push(`overfit suspect: train improved but test is flat vs ${reference}`);
		} else if (target.test.verdict === "up") {
			decision = "rerun";
			reasons.push(
				`test improved but train did not; append reps to ${variant} and ${reference}, then gate ${variant} again`,
			);
		} else {
			decision = "revert";
			reasons.push(`no change outside noise vs ${reference}`);
		}
	}

	const round: RatchetRound = {
		round: roundNumber,
		variant,
		change: variant === "baseline" ? "baseline" : change,
		decision,
		reasons,
		train,
		test,
		errors: data.errors.length,
		truncated,
		at: new Date().toISOString(),
	};
	if (rerun) state.rounds[state.rounds.length - 1] = round;
	else state.rounds.push(round);
	state.current_round = roundNumber;
	if (decision === "baseline") state.baseline_inputs_sha = await stageDigest(cwd, state, "inputs");
	if (decision === "baseline" || decision === "keep") {
		state.best = { round: roundNumber, variant, test_score: test[goal.target]!.mean };
		state.flat_rounds = 0;
	} else if (decision === "revert") {
		state.flat_rounds += 1;
	}
	const plateau = state.flat_rounds >= state.stop.plateau;
	const climbed = state.rounds.filter(entry => entry.variant !== "baseline").length;
	const done = plateau || (state.stop.rounds !== undefined && climbed >= state.stop.rounds);
	await saveState(cwd, state);
	const table = renderStatusTable(state);
	await Bun.write(path.join(dir, "status.md"), `# ${state.flow}\n\n${table}\n`);
	return { variant, decision, reasons, warnings, deltas, best: state.best, plateau, done, table };
}

// ---------------------------------------------------------------------------
// Analyzer view
// ---------------------------------------------------------------------------

export interface TrainView {
	variant: string;
	rows: Record<string, unknown>[];
	traces: string[];
	/** Train case → variant → mean target score, across every gated round. */
	history: Record<string, Record<string, number | null>>;
}

/** Everything the analyzer may read for a round: train rows, train traces, train score history. */
export async function trainView(
	cwd: string,
	state: RatchetState,
	variant: string,
	lookup: PriceLookup,
): Promise<TrainView> {
	if (!state.goal) throw new RatchetError("Set a goal with plan() before reading the train view");
	const dir = flowDir(cwd, state.flow);
	const trainIds = new Set(state.train_ids);
	const data = await readVariant(dir, variant);
	const rows = data.rows.filter(row => trainIds.has(row.prompt_id));
	const traces = data.traces
		.filter(file => {
			const match = /^(.*)_rep\d+\.json$/.exec(file);
			return match !== null && trainIds.has(match[1]!);
		})
		.map(file => toPosix(path.relative(cwd, path.join(dir, variant, "traces", file))));
	const history: TrainView["history"] = {};
	for (const id of state.train_ids) history[id] = {};
	for (const round of state.rounds) {
		const roundData = await readVariant(dir, round.variant);
		const roundRows = roundData.rows.filter(row => trainIds.has(row.prompt_id));
		const means = caseMeans(
			roundRows,
			roundRows.map(row => rowCost(state, lookup, row, new Set())),
		);
		for (const id of state.train_ids) history[id]![round.variant] = means.get(id)?.get(state.goal.target) ?? null;
	}
	return { variant, rows, traces, history };
}
