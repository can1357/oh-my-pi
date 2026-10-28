/**
 * Wire definitions for session events: the `AgentSessionEvent` stream RPC mode
 * forwards (subject to `set_event_filter`), with `messageId` stamped on message
 * lifecycle frames.
 */
import { absentAs, doc, type WireDefs } from "./dsl";

const JSON_OBJECT = "Record<string, unknown>";
const MESSAGE_ID = doc("string", "Shared by the start, updates, and end of one message; unique per process.");

export const eventDefs = {
	AutoCompactionReason: "'threshold' | 'overflow' | 'idle' | 'incomplete'",
	AutoCompactionAction: "'context-full' | 'remote' | 'handoff' | 'shake' | 'snapcompact'",
	CacheWarmingPhase: "'streaming' | 'idle'",
	CacheWarmingOutcome: "'hit' | 'miss' | 'error' | 'aborted'",
	NotifyType: "'info' | 'warning' | 'error'",

	AgentStartEvent: {
		type: "'agent_start'",
		"resumedToolCallIds?": doc(
			"string[]",
			"Calls of an unpaired assistant tail a continued run executes before its first model request.",
		),
	},
	AgentEndEvent: {
		type: "'agent_end'",
		messages: doc(
			"AgentMessage[]",
			"Messages of the run; an oversized frame drops a prefix already delivered by `message_end` (see `messageCount`).",
		),
		"messageCount?": doc("number.integer", "Original message count when the frame was compacted."),
		"isTerminal?": doc("boolean", "False when a continuation or async delivery remains."),
		"yielded?": doc(
			"boolean",
			"The agent finished its turn and resumes only for queued input or background-job results.",
		),
		"awaitingAsyncWork?": doc("boolean", "Non-terminal end whose only possible resume is a background-job result."),
		"telemetry?": JSON_OBJECT,
		"coverage?": JSON_OBJECT,
	},
	TurnStartEvent: { type: "'turn_start'" },
	TurnEndEvent: { type: "'turn_end'", message: "AgentMessage", toolResults: "ToolResultMessage[]" },
	MessageStartEvent: { type: "'message_start'", message: "AgentMessage", "messageId?": MESSAGE_ID },
	MessageUpdateEvent: {
		type: "'message_update'",
		message: "AgentMessage",
		assistantMessageEvent: "AssistantMessageEvent",
		"messageId?": MESSAGE_ID,
	},
	MessageEndEvent: { type: "'message_end'", message: "AgentMessage", "messageId?": MESSAGE_ID },
	ToolExecutionStartEvent: {
		type: "'tool_execution_start'",
		toolCallId: "string",
		toolName: "string",
		"args?": "unknown",
		"intent?": "string",
	},
	ToolExecutionUpdateEvent: {
		type: "'tool_execution_update'",
		toolCallId: "string",
		toolName: "string",
		"args?": "unknown",
		"partialResult?": "unknown",
	},
	ToolStreamUpdateEvent: {
		type: "'tool_stream_update'",
		toolCallId: "string",
		toolName: "string",
		"update?": "unknown",
	},
	ToolExecutionEndEvent: {
		type: "'tool_execution_end'",
		toolCallId: "string",
		toolName: "string",
		"result?": "unknown",
		"isError?": "boolean",
	},
	AutoCompactionStartEvent: {
		type: "'auto_compaction_start'",
		reason: "AutoCompactionReason",
		action: "AutoCompactionAction",
	},
	AutoCompactionEndEvent: {
		type: "'auto_compaction_end'",
		action: "AutoCompactionAction",
		"result?": "CompactionResult",
		aborted: "boolean",
		willRetry: "boolean",
		"errorMessage?": "string",
		"skipped?": doc("boolean", "Compaction was skipped for a benign reason."),
	},
	ManualCompactionStartEvent: doc(
		{
			type: "'manual_compaction_start'",
			"mode?": doc("string", "The `/compact <mode>` subcommand, when one was given."),
		},
		"A manual compaction (`compact` command, `/compact`, extension `ctx.compact()`) began; the live turn is already aborted.",
	),
	ManualCompactionEndEvent: doc(
		{
			type: "'manual_compaction_end'",
			"result?": doc("CompactionResult", "Present when the compaction committed."),
			aborted: doc("boolean", "The compaction was cancelled (abort, or a `session_before_compact` hook)."),
			"skipped?": doc("boolean", "There was nothing to compact; `errorMessage` says why."),
			"errorMessage?": "string",
		},
		"Outcome of the compaction announced by the matching `manual_compaction_start`.",
	),
	AutoRetryStartEvent: {
		type: "'auto_retry_start'",
		attempt: "number.integer",
		maxAttempts: "number.integer",
		delayMs: "number.integer",
		errorMessage: "string",
		"errorId?": "number.integer",
	},
	AutoRetryEndEvent: {
		type: "'auto_retry_end'",
		success: "boolean",
		attempt: "number.integer",
		"finalError?": "string",
		retryErrors: absentAs(
			doc(`${JSON_OBJECT}[]`, "Persisted retry errors whose presentation changed when the retry settled."),
			[],
		),
	},
	CacheWarmingStartEvent: doc(
		{ type: "'cache_warming_start'", phase: "CacheWarmingPhase", provider: "string", model: "string" },
		"A prompt-cache refresh was handed to the provider.",
	),
	CacheWarmingEndEvent: doc(
		{
			type: "'cache_warming_end'",
			phase: "CacheWarmingPhase",
			provider: "string",
			model: "string",
			outcome: "CacheWarmingOutcome",
			"usage?": doc("Usage", "Present only when the refresh was billed."),
			"warmingStopReason?": doc("string", "Why warming stopped; absent while it continues."),
		},
		"Outcome of the refresh announced by the matching `cache_warming_start`.",
	),
	RetryFallbackAppliedEvent: {
		type: "'retry_fallback_applied'",
		from: "string",
		to: "string",
		role: "string",
		"reason?": "string",
	},
	RetryFallbackSucceededEvent: { type: "'retry_fallback_succeeded'", model: "string", role: "string" },
	ModelChangedEvent: { type: "'model_changed'" },
	ConfigWarningsChangedEvent: { type: "'config_warnings_changed'" },
	AdvisorCostChangedEvent: { type: "'advisor_cost_changed'" },
	AdvisorYieldedEvent: { type: "'advisor_yielded'" },
	TtsrTriggeredEvent: doc(
		{ type: "'ttsr_triggered'", rules: `${JSON_OBJECT}[]` },
		"Rule injection: a TTSR rule matched the stream and its text was injected. Each rule carries at least `name`, `path`, and `content`.",
	),
	TodoReminderEvent: {
		type: "'todo_reminder'",
		todos: "TodoItem[]",
		attempt: "number.integer",
		maxAttempts: "number.integer",
	},
	TodoAutoClearEvent: { type: "'todo_auto_clear'" },
	IrcMessageEvent: { type: "'irc_message'", message: "CustomMessage" },
	NoticeEvent: { type: "'notice'", level: "NotifyType", message: "string", "source?": "string" },
	ThinkingLevelChangedEvent: doc(
		{
			type: "'thinking_level_changed'",
			"thinkingLevel?": "ThinkingLevel",
			"configured?": doc("ConfiguredThinkingLevel", "The user's selector when it differs from the effective level."),
			"resolved?": doc("Effort", "The level `auto` resolved to this turn, once classified."),
		},
		"The effective thinking level changed.",
	),
	GoalUpdatedEvent: doc(
		{ type: "'goal_updated'", goal: "Goal | null", "state?": "GoalModeState" },
		"Goal mode changed, by a host `goal` command or the agent's `goal` tool.",
	),
	QueueUpdateEvent: doc(
		{
			type: "'queue_update'",
			steering: "string[]",
			followUp: "string[]",
			liveSteered: absentAs(
				doc(
					"number.integer",
					"Leading `steering` entries are live steering already sent into the streaming response; `remove_queued_message` cannot reach them.",
				),
				0,
			),
		},
		"Coalesced snapshot of the displayable steering/follow-up queue, sent whenever it changes.",
	),
	UserWaitStartEvent: doc(
		{ type: "'user_wait_start'", prompt: doc("string", "What the session is asking a person to decide.") },
		"The session opened a dialog only a person can answer and the turn is held until it settles.",
	),
	UserWaitEndEvent: doc(
		{ type: "'user_wait_end'" },
		"The last dialog waiting on a person settled; the turn goes on.",
	),

	RpcAgentEvent: doc(
		[
			"AgentStartEvent",
			"AgentEndEvent",
			"TurnStartEvent",
			"TurnEndEvent",
			"MessageStartEvent",
			"MessageUpdateEvent",
			"MessageEndEvent",
			"ToolExecutionStartEvent",
			"ToolExecutionUpdateEvent",
			"ToolStreamUpdateEvent",
			"ToolExecutionEndEvent",
			"AutoCompactionStartEvent",
			"AutoCompactionEndEvent",
			"ManualCompactionStartEvent",
			"ManualCompactionEndEvent",
			"AutoRetryStartEvent",
			"AutoRetryEndEvent",
			"CacheWarmingStartEvent",
			"CacheWarmingEndEvent",
			"RetryFallbackAppliedEvent",
			"RetryFallbackSucceededEvent",
			"ModelChangedEvent",
			"ConfigWarningsChangedEvent",
			"AdvisorCostChangedEvent",
			"AdvisorYieldedEvent",
			"TtsrTriggeredEvent",
			"TodoReminderEvent",
			"TodoAutoClearEvent",
			"IrcMessageEvent",
			"NoticeEvent",
			"ThinkingLevelChangedEvent",
			"GoalUpdatedEvent",
			"QueueUpdateEvent",
			"UserWaitStartEvent",
			"UserWaitEndEvent",
		].join(" | "),
		"A session event, discriminated by `type`; `set_event_filter` selects which are sent.",
	),
} satisfies WireDefs;
