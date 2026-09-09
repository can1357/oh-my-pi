/**
 * Helpers that share one cheap, structural identity for messages — both during
 * incremental persistence and for the mid-run-compaction ordering check.
 *
 * Previously `AgentSession` carried two near-duplicate routines
 * (`#sessionMessagesReferToSameTurn` + `#messageValueSignature`) that
 * reconstructed the branch path on every check (O(n²) `unshift`) and
 * `JSON.stringify`-compared the full message content on every pairwise hit.
 * Long-running sessions with many subagents fired this thousands of times per
 * minute and froze the TUI loop (see issue #3629). The persistence key already
 * encodes a stable logical identity — timestamp + role-specific discriminators
 * — so the structural compare is now the rare collision tiebreaker (e.g. two
 * provider responses at the same millisecond with `undefined` responseId),
 * not the load-bearing check.
 *
 * The helpers here keep that identity in one place and expose the planner so
 * the persistence-ordering logic is unit-testable without standing up an
 * `AgentSession`.
 */
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";

/**
 * Stable identity for messages that pass through {@link AgentSession}'s
 * incremental persistence path.
 *
 * The discriminators chosen per role are precisely the fields that uniquely
 * identify a single logical message instance:
 *
 * - `assistant` — timestamp + provider + model + responseId + stopReason
 *   (responseId is the canonical provider-side id when available; the rest
 *   disambiguate when it is not, e.g. local/dev models).
 * - `toolResult` — timestamp + toolCallId + toolName (toolCallId is unique
 *   per execution; toolName guards against synthetic reuse).
 * - `user` / `developer` — timestamp + attribution (attribution distinguishes
 *   user-typed vs hook-injected at the same wall-clock millisecond).
 * - `fileMention` — timestamp.
 *
 * Returns `undefined` for message roles that are not persisted through this
 * path (e.g. `hookMessage`, `custom`, `bashExecution`) — those follow other
 * append paths in `SessionManager`.
 */
export function sessionMessagePersistenceKey(message: AgentMessage): string | undefined {
	switch (message.role) {
		case "assistant":
			return [
				"assistant",
				message.timestamp,
				message.provider,
				message.model,
				message.responseId ?? "",
				message.stopReason,
			].join(":");
		case "toolResult":
			return `toolResult:${message.timestamp}:${message.toolCallId}:${message.toolName}`;
		case "user":
		case "developer":
			return `${message.role}:${message.timestamp}:${message.attribution ?? ""}`;
		case "fileMention":
			return `fileMention:${message.timestamp}`;
		default:
			return undefined;
	}
}

/**
 * Slow-path content equality check used when two messages collide on
 * {@link sessionMessagePersistenceKey}. Only the role's content fields are
 * compared (no timestamps, no metadata) because the key already pinned all of
 * those down.
 *
 * Most calls into the persistence path never reach this — keys are unique
 * enough in production that the snapshot lookup short-circuits at the key
 * level. Restoring the structural compare here preserves the pre-#3629
 * contract that two messages with the same metadata BUT different content are
 * distinct (e.g. two assistant turns with `undefined` responseId emitted in
 * the same wall-clock millisecond, which is exactly how the in-memory test
 * harness crafts streamed responses).
 */
export function sameMessageContent(left: AgentMessage, right: AgentMessage): boolean {
	if (left === right) return true;
	if (left.role !== right.role) return false;
	// `JSON.stringify` is the slow-path serializer here on purpose: nothing on
	// the hot persistence-check path reaches it (key lookup short-circuits
	// first), so a stable lexicographic compare beats hand-rolling structural
	// equality for content arrays that mix text / tool blocks / file refs.
	const leftRaw = left.role === "fileMention" ? left.files : "content" in left ? left.content : undefined;
	const rightRaw = right.role === "fileMention" ? right.files : "content" in right ? right.content : undefined;
	if (leftRaw === undefined || rightRaw === undefined) return false;
	return (JSON.stringify(leftRaw) ?? "undefined") === (JSON.stringify(rightRaw) ?? "undefined");
}

/**
 * Outcome of {@link planTurnPersistence}.
 *
 * `ok` lists the turn-message indices that still need to be appended (in
 * order). `out-of-order` reports the first message whose later sibling is
 * already persisted — the caller bails so it does not silently splice a
 * stale message between newer entries on the live branch.
 */
export type TurnPersistencePlan =
	| { kind: "ok"; toPersist: readonly number[] }
	| { kind: "out-of-order"; messageIndex: number };

/**
 * Decide what to do with a turn's messages relative to what's already on the
 * branch, in a single pass over the pre-computed keys.
 *
 * @param turnKeys persistence keys for each turn message, in the order the
 *   agent loop emitted them. `undefined` slots represent messages with no
 *   persistence key (skipped silently).
 * @param persistedKeys the snapshot of persistence keys currently on the
 *   branch (built once per call from {@link sessionMessagePersistenceKey} for
 *   each persisted message entry).
 *
 * The check is O(n²) over turn messages — but `n` here is the size of one
 * turn (a handful of tool results), not the size of the branch. That's the
 * point of this refactor: the expensive O(branch) work happens exactly once,
 * inside the caller's snapshot loop, not per-comparison.
 */
export function planTurnPersistence(
	turnKeys: readonly (string | undefined)[],
	persistedKeys: ReadonlySet<string>,
): TurnPersistencePlan {
	const toPersist: number[] = [];
	for (let index = 0; index < turnKeys.length; index++) {
		const key = turnKeys[index];
		// Slots without a persistence key (non-persistent roles like `custom` /
		// `hookMessage`) take other branches in `SessionManager` — they are not
		// our responsibility to append, and they cannot violate ordering because
		// they have no identity on the branch.
		if (key === undefined) continue;
		if (persistedKeys.has(key)) continue;
		for (let later = index + 1; later < turnKeys.length; later++) {
			const laterKey = turnKeys[later];
			if (laterKey !== undefined && persistedKeys.has(laterKey)) {
				return { kind: "out-of-order", messageIndex: index };
			}
		}
		toPersist.push(index);
	}
	return { kind: "ok", toPersist };
}
