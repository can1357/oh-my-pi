import { resolveUsedFraction, type UsageLimit, type UsageReport } from "@oh-my-pi/pi-ai";
import { formatDuration } from "@oh-my-pi/pi-utils";

import {
	ADVISOR_REVIEW_MODES,
	ADVISOR_SESSION_SCOPES,
	ADVISOR_SEVERITIES,
	ADVISOR_SYNC_BACKLOG_MODES,
	type AdvisorReviewMode,
	type AdvisorSessionScope,
	type AdvisorSeverity,
	type AdvisorSyncBacklog,
} from "./advisor-constants";

export {
	ADVISOR_REVIEW_MODES,
	ADVISOR_SESSION_SCOPES,
	ADVISOR_SEVERITIES,
	ADVISOR_SYNC_BACKLOG_MODES,
	type AdvisorReviewMode,
	type AdvisorSessionScope,
	type AdvisorSeverity,
	type AdvisorSyncBacklog,
};

/** One advisor declared in `WATCHDOG.yml`; its instructions specialize the shared baseline. */
export interface AdvisorConfig {
	name: string;
	/** Model selector with an optional `:level` thinking suffix, resolved like any other model override. */
	model?: string;
	/** Built-in tool names, including mutating tools; omitted uses read/grep/glob plus available recall, empty grants none. */
	tools?: string[];
	instructions?: string;
	/** Defaults to true; false retains the advisor in the roster and status displays without building its runtime. */
	enabled?: boolean;
	/** Maximum non-blocker notes per advisor prompt update (default 4); blockers are exempt. */
	maxNotesPerUpdate?: number;
	reviewMode?: AdvisorReviewMode;
	reviewInterval?: number;
	syncBacklog?: AdvisorSyncBacklog;
	/** Which session kinds this advisor attaches to (`main`, `subagent`, or `all`; defaults to `all`). */
	scope?: AdvisorSessionScope;
	/** Whether primary assistant thinking blocks are included in updates sent to this advisor (defaults to `true`). */
	includeReasoning?: boolean;
}

/** Which level a `WATCHDOG.yml` lives at: the project root or the user agent dir. */
export type AdvisorConfigScope = "project" | "user";

/** Editable raw contents of one `WATCHDOG.yml`, without cross-level merging or `@import` expansion, for exact round trips. */
export interface WatchdogConfigDoc {
	instructions?: string;
	maxNotesPerUpdate?: number;
	advisors: AdvisorConfig[];
	/** Per-entry problems found while loading (dropped entries). Shown when the file becomes active in the editor. */
	warnings?: string[];
}

/**
 * One-line provider quota display. The host supplies normalized usage reports
 * and an optional credential filter; the overlay owns only presentation.
 */
export function formatCompactQuota(
	provider: string,
	reports: UsageReport[],
	nowMs: number,
	includeLimit?: (report: UsageReport, limit: UsageLimit) => boolean,
): string | null {
	const byWindow = new Map<string, { limit: UsageLimit; fraction: number }>();
	for (const report of reports) {
		if (report.provider !== provider) continue;
		for (const limit of report.limits) {
			if (includeLimit && !includeLimit(report, limit)) continue;
			const fraction = resolveUsedFraction(limit);
			if (fraction === undefined) continue;
			const key = limit.window?.id ?? limit.scope.windowId ?? "—";
			const existing = byWindow.get(key);
			if (!existing || fraction > existing.fraction) byWindow.set(key, { limit, fraction });
		}
	}
	if (byWindow.size === 0) return null;
	const entries = [...byWindow.values()].sort((a, b) => b.fraction - a.fraction);
	const lines: string[] = [];
	for (const { limit, fraction } of entries) {
		const pct = Math.round(fraction * 100);
		const windowLabel = limit.window?.label ?? limit.scope.windowId ?? "—";
		const identity = limit.label.trim();
		const header = identity && identity !== windowLabel ? `${windowLabel} (${identity})` : windowLabel;
		const parts = [`${header}: ${pct}% used`];
		const window = limit.window;
		if (window?.resetsAt !== undefined && Number.isFinite(window.resetsAt) && window.resetsAt > nowMs) {
			parts.push(`${window.resetLabel ?? "resets"} in ${formatDuration(window.resetsAt - nowMs)}`);
		}
		lines.push(parts.join(" · "));
	}
	return `Quota: ${lines.join(" │ ")}`;
}
