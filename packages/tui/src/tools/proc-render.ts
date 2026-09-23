import type { Component } from "../tui";
import { createCachedComponent, Ellipsis, renderStatusLine, renderTreeList, truncateToWidth } from "../render";
import {
	cappedHeadLines,
	formatBadge,
	formatDuration,
	formatErrorDetail,
	formatStatusIcon,
	PREVIEW_LIMITS,
	TRUNCATE_LENGTHS,
	replaceTabs,
	type ToolUIColor,
} from "../render/render-utils";
import type { Theme } from "../theme/theme";
import type { RenderResultOptions } from "./renderer";
import type { AgentActivitySnapshot, CoordinationDetails, JobSnapshot } from "./wait";
import type { IrcDeliveryReceipt } from "./irc";
import type { DaemonSnapshot } from "./daemon";
import { styleTerminalRow } from "./terminal-output";

export interface ProcReadDetails {
	jobs?: JobSnapshot[];
	agents?: AgentActivitySnapshot[];
	daemons?: DaemonSnapshot[];
	job?: JobSnapshot;
	daemon?: DaemonSnapshot;
	log?: string;
	terminalRows?: string[];
}

export type ProcWriteDetails =
	| CoordinationDetails
	| { action: "stop" | "stdin" | "mode"; daemon: DaemonSnapshot; input?: string; mode?: string };

interface ToolResult {
	content: Array<{ type: string; text?: string }>;
	isError?: boolean;
}

function firstText(result: ToolResult): string {
	return result.content.find(item => item.type === "text")?.text ?? "";
}

function safe(value: string): string {
	return replaceTabs(value).replace(/\r/g, "");
}

function card(lines: (width: number, expanded: boolean) => string[], options: RenderResultOptions): Component {
	return createCachedComponent(
		() => Boolean(options.expanded),
		(width, expanded) =>
			lines(width, expanded)
				.flatMap(line => line.split("\n"))
				.map(line => truncateToWidth(safe(line), width, Ellipsis.Unicode)),
		{ paddingX: 1 },
	);
}

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
	meta.push(
		`${daemon.exitedAt === undefined ? "up" : "ran"} ${formatDuration(Math.max(0, (daemon.exitedAt ?? Date.now()) - daemon.startedAt))}`,
	);
	if (daemon.detached) meta.push("detached");
	else if (daemon.persist) meta.push("persistent");
	return meta;
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
	return `${icon} ${formatBadge(job.type, job.status === "failed" ? "error" : job.status === "cancelled" ? "warning" : "accent", theme)} ${theme.fg("toolOutput", safe(job.id))} ${theme.fg("dim", safe(job.label))} ${theme.fg("dim", formatDuration(job.durationMs))}`;
}

export function renderProcWrite(
	id: string,
	modePath: boolean,
	content: string | undefined,
	argsComplete: boolean,
	result: ToolResult | undefined,
	details: ProcWriteDetails | undefined,
	options: RenderResultOptions,
	theme: Theme,
): Component {
	return card((_width, expanded) => {
		const action =
			details && "action" in details
				? details.action
				: details?.op === "cancel"
					? "cancel"
					: modePath
						? "mode"
						: content
							? "stdin"
							: argsComplete
								? "cancel / stop"
								: "operation";
		const title = `Proc ${action} ${safe(id || "…")}`;
		const daemon = details && "daemon" in details ? details.daemon : undefined;
		const header = renderStatusLine(
			{
				icon:
					result === undefined ? "pending" : result.isError ? "error" : action === "stop" ? "aborted" : "success",
				title,
				meta: daemon ? daemonMeta(daemon, theme) : modePath && content ? [safe(content)] : [],
			},
			theme,
		);
		if (result?.isError) return [header, formatErrorDetail(firstText(result) || "Process operation failed.", theme)];
		const lines = [header];
		if (content && !modePath) lines.push(...preview(content, expanded, theme));
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
		const header = renderStatusLine(
			{
				icon: result === undefined ? "pending" : result.isError ? "error" : "info",
				title,
				meta: daemon ? daemonMeta(daemon, theme) : [],
			},
			theme,
		);
		if (result?.isError) return [header, formatErrorDetail(firstText(result) || "Process read failed.", theme)];
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
			return [header, ...visible];
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
		const items = [
			...jobs.map(job => ({ label: jobRow(job, theme) })),
			...services.map(service => ({
				label: `${formatBadge("service", "accent", theme)} ${theme.fg("toolOutput", safe(service.name))} ${formatBadge(service.state, service.state === "failed" ? "error" : service.state === "ready" || service.state === "running" ? "success" : "warning", theme)} ${daemonMeta(service, theme).slice(1).join(theme.sep.dot)}`,
			})),
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
					itemType: "process",
					renderItem: item => item.label,
				},
				theme,
			),
			...(items.length ? [] : [theme.fg("dim", "No background jobs or services.")]),
		];
	}, options);
}
