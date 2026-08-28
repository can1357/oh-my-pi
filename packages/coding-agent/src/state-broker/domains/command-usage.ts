/**
 * `command-usage` replicated domain: per-install slash-command invocation
 * counters feeding the autocomplete frequency ranker.
 *
 * A command count is a COUNTER, not a last-writer-wins value. A naive LWW merge
 * into the shared `command_usage` table would make the fleet-wide count equal
 * whichever machine wrote last, and pushing a summed count back would
 * double-count on every sync cycle. So counters are partitioned by install: the
 * wire key is `` `${installId}\u0000${name}` ``, giving every machine its own
 * row where LWW-per-key is correct and commutative. Each install stays the sole
 * writer of its own counter, so its monotonically-growing count simply
 * converges to the latest version everywhere.
 *
 * `applyRemote` stores rows from OTHER installs (via `command_usage_remote`) and
 * ignores rows from THIS install — the local `command_usage` table is already
 * authoritative for our own counter. `AgentStorage.listCommandUsageMerged()`
 * sums local + remote for the ranker.
 *
 * Unit note: local `command_usage.last_used_at` is epoch SECONDS; wire `rev`
 * (and the stored remote `last_used_at`) are epoch MILLIS, so the domain
 * multiplies by 1000 outbound.
 */

import { getInstallId, logger } from "@oh-my-pi/pi-utils";
import type { AgentStorage } from "../../session/agent-storage";
import type { ReplicatedDomain } from "../replica";
import type { StateEntry } from "../wire";

/** Separator between install id and command name in the wire key. NUL never appears in either. */
const KEY_SEP = "\u0000";

/** Payload carried in a command-usage {@link StateEntry.value}. `lastUsedAt` is epoch MILLIS. */
interface CommandUsageValue {
	installId: string;
	name: string;
	count: number;
	lastUsedAt: number;
}

/**
 * Validate a remote value into a {@link CommandUsageValue}, or `null` if
 * malformed. Kept total so `applyRemote` drops a bad entry with a log instead
 * of throwing.
 */
function parseValue(value: unknown): CommandUsageValue | null {
	if (typeof value !== "object" || value === null) return null;
	const { installId, name, count, lastUsedAt } = value as Partial<CommandUsageValue>;
	if (typeof installId !== "string" || installId.length === 0) return null;
	if (typeof name !== "string" || name.length === 0) return null;
	if (typeof count !== "number" || !Number.isFinite(count)) return null;
	if (typeof lastUsedAt !== "number" || !Number.isFinite(lastUsedAt)) return null;
	return { installId, name, count, lastUsedAt };
}

/**
 * Create the `command-usage` domain replicating this install's slash-command
 * counters. `storage` is optional so an integration that has not opened
 * agent.db yet gets a safe no-op domain; `installId` defaults to this machine's
 * id and is injectable for tests.
 */
export function createCommandUsageDomain(storage?: AgentStorage, installId: string = getInstallId()): ReplicatedDomain {
	return {
		id: "command-usage",

		changedSince(afterRev: number, limit: number): StateEntry[] {
			if (!storage) return [];
			// Wire `rev` is millis; the table is seconds. `afterRev` lands on a
			// whole-second boundary (every emitted rev is seconds*1000), so
			// flooring is exact and the strict `>` never re-emits a sent row.
			const afterSeconds = Math.floor(afterRev / 1000);
			const rows = storage.scanCommandUsageChangedSince(afterSeconds, limit);
			return rows.map<StateEntry>(row => {
				const lastUsedAt = row.last_used_at * 1000;
				return {
					key: `${installId}${KEY_SEP}${row.name}`,
					rev: lastUsedAt,
					value: { installId, name: row.name, count: row.count, lastUsedAt },
				};
			});
		},

		applyRemote(entries: readonly StateEntry[]): void {
			if (!storage) return;
			const rows: Array<{ installId: string; name: string; count: number; lastUsedAt: number }> = [];
			for (const entry of entries) {
				// Counters are never deleted; a tombstone would drop a peer's total.
				if (entry.value === null) continue;
				const value = parseValue(entry.value);
				if (!value) {
					logger.debug("command-usage domain: dropping malformed entry", { key: entry.key });
					continue;
				}
				// Our own counter is authoritative locally; ignore its echo.
				if (value.installId === installId) continue;
				rows.push(value);
			}
			storage.mergeRemoteCommandUsage(rows);
		},
	};
}
