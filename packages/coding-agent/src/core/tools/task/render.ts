/**
 * TUI rendering for task tool.
 *
 * Provides renderCall and renderResult functions for displaying
 * task execution in the terminal UI.
 */

import path from "node:path";
import type { Component } from "@oh-my-pi/pi-tui";
import { Text } from "@oh-my-pi/pi-tui";
import type { Theme } from "../../../modes/interactive/theme/theme.js";
import type { RenderResultOptions } from "../../custom-tools/types.js";
import type { AgentProgress, SingleResult, TaskParams, TaskToolDetails } from "./types.js";

/**
 * Format token count for display (e.g., 1.5k, 25k).
 */
function formatTokens(tokens: number): string {
	if (tokens >= 1000) {
		return `${(tokens / 1000).toFixed(1)}k`;
	}
	return String(tokens);
}

/**
 * Format duration for display.
 */
export function formatDuration(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
	return `${(ms / 60000).toFixed(1)}m`;
}

/**
 * Truncate text to max length with ellipsis.
 */
function truncate(text: string, maxLen: number): string {
	if (text.length <= maxLen) return text;
	return `${text.slice(0, maxLen - 3)}...`;
}

/**
 * Get status icon for agent state.
 */
function getStatusIcon(status: AgentProgress["status"]): string {
	switch (status) {
		case "pending":
			return "○";
		case "running":
			return "◐";
		case "completed":
			return "✓";
		case "failed":
			return "✗";
	}
}

/**
 * Render the tool call arguments.
 */
export function renderCall(args: TaskParams, theme: Theme): Component {
	const label = theme.fg("toolTitle", theme.bold("task"));

	if (args.tasks.length === 1) {
		// Single task - show agent and task preview
		const task = args.tasks[0];
		const taskPreview = truncate(task.task, 60);
		return new Text(`${label} ${theme.fg("accent", task.agent)}: ${theme.fg("muted", taskPreview)}`, 0, 0);
	}

	// Multiple tasks - show count and agent names
	const agents = args.tasks.map((t) => t.agent).join(", ");
	return new Text(`${label} ${theme.fg("muted", `${args.tasks.length} agents: ${truncate(agents, 50)}`)}`, 0, 0);
}

/**
 * Render streaming progress for a single agent.
 */
function renderAgentProgress(progress: AgentProgress, isLast: boolean, expanded: boolean, theme: Theme): string[] {
	const lines: string[] = [];
	const prefix = isLast ? "└─" : "├─";
	const continuePrefix = isLast ? "   " : "│  ";

	const icon = getStatusIcon(progress.status);
	const iconColor = progress.status === "completed" ? "success" : progress.status === "failed" ? "error" : "accent";

	// Main status line
	let statusLine = `${prefix} ${theme.fg(iconColor, icon)} ${theme.fg("accent", progress.agent)}`;

	if (progress.status === "running") {
		const taskPreview = truncate(progress.task, 40);
		statusLine += `: ${theme.fg("muted", taskPreview)}`;
		statusLine += ` · ${theme.fg("dim", `${progress.toolCount} tools`)}`;
		if (progress.tokens > 0) {
			statusLine += ` · ${theme.fg("dim", `${formatTokens(progress.tokens)} tokens`)}`;
		}
	} else if (progress.status === "completed") {
		statusLine += `: ${theme.fg("success", "done")}`;
		statusLine += ` · ${theme.fg("dim", `${progress.toolCount} tools`)}`;
		statusLine += ` · ${theme.fg("dim", `${formatTokens(progress.tokens)} tokens`)}`;
	} else if (progress.status === "failed") {
		statusLine += `: ${theme.fg("error", "failed")}`;
	}

	lines.push(statusLine);

	// Current tool (if running)
	if (progress.status === "running" && progress.currentTool) {
		let toolLine = `${continuePrefix}⎿ ${theme.fg("muted", progress.currentTool)}`;
		if (progress.currentToolArgs) {
			toolLine += `: ${theme.fg("dim", truncate(progress.currentToolArgs, 40))}`;
		}
		if (progress.currentToolStartMs) {
			const elapsed = Date.now() - progress.currentToolStartMs;
			if (elapsed > 5000) {
				toolLine += ` · ${theme.fg("warning", formatDuration(elapsed))}`;
			}
		}
		lines.push(toolLine);
	}

	// Expanded view: recent output and tools
	if (expanded && progress.status === "running") {
		// Recent output
		for (const line of progress.recentOutput.slice(0, 3)) {
			lines.push(`${continuePrefix}  ${theme.fg("dim", truncate(line, 60))}`);
		}
	}

	return lines;
}

/**
 * Render final result for a single agent.
 */
function renderAgentResult(result: SingleResult, isLast: boolean, expanded: boolean, theme: Theme): string[] {
	const lines: string[] = [];
	const prefix = isLast ? "└─" : "├─";
	const continuePrefix = isLast ? "   " : "│  ";

	const success = result.exitCode === 0;
	const icon = success ? "✓" : "✗";
	const iconColor = success ? "success" : "error";

	// Main status line
	let statusLine = `${prefix} ${theme.fg(iconColor, icon)} ${theme.fg("accent", result.agent)}`;
	statusLine += `: ${theme.fg(iconColor, success ? "done" : "failed")}`;
	statusLine += ` · ${theme.fg("dim", `${formatTokens(result.tokens)} tokens`)}`;
	statusLine += ` · ${theme.fg("dim", formatDuration(result.durationMs))}`;

	if (result.truncated) {
		statusLine += ` ${theme.fg("warning", "[truncated]")}`;
	}

	lines.push(statusLine);

	// Output preview
	const outputLines = result.output.split("\n").filter((l) => l.trim());
	const previewCount = expanded ? 8 : 3;

	for (const line of outputLines.slice(0, previewCount)) {
		lines.push(`${continuePrefix}${theme.fg("dim", truncate(line, 70))}`);
	}

	if (outputLines.length > previewCount) {
		lines.push(`${continuePrefix}${theme.fg("dim", `... ${outputLines.length - previewCount} more lines`)}`);
	}

	// Error message
	if (result.error && !success) {
		lines.push(`${continuePrefix}${theme.fg("error", truncate(result.error, 70))}`);
	}

	return lines;
}

/**
 * Render the tool result.
 */
export function renderResult(
	result: { content: Array<{ type: string; text?: string }>; details?: TaskToolDetails },
	options: RenderResultOptions,
	theme: Theme,
): Component {
	const { expanded, isPartial } = options;
	const details = result.details;

	if (!details) {
		// Fallback to simple text
		const text = result.content.find((c) => c.type === "text")?.text || "";
		return new Text(theme.fg("dim", truncate(text, 100)), 0, 0);
	}

	const lines: string[] = [];

	if (isPartial && details.progress) {
		// Streaming progress view
		details.progress.forEach((progress, i) => {
			const isLast = i === details.progress!.length - 1;
			lines.push(...renderAgentProgress(progress, isLast, expanded, theme));
		});
	} else if (details.results.length > 0) {
		// Final results view
		details.results.forEach((res, i) => {
			const isLast = i === details.results.length - 1;
			lines.push(...renderAgentResult(res, isLast, expanded, theme));
		});

		// Summary line
		const successCount = details.results.filter((r) => r.exitCode === 0).length;
		const failCount = details.results.length - successCount;
		let summary = `\n${theme.fg("dim", "Total:")} `;
		summary += theme.fg("success", `${successCount} succeeded`);
		if (failCount > 0) {
			summary += `, ${theme.fg("error", `${failCount} failed`)}`;
		}
		summary += ` · ${theme.fg("dim", formatDuration(details.totalDurationMs))}`;
		lines.push(summary);

		// Artifacts location
		if (details.outputPaths && details.outputPaths.length > 0) {
			const artifactsDir = path.dirname(details.outputPaths[0]);
			lines.push(`${theme.fg("dim", "Artifacts:")} ${theme.fg("muted", artifactsDir)}`);
		}
	}

	if (lines.length === 0) {
		return new Text(theme.fg("dim", "No results"), 0, 0);
	}

	return new Text(lines.join("\n"), 0, 0);
}
