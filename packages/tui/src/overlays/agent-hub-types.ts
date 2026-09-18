import type { AgentMessage, ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";

/** Identity of the ambient main session in the agent roster. */
export const MAIN_AGENT_ID = "Main";
/** Lifecycle state shown in the roster. */
export type AgentStatus = "running" | "idle" | "parked" | "aborted";
/** Usage summary consumed by the roster and inspector. */
export interface AgentMetricsSummary {
	tokens: number;
	requests: number;
	tools: number;
	cost: number;
	durationMs: number;
	durationKind?: "active" | "span" | "unknown";
	contextTokens?: number;
	contextWindow?: number;
}
/** Live session data and actions used by the agent hub. */
export interface AgentHubSession {
	readonly thinkingLevel: ThinkingLevel | undefined;
	readonly model: Model | undefined;
	readonly servingModel?: { selector: string; isFallback: boolean };
	readonly agent?: { state: { messages: AgentMessage[] } };
	getSessionStats(): {
		tokens: { input: number; output: number; cacheWrite: number };
		assistantMessages: number;
		toolCalls: number;
		cost: number;
		contextUsage?: { tokens: number; contextWindow: number } | null;
	};
	abort(options?: { reason?: string }): Promise<void>;
}
/** Structural view of an agent-registry record. */
export interface AgentRecordLike {
	id: string;
	displayName: string;
	kind: "main" | "sub" | "advisor" | "remote";
	parentId?: string;
	status: AgentStatus;
	session: AgentHubSession | null;
	sessionFile: string | null;
	createdAt: number;
	lastActivity: number;
	activity?: string;
	history?: {
		agent?: string;
		modelRole?: string;
		resolvedModel?: string;
		resolvedModelIsFallback?: boolean;
		metrics?: AgentMetricsSummary;
		readOnly?: boolean;
		outputPath?: string;
		patchPath?: string;
		branchName?: string;
		nestedPatchPaths?: string[];
	};
	lifecycle?: { responseAt?: number; acceptedAt?: number; terminalAt?: number };
}
/** Registry operations needed to display a live roster. */
export interface AgentHubRegistry<TRecord extends AgentRecordLike = AgentRecordLike> {
	list(): TRecord[];
	get(id: string): TRecord | undefined;
	onChange(listener: () => void): () => void;
}
/** Lifecycle actions exposed by the host. */
export interface AgentLifecycleLike<TRecord extends AgentRecordLike = AgentRecordLike> {
	ensureLive(id: string): Promise<{ prompt(text: string, options: { streamingBehavior: "steer" }): Promise<unknown> }>;
	release(id: string, expected: TRecord, options: { tombstone: true }): Promise<boolean>;
}
/** Unread-message counts supplied by the host IRC bus. */
export interface IrcBusLike {
	unreadCount(id: string): number;
}
