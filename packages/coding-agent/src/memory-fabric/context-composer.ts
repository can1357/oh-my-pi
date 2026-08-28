/**
 * Context packet composition.
 *
 * Takes ranked memory records and folds them into a tiered, token-budgeted
 * packet ready for model injection. This is the counterpart of the tiered
 * retrieval broker: the broker decides *which* candidates exist, the composer
 * decides *what actually ships* this turn and renders it.
 *
 * Tier semantics follow `tiered-retrieval-types.ts`: L0 identity/continuity,
 * L1 active task state, L2 verified knowledge, L3 evidence, L4 history.
 * L3/L4 records are carried in the packet for audit but are given zero or
 * capped budgets by default -- history is retrievable, not ambient.
 *
 * Everything here is pure and deterministic: same records in, same packet
 * out. No clocks, no randomness, no I/O.
 */

import type { ContextTier } from "./tiered-retrieval-types";
import type { MemoryRecord } from "./types";

/** Per-tier token budget window. */
export interface TierBudget {
	min: number;
	max: number;
}

/** Default per-tier budgets, in model tokens. */
export const DEFAULT_TIER_BUDGETS: Record<ContextTier, TierBudget> = {
	L0: { min: 50, max: 100 },
	L1: { min: 150, max: 300 },
	L2: { min: 300, max: 900 },
	L3: { min: 0, max: 500 },
	L4: { min: 0, max: 0 },
};

/** How records should be rendered when multiple representations exist. */
export type RepresentationPolicy = "compact-first" | "standard-first" | "mixed";

/** A composed, budgeted, provenance-carrying context packet. */
export interface ComposedContextPacket {
	tiers: Record<ContextTier, MemoryRecord[]>;
	estimatedTokens: number;
	/** record id -> "verification | type | source refs" audit line. */
	provenance: Record<string, string>;
	warnings: string[];
	representationPolicy: RepresentationPolicy;
}

/** Inputs to {@link composeContextPacket}. */
export interface ComposeContextOptions {
	/** L1 records: the live task state. */
	taskState?: MemoryRecord[];
	/** L0 records: identity/continuity. */
	identity?: MemoryRecord[];
	/** Total token budget for the packet. Default 900. */
	totalBudget?: number;
	representationPolicy?: RepresentationPolicy;
	/** Override the per-tier budget windows. */
	tierBudgets?: Record<ContextTier, TierBudget>;
}

/** Rough token estimate: one token per four characters of content. */
export function estimateRecordTokens(records: readonly MemoryRecord[]): number {
	return records.reduce((sum, record) => sum + Math.ceil(record.content.length / 4), 0);
}

/** Which tier a retrieved record belongs to, by type and verification. */
export function assignRecordTier(record: MemoryRecord): ContextTier {
	if (record.type === "working-state") return "L1";
	if (record.type === "evidence") return "L3";
	if (record.verification === "superseded" || record.verification === "archived") return "L4";
	if (record.type === "episode") return "L4";
	return "L2";
}

function emptyTiers(): Record<ContextTier, MemoryRecord[]> {
	return { L0: [], L1: [], L2: [], L3: [], L4: [] };
}

/**
 * Greedy best-first fill of `budget.max`. A record that does not fit is
 * skipped rather than ending the scan, so one oversized high-ranked record
 * cannot starve every smaller record ranked behind it. Relative order of the
 * kept records is preserved.
 */
function applyTierBudget(records: readonly MemoryRecord[], budget: TierBudget): MemoryRecord[] {
	let tokens = 0;
	const kept: MemoryRecord[] = [];
	for (const record of records) {
		const recordTokens = estimateRecordTokens([record]);
		if (tokens + recordTokens > budget.max) continue;
		kept.push(record);
		tokens += recordTokens;
	}
	return kept;
}

/**
 * Compose a tiered context packet from ranked records.
 *
 * `records` are treated as already ranked best-first (the broker's job); the
 * composer only assigns tiers and applies budgets, so relative order within a
 * tier is preserved. Identity and task-state records are supplied separately
 * because they come from stores, not retrieval.
 */
export function composeContextPacket(
	records: readonly MemoryRecord[],
	options: ComposeContextOptions = {},
): ComposedContextPacket {
	const budgets = options.tierBudgets ?? DEFAULT_TIER_BUDGETS;
	const totalBudget = options.totalBudget ?? 900;

	const tiered = emptyTiers();
	tiered.L0 = [...(options.identity ?? [])];
	tiered.L1 = [...(options.taskState ?? [])];
	for (const record of records) {
		tiered[assignRecordTier(record)].push(record);
	}

	const result = emptyTiers();
	let totalTokens = 0;

	result.L0 = applyTierBudget(tiered.L0, budgets.L0);
	totalTokens += estimateRecordTokens(result.L0);

	result.L1 = applyTierBudget(tiered.L1, budgets.L1);
	totalTokens += estimateRecordTokens(result.L1);

	const remaining = totalBudget - totalTokens;
	if (remaining > 0) {
		result.L2 = applyTierBudget(tiered.L2, { min: 0, max: Math.min(budgets.L2.max, remaining) });
		totalTokens += estimateRecordTokens(result.L2);
	}

	result.L3 = applyTierBudget(tiered.L3, budgets.L3);
	totalTokens += estimateRecordTokens(result.L3);

	result.L4 = applyTierBudget(tiered.L4, budgets.L4);
	totalTokens += estimateRecordTokens(result.L4);

	const provenance: Record<string, string> = {};
	const shipped = [...result.L0, ...result.L1, ...result.L2, ...result.L3, ...result.L4];
	for (const record of shipped) {
		const sources = record.sourceRefs.map(ref => `${ref.type}:${ref.id}`).join(", ");
		provenance[record.id] = `${record.verification} | ${record.type} | ${sources}`;
	}

	const warnings: string[] = [];
	const provisionalCount = shipped.filter(record => record.verification === "model-proposed").length;
	if (provisionalCount > 0) {
		warnings.push(`${provisionalCount} provisional records included`);
	}

	return {
		tiers: result,
		estimatedTokens: totalTokens,
		provenance,
		warnings,
		representationPolicy: options.representationPolicy ?? "compact-first",
	};
}

/** Render a packet as the model-facing memory-context block. */
export function formatContextForModel(packet: ComposedContextPacket): string {
	const sections: string[] = [];

	if (packet.tiers.L0.length > 0) {
		sections.push("[MEMORY CONTEXT: IDENTITY]");
		for (const record of packet.tiers.L0) {
			sections.push(`- ${record.content}`);
		}
		sections.push("");
	}

	if (packet.tiers.L1.length > 0) {
		sections.push("[MEMORY CONTEXT: TASK STATE]");
		for (const record of packet.tiers.L1) {
			sections.push(`- ${record.content}`);
		}
		sections.push("");
	}

	const verified = packet.tiers.L2.filter(record => record.verification !== "model-proposed");
	const provisional = packet.tiers.L2.filter(record => record.verification === "model-proposed");

	if (verified.length > 0) {
		sections.push("[MEMORY CONTEXT: VERIFIED]");
		for (const record of verified) {
			sections.push(`- ${record.content} [${record.type}]`);
		}
		sections.push("");
	}

	if (provisional.length > 0) {
		sections.push("[MEMORY CONTEXT: PROVISIONAL]");
		for (const record of provisional) {
			sections.push(`- ${record.content} [${record.type}, confidence: ${record.confidence}]`);
		}
		sections.push("");
	}

	sections.push("---");
	sections.push(
		`Provenance: ${Object.entries(packet.provenance)
			.map(([id, line]) => `${id}=>${line}`)
			.join("; ")}`,
	);

	return sections.join("\n");
}
