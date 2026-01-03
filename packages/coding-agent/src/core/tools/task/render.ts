/**
 * TUI rendering for task tool.
 *
 * Provides renderCall and renderResult functions for displaying
 * task execution in the terminal UI.
 */

import path from "node:path";
import type { Component } from "@oh-my-pi/pi-tui";
import { Container, Text } from "@oh-my-pi/pi-tui";
import type { Theme } from "../../../modes/interactive/theme/theme";
import type { RenderResultOptions } from "../../custom-tools/types";
import type { ReportFindingDetails, SubmitReviewDetails } from "../review";
import { subprocessToolRegistry } from "./subprocess-tool-registry";
import type { AgentProgress, SingleResult, TaskParams, TaskToolDetails } from "./types";

/** Priority labels for review findings */
const PRIORITY_LABELS: Record<number, string> = {
	0: "P0",
	1: "P1",
	2: "P2",
	3: "P3",
};

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
		case "aborted":
			return "⊘";
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
	const iconColor =
		progress.status === "completed"
			? "success"
			: progress.status === "failed" || progress.status === "aborted"
				? "error"
				: "accent";

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
	} else if (progress.status === "aborted") {
		statusLine += `: ${theme.fg("error", "aborted")}`;
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

	// Render extracted tool data inline (e.g., review findings)
	if (progress.extractedToolData) {
		for (const [toolName, dataArray] of Object.entries(progress.extractedToolData)) {
			const handler = subprocessToolRegistry.getHandler(toolName);
			if (handler?.renderInline) {
				// Show last few items inline
				const recentData = (dataArray as unknown[]).slice(-3);
				for (const data of recentData) {
					const component = handler.renderInline(data, theme);
					if (component instanceof Text) {
						lines.push(`${continuePrefix}${component.getText()}`);
					}
				}
				if (dataArray.length > 3) {
					lines.push(`${continuePrefix}${theme.fg("dim", `... ${dataArray.length - 3} more`)}`);
				}
			}
		}
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
 * Render review result with combined verdict + findings in tree structure.
 */
function renderReviewResult(
	summary: SubmitReviewDetails,
	findings: ReportFindingDetails[],
	continuePrefix: string,
	expanded: boolean,
	theme: Theme,
): string[] {
	const lines: string[] = [];

	// Verdict line
	const verdictColor = summary.overall_correctness === "correct" ? "success" : "error";
	const verdictIcon = summary.overall_correctness === "correct" ? "✓" : "✗";
	lines.push(
		`${continuePrefix}${theme.fg(verdictColor, verdictIcon)} Patch is ${theme.fg(verdictColor, summary.overall_correctness)} ${theme.fg("dim", `(${(summary.confidence * 100).toFixed(0)}% confidence)`)}`,
	);

	// Explanation preview (first ~80 chars when collapsed, full when expanded)
	if (summary.explanation) {
		if (expanded) {
			// Full explanation, wrapped
			const explanationLines = summary.explanation.split("\n");
			for (const line of explanationLines) {
				lines.push(`${continuePrefix}${theme.fg("dim", line)}`);
			}
		} else {
			// Preview: first sentence or ~100 chars
			const preview = truncate(`${summary.explanation.split(/[.!?]/)[0]}.`, 100);
			lines.push(`${continuePrefix}${theme.fg("dim", preview)}`);
		}
	}

	// Findings in tree structure
	if (findings.length > 0) {
		lines.push(`${continuePrefix}`); // Spacing
		const displayCount = expanded ? findings.length : Math.min(3, findings.length);

		for (let i = 0; i < displayCount; i++) {
			const finding = findings[i];
			const isLastFinding = i === displayCount - 1 && (expanded || findings.length <= 3);
			const findingPrefix = isLastFinding ? "└─" : "├─";
			const findingContinue = isLastFinding ? "   " : "│  ";

			const priority = PRIORITY_LABELS[finding.priority] ?? "P?";
			const color = finding.priority === 0 ? "error" : finding.priority === 1 ? "warning" : "muted";
			const titleText = finding.title.replace(/^\[P\d\]\s*/, "");
			const loc = `${path.basename(finding.file_path)}:${finding.line_start}`;

			lines.push(
				`${continuePrefix}${findingPrefix} ${theme.fg(color, `[${priority}]`)} ${titleText} ${theme.fg("dim", loc)}`,
			);

			// Show body when expanded
			if (expanded && finding.body) {
				// Wrap body text
				const bodyLines = finding.body.split("\n");
				for (const bodyLine of bodyLines) {
					lines.push(`${continuePrefix}${findingContinue}${theme.fg("dim", bodyLine)}`);
				}
			}
		}

		if (!expanded && findings.length > 3) {
			lines.push(`${continuePrefix}${theme.fg("dim", `... ${findings.length - 3} more findings`)}`);
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

	const aborted = result.aborted ?? false;
	const success = !aborted && result.exitCode === 0;
	const icon = aborted ? "⊘" : success ? "✓" : "✗";
	const iconColor = success ? "success" : "error";
	const statusText = aborted ? "aborted" : success ? "done" : "failed";

	// Main status line
	let statusLine = `${prefix} ${theme.fg(iconColor, icon)} ${theme.fg("accent", result.agent)}`;
	statusLine += `: ${theme.fg(iconColor, statusText)}`;
	if (result.tokens > 0) {
		statusLine += ` · ${theme.fg("dim", `${formatTokens(result.tokens)} tokens`)}`;
	}
	statusLine += ` · ${theme.fg("dim", formatDuration(result.durationMs))}`;

	if (result.truncated) {
		statusLine += ` ${theme.fg("warning", "[truncated]")}`;
	}

	lines.push(statusLine);

	// Check for review result (submit_review + report_finding)
	const submitReviewData = result.extractedToolData?.submit_review as SubmitReviewDetails[] | undefined;
	const reportFindingData = result.extractedToolData?.report_finding as ReportFindingDetails[] | undefined;

	if (submitReviewData && submitReviewData.length > 0) {
		// Use combined review renderer
		const summary = submitReviewData[submitReviewData.length - 1];
		const findings = reportFindingData ?? [];
		lines.push(...renderReviewResult(summary, findings, continuePrefix, expanded, theme));
		return lines;
	}

	// Check for extracted tool data with custom renderers (skip review tools)
	let hasCustomRendering = false;
	if (result.extractedToolData) {
		for (const [toolName, dataArray] of Object.entries(result.extractedToolData)) {
			// Skip review tools - handled above
			if (toolName === "submit_review" || toolName === "report_finding") continue;

			const handler = subprocessToolRegistry.getHandler(toolName);
			if (handler?.renderFinal && (dataArray as unknown[]).length > 0) {
				hasCustomRendering = true;
				const component = handler.renderFinal(dataArray as unknown[], theme, expanded);
				if (component instanceof Text) {
					// Prefix each line with continuePrefix
					const text = component.getText();
					for (const line of text.split("\n")) {
						if (line.trim()) {
							lines.push(`${continuePrefix}${line}`);
						}
					}
				} else if (component instanceof Container) {
					// For containers, render each child
					for (const child of (component as Container).children) {
						if (child instanceof Text) {
							lines.push(`${continuePrefix}${child.getText()}`);
						}
					}
				}
			}
		}
	}

	// Fallback to output preview if no custom rendering
	if (!hasCustomRendering) {
		const outputLines = result.output.split("\n").filter((l) => l.trim());
		const previewCount = expanded ? 8 : 3;

		for (const line of outputLines.slice(0, previewCount)) {
			lines.push(`${continuePrefix}${theme.fg("dim", truncate(line, 70))}`);
		}

		if (outputLines.length > previewCount) {
			lines.push(`${continuePrefix}${theme.fg("dim", `... ${outputLines.length - previewCount} more lines`)}`);
		}
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
		const abortedCount = details.results.filter((r) => r.aborted).length;
		const successCount = details.results.filter((r) => !r.aborted && r.exitCode === 0).length;
		const failCount = details.results.length - successCount - abortedCount;
		let summary = `\n${theme.fg("dim", "Total:")} `;
		if (abortedCount > 0) {
			summary += theme.fg("error", `${abortedCount} aborted`);
			if (successCount > 0 || failCount > 0) summary += ", ";
		}
		if (successCount > 0) {
			summary += theme.fg("success", `${successCount} succeeded`);
			if (failCount > 0) summary += ", ";
		}
		if (failCount > 0) {
			summary += theme.fg("error", `${failCount} failed`);
		}
		summary += ` · ${theme.fg("dim", formatDuration(details.totalDurationMs))}`;
		lines.push(summary);

		// Artifacts suppressed from user view - available via session file
	}

	if (lines.length === 0) {
		return new Text(theme.fg("dim", "No results"), 0, 0);
	}

	return new Text(lines.join("\n"), 0, 0);
}
