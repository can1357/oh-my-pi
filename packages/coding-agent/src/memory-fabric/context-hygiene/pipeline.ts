/**
 * Adaptive Context Hygiene Gate — pipeline wiring (ACF, plan §5).
 *
 * Composes the already-shipped hygiene steps into the single pre-model gate the
 * plan describes (§5 "Pre-model — Adaptive Context Hygiene Gate"):
 *
 *   retrieved candidates
 *     -> reject unsafe / out-of-scope (F4)     [CH3 classifier decides F4]
 *     -> exact dedup                            [CH2]
 *     -> assign fidelity class (F0–F4)          [CH3]
 *     -> protect authoritative (F0/F1)          [CH3: preserved + transforms]
 *     -> project evidence & code (F2)           [CH4 seam — identity for now]
 *     -> order by decision importance           [CH10 seam — identity for now]
 *     -> required-need coverage check           [CH6]
 *     -> expand fidelity where coverage is short [CH6]
 *
 * Every stage records CH0 token telemetry (before/after) to an injectable sink,
 * and the whole gate fails open (rule #4): on ANY error it returns the original
 * candidates untouched and flags `failedOpen`.
 *
 * Rollout discipline (rule #11: observe → suggest → active):
 *   - Default mode is "observe": the gate MEASURES everything (dedup, classes,
 *     coverage, telemetry) but returns the ORIGINAL items UNCHANGED. It never
 *     alters context until a caller explicitly opts into "enforce".
 *   - "enforce" returns the transformed packet (deduped, F4 dropped, coverage-
 *     expanded, ordered).
 * Either way `proposal` carries what enforce WOULD emit, so observe mode can be
 * diffed against reality before anyone flips the flag.
 *
 * Safety notes:
 *   - "Reject unsafe/out-of-scope" is realized as the post-classification F4
 *     DROP, NOT a naive pre-filter, precisely because CH3 detects F0 BEFORE F4
 *     (plan §3): a security warning that also looks out-of-scope must survive.
 *     A conservative `preReject` hook is available but OFF by default.
 *   - F2 projection (CH4) and anti-burial ordering (CH10) are honest identity
 *     SEAMS here; wiring them is those phases' job. They are applied so the gate
 *     shape matches §5 exactly and later phases only swap the hook.
 *
 * Additive, injectable, disabled by default; NOT re-exported from
 * memory-fabric/index.ts. Non-mutating on the caller's input.
 */

import {
	accountTokens,
	countTokens,
	emitTokenTelemetry,
	heuristicTokenCounter,
	noopTelemetrySink,
	type TokenCounter,
	type TokenTelemetryEvent,
	type TokenTelemetrySink,
} from "../token-accounting/token-accounting";
import { classifyItems } from "./classify";
import {
	type CoverageOptions,
	type CoverageReport,
	type CoveredContextItem,
	type Disposition,
	type RequiredNeed,
	validateCoverage,
} from "./coverage";
import { type DedupOptions, type DedupTelemetry, exactDedup } from "./dedup";
import type { ClassifiedContextItem, ClassifyOptions, ContextItem, FidelityClass } from "./types";

export const HYGIENE_GATE_NAME = "acf-context-hygiene-gate";
export const HYGIENE_GATE_VERSION = "wire-1";

/** observe = measure only (never alter); enforce = emit the transformed packet. */
export type HygieneMode = "observe" | "enforce";

/** A candidate removed before it could reach the model, with why. */
export interface RejectedRecord {
	id: string;
	stage: "pre-reject" | "f4-drop" | "omitted";
	fidelity?: FidelityClass;
	reason: string;
}

/** Per-stage token telemetry captured while running the gate. */
export interface HygieneStage {
	stage: string;
	inputCount: number;
	outputCount: number;
	event: TokenTelemetryEvent;
}

export interface HygieneGateResult {
	name: string;
	version: string;
	mode: HygieneMode;
	/**
	 * What the caller should USE:
	 *   - observe mode: the ORIGINAL items, unchanged.
	 *   - enforce mode: the transformed, kept packet (same as `proposal`).
	 */
	items: ContextItem[] | CoveredContextItem[];
	/** What enforce WOULD emit, regardless of mode (kept items, in order). */
	proposal: CoveredContextItem[];
	/** Items the gate would drop or omit (F4 drops, budget omits). */
	rejected: RejectedRecord[];
	/** CH2 dedup telemetry. */
	dedup: DedupTelemetry;
	/** CH3 classified set (post-dedup), in gate order. */
	classified: ClassifiedContextItem[];
	/** CH6 coverage report (dispositions, expansions, gaps, never-worse). */
	coverage: CoverageReport;
	/** Per-stage CH0 token telemetry, in execution order. */
	stages: HygieneStage[];
	/** True when the gate caught an error and returned the input untouched. */
	failedOpen: boolean;
	generatedAt: string;
}

export interface HygieneGateOptions {
	/** Default "observe" — measure only, never alter (rule #11). */
	mode?: HygieneMode;
	/** Token counter for telemetry (default heuristic; rule #16 seam). */
	counter?: TokenCounter;
	/** Telemetry sink (default no-op — disabled; not wired to Event Gateway). */
	sink?: TokenTelemetrySink;
	dedupOptions?: DedupOptions;
	classifyOptions?: ClassifyOptions;
	coverageOptions?: CoverageOptions;
	/**
	 * Optional conservative pre-classification reject (default: none). MUST NOT
	 * reject content that could be F0 — prefer letting CH3 decide F4. Off by
	 * default for exactly that reason.
	 */
	preReject?: (item: ContextItem) => boolean;
	/** CH4 seam: project an F2 item to a compact form. Default: identity. */
	projectItem?: (item: ClassifiedContextItem) => ClassifiedContextItem;
	/** CH10 seam: anti-burial ordering. Default: identity (stable order). */
	orderItems?: (items: ClassifiedContextItem[]) => ClassifiedContextItem[];
	/** Injectable clock for deterministic tests. */
	now?: () => Date;
}

function sumTokens(items: { content: string }[], counter: TokenCounter): number {
	let total = 0;
	for (const it of items) total += countTokens(it.content, counter).tokens;
	return total;
}

/** F4 → drop, everything else → keep (mirrors CH6 defaultDisposition). */
function defaultDisposition(item: ClassifiedContextItem): Disposition {
	return item.fidelity === "F4" ? "drop" : "keep";
}

/**
 * Run the pre-model Adaptive Context Hygiene Gate over retrieved candidates.
 * Pure, deterministic, fail-open. In observe mode the returned `items` are the
 * caller's original array, untouched.
 */
export function runContextHygieneGate(
	items: ContextItem[],
	needs: RequiredNeed[] = [],
	options: HygieneGateOptions = {},
): HygieneGateResult {
	const now = options.now ?? (() => new Date());
	const generatedAt = now().toISOString();
	const mode: HygieneMode = options.mode ?? "observe";
	const counter = options.counter ?? heuristicTokenCounter;
	const sink = options.sink ?? noopTelemetrySink;
	const stages: HygieneStage[] = [];

	const record = (stage: string, inputCount: number, outputCount: number, before: number, after: number): void => {
		const event = accountTokens(before, after, { stage, reason: `${HYGIENE_GATE_NAME} ${stage}`, now });
		emitTokenTelemetry(event, sink);
		stages.push({ stage, inputCount, outputCount, event });
	};

	try {
		const inputTokens = sumTokens(items, counter);

		// 1) Optional conservative pre-reject (default: none).
		const preRejected: RejectedRecord[] = [];
		const afterPreReject: ContextItem[] = [];
		const preReject = options.preReject;
		for (const item of items) {
			if (preReject?.(item)) {
				preRejected.push({ id: item.id, stage: "pre-reject", reason: "pre-reject hook" });
			} else {
				afterPreReject.push(item);
			}
		}

		// 2) Exact dedup (CH2) — before any semantic transform (rule #3).
		const dedupResult = exactDedup(afterPreReject, options.dedupOptions);
		const dedupedTokens = sumTokens(dedupResult.items, counter);
		record("dedup", afterPreReject.length, dedupResult.items.length, inputTokens, dedupedTokens);

		// 3) Classify F0–F4 (CH3). Content unchanged → a measured no-op size-wise.
		const classified = classifyItems(dedupResult.items, options.classifyOptions);
		record("classify", dedupResult.items.length, classified.length, dedupedTokens, dedupedTokens);

		// 4) Project F2 (CH4 seam) + 5) order (CH10 seam). Identity by default.
		const projectItem = options.projectItem ?? ((i: ClassifiedContextItem) => i);
		const projected = classified.map(i => (i.fidelity === "F2" ? projectItem(i) : i));
		const orderItems = options.orderItems ?? ((xs: ClassifiedContextItem[]) => xs);
		const ordered = orderItems(projected);

		// 6+7) Required-need coverage + expand-rather-than-gap (CH6).
		const coverage = validateCoverage(ordered, needs, options.coverageOptions);

		// Derive the final packet + rejected/omitted records from dispositions.
		const kept = coverage.items.filter(i => i.disposition === "keep");
		const rejected: RejectedRecord[] = [...preRejected];
		for (const i of coverage.items) {
			if (i.disposition === "drop") {
				rejected.push({ id: i.id, stage: "f4-drop", fidelity: i.fidelity, reason: `dropped (${i.fidelity})` });
			} else if (i.disposition === "omit") {
				rejected.push({ id: i.id, stage: "omitted", fidelity: i.fidelity, reason: "omitted by budget stage" });
			}
		}

		// Coverage stage telemetry: kept-by-default vs kept-after-expansion.
		const keptByDefault = ordered.filter(i => defaultDisposition(i) === "keep");
		const keptByDefaultTokens = sumTokens(keptByDefault, counter);
		const keptTokens = sumTokens(kept, counter);
		record("coverage", ordered.length, kept.length, keptByDefaultTokens, keptTokens);

		// Gate-total: whole-packet before/after (input → final proposed packet).
		record("gate", items.length, kept.length, inputTokens, keptTokens);

		return {
			name: HYGIENE_GATE_NAME,
			version: HYGIENE_GATE_VERSION,
			mode,
			items: mode === "enforce" ? kept : items,
			proposal: kept,
			rejected,
			dedup: dedupResult.telemetry,
			classified: ordered,
			coverage,
			stages,
			failedOpen: false,
			generatedAt,
		};
	} catch {
		// Fail open (rule #4): never alter or drop context on error.
		const event = accountTokens(0, 0, { stage: "gate", reason: "failed-open", now });
		emitTokenTelemetry(event, sink);
		return {
			name: HYGIENE_GATE_NAME,
			version: HYGIENE_GATE_VERSION,
			mode,
			items,
			proposal: [],
			rejected: [],
			dedup: {
				deduper: "acf-exact-deduper",
				deduperVersion: "ch2-1",
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
			coverage: {
				items: [],
				results: [],
				expansions: [],
				gaps: [],
				allRequiredCovered: false,
				neverWorse: { requiredCoverableCount: 0, requiredCoveredCount: 0, violation: false },
				generatedAt,
				failedOpen: true,
			},
			stages: [{ stage: "gate", inputCount: items.length, outputCount: items.length, event }],
			failedOpen: true,
			generatedAt,
		};
	}
}
