/**
 * `model-usage` replicated domain: the MRU model-picker ordering signal.
 *
 * The merge key is the model key (`provider/modelId`); the `rev` is the row's
 * last-used timestamp. Merge is pure last-writer-wins on that timestamp — for
 * an MRU signal, "used most recently on any machine" is exactly the ordering
 * every replica should converge to, so there is nothing to reconcile beyond
 * keeping the maximum. There are no tombstones: an MRU recency signal has no
 * meaningful "unused" state to delete.
 *
 * Unit note: the local `model_usage.last_used_at` column stores epoch SECONDS
 * (`strftime('%s','now')`), but the wire `rev` is epoch MILLIS like every other
 * domain, so this domain multiplies by 1000 outbound and divides inbound.
 */

import { logger } from "@oh-my-pi/pi-utils";
import type { AgentStorage } from "../../session/agent-storage";
import type { ReplicatedDomain } from "../replica";
import type { StateEntry } from "../wire";

/** Payload carried in a model-usage {@link StateEntry.value}. `lastUsedAt` is epoch MILLIS. */
interface ModelUsageValue {
	modelKey: string;
	lastUsedAt: number;
}

/**
 * Validate a remote value into a {@link ModelUsageValue}, or `null` if malformed.
 * Kept total so `applyRemote` can drop a bad entry with a log instead of throwing.
 */
function parseValue(value: unknown): ModelUsageValue | null {
	if (typeof value !== "object" || value === null) return null;
	const { modelKey, lastUsedAt } = value as Partial<ModelUsageValue>;
	if (typeof modelKey !== "string" || modelKey.length === 0) return null;
	if (typeof lastUsedAt !== "number" || !Number.isFinite(lastUsedAt)) return null;
	return { modelKey, lastUsedAt };
}

/**
 * Create the `model-usage` domain replicating {@link AgentStorage}'s MRU table.
 * `storage` is optional so an integration that has not opened agent.db yet gets
 * a safe no-op domain rather than a crash.
 */
export function createModelUsageDomain(storage?: AgentStorage): ReplicatedDomain {
	return {
		id: "model-usage",

		changedSince(afterRev: number, limit: number): StateEntry[] {
			if (!storage) return [];
			// Wire `rev` is millis; the table is seconds. `afterRev` always lands
			// on a whole-second boundary (every emitted rev is seconds*1000), so
			// flooring is exact and the strict `>` never re-emits an already-sent
			// row. Ties within one second that split across a page boundary are
			// skipped until the model is used again — acceptable for a recency
			// hint, never for correctness.
			const afterSeconds = Math.floor(afterRev / 1000);
			const rows = storage.scanModelUsageChangedSince(afterSeconds, limit);
			return rows.map<StateEntry>(row => {
				const lastUsedAt = row.last_used_at * 1000;
				return { key: row.model_key, rev: lastUsedAt, value: { modelKey: row.model_key, lastUsedAt } };
			});
		},

		applyRemote(entries: readonly StateEntry[]): void {
			if (!storage) return;
			const rows: Array<{ modelKey: string; lastUsedAt: number }> = [];
			for (const entry of entries) {
				// No tombstones for a pure LWW-max recency signal.
				if (entry.value === null) continue;
				const value = parseValue(entry.value);
				if (!value) {
					logger.debug("model-usage domain: dropping malformed entry", { key: entry.key });
					continue;
				}
				// Millis back to the table's second granularity.
				rows.push({ modelKey: value.modelKey, lastUsedAt: Math.floor(value.lastUsedAt / 1000) });
			}
			storage.mergeRemoteModelUsage(rows);
		},
	};
}
