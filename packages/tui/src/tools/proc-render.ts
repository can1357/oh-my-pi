import type { Component } from "../tui";
import { Ellipsis, renderStatusLine, renderTreeList, truncateToWidth } from "../render";
import {
	cappedHeadLines,
	formatBadge,
	formatDuration,
	formatErrorDetail,
	formatMoreItems,
	formatStatusIcon,
	PREVIEW_LIMITS,
	TRUNCATE_LENGTHS,
	type ToolUIColor,
} from "../render/render-utils";
import type { Theme } from "../theme/theme";
import type { RenderResultOptions } from "./renderer";
import type {
	AgentActivitySnapshot,
	CoordinationDetails,
	JobRetuneOutcome,
	JobRetuneStatus,
	JobSnapshot,
} from "./wait";
import type { IrcDeliveryReceipt } from "./irc";
import { displayDaemonExitReason, type DaemonMonitorWatcher, type DaemonSnapshot } from "./daemon";
import { styleTerminalRow } from "./terminal-output";
import { card, type CardToolResult as ToolResult, firstText, safe } from "./result-card";

export interface ProcReadDetails {
	jobs?: JobSnapshot[];
	agents?: AgentActivitySnapshot[];
	daemons?: DaemonSnapshot[];
	job?: JobSnapshot;
	daemon?: DaemonSnapshot;
	/** Live output monitors; absent when the broker predates watcher reporting. */
	monitors?: DaemonMonitorWatcher[];
	log?: string;
	terminalRows?: string[];
}

export type ProcWriteDetails =
	| CoordinationDetails
	| {
			action: "stop" | "stdin" | "mode" | "progress";
			daemon: DaemonSnapshot;
			input?: string;
			mode?: string;
			/** `progress`: monitor delivery mode this write resulted in. */
			progress?: "wake" | "ambient" | "off";
			/** `progress` off: whether an active monitor was actually detached. */
			detached?: boolean;
	  };

/** Process operation selected by a write URL, independent of its content. */
export type ProcWriteAction = "stdin" | "mode" | "kill" | "progress";

function preview(body: string, expanded: boolean, theme: Theme, tone: "dim" | "toolOutput" = "dim"): string[] {
	if (!body.trim()) return [];
	const limit = expanded ? PREVIEW_LIMITS.EXPANDED_LINES : PREVIEW_LIMITS.COLLAPSED_LINES;
	const shown = cappedHeadLines(
		body.split("\n").filter(line => line.trim()),
		limit,
	);
	const quote = theme.fg("dim", theme.md.quoteBorder);
	const lines = shown.lines.map(
		line =>
			`  ${quote} ${theme.fg(tone, truncateToWidth(safe(line.trim()), TRUNCATE_LENGTHS.LINE, Ellipsis.Unicode))}`,
	);
	if (shown.hidden) lines.push(`  ${quote} ${theme.fg("dim", `… +${shown.hidden} more lines`)}`);
	return lines;
}

function receiptColor(outcome: IrcDeliveryReceipt["outcome"]): ToolUIColor {
	return outcome === "failed" ? "error" : outcome === "revived" ? "warning" : "success";
}

export function renderAgentWrite(
	to: string,
	body: string,
	result: ToolResult | undefined,
	details: CoordinationDetails | undefined,
	options: RenderResultOptions,
	theme: Theme,
): Component {
	return card((width, expanded) => {
		const recipient = safe(details?.to || to || "…");
		const title = `IRC ${theme.nav.selected} ${recipient}`;
		const receipts = details?.receipts ?? [];
		const delivered = receipts.filter(receipt => receipt.outcome !== "failed").length;
		const failed = receipts.length - delivered;
		const error = result?.isError || (failed > 0 && delivered === 0);
		const meta: string[] = [];
		if (recipient === "all") meta.push("broadcast");
		if (receipts.length === 1) meta.push(theme.fg(receiptColor(receipts[0]!.outcome), receipts[0]!.outcome));
		else if (receipts.length > 1) {
			if (delivered) meta.push(theme.fg("success", `${delivered} delivered`));
			if (failed) meta.push(theme.fg("error", `${failed} failed`));
		}
		const header = renderStatusLine(
			result === undefined
				? { icon: "pending", title, meta }
				: error
					? { icon: "error", title, meta }
					: { iconOverride: theme.styledSymbol("tool.irc", "accent"), title, meta },
			theme,
		);
		if (result?.isError && receipts.length === 0)
			return [header, formatErrorDetail(firstText(result) || "Message delivery failed.", theme)];
		const lines = [header, ...preview(body, expanded, theme)];
		if (result && receipts.length === 0)
			lines.push(theme.fg("muted", firstText(result) || "No live peers to broadcast to."));
		if (receipts.length > 1 || failed > 0) {
			lines.push(
				...renderTreeList(
					{
						items: receipts,
						expanded,
						maxCollapsed: PREVIEW_LIMITS.COLLAPSED_ITEMS,
						itemType: "recipient",
						renderItem: receipt =>
							`${theme.fg("toolOutput", safe(receipt.to))} ${formatBadge(receipt.outcome, receiptColor(receipt.outcome), theme)}${receipt.error ? ` ${theme.fg("error", `${theme.format.dash} ${safe(receipt.error)}`)}` : ""}`,
					},
					theme,
				),
			);
		}
		return lines.map(line => truncateToWidth(line, width, Ellipsis.Unicode));
	}, options);
}

function daemonMeta(daemon: DaemonSnapshot, theme: Theme): string[] {
	const stateColor =
		daemon.state === "ready" || daemon.state === "running"
			? "success"
			: daemon.state === "failed"
				? "error"
				: "warning";
	const meta = [theme.fg(stateColor, daemon.state)];
	if (daemon.pid !== undefined) meta.push(`pid ${daemon.pid}`);
	if (daemon.exitCode !== undefined) meta.push(`exit ${daemon.exitCode}`);
	meta.push(
		`${daemon.exitedAt === undefined ? "up" : "ran"} ${formatDuration(Math.max(0, (daemon.exitedAt ?? Date.now()) - daemon.startedAt))}`,
	);
	if (daemon.detached) meta.push("detached");
	else if (daemon.persist) meta.push("persistent");
	return meta;
}

/** Keep runtime diagnostics visible independently of terminal output or lifecycle state. */
function daemonReasonLine(daemon: DaemonSnapshot, theme: Theme): string | undefined {
	const reason = displayDaemonExitReason(daemon.exitReason);
	return reason ? theme.fg("error", `Reason: ${truncateToWidth(reason, TRUNCATE_LENGTHS.LINE)}`) : undefined;
}

/** Indented `↳ watched by owner · mode · age · state` row under a service line; owner ids are sanitized like any display text. */
function watcherRow(watcher: DaemonMonitorWatcher, daemon: DaemonSnapshot, theme: Theme): string {
	const owner = truncateToWidth(safe(watcher.owner), TRUNCATE_LENGTHS.TITLE);
	const facts = [theme.fg("accent", watcher.delivery ?? "unknown mode")];
	if (watcher.since !== undefined) facts.push(`${formatDuration(Math.max(0, Date.now() - watcher.since))} ago`);
	if (!watcher.connected) facts.push(theme.fg("warning", "disconnected"));
	if (watcher.daemonId === undefined) facts.push(theme.fg("muted", "awaiting start"));
	else if (watcher.daemonId !== daemon.id) facts.push(theme.fg("warning", "previous incarnation"));
	return `  ${theme.fg("dim", "↳ watched by")} ${owner} ${theme.fg("dim", facts.join(theme.sep.dot))}`;
}

const RETUNE_WARNING_STATUS: Record<JobRetuneStatus, boolean> = {
	retuned: false,
	unchanged: false,
	not_found: true,
	not_running: true,
	unmonitored: true,
	suppressed: true,
};

/**
 * Compact per-id retune row. The model-facing explanation of each status lives
 * in the write result text; duplicating those sentences here would put two
 * copies of the same copy in two packages and blow past a feed row's width.
 */
function jobRetuneRow(outcome: JobRetuneOutcome, theme: Theme): string {
	const id = safe(outcome.id);
	const mode = outcome.progress ? safe(outcome.progress) : "?";
	const text = (() => {
		switch (outcome.status) {
			case "retuned":
				return `${id} → ${mode}`;
			case "unchanged":
				return `${id} already ${mode}`;
			case "not_found":
				return `${id} not your job`;
			case "not_running":
				return `${id} already settled`;
			case "unmonitored":
				return `${id} launched without progress`;
			case "suppressed":
				return `${id} withheld by a wait`;
		}
	})();
	return theme.fg(
		RETUNE_WARNING_STATUS[outcome.status] ? "warning" : outcome.status === "retuned" ? "success" : "accent",
		text,
	);
}

function jobRow(job: JobSnapshot, theme: Theme): string {
	const icon = formatStatusIcon(
		job.status === "cancelled"
			? "aborted"
			: job.status === "failed"
				? "error"
				: job.status === "running"
					? "running"
					: "done",
		theme,
	);
	const progress = job.progress ? ` ${formatBadge(safe(job.progress), "accent", theme)}` : "";
	return `${icon} ${formatBadge(job.type, job.status === "failed" ? "error" : job.status === "cancelled" ? "warning" : "accent", theme)} ${theme.fg("toolOutput", safe(job.id))}${progress} ${theme.fg("dim", safe(job.label))} ${theme.fg("dim", formatDuration(job.durationMs))}`;
}

/** Render live and completed process writes with the URL-selected operation. */
export function renderProcWrite(
	id: string,
	action: ProcWriteAction,
	content: string | undefined,
	result: ToolResult | undefined,
	details: ProcWriteDetails | undefined,
	options: RenderResultOptions,
	theme: Theme,
): Component {
	return card((_width, expanded) => {
		const title = `Proc ${action} ${safe(id || "…")}`;
		const daemon = details && "daemon" in details ? details.daemon : undefined;
		const reason = daemon ? daemonReasonLine(daemon, theme) : undefined;
		const retuned = details && "op" in details && details.op === "monitor" ? (details.retuned ?? []) : [];
		const meta = daemon
			? daemonMeta(daemon, theme)
			: (action === "mode" || action === "progress") && content
				? [safe(content)]
				: [];
		if (daemon && details && "action" in details && details.action === "progress") {
			// wake/ambient/off/no-op must be distinguishable at a glance; details carry the authoritative state.
			meta.unshift(
				details.progress === "off"
					? theme.fg("muted", details.detached === false ? "no active monitor" : "monitor off")
					: theme.fg("accent", `monitor ${safe(details.progress ?? content ?? "")}`),
			);
		}
		const header = renderStatusLine(
			{
				icon:
					result === undefined
						? "pending"
						: result.isError ||
							  daemon?.state === "failed" ||
							  (daemon?.exitCode !== undefined && daemon.exitCode !== 0)
							? retuned.length > 0
								? "warning"
								: "error"
							: action === "kill"
								? "aborted"
								: "success",
				title,
				meta,
			},
			theme,
		);
		if (retuned.length > 0) return [header, ...retuned.map(outcome => jobRetuneRow(outcome, theme))];
		const lines = reason ? [header, reason] : [header];
		if (result?.isError)
			return [...lines, formatErrorDetail(firstText(result) || "Process operation failed.", theme)];
		if (content && action === "stdin") lines.push(...preview(content, expanded, theme));
		if (details && "op" in details && details.op === "cancel") {
			const jobs = details.jobs ?? [];
			const outcomes = details.cancelled ?? [];
			lines.push(
				...renderTreeList(
					{
						items: outcomes,
						expanded,
						maxCollapsed: PREVIEW_LIMITS.COLLAPSED_ITEMS,
						itemType: "job",
						renderItem: outcome => {
							const job = jobs.find(item => item.id === outcome.id);
							return `${job ? `${jobRow(job, theme)} ` : `${theme.fg("toolOutput", safe(outcome.id))} `}${formatBadge(outcome.status, outcome.status === "cancelled" ? "warning" : "error", theme)}`;
						},
					},
					theme,
				),
			);
		}
		return lines;
	}, options);
}

export function renderProcRead(
	id: string,
	result: ToolResult | undefined,
	details: ProcReadDetails | undefined,
	options: RenderResultOptions,
	theme: Theme,
): Component {
	return card((_width, expanded) => {
		const title = id ? `Proc ${safe(id)}` : "Proc jobs & services";
		const daemon = details?.daemon;
		const reason = daemon ? daemonReasonLine(daemon, theme) : undefined;
		const header = renderStatusLine(
			{
				icon:
					result === undefined
						? "pending"
						: result.isError ||
							  daemon?.state === "failed" ||
							  (daemon?.exitCode !== undefined && daemon.exitCode !== 0)
							? "error"
							: "info",
				title,
				meta: daemon ? daemonMeta(daemon, theme) : [],
			},
			theme,
		);
		if (result?.isError) {
			return [
				header,
				...(reason ? [reason] : []),
				formatErrorDetail(firstText(result) || "Process read failed.", theme),
			];
		}
		if (!result) return [header];
		if (details?.job)
			return [
				header,
				jobRow(details.job, theme),
				...preview(
					details.log ?? details.job.errorText ?? details.job.resultText ?? "",
					expanded,
					theme,
					"toolOutput",
				),
			];
		if (daemon) {
			const output = details.terminalRows ?? (details.log ?? "").split("\n").filter(Boolean);
			const limit = expanded ? PREVIEW_LIMITS.EXPANDED_LINES : PREVIEW_LIMITS.COLLAPSED_LINES;
			const visible = output
				.slice(-limit)
				.map(
					line =>
						`  ${styleTerminalRow(truncateToWidth(safe(line), TRUNCATE_LENGTHS.LINE, Ellipsis.Unicode), theme.fg("toolOutput", ""))}`,
				);
			if (output.length > limit) visible.unshift(theme.fg("dim", `  … ${output.length - limit} earlier lines`));
			const watchers = details.monitors?.map(watcher => watcherRow(watcher, daemon, theme)) ?? [];
			return [header, ...(reason ? [reason] : []), ...watchers, ...visible];
		}
		if (id && !details?.jobs && !details?.daemons && !details?.agents) {
			return [header, ...preview(firstText(result), expanded, theme, "toolOutput")];
		}
		const jobs = details?.jobs ?? [];
		const services = details?.daemons ?? [];
		const agents = details?.agents ?? [];
		const meta = [
			`${jobs.length} jobs`,
			`${services.length} services`,
			...(agents.length ? [`${agents.length} agents`] : []),
		];
		const listHeader = renderStatusLine({ icon: "info", title, meta }, theme);
		const items: Array<{ label: string | string[] }> = [
			...jobs.map(job => ({ label: jobRow(job, theme) })),
			...services.map(service => {
				const reason = daemonReasonLine(service, theme);
				const watchers = (details?.monitors ?? []).filter(watcher => watcher.name === service.name);
				const shownWatchers = expanded ? watchers : watchers.slice(0, PREVIEW_LIMITS.COLLAPSED_LINES);
				return {
					label: [
						`${formatBadge("service", "accent", theme)} ${theme.fg("toolOutput", safe(service.name))} ${formatBadge(service.state, service.state === "failed" ? "error" : service.state === "ready" || service.state === "running" ? "success" : "warning", theme)} ${daemonMeta(service, theme).slice(1).join(theme.sep.dot)}`,
						...(reason ? [reason] : []),
						...shownWatchers.map(watcher => watcherRow(watcher, service, theme)),
						...(watchers.length > shownWatchers.length
							? [theme.fg("dim", `  ${formatMoreItems(watchers.length - shownWatchers.length, "watcher")}`)]
							: []),
					],
				};
			}),
			...agents.map(agent => ({
				label: `${formatBadge("agent", agent.live ? "accent" : "warning", theme)} ${theme.fg("toolOutput", safe(agent.id))} ${theme.fg("dim", formatDuration(agent.ageMs))}`,
			})),
		];
		return [
			listHeader,
			...renderTreeList(
				{
					items,
					expanded,
					maxCollapsed: PREVIEW_LIMITS.COLLAPSED_ITEMS,
					maxCollapsedLines: PREVIEW_LIMITS.COLLAPSED_ITEMS * 2 + 1,
					itemType: "process",
					renderItem: item => item.label,
				},
				theme,
			),
			...(items.length ? [] : [theme.fg("dim", "No background jobs or services.")]),
		];
	}, options);
}
