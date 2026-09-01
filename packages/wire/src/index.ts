/**
 * Shared wire types for the omp collab live-session protocol.
 *
 * Dependency-free JSON shapes produced by `@oh-my-pi/pi-coding-agent`
 * (`src/collab/protocol.ts` and friends). Browser and test clients import this
 * package instead of depending on the coding-agent runtime; conformance is
 * asserted type-only in `packages/coding-agent/test/collab/web-wire.types.ts`.
 *
 * Unknown entry/event variants arrive over the wire as plain JSON. The unions
 * below cover only the variants this client renders; consumers cast at the
 * JSON boundary and every `switch` keeps a tolerant `default:` branch.
 */

// ═══════════════════════════════════════════════════════════════════════════
// Content blocks
// ═══════════════════════════════════════════════════════════════════════════

export interface TextContent {
	type: "text";
	text: string;
}

export interface ImageContent {
	type: "image";
	/** Base64-encoded image data. */
	data: string;
	/** e.g. "image/png". */
	mimeType: string;
}

export interface ThinkingContent {
	type: "thinking";
	thinking: string;
}

export interface RedactedThinkingContent {
	type: "redactedThinking";
	data: string;
}

export interface ToolCallContent {
	type: "toolCall";
	id: string;
	name: string;
	arguments: Record<string, unknown>;
	intent?: string;
}

export type AssistantContent = TextContent | ThinkingContent | RedactedThinkingContent | ToolCallContent;

export type StopReason = "stop" | "length" | "toolUse" | "error" | "aborted";

export interface WireUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	cost: { total: number };
}

// ═══════════════════════════════════════════════════════════════════════════
// Messages
// ═══════════════════════════════════════════════════════════════════════════

export interface UserMessage {
	role: "user";
	content: string | (TextContent | ImageContent)[];
	/** True if the message was injected by the system (e.g. auto-continue). */
	synthetic?: boolean;
	/** Unix timestamp in milliseconds. */
	timestamp: number;
}

export interface DeveloperMessage {
	role: "developer";
	content: string | (TextContent | ImageContent)[];
	timestamp: number;
}

export interface AssistantMessage {
	role: "assistant";
	content: AssistantContent[];
	model: string;
	usage: WireUsage;
	stopReason: StopReason;
	errorMessage?: string;
	timestamp: number;
}

export interface ToolResultMessage {
	role: "toolResult";
	toolCallId: string;
	toolName: string;
	content: (TextContent | ImageContent)[];
	details?: unknown;
	isError: boolean;
	timestamp: number;
}

export type WireMessage = UserMessage | DeveloperMessage | AssistantMessage | ToolResultMessage;

// ═══════════════════════════════════════════════════════════════════════════
// Session entries (rendered subset; cast `as SessionEntry` at the JSON
// boundary and skip unknown `type`s in a tolerant `default:`)
// ═══════════════════════════════════════════════════════════════════════════

export interface SessionHeader {
	type: "session";
	id: string;
	title?: string;
	timestamp: string;
	cwd: string;
}

export interface EntryBase {
	id: string;
	parentId: string | null;
	timestamp: string;
}

export interface MessageEntry extends EntryBase {
	type: "message";
	message: WireMessage;
}

export interface CustomMessageEntry extends EntryBase {
	type: "custom_message";
	customType: string;
	content: string | (TextContent | ImageContent)[];
	details?: unknown;
	display: boolean;
}

export interface CompactionEntry extends EntryBase {
	type: "compaction";
	summary: string;
	shortSummary?: string;
	firstKeptEntryId: string;
	tokensBefore: number;
}

export interface BranchSummaryEntry extends EntryBase {
	type: "branch_summary";
	fromId: string;
	summary: string;
}

export interface ModelChangeEntry extends EntryBase {
	type: "model_change";
	/** Model in "provider/modelId" format. */
	model: string;
	role?: string;
}

export interface ThinkingLevelChangeEntry extends EntryBase {
	type: "thinking_level_change";
	thinkingLevel?: string | null;
}

export type SessionEntry =
	| MessageEntry
	| CustomMessageEntry
	| CompactionEntry
	| BranchSummaryEntry
	| ModelChangeEntry
	| ThinkingLevelChangeEntry;

/** customType of collab guest prompts injected on the host. */
export const COLLAB_PROMPT_MESSAGE_TYPE = "collab-prompt";

/** `details` shape of `custom_message` entries with `customType === "collab-prompt"`. */
export interface CollabPromptDetails {
	from?: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// Events (handled subset)
// ═══════════════════════════════════════════════════════════════════════════

export type AgentEvent =
	| { type: "agent_start" }
	| { type: "agent_end" }
	| { type: "turn_start" }
	| { type: "turn_end" }
	| { type: "message_start"; message: WireMessage }
	/** Carries the FULL accumulating partial message — no delta tracking needed. */
	| { type: "message_update"; message: WireMessage }
	| { type: "message_end"; message: WireMessage }
	| { type: "tool_execution_start"; toolCallId: string; toolName: string; args: unknown; intent?: string }
	| { type: "tool_execution_update"; toolCallId: string; toolName: string; args: unknown; partialResult: unknown }
	| { type: "tool_execution_end"; toolCallId: string; toolName: string; result: unknown; isError?: boolean }
	| { type: "notice"; level: "info" | "warning" | "error"; message: string; source?: string }
	| { type: "auto_compaction_start"; reason: string; action: string }
	| { type: "auto_compaction_end"; aborted: boolean; willRetry: boolean; errorMessage?: string; skipped?: boolean }
	| { type: "auto_retry_start"; attempt: number; maxAttempts: number; delayMs: number; errorMessage: string }
	| { type: "auto_retry_end"; success: boolean; attempt: number; finalError?: string }
	| { type: "thinking_level_changed"; thinkingLevel?: string };

// ═══════════════════════════════════════════════════════════════════════════
// State & agents
// ═══════════════════════════════════════════════════════════════════════════

export interface WireModel {
	id: string;
	name: string;
	provider: string;
	contextWindow: number | null;
}

export interface ContextUsage {
	tokens: number | null;
	contextWindow: number | null;
	percent: number | null;
}

export interface Participant {
	name: string;
	role: "host" | "guest";
	/** True when the guest joined through a read-only (view) link. */
	readOnly?: boolean;
}

/** Debounced footer snapshot broadcast by the host. */
export interface SessionState {
	isStreaming: boolean;
	queuedMessageCount: number;
	sessionName?: string;
	/** Host cwd — display only; the guest never chdirs. */
	cwd: string;
	model?: WireModel;
	thinkingLevel?: string;
	contextUsage?: ContextUsage;
	participants: Participant[];
	isAborting?: boolean;
}

export interface AgentSnapshot {
	id: string;
	displayName: string;
	kind: "main" | "sub";
	parentId?: string;
	status: "running" | "idle" | "parked" | "aborted";
	/** Whether the host has a transcript file for this agent (gates remote transcript fetch). */
	hasSessionFile: boolean;
	createdAt: number;
	lastActivity: number;
}

// ═══════════════════════════════════════════════════════════════════════════
// Bus payloads (task subagent lifecycle/progress channels)
// ═══════════════════════════════════════════════════════════════════════════

export interface AgentProgress {
	index: number;
	id: string;
	agent: string;
	status: "pending" | "running" | "completed" | "failed" | "aborted";
	task: string;
	description?: string;
	lastIntent?: string;
	currentTool?: string;
	currentToolArgs?: string;
	currentToolStartMs?: number;
	recentTools: { tool: string; args: string; endMs: number }[];
	recentOutput: string[];
	toolCount: number;
	requests: number;
	tokens: number;
	contextTokens?: number;
	contextWindow?: number;
	cost: number;
	durationMs: number;
	resolvedModel?: string;
}

export interface SubagentProgressPayload {
	index: number;
	agent: string;
	task: string;
	parentToolCallId?: string;
	assignment?: string;
	progress: AgentProgress;
	sessionFile?: string;
}

export interface SubagentLifecyclePayload {
	id: string;
	agent: string;
	description?: string;
	status: "started" | "completed" | "failed" | "aborted";
	sessionFile?: string;
	parentToolCallId?: string;
	index: number;
}

// ═══════════════════════════════════════════════════════════════════════════
// Guests (persistent identity, roles, granular permissions)
// ═══════════════════════════════════════════════════════════════════════════

/** Role ladder for collab guests; the human host is the de-facto `owner`. */
export type GuestRole = "owner" | "admin" | "member" | "viewer";

export type GuestStatus = "online" | "away" | "offline";

/** Feature flags a guest declares in `hello`; the host gates broadcasts on them. */
export interface GuestCapabilities {
	/** Guest's wire protocol version. */
	protocolVersion: number;
	supportsGuestChat: boolean;
	supportsPresence: boolean;
	supportsCursors: boolean;
}

/**
 * Stable per-guest identity (proto 4+). `id` survives reconnects within the
 * same host session; `peerId` changes on every reconnect.
 */
export interface GuestIdentity {
	id: string;
	/** Current relay peerId; -1 while the guest is disconnected. */
	peerId: number;
	name: string;
	role: GuestRole;
	status: GuestStatus;
	/** `data:` or https URL; rendered by guests when present. */
	avatar?: string;
	/** True when this guest's current hello proved write-token possession. */
	canWrite: boolean;
	capabilities: GuestCapabilities;
	/** Epoch ms of the original join. */
	joinedAt: number;
	/** Epoch ms of the guest's most recent frame (or disconnect). */
	lastActive: number;
	/** guestId of the inviter, when the guest arrived through a pending invite. */
	invitedBy?: string;
}

/**
 * Granular guest permissions as bit flags over a `number` — deliberately NOT
 * bigint: every collab frame is JSON.stringify'd inside the AES-GCM seal, and
 * bigint throws on serialization. 13 flags stay far inside the 32-bit range.
 */
export const GUEST_PERMISSIONS = {
	/** Send prompts. */
	PROMPT: 1 << 0,
	/** `agent-cmd: chat`. */
	AGENT_CHAT: 1 << 1,
	/** `agent-cmd: kill`. */
	AGENT_KILL: 1 << 2,
	/** `agent-cmd: revive`. */
	AGENT_REVIVE: 1 << 3,
	/** Answer host `ui-request` prompts (select/editor). */
	UI_RESPONSE: 1 << 4,
	/** `fetch-transcript`. */
	FETCH_TRANSCRIPT: 1 << 5,
	/** `abort`. */
	ABORT: 1 << 6,
	/** Guest-to-guest chat (send and receive). */
	GUEST_CHAT: 1 << 7,
	/** Invite new guests. */
	GUEST_INVITE: 1 << 8,
	/** Kick guests. */
	GUEST_KICK: 1 << 9,
	/** Change guest roles. */
	GUEST_ROLE: 1 << 10,
	/** Grant/revoke permission bits and read the audit log. */
	PERMISSION_MANAGE: 1 << 11,
	/** Change session settings (reserved for future frames). */
	SESSION_CONFIG: 1 << 12,
} as const satisfies Record<string, number>;

export type GuestPermissionKey = keyof typeof GUEST_PERMISSIONS;

/** Bitmask over {@link GUEST_PERMISSIONS}. */
export type GuestPermissionSet = number;

/**
 * Effective surface of a legacy proto-3 guest holding a write token: exactly
 * the pre-4 mutating grammar. Proto-3 clients have no chat/invite UI, so the
 * guest-management bits never fire for them even when role defaults include
 * them.
 */
export const LEGACY_FULL_PERMISSIONS: GuestPermissionSet =
	GUEST_PERMISSIONS.PROMPT |
	GUEST_PERMISSIONS.AGENT_CHAT |
	GUEST_PERMISSIONS.AGENT_KILL |
	GUEST_PERMISSIONS.AGENT_REVIVE |
	GUEST_PERMISSIONS.UI_RESPONSE |
	GUEST_PERMISSIONS.FETCH_TRANSCRIPT |
	GUEST_PERMISSIONS.ABORT;

/** Role → default permission bitmask. Hosts may override per role and per guest. */
export const ROLE_DEFAULT_PERMISSIONS: Record<GuestRole, GuestPermissionSet> = {
	owner:
		LEGACY_FULL_PERMISSIONS |
		GUEST_PERMISSIONS.GUEST_INVITE |
		GUEST_PERMISSIONS.GUEST_KICK |
		GUEST_PERMISSIONS.GUEST_ROLE |
		GUEST_PERMISSIONS.PERMISSION_MANAGE |
		GUEST_PERMISSIONS.SESSION_CONFIG,
	admin:
		LEGACY_FULL_PERMISSIONS |
		GUEST_PERMISSIONS.GUEST_INVITE |
		GUEST_PERMISSIONS.GUEST_KICK |
		GUEST_PERMISSIONS.GUEST_ROLE,
	member:
		GUEST_PERMISSIONS.PROMPT |
		GUEST_PERMISSIONS.AGENT_CHAT |
		GUEST_PERMISSIONS.UI_RESPONSE |
		GUEST_PERMISSIONS.FETCH_TRANSCRIPT |
		GUEST_PERMISSIONS.ABORT |
		GUEST_PERMISSIONS.GUEST_CHAT,
	/** Watch the transcript and join guest chat; nothing else. */
	viewer: GUEST_PERMISSIONS.FETCH_TRANSCRIPT | GUEST_PERMISSIONS.GUEST_CHAT,
};

/** Append-only audit record for permission-affecting actions (host caps the log). */
export interface PermissionAuditEntry {
	/** Epoch ms. */
	at: number;
	/** Actor guestId, or `"host"` for host-side actions. */
	actorId: string;
	action: "grant" | "revoke" | "role-change" | "invite" | "kick";
	/** Affected guestId when the action targets one. */
	target?: string;
	/** Human-readable detail, e.g. `"PROMPT|AGENT_CHAT"` or `"member -> admin"`. */
	detail: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// Frames (JSON inside the AES-GCM seal)
// ═══════════════════════════════════════════════════════════════════════════

export type CollabUiSelectItem = string | { label: string; description?: string };

export type CollabUiResponseValue = string | undefined;

export type CollabUiRequestDraft =
	| {
			kind: "select";
			title: string;
			options: CollabUiSelectItem[];
			initialIndex?: number;
			selectionMarker?: "radio" | "checkbox";
			checkedIndices?: number[];
			markableCount?: number;
			helpText?: string;
	  }
	| {
			kind: "editor";
			title: string;
			prefill?: string;
	  };

export type CollabUiRequest = CollabUiRequestDraft & { reqId: number };

export type GuestFrame =
	| {
			t: "hello";
			proto: number;
			name: string;
			/**
			 * base64url write token proving full-link possession; absent for
			 * read-only (view) links. The host marks peers without a valid token
			 * read-only and rejects their mutating frames.
			 */
			writeToken?: string;
			/**
			 * Persistent guest identity (proto 4+); survives reconnects within
			 * the same host session. Absent on legacy proto-3 clients.
			 */
			guestId?: string;
			/** Feature flags (proto 4+); absent flags default to false. */
			capabilities?: GuestCapabilities;
	  }
	| { t: "prompt"; text: string; images?: ImageContent[] }
	| { t: "ui-response"; reqId: number; value?: CollabUiResponseValue }
	| { t: "abort" }
	| { t: "agent-cmd"; cmd: "chat" | "kill" | "revive"; agentId: string; text?: string }
	| { t: "fetch-transcript"; reqId: number; agentId: string; fromByte: number }
	// ── Guest management (proto 4+) ──────────────────────────────────────────
	/**
	 * Invite a guest by display name; the host records a pending invitation
	 * and applies `role` (plus optional permission bits) when a guest joins
	 * under that name.
	 */
	| { t: "guest-invite"; name: string; role: GuestRole; permissionsOverride?: GuestPermissionSet }
	/** Disconnect a guest and mark its identity kicked for this session. */
	| { t: "guest-kick"; guestId: string; reason?: string }
	| { t: "guest-role"; guestId: string; role: GuestRole }
	/** Grant/revoke permission bits on top of the guest's role defaults. */
	| { t: "guest-permission"; guestId: string; grant: GuestPermissionSet; revoke: GuestPermissionSet }
	// ── Guest-to-guest communication (proto 4+) ─────────────────────────────
	/** `"broadcast"` fans out to every chat-capable guest; a guestId targets one. */
	| { t: "guest-message"; to: string | "broadcast"; text: string; kind?: "chat" | "system" }
	| { t: "guest-presence"; status: GuestStatus }
	| { t: "guest-cursor"; agentId?: string; position?: { line: number; column: number } }
	/** Request the host's permission audit log (requires PERMISSION_MANAGE). */
	| { t: "permission-audit"; reqId: number; guestId?: string; limit?: number };

/** EventBus channels mirrored to guests (task subagent traffic only). */
export type BusChannel = "task:subagent:progress" | "task:subagent:lifecycle";

export type HostFrame =
	| {
			t: "welcome";
			proto: number;
			header: SessionHeader;
			state: SessionState;
			agents: AgentSnapshot[];
			/**
			 * Total number of `SessionEntry` items the host will deliver in the
			 * `snapshot-chunk` frames that follow. Guests stay in the loading
			 * phase until they have accumulated all of them (or a chunk arrives
			 * with `final: true`).
			 */
			entryCount: number;
			/** True when this peer joined through a read-only (view) link. */
			readOnly?: boolean;
			/** Proto-4 guests only: the identity the host assigned to this guest. */
			self?: GuestIdentity;
			/** Proto-4 guests only: every current guest in the room (including self). */
			guests?: GuestIdentity[];
			/** Proto-4 guests only: the host's effective permission bitmask for this guest. */
			permissionsSet?: GuestPermissionSet;
	  }
	/**
	 * Targeted snapshot fragment delivered after `welcome`. Hosts split the
	 * transcript into chunks bounded by byte size so a multi-MB session is not
	 * forced through one giant frame the relay may stall on. The last chunk
	 * carries `final: true`; guests finalize the replica on that frame.
	 */
	| { t: "snapshot-chunk"; entries: SessionEntry[]; final: boolean }
	| { t: "entry"; entry: SessionEntry }
	| { t: "event"; event: AgentEvent }
	| { t: "state"; state: SessionState }
	/** Mirrored EventBus traffic (task subagent lifecycle/progress channels only). */
	| { t: "bus"; channel: BusChannel; data: unknown }
	| { t: "agents"; agents: AgentSnapshot[] }
	| { t: "ui-request"; request: CollabUiRequest }
	| { t: "ui-request-end"; reqId: number }
	/** Targeted reply to fetch-transcript; `text` is decoded JSONL from `fromByte`, `newSize` the next offset base. */
	| { t: "transcript"; reqId: number; text: string; newSize: number; error?: string }
	| { t: "bye"; reason: string }
	| { t: "error"; message: string }
	// ── Guest management (proto-4 guests only; legacy guests never receive these) ──
	| { t: "guest-joined"; guest: GuestIdentity }
	| { t: "guest-left"; guestId: string; reason?: string }
	| { t: "guest-role-changed"; guestId: string; role: GuestRole; by: string }
	| { t: "guest-permission-changed"; guestId: string; permissionsSet: GuestPermissionSet }
	// ── Guest-to-guest communication ──
	| { t: "guest-message"; from: GuestIdentity; to: string | "broadcast"; text: string; kind: "chat" | "system" }
	| { t: "guest-presence"; guestId: string; status: GuestStatus }
	| { t: "guest-cursor"; from: string; agentId?: string; position?: { line: number; column: number } }
	/** Targeted reply to `permission-audit`. */
	| { t: "permission-audit"; reqId: number; entries: PermissionAuditEntry[]; error?: string };

export type WireFrame = GuestFrame | HostFrame;

/**
 * Wire protocol version carried in `hello`; the host rejects mismatches.
 *
 * - `1` (legacy): `welcome` carried the full `entries` array inline.
 * - `2`: `welcome` carries only metadata (header/state/agents/entryCount);
 *   transcript entries follow in `snapshot-chunk` frames, so multi-MB
 *   sessions are not gated on a single welcome frame fitting under the
 *   guest's first-welcome timeout.
 * - `3`: host asks guests through `ui-request`/`ui-request-end` host frames
 *   answered by the `ui-response` guest frame. Guests that predate the
 *   grammar would silently drop `ui-request` (asks hang forever on the
 *   host), so they must be rejected at hello.
 * - `4`: guest management + inter-guest communication. Guests may declare a
 *   persistent `guestId` and `capabilities` in `hello`; the host answers
 *   with `self`/`guests`/`permissionsSet` in `welcome` and accepts the
 *   `guest-*`/`permission-audit` frames. Hosts still accept proto-3 guests
 *   (legacy subset: no self/guests/permissions in welcome, never sent guest
 *   frames), and guests ignore unknown frame types, so mixed versions
 *   interoperate.
 */
export const COLLAB_PROTO = 4;

/** Parameter key used for intent tracing (e.g. prompt explanation/reasoning) */
export const INTENT_FIELD = "i";

// ═══════════════════════════════════════════════════════════════════════════
// Envelope & link constants
// ═══════════════════════════════════════════════════════════════════════════

/** Plaintext envelope prefix: `[4B uint32 BE peerId][sealed payload]`. */
export const ENVELOPE_HEADER_LENGTH = 4;

export const ROOM_ID_BYTES = 16;

/** AES-256-GCM room key; the seal key for every collab frame. */
export const ROOM_KEY_BYTES = 32;

/**
 * Random write token appended to the room key in full links
 * (`base64url(key ∥ token)`); view links carry the bare key. Possession
 * proves prompt/abort/agent-cmd capability to the host.
 */
export const WRITE_TOKEN_BYTES = 16;

/** Default public relay; bare `<roomId>.<key>` links resolve against it. */
export const DEFAULT_RELAY_URL = "wss://my.omp.sh";

/** Default share viewer/upload base; `/share` links resolve against `<base>/<id>#<key>`. */
export const DEFAULT_SHARE_URL = "https://my.omp.sh/s";

export interface ParsedCollabLink {
	/** wss://host[:port]/r/<roomId> — no query, no fragment. */
	wsUrl: string;
	roomId: string;
	key: Uint8Array;
	/** Write token from a full link; absent for read-only (view) links. */
	writeToken?: Uint8Array;
}

// ═══════════════════════════════════════════════════════════════════════════
// Relay control messages (TEXT JSON, unencrypted, no session data)
// ═══════════════════════════════════════════════════════════════════════════

/** Relay → host control message. */
export type RelayControlToHost = { t: "peer-joined" | "peer-left"; peer: number };
/** Relay → guest control message. */
export type RelayControlToGuest = { t: "room-closed" };
export type RelayControlMessage = RelayControlToHost | RelayControlToGuest;
