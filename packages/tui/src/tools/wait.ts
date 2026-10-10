import type { Component } from "../tui";
import { Text } from "../components/text";
import { visibleWidth } from "../utils";
import { formatAge } from "@oh-my-pi/pi-utils";
import { shimmerEnabled, shimmerText } from "../theme/shimmer";
import type { Theme } from "../theme/theme";
import { Ellipsis, Hasher, type RenderCache, renderStatusLine, renderTreeList, truncateToWidth } from "../render/index";
import { formatArtifactErrorNotice, stripOutputNotice, type OutputMeta } from "./output-meta";
import {
	FEED_MODEL_BADGE_WIDTH,
	formatBadge,
	formatDuration,
	formatEmptyMessage,
	formatExpandHint,
	formatFeedModelBadge,
	formatStatusIcon,
	getPreviewLines,
	isFeedModelBadgeEnabled,
	PREVIEW_LIMITS,
	replaceTabs,
	type ToolUIColor,
	type ToolUIStatus,
	cappedHeadLines,
	createCachedComponent,
	type ConfiguredThinkingLevel,
	wrapTextWithAnsi,
} from "../render/render-utils";
import type { StructuredSubagentOutput } from "./task";
import { describeJobTiles, type JobTile, type JobWidgetView, renderJobTileLines } from "./job-widget";
import type { RenderResultOptions, ToolRenderer, ToolActivitySummary } from "./renderer";
import type { IrcDeliveryReceipt, IrcMessage } from "./irc";
import type { TspSpan } from "@oh-my-pi/pi-wire";
import { card as cardNode, compact, elapsed, keyed, md, node, row, span, text } from "../native/describe";
import type { NativeNode } from "../native/node";
import { OwnerMemo } from "../native/memo";
import { plainText } from "../native/spans";
import { errorView, resultText, toolHead } from "./native-view";
import type { NativeToolView, ToolRenderResult } from "./renderer";

/** Whether a wait snapshot contains only running jobs and no cancellations. */
export function isWaitingPollDetails(details: unknown): boolean {
	const d = details as CoordinationDetails | undefined;
	if (!d || !Array.isArray(d.jobs) || d.jobs.length === 0) return false;
	if (d.cancelled?.length) return false;
	return d.jobs.every(job => job?.status === "running");
}
/** Coordination details retained by wait and background job operations. */
export type CoordinationOp = "send" | "wait" | "cancel";

/** Background-job row surfaced by `wait`/`cancel` results and `proc://` listings. */
export interface JobSnapshot {
	id: string;
	type: "bash" | "task" | "eval";
	status: "running" | "completed" | "failed" | "cancelled";
	label: string;
	durationMs: number;
	/** Process exit status when the job reports one. */
	exitCode?: number;
	/** Effective task model selector, including an explicit reasoning suffix when configured. */
	resolvedModel?: string;
	/** Provider/id including routing, with no added thinking suffix. */
	resolvedModelIdentity?: string;
	/** Explicit thinking metadata, independent of the model identity. */
	resolvedThinkingLevel?: ConfiguredThinkingLevel;
	/** True when the task progress reports an attached live advisor. */
	advisor?: boolean;
	/** The task agent's latest self-estimated completion (0–100); see `AgentProgress.completionPercent`. */
	completionPercent?: number;
	/** The task agent's latest stage in its own words; see `AgentProgress.stage`. */
	stage?: string;
	/** Running task only: assistant requests so far; see `AgentProgress.requests`. */
	requests?: number;
	/** Running task only: cumulative cost in USD; see `AgentProgress.cost`. */
	cost?: number;
	/** Running task only: latest per-turn context size; see `AgentProgress.contextTokens`. */
	contextTokens?: number;
	/** Running task only: the model's context window; see `AgentProgress.contextWindow`. */
	contextWindow?: number;
	/** The job's live widget, while one is being drawn; frozen at its last state once the job settles. */
	widget?: JobWidgetView;
	resultText?: string;
	errorText?: string;
	/** Source-output metadata retained for per-job warnings and persisted row rendering. */
	meta?: OutputMeta;
	/** Capture error in historical snapshots; new snapshots store source metadata in `meta`. */
	artifactError?: OutputMeta["artifactError"];
	structured?: StructuredSubagentOutput;
	/**
	 * `agent://<id>` handle backing this job's artifacts — the job-row's
	 * registry `agentId` when the manager disambiguated a requested job id
	 * on collision, else the job id itself. See {@link AsyncJob.agentId}.
	 */
	agentUrlId?: string;
	/**
	 * Whether this job's turn published `<agentUrlId>.md`. False where the job
	 * body reported that it wrote none, so `agent://` still holds an earlier
	 * turn's output; undefined where the body does not report it.
	 */
	agentOutputPublished?: boolean;
}

/** Outcome of cancelling one background job. */
export type CancelStatus = "cancelled" | "not_found" | "already_completed";

/** Cancellation outcome and its model-facing explanation. */
export interface CancelOutcome {
	id: string;
	status: CancelStatus;
	message: string;
}

/**
 * A live subagent from the AgentRegistry that has no backing job in the
 * AsyncJobManager — e.g. an idle agent woken (or a parked agent revived) via
 * a peer message, or a spawn owned by another agent. Surfaced by background
 * snapshots so the displayed picture matches the UI's running-agent
 * count.
 */
export interface AgentActivitySnapshot {
	id: string;
	parentId?: string;
	/** Latest activity gist recorded by the registry (display-only). */
	activity?: string;
	/** Time since the agent was registered. */
	ageMs: number;
	/**
	 * Whether an attached session corroborates the `running` claim. False marks
	 * a ref that says `running` with no turn in flight — either a spawn still
	 * wiring up or a stale registration that an explicit cancellation clears (#8634).
	 */
	live: boolean;
	/**
	 * Acceptance time of the agent's final result, when the registry recorded
	 * one. With `live: false` this is an accepted run the parent may cancel
	 * instead of waiting on (#11079).
	 */
	acceptedAt?: number;
}

/** Details shared by messaging receipts and job/wait results. */
export interface CoordinationDetails {
	meta?: OutputMeta;
	op: CoordinationOp;
	from?: string;
	to?: string;
	receipts?: IrcDeliveryReceipt[];
	/** Message consumed by `wait`. */
	waited?: IrcMessage | null;
	jobs?: JobSnapshot[];
	cancelled?: { id: string; status: CancelStatus }[];
	/** Running subagents not represented by a job row in this result. */
	agents?: AgentActivitySnapshot[];
	/** `wait` was cut short by steering, a peer message, or a completion notice that injects next. */
	interrupted?: boolean;
}

// =============================================================================
// TUI Renderer
// =============================================================================

const LABEL_MAX_WIDTH = 60;
const PREVIEW_LINES_COLLAPSED = 1;
const PREVIEW_LINES_EXPANDED = 4;
const LABEL_LINES_COLLAPSED = 1;
const LABEL_LINES_EXPANDED = 3;
const PREVIEW_LINE_WIDTH = 80;

function statusToIcon(status: JobSnapshot["status"]): ToolUIStatus {
	switch (status) {
		case "completed":
			return "done";
		case "failed":
			return "error";
		case "cancelled":
			return "aborted";
		case "running":
			return "running";
	}
}

function statusToColor(status: JobSnapshot["status"]): ToolUIColor {
	switch (status) {
		case "completed":
			return "success";
		case "failed":
			return "error";
		case "cancelled":
			return "warning";
		case "running":
			return "accent";
	}
}

/**
 * Task job results are delivered in the model-facing `<task-result>` envelope
 * (prompts/tools/task-summary.md) so the parent agent can parse status and the
 * `agent://` pointer. The wrapper markup is noise to a human — preview the
 * inner <output>/<preview> body instead.
 */
function stripTaskResultEnvelope(text: string): string {
	if (!text.startsWith("<task-result")) return text;
	const body = /<(output|preview)(?:\s[^>]*)?>\n?([\s\S]*?)\n?<\/\1>/.exec(text)?.[2];
	return body?.trim() || text;
}

/**
 * Pretty-printed JSON output wastes the collapsed one-line preview on a lone
 * "{" — flatten structured-looking bodies onto a single line. Slice first:
 * downstream truncation keeps at most a few hundred columns, so collapsing
 * whitespace across a multi-KB body would be pure waste.
 */
function flattenStructuredPreview(text: string): string {
	const first = text[0];
	if (first !== "{" && first !== "[") return text;
	return text.slice(0, PREVIEW_LINES_EXPANDED * PREVIEW_LINE_WIDTH * 2).replace(/\s+/g, " ");
}

/** The row label: a running task's own stage line when it reports one, else the job's label. */
function jobRowLabel(job: JobSnapshot): string {
	return job.type === "task" && job.status === "running" && job.stage?.trim() ? job.stage : job.label;
}

/** A job as its tile; `live` while the card's clocks run. */
function jobTile(job: JobSnapshot, live: boolean): JobTile {
	return {
		id: job.id,
		type: job.type,
		status: job.status,
		label: job.label,
		durationMs: job.durationMs,
		live: live && job.status === "running",
		...(job.widget ? { widget: job.widget } : {}),
		...(job.status === "running" && job.completionPercent !== undefined
			? { completionPercent: job.completionPercent }
			: {}),
		...(job.stage ? { stage: job.stage } : {}),
		...(job.exitCode === undefined ? {} : { exitCode: job.exitCode }),
	};
}

/** Identity of the widgets a job list draws: changes whenever any widget's data or state does. */
function widgetStamp(jobs: readonly JobSnapshot[] | undefined): string {
	if (!jobs) return "";
	let stamp = "";
	for (const job of jobs) if (job.widget) stamp += `${job.id}:${job.widget.updatedAt}:${job.widget.state};`;
	return stamp;
}

/** Tiles a native wait card shows before it counts the rest. */
const TILES_SHOWN = 9;

/** Pending wait frame. */
function waitRenderCall(_args: object, _options: RenderResultOptions, uiTheme: Theme): Component {
	return new Text(renderStatusLine({ icon: "pending", title: "Wait" }, uiTheme), 0, 0);
}

/** Result frame for wait snapshots and the agents roster. */
function jobsRenderResult(
	result: {
		content: Array<{ type: string; text?: string }>;
		details?: CoordinationDetails;
		isError?: boolean;
	},
	options: RenderResultOptions,
	uiTheme: Theme,
): Component {
	const jobs = result.details?.jobs ?? [];
	const agents = result.details?.agents ?? [];

	if (jobs.length === 0 && agents.length === 0) {
		const fallback = result.content?.find(c => c.type === "text")?.text || "No jobs to process";
		const header = renderStatusLine({ icon: "warning", title: "Wait" }, uiTheme);
		return new Text([header, formatEmptyMessage(fallback, uiTheme)].join("\n"), 0, 0);
	}

	// Sealing freezes the snapshot; still-running rows remain meaningful history.

	const counts = { completed: 0, failed: 0, cancelled: 0, running: 0 };
	for (const job of jobs) counts[job.status]++;

	// The title already carries the running count, so meta lists only the
	// settled categories — "waiting on 19 of 19 · 19 running" read awkward.
	const meta: string[] = [];
	if (counts.completed > 0) meta.push(uiTheme.fg("success", `${counts.completed} done`));
	if (counts.failed > 0) meta.push(uiTheme.fg("error", `${counts.failed} failed`));
	if (counts.cancelled > 0) meta.push(uiTheme.fg("warning", `${counts.cancelled} cancelled`));
	if (agents.length > 0 && jobs.length > 0) {
		meta.push(uiTheme.fg("accent", `${agents.length} agent${agents.length === 1 ? "" : "s"}`));
	}

	const headerIcon: ToolUIStatus =
		counts.failed > 0 ? "warning" : counts.running > 0 || agents.length > 0 ? "info" : "success";
	const jobsNoun = jobs.length === 1 ? "job" : "jobs";
	const description =
		jobs.length === 0
			? `${agents.length} running agent${agents.length === 1 ? "" : "s"} — no jobs`
			: counts.running > 0
				? counts.running === jobs.length
					? `waiting on ${jobs.length} ${jobsNoun}`
					: `waiting on ${counts.running} of ${jobs.length} ${jobsNoun}`
				: `${jobs.length} ${jobsNoun} settled`;

	const header = renderStatusLine(
		{
			icon: headerIcon,
			spinnerFrame: counts.running > 0 || agents.length > 0 ? options.spinnerFrame : undefined,
			title: description,
			meta,
		},
		uiTheme,
	);

	const outputMeta = result.details?.meta;
	// Historical snapshots promoted a job failure to the root. Render it there
	// only when no row identifies that failure; new report capture errors are distinct.
	const aggregateArtifactError =
		outputMeta?.artifactError &&
		(outputMeta.source?.type === "report" ||
			!jobs.some(job => (job.meta?.artifactError ?? job.artifactError) === outputMeta.artifactError))
			? outputMeta.artifactError
			: undefined;

	// Sort: running first (so user sees what's still pending), then failed, then completed/cancelled.
	const statusOrder: Record<JobSnapshot["status"], number> = {
		running: 0,
		failed: 1,
		cancelled: 2,
		completed: 3,
	};
	const sortedJobs = [...jobs].sort((a, b) => {
		const diff = statusOrder[a.status] - statusOrder[b.status];
		if (diff !== 0) return diff;
		return b.durationMs - a.durationMs;
	});

	let cached: RenderCache | undefined;
	// Per-job preview rows are invariant across spinner/shimmer frames (the job
	// snapshots are frozen for this result), so the envelope strip, flatten and
	// wrap run once per (job, expanded, width) instead of every animated frame.
	const previewRows = new Map<JobSnapshot, { expanded: boolean; width: number; lines: readonly string[] }>();
	const jobPreviewRows = (job: JobSnapshot, expanded: boolean, continuationWidth: number): readonly string[] => {
		const hit = previewRows.get(job);
		if (hit !== undefined && hit.expanded === expanded && hit.width === continuationWidth) return hit.lines;
		const artifactError = job.meta?.artifactError ?? job.artifactError;
		// Legacy rows did not retain full metadata. Strip the known warning
		// footer so the dedicated row/root warning remains the only copy.
		const previewError =
			artifactError ?? (outputMeta?.source?.type !== "report" ? outputMeta?.artifactError : undefined);
		const previewMeta = job.meta ?? (previewError ? { artifactError: previewError } : undefined);
		const preview = flattenStructuredPreview(
			stripTaskResultEnvelope(
				stripOutputNotice(job.errorText?.trim() || job.resultText?.trim() || "", previewMeta).trim(),
			),
		);
		const lines: string[] = [];
		if (preview) {
			const maxLines = expanded ? PREVIEW_LINES_EXPANDED : PREVIEW_LINES_COLLAPSED;
			const previewLines = getPreviewLines(
				preview,
				maxLines,
				Math.min(PREVIEW_LINE_WIDTH, continuationWidth),
				Ellipsis.Unicode,
			);
			const tone = job.errorText ? "error" : "dim";
			for (const pl of previewLines) lines.push(`  ${uiTheme.fg(tone, pl)}`);
		}
		previewRows.set(job, { expanded, width: continuationWidth, lines });
		return lines;
	};
	// Collapsed card: one line per settled job, or the bare "waiting on N jobs"
	// header while nothing has settled. Repeated polls then read as a short
	// completion log instead of a re-printed (and shrinking) job tree; Ctrl+O
	// restores the full tree with output previews. A running job's live widget
	// still draws its tile: that chart is the job's progress, not a copy of it.
	const settledJobs = sortedJobs.filter(job => job.status !== "running");
	const widgetJobs = sortedJobs.filter(job => job.status === "running" && job.widget?.state === "live");
	const compactJobLines = (width: number, live: boolean): string[] => {
		const lines: string[] = [];
		const indent = " ".repeat(visibleWidth(formatStatusIcon("done", uiTheme)) + 1);
		// Failures sort first, so the cap never hides one behind successes;
		// Ctrl+O lists the rest.
		for (const job of settledJobs.slice(0, PREVIEW_LIMITS.COLLAPSED_ITEMS)) {
			const icon = formatStatusIcon(statusToIcon(job.status), uiTheme);
			const word = job.status === "completed" ? "done" : job.status;
			const exit =
				job.exitCode !== undefined && job.exitCode !== 0
					? `${uiTheme.sep.dot}${uiTheme.fg("error", `exit ${job.exitCode}`)}`
					: "";
			// The outcome (status, exit, duration) is reserved first; a long id
			// gives way so a failure is never cut off the row.
			const outcome = ` ${uiTheme.fg(statusToColor(job.status), word)}${exit}${uiTheme.sep.dot}${uiTheme.fg("dim", formatDuration(job.durationMs))}`;
			const id = truncateToWidth(
				replaceTabs(job.id).replace(/\s+/g, " "),
				Math.max(1, width - visibleWidth(`${icon} `) - visibleWidth(outcome)),
				Ellipsis.Unicode,
			);
			let line = `${icon} ${uiTheme.fg("accent", id)}${outcome}`;
			const label = replaceTabs(jobRowLabel(job).split(/\r?\n/)[0] ?? "").trim();
			const labelBudget = width - visibleWidth(line) - 2;
			if (label && label !== job.id && labelBudget >= 8) {
				line += `  ${uiTheme.fg("muted", truncateToWidth(label, labelBudget, Ellipsis.Unicode))}`;
			}
			lines.push(line);
			// A failure says why on the collapsed row; the rest of its output
			// stays behind Ctrl+O.
			const reason =
				job.status === "failed"
					? stripOutputNotice(job.errorText ?? "", job.meta)
							.split(/\r?\n/)
							.find(part => part.trim())
							?.trim()
					: undefined;
			if (reason) {
				lines.push(
					`${indent}${uiTheme.fg("error", truncateToWidth(replaceTabs(reason), Math.max(1, width - indent.length), Ellipsis.Unicode))}`,
				);
			}
			// The root warning is suppressed when a row owns the failure, so the
			// compact row carries it too — otherwise it only shows after Ctrl+O.
			const artifactError = job.meta?.artifactError ?? job.artifactError;
			if (artifactError) {
				lines.push(uiTheme.fg("warning", truncateToWidth(formatArtifactErrorNotice(artifactError), width)));
			}
		}
		const hiddenSettled = settledJobs.length - PREVIEW_LIMITS.COLLAPSED_ITEMS;
		if (hiddenSettled > 0) lines.push(`${indent}${uiTheme.fg("dim", `… ${hiddenSettled} more settled`)}`);
		const shownWidgetJobs = widgetJobs.slice(0, PREVIEW_LIMITS.COLLAPSED_ITEMS);
		for (const job of shownWidgetJobs) {
			const typeBadge = formatBadge(job.type, statusToColor(job.status), uiTheme);
			const icon = formatStatusIcon("running", uiTheme, live ? options.spinnerFrame : undefined);
			const meta = compact([
				job.completionPercent !== undefined ? uiTheme.fg("accent", `${job.completionPercent}%`) : undefined,
				uiTheme.fg("dim", formatDuration(job.durationMs)),
			]).join(" ");
			lines.push(
				...renderJobTileLines(jobTile(job, live), width, uiTheme, {
					lead: `${icon} ${typeBadge} `,
					meta,
					full: false,
				}),
			);
		}
		// Running jobs without a drawn tile (no widget, or past the cap) collapse
		// into one count; the header already carries it while nothing settled.
		const quietRunning = counts.running - shownWidgetJobs.length;
		if (quietRunning > 0 && (settledJobs.length > 0 || shownWidgetJobs.length < widgetJobs.length)) {
			lines.push(`${indent}${uiTheme.fg("dim", `${quietRunning} still running`)}`);
		}
		return lines;
	};
	return {
		render(width: number): readonly string[] {
			const expanded = options.expanded;
			const spinnerFrame = options.spinnerFrame ?? 0;
			// Running-job labels shimmer while the wait block is live; the band
			// phase is Date.now()-sampled at render time, so serving cached bytes
			// would pin it to the ~12.5fps spinner-glyph cadence instead of the
			// 30fps redraw. Bypass the cache while any row animates, and key on
			// the animation state so a sealed block never hits stale shimmered
			// bytes (spinnerFrame falls back to 0 on both sides of the seal).
			const shimmerActive = counts.running > 0 && options.spinnerFrame !== undefined && shimmerEnabled();
			const showModelBadge = isFeedModelBadgeEnabled();
			const key = new Hasher()
				.bool(expanded)
				.u32(width)
				.u32(spinnerFrame)
				.bool(shimmerActive)
				.bool(showModelBadge)
				.str(widgetStamp(jobs))
				.digest();
			if (!shimmerActive && cached?.key === key) return cached.lines;

			const compactView = !expanded && jobs.length > 0;
			const itemLines = compactView
				? compactJobLines(width, counts.running > 0 && options.spinnerFrame !== undefined)
				: renderTreeList<JobSnapshot>(
						{
							items: sortedJobs,
							expanded,
							maxCollapsed: PREVIEW_LIMITS.COLLAPSED_ITEMS,
							itemType: "job",
							renderItem: (job, context) => {
								const rowWidth = Math.max(0, width - (context.prefixWidth ?? 0));
								const lines: string[] = [];
								const icon = `${formatStatusIcon(
									statusToIcon(job.status),
									uiTheme,
									job.status === "running" ? options.spinnerFrame : undefined,
								)}${job.exitCode === undefined ? "" : `${uiTheme.sep.dot}${uiTheme.fg(job.exitCode === 0 ? "muted" : "error", `exit ${job.exitCode}`)}`}`;
								const typeBadge = formatBadge(job.type, statusToColor(job.status), uiTheme);
								const completion =
									job.status === "running" && job.completionPercent !== undefined
										? `${uiTheme.sep.dot}${uiTheme.fg("accent", `${job.completionPercent}%`)}`
										: "";
								const durationSuffix = `${completion}${uiTheme.sep.dot}${uiTheme.fg("dim", formatDuration(job.durationMs))}`;
								const displayId = truncateToWidth(
									replaceTabs(job.id).replace(/\s+/g, " "),
									Math.max(0, rowWidth - visibleWidth(`${icon} ${typeBadge} ${durationSuffix}`)),
									Ellipsis.Unicode,
								);
								const rowLabel = jobRowLabel(job);
								const rawLabelLines = (rowLabel || "(no label)").split(/\r?\n/);
								const maxLabelLines = expanded ? LABEL_LINES_EXPANDED : LABEL_LINES_COLLAPSED;
								const visibleLabelLines = rawLabelLines
									.slice(0, maxLabelLines)
									.map(l => truncateToWidth(replaceTabs(l), LABEL_MAX_WIDTH, Ellipsis.Unicode));
								if (rawLabelLines.length > maxLabelLines && visibleLabelLines.length > 0) {
									const last = visibleLabelLines[visibleLabelLines.length - 1]!;
									visibleLabelLines[visibleLabelLines.length - 1] = `${last} …`;
								}
								const rowPrefix = `${icon} ${typeBadge} `;
								const live = job.status === "running" && options.spinnerFrame !== undefined;
								const continuationWidth = Math.max(0, rowWidth - visibleWidth("  "));
								if (job.widget?.state === "live") {
									const meta = compact([
										job.status === "running" && job.completionPercent !== undefined
											? uiTheme.fg("accent", `${job.completionPercent}%`)
											: undefined,
										uiTheme.fg("dim", formatDuration(job.durationMs)),
									]).join(" ");
									lines.push(
										...renderJobTileLines(jobTile(job, live), rowWidth, uiTheme, {
											lead: rowPrefix,
											meta,
											full: expanded,
										}),
									);
								} else {
									const modelIdentity = job.resolvedModelIdentity ?? job.resolvedModel;
									const modelBadge =
										job.type === "task" && showModelBadge && typeof modelIdentity === "string"
											? formatFeedModelBadge(
													modelIdentity,
													job.resolvedThinkingLevel,
													job.advisor === true,
													uiTheme,
													Math.min(
														FEED_MODEL_BADGE_WIDTH,
														Math.max(
															0,
															rowWidth - visibleWidth(`${rowPrefix}${displayId}${durationSuffix}`) - 1,
														),
													),
												)
											: "";
									const modelLead = modelBadge ? `${modelBadge} ` : "";
									const headRaw = displayId;
									// Running rows in a live block shimmer their label; once the block
									// stops animating (sealed, or a settled snapshot — spinnerFrame
									// cleared) they render static so scrollback never keeps a mid-sweep
									// shimmer band.
									const headLabel = live
										? shimmerEnabled()
											? shimmerText(headRaw, uiTheme)
											: uiTheme.fg("accent", headRaw)
										: uiTheme.fg("toolOutput", headRaw);
									let row = `${rowPrefix}${modelLead}${headLabel}`;
									const distinctLabel = rowLabel.trim() !== job.id;
									const label = visibleLabelLines[0] ?? "";
									const inlineLabel =
										distinctLabel && visibleWidth(`${row} ${label}${durationSuffix}`) <= rowWidth;
									if (inlineLabel) row += ` ${uiTheme.fg("toolOutput", label)}`;
									row += durationSuffix;
									lines.push(truncateToWidth(row, rowWidth, ""));
									for (let i = distinctLabel && !inlineLabel ? 0 : 1; i < visibleLabelLines.length; i++) {
										lines.push(
											`  ${uiTheme.fg("toolOutput", truncateToWidth(visibleLabelLines[i]!, continuationWidth))}`,
										);
									}
								}
								const artifactError = job.meta?.artifactError ?? job.artifactError;
								if (artifactError) {
									lines.push(
										uiTheme.fg(
											"warning",
											truncateToWidth(formatArtifactErrorNotice(artifactError), rowWidth),
										),
									);
								}

								for (const previewLine of jobPreviewRows(job, expanded, continuationWidth))
									lines.push(previewLine);
								return lines;
							},
						},
						uiTheme,
					);

			// Agents run outside job control; render them as their own tree so
			// they never skew the job counts or the "waiting on N jobs" title.
			const agentLines =
				agents.length === 0
					? []
					: renderTreeList<AgentActivitySnapshot>(
							{
								items: agents,
								expanded,
								maxCollapsed: PREVIEW_LIMITS.COLLAPSED_ITEMS,
								itemType: "agent",
								renderItem: (agent, context) => {
									const rowWidth = Math.max(0, width - (context.prefixWidth ?? 0));
									const icon = agent.live
										? formatStatusIcon("running", uiTheme, options.spinnerFrame)
										: formatStatusIcon("warning", uiTheme);
									const badge = agent.live
										? formatBadge("agent", "accent", uiTheme)
										: formatBadge("agent · no turn", "warning", uiTheme);
									const id = truncateToWidth(
										replaceTabs(agent.id).replace(/\s+/g, " "),
										Math.max(0, rowWidth - visibleWidth(`${icon}  ${badge}`)),
										Ellipsis.Unicode,
									);
									const gist = agent.activity
										? ` ${uiTheme.fg("toolOutput", truncateToWidth(replaceTabs(agent.activity), LABEL_MAX_WIDTH, Ellipsis.Unicode))}`
										: "";
									const parent = agent.parentId ? uiTheme.fg("dim", ` ← ${agent.parentId}`) : "";
									const age = uiTheme.fg("dim", formatDuration(agent.ageMs));
									return [
										truncateToWidth(
											`${icon} ${uiTheme.fg("muted", id)} ${badge}${gist} ${age}${parent}`,
											rowWidth,
											"",
										),
									];
								},
							},
							uiTheme,
						);

			const all = compactView && settledJobs.length > 0 ? [] : [header];
			if (aggregateArtifactError) {
				all.push(uiTheme.fg("warning", formatArtifactErrorNotice(aggregateArtifactError)));
			}
			all.push(...itemLines, ...agentLines);
			for (let i = 0; i < all.length; i++) all[i] = truncateToWidth(all[i]!, width, Ellipsis.Unicode);
			cached = { key, lines: all };
			return all;
		},
		invalidate() {
			cached = undefined;
		},
	};
}

// =============================================================================
// Display-only IRC cards and wait-message results
// =============================================================================

const BODY_LINES_COLLAPSED = 2;
const BODY_LINE_WIDTH = 100;

function ircGlyph(theme: Theme): string {
	return theme.styledSymbol("tool.irc", "accent");
}

function messageAge(ts: number | undefined): string {
	if (!ts) return "";
	return formatAge(Math.max(1, Math.round((Date.now() - ts) / 1000)));
}

/**
 * Quote-bordered message body preview. `tone` separates outbound text (dim)
 * from received text (toolOutput); a trailing dim counter marks elided lines.
 */
function bodyLines(
	body: string,
	expanded: boolean,
	theme: Theme,
	width: number,
	options: {
		indent?: string;
		tone?: "dim" | "toolOutput";
		collapsedLines?: number;
	} = {},
): string[] {
	const indent = options.indent ?? "";
	const tone = options.tone ?? "toolOutput";
	const quote = theme.fg("dim", theme.md.quoteBorder);
	const source = body.split("\n").filter(line => line.trim());
	const shown = expanded ? source : cappedHeadLines(source, options.collapsedLines ?? BODY_LINES_COLLAPSED).lines;
	const hidden = source.length - shown.length;
	const contentWidth = Math.max(1, width - visibleWidth(indent) - 2);
	let cut = false;
	const lines: string[] = [];
	for (const line of shown) {
		const text = replaceTabs(line.trim());
		// Expanded: soft-wrap to the card width so a long single-line message
		// shows in full instead of being cut at BODY_LINE_WIDTH.
		if (expanded) {
			for (const row of wrapTextWithAnsi(text, contentWidth)) lines.push(`${indent}${quote} ${theme.fg(tone, row)}`);
			continue;
		}
		cut ||= visibleWidth(text) > BODY_LINE_WIDTH;
		lines.push(`${indent}${quote} ${theme.fg(tone, truncateToWidth(text, BODY_LINE_WIDTH, Ellipsis.Unicode))}`);
	}
	if (hidden > 0 || cut) {
		const hint = formatExpandHint(theme, expanded, true);
		const marker = hidden > 0 ? `… +${hidden} more ${hidden === 1 ? "line" : "lines"}` : "…";
		lines.push(`${indent}${quote} ${theme.fg("dim", `${marker}${hint ? ` ${hint}` : ""}`)}`);
	}
	return lines;
}

/**
 * Display-only transcript card for live IRC traffic: `irc:incoming` DMs
 * delivered to this session, `irc:autoreply` side-channel replies sent on
 * this session's behalf, and `irc:relay` observations of agent↔agent
 * traffic. Shares the tool renderer's glyph + quote-border conventions so
 * cards and peer-message output look identical in the transcript.
 */
export function createIrcMessageCard(
	card: {
		kind: "incoming" | "autoreply" | "relay" | "workpool";
		from?: string;
		to?: string;
		body?: string;
		replyTo?: string;
		timestamp?: number;
		pool?: string;
		mode?: string;
	},
	getExpanded: () => boolean,
	uiTheme: Theme,
): Component {
	const from = card.from?.trim() || "?";
	const title =
		card.kind === "incoming"
			? `IRC ${uiTheme.nav.back} ${from}`
			: card.kind === "autoreply"
				? `IRC ${uiTheme.nav.selected} ${card.to?.trim() || "?"}`
				: card.kind === "workpool"
					? `Pool ${card.pool?.trim() || "?"} ${uiTheme.nav.selected} ${card.to?.trim() || "?"}`
					: `IRC ${from} ${uiTheme.nav.selected} ${card.to?.trim() || "?"}`;
	const body = card.body ?? "";
	const meta: string[] = [];
	if (card.kind === "autoreply") meta.push("auto");
	if (card.kind === "workpool" && card.mode) meta.push(card.mode);
	if (card.replyTo) meta.push("reply");
	const age = messageAge(card.timestamp);
	if (age) meta.push(age);
	const component = createCachedComponent(getExpanded, (width, expanded) => {
		const lines = [renderStatusLine({ iconOverride: ircGlyph(uiTheme), title, meta }, uiTheme)];
		if (body.trim()) {
			lines.push(
				...bodyLines(body, expanded, uiTheme, width, {
					indent: "  ",
					collapsedLines: 3,
				}),
			);
		}
		return lines.map(line => truncateToWidth(line, width, Ellipsis.Unicode));
	});
	// Terminal-local collapse replaces `getExpanded`; the node never changes after creation.
	const described = cardNode(
		{
			role: `omp.irc.${card.kind}`,
			tone: "info",
			head: [
				span(plainText(title), "toolTitle strong"),
				...meta.filter(part => part !== age).map(part => span(` ${part}`, "muted")),
			],
			collapsible: body.trim().length > 0,
			preview: { lines: 3 },
		},
		compact([
			card.timestamp
				? row([elapsed(Date.now() - card.timestamp), text([span("ago", "dim")])], { gap: "xs" })
				: undefined,
			body.trim() ? md(body) : undefined,
		]),
	);
	return Object.assign(component, { describe: () => described });
}

function describeJobsResult(
	result: ToolRenderResult<CoordinationDetails>,
	isPartial: boolean,
): NativeToolView | undefined {
	const jobs = result.details?.jobs ?? [];
	const agents = result.details?.agents ?? [];
	if (jobs.length === 0 && agents.length === 0) {
		return {
			head: toolHead("Wait"),
			tone: "warning",
			body: [text([span(plainText(resultText(result) || "No jobs to process"), "dim")])],
		};
	}
	const counts = { completed: 0, failed: 0, cancelled: 0, running: 0 };
	for (const job of jobs) counts[job.status]++;
	const noun = jobs.length === 1 ? "job" : "jobs";
	const title =
		jobs.length === 0
			? `${agents.length} running agent${agents.length === 1 ? "" : "s"} — no jobs`
			: counts.running > 0
				? counts.running === jobs.length
					? `waiting on ${jobs.length} ${noun}`
					: `waiting on ${counts.running} of ${jobs.length} ${noun}`
				: `${jobs.length} ${noun} settled`;
	const head: TspSpan[] = [span(title, "toolTitle strong")];
	if (counts.completed > 0) head.push(span(` ${counts.completed} done`, "success"));
	if (counts.failed > 0) head.push(span(` ${counts.failed} failed`, "error"));
	if (counts.cancelled > 0) head.push(span(` ${counts.cancelled} cancelled`, "warning"));
	const order: Record<JobSnapshot["status"], number> = {
		running: 0,
		failed: 1,
		cancelled: 2,
		completed: 3,
	};
	const sorted = [...jobs].sort((a, b) => order[a.status] - order[b.status] || b.durationMs - a.durationMs);
	// One frame of tiles: each job's status, title, figure and widget together. The job's output
	// and errors fill the card of the call that started it (`parksAsBackground`), so no previews.
	const body: NativeNode[] = [];
	if (sorted.length > 0) {
		body.push(keyed(describeJobTiles(sorted.slice(0, TILES_SHOWN).map(job => jobTile(job, isPartial))), "tiles"));
	}
	if (sorted.length > TILES_SHOWN) {
		const rest = sorted.length - TILES_SHOWN;
		body.push(text([span(`+${rest} more ${rest === 1 ? "job" : "jobs"} · /jobs`, "dim")], { role: "omp.wait.more" }));
	}
	for (const agent of agents) {
		const spans: TspSpan[] = [span(plainText(agent.id), "muted")];
		if (agent.activity) spans.push(span(` ${plainText(agent.activity)}`, "toolOutput"));
		if (agent.parentId) spans.push(span(` ← ${plainText(agent.parentId)}`, "dim"));
		body.push(
			node(
				"row",
				{ gap: "sm", role: "omp.wait.agent" },
				[
					node("badge", {
						text: agent.live ? "agent" : "agent · no turn",
						tone: agent.live ? "accent" : "warning",
					}),
					text(spans, { truncate: "end", grow: 1 }),
					elapsed(agent.ageMs, !agent.live || !isPartial),
				],
				`agent:${agent.id}`,
			),
		);
	}
	return {
		head,
		tone: counts.failed > 0 ? "warning" : counts.running > 0 || agents.length > 0 ? "info" : "success",
		// The tiles are what a wait shows: clamping the body by lines would cut them.
		preview: "children",
		body,
	};
}

/** Received-message view: sender head, terminal-clocked age, markdown body. */
function describeMessage(
	from: string,
	ts: number | undefined,
	bodyText: string,
	meta: readonly string[],
): NativeToolView {
	const head: TspSpan[] = [span(`IRC ← ${plainText(from)}`, "toolTitle strong")];
	for (const part of meta) head.push(span(` ${part}`, "muted"));
	return {
		head,
		tone: "info",
		preview: { lines: BODY_LINES_COLLAPSED + 1 },
		body: compact([
			ts
				? row([text([span("received", "dim")]), elapsed(Date.now() - ts), text([span("ago", "dim")])], {
						gap: "xs",
					})
				: undefined,
			bodyText.trim() ? md(bodyText) : undefined,
		]),
	};
}

const waitResultMemo = new OwnerMemo<NativeToolView | undefined>();

/** Render either a received message or a background-job snapshot. */
export const waitToolRenderer = {
	inline: true,
	mergeCallAndResult: true,
	activitySummary(): ToolActivitySummary {
		return { label: "Wait", detail: "Background work or peer message" };
	},
	renderCall: waitRenderCall,
	describeCall(): NativeToolView {
		return { head: toolHead("Wait"), inline: true };
	},
	describeResult(
		result: ToolRenderResult<CoordinationDetails>,
		options: RenderResultOptions,
	): NativeToolView | undefined {
		return waitResultMemo.get(result, [options.isPartial, widgetStamp(result.details?.jobs)], () => {
			if (result.isError) return errorView("Wait", resultText(result));
			const details = result.details;
			if (details?.interrupted) {
				return {
					head: toolHead("Wait", "interrupted by message"),
					tone: "info",
					inline: true,
				};
			}
			const waited = details?.waited;
			if (!waited) return describeJobsResult(result, options.isPartial);
			return describeMessage(waited.from, waited.ts, waited.body, waited.replyTo ? ["reply"] : []);
		});
	},
	renderResult(
		result: {
			content: Array<{ type: string; text?: string }>;
			details?: CoordinationDetails;
			isError?: boolean;
		},
		options: RenderResultOptions,
		uiTheme: Theme,
	): Component {
		if (result.details?.interrupted && !result.isError) {
			return new Text(
				renderStatusLine({ icon: "info", title: "Wait", meta: ["interrupted by message"] }, uiTheme),
				0,
				0,
			);
		}
		const waited = result.details?.waited;
		if (!waited) return jobsRenderResult(result, options, uiTheme);
		return createCachedComponent(
			() => options.expanded,
			(width, expanded) =>
				[
					renderStatusLine(
						{
							iconOverride: ircGlyph(uiTheme),
							title: `IRC ${uiTheme.nav.back} ${replaceTabs(waited.from)}`,
							meta: [messageAge(waited.ts), ...(waited.replyTo ? ["reply"] : [])],
						},
						uiTheme,
					),
					...bodyLines(waited.body, expanded, uiTheme, width, { indent: "  " }),
				].map(line => truncateToWidth(line, width, Ellipsis.Unicode)),
		);
	},
} satisfies ToolRenderer<object, CoordinationDetails>;
