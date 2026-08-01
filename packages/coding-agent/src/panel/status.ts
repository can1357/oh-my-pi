import type { AgentProgress } from "../task/types";
import type { PanelRunResult } from "./runtime";

/** Render a compact live status line from the latest progress of every panel member. */
export function formatPanelProgress(
	memberCount: number,
	progress: ReadonlyMap<string, Pick<AgentProgress, "status">>,
): string {
	let completed = 0;
	let failed = 0;
	let aborted = 0;
	let running = 0;
	let pending = Math.max(0, memberCount - progress.size);
	for (const { status } of progress.values()) {
		if (status === "completed") completed += 1;
		else if (status === "failed") failed += 1;
		else if (status === "aborted") aborted += 1;
		else if (status === "running") running += 1;
		else pending += 1;
	}
	return `Panel: ${completed} completed, ${failed} failed, ${aborted} aborted, ${running} running, ${pending} pending.`;
}

/** Summary line shared by text and TUI panel command completions. */
export function formatPanelCompletionStatus(result: PanelRunResult): string {
	let completed = 0;
	let failed = 0;
	let aborted = 0;
	for (const panelist of result.results) {
		if (panelist.status === "completed") completed += 1;
		else if (panelist.status === "failed") failed += 1;
		else aborted += 1;
	}
	const { tokens, requests, cost } = result.usage;
	return `Panel: ${completed} completed, ${failed} failed, ${aborted} aborted. Usage: ${tokens.toLocaleString()} tokens, ${requests.toLocaleString()} request${requests === 1 ? "" : "s"}, $${cost.toFixed(4)}.`;
}
