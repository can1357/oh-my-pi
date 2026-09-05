import type { AssistantMessage, ServiceTier, StopReason, Usage } from "@pk-nerdsaver-ai/pi-ai";
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
	serviceTier: ServiceTier | null;
}

export type SessionEntry = SessionHeader | SessionMessageEntry | SessionServiceTierChangeEntry | { type: string };

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
	/** Catch-all upset signal: drama runs + `noooo`/`ughh`/... + `dude` + `..` */
	anguish: number;
	/** Corrective negation ("no", "nope", "thats not what i meant") */
	negation: number;
	/** User repeating themselves ("i meant", "still doesnt work", "like i said") */
	repetition: number;
	/** Second-person reproach ("you didnt", "you broke", "stop X-ing") */
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
 * Aggregated statistics for a single task span (user prompt turn).
 */
export interface TaskLedgerRecord {
	/** Unique task identifier: `${sessionFile}#${anchorUserEntryId}` */
	taskId: string;
	/** Session file path */
	sessionFile: string;
	/** Folder/project path (extracted from session filename) */
	folder: string;
	/** Which agent produced this task (main agent, task subagent, advisor) */
	agentType: AgentType;
	/** Responding model of the task's final request */
	model: string;
	/** Responding provider of the task's final request */
	provider: string;
	/** Anchor user-message timestamp (epoch ms) */
	startedAt: number;
	/** Final linked assistant timestamp (epoch ms) */
	completedAt: number;
	/** Sum of per-request duration in milliseconds, excluding idle time between requests */
	wallMs: number;
	/** Time to first token of the first request in the span, or null */
	ttftMs: number | null;
	/** Total input tokens across all requests in the span */
	inputTokens: number;
	/** Total output tokens across all requests in the span */
	outputTokens: number;
	/** Total cache-read tokens across all requests in the span */
	cacheReadTokens: number;
	/** Number of assistant requests in this task span */
	requestCount: number;
	/** Total cost in USD across all requests in the span */
	costUsd: number;
	/** Stop reason of the final assistant request */
	stopReason: StopReason;
}

/**
 * Economic summary aggregated by model and provider.
 */
export interface ModelEconomics {
	model: string;
	provider: string;
	taskCount: number;
	avgCostUsd: number;
	avgWallMs: number;
	avgTtftMs: number | null;
}
