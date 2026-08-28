/**
 * Memory Fabric — observe-mode controller (rollout rung 1).
 *
 * The contract of the `observe` rung is one sentence: *the pipeline measures
 * but never alters context*. This module is the concrete realization of that
 * rung. It wraps the pre-model context hygiene gate (`runContextHygieneGate`)
 * and turns it into a strictly MEASURE-ONLY pass:
 *
 *   1. It runs the gate FORCED to observe mode — any `mode` a caller tries to
 *      pass through is overridden. Enforce cannot be reached from here.
 *   2. It returns the caller's ORIGINAL array, and *structurally guarantees*
 *      that: the non-alteration invariant is checked against whatever the
 *      runner actually returned, and if the runner (however buggy or swapped
 *      out) hands back anything other than the untouched input, the controller
 *      DISCARDS it and returns the original, flagging the breach. "Never alters
 *      context" is therefore enforced by construction, not by convention.
 *   3. It records a rich report of what enforce WOULD do — projected token
 *      delta, would-remove / would-reorder, dedup savings, coverage gaps,
 *      per-stage telemetry, and the safety invariants — so a later rung can
 *      diff the proposal against reality before anyone flips a flag.
 *
 * Everything is deterministic (injectable clock), non-mutating, and fail-open:
 * on ANY error it returns the original context untouched with an empty, safe
 * measurement. Disabled by default, not wired into the hot path, and not
 * re-exported from `memory-fabric/index.ts`.
 *
 * Three properties are worth calling out because they are easy to get wrong:
 *
 *   - Removal and reordering are distinguished with a MULTISET walk, not a
 *     `Set`. When the gate's exact-dedup collapses two candidates that share an
 *     id, the naive set comparison reports a spurious reorder and hides the
 *     removal. Since `wouldChange` is exactly the metric a rollout decision is
 *     made on, that false positive matters.
 *   - The input fingerprint used to detect in-place mutation is a rolling
 *     hash, not `JSON.stringify`. Serializing the whole context twice per pass
 *     would duplicate megabytes of content in a code path whose entire purpose
 *     is to be free.
 *   - `generatedAt` is sampled ONCE and the same instant is handed to the gate,
 *     so the report and the gate result can never disagree about when the pass
 *     happened.
 */

import type { CoverageReport, CoveredContextItem, RequiredNeed } from "../context-hygiene/coverage";
import { DEDUPER_NAME, DEDUPER_VERSION } from "../context-hygiene/dedup";
import {
	HYGIENE_GATE_NAME,
	HYGIENE_GATE_VERSION,
	type HygieneGateOptions,
	type HygieneGateResult,
	type HygieneStage,
	runContextHygieneGate,
} from "../context-hygiene/pipeline";
import type { ContextItem } from "../context-hygiene/types";
import {
	countTokens,
	heuristicTokenCounter,
	type TokenCounter,
	type TokenDelta,
	tokenDelta,
} from "../token-accounting/token-accounting";
import { OBSERVER_NAME, OBSERVER_VERSION } from "./types";

/**
 * The gate runner the observer drives. Defaults to `runContextHygieneGate`;
 * injectable so tests can supply a stub and so the observer can enforce its
 * non-alteration invariant even against a misbehaving implementation.
 */
export type HygieneGateRunner = (
	items: ContextItem[],
	needs: RequiredNeed[],
	options: HygieneGateOptions,
) => HygieneGateResult;

export interface ObserveOptions {
	/** Token counter for the projected-savings measurement (default heuristic). */
	counter?: TokenCounter;
	/**
	 * Options forwarded to the gate runner. `mode` and `now` are intentionally
	 * omitted: observe mode is forced, and the clock is owned by the observer so
	 * the report and the gate result share one instant.
	 */
	gateOptions?: Omit<HygieneGateOptions, "mode" | "now">;
	/** Injectable gate runner (default `runContextHygieneGate`). */
	runner?: HygieneGateRunner;
	/** Optional sink that receives the observation (default: discard). */
	sink?: ObservationSink;
	/** Injectable clock for deterministic tests. Sampled exactly once per pass. */
	now?: () => Date;
}

/** A structured, measure-only record of one observe pass. */
export interface ObservationReport {
	observer: string;
	observerVersion: string;
	/** Always "observe" for this controller. */
	stage: "observe";
	gate: string;
	gateVersion: string;
	generatedAt: string;

	inputCount: number;
	proposalCount: number;
	/** Ids of the input items, in input order. */
	inputIds: string[];
	/** Ids enforce WOULD keep, in the proposed order. */
	proposalIds: string[];
	/** Ids enforce WOULD remove (F4 drop, budget omit, dedup, or pre-reject). */
	wouldRemoveIds: string[];
	/** True if enforce would reorder the kept items relative to input order. */
	wouldReorder: boolean;
	/** True if enforce would differ from the input at all (remove or reorder). */
	wouldChange: boolean;

	/** Input tokens vs proposal tokens — what enforce WOULD save. */
	projected: TokenDelta;
	dedupRemoved: number;
	f4Drops: number;
	coverageGaps: string[];
	allRequiredCovered: boolean;

	// --- invariants (all must hold in observe mode) ---
	/** The caller's array was not mutated in place during the pass. */
	contextUnchanged: boolean;
	/** The runner returned the input untouched (else the controller overrode it). */
	invariantHeld: boolean;
	/** Preserved (F0/F1) ids the proposal would drop — MUST be empty. */
	preservedWouldDrop: string[];
	/** Never-worse coverage violation — MUST be false. */
	neverWorseViolation: boolean;
	/** True when the gate (or the controller) failed open. */
	failedOpen: boolean;
	/** Human-readable invariant breaches that were detected AND corrected. */
	breaches: string[];

	/** Per-stage token telemetry captured by the gate, in order. */
	stages: HygieneStage[];
}

export interface ObservationResult {
	/**
	 * ALWAYS the caller's original array, unchanged. This is the whole point of
	 * observe mode; the controller guarantees it structurally.
	 */
	context: ContextItem[];
	report: ObservationReport;
	/** The full (measure-only) gate result, for callers who want the detail. */
	gate: HygieneGateResult;
}

/** A sink for observation reports. Implementations MUST NOT throw to the caller. */
export interface ObservationSink {
	record(report: ObservationReport): void;
}

/** Default sink: discards everything (observe telemetry disabled by default). */
export const noopObservationSink: ObservationSink = { record() {} };

/** Buffering sink for tests and observe-mode collection. Never throws. */
export class InMemoryObservationSink implements ObservationSink {
	readonly reports: ObservationReport[] = [];

	record(report: ObservationReport): void {
		this.reports.push(report);
	}

	summary(): ObservationSummary {
		return summarizeObservations(this.reports);
	}

	clear(): void {
		this.reports.length = 0;
	}
}

/** Emit an observation to a sink, fail-open: a throwing sink can't break us. */
export function emitObservation(report: ObservationReport, sink: ObservationSink = noopObservationSink): void {
	try {
		sink.record(report);
	} catch {
		// Observation telemetry must never break the caller.
	}
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function sumTokens(items: readonly { content: string }[], counter: TokenCounter): number {
	let total = 0;
	for (const item of items) total += countTokens(item.content, counter).tokens;
	return total;
}

/** Referential sameness: same length AND every element the same reference. */
function sameItems(a: readonly unknown[], b: readonly unknown[]): boolean {
	if (a.length !== b.length) return false;
	for (let i = 0; i < a.length; i++) {
		if (a[i] !== b[i]) return false;
	}
	return true;
}

/**
 * A cheap, constant-memory fingerprint over (id, content) used to detect
 * in-place mutation of the caller's array. FNV-1a with explicit field
 * separators, so ("ab", "c") and ("a", "bc") cannot collide trivially. Total:
 * a malformed item can never make the observer throw.
 */
function structuralSignature(items: readonly (ContextItem | undefined)[]): string {
	let hash = 0x811c9dc5;
	const mix = (value: unknown): void => {
		const text = typeof value === "string" ? value : String(value);
		for (let i = 0; i < text.length; i++) {
			hash ^= text.charCodeAt(i);
			hash = Math.imul(hash, 0x01000193);
		}
		// Field separator, so adjacent fields cannot be shifted between each other.
		hash ^= 0xff;
		hash = Math.imul(hash, 0x01000193);
	};
	if (!Array.isArray(items)) return "invalid";
	for (const item of items) {
		mix(item?.id);
		mix(item?.content);
	}
	return `${items.length}:${(hash >>> 0).toString(16)}`;
}

interface OrderDiff {
	wouldRemoveIds: string[];
	wouldReorder: boolean;
}

/**
 * Split the input-vs-proposal difference into removals and reordering.
 *
 * This walks the proposal as a MULTISET rather than a `Set`. When two input
 * items share an id and the gate's exact-dedup collapses them, a set-based
 * comparison sees the id still present (so reports no removal) but sees one
 * fewer proposal entry (so reports a reorder) — exactly backwards. Consuming
 * proposal entries one at a time attributes that to a removal, and only calls
 * it a reorder when the surviving order actually differs.
 */
function diffOrder(inputIds: readonly string[], proposalIds: readonly string[]): OrderDiff {
	const remaining = new Map<string, number>();
	for (const id of proposalIds) remaining.set(id, (remaining.get(id) ?? 0) + 1);

	const wouldRemoveIds: string[] = [];
	const kept: string[] = [];
	for (const id of inputIds) {
		const count = remaining.get(id) ?? 0;
		if (count > 0) {
			remaining.set(id, count - 1);
			kept.push(id);
		} else {
			wouldRemoveIds.push(id);
		}
	}

	// Anything still outstanding was proposed but never present in the input.
	let injected = 0;
	for (const count of remaining.values()) injected += count;
	if (injected > 0) return { wouldRemoveIds, wouldReorder: true };

	for (let i = 0; i < kept.length; i++) {
		if (kept[i] !== proposalIds[i]) return { wouldRemoveIds, wouldReorder: true };
	}
	return { wouldRemoveIds, wouldReorder: false };
}

/**
 * Coverage stub for a synthesized fail-open gate result. `allRequiredCovered`
 * is false because the gate never ran: "we did not measure" must not read as
 * "everything is covered". This matches the hygiene gate's own fail-open path.
 */
function emptyCoverage(generatedAt: string): CoverageReport {
	return {
		items: [],
		results: [],
		expansions: [],
		gaps: [],
		allRequiredCovered: false,
		neverWorse: { requiredCoverableCount: 0, requiredCoveredCount: 0, violation: false },
		generatedAt,
		failedOpen: true,
	};
}

function failOpenGate(items: ContextItem[], generatedAt: string): HygieneGateResult {
	return {
		name: HYGIENE_GATE_NAME,
		version: HYGIENE_GATE_VERSION,
		mode: "observe",
		items,
		proposal: [],
		rejected: [],
		dedup: {
			deduper: DEDUPER_NAME,
			deduperVersion: DEDUPER_VERSION,
			inputCount: items.length,
			outputCount: items.length,
			removedCount: 0,
			bytesBefore: 0,
			bytesAfter: 0,
			approxTokensBefore: 0,
			approxTokensAfter: 0,
			dedupedAt: generatedAt,
			failedOpen: true,
		},
		classified: [],
		coverage: emptyCoverage(generatedAt),
		stages: [],
		failedOpen: true,
		generatedAt,
	};
}

function buildFailOpenReport(
	items: readonly ContextItem[],
	generatedAt: string,
	breaches: string[],
	contextUnchanged: boolean,
): ObservationReport {
	return {
		observer: OBSERVER_NAME,
		observerVersion: OBSERVER_VERSION,
		stage: "observe",
		gate: HYGIENE_GATE_NAME,
		gateVersion: HYGIENE_GATE_VERSION,
		generatedAt,
		inputCount: items.length,
		proposalCount: 0,
		inputIds: items.map(item => item.id),
		proposalIds: [],
		wouldRemoveIds: [],
		wouldReorder: false,
		wouldChange: false,
		projected: tokenDelta(0, 0),
		dedupRemoved: 0,
		f4Drops: 0,
		coverageGaps: [],
		allRequiredCovered: false,
		contextUnchanged,
		invariantHeld: contextUnchanged,
		preservedWouldDrop: [],
		neverWorseViolation: false,
		failedOpen: true,
		breaches,
		stages: [],
	};
}

// ---------------------------------------------------------------------------
// the observe controller
// ---------------------------------------------------------------------------

/**
 * Run the context hygiene gate in strict observe mode: measure what enforce
 * WOULD do, but return the caller's context untouched. Deterministic,
 * non-mutating, fail-open, and structurally guaranteed not to alter context.
 */
export function observeContextHygiene(
	items: ContextItem[],
	needs: RequiredNeed[] = [],
	options: ObserveOptions = {},
): ObservationResult {
	const clock = options.now ?? (() => new Date());
	// Sample the clock exactly once, then hand the SAME instant to the gate so
	// the report and the gate result can never disagree about when this ran.
	const instant = clock();
	const generatedAt = instant.toISOString();
	const frozenNow = (): Date => instant;
	const counter = options.counter ?? heuristicTokenCounter;
	const runner = options.runner ?? runContextHygieneGate;
	const input = items; // never reassigned: this exact array is what we return
	const entrySignature = structuralSignature(input);
	const breaches: string[] = [];

	let gate: HygieneGateResult;
	try {
		// Force observe mode; a caller cannot opt this pass into enforce.
		gate = runner(input, needs, { ...(options.gateOptions ?? {}), mode: "observe", now: frozenNow });
	} catch {
		// Fail open: no measurement, context untouched.
		breaches.push("gate runner threw; failing open with untouched context");
		const unchanged = structuralSignature(input) === entrySignature;
		if (!unchanged) breaches.push("caller input was mutated in place before the gate threw");
		const report = buildFailOpenReport(input, generatedAt, breaches, unchanged);
		emitObservation(report, options.sink);
		return { context: input, report, gate: failOpenGate(input, generatedAt) };
	}

	// --- enforce the non-alteration invariant, structurally ---
	// The runner should hand back the exact input array in observe mode. If it
	// returns anything else we DISCARD it and keep the original (never alter).
	const runnerHeldInvariant = sameItems(input, gate.items);
	if (!runnerHeldInvariant) {
		breaches.push("runner returned altered context in observe mode; discarded and kept original");
	}
	// Detect (and flag) any in-place mutation of the caller's input.
	const contextUnchanged = structuralSignature(input) === entrySignature;
	if (!contextUnchanged) {
		breaches.push("caller input was mutated in place during the gate run");
	}
	const invariantHeld = runnerHeldInvariant && contextUnchanged;

	// --- measurement: what enforce WOULD do (the gate's proposal) ---
	const proposal: CoveredContextItem[] = Array.isArray(gate.proposal) ? gate.proposal : [];
	const inputIds = input.map(item => item.id);
	const proposalIds = proposal.map(item => item.id);
	const { wouldRemoveIds, wouldReorder } = diffOrder(inputIds, proposalIds);
	const wouldChange = wouldRemoveIds.length > 0 || wouldReorder;

	const projected = tokenDelta(sumTokens(input, counter), sumTokens(proposal, counter));

	// Safety-critical: no preserved (F0/F1) item may be proposed for removal.
	const preservedWouldDrop = gate.coverage.items
		.filter(item => item.preserved && item.disposition !== "keep")
		.map(item => item.id);
	if (preservedWouldDrop.length > 0) {
		breaches.push(`proposal would drop preserved F0/F1 items: ${preservedWouldDrop.join(", ")}`);
	}

	const report: ObservationReport = {
		observer: OBSERVER_NAME,
		observerVersion: OBSERVER_VERSION,
		stage: "observe",
		gate: gate.name,
		gateVersion: gate.version,
		generatedAt,
		inputCount: input.length,
		proposalCount: proposal.length,
		inputIds,
		proposalIds,
		wouldRemoveIds,
		wouldReorder,
		wouldChange,
		projected,
		dedupRemoved: gate.dedup.removedCount,
		f4Drops: gate.rejected.filter(record => record.stage === "f4-drop").length,
		coverageGaps: gate.coverage.gaps,
		allRequiredCovered: gate.coverage.allRequiredCovered,
		contextUnchanged,
		invariantHeld,
		preservedWouldDrop,
		neverWorseViolation: gate.coverage.neverWorse.violation,
		failedOpen: gate.failedOpen,
		breaches,
		stages: gate.stages,
	};

	emitObservation(report, options.sink);
	return { context: input, report, gate };
}

// ---------------------------------------------------------------------------
// aggregation — the go/no-go the rollout ladder consults
// ---------------------------------------------------------------------------

export interface ObservationSummary {
	count: number;
	/** Observations where enforce would have changed the context. */
	wouldChangeCount: number;
	/** wouldChangeCount / count (0 when count is 0). */
	wouldChangeRate: number;
	/** Total tokens enforce WOULD have saved across all observations. */
	totalProjectedSaved: number;
	/** Mean projected saved tokens per observation. */
	meanProjectedSaved: number;
	/** True if ANY observation would drop preserved F0/F1 content (must be false). */
	anyPreservedWouldDrop: boolean;
	/** True if ANY observation reported a never-worse violation (must be false). */
	anyNeverWorseViolation: boolean;
	/** True if ANY observation detected a non-alteration invariant breach. */
	anyInvariantBreach: boolean;
	/** True if ANY observation failed open. */
	anyFailedOpen: boolean;
	/**
	 * True only when every observation held every safety invariant: context
	 * unchanged, no preserved drop, no never-worse violation, no breach, no
	 * fail-open. This is the observe-mode go/no-go consulted before `suggest`.
	 */
	safeToAdvance: boolean;
}

/** Aggregate a batch of observation reports into a rollout-decision summary. */
export function summarizeObservations(reports: readonly ObservationReport[]): ObservationSummary {
	const count = reports.length;
	let wouldChangeCount = 0;
	let totalProjectedSaved = 0;
	let anyPreservedWouldDrop = false;
	let anyNeverWorseViolation = false;
	let anyInvariantBreach = false;
	let anyFailedOpen = false;

	for (const report of reports) {
		if (report.wouldChange) wouldChangeCount++;
		totalProjectedSaved += report.projected.saved;
		if (report.preservedWouldDrop.length > 0) anyPreservedWouldDrop = true;
		if (report.neverWorseViolation) anyNeverWorseViolation = true;
		if (!report.invariantHeld || !report.contextUnchanged || report.breaches.length > 0) {
			anyInvariantBreach = true;
		}
		if (report.failedOpen) anyFailedOpen = true;
	}

	const safeToAdvance =
		count > 0 && !anyPreservedWouldDrop && !anyNeverWorseViolation && !anyInvariantBreach && !anyFailedOpen;

	return {
		count,
		wouldChangeCount,
		wouldChangeRate: count === 0 ? 0 : wouldChangeCount / count,
		totalProjectedSaved,
		meanProjectedSaved: count === 0 ? 0 : totalProjectedSaved / count,
		anyPreservedWouldDrop,
		anyNeverWorseViolation,
		anyInvariantBreach,
		anyFailedOpen,
		safeToAdvance,
	};
}
