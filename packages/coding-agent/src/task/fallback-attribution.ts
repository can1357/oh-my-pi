import type { SessionEntry } from "../session/session-entries";

/**
 * Resolve the persisted `model_change` that belongs to one `retry_fallback_applied`
 * event. The primary session appends the entry (carrying `fallback.from`) right
 * before emitting the event; advisor fallbacks emit the same event but append no
 * entry. The newest fallback entry is therefore attributed only when it names the
 * event's own source model and has not been attributed before, so an advisor
 * event can neither reuse an older primary entry nor duplicate it.
 */
export function findFallbackEntryForEvent(
	branch: readonly SessionEntry[],
	eventFrom: string,
	consumedEntryIds: ReadonlySet<string>,
): Extract<SessionEntry, { type: "model_change" }> | undefined {
	for (let i = branch.length - 1; i >= 0; i--) {
		const entry = branch[i];
		if (entry.type !== "model_change" || !entry.resolvedModelIsFallback) continue;
		if (consumedEntryIds.has(entry.id)) return undefined;
		return entry.fallback?.from === eventFrom ? entry : undefined;
	}
	return undefined;
}
