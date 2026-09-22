/**
 * Model-facing `<task-result>` envelope for a settled subagent run.
 *
 * Rendered by the task tool for spawn results and by the IRC wake-turn relay
 * when a woken subagent re-yields, so a parent reads the same shape (status,
 * preview, `agent://` pointer) regardless of which path delivered it.
 */
import { prompt } from "@oh-my-pi/pi-utils";
import taskSummaryTemplate from "../prompts/tools/task-summary.md" with { type: "text" };
import { AgentRegistry } from "../registry/agent-registry";
import { formatBytes, formatDuration } from "@oh-my-pi/pi-tui/render/render-utils";
import type { SingleResult } from "@oh-my-pi/pi-tui/tools/task";

/** Inline preview budget before the envelope points at `agent://<id>` instead. */
const FULL_OUTPUT_THRESHOLD = 5000;

/**
 * Preview text for a child result. Falls back to "(no output)" — annotated
 * with the request count when the child actually did work, so the parent can
 * tell a no-op child from one that burned requests before being cancelled.
 */
export function formatResultOutputFallback(result: Pick<SingleResult, "output" | "stderr" | "requests">): string {
	const base = result.output.trim() || result.stderr.trim();
	if (base) return base;
	return result.requests > 0 ? `(no output) after ${result.requests} req` : "(no output)";
}

/**
 * Head of `output` that fits the inline budget. Prefers a line boundary so a
 * markdown preview does not end mid-row, but falls back to a hard cut when the
 * only boundary is near the start (pretty-printed JSON whose second line is
 * one huge string would otherwise preview as a lone `{`).
 */
function previewHead(output: string): string {
	const slice = output.slice(0, FULL_OUTPUT_THRESHOLD);
	const lastNewline = slice.lastIndexOf("\n");
	return lastNewline >= FULL_OUTPUT_THRESHOLD / 2 ? slice.slice(0, lastNewline) : slice;
}

/** Render the `<task-result>` envelope for a settled run. */
export function formatTaskResultSummary(
	result: SingleResult,
	options: { totalDurationMs: number; mergeSummary?: string },
): string {
	const status = result.aborted
		? "cancelled"
		: result.exitCode === 0 && result.error
			? "merge failed"
			: result.exitCode === 0
				? "completed"
				: `failed (exit ${result.exitCode})`;
	const output = formatResultOutputFallback(result);
	// The preview prefers `output` over `stderr`, so a run that failed after
	// streaming prose (provider stream error, missing yield) would otherwise
	// show only the half-written text and no reason. Aborts carry their own
	// <abort-reason>; an empty output already previews the error itself.
	const error = result.exitCode !== 0 && !result.aborted && result.output.trim().length > 0 ? result.error : undefined;
	const outputCharCount = result.outputMeta?.charCount ?? output.length;
	const truncated = outputCharCount > FULL_OUTPUT_THRESHOLD && result.outputPath !== undefined;
	const preview = truncated ? previewHead(output) : output;
	// A stopped-but-adopted agent (soft-budget stop) stays messageable; tell
	// the parent so it can resume via irc instead of redoing the work. Isolated
	// runs are parked without a reviver (their worktree is gone), so their
	// "parked" status must not read as resumable.
	const refStatus = AgentRegistry.global().get(result.id)?.status;
	const resumable = result.aborted && !result.isolated && (refStatus === "idle" || refStatus === "parked");
	return prompt.render(taskSummaryTemplate, {
		agentName: result.agent,
		id: result.id,
		status,
		duration: formatDuration(options.totalDurationMs),
		abortReason: result.aborted ? result.abortReason : undefined,
		error,
		resumable,
		preview,
		truncated,
		meta: result.outputMeta
			? {
					lineCount: result.outputMeta.lineCount,
					charSize: formatBytes(result.outputMeta.charCount),
				}
			: undefined,
		mergeSummary: options.mergeSummary ?? "",
	});
}
