/**
 * Shared message identity for incremental persistence and mid-run compaction.
 * Assistant emission identities survive core event snapshots without relying
 * on provider IDs, wall-clock resolution, or equal content.
 */
import { type AgentMessage, assistantMessageIdentity } from "@oh-my-pi/pi-agent-core";

/**
 * Stable identity for messages that pass through {@link AgentSession}'s
 * incremental persistence path.
 *
 * - `assistant` — process-local emission identity, shared by the original and
 *   its event/display snapshots. Context materialization stamps loaded canonical
 *   messages before any replay/display copies; direct callers are stamped here.
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
			return assistantMessageIdentity(message);
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
 * Slow-path content equality for roles with structural persistence keys.
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
