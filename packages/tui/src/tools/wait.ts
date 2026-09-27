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
} from "../render/render-utils";
import type { StructuredSubagentOutput } from "./task";
import type { RenderResultOptions, ToolRenderer, ToolActivitySummary } from "./renderer";
import type { IrcDeliveryReceipt, IrcMessage } from "./irc";

/** Whether a wait snapshot contains only running jobs and no cancellations. */
export function isWaitingPollDetails(details: unknown): boolean {
	const d = details as CoordinationDetails | undefined;
	if (!d || !Array.isArray(d.jobs) || d.jobs.length === 0) return false;
	if (d.cancelled?.length) return false;
	return d.jobs.every(job => job?.status === "running");
}
/** Coordination details retained by wait and background job operations. */
export type CoordinationOp = "send" | "wait" | "jobs" | "cancel";

/** Background-job row surfaced by `wait`/`cancel`/`jobs` results. */
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

/** Pending wait frame. */
function waitRenderCall(_args: object, _options: RenderResultOptions, uiTheme: Theme): Component {
	return new Text(renderStatusLine({ icon: "pending", title: "Wait" }, uiTheme), 0, 0);
}

/** Result frame for wait snapshots and the agents roster. */
function jobsRenderResult(
	result: { content: Array<{ type: string; text?: string }>; details?: CoordinationDetails; isError?: boolean },
	options: RenderResultOptions,
	uiTheme: Theme,
): Component {
	let jobs = result.details?.jobs ?? [];
	const agents = result.details?.agents ?? [];

	if (jobs.length === 0 && agents.length === 0) {
		const fallback = result.content?.find(c => c.type === "text")?.text || "No jobs to process";
		const header = renderStatusLine({ icon: "warning", title: "Wait" }, uiTheme);
		return new Text([header, formatEmptyMessage(fallback, uiTheme)].join("\n"), 0, 0);
	}

	// Agent-carrying results (jobs snapshot / empty-wait roster) are real
	// snapshots, not displaceable waiting frames — only agentless waits
	// collapse their still-running rows once sealed.
	if (!options.isPartial && agents.length === 0) {
		jobs = jobs.filter(job => job.status !== "running");
		if (jobs.length === 0) {
			return new Text("", 0, 0);
		}
	}

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
				.digest();
			if (!shimmerActive && cached?.key === key) return cached.lines;

			const itemLines = renderTreeList<JobSnapshot>(
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
						const durationSuffix = `${uiTheme.sep.dot}${uiTheme.fg("dim", formatDuration(job.durationMs))}`;
						const displayId = truncateToWidth(
							replaceTabs(job.id).replace(/\s+/g, " "),
							Math.max(0, rowWidth - visibleWidth(`${icon} ${typeBadge} ${durationSuffix}`)),
							Ellipsis.Unicode,
						);
						const rawLabelLines = (job.label || "(no label)").split(/\r?\n/);
						const maxLabelLines = expanded ? LABEL_LINES_EXPANDED : LABEL_LINES_COLLAPSED;
						const visibleLabelLines = rawLabelLines
							.slice(0, maxLabelLines)
							.map(l => truncateToWidth(replaceTabs(l), LABEL_MAX_WIDTH, Ellipsis.Unicode));
						if (rawLabelLines.length > maxLabelLines && visibleLabelLines.length > 0) {
							const last = visibleLabelLines[visibleLabelLines.length - 1]!;
							visibleLabelLines[visibleLabelLines.length - 1] = `${last} …`;
						}
						const rowPrefix = `${icon} ${typeBadge} `;
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
											Math.max(0, rowWidth - visibleWidth(`${rowPrefix}${displayId}${durationSuffix}`) - 1),
										),
									)
								: "";
						const modelLead = modelBadge ? `${modelBadge} ` : "";
						const headRaw = displayId;
						// Running rows in a live block shimmer their label; once the block
						// stops animating (sealed, or a settled snapshot — spinnerFrame
						// cleared) they render static so scrollback never keeps a mid-sweep
						// shimmer band.
						const live = job.status === "running" && options.spinnerFrame !== undefined;
						const headLabel = live
							? shimmerEnabled()
								? shimmerText(headRaw, uiTheme)
								: uiTheme.fg("accent", headRaw)
							: uiTheme.fg("toolOutput", headRaw);
						let row = `${rowPrefix}${modelLead}${headLabel}`;
						const distinctLabel = job.label.trim() !== job.id;
						const label = visibleLabelLines[0] ?? "";
						const inlineLabel = distinctLabel && visibleWidth(`${row} ${label}${durationSuffix}`) <= rowWidth;
						if (inlineLabel) row += ` ${uiTheme.fg("toolOutput", label)}`;
						row += durationSuffix;
						lines.push(truncateToWidth(row, rowWidth, ""));
						const continuationWidth = Math.max(0, rowWidth - visibleWidth("  "));
						for (let i = distinctLabel && !inlineLabel ? 0 : 1; i < visibleLabelLines.length; i++) {
							lines.push(
								`  ${uiTheme.fg("toolOutput", truncateToWidth(visibleLabelLines[i]!, continuationWidth))}`,
							);
						}
						const artifactError = job.meta?.artifactError ?? job.artifactError;
						if (artifactError) {
							lines.push(
								uiTheme.fg("warning", truncateToWidth(formatArtifactErrorNotice(artifactError), rowWidth)),
							);
						}

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
						if (preview) {
							const maxLines = expanded ? PREVIEW_LINES_EXPANDED : PREVIEW_LINES_COLLAPSED;
							const previewLines = getPreviewLines(
								preview,
								maxLines,
								Math.min(PREVIEW_LINE_WIDTH, continuationWidth),
								Ellipsis.Unicode,
							);
							const tone = job.errorText ? "error" : "dim";
							for (const pl of previewLines) {
								lines.push(`  ${uiTheme.fg(tone, pl)}`);
							}
						}
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

			const all = [header];
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
const BODY_LINES_EXPANDED = 12;
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
	options: { indent?: string; tone?: "dim" | "toolOutput"; collapsedLines?: number } = {},
): string[] {
	const indent = options.indent ?? "";
	const tone = options.tone ?? "toolOutput";
	const max = expanded ? BODY_LINES_EXPANDED : (options.collapsedLines ?? BODY_LINES_COLLAPSED);
	const preview = cappedHeadLines(
		body.split("\n").filter(line => line.trim()),
		max,
	);
	const quote = theme.fg("dim", theme.md.quoteBorder);
	const lines = preview.lines.map(
		line =>
			`${indent}${quote} ${theme.fg(tone, replaceTabs(truncateToWidth(line.trim(), BODY_LINE_WIDTH, Ellipsis.Unicode)))}`,
	);
	const hidden = preview.hidden;
	if (hidden > 0) {
		lines.push(`${indent}${quote} ${theme.fg("dim", `… +${hidden} more ${hidden === 1 ? "line" : "lines"}`)}`);
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
	return createCachedComponent(
		getExpanded,
		(width, expanded) => {
			const lines = [renderStatusLine({ iconOverride: ircGlyph(uiTheme), title, meta }, uiTheme)];
			if (body.trim()) {
				lines.push(...bodyLines(body, expanded, uiTheme, { indent: "  ", collapsedLines: 3 }));
			}
			return lines.map(line => truncateToWidth(line, width, Ellipsis.Unicode));
		},
		{ paddingX: 1 },
	);
}

/** Render either a received message or a background-job snapshot. */
export const waitToolRenderer = {
	inline: true,
	mergeCallAndResult: true,
	activitySummary(): ToolActivitySummary {
		return { label: "Wait", detail: "Background work or peer message" };
	},
	renderCall: waitRenderCall,
	renderResult(
		result: { content: Array<{ type: string; text?: string }>; details?: CoordinationDetails; isError?: boolean },
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
					...bodyLines(waited.body, expanded, uiTheme, { indent: "  " }),
				].map(line => truncateToWidth(line, width, Ellipsis.Unicode)),
		);
	},
} satisfies ToolRenderer<object, CoordinationDetails>;
