/**
 * Task tool - Delegate tasks to specialized agents.
 *
 * Discovers agent definitions from:
 *   - Bundled agents (shipped with pi-coding-agent)
 *   - ~/.pi/agent/agents/*.md (user-level)
 *   - .pi/agents/*.md (project-level)
 *
 * Supports:
 *   - Single agent execution
 *   - Parallel execution with concurrency limits
 *   - Progress tracking via JSON events
 *   - Session artifacts for debugging
 */

import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import type { Theme } from "../../../modes/interactive/theme/theme.js";
import { cleanupTempDir, createTempArtifactsDir, getArtifactsDir, writeArtifacts } from "./artifacts.js";
import { discoverAgents, getAgent } from "./discovery.js";
import { runSubprocess } from "./executor.js";
import { mapWithConcurrencyLimit } from "./parallel.js";
import { renderCall, renderResult } from "./render.js";
import {
	type AgentProgress,
	type AgentScope,
	MAX_AGENTS_IN_DESCRIPTION,
	MAX_CONCURRENCY,
	MAX_PARALLEL_TASKS,
	PI_NO_SUBAGENTS_ENV,
	type SingleResult,
	type TaskToolDetails,
	taskSchema,
} from "./types.js";

/** Session context interface */
interface SessionContext {
	getSessionFile: () => string | null;
}

// Re-export types and utilities
export { loadBundledAgents as BUNDLED_AGENTS } from "./agents.js";
export { discoverCommands, expandCommand, getCommand } from "./commands.js";
export { discoverAgents, getAgent } from "./discovery.js";
export type { AgentDefinition, AgentProgress, AgentScope, SingleResult, TaskParams, TaskToolDetails } from "./types.js";
export { taskSchema } from "./types.js";

/**
 * Build dynamic tool description listing available agents.
 */
function buildDescription(cwd: string): string {
	const { agents, projectAgentsDir } = discoverAgents(cwd, "both");

	// Group agents by source
	const bundled = agents.filter((a) => a.source === "bundled");
	const user = agents.filter((a) => a.source === "user");
	const project = agents.filter((a) => a.source === "project");

	const lines: string[] = ["Spawn a sub-agent to handle complex tasks. Each agent runs in an isolated context.", ""];

	// Bundled agents
	if (bundled.length > 0) {
		lines.push("**Bundled agents:**");
		for (const agent of bundled.slice(0, MAX_AGENTS_IN_DESCRIPTION)) {
			const tools = agent.tools ? ` (${agent.tools.join(", ")})` : "";
			lines.push(`- \`${agent.name}\`: ${agent.description}${tools}`);
		}
		lines.push("");
	}

	// User agents
	if (user.length > 0) {
		lines.push("**User agents (~/.pi/agent/agents/):**");
		for (const agent of user.slice(0, MAX_AGENTS_IN_DESCRIPTION)) {
			lines.push(`- \`${agent.name}\`: ${agent.description}`);
		}
		if (user.length > MAX_AGENTS_IN_DESCRIPTION) {
			lines.push(`- ... and ${user.length - MAX_AGENTS_IN_DESCRIPTION} more`);
		}
		lines.push("");
	}

	// Project agents
	if (project.length > 0) {
		const dir = projectAgentsDir || ".pi/agents/";
		lines.push(`**Project agents (${dir}):**`);
		for (const agent of project.slice(0, MAX_AGENTS_IN_DESCRIPTION)) {
			lines.push(`- \`${agent.name}\`: ${agent.description}`);
		}
		if (project.length > MAX_AGENTS_IN_DESCRIPTION) {
			lines.push(`- ... and ${project.length - MAX_AGENTS_IN_DESCRIPTION} more`);
		}
		lines.push("");
	}

	// Usage
	lines.push("**Usage:**");
	lines.push("- Single: `{ agent: 'explore', prompt: 'find auth code' }`");
	lines.push("- Parallel: `{ tasks: [{ agent: 'explore', task: '...' }, ...] }`");
	lines.push("- With context: `{ context: 'shared info', tasks: [...] }`");
	lines.push("");
	lines.push("**When NOT to use:** For simple file reads, use Read directly.");

	return lines.join("\n");
}

/**
 * Create the task tool configured for a specific working directory.
 */
export function createTaskTool(
	cwd: string,
	sessionContext?: SessionContext,
): AgentTool<typeof taskSchema, TaskToolDetails, Theme> {
	// Check if subagents are inhibited (recursion prevention)
	if (process.env[PI_NO_SUBAGENTS_ENV]) {
		return {
			name: "task",
			label: "Task",
			description: "Sub-agents disabled (recursion prevention)",
			parameters: taskSchema,
			execute: async () => ({
				content: [{ type: "text", text: "Sub-agents are disabled for this agent (recursion prevention)." }],
				details: {
					mode: "single",
					agentScope: "both",
					projectAgentsDir: null,
					results: [],
					totalDurationMs: 0,
				},
			}),
		};
	}

	return {
		name: "task",
		label: "Task",
		description: buildDescription(cwd),
		parameters: taskSchema,
		renderCall,
		renderResult,
		execute: async (_toolCallId, params, signal, onUpdate) => {
			const startTime = Date.now();
			const agentScope: AgentScope = (params.agentScope as AgentScope) || "both";
			const { agents, projectAgentsDir } = discoverAgents(cwd, agentScope);

			// Derive artifacts directory
			const sessionFile = sessionContext?.getSessionFile() ?? null;
			const artifactsDir = sessionFile ? getArtifactsDir(sessionFile) : null;
			const tempArtifactsDir = artifactsDir ? null : createTempArtifactsDir();
			const effectiveArtifactsDir = artifactsDir || tempArtifactsDir!;

			// Determine mode
			const isParallel = params.tasks && params.tasks.length > 0;

			// Initialize progress tracking
			const progressMap = new Map<number, AgentProgress>();

			// Update callback
			const emitProgress = () => {
				const progress = Array.from(progressMap.values()).sort((a, b) => a.index - b.index);
				onUpdate?.({
					content: [{ type: "text", text: "Running..." }],
					details: {
						mode: isParallel ? "parallel" : "single",
						agentScope,
						projectAgentsDir,
						results: [],
						totalDurationMs: Date.now() - startTime,
						progress,
					},
				});
			};

			try {
				let results: SingleResult[];

				if (isParallel) {
					// Parallel mode
					const tasks = params.tasks!;

					// Validate task count
					if (tasks.length > MAX_PARALLEL_TASKS) {
						return {
							content: [
								{
									type: "text",
									text: `Error: Maximum ${MAX_PARALLEL_TASKS} tasks allowed, got ${tasks.length}`,
								},
							],
							details: {
								mode: "parallel",
								agentScope,
								projectAgentsDir,
								results: [],
								totalDurationMs: Date.now() - startTime,
							},
						};
					}

					// Validate all agents exist
					for (const task of tasks) {
						if (!getAgent(agents, task.agent)) {
							const available = agents.map((a) => a.name).join(", ");
							return {
								content: [{ type: "text", text: `Unknown agent: ${task.agent}. Available: ${available}` }],
								details: {
									mode: "parallel",
									agentScope,
									projectAgentsDir,
									results: [],
									totalDurationMs: Date.now() - startTime,
								},
							};
						}
					}

					// Initialize progress for all tasks
					for (let i = 0; i < tasks.length; i++) {
						progressMap.set(i, {
							index: i,
							agent: tasks[i].agent,
							agentSource: getAgent(agents, tasks[i].agent)!.source,
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

					// Execute in parallel with concurrency limit
					results = await mapWithConcurrencyLimit(tasks, MAX_CONCURRENCY, async (task, index) => {
						const agent = getAgent(agents, task.agent)!;
						return runSubprocess({
							cwd,
							agent,
							task: task.task,
							index,
							context: params.context,
							modelOverride: task.model,
							sessionFile,
							persistArtifacts: !!artifactsDir,
							artifactsDir: effectiveArtifactsDir,
							signal,
							onProgress: (progress) => {
								progressMap.set(index, progress);
								emitProgress();
							},
						});
					});
				} else {
					// Single mode
					const agentName = params.agent || "task";
					const agent = getAgent(agents, agentName);

					if (!agent) {
						const available = agents.map((a) => a.name).join(", ");
						return {
							content: [{ type: "text", text: `Unknown agent: ${agentName}. Available: ${available}` }],
							details: {
								mode: "single",
								agentScope,
								projectAgentsDir,
								results: [],
								totalDurationMs: Date.now() - startTime,
							},
						};
					}

					if (!params.prompt) {
						return {
							content: [{ type: "text", text: "Error: 'prompt' is required for single agent mode" }],
							details: {
								mode: "single",
								agentScope,
								projectAgentsDir,
								results: [],
								totalDurationMs: Date.now() - startTime,
							},
						};
					}

					// Initialize progress
					progressMap.set(0, {
						index: 0,
						agent: agentName,
						agentSource: agent.source,
						status: "pending",
						task: params.prompt,
						recentTools: [],
						recentOutput: [],
						toolCount: 0,
						tokens: 0,
						durationMs: 0,
						modelOverride: params.model,
					});
					emitProgress();

					const result = await runSubprocess({
						cwd,
						agent,
						task: params.prompt,
						index: 0,
						context: params.context,
						modelOverride: params.model,
						sessionFile,
						persistArtifacts: !!artifactsDir,
						artifactsDir: effectiveArtifactsDir,
						signal,
						onProgress: (progress) => {
							progressMap.set(0, progress);
							emitProgress();
						},
					});

					results = [result];
				}

				// Write artifacts
				const outputPaths: string[] = [];
				for (const result of results) {
					const fullTask = params.context ? `${params.context}\n\n${result.task}` : result.task;
					const paths = await writeArtifacts(
						effectiveArtifactsDir,
						result.agent,
						result.index,
						fullTask,
						result.output,
						result.jsonlEvents,
					);
					outputPaths.push(paths.outputPath);
					result.artifactPaths = paths;
				}

				// Build final output
				const successCount = results.filter((r) => r.exitCode === 0).length;
				const failCount = results.length - successCount;

				let summary: string;
				if (results.length === 1) {
					const r = results[0];
					summary = r.exitCode === 0 ? r.output : `Error: ${r.error || r.stderr || "Unknown error"}`;
				} else {
					summary = `Completed ${successCount}/${results.length} tasks`;
					if (failCount > 0) {
						summary += ` (${failCount} failed)`;
					}
					summary += "\n\n";
					for (const r of results) {
						const status = r.exitCode === 0 ? "✓" : "✗";
						summary += `${status} ${r.agent}: ${r.output.split("\n")[0] || "(no output)"}\n`;
					}
				}

				// Cleanup temp directory if used
				if (tempArtifactsDir) {
					await cleanupTempDir(tempArtifactsDir);
				}

				return {
					content: [{ type: "text", text: summary }],
					details: {
						mode: isParallel ? "parallel" : "single",
						agentScope,
						projectAgentsDir,
						results,
						totalDurationMs: Date.now() - startTime,
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
						mode: isParallel ? "parallel" : "single",
						agentScope,
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
