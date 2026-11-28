import type { AgentMessage, ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { Model } from "@oh-my-pi/pi-ai";
import type { AiuTotals } from "../session/aiu-billing";

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

/** Where an external agent runs: its backend, the job id there, and the host when known. */
export interface ExternalAgentExecution {
	backend: string;
	jobId: string;
	machine?: string;
}

/** One page of an external agent's transcript, read from a byte cursor. */
export interface ExternalTranscriptPage {
	/** Session JSONL entries from the requested byte, or from byte 0 when {@link reset} is set. */
	text: string;
	/** Cursor for the next read. */
	newSize: number;
	/** The transcript was rebuilt: `text` replaces everything read before. */
	reset?: boolean;
	/** Permanent read failure; readers show it and stop polling. */
	error?: string;
}

/** What core calls on an external agent; the extension that registered it serves them. */
export interface ExternalAgentControls {
	readTranscript(fromByte: number, signal?: AbortSignal): Promise<ExternalTranscriptPage>;
	/** Deliver a message: steered into its turn while it runs, a follow-up once idle. Absent when it takes none, or once it settled. */
	steer?(text: string): Promise<void>;
}

/** Live session data and actions used by the agent hub. */
export interface AgentHubSession {
	readonly thinkingLevel: ThinkingLevel | undefined;
	readonly model: Model | undefined;
	readonly servingModel?: { selector: string; isFallback: boolean };
	readonly agent?: { state: { messages: AgentMessage[] } };
	/** Existing session ledger includes off-transcript model usage and nested-task attribution. */
	readonly sessionManager?: {
		getUsageStatistics(): { cost: number; subagentCost: number; aiuNano?: number; aiuUnknownCalls?: number };
	};
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
	kind: "main" | "sub" | "advisor" | "external";
	parentId?: string;
	execution?: ExternalAgentExecution;
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
		/** Cumulative own-session assistant and model_usage cost, excluding nested task results. */
		directCost?: number;
		/** Cumulative own-session AI credits, counted where calls are recorded (assistant messages, model_usage). */
		directAiu?: AiuTotals;
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
