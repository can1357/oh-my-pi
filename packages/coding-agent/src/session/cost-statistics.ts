import type { FileEntry } from "./session-entries";

/** Each child contributes only its own model calls; task result usage already sums its descendants. */
export interface DescendantCost {
	id: string;
	entries?: readonly FileEntry[];
	/** Own spend from a persisted transcript. */
	cost?: number;
	/** Live, in-memory own spend supersedes a possibly unflushed transcript. */
	liveCost?: number;
	running?: boolean;
}

export interface CostStatistics {
	selfCost: number;
	totalCost: number;
	pending: boolean;
}

/** Charge only direct model calls, never a task result's recursive usage summary. */
export function entryOwnCost(entry: FileEntry): number {
	if (entry.type === "model_usage") return entry.usage.cost.total;
	return entry.type === "message" && entry.message.role === "assistant" ? entry.message.usage.cost.total : 0;
}

export function ownCost(entries: readonly FileEntry[]): number {
	let cost = 0;
	for (const entry of entries) cost += entryOwnCost(entry);
	return cost;
}

/** Stable identity wins over multiple observations of the same child (disk + live). */
export function aggregateCost(selfCost: number, descendants: readonly DescendantCost[]): CostStatistics {
	const byId = new Map<string, { cost: number; pending: boolean }>();
	for (const descendant of descendants) {
		const previous = byId.get(descendant.id);
		const cost =
			descendant.liveCost ?? descendant.cost ?? (descendant.entries ? ownCost(descendant.entries) : undefined);
		byId.set(descendant.id, {
			cost: cost ?? previous?.cost ?? 0,
			pending: Boolean(descendant.running || previous?.pending),
		});
	}
	let totalCost = selfCost;
	let pending = false;
	for (const value of byId.values()) {
		totalCost += value.cost;
		pending ||= value.pending;
	}
	return { selfCost, totalCost, pending };
}
