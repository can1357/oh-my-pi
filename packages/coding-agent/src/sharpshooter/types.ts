/**
 * Sharpshooter memory types.
 *
 * Sharpshooter is the friction-gated project-decision memory backend: per-prompt
 * async extraction emits {@link SharpshooterDelta}s into a per-session queue, and
 * a shared 5-minute consolidation pass applies queued deltas per project into
 * three markdown decision files ({@link SHARPSHOOTER_MEMORY_FILES}).
 */

/** Decision categories a delta may claim. Consolidation maps them onto the three memory files. */
export type SharpshooterDeltaKind =
	| "architecture_decision"
	| "product_decision"
	| "style_decision"
	| "constraint"
	| "rejected_approach"
	| "correction";

/**
 * Provenance of a delta: stated outright in the user's prompt, or resolved from a
 * short reply ("opt 2", "go for it") against the assistant's preceding question/options.
 */
export type SharpshooterDeltaSource = "explicit_user" | "contextual_resolution";

/**
 * Friction hints the extractor tags per delta. Consolidation admits a decision only
 * when its lineage shows friction: a regression, repeated corrections, or a rule
 * that is subtle to get right from the code alone.
 */
export interface SharpshooterFriction {
	/** The user is correcting/re-stating something previously settled. */
	corrective: boolean;
	/** The user reports previously-working behavior broke or drifted. */
	regression: boolean;
	/** Non-obvious invariant a fresh agent would plausibly get wrong from code alone. */
	subtle: boolean;
}

/** One extracted decision delta, queued per session until consolidation applies it. */
export interface SharpshooterDelta {
	v: 1;
	kind: SharpshooterDeltaKind;
	/** Timeless normative statement; never task state, paths, or symbols. */
	statement: string;
	/** Alternative the user explicitly rejected, when the rejection is part of the decision. */
	rejectedAlternative?: string;
	/** Short "because" clause when the user gave one. */
	rationale?: string;
	source: SharpshooterDeltaSource;
	/** Exact substring of the triggering user prompt; host-enforced admission gate. */
	evidence: string;
	friction: SharpshooterFriction;
	/** Session that produced the delta; consolidation groups by this. */
	sessionId: string;
	/** Extraction wall-clock time (ms since epoch); orders deltas within a session. */
	ts: number;
}

/** The project memory file set, in injection order. */
export const SHARPSHOOTER_MEMORY_FILES = ["architecture.md", "product.md", "style.md"] as const;

export type SharpshooterMemoryFile = (typeof SHARPSHOOTER_MEMORY_FILES)[number];

/** Hard per-file line ceiling enforced on consolidation output. */
export const SHARPSHOOTER_MAX_FILE_LINES = 120;

/** Consolidation bookkeeping persisted in the bank's `state.json`. */
export interface SharpshooterState {
	v: 1;
	/** Wall-clock ms of the last completed (or empty-queue) consolidation pass. */
	lastConsolidatedAt: number;
	/** Summary of the last successful apply, for `/memory stats`. */
	lastResult?: {
		at: number;
		sessions: number;
		deltas: number;
		model: string;
	};
	/** Last consolidation failure, for `/memory diagnose`. */
	lastError?: {
		at: number;
		message: string;
	};
}
