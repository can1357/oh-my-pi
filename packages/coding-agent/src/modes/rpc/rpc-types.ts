/**
 * RPC protocol types for headless operation.
 *
 * Commands are sent as JSON lines on stdin.
 * Responses and events are emitted as JSON lines on stdout.
 */
import type { AgentMessage, AgentToolResult, ThinkingLevel, ToolLoadMode } from "@oh-my-pi/pi-agent-core";
import type { CompactionResult } from "@oh-my-pi/pi-agent-core/compaction";
import type { AssistantMessageEvent, Effort, ImageContent, Model, ToolExample } from "@oh-my-pi/pi-ai";
import type { BashResult } from "../../exec/bash-executor";
import type { ContextUsage } from "../../extensibility/extensions/types";
import type { AgentSessionEvent, SessionStats } from "../../session/agent-session";
import type { RestoredQueuedMessage } from "../../session/agent-session-types";
import type { CacheWarmingMode } from "../../session/cache-warmer";
import type { FileEntry, SessionEntry, SessionHeader, SessionTreeNode } from "../../session/session-entries";
import type { UsageLimitState } from "../../session/usage-limit";
import type { AvailableSlashCommandSource } from "../../slash-commands/available-commands";
import type { AgentProgress } from "@oh-my-pi/pi-tui/tools/task";
import type { SubagentEventPayload, SubagentLifecyclePayload, SubagentProgressPayload } from "../../task";
import type { TodoPhase } from "@oh-my-pi/pi-tui/tools/todo";
import type { LogoutAccount } from "@oh-my-pi/pi-tui/overlays/logout-account-selector";
import type { LivePhase } from "@oh-my-pi/pi-tui/apps/live-visualizer";
import type { RpcMessagesPage } from "./rpc-messages";
import type { GoalModeState } from "../../goals/state";
import type { RpcGoalOp, RpcGoalResult } from "./rpc-goal";
import type { BtwHistoryRecord } from "../../session/btw-history";

// ============================================================================
// RPC Commands (stdin)
// ============================================================================

/** `set_event_filter` projection: `"full"` keeps both accumulated snapshots in `message_update`, `"delta"` sends only the increment. */
export type RpcMessageUpdates = "full" | "delta";

/**
 * Write preconditions for sequenced (socket) clients. On mismatch the command does not run and
 * fails with `code: "stale"`; abort, detach, exit, the side-channel setters, and `get_*` reads are exempt.
 */
export interface RpcPreconditions {
	/** Run only while the host's session epoch equals this. */
	ifEpoch?: number;
	/** Run only while the session leaf equals this entry id. */
	ifLeaf?: string | null;
}

type RpcCommandBody =
	// Protocol
	| { id?: string; type: "negotiate_protocol"; protocolVersion: number }
	// Session host: leave the host running / end it once no other client remains
	| { id?: string; type: "detach" }
	| { id?: string; type: "exit" }

	// Prompting
	| { id?: string; type: "prompt"; message: string; images?: ImageContent[]; streamingBehavior?: "steer" | "followUp" }
	| { id?: string; type: "steer"; message: string; images?: ImageContent[] }
	| { id?: string; type: "follow_up"; message: string; images?: ImageContent[] }
	| {
			id?: string;
			type: "remove_queued_message";
			message: string;
			queue: "steering" | "followUp";
			/** `"last"`: the newest prompt whose chip text is `message`. Default `"first"` (the raw-text-then-chip match). */
			match?: "first" | "last";
			/** Remove nothing, and answer `refused: "attachments"`, when the prompt to remove carries an attachment. */
			refuseAttachments?: boolean;
	  }
	| { id?: string; type: "promote_queued_message"; message: string }
	| { id?: string; type: "abort" }
	| { id?: string; type: "abort_and_prompt"; message: string; images?: ImageContent[] }
	| { id?: string; type: "abort_and_restore_queue" }
	| { id?: string; type: "new_session"; parentSession?: string }
	| { id?: string; type: "open_session"; sessionDir: string; provider?: string; modelId?: string }

	// State
	| { id?: string; type: "get_state" }
	| { id?: string; type: "set_fast_mode"; enabled: boolean }
	| { id?: string; type: "set_slow_mode"; enabled: boolean }
	| {
			id?: string;
			type: "goal";
			op: RpcGoalOp;
			objective?: string;
			token_budget?: number;
	  }
	| { id?: string; type: "set_ask_dialog"; enabled: boolean }
	| { id?: string; type: "set_idle_activity"; isComposing: boolean }
	| { id?: string; type: "get_available_commands" }
	| { id?: string; type: "get_entries"; since?: string }
	| { id?: string; type: "get_tree" }
	| { id?: string; type: "set_todos"; phases: TodoPhase[] }
	| { id?: string; type: "set_host_tools"; tools: RpcHostToolDefinition[] }
	| { id?: string; type: "set_host_uri_schemes"; schemes: RpcHostUriSchemeDefinition[] }
	| { id?: string; type: "set_subagent_subscription"; level: RpcSubagentSubscriptionLevel }
	| { id?: string; type: "set_event_filter"; events: string[] | null; messageUpdates?: RpcMessageUpdates }
	| { id?: string; type: "get_subagents" }
	| { id?: string; type: "get_subagent_messages"; subagentId?: string; sessionFile?: string; fromByte?: number }
	| { id?: string; type: "cancel_subagent"; subagentId: string }
	| { id?: string; type: "steer_subagent"; subagentId: string; message: string }
	// Live voice (GPT live bound to this session)
	| { id?: string; type: "live_start"; voice?: string; instructions?: string }
	| { id?: string; type: "live_stop" }
	| { id?: string; type: "live_mute"; muted?: boolean }

	// Model
	| { id?: string; type: "set_model"; provider: string; modelId: string }
	| { id?: string; type: "cycle_model" }
	| { id?: string; type: "get_available_models" }

	// Thinking
	| { id?: string; type: "set_thinking_level"; level: ThinkingLevel }
	| { id?: string; type: "cycle_thinking_level" }
	| { id?: string; type: "get_available_thinking_levels" }

	// Queue modes
	| { id?: string; type: "set_steering_mode"; mode: "all" | "one-at-a-time" }
	| { id?: string; type: "set_follow_up_mode"; mode: "all" | "one-at-a-time" }
	| { id?: string; type: "set_interrupt_mode"; mode: "immediate" | "wait" }

	// Compaction
	| { id?: string; type: "compact"; customInstructions?: string }
	| { id?: string; type: "set_auto_compaction"; enabled: boolean }

	// Cache warming
	| { id?: string; type: "set_cache_warming"; mode: CacheWarmingMode }

	// Retry
	| { id?: string; type: "set_auto_retry"; enabled: boolean }
	| { id?: string; type: "abort_retry" }

	// Bash
	| { id?: string; type: "bash"; command: string }
	| { id?: string; type: "abort_bash" }

	// Session
	| { id?: string; type: "get_session_stats" }
	| { id?: string; type: "export_html"; outputPath?: string }
	| { id?: string; type: "switch_session"; sessionPath: string; provider?: string; modelId?: string }
	| { id?: string; type: "branch"; entryId: string }
	| { id?: string; type: "fork"; entryId?: string }
	| { id?: string; type: "get_branch_messages" }
	| { id?: string; type: "get_last_assistant_text" }
	| { id?: string; type: "set_session_name"; name: string }
	| { id?: string; type: "handoff"; customInstructions?: string }

	// Messages
	| { id?: string; type: "get_messages" }
	| { id?: string; type: "get_messages_page"; cursor?: string; limit?: number }

	// Login
	| { id?: string; type: "get_login_providers" }
	| { id?: string; type: "login"; providerId: string }
	| { id?: string; type: "get_logout_accounts"; providerId: string }
	| { id?: string; type: "logout"; providerId: string; credentialId: number }

	// Word prediction (composer ghost text); `cursor` is a UTF-16 offset into `text`
	| { id?: string; type: "predict_word"; text: string; cursor: number }
	| {
			id?: string;
			type: "predict_word_feedback";
			text: string;
			cursor: number;
			suggestion: string;
			accepted: boolean;
	  }

	// Side questions (/btw); answers stream as `btw_delta` / `btw_record` frames
	| { id?: string; type: "btw"; question: string; recordId?: string }
	| { id?: string; type: "btw_cancel"; recordId?: string }
	| { id?: string; type: "get_btw_history" };

export type RpcCommand = RpcCommandBody & RpcPreconditions;

// ============================================================================
// RPC State
// ============================================================================

export interface RpcSessionState {
	model?: Model;
	thinkingLevel: ThinkingLevel | undefined;
	isStreaming: boolean;
	isCompacting: boolean;
	steeringMode: "all" | "one-at-a-time";
	followUpMode: "all" | "one-at-a-time";
	interruptMode: "immediate" | "wait";
	sessionFile?: string;
	sessionId: string;
	sessionName?: string;
	autoCompactionEnabled: boolean;
	fastModeEnabled: boolean;
	fastModeActive: boolean;
	/** `/slow` applies to the active model (flex tier on OpenAI/Google, low priority on Claude subscriptions). */
	slowModeSupported: boolean;
	/** `/slow` is on for the active model; always `false` when `slowModeSupported` is `false`. */
	slowModeEnabled: boolean;
	/**
	 * Where the active model's `/slow` lives: `global` (persisted config shared by every
	 * session, e.g. Claude low priority) or `session` (this session's flex tier). Absent when unsupported.
	 */
	slowModeScope?: "session" | "global";
	/** Usage-limit stage of the active model's account; absent outside wrap-up and low priority. */
	usageLimit?: UsageLimitState;
	tokensPerSecond: number | null;
	messageCount: number;
	queuedMessageCount: number;
	/** Background jobs or deliveries can still inject a follow-up and wake the session. */
	hasPendingAsyncWork: boolean;
	/** Same predicate as `session_settled`: idle with nothing queued or pending. */
	isSettled: boolean;
	/** Displayable queue-chip text for pending user-authored messages, mirroring
	 *  `AgentSession.getQueuedMessages()`. Render the queue from this snapshot
	 *  (and the `queue_update` event) instead of tracking chips independently. */
	queuedMessages: { steering: string[]; followUp: string[] };
	todoPhases: TodoPhase[];
	/** For session dump / export (plain-text parity with /dump). */
	systemPrompt?: string[];
	dumpTools?: Array<{ name: string; description: string; parameters: unknown; examples?: readonly ToolExample[] }>;
	/** Current context window usage. */
	contextUsage?: ContextUsage;
	/** Current goal-mode state; `null` when the session has no goal. */
	goal: GoalModeState | null;
}

export interface RpcAvailableSlashCommand {
	name: string;
	aliases?: string[];
	description?: string;
	input?: { hint?: string };
	subcommands?: Array<{ name: string; description?: string; usage?: string }>;
	source: AvailableSlashCommandSource;
}

export interface RpcAvailableCommandsUpdateFrame {
	type: "available_commands_update";
	commands: RpcAvailableSlashCommand[];
}

/** How a prompt's work ended, as reported by its {@link RpcPromptResultFrame}. */
export type RpcPromptStatus = "completed" | "aborted" | "error";

/**
 * Failure detail for a `prompt_result` with `status: "error"`. `message` is the
 * provider's error text without OMP-local diagnostics (e.g. request dump paths).
 */
export interface RpcPromptError {
	message: string;
	provider?: string;
	model?: string;
	/** HTTP status reported by the provider, when the failure came from a request. */
	httpStatus?: number;
	/** The failure is classified transient: resubmitting later may succeed. OMP's own retries are already exhausted. */
	retryable: boolean;
}

/**
 * Terminal frame emitted exactly once per accepted `prompt`/`abort_and_prompt`,
 * after all work the prompt caused has settled. Correlate on `id`.
 */
export interface RpcPromptResultFrame {
	type: "prompt_result";
	id?: string;
	/** False when the prompt completed locally (slash command) or failed before reaching the agent. */
	agentInvoked: boolean;
	status: RpcPromptStatus;
	error?: RpcPromptError;
	/**
	 * The agent yielded and nothing will wake the session again: no run is live and no
	 * queued message or background job (async bash/task/eval) will inject a follow-up.
	 * When false, a {@link RpcSessionSettledFrame} follows once that work is done.
	 */
	sessionSettled: boolean;
}

/**
 * Emitted when the session goes quiet after agent activity: the last run yielded
 * and no background work remains that could inject messages and wake it again.
 * Distinct from a terminal `agent_end`, which only means one run yielded.
 */
export interface RpcSessionSettledFrame {
	type: "session_settled";
}

// ============================================================================
// Live Voice Frames (stdout, unsolicited; not session events, so `set_event_filter` never drops them)
// ============================================================================

/** Live session phase change. */
export interface RpcLivePhaseFrame {
	type: "live_phase";
	phase: LivePhase;
}

/** Microphone/speaker RMS in [0, 1], at most one frame per 100 ms carrying the latest values. */
export interface RpcLiveLevelsFrame {
	type: "live_levels";
	input: number;
	output: number;
}

/** Incremental (`final: false`) or final transcript of one realtime turn; coalesce on `role` + `turn`. */
export interface RpcLiveTranscriptFrame {
	type: "live_transcript";
	role: "user" | "assistant";
	turn: number;
	text: string;
	final: boolean;
}

/** Emitted exactly once per live session when it has ended; `error` carries the failure cause. */
export interface RpcLiveEndFrame {
	type: "live_end";
	error?: string;
}

export type RpcLiveFrame = RpcLivePhaseFrame | RpcLiveLevelsFrame | RpcLiveTranscriptFrame | RpcLiveEndFrame;

/** `open_session` result: `resumed` is false when a fresh session was started in the directory. */
export interface RpcOpenSessionResult {
	cancelled: boolean;
	resumed: boolean;
	sessionId: string;
	sessionFile?: string;
}

/** `remove_queued_message` result. */
export interface RpcRemoveQueuedMessageResult {
	removed: boolean;
	/** The removed message's images, so the client can restore them with its text. */
	images?: ImageContent[];
	/** Set when the images exceeded the transport limit and were omitted; the removal still happened. */
	imagesDropped?: true;
	/** Nothing was removed: `refuseAttachments` was set and the prompt carries an attachment. */
	refused?: "attachments";
}

/** `abort_and_restore_queue` result: the user-authored queued input withdrawn before the abort, oldest first. */
export interface RpcAbortAndRestoreQueueResult {
	steering: RestoredQueuedMessage[];
	followUp: RestoredQueuedMessage[];
	/** Set when the full result exceeded the transport limit and every entry's `images` was omitted. */
	imagesDropped?: true;
	/** Set when even the text-only result exceeded the limit: only an oldest-first prefix is listed. */
	truncated?: true;
}

/**
 * Which of the queued chips carry an attachment (an image, or a companion holding an image's source or description)
 * that the chip's text does not. Parallel to the chip lists they accompany: entry `i` describes chip `i`, and the two
 * always travel in the same frame, so their lengths match.
 */
export interface RpcQueueAttachments {
	steering: boolean[];
	followUp: boolean[];
}

/** A connected session-host client, as listed in snapshots and `clients_changed`. */
export interface RpcClientInfo {
	clientId: string;
	kind: string;
	label?: string;
}

/**
 * Where the host session lives, for resolving links in what it authored (`local://`, relative file paths): the host's
 * cwd, artifacts directory (`null`: none, e.g. an in-memory session), the actual directory its `local://` URLs map to
 * (the host's own resolution, so an in-memory session reports the host's temp root), and its transcript id. Socket
 * clients only.
 */
export interface RpcSessionOrigin {
	cwd: string;
	artifactsDir: string | null;
	localRoot: string;
	sessionId: string;
}

/**
 * Everything a client needs to render the session from scratch. `entries`, `leafId` and the title are the session as
 * the `entry` frames have announced it: entries of an atomic batch that is still publishing, and entries recorded
 * meanwhile, are not in it and reach the client once, as entry frames after the commit.
 */
export interface RpcSnapshot {
	state: RpcSessionState;
	header: SessionHeader | null;
	entries: SessionEntry[];
	leafId: string | null;
	/** The in-flight message of a mid-turn join; later frames for it carry `messageId`. */
	streaming?: { messageId: string; message: AgentMessage };
	/** Open extension dialogs a late joiner can answer. */
	pendingUi: RpcExtensionUIRequest[];
	/**
	 * Extension statuses and widgets showing now (the latest `setStatus`/`setWidget` per key), for a client that attached
	 * after they were set. Absent from hosts that predate it.
	 */
	uiState?: RpcExtensionUIRequest[];
	clients: RpcClientInfo[];
	/**
	 * Which queued chips of `state.queuedMessages` carry an attachment, parallel to them (see {@link RpcQueueAttachments}).
	 * Absent from hosts that predate it.
	 */
	queueAttachments?: RpcQueueAttachments;
	/** Where the host session lives (see {@link RpcSessionOrigin}). Absent from hosts that predate it. */
	origin?: RpcSessionOrigin;
}

/** First frame a socket client sends; anything else, or a wrong token, gets `unauthorized` and a close. */
export interface RpcHelloFrame {
	type: "hello";
	token: string;
	protocolVersion: 1 | 2;
	client: { kind: string; label?: string };
	capabilities: { ui: boolean };
	/** Ignored, so the client gets `attached`, unless `hostId` names this host. */
	resume?: { hostId: string; epoch: number; lastSeq: number };
}

/** First frame of a fresh attach: frames after it carry `seq` > this `seq`. */
export interface RpcAttachedFrame {
	type: "attached";
	hostId: string;
	clientId: string;
	epoch: number;
	seq: number;
	snapshot: RpcSnapshot;
}

/** First frame of a resume: the `replayed` frames after `lastSeq` follow it. */
export interface RpcResumedFrame {
	type: "resumed";
	epoch: number;
	replayed: number;
}

/** A session-file append. Sequenced clients only. */
export interface RpcEntryFrame {
	type: "entry";
	entry: SessionEntry;
	/**
	 * The host's active leaf at the time the entry was announced (`null`: the session has no entries on its branch).
	 * It is the entry itself for an append on the active branch, the unchanged leaf for an off-branch append such as a
	 * retained bash result, and may name an entry announced right after this one. A client that follows the host's
	 * branch applies it with the entry. Additive: a host that predates it omits the field, and the client then keeps
	 * its previous behavior (the entry becomes the leaf).
	 */
	leafId?: string | null;
	seq: number;
}

/** The host now serves a different session (or transcript); `snapshot` replaces the client's view. Sequenced clients only. */
export interface RpcSessionReplacedFrame {
	type: "session_replaced";
	epoch: number;
	sessionFile: string | undefined;
	reason: "new" | "resume" | "fork" | "tree";
	snapshot: RpcSnapshot;
	seq: number;
}

/** Client presence changed. Sequenced clients only. */
export interface RpcClientsChangedFrame {
	type: "clients_changed";
	clients: RpcClientInfo[];
	seq: number;
}

/** Output of a builtin slash command run by this client's `prompt`; sent to that connection only, never stamped with `seq`. */
export interface RpcCommandOutputFrame {
	type: "command_output";
	text: string;
}

/** The live model or thinking level changed. `seq` is present for sequenced clients only. */
export interface RpcConfigUpdateFrame {
	type: "config_update";
	model?: Model;
	thinkingLevel?: ThinkingLevel;
	seq?: number;
}

/** The session title changed. `seq` is present for sequenced clients only. */
export interface RpcSessionInfoUpdateFrame {
	type: "session_info_update";
	title?: string;
	sessionId: string;
	/** Sequenced clients only: the session was relocated (`/move`, `/wt`), so this is where it lives now. */
	origin?: RpcSessionOrigin;
	seq?: number;
}

/** Every frame `RpcClient.onHostFrame` delivers: the session-host handshake, replica updates, and state notices. */
export type RpcHostFrame =
	| RpcAttachedFrame
	| RpcResumedFrame
	| RpcEntryFrame
	| RpcSessionReplacedFrame
	| RpcClientsChangedFrame
	| RpcCommandOutputFrame
	| RpcConfigUpdateFrame
	| RpcSessionInfoUpdateFrame;

export interface RpcReadyFrame {
	type: "ready";
	protocolVersion: 1;
	supportedProtocolVersions: [1, 2];
	maxFrameBytes: number;
	maxReassembledFrameBytes: number;
}

export interface RpcChunkFrame {
	type: "rpc_chunk";
	chunkId: string;
	index: number;
	count: number;
	byteLength: number;
	data: string;
}

export interface RpcHandoffResult {
	savedPath?: string;
}

export type RpcSubagentSubscriptionLevel = "off" | "progress" | "events";

export interface RpcSubagentSnapshot {
	id: string;
	index: number;
	agent: string;
	agentSource: AgentProgress["agentSource"];
	description?: string;
	status: AgentProgress["status"];
	task?: string;
	assignment?: string;
	sessionFile?: string;
	lastUpdate: number;
	progress?: AgentProgress;
	parentToolCallId?: string;
}

export interface RpcSubagentMessagesResult {
	sessionFile: string;
	fromByte: number;
	nextByte: number;
	reset: boolean;
	entries: FileEntry[];
	messages: AgentMessage[];
}

// ============================================================================
// RPC Responses (stdout)
// ============================================================================

// Success responses with data
export type RpcResponse =
	// Protocol
	| {
			id?: string;
			type: "response";
			command: "negotiate_protocol";
			success: true;
			data: { protocolVersion: 2 };
	  }
	// Session host
	| { id?: string; type: "response"; command: "detach"; success: true }
	| { id?: string; type: "response"; command: "exit"; success: true }
	// Prompting (async - events follow)
	| { id?: string; type: "response"; command: "prompt"; success: true; data?: { agentInvoked: boolean } }
	| { id?: string; type: "response"; command: "steer"; success: true }
	| { id?: string; type: "response"; command: "follow_up"; success: true }
	| {
			id?: string;
			type: "response";
			command: "remove_queued_message";
			success: true;
			data: RpcRemoveQueuedMessageResult;
	  }
	| { id?: string; type: "response"; command: "promote_queued_message"; success: true; data: { promoted: boolean } }
	| { id?: string; type: "response"; command: "abort"; success: true }
	| { id?: string; type: "response"; command: "abort_and_prompt"; success: true }
	| {
			id?: string;
			type: "response";
			command: "abort_and_restore_queue";
			success: true;
			data: RpcAbortAndRestoreQueueResult;
	  }
	| { id?: string; type: "response"; command: "new_session"; success: true; data: { cancelled: boolean } }
	| { id?: string; type: "response"; command: "open_session"; success: true; data: RpcOpenSessionResult }

	// State
	| { id?: string; type: "response"; command: "get_state"; success: true; data: RpcSessionState }
	| {
			id?: string;
			type: "response";
			command: "set_fast_mode";
			success: true;
			data: { enabled: boolean; active: boolean };
	  }
	| { id?: string; type: "response"; command: "set_slow_mode"; success: true; data: { enabled: boolean } }
	| { id?: string; type: "response"; command: "goal"; success: true; data: RpcGoalResult }
	| { id?: string; type: "response"; command: "set_ask_dialog"; success: true; data: { enabled: boolean } }
	| { id?: string; type: "response"; command: "set_idle_activity"; success: true; data: { isComposing: boolean } }
	| {
			id?: string;
			type: "response";
			command: "get_available_commands";
			success: true;
			data: { commands: RpcAvailableSlashCommand[] };
	  }
	| {
			id?: string;
			type: "response";
			command: "get_entries";
			success: true;
			data: { entries: SessionEntry[]; leafId: string | null };
	  }
	| {
			id?: string;
			type: "response";
			command: "get_tree";
			success: true;
			data: { tree: SessionTreeNode[]; leafId: string | null };
	  }
	| { id?: string; type: "response"; command: "set_todos"; success: true; data: { todoPhases: TodoPhase[] } }
	| { id?: string; type: "response"; command: "set_host_tools"; success: true; data: { toolNames: string[] } }
	| { id?: string; type: "response"; command: "set_host_uri_schemes"; success: true; data: { schemes: string[] } }
	| {
			id?: string;
			type: "response";
			command: "set_event_filter";
			success: true;
			data: { events: string[] | null; messageUpdates: RpcMessageUpdates };
	  }
	| {
			id?: string;
			type: "response";
			command: "set_subagent_subscription";
			success: true;
			data: { level: RpcSubagentSubscriptionLevel };
	  }
	| {
			id?: string;
			type: "response";
			command: "get_subagents";
			success: true;
			data: { subagents: RpcSubagentSnapshot[] };
	  }
	| {
			id?: string;
			type: "response";
			command: "get_subagent_messages";
			success: true;
			data: RpcSubagentMessagesResult;
	  }
	| {
			id?: string;
			type: "response";
			command: "cancel_subagent";
			success: true;
			data: { cancelled: boolean };
	  }
	| { id?: string; type: "response"; command: "steer_subagent"; success: true }

	// Model
	| {
			id?: string;
			type: "response";
			command: "set_model";
			success: true;
			data: Model;
	  }
	| {
			id?: string;
			type: "response";
			command: "cycle_model";
			success: true;
			data: { model: Model; thinkingLevel: ThinkingLevel | undefined; isScoped: boolean } | null;
	  }
	| {
			id?: string;
			type: "response";
			command: "get_available_models";
			success: true;
			data: { models: Model[] };
	  }

	// Thinking
	| { id?: string; type: "response"; command: "set_thinking_level"; success: true }
	| {
			id?: string;
			type: "response";
			command: "cycle_thinking_level";
			success: true;
			data: { level: Effort } | null;
	  }
	| {
			id?: string;
			type: "response";
			command: "get_available_thinking_levels";
			success: true;
			data: { levels: ThinkingLevel[] };
	  }

	// Queue modes
	| { id?: string; type: "response"; command: "set_steering_mode"; success: true }
	| { id?: string; type: "response"; command: "set_follow_up_mode"; success: true }
	| { id?: string; type: "response"; command: "set_interrupt_mode"; success: true }

	// Compaction
	| { id?: string; type: "response"; command: "compact"; success: true; data: CompactionResult }
	| { id?: string; type: "response"; command: "set_auto_compaction"; success: true }

	// Cache warming
	| { id?: string; type: "response"; command: "set_cache_warming"; success: true; data: { mode: CacheWarmingMode } }

	// Retry
	| { id?: string; type: "response"; command: "set_auto_retry"; success: true }
	| { id?: string; type: "response"; command: "abort_retry"; success: true }

	// Bash
	| { id?: string; type: "response"; command: "bash"; success: true; data: BashResult }
	| { id?: string; type: "response"; command: "abort_bash"; success: true }

	// Session
	| { id?: string; type: "response"; command: "get_session_stats"; success: true; data: SessionStats }
	| { id?: string; type: "response"; command: "export_html"; success: true; data: { path: string } }
	| { id?: string; type: "response"; command: "switch_session"; success: true; data: { cancelled: boolean } }
	| { id?: string; type: "response"; command: "branch"; success: true; data: { text: string; cancelled: boolean } }
	| { id?: string; type: "response"; command: "fork"; success: true; data: { cancelled: boolean } }
	| {
			id?: string;
			type: "response";
			command: "get_branch_messages";
			success: true;
			data: { messages: Array<{ entryId: string; text: string }> };
	  }
	| {
			id?: string;
			type: "response";
			command: "get_last_assistant_text";
			success: true;
			data: { text: string | null };
	  }
	| { id?: string; type: "response"; command: "set_session_name"; success: true }
	// Live voice
	| { id?: string; type: "response"; command: "live_start"; success: true; data: { voice: string } }
	| { id?: string; type: "response"; command: "live_stop"; success: true }
	| { id?: string; type: "response"; command: "live_mute"; success: true; data: { muted: boolean } }
	| { id?: string; type: "response"; command: "handoff"; success: true; data: RpcHandoffResult | null }

	// Messages
	| { id?: string; type: "response"; command: "get_messages"; success: true; data: { messages: AgentMessage[] } }
	| { id?: string; type: "response"; command: "get_messages_page"; success: true; data: RpcMessagesPage }

	// Login
	| {
			id?: string;
			type: "response";
			command: "get_login_providers";
			success: true;
			data: { providers: Array<{ id: string; name: string; available: boolean; authenticated: boolean }> };
	  }
	| { id?: string; type: "response"; command: "login"; success: true; data: { providerId: string } }
	| {
			id?: string;
			type: "response";
			command: "get_logout_accounts";
			success: true;
			data: { accounts: LogoutAccount[] };
	  }
	| { id?: string; type: "response"; command: "logout"; success: true; data: { remainingSource?: string } }

	// Word prediction
	| { id?: string; type: "response"; command: "predict_word"; success: true; data: { suffix: string | null } }
	| { id?: string; type: "response"; command: "predict_word_feedback"; success: true }

	// Side questions (/btw)
	| { id?: string; type: "response"; command: "btw"; success: true; data: { record: BtwHistoryRecord } }
	| { id?: string; type: "response"; command: "btw_cancel"; success: true; data: { cancelled: boolean } }
	| {
			id?: string;
			type: "response";
			command: "get_btw_history";
			success: true;
			data: { records: readonly BtwHistoryRecord[] };
	  }

	// Error response (any command can fail); `code` is an optional machine-readable reason.
	// `stale` carries the current `epoch` or `leafId`; `session_hosted` the owning `hostId`.
	| {
			id?: string;
			type: "response";
			command: string;
			success: false;
			error: string;
			code?: string;
			epoch?: number;
			leafId?: string | null;
			hostId?: string;
	  };

// ============================================================================
// Side question (/btw) frames (stdout)
// ============================================================================

/** Text appended to the running side question's latest answer. */
export interface RpcBtwDeltaFrame {
	type: "btw_delta";
	recordId: string;
	delta: string;
}

/** Full record snapshot on every lifecycle change: started, complete, cancelled, error. */
export interface RpcBtwRecordFrame {
	type: "btw_record";
	record: BtwHistoryRecord;
}

// ============================================================================
// Subagent Events (stdout)
// ============================================================================

export interface RpcSubagentLifecycleFrame {
	type: "subagent_lifecycle";
	payload: SubagentLifecyclePayload;
}

export interface RpcSubagentProgressFrame {
	type: "subagent_progress";
	payload: SubagentProgressPayload;
}

export interface RpcSubagentEventFrame {
	type: "subagent_event";
	payload: SubagentEventPayload;
}

export type RpcSubagentFrame = RpcSubagentLifecycleFrame | RpcSubagentProgressFrame | RpcSubagentEventFrame;

/** Message lifecycle event kinds that RPC mode stamps with a `messageId`. */
export type RpcMessageEventType = "message_start" | "message_update" | "message_end";

/**
 * Message lifecycle frame as written by RPC mode. `messageId` is shared by the
 * `message_start`, every `message_update`, and the `message_end` of one message;
 * it is unique within the RPC process.
 */
export type RpcMessageEventFrame = Extract<AgentSessionEvent, { type: RpcMessageEventType }> & { messageId: string };

type WithoutPartial<T> = T extends unknown ? Omit<T, "partial"> : never;

/** Raw-protocol opt-in projection; terminal subtype fields are preserved. */
export type RpcDeltaMessageUpdateFrame = Omit<
	Extract<RpcMessageEventFrame, { type: "message_update" }>,
	"message" | "assistantMessageEvent"
> & {
	message: Pick<AgentMessage, "role">;
	assistantMessageEvent: WithoutPartial<AssistantMessageEvent>;
};

/**
 * `queue_update` as a sequenced (socket) client receives it: the chip lists plus which chips carry an attachment.
 * Stdio gets the plain event. Absent from hosts that predate it, so a reader that needs it must treat absence as
 * "unknown", not "none".
 */
export type RpcQueueUpdateFrame = Extract<AgentSessionEvent, { type: "queue_update" }> & {
	attachments?: RpcQueueAttachments;
};

/** Session event as written to stdout by default: message lifecycle events carry a `messageId`. */
export type RpcAgentSessionEventFrame =
	| Exclude<AgentSessionEvent, { type: RpcMessageEventType | "queue_update" }>
	| RpcQueueUpdateFrame
	| RpcMessageEventFrame;

/** Every session event shape RPC mode can write, including the opt-in `messageUpdates: "delta"` projection. */
export type RpcProjectedSessionEventFrame = RpcAgentSessionEventFrame | RpcDeltaMessageUpdateFrame;

export type RpcSessionEventFrame = RpcAgentSessionEventFrame | RpcSubagentFrame;

// ============================================================================
// Extension UI Events (stdout)
// ============================================================================
/** Positional presentation metadata for an RPC select option. */
export interface RpcExtensionUISelectOptionDetail {
	description?: string;
}

/** One question of an RPC `ask` dialog. Options never include "Other"; hosts always offer free text. */
export interface RpcAskDialogQuestion {
	id: string;
	question: string;
	header?: string;
	options: Array<{ label: string; description?: string; preview?: string }>;
	multi?: boolean;
	/** Index of the recommended option. */
	recommended?: number;
}

/** Emitted when an extension needs user input */
export type RpcExtensionUIRequest =
	| {
			type: "extension_ui_request";
			id: string;
			method: "select";
			title: string;
			options: string[];
			optionDetails?: RpcExtensionUISelectOptionDetail[];
			timeout?: number;
	  }
	| { type: "extension_ui_request"; id: string; method: "confirm"; title: string; message: string; timeout?: number }
	| {
			type: "extension_ui_request";
			id: string;
			method: "input";
			title: string;
			placeholder?: string;
			timeout?: number;
	  }
	| {
			type: "extension_ui_request";
			id: string;
			method: "editor";
			title: string;
			prefill?: string;
			promptStyle?: boolean;
	  }
	/** Emitted only after the host opts in with `set_ask_dialog`. */
	| {
			type: "extension_ui_request";
			id: string;
			method: "ask";
			questions: RpcAskDialogQuestion[];
			timeout?: number;
	  }
	| { type: "extension_ui_request"; id: string; method: "cancel"; targetId: string }
	| {
			type: "extension_ui_request";
			id: string;
			method: "notify";
			message: string;
			notifyType?: "info" | "warning" | "error";
	  }
	| {
			type: "extension_ui_request";
			id: string;
			method: "setStatus";
			statusKey: string;
			statusText: string | undefined;
	  }
	| {
			type: "extension_ui_request";
			id: string;
			method: "setWidget";
			widgetKey: string;
			widgetLines: string[] | undefined;
			widgetPlacement?: "aboveEditor" | "belowEditor";
	  }
	| { type: "extension_ui_request"; id: string; method: "setTitle"; title: string }
	| { type: "extension_ui_request"; id: string; method: "set_editor_text"; text: string }
	| {
			type: "extension_ui_request";
			id: string;
			method: "open_url";
			url: string;
			/**
			 * Short loopback URL that 302-redirects to {@link url}. When present,
			 * hosts SHOULD surface it as the copy target so terminal viewport
			 * truncation cannot corrupt OAuth query parameters on the full URL.
			 */
			launchUrl?: string;
			instructions?: string;
	  };

// ============================================================================
// Host Tool Frames (bidirectional)
// ============================================================================

export interface RpcHostToolDefinition {
	name: string;
	label?: string;
	description: string;
	parameters: Record<string, unknown>;
	hidden?: boolean;
	/** How this host tool is presented when enabled; omission normalizes to `"discoverable"` at the adapter boundary. */
	loadMode?: ToolLoadMode;
	/** Whether this host tool can read `skill://` instruction content. */
	readsSkillUris?: boolean;
}

/** Emitted by the RPC server when it needs the host to execute a registered tool. */
export interface RpcHostToolCallRequest {
	type: "host_tool_call";
	id: string;
	toolCallId: string;
	toolName: string;
	arguments: Record<string, unknown>;
}

/** Emitted by the RPC server when a pending host tool call should be aborted. */
export interface RpcHostToolCancelRequest {
	type: "host_tool_cancel";
	id: string;
	targetId: string;
}

/** Sent by the host to stream partial tool updates back to the RPC server. */
export interface RpcHostToolUpdate {
	type: "host_tool_update";
	id: string;
	partialResult: AgentToolResult<unknown>;
}

/** Sent by the host to complete a pending tool call. */
export interface RpcHostToolResult {
	type: "host_tool_result";
	id: string;
	result: AgentToolResult<unknown>;
	isError?: boolean;
}

// ============================================================================
// Host URI Frames (bidirectional)
// ============================================================================

export interface RpcHostUriSchemeDefinition {
	/** URL scheme without trailing `://` (e.g. `db`, `notion`). */
	scheme: string;
	/** Optional human-readable description for logs/diagnostics. */
	description?: string;
	/** When true, the write tool is allowed to dispatch writes to this scheme. */
	writable?: boolean;
	/** When true, downstream callers suppress hashline anchors for resolved content. */
	immutable?: boolean;
}

export type RpcHostUriOperation = "read" | "write";

/** Emitted by the RPC server when it needs the host to satisfy a URI operation. */
export interface RpcHostUriRequest {
	type: "host_uri_request";
	id: string;
	operation: RpcHostUriOperation;
	url: string;
	/** Present for write operations. */
	content?: string;
}

/** Emitted by the RPC server when a pending URI request should be aborted. */
export interface RpcHostUriCancelRequest {
	type: "host_uri_cancel";
	id: string;
	targetId: string;
}

/** Sent by the host to complete a pending URI request. */
export interface RpcHostUriResult {
	type: "host_uri_result";
	id: string;
	/**
	 * Required for successful `read` results. Ignored for `write` success.
	 * Set on errors when a textual explanation accompanies `isError`.
	 */
	content?: string;
	/** Defaults to `text/plain` when omitted. */
	contentType?: "text/markdown" | "application/json" | "text/plain";
	/** Optional resolution notes propagated to the read tool. */
	notes?: string[];
	/** Overrides the scheme-level `immutable` flag for this single resolution. */
	immutable?: boolean;
	/** When true, surface the result content as an error to the caller. */
	isError?: boolean;
	/** Optional error message; preferred over `content` for error surfacing. */
	error?: string;
}

// ============================================================================
// Extension UI Commands (stdin)
// ============================================================================

/** One question's answer in an `ask` response. */
export interface RpcAskDialogAnswer {
	id: string;
	selectedOptions: string[];
	customInput?: string;
	/** Images pasted into the custom answer; their `[Image #N]` markers sit in `customInput`. */
	customInputImages?: ImageContent[];
	/** The user's note on the answer. */
	note?: string;
	noteImages?: ImageContent[];
}

/** Response to an extension UI request */
export type RpcExtensionUIResponse =
	| { type: "extension_ui_response"; id: string; value: string }
	| { type: "extension_ui_response"; id: string; confirmed: boolean }
	| { type: "extension_ui_response"; id: string; cancelled: true; timedOut?: boolean }
	/** Answers to an `ask` request, one per question in request order. */
	| { type: "extension_ui_response"; id: string; answers: RpcAskDialogAnswer[] }
	/** The user chose to discuss an `ask` request instead of answering it; distinct from cancelling. */
	| { type: "extension_ui_response"; id: string; chat: true };

// ============================================================================
// Helper type for extracting command types
// ============================================================================

export type RpcCommandType = RpcCommand["type"];
