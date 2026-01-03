import { type Static, Type } from "@sinclair/typebox";

/** Source of an agent definition */
export type AgentSource = "bundled" | "user" | "project";

/** Single task item for parallel execution */
export const taskItemSchema = Type.Object({
	agent: Type.String({ description: "Agent name" }),
	task: Type.String({ description: "Task description for the agent" }),
	model: Type.Optional(Type.String({ description: "Model override for this task" })),
});

export type TaskItem = Static<typeof taskItemSchema>;

/** Maximum tasks per call */
export const MAX_PARALLEL_TASKS = 32;

/** Maximum concurrent workers */
export const MAX_CONCURRENCY = 16;

/** Maximum output bytes per agent */
export const MAX_OUTPUT_BYTES = 500_000;

/** Maximum output lines per agent */
export const MAX_OUTPUT_LINES = 5000;

/** Maximum agents to show in description */
export const MAX_AGENTS_IN_DESCRIPTION = 10;

/** Environment variable to inhibit subagent spawning (legacy, still checked for backwards compat) */
export const PI_NO_SUBAGENTS_ENV = "PI_NO_SUBAGENTS";

/** Environment variable containing blocked agent name (self-recursion prevention) */
export const PI_BLOCKED_AGENT_ENV = "PI_BLOCKED_AGENT";

/** Task tool parameters */
export const taskSchema = Type.Object({
	context: Type.Optional(Type.String({ description: "Shared context prepended to all task prompts" })),
	tasks: Type.Array(taskItemSchema, {
		description: "Tasks to run in parallel",
		maxItems: MAX_PARALLEL_TASKS,
	}),
});

export type TaskParams = Static<typeof taskSchema>;

/** A code review finding reported by the reviewer agent */
export interface ReviewFinding {
	title: string;
	body: string;
	priority: number;
	confidence: number;
	file_path: string;
	line_start: number;
	line_end: number;
}

/** Review summary submitted by the reviewer agent */
export interface ReviewSummary {
	overall_correctness: "correct" | "incorrect";
	explanation: string;
	confidence: number;
}

/** Structured review data extracted from reviewer agent */
export interface ReviewData {
	findings: ReviewFinding[];
	summary?: ReviewSummary;
}

/** Agent definition (bundled or discovered) */
export interface AgentDefinition {
	name: string;
	description: string;
	systemPrompt: string;
	tools?: string[];
	model?: string;
	recursive?: boolean;
	source: AgentSource;
	filePath?: string;
}

/** Progress tracking for a single agent */
export interface AgentProgress {
	index: number;
	agent: string;
	agentSource: AgentSource;
	status: "pending" | "running" | "completed" | "failed" | "aborted";
	task: string;
	currentTool?: string;
	currentToolArgs?: string;
	currentToolStartMs?: number;
	recentTools: Array<{ tool: string; args: string; endMs: number }>;
	recentOutput: string[];
	toolCount: number;
	tokens: number;
	durationMs: number;
	modelOverride?: string;
	/** Data extracted by registered subprocess tool handlers (keyed by tool name) */
	extractedToolData?: Record<string, unknown[]>;
}

/** Result from a single agent execution */
export interface SingleResult {
	index: number;
	agent: string;
	agentSource: AgentSource;
	task: string;
	exitCode: number;
	output: string;
	stderr: string;
	truncated: boolean;
	durationMs: number;
	tokens: number;
	modelOverride?: string;
	error?: string;
	aborted?: boolean;
	jsonlEvents?: string[];
	artifactPaths?: { inputPath: string; outputPath: string; jsonlPath?: string };
	/** Data extracted by registered subprocess tool handlers (keyed by tool name) */
	extractedToolData?: Record<string, unknown[]>;
	/** Output metadata for Output tool integration */
	outputMeta?: { lineCount: number; charCount: number };
}

/** Tool details for TUI rendering */
export interface TaskToolDetails {
	projectAgentsDir: string | null;
	results: SingleResult[];
	totalDurationMs: number;
	outputPaths?: string[];
	progress?: AgentProgress[];
}
