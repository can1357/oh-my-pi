/** Visibility of context relative to the root frontier model. */
export type ContextFlowVisibility = "root" | "worker" | "local" | "externalized" | "shadow" | "dropped";

/** Wiring classification for research-stack components. */
export type WiringStatus =
	| "hot_path"
	| "conditional"
	| "shadow"
	| "experiment_only"
	| "present_not_wired"
	| "stale"
	| "unknown";

export type ContextFlowStage =
	| "prompt"
	| "preprocess"
	| "classifier"
	| "semantic"
	| "context_manager"
	| "root_model"
	| "tool"
	| "worker"
	| "economics"
	| "offload";

export type ContextFlowNodeStatus = "pending" | "running" | "complete" | "failed" | "skipped" | "not_wired";

export interface ContextFlowNode {
	id: string;
	parentId?: string;
	turn: number;
	stage: ContextFlowStage;
	component: string;
	role: string;
	visibility: ContextFlowVisibility;
	wiringStatus?: WiringStatus;
	provider?: string;
	model?: string;
	inputTokens?: number;
	outputTokens?: number;
	cachedTokens?: number;
	inputBytes?: number;
	outputBytes?: number;
	startedAt: number;
	durationMs?: number;
	status: ContextFlowNodeStatus;
	decision?: string;
	reason?: string;
	evidenceHandles?: readonly string[];
	grantCount?: number;
}

export interface OffloadSummary {
	/** Bytes stored in RLM / external addressable store. */
	externalBytes: number;
	/** Tokens reintroduced to root (e.g. EvidencePacket). */
	reintroducedTokens: number;
	/** Worker-visible grant tokens (estimate). */
	grantedTokens?: number;
	active: boolean;
}

export interface ContextFlowEconomics {
	rootTokens: number;
	workerTokens: number;
	subagentTokens: number;
	cachedTokens: number;
	unattributedTokens: number;
	totalIncrementalTokens: number;
	costUsd: number;
	reconciliationDelta?: number;
	coverage?: number;
	tokenomicsEnabled: boolean;
}

export interface ContextFlowSnapshot {
	turn: number;
	updatedAt: number;
	nodes: readonly ContextFlowNode[];
	offload: OffloadSummary;
	economics: ContextFlowEconomics;
	wiring: Readonly<Record<string, WiringStatus>>;
}
