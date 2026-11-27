/**
 * `tool_result_prune` records: how a session file remembers the tool results a
 * prune pass blanked in place.
 *
 * The per-turn prune passes blank stale tool results in memory and append one
 * record listing them (`SessionManager.appendToolResultPrunes`), instead of
 * republishing the whole transcript. The original result line stays in the
 * file, so every reader that loads a whole session file calls
 * {@link applyToolResultPrunes}: `SessionManager` resume and `forkFrom`,
 * `loadSessionMessagesReadOnly` (`history://` and `agent://`), `omp anonymize`,
 * `collectSubSessions` (HTML export, `/dump`, subagent restore), and the Agent
 * Hub viewer. Where the reader migrates and resolves blobs, it applies the
 * records after migration and before blob resolution, so a pruned result's
 * blobs are never read.
 *
 * The collab-web transcript and RPC subagent messages expose raw byte-offset
 * entries. They keep a result's original content and carry the prune record
 * beside it, so their clients can apply it.
 *
 * A later full rewrite folds the blanked content inline and keeps the records;
 * replaying a record over already-blanked content changes nothing.
 */
import { blankToolResult, type ToolResultPrune } from "@oh-my-pi/pi-agent-core/compaction/pruning";
import { logger } from "@oh-my-pi/pi-utils";
import type { FileEntry, SessionEntry } from "./session-entries";

/** `customType` of the custom entry a prune pass appends; reserved for core (see `docs/session.md`). */
export const TOOL_RESULT_PRUNE_CUSTOM_TYPE = "tool_result_prune";

/**
 * One blanked tool result as persisted in a prune record: the fields of
 * agent-core's {@link ToolResultPrune} that replay needs.
 */
export type ToolResultPruneRecord = Pick<ToolResultPrune, "entryId" | "notice" | "prunedAt">;

/** `data` of a `tool_result_prune` custom entry. */
export interface ToolResultPruneData {
	readonly results: readonly ToolResultPruneRecord[];
}

/**
 * The `data` to persist for one prune pass. Copies each field explicitly, so a
 * field added to agent-core's in-memory {@link ToolResultPrune} does not
 * silently become part of the on-disk record.
 */
export function toToolResultPruneData(pruned: readonly ToolResultPrune[]): ToolResultPruneData {
	return { results: pruned.map(({ entryId, notice, prunedAt }) => ({ entryId, notice, prunedAt })) };
}

function isToolResultPruneRecord(value: unknown): value is ToolResultPruneRecord {
	return (
		typeof value === "object" &&
		value !== null &&
		"entryId" in value &&
		typeof value.entryId === "string" &&
		"notice" in value &&
		typeof value.notice === "string" &&
		"prunedAt" in value &&
		typeof value.prunedAt === "number"
	);
}

/** Whether `value` is a well-formed `tool_result_prune` record's `data`; readers skip a record that is not. */
export function isToolResultPruneData(value: unknown): value is ToolResultPruneData {
	return (
		typeof value === "object" &&
		value !== null &&
		"results" in value &&
		Array.isArray(value.results) &&
		value.results.every(isToolResultPruneRecord)
	);
}

/**
 * Blank, in place, every tool result a `tool_result_prune` record in
 * `entries` names, so freshly loaded entries rebuild to the context the live
 * session had after its prune passes. Order-independent: a record may precede
 * its target. A malformed record, or a result whose target is missing or not a
 * tool result, is skipped with a warning.
 */
export function applyToolResultPrunes(entries: readonly FileEntry[]): void {
	let byId: Map<string, SessionEntry> | undefined;
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== TOOL_RESULT_PRUNE_CUSTOM_TYPE) continue;
		if (!isToolResultPruneData(entry.data)) {
			logger.warn("Skipping malformed tool-result prune record", { id: entry.id });
			continue;
		}
		if (!byId) {
			byId = new Map();
			for (const candidate of entries) if (candidate.type !== "session") byId.set(candidate.id, candidate);
		}
		for (const result of entry.data.results) {
			const target = byId.get(result.entryId);
			if (target?.type !== "message" || target.message.role !== "toolResult") {
				logger.warn("Tool-result prune record targets no tool result", { id: entry.id, target: result.entryId });
				continue;
			}
			blankToolResult(target.message, result.notice, result.prunedAt);
		}
	}
}
