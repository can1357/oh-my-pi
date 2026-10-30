/**
 * Model-facing `<task-result>` envelope for a settled subagent run.
 *
 * Rendered by the task tool for spawn results and by the IRC wake-turn relay
 * when a woken subagent re-yields, so a parent reads the same shape (status,
 * preview, `agent://` pointer) regardless of which path delivered it.
 */
import { prompt } from "@oh-my-pi/pi-utils";
import taskSummaryTemplate from "../prompts/tools/task-summary.md" with { type: "text" };
import { AgentRegistry, isResumable } from "../registry/agent-registry";
import { ASYNC_INLINE_RESULT_MAX_CHARS } from "../session/async-job-delivery";
import { escapeHarnessTags } from "../session/harness-tags";
import { formatBytes, formatDuration } from "@oh-my-pi/pi-tui/render/render-utils";
import type { SingleResult } from "@oh-my-pi/pi-tui/tools/task";

/**
 * Largest output inlined whole. A cut output costs the parent a
 * `read agent://<id>` turn plus the preview it then holds twice, which parents
 * pay for most outputs past ~8k chars. A background task result arrives as an
 * async follow-up, which cuts anything over {@link ASYNC_INLINE_RESULT_MAX_CHARS};
 * an envelope whose `<error>` or `<merge-summary>` would push it over falls back
 * to the preview instead.
 */
export const INLINE_OUTPUT_CHARS = ASYNC_INLINE_RESULT_MAX_CHARS - 500;
/** Head shown for an output over {@link INLINE_OUTPUT_CHARS}, with a pointer to `agent://<id>`. */
const PREVIEW_CHARS = 5000;

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
	const slice = output.slice(0, PREVIEW_CHARS);
	const lastNewline = slice.lastIndexOf("\n");
	return lastNewline >= PREVIEW_CHARS / 2 ? slice.slice(0, lastNewline) : slice;
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
	// <abort-reason>; an output that is empty or already opens with the error
	// (a missing-yield warning prefixed to the report) previews it itself.
	const streamed = result.output.trim();
	const error =
		result.exitCode !== 0 &&
		!result.aborted &&
		streamed.length > 0 &&
		result.error !== undefined &&
		!streamed.startsWith(result.error.trim())
			? result.error
			: undefined;
	const outputCharCount = result.outputMeta?.charCount ?? output.length;
	// A stopped agent stays messageable; tell the parent so it can resume via
	// irc instead of redoing the work. Isolated runs are parked without a
	// reviver (their worktree is gone), so they must not read as resumable.
	const resumable = result.aborted && !result.isolated && isResumable(AgentRegistry.global().get(result.id));
	const render = (truncated: boolean): string =>
		prompt.render(taskSummaryTemplate, {
			agentName: result.agent,
			id: result.id,
			status,
			missingYield: result.missingYield,
			duration: formatDuration(options.totalDurationMs),
			abortReason: result.aborted ? escapeHarnessTags(result.abortReason ?? "") || undefined : undefined,
			error: error === undefined ? undefined : escapeHarnessTags(error),
			resumable,
			preview: escapeHarnessTags(truncated ? previewHead(output) : output),
			truncated,
			meta: result.outputMeta
				? {
						lineCount: result.outputMeta.lineCount,
						charSize: formatBytes(result.outputMeta.charCount),
					}
				: undefined,
			mergeSummary: options.mergeSummary === undefined ? "" : escapeHarnessTags(options.mergeSummary),
		});
	if (result.outputPath === undefined) return render(false);
	if (outputCharCount > INLINE_OUTPUT_CHARS) return render(true);
	const whole = render(false);
	return whole.length > ASYNC_INLINE_RESULT_MAX_CHARS && outputCharCount > PREVIEW_CHARS ? render(true) : whole;
}
