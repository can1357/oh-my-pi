/**
 * Wire definitions for session state snapshots and command results.
 *
 * Fields wrapped in `absentAs` were added after the first protocol release (or
 * are informational); decoders substitute the default when an older server
 * omits them.
 */
import { absentAs, doc, type WireDefs } from "./dsl";

const JSON_OBJECT = "Record<string, unknown>";

export const stateDefs = {
	QueueMode: "'all' | 'one-at-a-time'",
	InterruptMode: "'immediate' | 'wait'",
	StreamingBehavior: "'steer' | 'followUp'",
	QueuedMessageQueue: "'steering' | 'followUp'",
	CacheWarmingMode: "'off' | 'streaming' | 'idle'",
	MessageUpdates: doc(
		"'full' | 'delta'",
		"`set_event_filter` projection: `delta` drops the accumulated snapshots from `message_update`.",
	),
	TodoStatus: "'pending' | 'in_progress' | 'completed' | 'abandoned' | 'blocked'",
	GoalOp: "'get' | 'create' | 'resume' | 'pause' | 'drop'",
	GoalStatus: "'active' | 'paused' | 'budget-limited' | 'complete' | 'dropped'",
	SlashCommandSource: "'builtin' | 'skill' | 'extension' | 'custom' | 'mcp_prompt' | 'file'",
	SubagentSubscriptionLevel: doc(
		"'off' | 'progress' | 'events'",
		"Forwarded subagent frames: none, lifecycle and progress, or also raw session events.",
	),
	AgentSource: "'bundled' | 'user' | 'project'",
	SubagentStatus: "'pending' | 'running' | 'completed' | 'failed' | 'aborted'",

	TodoItem: {
		content: "string",
		status: "TodoStatus",
		"blocker?": doc("string", "What a `blocked` task is waiting on."),
		"details?": "string",
		"notes?": "string[]",
	},
	TodoPhase: { name: "string", tasks: "TodoItem[]" },
	ContextUsage: { tokens: "number.integer", contextWindow: "number.integer", percent: "number" },
	QueuedMessagesState: doc(
		{ steering: "string[]", followUp: "string[]" },
		"Displayable queue-chip text for pending user-authored messages; accepted verbatim by `remove_queued_message`.",
	),
	ToolDescriptor: { name: "string", description: "string", "parameters?": "unknown", "examples?": "unknown[]" },
	Goal: doc(
		{
			id: "string",
			objective: "string",
			status: "GoalStatus",
			"tokenBudget?": "number.integer",
			tokensUsed: "number.integer",
			timeUsedSeconds: "number",
			createdAt: "number.integer",
			updatedAt: "number.integer",
		},
		"A tracked goal: its objective, lifecycle status, and resource accounting.",
	),
	GoalModeState: doc(
		{ enabled: "boolean", mode: "'active' | 'exiting'", "reason?": "'completed'", goal: "Goal" },
		'Session goal mode; `mode` is `"exiting"` while a completed goal unwinds.',
	),
	GoalResult: doc(
		{ goal: "Goal | null", state: "GoalModeState | null" },
		"Outcome of every `goal` op; both fields are null when the session has no goal.",
	),
	SlowModeScope: doc(
		"'session' | 'global'",
		"Where `/slow` lives: persisted config shared by every session, or this session's flex tier.",
	),
	UsageLimitLowPriority: doc(
		{
			stage: "'low_priority'",
			resetsAtSec: doc("number", "Epoch seconds when the limit that was hit resets."),
			"allowanceLeftPercent?": doc(
				"number.integer",
				"Percent of the low-priority allowance still available, when reported.",
			),
		},
		"Requests are served on the provider's low-priority (slow) lane.",
	),
	UsageLimitWrapUp: doc(
		{
			stage: "'wrap_up'",
			"resetsAtSec?": doc("number", "Epoch seconds when the limit that was hit resets, if reported."),
			extraUsage: doc("boolean", "Whether paid extra usage serves requests once the allowance is spent."),
		},
		"Requests run on a short wrap-up allowance past the limit.",
	),
	UsageLimitState: doc(
		"UsageLimitLowPriority | UsageLimitWrapUp",
		"Provider-neutral state of an account past its usage limit, discriminated by `stage`.",
	),
	SkillSelectionReason: doc(
		"'source-order' | 'custom-directory' | 'authored-over-installed'",
		"Rule that ordered the active variants of one skill name.",
	),
	SkillDiagnosticEntry: doc(
		{
			name: "string",
			filePath: "string",
			source: "string",
			"pluginName?": "string",
			"repository?": "string",
			"version?": "string",
		},
		"Allowlisted identity of one discovered skill file; `repository`/`version` are what its plugin declares.",
	),
	SkillDuplicateMatch: doc(
		"'content' | 'origin'",
		"Why a duplicate is not loaded: identical SKILL.md content, or a same-origin variant (`skills.dedupeSameOrigin`).",
	),
	SkillDiagnosticDuplicate: doc(
		{
			skill: "SkillDiagnosticEntry",
			retained: "SkillDiagnosticEntry",
			match: absentAs("SkillDuplicateMatch", "content"),
		},
		"A file not loaded because `retained` stands for it; older snapshots imply `match: content`.",
	),
	SkillResolutionDiagnostic: doc(
		{
			name: "string",
			reason: "SkillSelectionReason",
			skills: "SkillDiagnosticEntry[]",
			duplicates: "SkillDiagnosticDuplicate[]",
		},
		"A skill name that resolved into several active variants and/or left redundant copies unloaded.",
	),
	ResourceRelationship: doc(
		"'copies' | 'adaptation' | 'overlap' | 'complementary' | 'unrelated' | 'uncertain'",
		"How the model judged the compared resources to relate.",
	),
	ResourceAnalysisEvidence: doc(
		{ candidateId: "string", file: "string", quote: "string", explanation: "string" },
		"A quote from one candidate's file that supports a finding; the server validated it against the snapshot the model read.",
	),
	ResourceRecommendationAction: "'keep-all' | 'prefer'",
	ResourceRecommendation: doc(
		{
			action: "ResourceRecommendationAction",
			"preferredId?": doc("string", "Candidate id to keep; present only when `action` is `prefer`."),
			reason: "string",
		},
		"What to do with the compared resources; `prefer` only follows a preferable relationship over complete coverage.",
	),
	ResourceAnalysis: doc(
		{
			relationship: "ResourceRelationship",
			evidence: "ResourceAnalysisEvidence[]",
			differences: "string[]",
			recommendation: "ResourceRecommendation",
			limitations: "string[]",
		},
		"The model's comparison of the prepared snapshots, validated against them before it is reported.",
	),
	SkillAnalysisStatus: doc(
		"'prepared' | 'running' | 'complete' | 'failed' | 'cancelled' | 'applied' | 'stale'",
		"Lifecycle of one analysis: `prepared` has sent nothing; `stale` means the reviewed files changed after preparation or analysis, or an applied preference was restored. A completed `result` may remain for inspection but cannot be applied.",
	),
	SkillAnalysisCandidate: doc(
		{
			id: "string",
			name: "string",
			filePath: "string",
			root: "string",
			fingerprint: "string",
			complete: doc("boolean", "False when part of the skill directory was left out of the snapshot."),
			files: doc("number.integer", "Files included in the snapshot."),
			omissions: doc("string[]", "What was left out and why."),
		},
		"One skill variant an analysis would send: where it lives and how completely it is covered.",
	),
	SkillDiagnosticAnalysisRecord: doc(
		{
			id: doc("string", "Opaque server-issued id; the only handle `analyze`, `cancel` and `apply` accept."),
			name: "string",
			status: "SkillAnalysisStatus",
			model: doc("string", "Exact model selector the analysis uses."),
			bytes: doc("number.integer", "Resource bytes the request carries."),
			candidates: "SkillAnalysisCandidate[]",
			disclosure: doc(
				"string",
				"What leaving the machine means (files are data, known secrets are filtered best-effort, the conversation is excluded, charges may apply); show it with `model`, `candidates` and `bytes` before asking for consent.",
			),
			createdAt: doc("number.integer", "Epoch milliseconds when the record was prepared."),
			"result?": doc(
				"ResourceAnalysis",
				"Present once the analysis has completed, including `applied` and `stale` records.",
			),
			"error?": doc("string", "Why the last run or application did not finish."),
			applied: doc(
				"boolean",
				"The preference was saved. With `error`, the session reload failed and copies may still be active; a separately confirmed application can retry it. Restoring the copies invalidates this status.",
			),
		},
		"Server-held analysis of one skill name: what would be sent, then its status and result. Holds no full resource snapshots, credentials, or conversation; `result.evidence[].quote` carries bounded verbatim excerpts of skill files.",
	),
	SkillDiagnosticIssue: doc(
		"'conflict' | 'redundancy' | 'missing-provenance'",
		"What is wrong with a skill name: several active variants, redundant unloaded copies, or a copy that declares no repository.",
	),
	SkillDiagnosticItem: doc(
		{
			name: "string",
			issues: "SkillDiagnosticIssue[]",
			skills: "SkillDiagnosticEntry[]",
			duplicates: "SkillDiagnosticDuplicate[]",
			"reason?": "SkillSelectionReason",
			canAnalyze: doc(
				"boolean",
				"A comparable group exists, so `prepare_skill_diagnostic_analysis` can run for this name.",
			),
			"unavailableReason?": doc("string", "Why `canAnalyze` is false, e.g. a single copy with nothing to compare."),
			"analysis?": doc("SkillDiagnosticAnalysisRecord", "Current plan record for this name, in any status."),
			"lastAnalysis?": doc(
				"SkillDiagnosticAnalysisRecord",
				"Most recent finished analysis, kept while another is prepared.",
			),
		},
		"One loaded skill name with its issues and analysis state; clean single-copy names are listed with `canAnalyze: false`.",
	),
	SkillDiagnosticsSnapshot: doc(
		{
			cwd: "string",
			showStartupDiagnostics: "boolean",
			diagnostics: "SkillResolutionDiagnostic[]",
			"items?": doc(
				"SkillDiagnosticItem[]",
				"Every loaded skill name with its analysis state; absent when connected to an older server.",
			),
		},
		"Current skill resolution; an empty `diagnostics` means no conflicts or redundant installations.",
	),
	SessionState: {
		"model?": "ModelInfo",
		"thinkingLevel?": "ThinkingLevel",
		isStreaming: absentAs("boolean", false),
		isCompacting: absentAs("boolean", false),
		steeringMode: absentAs("QueueMode", "one-at-a-time"),
		followUpMode: absentAs("QueueMode", "one-at-a-time"),
		interruptMode: absentAs("InterruptMode", "immediate"),
		"sessionFile?": "string",
		sessionId: "string",
		"sessionName?": "string",
		autoCompactionEnabled: absentAs("boolean", false),
		fastModeEnabled: absentAs("boolean", false),
		fastModeActive: absentAs("boolean", false),
		slowModeSupported: absentAs(doc("boolean", "`/slow` applies to the active model."), false),
		slowModeEnabled: absentAs(
			doc("boolean", "`/slow` is on for the active model; always `false` when `slowModeSupported` is `false`."),
			false,
		),
		"slowModeScope?": doc("SlowModeScope", "Where the active model's `/slow` lives; absent when unsupported."),
		"usageLimit?": doc(
			"UsageLimitState",
			"Usage-limit stage of the active model's account; absent outside wrap-up and low priority.",
		),
		tokensPerSecond: absentAs("number | null", null),
		messageCount: absentAs("number.integer", 0),
		queuedMessageCount: absentAs("number.integer", 0),
		hasPendingAsyncWork: absentAs(
			doc("boolean", "Background jobs or deliveries can still inject a follow-up and wake the session."),
			false,
		),
		isSettled: absentAs(
			doc("boolean", "Idle with nothing queued or pending; same predicate as `session_settled`."),
			false,
		),
		queuedMessages: absentAs("QueuedMessagesState", { steering: [], followUp: [] }),
		todoPhases: absentAs("TodoPhase[]", []),
		systemPrompt: absentAs(doc("string[]", "System prompt sections, for session dumps."), []),
		dumpTools: absentAs("ToolDescriptor[]", []),
		"contextUsage?": "ContextUsage",
		goal: absentAs(doc("GoalModeState | null", "Current goal mode; null when the session has no goal."), null),
		"skillDiagnostics?": doc(
			"SkillDiagnosticsSnapshot",
			"Current skill-resolution details; absent when connected to an older server.",
		),
	},

	BashResult: {
		output: "string",
		"exitCode?": "number.integer",
		cancelled: "boolean",
		"timedOut?": "boolean",
		truncated: "boolean",
		totalLines: "number.integer",
		totalBytes: "number.integer",
		outputLines: "number.integer",
		outputBytes: "number.integer",
		"artifactId?": "string",
		"artifactElidedBytes?": "number.integer",
		"artifactError?": JSON_OBJECT,
		"workingDir?": "string",
		"images?": "ImageContent[]",
	},
	FastModeResult: { enabled: "boolean", active: "boolean" },
	CompactionResult: {
		summary: "string",
		"shortSummary?": "string",
		firstKeptEntryId: "string",
		tokensBefore: "number.integer",
		"details?": "unknown",
		"preserveData?": JSON_OBJECT,
	},
	ModelCycleResult: { model: "ModelInfo", "thinkingLevel?": "ThinkingLevel", isScoped: "boolean" },
	ThinkingLevelCycleResult: { level: "Effort" },
	CancellationResult: { cancelled: "boolean" },
	OpenSessionResult: doc(
		{ cancelled: "boolean", resumed: "boolean", sessionId: "string", "sessionFile?": "string" },
		"`open_session` outcome; `resumed` is false when a fresh session was started.",
	),
	RemoveQueuedMessageResult: {
		removed: "boolean",
		"images?": doc("ImageContent[]", "The removed message's images, so the client can restore them with its text."),
		"imagesDropped?": doc(
			"boolean",
			"Only ever `true`: the images exceeded the transport limit and were omitted; the removal still happened.",
		),
	},
	PromoteQueuedMessageResult: { promoted: "boolean" },
	RestoredQueuedMessage: doc(
		{ text: "string", "images?": "ImageContent[]" },
		"Queued user content withdrawn from the queue, as the editor would restore it.",
	),
	AbortAndRestoreQueueResult: doc(
		{
			steering: "RestoredQueuedMessage[]",
			followUp: "RestoredQueuedMessage[]",
			"imagesDropped?": doc(
				"boolean",
				"Only ever `true`: the full result exceeded the transport limit and every `images` was omitted.",
			),
			"truncated?": doc(
				"boolean",
				"Only ever `true`: even the text-only result exceeded the limit, so only an oldest-first prefix is listed.",
			),
		},
		"User-authored queued input withdrawn before the abort, oldest first.",
	),
	BranchMessage: { entryId: "string", text: "string" },
	BranchResult: { text: "string", cancelled: "boolean" },
	TokenUsage: {
		input: "number.integer",
		output: "number.integer",
		reasoning: absentAs("number.integer", 0),
		cacheRead: "number.integer",
		cacheWrite: "number.integer",
		total: "number.integer",
	},
	SessionCredits: { cost: "number", committedCost: "number", acuCost: "number" },
	SessionStats: {
		"sessionFile?": "string",
		sessionId: "string",
		userMessages: "number.integer",
		assistantMessages: "number.integer",
		toolCalls: "number.integer",
		toolResults: "number.integer",
		totalMessages: "number.integer",
		tokens: "TokenUsage",
		premiumRequests: "number",
		cost: "number",
		"credits?": "SessionCredits",
		"routedModels?": "Record<string, number>",
		"contextUsage?": "ContextUsage",
	},
	MessagesPage: {
		messages: "AgentMessage[]",
		totalMessages: "number.integer",
		"nextCursor?": doc("string", "Opaque cursor for the next page; absent on the last page."),
	},
	SlashCommandInput: { "hint?": "string" },
	SlashSubcommand: { name: "string", "description?": "string", "usage?": "string" },
	AvailableSlashCommand: {
		name: "string",
		"aliases?": "string[]",
		"description?": "string",
		"input?": "SlashCommandInput",
		"subcommands?": "SlashSubcommand[]",
		source: "SlashCommandSource",
	},
	SessionEntries: doc(
		{ entries: `${JSON_OBJECT}[]`, leafId: "string | null" },
		"OMP-native session entries in append order.",
	),
	SessionTree: doc({ tree: `${JSON_OBJECT}[]`, leafId: "string | null" }, "Raw session tree roots."),
	SubagentSnapshot: {
		id: "string",
		index: "number.integer",
		agent: "string",
		agentSource: "AgentSource",
		"description?": "string",
		status: "SubagentStatus",
		"task?": "string",
		"assignment?": "string",
		"sessionFile?": "string",
		lastUpdate: "number.integer",
		"progress?": doc(JSON_OBJECT, "Raw `AgentProgress` record."),
		"parentToolCallId?": "string",
	},
	SubagentMessages: doc(
		{
			sessionFile: "string",
			fromByte: "number.integer",
			nextByte: doc("number.integer", "Pass as the next `fromByte` to read incrementally."),
			reset: doc("boolean", "`fromByte` exceeded the file size and reading restarted at zero."),
			entries: `${JSON_OBJECT}[]`,
			messages: "AgentMessage[]",
		},
		"Incremental subagent transcript read.",
	),
	BtwStatus: doc(
		"'running' | 'complete' | 'cancelled' | 'error' | 'interrupted'",
		"Side-question turn lifecycle; `interrupted` marks a turn whose process died while it ran.",
	),
	BtwHistoryTurn: doc(
		{
			question: "string",
			answer: "string",
			status: "BtwStatus",
			createdAt: "number.integer",
			updatedAt: "number.integer",
			"error?": "string",
		},
		"One question and its answer within a side-question topic.",
	),
	BtwHistoryRecord: doc(
		{
			question: "string",
			answer: "string",
			status: "BtwStatus",
			createdAt: "number.integer",
			updatedAt: "number.integer",
			"error?": "string",
			id: "string",
			leafId: "string | null",
			"followUps?": "BtwHistoryTurn[]",
		},
		"A side-question topic: its first turn's fields plus follow-ups; the latest turn is the last follow-up, else the record.",
	),
	LoginProvider: { id: "string", name: "string", available: "boolean", authenticated: "boolean" },
	LogoutAccount: doc(
		{
			credentialId: "number.integer",
			provider: "string",
			label: "string",
			detail: "string",
			type: "'api_key' | 'oauth'",
			active: "boolean",
		},
		"A stored credential `logout` can remove; `active` marks credentials the session may be using.",
	),
	HandoffResult: { "savedPath?": "string" },
	PromptAck: doc(
		{ "agentInvoked?": "boolean" },
		"`agentInvoked: false` means the prompt completed locally and no `prompt_result` follows.",
	),
} satisfies WireDefs;
