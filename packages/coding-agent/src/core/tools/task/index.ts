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
import type { Usage } from "@oh-my-pi/pi-ai";
import type { Theme } from "../../../modes/interactive/theme/theme";
import taskDescriptionTemplate from "../../../prompts/tools/task.md" with { type: "text" };
import { renderPromptTemplate } from "../../prompt-templates";
import { formatDuration } from "../render-utils";
import { cleanupTempDir, createTempArtifactsDir, getArtifactsDir } from "./artifacts";
import { discoverAgents, getAgent } from "./discovery";
import { runSubprocess } from "./executor";
import { mapWithConcurrencyLimit } from "./parallel";
import { renderCall, renderResult } from "./render";
import {
	type AgentProgress,
	MAX_AGENTS_IN_DESCRIPTION,
	MAX_CONCURRENCY,
	MAX_PARALLEL_TASKS,
	type SingleResult,
	type TaskToolDetails,
	taskSchema,
} from "./types";

// Import review tools for side effects (registers subagent tool handlers)
import "../review";
import type { ToolSession } from "..";

/** Format byte count for display */
function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes}B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}K`;
	return `${(bytes / (1024 * 1024)).toFixed(1)}M`;
}

function createUsageTotals(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function addUsageTotals(target: Usage, usage: Partial<Usage>): void {
	const input = usage.input ?? 0;
	const output = usage.output ?? 0;
	const cacheRead = usage.cacheRead ?? 0;
	const cacheWrite = usage.cacheWrite ?? 0;
	const totalTokens = usage.totalTokens ?? input + output + cacheRead + cacheWrite;
	const cost =
		usage.cost ??
		({
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			total: 0,
		} satisfies Usage["cost"]);

	target.input += input;
	target.output += output;
	target.cacheRead += cacheRead;
	target.cacheWrite += cacheWrite;
	target.totalTokens += totalTokens;
	target.cost.input += cost.input;
	target.cost.output += cost.output;
	target.cost.cacheRead += cost.cacheRead;
	target.cost.cacheWrite += cost.cacheWrite;
	target.cost.total += cost.total;
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
async function buildDescription(cwd: string): Promise<string> {
	const { agents } = await discoverAgents(cwd);

	return renderPromptTemplate(taskDescriptionTemplate, {
		agents: agents.slice(0, MAX_AGENTS_IN_DESCRIPTION),
		moreAgents: agents.length > MAX_AGENTS_IN_DESCRIPTION ? agents.length - MAX_AGENTS_IN_DESCRIPTION : 0,
		MAX_PARALLEL_TASKS,
		MAX_CONCURRENCY,
	});
}

/**
 * Create the task tool configured for a specific session.
 */
export async function createTaskTool(
	session: ToolSession,
): Promise<AgentTool<typeof taskSchema, TaskToolDetails, Theme>> {
	// Check for same-agent blocking (allows other agent types)
	const blockedAgent = process.env.OMP_BLOCKED_AGENT;

	// Build description upfront
	const description = await buildDescription(session.cwd);

	return {
		name: "task",
		label: "Task",
		description,
		parameters: taskSchema,
		renderCall,
		renderResult,
		execute: async (_toolCallId, params, signal, onUpdate) => {
			const startTime = Date.now();
			const { agents, projectAgentsDir } = await discoverAgents(session.cwd);
			const { agent: agentName, context, model, output: outputSchema } = params;

			const isDefaultModelAlias = (value: string | undefined): boolean => {
				if (!value) return true;
				const normalized = value.trim().toLowerCase();
				return normalized === "default" || normalized === "pi/default" || normalized === "omp/default";
			};

			// Validate agent exists
			const agent = getAgent(agents, agentName);
			if (!agent) {
				const available = agents.map((a) => a.name).join(", ") || "none";
				return {
					content: [
						{
							type: "text",
							text: `Unknown agent "${agentName}". Available: ${available}`,
						},
					],
					details: {
						projectAgentsDir,
						results: [],
						totalDurationMs: 0,
					},
				};
			}

			const shouldInheritSessionModel = model === undefined && isDefaultModelAlias(agent.model);
			const sessionModel = shouldInheritSessionModel ? session.getActiveModelString?.() : undefined;
			const modelOverride = model ?? sessionModel ?? session.getModelString?.();
			const thinkingLevelOverride = agent.thinkingLevel;

			// Output schema priority: agent frontmatter > params > inherited from parent session
			const schemaOverridden = outputSchema !== undefined && agent.output !== undefined;
			const effectiveOutputSchema = agent.output ?? outputSchema ?? session.outputSchema;

			// Handle empty or missing tasks
			if (!params.tasks || params.tasks.length === 0) {
				return {
					content: [
						{
							type: "text",
							text: `No tasks provided. Use: { agent, context, tasks: [{id, task, description}, ...] }`,
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

			const tasks = params.tasks;
			const missingTaskIndexes: number[] = [];
			const idIndexes = new Map<string, number[]>();

			for (let i = 0; i < tasks.length; i++) {
				const id = tasks[i]?.id;
				if (typeof id !== "string" || id.trim() === "") {
					missingTaskIndexes.push(i);
					continue;
				}
				const normalizedId = id.toLowerCase();
				const indexes = idIndexes.get(normalizedId);
				if (indexes) {
					indexes.push(i);
				} else {
					idIndexes.set(normalizedId, [i]);
				}
			}

			const duplicateIds: Array<{ id: string; indexes: number[] }> = [];
			for (const [normalizedId, indexes] of idIndexes.entries()) {
				if (indexes.length > 1) {
					duplicateIds.push({
						id: tasks[indexes[0]]?.id ?? normalizedId,
						indexes,
					});
				}
			}

			if (missingTaskIndexes.length > 0 || duplicateIds.length > 0) {
				const problems: string[] = [];
				if (missingTaskIndexes.length > 0) {
					problems.push(`Missing task ids at indexes: ${missingTaskIndexes.join(", ")}`);
				}
				if (duplicateIds.length > 0) {
					const details = duplicateIds
						.map((entry) => `${entry.id} (indexes ${entry.indexes.join(", ")})`)
						.join("; ");
					problems.push(`Duplicate task ids detected (case-insensitive): ${details}`);
				}
				return {
					content: [{ type: "text", text: `Invalid tasks: ${problems.join(". ")}` }],
					details: {
						projectAgentsDir,
						results: [],
						totalDurationMs: 0,
					},
				};
			}

			// Derive artifacts directory
			const sessionFile = session.getSessionFile();
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
				// Check self-recursion prevention
				if (blockedAgent && agentName === blockedAgent) {
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

				// Check spawn restrictions from parent
				const parentSpawns = session.getSessionSpawns() ?? "*";
				const allowedSpawns = parentSpawns.split(",").map((s) => s.trim());
				const isSpawnAllowed = (): boolean => {
					if (parentSpawns === "") return false; // Empty = deny all
					if (parentSpawns === "*") return true; // Wildcard = allow all
					return allowedSpawns.includes(agentName);
				};

				if (!isSpawnAllowed()) {
					const allowed = parentSpawns === "" ? "none (spawns disabled for this agent)" : parentSpawns;
					return {
						content: [{ type: "text", text: `Cannot spawn '${agentName}'. Allowed: ${allowed}` }],
						details: {
							projectAgentsDir,
							results: [],
							totalDurationMs: Date.now() - startTime,
						},
					};
				}

				// Build full prompts with context prepended
				const tasksWithContext = tasks.map((t) => ({
					task: context ? `${context}\n\n${t.task}` : t.task,
					description: t.description,
					taskId: t.id,
				}));

				// Initialize progress for all tasks
				for (let i = 0; i < tasksWithContext.length; i++) {
					const t = tasksWithContext[i];
					progressMap.set(i, {
						index: i,
						taskId: t.taskId,
						agent: agentName,
						agentSource: agent.source,
						status: "pending",
						task: t.task,
						recentTools: [],
						recentOutput: [],
						toolCount: 0,
						tokens: 0,
						durationMs: 0,
						modelOverride,
						description: t.description,
					});
				}
				emitProgress();

				// Execute in parallel with concurrency limit
				const { results: partialResults, aborted } = await mapWithConcurrencyLimit(
					tasksWithContext,
					MAX_CONCURRENCY,
					async (task, index) => {
						return runSubprocess({
							cwd: session.cwd,
							agent,
							task: task.task,
							description: task.description,
							index,
							taskId: task.taskId,
							context: undefined, // Already prepended above
							modelOverride,
							thinkingLevel: thinkingLevelOverride,
							outputSchema: effectiveOutputSchema,
							sessionFile,
							persistArtifacts: !!artifactsDir,
							artifactsDir: effectiveArtifactsDir,
							enableLsp: false,
							signal,
							eventBus: undefined,
							onProgress: (progress) => {
								progressMap.set(index, structuredClone(progress));
								emitProgress();
							},
							authStorage: session.authStorage,
							modelRegistry: session.modelRegistry,
							settingsManager: session.settingsManager,
							mcpManager: session.mcpManager,
						});
					},
					signal,
				);

				// Fill in skipped tasks (undefined entries from abort) with placeholder results
				const results: SingleResult[] = partialResults.map((result, index) => {
					if (result !== undefined) return result;
					const task = tasksWithContext[index];
					return {
						index,
						taskId: task.taskId,
						agent: agentName,
						agentSource: agent.source,
						task: task.task,
						description: task.description,
						exitCode: 1,
						output: "",
						stderr: "Skipped (cancelled before start)",
						truncated: false,
						durationMs: 0,
						tokens: 0,
						modelOverride,
						error: "Skipped",
						aborted: true,
					};
				});

				// Aggregate usage from executor results (already accumulated incrementally)
				const aggregatedUsage = createUsageTotals();
				let hasAggregatedUsage = false;
				for (const result of results) {
					if (result.usage) {
						addUsageTotals(aggregatedUsage, result.usage);
						hasAggregatedUsage = true;
					}
				}

				// Collect output paths (artifacts already written by executor in real-time)
				const outputPaths: string[] = [];
				for (const result of results) {
					if (result.artifactPaths) {
						outputPaths.push(result.artifactPaths.outputPath);
					}
				}

				// Build final output - match plugin format
				const successCount = results.filter((r) => r.exitCode === 0).length;
				const cancelledCount = results.filter((r) => r.aborted).length;
				const totalDuration = Date.now() - startTime;

				const summaries = results.map((r) => {
					const status = r.aborted ? "cancelled" : r.exitCode === 0 ? "completed" : `failed (exit ${r.exitCode})`;
					const output = r.output.trim() || r.stderr.trim() || "(no output)";
					const preview = output.split("\n").slice(0, 5).join("\n");
					const meta = r.outputMeta
						? ` [${r.outputMeta.lineCount} lines, ${formatBytes(r.outputMeta.charCount)}]`
						: "";
					return `[${r.agent}] ${status}${meta} ${r.taskId}\n${preview}`;
				});

				const outputIds = results.filter((r) => !r.aborted || r.output.trim()).map((r) => r.taskId);
				const outputHint =
					outputIds.length > 0 ? `\n\nUse output tool for full logs: output ids ${outputIds.join(", ")}` : "";
				const schemaNote = schemaOverridden
					? `\n\nNote: Agent '${agentName}' has a fixed output schema; your 'output' parameter was ignored.\nRequired schema: ${JSON.stringify(agent.output)}`
					: "";
				const cancelledNote = aborted && cancelledCount > 0 ? ` (${cancelledCount} cancelled)` : "";
				const summary = `${successCount}/${results.length} succeeded${cancelledNote} [${formatDuration(
					totalDuration,
				)}]\n\n${summaries.join("\n\n---\n\n")}${outputHint}${schemaNote}`;

				// Cleanup temp directory if used
				if (tempArtifactsDir) {
					await cleanupTempDir(tempArtifactsDir);
				}

				return {
					content: [{ type: "text", text: summary }],
					details: {
						projectAgentsDir,
						results: results,
						totalDurationMs: totalDuration,
						usage: hasAggregatedUsage ? aggregatedUsage : undefined,
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

// Default task tool - returns a placeholder tool
// Real implementations should use createTaskTool(session) to initialize the tool
export const taskTool: AgentTool<typeof taskSchema, TaskToolDetails, Theme> = {
	name: "task",
	label: "Task",
	description: "Launch a new agent to handle complex, multi-step tasks autonomously.",
	parameters: taskSchema,
	execute: async () => ({
		content: [{ type: "text", text: "Task tool not properly initialized. Use createTaskTool(session) instead." }],
		details: {
			projectAgentsDir: null,
			results: [],
			totalDurationMs: 0,
		},
	}),
};
