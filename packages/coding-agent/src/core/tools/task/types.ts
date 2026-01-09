import type { Usage } from "@oh-my-pi/pi-ai";
import { type Static, Type } from "@sinclair/typebox";

/** Source of an agent definition */
export type AgentSource = "bundled" | "user" | "project";

function getEnv(name: string, defaultValue: number): number {
	const value = process.env[name];
	if (value === undefined) {
		return defaultValue;
	}
	try {
		const number = Number.parseInt(value, 10);
		if (!Number.isNaN(number) && number > 0) {
			return number;
		}
	} catch {}
	return defaultValue;
}

/** Maximum tasks per call */
export const MAX_PARALLEL_TASKS = getEnv("OMP_TASK_MAX_PARALLEL", 32);

/** Maximum concurrent workers */
export const MAX_CONCURRENCY = getEnv("OMP_TASK_MAX_CONCURRENCY", 16);

/** Maximum output bytes per agent */
export const MAX_OUTPUT_BYTES = getEnv("OMP_TASK_MAX_OUTPUT_BYTES", 500_000);

/** Maximum output lines per agent */
export const MAX_OUTPUT_LINES = getEnv("OMP_TASK_MAX_OUTPUT_LINES", 5000);

/** Maximum agents to show in description */
export const MAX_AGENTS_IN_DESCRIPTION = getEnv("OMP_TASK_MAX_AGENTS_IN_DESCRIPTION", 10);

/** EventBus channel for raw subagent events */
export const TASK_SUBAGENT_EVENT_CHANNEL = "task:subagent:event";

/** EventBus channel for aggregated subagent progress */
export const TASK_SUBAGENT_PROGRESS_CHANNEL = "task:subagent:progress";

/** Single task item for parallel execution */
export const taskItemSchema = Type.Object({
	id: Type.String({
		description: "Short task identifier for display (max 32 chars, CamelCase, e.g. 'SessionStore', 'WebFetchFix')",
		maxLength: 32,
		pattern: "^[A-Za-z][A-Za-z0-9]*$",
	}),
	task: Type.String({ description: "Task description for the agent" }),
	description: Type.String({ description: "Short description for UI display" }),
});

export type TaskItem = Static<typeof taskItemSchema>;

/** Task tool parameters */
export const taskSchema = Type.Object({
	agent: Type.String({ description: "Agent type to use for all tasks" }),
	context: Type.String({ description: "Shared context prepended to all task prompts" }),
	model: Type.Optional(
		Type.String({
			description: "Model override for all tasks (fuzzy matching, e.g. 'sonnet', 'opus')",
		})
	),
	output: Type.Optional(
		Type.Any({
			description: "JTD schema for structured subagent output (used by the complete tool)",
		})
	),
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
	spawns?: string[] | "*";
	model?: string;
	source: AgentSource;
	filePath?: string;
}

/** Progress tracking for a single agent */
export interface AgentProgress {
	index: number;
	taskId: string;
	agent: string;
	agentSource: AgentSource;
	status: "pending" | "running" | "completed" | "failed" | "aborted";
	task: string;
	description?: string;
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
	taskId: string;
	agent: string;
	agentSource: AgentSource;
	task: string;
	description?: string;
	exitCode: number;
	output: string;
	stderr: string;
	truncated: boolean;
	durationMs: number;
	tokens: number;
	modelOverride?: string;
	error?: string;
	aborted?: boolean;
	/** Aggregated usage from the subprocess, accumulated incrementally from message_end events. */
	usage?: Usage;
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
	/** Aggregated usage across all subagents. */
	usage?: Usage;
	outputPaths?: string[];
	progress?: AgentProgress[];
}
