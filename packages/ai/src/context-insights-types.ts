/** Dependency-free Context Insights response contracts shared by server, TUI, and browser. */
export type ContextCategoryId = "systemPrompt" | "systemTools" | "systemContext" | "skills" | "messages";

export interface ContextCategoryTokens {
	systemPrompt: number;
	systemTools: number;
	systemContext: number;
	skills: number;
	messages: number;
}

export interface ContextNamedTokens {
	name: string;
	tokens: number;
}

export interface ContextSnapshotDetails {
	contextWindow: number;
	categories: ContextCategoryTokens;
	/** Per-tool schema tokens. Sum <= categories.systemTools. */
	toolSchemas?: ContextNamedTokens[];
	/** Entries omitted by the persisted cap (their tokens remain in the category). */
	omittedToolSchemas?: number;
	/** Per-skill tokens. Sum <= categories.skills. */
	skills?: ContextNamedTokens[];
	omittedSkills?: number;
	/** System-prompt part tokens; part 0 has skills subtracted. */
	systemPromptParts?: number[];
	/** Original parts merged into the last returned part (0 when none). */
	systemPromptPartsOmitted?: number;
	messageCount: number;
	pendingMessageTokens: number;
}

/** Bounded projection attached to a returned step. */
export interface ContextStepDetails {
	contextWindow: number;
	categories: ContextCategoryTokens;
	toolSchemas?: ContextNamedTokens[];
	omittedToolSchemas?: number;
	skills?: ContextNamedTokens[];
	omittedSkills?: number;
	systemPromptParts?: number[];
	systemPromptPartsOmitted?: number;
	messageCount: number;
	pendingMessageTokens: number;
}

export interface ContextStepUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	total: number;
	costTotal?: number;
}

export interface ContextStep {
	/** Assistant session entry id. */
	id: string;
	/** Absolute step index within the session (0-based). */
	index: number;
	timestamp: number;
	model?: string;
	provider?: string;
	/** Provider-authoritative prompt tokens when a snapshot exists, else usage-derived. */
	promptTokens: number;
	anchored: boolean;
	/** Undefined on legacy steps without ContextSnapshotDetails. */
	composition?: ContextCategoryTokens;
	/** True when composition comes from a request-time estimate. */
	compositionEstimated?: boolean;
	/** Bounded projection; undefined when legacy or over the maxBrowserEntries budget. */
	details?: ContextStepDetails;
	/** promptTokens - sum(composition); signed, never redistributed. */
	unattributed?: number;
	contextWindow?: number;
	deltaTokens?: number;
	deltaKind: "first" | "grow" | "shrink" | "compaction" | "reset" | "model-switch";
	usage?: ContextStepUsage;
	eventIds: string[];
	filePaths: string[];
}

export type ContextEventKind = "inject" | "compact" | "prune" | "switch" | "mode" | "reset" | "branch";

export interface ContextEvent {
	id: string;
	timestamp: number;
	kind: ContextEventKind;
	label: string;
	detail?: string;
	tokensBefore?: number;
	tokensAfter?: number;
	source?: string;
	/** True for prune inferred from ToolResultMessage.prunedAt. */
	inferred?: boolean;
	/** Absolute index of the next step in file order (the step it affects); undefined when trailing. */
	stepIndex?: number;
}

export interface ContextFileActivity {
	path: string;
	reads: number;
	writes: number;
	edits: number;
	searches: number;
	linesRead: number;
	linesAdded: number;
	linesRemoved: number;
	bytesRead: number;
	bytesWritten: number;
	lastTimestamp: number;
}

export interface ContextAgentUsage {
	trackId: string;
	/** Absolute transcript filename for fleet drill-down. */
	file?: string;
	label: string;
	agent?: string;
	model?: string;
	requests: number;
	peakTokens: number;
	lastTokens?: number;
	costTotal?: number;
	status: "main" | "subagent" | "advisor";
}

export interface ContextTimeline {
	schemaVersion: 1;
	sessionId: string;
	file?: string;
	cwd?: string;
	source: "live" | "journal";
	steps: ContextStep[];
	omittedSteps: number;
	/** Steps with details in the journal but skipped by the maxBrowserEntries budget. */
	detailsOmittedSteps: number;
	/** Last returned step's composition, if any. */
	composition?: ContextCategoryTokens;
	contextWindow?: number;
	peakTokens: number;
	/** Usage cost across every eligible step, including steps beyond `maxSteps`. */
	costTotal: number;
	/** Max promptTokens across every eligible step, including steps beyond `maxSteps`. */
	peakTokensTotal: number;
	events: ContextEvent[];
	omittedEvents: number;
	files: ContextFileActivity[];
	omittedFiles: number;
	/** File tool calls with no matching toolResult in the active branch. */
	incompleteFileCalls: number;
	agents: ContextAgentUsage[];
	legacySteps: number;
	truncated: boolean;
}
export interface ContextTimelineLimits {
	maxSteps: number;
	maxEvents: number;
	maxFiles: number;
	/** Total named entries across returned step.details. */
	maxBrowserEntries: number;
	maxToolSchemas: number;
	maxSkills: number;
	maxSystemParts: number;
}
