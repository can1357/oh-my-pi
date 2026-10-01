/**
 * Tail-first snapshots (issue #9469): which slice of the active branch a guest
 * receives on join (`hello.snapshot`) and on each `fetch-history` page.
 *
 * The guest owns the byte budget; the host only ever cuts at turn boundaries
 * and always sends at least one whole turn, however large.
 */
import { isTurnStartEntry } from "@oh-my-pi/pi-agent-core/compaction";
import { type ReplicatedEntry, replicationByteLength, shrinkReplicatedEntry } from "./replication-shrink";

/**
 * A guest's byte budget from `hello.snapshot` or `fetch-history.maxBytes`.
 * `null` means the request is absent or malformed; `undefined` budget means
 * "no limit". Never throws: hello handling must not fail on guest input.
 */
export function parseTailRequest(value: unknown): { maxBytes: number | undefined } | null {
	if (typeof value !== "object" || value === null) return null;
	const request = value as { mode?: unknown; maxBytes?: unknown };
	if (request.mode !== "tail") return null;
	const maxBytes = parseBudget(request.maxBytes);
	return maxBytes === null ? null : { maxBytes };
}

/** `undefined` for an absent budget, `null` for a malformed one. */
export function parseBudget(value: unknown): number | undefined | null {
	if (value === undefined) return undefined;
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * Start index of the window of whole turns that ends just before `end`.
 *
 * Walks back one turn at a time (a turn runs from one `isTurnStartEntry` to
 * the next; entries before the first turn start join the first turn) and
 * stops before the turn that would take the total past `maxBytes`. The first
 * turn is always taken. With no budget the window reaches the root. Entries
 * are measured as they will be sent: after the per-entry shrink.
 */
export function selectTurnWindow(path: readonly ReplicatedEntry[], end: number, maxBytes: number | undefined): number {
	if (maxBytes === undefined) return 0;
	let start = end;
	let total = 0;
	while (start > 0) {
		let turnStart = start - 1;
		while (turnStart > 0 && !isTurnStartEntry(path[turnStart] as ReplicatedEntry)) turnStart--;
		let turnBytes = 0;
		for (let i = turnStart; i < start; i++) {
			turnBytes += replicationByteLength(shrinkReplicatedEntry(path[i] as ReplicatedEntry)) ?? 0;
		}
		if (start < end && total + turnBytes > maxBytes) break;
		total += turnBytes;
		start = turnStart;
	}
	return start;
}
