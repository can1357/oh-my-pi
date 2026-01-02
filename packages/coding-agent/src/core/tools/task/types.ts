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

/** Environment variable to inhibit subagent spawning */
export const PI_NO_SUBAGENTS_ENV = "PI_NO_SUBAGENTS";

/** Task tool parameters */
export const taskSchema = Type.Object({
	context: Type.Optional(Type.String({ description: "Shared context prepended to all task prompts" })),
	tasks: Type.Array(taskItemSchema, {
		description: "Tasks to run in parallel",
		maxItems: MAX_PARALLEL_TASKS,
	}),
});

export type TaskParams = Static<typeof taskSchema>;

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
	status: "pending" | "running" | "completed" | "failed";
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
	jsonlEvents?: string[];
	artifactPaths?: { inputPath: string; outputPath: string; jsonlPath?: string };
}

/** Tool details for TUI rendering */
export interface TaskToolDetails {
	projectAgentsDir: string | null;
	results: SingleResult[];
	totalDurationMs: number;
	outputPaths?: string[];
	progress?: AgentProgress[];
}
