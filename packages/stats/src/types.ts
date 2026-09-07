import type { AssistantMessage, ServiceTier, ServiceTierByFamily, StopReason, Usage } from "@oh-my-pi/pi-ai";
import type { AgentType } from "./shared-types";

export * from "./shared-types";

/**
 * Extracted stats from an assistant message.
 */
export interface MessageStats {
	/** Database ID */
	id?: number;
	/** Session file path */
	sessionFile: string;
	/** Entry ID within the session */
	entryId: string;
	/** Folder/project path (extracted from session filename) */
	folder: string;
	/** Model ID */
	model: string;
	/** Provider name */
	provider: string;
	/** API type */
	api: string;
	/** Unix timestamp in milliseconds */
	timestamp: number;
	/** Request duration in milliseconds */
	duration: number | null;
	/** Time to first token in milliseconds */
	ttft: number | null;
	/** Stop reason */
	stopReason: StopReason;
	/** Error message if stopReason is error */
	errorMessage: string | null;
	/** Token usage */
	usage: Usage;
	/** Which agent produced this message (main agent, task subagent, advisor) */
	agentType: AgentType;
}

/**
 * Full details of a request, including content.
 */
export interface RequestDetails extends MessageStats {
	/** The full conversation history or just the last turn. */
	messages: unknown[];
	/** The model's response. */
	output: unknown;
}

/**
 * Session log entry types.
 */
export interface SessionHeader {
	type: "session";
	version: number;
	id: string;
	timestamp: string;
	cwd: string;
	title?: string;
}

export interface SessionMessageEntry {
	type: "message";
	id: string;
	parentId: string | null;
	timestamp: string;
	message: AssistantMessage | { role: "user" | "toolResult" };
}

export interface SessionServiceTierChangeEntry {
	type: "service_tier_change";
	id: string;
	parentId?: string | null;
	timestamp: string;
	serviceTier: ServiceTierByFamily | ServiceTier | null;
}

export interface SessionModelUsageEntry {
	type: "model_usage";
	id: string;
	parentId: string | null;
	timestamp: string;
	purpose: string;
	role?: string;
	api: string;
	provider: string;
	model: string;
	usage: Usage;
	stopReason?: StopReason;
	errorMessage?: string;
}

/**
 * Custom journal entry (`tool_execution_start`, `session_exit`, …). Mirrors
 * the coding-agent shape structurally — stats never imports coding-agent.
 */
export interface SessionCustomEntry {
	type: "custom";
	id?: string;
	parentId?: string | null;
	timestamp?: string;
	customType: string;
	data?: Record<string, unknown>;
}

/** Structural variants the trace builder matches on beyond messages. */
export interface SessionTypedEntry {
	type: "session_init" | "compaction" | "model_change" | "mode_change" | "reset_boundary";
	id?: string;
	parentId?: string | null;
	timestamp?: string;
	[key: string]: unknown;
}

export type SessionEntry =
	| SessionHeader
	| SessionMessageEntry
	| SessionServiceTierChangeEntry
	| SessionModelUsageEntry
	| SessionCustomEntry
	| SessionTypedEntry
	| { type: string };

/**
 * Behavioral stats extracted from a single user message.
 */
export interface UserMessageStats {
	/** Database ID */
	id?: number;
	/** Session file path */
	sessionFile: string;
	/** Entry ID within the session */
	entryId: string;
	/** Folder/project path */
	folder: string;
	/** Unix timestamp in ms */
	timestamp: number;
	/** Model that responded to this user message, if linked */
	model: string | null;
	/** Provider that responded to this user message, if linked */
	provider: string | null;
	/** Total characters of message text */
	chars: number;
	/** Whitespace-delimited word count */
	words: number;
	/** Yelling sentences (> 50% uppercase letters) */
	yelling: number;
	/** Profanity hits */
	profanity: number;
	/** Catch-all upset signal: drama runs + `noooo`/`ughh`/... + `dude` + `:(` */
	anguish: number;
	/** Corrective negation ("no", "nope", "thats not what i meant") */
	negation: number;
	/** User repeating themselves ("i meant", "still doesnt work", "like i said") */
	repetition: number;
	/** Second-person reproach ("you didnt", "why did you", "stop X-ing") */
	blame: number;
}

/**
 * Pair emitted by the parser when it sees an assistant message whose
 * `parentId` points to a user message that wasn't parsed in the same pass
 * (e.g. user prompt landed in an earlier incremental sync). The aggregator
 * applies the link to the persisted `user_messages` row so it stops showing
 * up in the "unknown" model bucket.
 */
export interface UserMessageLink {
	sessionFile: string;
	entryId: string;
	model: string;
	provider: string;
}

/**
 * One tool call extracted from an assistant message's `toolCall` content
 * blocks. `callsInTurn` records how many calls that assistant turn contained
 * so aggregation can split the turn's real provider usage evenly per call.
 */
export interface ToolCallStats {
	/** Session file path */
	sessionFile: string;
	/** Assistant-message entry ID that emitted the call */
	entryId: string;
	/** Provider-assigned tool call ID (unique within a session) */
	toolCallId: string;
	/** Folder/project path (extracted from session filename) */
	folder: string;
	/** Tool name */
	toolName: string;
	/** Model that emitted the call */
	model: string;
	/** Provider name */
	provider: string;
	/** Assistant-message timestamp (Unix ms) */
	timestamp: number;
	/** Which agent produced the call */
	agentType: AgentType;
	/** Total tool calls in the same assistant turn (>= 1) */
	callsInTurn: number;
	/** Serialized argument characters */
	argsChars: number;
}

/**
 * Result linkage emitted when the parser sees a `toolResult` message entry.
 * Applied as an UPDATE on the persisted tool-call row — results can land in a
 * later incremental sync pass than the call that produced them.
 */
export interface ToolResultLink {
	sessionFile: string;
	toolCallId: string;
	/** Text characters fed back into context */
	resultChars: number;
	isError: boolean;
}
