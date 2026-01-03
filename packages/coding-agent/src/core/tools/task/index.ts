/**
 * Task tool - Delegate tasks to specialized agents.
 *
 * Discovers agent definitions from:
 *   - Bundled agents (shipped with omp-coding-agent)
 *   - ~/.omp/agent/agents/*.md (user-level)
 *   - .omp/agents/*.md (project-level)
 *
 * Supports:
 *   - Single agent execution
 *   - Parallel execution with concurrency limits
 *   - Progress tracking via JSON events
 *   - Session artifacts for debugging
 */

import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import type { Theme } from "../../../modes/interactive/theme/theme";
import { cleanupTempDir, createTempArtifactsDir, getArtifactsDir } from "./artifacts";
import { discoverAgents, getAgent } from "./discovery";
import { runSubprocess } from "./executor";
import { mapWithConcurrencyLimit } from "./parallel";
import { formatDuration, renderCall, renderResult } from "./render";
import {
	type AgentProgress,
	MAX_AGENTS_IN_DESCRIPTION,
	MAX_CONCURRENCY,
	MAX_PARALLEL_TASKS,
	OMP_BLOCKED_AGENT_ENV,
	OMP_NO_SUBAGENTS_ENV,
	type TaskToolDetails,
	taskSchema,
} from "./types";

// Import review tools for side effects (registers subprocess tool handlers)
import "../review";

/** Format byte count for display */
function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes}B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}K`;
	return `${(bytes / (1024 * 1024)).toFixed(1)}M`;
}

/** Session context interface */
interface SessionContext {
	getSessionFile: () => string | null;
}

/** Task tool options */
interface TaskToolOptions {
	/** Set of available tool names (for cross-tool awareness) */
	availableTools?: Set<string>;
}

// Re-export types and utilities
export { loadBundledAgents as BUNDLED_AGENTS } from "./agents";
export { discoverCommands, expandCommand, getCommand } from "./commands";
export { discoverAgents, getAgent } from "./discovery";
export type { AgentDefinition, AgentProgress, SingleResult, TaskParams, TaskToolDetails } from "./types";
export { taskSchema } from "./types";

/**
 * Build dynamic tool description listing available agents.
 */
function buildDescription(cwd: string): string {
	const { agents } = discoverAgents(cwd);

	const lines: string[] = [];

	lines.push("Launch a new agent to handle complex, multi-step tasks autonomously.");
	lines.push("");
	lines.push(
		"The Task tool launches specialized agents (subprocesses) that autonomously handle complex tasks. Each agent type has specific capabilities and tools available to it.",
	);
	lines.push("");
	lines.push("Available agent types and the tools they have access to:");

	for (const agent of agents.slice(0, MAX_AGENTS_IN_DESCRIPTION)) {
		const tools = agent.tools?.join(", ") || "All tools";
		lines.push(`- ${agent.name}: ${agent.description} (Tools: ${tools})`);
	}
	if (agents.length > MAX_AGENTS_IN_DESCRIPTION) {
		lines.push(`  ...and ${agents.length - MAX_AGENTS_IN_DESCRIPTION} more agents`);
	}

	lines.push("");
	lines.push("When NOT to use the Task tool:");
	lines.push(
		"- If you want to read a specific file path, use the Read or Glob tool instead of the Task tool, to find the match more quickly",
	);
	lines.push(
		'- If you are searching for a specific class definition like "class Foo", use the Glob tool instead, to find the match more quickly',
	);
	lines.push(
		"- If you are searching for code within a specific file or set of 2-3 files, use the Read tool instead of the Task tool, to find the match more quickly",
	);
	lines.push("- Other tasks that are not related to the agent descriptions above");
	lines.push("");
	lines.push("");
	lines.push("Usage notes:");
	lines.push("- Always include a short description of the task in the task parameter");
	lines.push("- Launch multiple agents concurrently whenever possible, to maximize performance");
	lines.push(
		"- When the agent is done, it will return a single message back to you. The result returned by the agent is not visible to the user. To show the user the result, you should send a text message back to the user with a concise summary of the result.",
	);
	lines.push(
		"- Each agent invocation is stateless. You will not be able to send additional messages to the agent, nor will the agent be able to communicate with you outside of its final report. Therefore, your task should contain a highly detailed task description for the agent to perform autonomously and you should specify exactly what information the agent should return back to you in its final and only message to you.",
	);
	lines.push(
		"- IMPORTANT: Agent results are intermediate data, not task completions. Use the agent's findings to continue executing the user's request. Do not treat agent reports as 'task complete' signals - they provide context for you to perform the actual work.",
	);
	lines.push("- The agent's outputs should generally be trusted");
	lines.push(
		"- Clearly tell the agent whether you expect it to write code or just to do research (search, file reads, web fetches, etc.), since it is not aware of the user's intent",
	);
	lines.push(
		"- If the agent description mentions that it should be used proactively, then you should try your best to use it without the user having to ask for it first. Use your judgement.",
	);
	lines.push("");
	lines.push("Parameters:");
	lines.push(
		`- tasks: Array of {agent, task, model?} - tasks to run in parallel (max ${MAX_PARALLEL_TASKS}, ${MAX_CONCURRENCY} concurrent)`,
	);
	lines.push(
		'  - model: (optional) Override the agent\'s default model with fuzzy matching (e.g., "sonnet", "codex", "5.2"). Supports comma-separated fallbacks: "gpt, opus" tries gpt first, then opus. Use "default" for omp\'s default model',
	);
	lines.push(
		"- context: (optional) Shared context string prepended to all task prompts - use this to avoid repeating instructions",
	);
	lines.push("");
	lines.push("Results are always written to {tempdir}/omp-task-{runId}/task_{agent}_{index}.md");
	lines.push("");
	lines.push("Example usage:");
	lines.push("");
	lines.push("<example_agent_descriptions>");
	lines.push('"code-reviewer": use this agent after you are done writing a significant piece of code');
	lines.push('"explore": use this agent for fast codebase exploration and research');
	lines.push("</example_agent_descriptions>");
	lines.push("");
	lines.push("<example>");
	lines.push('user: "Please write a function that checks if a number is prime"');
	lines.push("assistant: Sure let me write a function that checks if a number is prime");
	lines.push("assistant: I'm going to use the Write tool to write the following code:");
	lines.push("<code>");
	lines.push("function isPrime(n) {");
	lines.push("  if (n <= 1) return false");
	lines.push("  for (let i = 2; i * i <= n; i++) {");
	lines.push("    if (n % i === 0) return false");
	lines.push("  }");
	lines.push("  return true");
	lines.push("}");
	lines.push("</code>");
	lines.push("<commentary>");
	lines.push(
		"Since a significant piece of code was written and the task was completed, now use the code-reviewer agent to review the code",
	);
	lines.push("</commentary>");
	lines.push("assistant: Now let me use the code-reviewer agent to review the code");
	lines.push(
		'assistant: Uses the Task tool: { tasks: [{ agent: "code-reviewer", task: "Review the isPrime function" }] }',
	);
	lines.push("</example>");
	lines.push("");
	lines.push("<example>");
	lines.push('user: "Find all TODO comments in the codebase"');
	lines.push("assistant: I'll use multiple explore agents to search different directories in parallel");
	lines.push("assistant: Uses the Task tool:");
	lines.push("{");
	lines.push('  "context": "Find all TODO comments. Return file:line:content format.",');
	lines.push('  "tasks": [');
	lines.push('    { "agent": "explore", "task": "Search in src/" },');
	lines.push('    { "agent": "explore", "task": "Search in lib/" },');
	lines.push('    { "agent": "explore", "task": "Search in tests/" }');
	lines.push("  ]");
	lines.push("}");
	lines.push("Results → {tempdir}/omp-task-{runId}/task_explore_*.md");
	lines.push("</example>");

	return lines.join("\n");
}

/**
 * Create the task tool configured for a specific working directory.
 */
export function createTaskTool(
	cwd: string,
	sessionContext?: SessionContext,
	options?: TaskToolOptions,
): AgentTool<typeof taskSchema, TaskToolDetails, Theme> {
	const hasOutputTool = options?.availableTools?.has("output") ?? false;
	// Check if subagents are completely inhibited (legacy recursion prevention)
	if (process.env[OMP_NO_SUBAGENTS_ENV]) {
		return {
			name: "task",
			label: "Task",
			description: "Sub-agents disabled (recursion prevention)",
			parameters: taskSchema,
			execute: async () => ({
				content: [{ type: "text", text: "Sub-agents are disabled for this agent (recursion prevention)." }],
				details: {
					projectAgentsDir: null,
					results: [],
					totalDurationMs: 0,
				},
			}),
		};
	}

	// Check for same-agent blocking (allows other agent types)
	const blockedAgent = process.env[OMP_BLOCKED_AGENT_ENV];

	return {
		name: "task",
		label: "Task",
		description: buildDescription(cwd),
		parameters: taskSchema,
		renderCall,
		renderResult,
		execute: async (_toolCallId, params, signal, onUpdate) => {
			const startTime = Date.now();
			const { agents, projectAgentsDir } = discoverAgents(cwd);
			const context = params.context;

			// Handle empty or missing tasks
			if (!params.tasks || params.tasks.length === 0) {
				const available = agents.map((a) => a.name).join(", ") || "none";
				return {
					content: [
						{
							type: "text",
							text: `No tasks provided. Use: { tasks: [{agent, task}, ...] }\nAvailable agents: ${available}`,
						},
					],
					details: {
						projectAgentsDir,
						results: [],
						totalDurationMs: 0,
					},
				};
			}

			// Validate task count
			if (params.tasks.length > MAX_PARALLEL_TASKS) {
				return {
					content: [
						{
							type: "text",
							text: `Too many tasks (${params.tasks.length}). Max is ${MAX_PARALLEL_TASKS}.`,
						},
					],
					details: {
						projectAgentsDir,
						results: [],
						totalDurationMs: 0,
					},
				};
			}

			// Derive artifacts directory
			const sessionFile = sessionContext?.getSessionFile() ?? null;
			const artifactsDir = sessionFile ? getArtifactsDir(sessionFile) : null;
			const tempArtifactsDir = artifactsDir ? null : createTempArtifactsDir();
			const effectiveArtifactsDir = artifactsDir || tempArtifactsDir!;

			// Initialize progress tracking
			const progressMap = new Map<number, AgentProgress>();

			// Update callback
			const emitProgress = () => {
				const progress = Array.from(progressMap.values()).sort((a, b) => a.index - b.index);
				onUpdate?.({
					content: [{ type: "text", text: `Running ${params.tasks.length} agents...` }],
					details: {
						projectAgentsDir,
						results: [],
						totalDurationMs: Date.now() - startTime,
						progress,
					},
				});
			};

			try {
				let tasks = params.tasks;
				let skippedSelfRecursion = 0;

				// Filter out blocked agent (self-recursion prevention)
				if (blockedAgent) {
					const blockedTasks = tasks.filter((t) => t.agent === blockedAgent);
					tasks = tasks.filter((t) => t.agent !== blockedAgent);
					skippedSelfRecursion = blockedTasks.length;

					if (skippedSelfRecursion > 0 && tasks.length === 0) {
						return {
							content: [
								{
									type: "text",
									text: `Cannot spawn ${blockedAgent} agent from within itself (recursion prevention). Use a different agent type.`,
								},
							],
							details: {
								projectAgentsDir,
								results: [],
								totalDurationMs: Date.now() - startTime,
							},
						};
					}
				}

				// Validate all agents exist
				for (const task of tasks) {
					if (!getAgent(agents, task.agent)) {
						const available = agents.map((a) => a.name).join(", ");
						return {
							content: [{ type: "text", text: `Unknown agent: ${task.agent}. Available: ${available}` }],
							details: {
								projectAgentsDir,
								results: [],
								totalDurationMs: Date.now() - startTime,
							},
						};
					}
				}

				// Initialize progress for all tasks
				for (let i = 0; i < tasks.length; i++) {
					const agentCfg = getAgent(agents, tasks[i].agent);
					progressMap.set(i, {
						index: i,
						agent: tasks[i].agent,
						agentSource: agentCfg?.source ?? "user",
						status: "pending",
						task: tasks[i].task,
						recentTools: [],
						recentOutput: [],
						toolCount: 0,
						tokens: 0,
						durationMs: 0,
						modelOverride: tasks[i].model,
					});
				}
				emitProgress();

				// Build full prompts with context prepended
				const tasksWithContext = tasks.map((t) => ({
					agent: t.agent,
					task: context ? `${context}\n\n${t.task}` : t.task,
					model: t.model,
				}));

				// Execute in parallel with concurrency limit
				const results = await mapWithConcurrencyLimit(tasksWithContext, MAX_CONCURRENCY, async (task, index) => {
					const agent = getAgent(agents, task.agent)!;
					return runSubprocess({
						cwd,
						agent,
						task: task.task,
						index,
						context: undefined, // Already prepended above
						modelOverride: task.model,
						sessionFile,
						persistArtifacts: !!artifactsDir,
						artifactsDir: effectiveArtifactsDir,
						signal,
						onProgress: (progress) => {
							progressMap.set(index, structuredClone(progress));
							emitProgress();
						},
					});
				});

				// Collect output paths (artifacts already written by executor in real-time)
				const outputPaths: string[] = [];
				for (const result of results) {
					if (result.artifactPaths) {
						outputPaths.push(result.artifactPaths.outputPath);
					}
				}

				// Build final output - match plugin format
				const successCount = results.filter((r) => r.exitCode === 0).length;
				const totalDuration = Date.now() - startTime;

				const summaries = results.map((r) => {
					const status = r.exitCode === 0 ? "completed" : `failed (exit ${r.exitCode})`;
					const output = r.output.trim() || r.stderr.trim() || "(no output)";
					const preview = output.split("\n").slice(0, 5).join("\n");
					// Include output metadata and ID; include path only if Output tool unavailable (for Read fallback)
					const outputId = `${r.agent}_${r.index}`;
					const meta = r.outputMeta
						? ` [${r.outputMeta.lineCount} lines, ${formatBytes(r.outputMeta.charCount)}]`
						: "";
					const pathInfo = !hasOutputTool && r.artifactPaths?.outputPath ? ` (${r.artifactPaths.outputPath})` : "";
					return `[${r.agent}] ${status}${meta} → ${outputId}${pathInfo}\n${preview}`;
				});

				const skippedNote =
					skippedSelfRecursion > 0
						? ` (${skippedSelfRecursion} ${blockedAgent} task${skippedSelfRecursion > 1 ? "s" : ""} skipped - self-recursion blocked)`
						: "";
				const summary = `${successCount}/${results.length} succeeded${skippedNote} [${formatDuration(totalDuration)}]\n\n${summaries.join("\n\n---\n\n")}`;

				// Cleanup temp directory if used
				if (tempArtifactsDir) {
					await cleanupTempDir(tempArtifactsDir);
				}

				return {
					content: [{ type: "text", text: summary }],
					details: {
						projectAgentsDir,
						results,
						totalDurationMs: totalDuration,
						outputPaths,
					},
				};
			} catch (err) {
				// Cleanup temp directory on error
				if (tempArtifactsDir) {
					await cleanupTempDir(tempArtifactsDir);
				}

				return {
					content: [{ type: "text", text: `Task execution failed: ${err}` }],
					details: {
						projectAgentsDir,
						results: [],
						totalDurationMs: Date.now() - startTime,
					},
				};
			}
		},
	};
}

// Default task tool using process.cwd()
export const taskTool = createTaskTool(process.cwd());
