import type {
	InterruptedPresentationRecord,
	StartedPresentationRecord,
	ToolCallPresentation,
	ToolCallRecord,
	ToolExecutionId,
	ToolOutcome,
	ToolPresentationRecord,
} from "@oh-my-pi/pi-agent-core/presentation";
import type { PresentationContentBlock } from "./schemas/content";
import { jsonRecordSchema } from "./schemas/journal";

/**
 * Persisted v4 tool journal and its replay-time folding.
 *
 * `CURRENT_SESSION_VERSION` is `4` and both journal variants are members of the
 * `SessionEntry` union with an explicit `migrateV3ToV4` arm behind them
 * (`../session/session-entries.ts`, `../session/session-migrations.ts`), so a
 * record of either shape is a legal, versioned part of the persisted format.
 * `AgentSession#trackToolPresentation` (`../session/agent-session.ts`) writes
 * both arms: a {@link PersistedToolExecutionStarted} record from the
 * `tool_presentation` `started` event, and the matching
 * {@link PersistedToolExecutionSettled} at settlement (reusing the same
 * `executionId`). Consumers read a {@link ReplayableToolExecution} through the
 * hydration adapter: `#replaySessionHistory` (`../modes/acp/acp-agent.ts`) via
 * `correlateReplayableToolExecution`/`hydrateReplayableToolExecution`
 * (`../session/tool-journal-correlation.ts`), plus `session-context.ts`'s
 * interrupted-tool markers and `session/exit-diagnostics.ts`.
 */

/** Version tag of {@link FrozenModelProjection}'s formatter — its own scope, distinct from `recordVersion`. */
export type ModelProjectionVersion = 1;

/** Current {@link ModelProjectionVersion}. */
export const MODEL_PROJECTION_VERSION: ModelProjectionVersion = 1;

/**
 * The exact model-facing content that entered LLM history, frozen at settlement
 * time and version-tagged so a future formatter release cannot rewrite it.
 *
 * `content` is `renderModelContent`'s own output type
 * ({@link PresentationContentBlock}) — the *model* projection, never the
 * structured presentation record. LLM context rebuild/compaction reads this
 * frozen projection; display replay reads the structured record instead. The
 * two never compete as display authority.
 */
export interface FrozenModelProjection {
	readonly version: ModelProjectionVersion;
	readonly content: readonly PresentationContentBlock[];
}

/** Version tag of a {@link PersistedToolJournal} record. Distinct from `presentation.version`, which versions only the nested presentation schema. */
export type ToolJournalRecordVersion = 1;

/** Current {@link ToolJournalRecordVersion}. */
export const TOOL_JOURNAL_RECORD_VERSION: ToolJournalRecordVersion = 1;

/**
 * `ToolCallPresentation` → `ToolCallRecord`: the write-side half of the
 * "persisted-safe counterpart" relationship `hydrate.ts` documents on the read
 * side.
 *
 * `awaitsLiveTerminal` is dropped on purpose (see {@link ToolCallRecord}'s own
 * doc comment): it is a live-routing hint meaningless on a replayed record.
 * `rawInput` is the one field that actually changes shape — a live call
 * carries `{ [key: string]: unknown }`, but the persisted record must round-trip
 * through the session JSONL, so this is the one place `unknown` crosses the
 * provenance boundary through `jsonRecordSchema` rather than a bare cast. A
 * `rawInput` that fails the JSON-safety check — including one that fails by
 * *throwing* rather than returning a validation error, e.g. a cyclic value
 * (zod's lazy record/array schemas have no visited-object guard) or a value
 * with a throwing accessor (`safeParse` reads properties directly) — is
 * dropped rather than persisting a value the schema would reject on load, or
 * worse, aborting the whole journal write and leaving the call unannounced.
 * `rawInput` is an explicitly untyped `{ [key: string]: unknown }` boundary
 * (`packages/agent/src/presentation/events.ts`), so a hostile/malformed value
 * reaching here is an expected input, not a bug in the caller — this function
 * has no failure mode of its own that reaches the caller.
 */
export function toolCallRecordOf(call: ToolCallPresentation): ToolCallRecord {
	const parsedRawInput = parseRawInput(call.rawInput);
	const record: {
		toolCallId: string;
		toolName: string;
		title: string;
		kind: ToolCallRecord["kind"];
		locations?: NonNullable<ToolCallRecord["locations"]>;
		sourceEcho?: string;
		cwd?: string;
		rawInput?: NonNullable<ToolCallRecord["rawInput"]>;
	} = {
		toolCallId: call.toolCallId,
		toolName: call.toolName,
		title: call.title,
		kind: call.kind,
	};
	if (call.locations !== undefined) record.locations = call.locations;
	if (call.sourceEcho !== undefined) record.sourceEcho = call.sourceEcho;
	if (call.cwd !== undefined) record.cwd = call.cwd;
	if (parsedRawInput !== undefined) record.rawInput = parsedRawInput;
	return record;
}

/**
 * Total, non-throwing narrowing of a live call's untyped `rawInput` into the
 * persisted-safe `JsonValue` record, or `undefined` when the value is absent
 * or not JSON-safe — including when checking that throws (a cyclic object, a
 * throwing accessor). `jsonRecordSchema.safeParse` never throws on a value
 * shaped like typical JSON, but it is not a defensive parser: its lazy
 * record/array schemas read properties directly with no visited-object guard,
 * so a pathological value can make it throw instead of returning
 * `{ success: false }`. The `try/catch` is the total boundary; `safeParse`'s
 * own success/failure result handles every value that does not throw.
 */
function parseRawInput(
	rawInput: { readonly [key: string]: unknown } | undefined,
): NonNullable<ToolCallRecord["rawInput"]> | undefined {
	if (rawInput === undefined) return undefined;
	try {
		const parsed = jsonRecordSchema.safeParse(rawInput);
		return parsed.success ? parsed.data : undefined;
	} catch {
		return undefined;
	}
}

/**
 * The `started` arm of {@link PersistedToolJournal}: the call descriptor,
 * persisted before the tool runs.
 */
export interface PersistedToolExecutionStarted {
	readonly type: "tool_execution_started";
	readonly recordVersion: ToolJournalRecordVersion;
	readonly executionId: ToolExecutionId;
	readonly call: ToolCallRecord;
	readonly presentation: StartedPresentationRecord;
}

/**
 * The `settled` arm of {@link PersistedToolJournal}: the outcome, the
 * replayable presentation record, and the frozen model projection.
 */
export interface PersistedToolExecutionSettled {
	readonly type: "tool_execution_settled";
	readonly recordVersion: ToolJournalRecordVersion;
	readonly executionId: ToolExecutionId;
	readonly outcome: ToolOutcome;
	readonly presentation: ToolPresentationRecord;
	readonly modelProjection: FrozenModelProjection;
}

/**
 * The append-only session journal's tool-call record pair.
 *
 * A `started` record can be the last thing persisted before the process dies —
 * pretending only `settled`/`interrupted` records exist is not crash-safe.
 * `started` owns the call descriptor; `settled` references it by
 * `executionId` rather than duplicating `call`, so the two records describing
 * one execution cannot disagree about what was called.
 */
export type PersistedToolJournal = PersistedToolExecutionStarted | PersistedToolExecutionSettled;

/**
 * One tool execution normalized for replay, after the hydration adapter folds
 * the raw {@link PersistedToolJournal} pair.
 *
 * A dangling `started` record with no matching `settled` one folds into the
 * explicit `interrupted` state before any consumer (display replay, branch,
 * rewind/fork, compaction) inspects tool lifecycle — no consumer reconstructs
 * dangling state independently.
 */
export type ReplayableToolExecution =
	| {
			readonly state: "settled";
			readonly call: ToolCallRecord;
			readonly outcome: ToolOutcome;
			readonly presentation: ToolPresentationRecord;
			readonly modelProjection: FrozenModelProjection;
	  }
	| {
			readonly state: "interrupted";
			readonly call: ToolCallRecord;
			readonly reason: string;
			readonly presentation: InterruptedPresentationRecord;
	  };
