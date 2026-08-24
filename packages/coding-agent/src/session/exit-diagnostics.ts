import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import type { SessionEntry } from "./session-entries";
import { correlateReplayableToolExecution } from "./tool-journal-correlation";

export const TOOL_EXECUTION_START_CUSTOM_TYPE = "tool_execution_start";
export const SESSION_EXIT_CUSTOM_TYPE = "session_exit";

/**
 * Compact projection of tool-call arguments persisted with the start marker.
 * The assistant message already carries the full arguments; this exists only
 * so `appendArgumentSummary` can name the command/path in resume warnings
 * without duplicating whole argument payloads into the session JSONL.
 */
export interface ToolArgumentSummary {
	command?: string;
	path?: string;
}

/** Persisted marker written before a tool implementation starts running. */
export interface ToolExecutionStartData {
	toolCallId: string;
	toolName: string;
	args?: ToolArgumentSummary;
	intent?: string;
	startedAt: string;
}

/** Tool call left without a matching toolResult at the end of a branch. */
export interface PendingToolCallDiagnostic {
	toolCallId?: string;
	toolName: string;
	args?: unknown;
	intent?: string;
	assistantTimestamp?: number;
	startedAt?: string;
}

/** Session shutdown marker written during normal and fatal process teardown. */
export interface SessionExitData {
	reason: string;
	kind: "normal" | "signal" | "fatal" | "process_exit";
	recordedAt: string;
	pendingToolCalls?: PendingToolCallDiagnostic[];
}

interface PendingToolCallRecord extends PendingToolCallDiagnostic {
	key: string;
}

interface ToolCallContent {
	type: "toolCall";
	id?: string;
	name?: string;
	arguments?: unknown;
}

export interface AssistantModelMetadata {
	api: AssistantMessage["api"];
	provider: string;
	model: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
	if (typeof value !== "object") return false;
	return value !== null;
}
function isPendingToolCallDiagnostic(value: unknown): value is PendingToolCallDiagnostic {
	if (!isObject(value) || typeof value.toolName !== "string") return false;
	if ("toolCallId" in value && typeof value.toolCallId !== "string") return false;
	if ("intent" in value && typeof value.intent !== "string") return false;
	if ("assistantTimestamp" in value && typeof value.assistantTimestamp !== "number") return false;
	if ("startedAt" in value && typeof value.startedAt !== "string") return false;
	return true;
}

function readPendingToolCalls(value: unknown): PendingToolCallDiagnostic[] | undefined {
	if (!Array.isArray(value) || !value.every(isPendingToolCallDiagnostic)) return undefined;
	return value;
}

function readSessionExit(entry: SessionEntry): SessionExitData | undefined {
	if (entry.type !== "custom" || entry.customType !== SESSION_EXIT_CUSTOM_TYPE || !isObject(entry.data)) {
		return undefined;
	}
	const { reason, kind, recordedAt } = entry.data;
	if (
		typeof reason !== "string" ||
		(kind !== "normal" && kind !== "signal" && kind !== "fatal" && kind !== "process_exit") ||
		typeof recordedAt !== "string"
	) {
		return undefined;
	}
	return {
		reason,
		kind,
		recordedAt,
		pendingToolCalls: readPendingToolCalls(entry.data.pendingToolCalls),
	};
}

/**
 * createInterruptedTurnAbortMessage returns a terminal assistant record when
 * the latest persisted process exit follows a non-terminal conversation tail.
 */
export function createInterruptedTurnAbortMessage(
	entries: readonly SessionEntry[],
	fallbackModel?: AssistantModelMetadata,
): AssistantMessage | undefined {
	let exitIndex = -1;
	let exit: SessionExitData | undefined;
	for (let index = entries.length - 1; index >= 0; index--) {
		const candidate = readSessionExit(entries[index]!);
		if (!candidate) continue;
		exitIndex = index;
		exit = candidate;
		break;
	}
	if (!exit || (exit.kind === "normal" && !exit.pendingToolCalls?.length)) return undefined;

	let tailIndex = -1;
	let tail: AgentMessage | undefined;
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index]!;
		if (entry.type !== "message") continue;
		tailIndex = index;
		tail = entry.message;
		break;
	}
	if (!tail || tailIndex > exitIndex) return undefined;
	if (tail.role === "assistant" && !tail.content.some(isToolCallContent)) return undefined;

	let previousAssistant: AssistantMessage | undefined;
	for (let index = tailIndex; index >= 0; index--) {
		const entry = entries[index]!;
		if (entry.type !== "message" || entry.message.role !== "assistant") continue;
		previousAssistant = entry.message;
		break;
	}
	if (
		tail.role === "toolResult" &&
		(previousAssistant?.stopReason === "error" || previousAssistant?.stopReason === "aborted")
	) {
		return undefined;
	}
	const model = previousAssistant ?? fallbackModel;
	if (!model) return undefined;

	const recordedAt = Date.parse(exit.recordedAt);
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.model,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "aborted",
		errorMessage: "Previous OMP process exited before completing the turn.",
		timestamp: Number.isFinite(recordedAt) ? recordedAt : Date.now(),
	};
}

function isToolCallContent(value: unknown): value is ToolCallContent {
	if (!isObject(value)) return false;
	return value.type === "toolCall" && (typeof value.name === "string" || typeof value.id === "string");
}

/** Character cap for each summarized argument field. */
const ARGUMENT_SUMMARY_MAX_CHARS = 200;

function truncateSummaryField(value: string): string {
	return value.length > ARGUMENT_SUMMARY_MAX_CHARS ? `${value.slice(0, ARGUMENT_SUMMARY_MAX_CHARS)}…` : value;
}

/**
 * Project full tool-call arguments down to the fields the pending-tool-call
 * resume warning actually renders (`command`/`path`), truncated. Returns
 * `undefined` when the arguments carry neither, so callers can omit `args`
 * entirely instead of persisting an empty object.
 */
export function summarizeToolArguments(args: unknown): ToolArgumentSummary | undefined {
	if (!isObject(args)) return undefined;
	const summary: ToolArgumentSummary = {};
	if (typeof args.command === "string" && args.command.length > 0) {
		summary.command = truncateSummaryField(args.command);
	}
	if (typeof args.path === "string" && args.path.length > 0) {
		summary.path = truncateSummaryField(args.path);
	}
	return summary.command !== undefined || summary.path !== undefined ? summary : undefined;
}

function readToolExecutionStart(entry: SessionEntry): ToolExecutionStartData | undefined {
	if (entry.type !== "custom" || entry.customType !== TOOL_EXECUTION_START_CUSTOM_TYPE) return undefined;
	const data = entry.data;
	if (!isObject(data)) return undefined;
	if (typeof data.toolCallId !== "string" || typeof data.toolName !== "string") return undefined;
	const startedAt = typeof data.startedAt === "string" ? data.startedAt : entry.timestamp;
	const result: ToolExecutionStartData = {
		toolCallId: data.toolCallId,
		toolName: data.toolName,
		startedAt,
	};
	// Legacy sessions persisted full argument objects; project them down.
	if ("args" in data) {
		const args = summarizeToolArguments(data.args);
		if (args) result.args = args;
	}
	if (typeof data.intent === "string") result.intent = data.intent;
	return result;
}

function appendAssistantToolCalls(pending: Map<string, PendingToolCallRecord>, message: AgentMessage): void {
	if (message.role !== "assistant") return;
	const content = Array.isArray(message.content) ? message.content : [];
	const toolCalls: PendingToolCallRecord[] = [];
	for (let index = 0; index < content.length; index++) {
		const part = content[index];
		if (!isToolCallContent(part)) continue;
		const toolName = part.name ?? "unknown";
		const key = part.id ?? `assistant:${message.timestamp ?? "unknown"}:${index}:${toolName}`;
		const record: PendingToolCallRecord = {
			key,
			toolName,
		};
		if (typeof message.timestamp === "number") record.assistantTimestamp = message.timestamp;
		if (part.id) record.toolCallId = part.id;
		if ("arguments" in part) record.args = part.arguments;
		toolCalls.push(record);
	}
	pending.clear();
	for (const toolCall of toolCalls) pending.set(toolCall.key, toolCall);
}

function applyToolExecutionStart(pending: Map<string, PendingToolCallRecord>, marker: ToolExecutionStartData): void {
	const existing = pending.get(marker.toolCallId);
	if (existing) {
		existing.startedAt = marker.startedAt;
		// The assistant message carries the full arguments; the marker only has
		// the command/path projection. Keep the richer copy when present.
		existing.args ??= marker.args;
		if (marker.intent) existing.intent = marker.intent;
		return;
	}
	const record: PendingToolCallRecord = {
		key: marker.toolCallId,
		toolCallId: marker.toolCallId,
		toolName: marker.toolName,
		args: marker.args,
		startedAt: marker.startedAt,
	};
	if (marker.intent) record.intent = marker.intent;
	pending.set(marker.toolCallId, record);
}

function applyMessageEntry(pending: Map<string, PendingToolCallRecord>, message: AgentMessage): void {
	if (message.role === "toolResult") {
		const toolCallId = typeof message.toolCallId === "string" ? message.toolCallId : undefined;
		if (toolCallId) pending.delete(toolCallId);
		return;
	}
	appendAssistantToolCalls(pending, message);
}

/**
 * Count each `toolCallId`'s `TOOL_EXECUTION_START_CUSTOM_TYPE` legacy marker
 * entries across the whole branch — deliberately **not** a count of
 * assistant-message tool-call content parts.
 *
 * `#recordToolExecutionStart` writes this marker unconditionally, for every
 * tool call regardless of protocol (`legacy_snapshot` or
 * `presentation_events`), and — like the v4 journal's own `started` write —
 * *synchronously*, in `#processAgentEvent`'s `tool_execution_start` branch,
 * before that event's own extension-delivery await and entirely independent
 * of the `tool_presentation` branch or of `message_end`'s persistence chain
 * (`agent-session.ts` lines 2510-2520: both branches run before the shared
 * `await this.#emitSessionEvent(...)`, and neither depends on the other or
 * on the assistant message's own, separately-gated persistence). Counting
 * from assistant-message content instead would reintroduce the
 * message-persistence-lag race one level up: a pending occurrence whose own
 * assistant message has not yet reached disk would silently undercount,
 * making an *unrelated*, already-resolved occurrence's journal coverage
 * look total when it is not. Counting from the marker keeps both sides of
 * the totality comparison below sourced from writes with the same
 * synchronous-relative-to-their-own-event guarantee, closing that race.
 */
function countLegacyMarkerOccurrences(entries: readonly SessionEntry[]): Map<string, number> {
	const counts = new Map<string, number>();
	for (const entry of entries) {
		const marker = readToolExecutionStart(entry);
		if (!marker) continue;
		counts.set(marker.toolCallId, (counts.get(marker.toolCallId) ?? 0) + 1);
	}
	return counts;
}

/** Count each `toolCallId`'s `tool_execution_started` journal entries across the whole branch. */
function countJournalStartedOccurrences(entries: readonly SessionEntry[]): Map<string, number> {
	const counts = new Map<string, number>();
	for (const entry of entries) {
		if (entry.type !== "tool_execution_started") continue;
		const id = entry.call.toolCallId;
		counts.set(id, (counts.get(id) ?? 0) + 1);
	}
	return counts;
}

/**
 * Source a pending call's diagnostic fields from its v4 journal record
 * instead of the legacy `tool_execution_start` marker scan, when the branch
 * actually has one (the journal is the call-descriptor
 * authority). `toolName`/`args` come from the journal's `call` (public,
 * pre-transform `rawInput` — richer than the marker's truncated
 * command/path projection). `intent` and `startedAt` are not part of
 * {@link ReplayableToolExecution}'s `call`/`presentation` shape — no producer
 * persists either there — so those two fields keep whatever the legacy scan
 * already populated on `record`; this is a per-field source substitution, not
 * a two-record merge.
 *
 * **Totality gate** (the same policy `ReplayToolJournalCursor` established
 * for the ACP replay walker): a recycled `toolCallId` can have
 * *some* of its occurrences on the typed `presentation_events` protocol
 * (journaled) and others still on `legacy_snapshot` (not journaled) — mixed
 * per-call route selection, not a hypothetical. If an *earlier*, already
 * fully-resolved occurrence of the id was journaled but the *pending*
 * (tail) occurrence itself never reached `presentation_events`, an unbounded
 * `correlateReplayableToolExecution` scan would still find that earlier
 * occurrence's `started` record — the only one that exists — and
 * misattribute its descriptor to the pending occurrence, even though the
 * pending occurrence has zero journal coverage of its own. Nothing persisted
 * says which occurrence a lone `started` record belongs to once coverage is
 * partial, so guessing would silently corrupt the diagnostic rather than
 * degrade it (the same disambiguation policy applies here: a short/partial
 * pairing disqualifies the id *entirely*, falling back to the legacy scan).
 * `markerCounts`/`journalCounts` are compared once per `toolCallId`;
 * only an *exact* match (every occurrence has its own journal entry) trusts
 * the correlation. On an exact match the earlier tail-occurrence-only
 * argument holds: the last matching `started` record is unambiguously the
 * pending occurrence's own, since every prior occurrence already accounted
 * for its own record and nothing later than the tail exists to add another.
 */
function projectPendingToolCall(
	entries: readonly SessionEntry[],
	record: PendingToolCallRecord,
	markerCounts: ReadonlyMap<string, number>,
	journalCounts: ReadonlyMap<string, number>,
): PendingToolCallDiagnostic {
	const { key: _key, ...diagnostic } = record;
	const toolCallId = diagnostic.toolCallId;
	if (toolCallId === undefined) return diagnostic;
	if ((markerCounts.get(toolCallId) ?? 0) !== (journalCounts.get(toolCallId) ?? 0)) return diagnostic;
	const execution = correlateReplayableToolExecution(entries, toolCallId);
	if (execution === undefined) return diagnostic;
	diagnostic.toolName = execution.call.toolName;
	diagnostic.args = execution.call.rawInput;
	return diagnostic;
}

/** Finds tool calls left pending at the end of a session branch. */
export function collectPendingToolCalls(entries: readonly SessionEntry[]): PendingToolCallDiagnostic[] {
	const pending = new Map<string, PendingToolCallRecord>();
	for (const entry of entries) {
		if (entry.type === "message") {
			applyMessageEntry(pending, entry.message);
			continue;
		}
		const marker = readToolExecutionStart(entry);
		if (marker) applyToolExecutionStart(pending, marker);
	}
	const markerCounts = countLegacyMarkerOccurrences(entries);
	const journalCounts = countJournalStartedOccurrences(entries);
	return [...pending.values()].map(record => projectPendingToolCall(entries, record, markerCounts, journalCounts));
}

function appendArgumentSummary(parts: string[], args: unknown): void {
	if (!isObject(args)) return;
	const command = args.command;
	if (typeof command === "string" && command.length > 0) {
		parts.push(`command \`${command}\``);
		return;
	}
	const path = args.path;
	if (typeof path === "string" && path.length > 0) parts.push(`path \`${path}\``);
}

function formatPendingToolCall(call: PendingToolCallDiagnostic): string {
	const parts = [call.toolName];
	if (call.toolCallId) parts.push(call.toolCallId);
	appendArgumentSummary(parts, call.args);
	return parts.join(" ");
}

/** Builds the resume warning shown when a prior branch ended mid-tool-call. */
export function describePendingToolCalls(entries: readonly SessionEntry[]): string | undefined {
	const pending = collectPendingToolCalls(entries);
	if (pending.length === 0) return undefined;
	const formatted = pending.map(formatPendingToolCall).join(", ");
	const noun = pending.length === 1 ? "tool call" : "tool calls";
	return `Previous session ended while ${pending.length} ${noun} remained pending: ${formatted}. The prior OMP process exited before recording tool result(s).`;
}
