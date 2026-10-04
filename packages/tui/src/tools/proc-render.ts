import type { Component } from "../tui";
import { Ellipsis, renderStatusLine, renderTreeList, truncateToWidth } from "../render";
import {
	cappedHeadLines,
	formatBadge,
	formatDuration,
	formatErrorDetail,
	formatStatusIcon,
	PREVIEW_LIMITS,
	TRUNCATE_LENGTHS,
	type ToolUIColor,
} from "../render/render-utils";
import type { Theme } from "../theme/theme";
import type { NativeToolView, RenderResultOptions } from "./renderer";
import type { TspSpan, TspTone } from "@oh-my-pi/pi-wire";
import { ansi, compact, node, span, text } from "../native/describe";
import type { NativeChild, NativeNode } from "../native/node";
import { errorText, noteText, toolHead } from "./native-view";
import type { AgentActivitySnapshot, CoordinationDetails, JobSnapshot } from "./wait";
import type { IrcDeliveryReceipt } from "./irc";
import type { DaemonSnapshot } from "./daemon";
import { styleTerminalRow } from "./terminal-output";
import { card, type CardToolResult as ToolResult, firstText, safe } from "./result-card";

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

/** Process operation selected by a write URL, independent of its content. */
export type ProcWriteAction = "stdin" | "mode" | "kill";

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
		const header = renderStatusLine(
			{
				icon:
					result === undefined ? "pending" : result.isError ? "error" : action === "kill" ? "aborted" : "success",
				title,
				meta: daemon ? daemonMeta(daemon, theme) : action === "mode" && content ? [safe(content)] : [],
			},
			theme,
		);
		if (result?.isError) return [header, formatErrorDetail(firstText(result) || "Process operation failed.", theme)];
		const lines = [header];
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

// =============================================================================
// Native (TSP) views
// =============================================================================

function daemonMetaText(daemon: DaemonSnapshot): string {
	const meta: string[] = [daemon.state];
	if (daemon.pid !== undefined) meta.push(`pid ${daemon.pid}`);
	meta.push(
		`${daemon.exitedAt === undefined ? "up" : "ran"} ${formatDuration(Math.max(0, (daemon.exitedAt ?? Date.now()) - daemon.startedAt))}`,
	);
	if (daemon.detached) meta.push("detached");
	else if (daemon.persist) meta.push("persistent");
	return meta.join(" · ");
}

function jobTone(status: JobSnapshot["status"]): TspTone {
	return status === "failed"
		? "error"
		: status === "cancelled"
			? "warning"
			: status === "running"
				? "info"
				: "success";
}

function jobItem(job: JobSnapshot, badge?: { text: string; tone: TspTone }): NativeNode {
	return node(
		"item",
		{
			label: [span(job.type, "accent"), span(" "), span(safe(job.id), "toolOutput")],
			detail: [span(safe(job.label), "muted")],
			value: badge ? [span(badge.text, badge.tone)] : [span(formatDuration(job.durationMs), "muted")],
			tone: badge?.tone ?? jobTone(job.status),
		},
		undefined,
		job.id,
	);
}

function quotedPreview(body: string, tone = "muted"): NativeNode | undefined {
	if (!body.trim()) return undefined;
	return text([span(body, tone)], { wrap: "word", role: "omp.tool.proc.preview" });
}

const RECEIPT_TONE: Record<IrcDeliveryReceipt["outcome"], TspTone> = {
	injected: "success",
	woken: "success",
	revived: "warning",
	failed: "error",
};

/** TSP view of an `agent://` write (IRC message). */
export function describeAgentWrite(
	to: string,
	body: string,
	result: ToolResult | undefined,
	details: CoordinationDetails | undefined,
): NativeToolView {
	const recipient = safe(details?.to || to || "…");
	const receipts = details?.receipts ?? [];
	const delivered = receipts.filter(receipt => receipt.outcome !== "failed").length;
	const failed = receipts.length - delivered;
	const meta: TspSpan[] = [];
	if (recipient === "all") meta.push(span("broadcast", "muted"));
	if (receipts.length === 1) meta.push(span(receipts[0]!.outcome, RECEIPT_TONE[receipts[0]!.outcome]));
	else if (receipts.length > 1) {
		if (delivered) meta.push(span(`${delivered} delivered`, "success"));
		if (failed) meta.push(span(`${failed} failed`, "error"));
	}
	const head = toolHead("IRC", span(recipient, "accent"), ...meta);
	const error = result?.isError === true || (failed > 0 && delivered === 0);
	if (result?.isError && receipts.length === 0) {
		return { head, tone: "error", body: [errorText(firstText(result) || "Message delivery failed.")] };
	}
	const children = compact<NativeChild>([
		quotedPreview(body),
		result !== undefined && receipts.length === 0 && noteText(firstText(result) || "No live peers to broadcast to."),
		(receipts.length > 1 || failed > 0) &&
			node(
				"list",
				{ role: "omp.tool.irc.receipts" },
				receipts.map(receipt =>
					node(
						"item",
						{
							label: [span(safe(receipt.to), "toolOutput")],
							value: [span(receipt.outcome, RECEIPT_TONE[receipt.outcome])],
							detail: receipt.error ? [span(safe(receipt.error), "error")] : undefined,
							tone: RECEIPT_TONE[receipt.outcome],
						},
						undefined,
						receipt.to,
					),
				),
			),
	]);
	return { head, tone: error ? "error" : undefined, body: children };
}

/** TSP view of a `proc://` write (stdin, mode change, kill). */
export function describeProcWrite(
	id: string,
	action: ProcWriteAction,
	content: string | undefined,
	result: ToolResult | undefined,
	details: ProcWriteDetails | undefined,
): NativeToolView {
	const daemon = details && "daemon" in details ? details.daemon : undefined;
	const head = toolHead(
		`Proc ${action}`,
		span(safe(id || "…"), "accent"),
		daemon ? daemonMetaText(daemon) : action === "mode" && content ? safe(content) : undefined,
	);
	if (result?.isError) {
		return { head, tone: "error", body: [errorText(firstText(result) || "Process operation failed.")] };
	}
	const body = compact<NativeChild>([content && action === "stdin" ? quotedPreview(content) : undefined]);
	if (details && "op" in details && details.op === "cancel") {
		const jobs = details.jobs ?? [];
		body.push(
			node(
				"list",
				{ role: "omp.tool.proc.cancelled" },
				(details.cancelled ?? []).map(outcome => {
					const job = jobs.find(item => item.id === outcome.id);
					const badge = {
						text: outcome.status,
						tone: outcome.status === "cancelled" ? "warning" : "error",
					} as const;
					return job
						? jobItem(job, badge)
						: node(
								"item",
								{ label: [span(safe(outcome.id), "toolOutput")], value: [span(badge.text, badge.tone)] },
								undefined,
								outcome.id,
							);
				}),
			),
		);
	}
	return { head, tone: result !== undefined && action === "kill" ? "warning" : undefined, body };
}

/** TSP view of a `proc://` read: job/service detail, logs, or the process table. */
export function describeProcRead(
	id: string,
	result: ToolResult | undefined,
	details: ProcReadDetails | undefined,
): NativeToolView {
	const daemon = details?.daemon;
	const title = id ? "Proc" : "Proc jobs & services";
	const head = toolHead(title, id ? span(safe(id), "accent") : undefined, daemon ? daemonMetaText(daemon) : undefined);
	if (result?.isError) {
		return { head, tone: "error", body: [errorText(firstText(result) || "Process read failed.")] };
	}
	if (!result) return { head };
	if (details?.job) {
		const log = details.log ?? details.job.errorText ?? details.job.resultText ?? "";
		return {
			head,
			body: compact<NativeChild>([
				node("list", {}, [jobItem(details.job)]),
				log.trim().length > 0 && ansi(log, { role: "omp.tool.proc.log" }),
			]),
		};
	}
	if (daemon) {
		const output = details.terminalRows?.join("\n") ?? details.log ?? "";
		return { head, body: [ansi(output, { follow: daemon.exitedAt === undefined, role: "omp.tool.proc.log" })] };
	}
	if (id && !details?.jobs && !details?.daemons && !details?.agents) {
		return { head, body: compact<NativeChild>([quotedPreview(firstText(result), "toolOutput")]) };
	}
	const jobs = details?.jobs ?? [];
	const services = details?.daemons ?? [];
	const agents = details?.agents ?? [];
	const items: NativeNode[] = [
		...jobs.map(job => jobItem(job)),
		...services.map(service =>
			node(
				"item",
				{
					label: [span("service", "accent"), span(" "), span(safe(service.name), "toolOutput")],
					detail: [span(daemonMetaText(service), "muted")],
					tone:
						service.state === "failed"
							? "error"
							: service.state === "ready" || service.state === "running"
								? "success"
								: "warning",
				},
				undefined,
				`service:${service.name}`,
			),
		),
		...agents.map(agent =>
			node(
				"item",
				{
					label: [span("agent", agent.live ? "accent" : "warning"), span(" "), span(safe(agent.id), "toolOutput")],
					value: [span(formatDuration(agent.ageMs), "muted")],
				},
				undefined,
				`agent:${agent.id}`,
			),
		),
	];
	const counts = [`${jobs.length} jobs`, `${services.length} services`];
	if (agents.length) counts.push(`${agents.length} agents`);
	return {
		head: toolHead(title, id ? span(safe(id), "accent") : undefined, counts.join(" · ")),
		body: [node("list", { empty: "No background jobs or services.", role: "omp.tool.proc.table" }, items)],
	};
}
