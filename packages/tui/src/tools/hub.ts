import { styleTerminalRow } from "./terminal-output";
import { TERMINAL_STATES } from "../apps/ps-data";
import type { Component } from "../tui";
import { Text } from "../components/text";
import { visibleWidth } from "../utils";
import { formatAge, pluralize } from "@oh-my-pi/pi-utils";
import { shimmerEnabled, shimmerText } from "../theme/shimmer";
import type { Theme, ThemeColor } from "../theme/theme";
import { Ellipsis, Hasher, type RenderCache, renderStatusLine, renderTreeList, truncateToWidth } from "../render/index";
import { framedToolCard } from "../render/tool-card";
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
	capPreviewLines,
	cappedHeadLines,
	createCachedComponent,
	DEFAULT_TERMINAL_PREVIEW_LINES,
	formatMoreItems,
	formatExpandHint,
	previewLine,
	TRUNCATE_LENGTHS,
	shortenPath,
	formatErrorDetail,
	type ConfiguredThinkingLevel,
} from "../render/render-utils";
import type { StructuredSubagentOutput } from "./task";
import type { RenderResultOptions, ToolRenderer, ToolActivitySummary } from "./renderer";

/** Whether a wait snapshot contains only running jobs and no cancellations. */
export function isWaitingPollDetails(details: unknown): boolean {
	const d = details as CoordinationDetails | undefined;
	if (!d || !Array.isArray(d.jobs) || d.jobs.length === 0) return false;
	if (d.cancelled?.length) return false;
	return d.jobs.every(job => job?.status === "running");
}
/**
 * Hub operations: messaging (`send`/`wait`/`inbox`/`list`), jobs
 * (`wait`/`cancel`/`jobs`), and process supervision (`start`/`ps`/`logs`/
 * `stop`/`restart`/`describe`, plus `send`/`wait` when they carry `name`).
 */
export type HubOp =
	| "send"
	| "wait"
	| "inbox"
	| "list"
	| "jobs"
	| "cancel"
	| "start"
	| "ps"
	| "logs"
	| "stop"
	| "restart"
	| "describe";

/** Peer row surfaced by `op:"list"`. */
export interface HubPeerInfo {
	id: string;
	displayName: string;
	kind: string;
	status: string;
	parentId?: string;
	unread: number;
	lastActivity: number;
	activity?: string;
}

/** Status values `op:"list"` can filter on. Advisor is a kind, not a status. */
export type HubListStatus = "running" | "idle" | "parked";

/** Model-facing roster bounds shared by the hub schema and executor. */
export const DEFAULT_HUB_LIST_LIMIT = 32;

/** Maximum number of peers in a hub roster page. */
export const MAX_HUB_LIST_LIMIT = 100;

/** Addressable roster tallies always returned by `op:"list"`. */
export interface HubRosterCounts {
	running: number;
	idle: number;
	parked: number;
	shown: number;
	truncated: number;
}

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
 * a hub message, or a spawn owned by another agent. Surfaced by `jobs` and
 * empty-wait snapshots so the hub's picture matches the UI's running-agent
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
	 * wiring up or a stale registration that `hub cancel <id>` clears (#8634).
	 */
	live: boolean;
	/**
	 * Acceptance time of the agent's final result, when the registry recorded
	 * one. With `live: false` this is an accepted run the parent may cancel
	 * instead of waiting on (#11079).
	 */
	acceptedAt?: number;
}

/** Result details for messaging and job ops; fields are disjoint per op. */
export interface CoordinationDetails {
	meta?: OutputMeta;
	op: HubOp;
	from?: string;
	to?: string;
	receipts?: IrcDeliveryReceipt[];
	/** Message consumed by `wait` / `send await:true`; null when the wait timed out. */
	waited?: IrcMessage | null;
	inbox?: IrcMessage[];
	peers?: HubPeerInfo[];
	/** Present on `op:"list"`: addressable running/idle/parked plus page size. */
	counts?: HubRosterCounts;
	jobs?: JobSnapshot[];
	cancelled?: { id: string; status: CancelStatus }[];
	/** Running subagents not represented by a job row in this result. */
	agents?: AgentActivitySnapshot[];
}

/** Hub result details: coordination snapshots or launch (process) state. */
export type HubDetails = CoordinationDetails | LaunchToolDetails;

/** Partially-streamed hub call arguments, as seen by the renderers. */
export type HubRenderArgs = {
	op?: string;
	to?: string;
	message?: string;
	replyTo?: string;
	await?: boolean;
	from?: string;
	peek?: boolean;
	ids?: string[];
} & Partial<Omit<LaunchParams, "op">>;
/** Stable lifecycle states exposed by the launch tool. */
export type DaemonState = "starting" | "running" | "ready" | "restarting" | "stopping" | "exited" | "failed";

/** Restart behavior applied after an unexpected daemon exit. */
export type DaemonRestartPolicy = "no" | "on-failure" | "always";

/** Readiness conditions; every configured condition must pass. */
export interface DaemonReadySpec {
	log?: string;
	port?: number;
	host?: string;
	timeoutMs: number;
}

/** Immutable launch specification retained for restart and inspection. */
export interface DaemonSpec {
	name: string;
	application: string;
	args: string[];
	env: Record<string, string>;
	cwd: string;
	pty: boolean;
	ready?: DaemonReadySpec;
	restart: DaemonRestartPolicy;
	persist: boolean;
	detached: boolean;
}

/** Serializable daemon state visible to every client in one broker scope. */
export interface DaemonSnapshot {
	name: string;
	id: string;
	state: DaemonState;
	pid?: number;
	createdAt: number;
	startedAt: number;
	readyAt?: number;
	exitedAt?: number;
	exitCode?: number;
	exitReason?: string;
	restartCount: number;
	outputBytes: number;
	owner?: string;
	readyMatch?: string;
	/** Readiness conditions still unmet while `state` is `starting`; absent once ready or without a ready spec. */
	readyPending?: ("log" | "port")[];
	persist: boolean;
	detached: boolean;
}
/** Serializable peer message retained in hub result snapshots. */
export interface IrcMessage {
	id: string;
	/** Sender agent id. */
	from: string;
	/** Recipient agent id (resolved; "all" is expanded by the tool, not stored). */
	to: string;
	body: string;
	ts: number;
	/** Message id being answered. */
	replyTo?: string;
	/**
	 * Automated wake-turn relay of a woken subagent's stop output (task executor
	 * `relayWakeTurnOutput`). Relays are answers, never wake sources: the
	 * recipient's own wake-turn relay must skip them or two idle peers
	 * ping-pong forever.
	 */
	wakeRelay?: boolean;
}

/** Delivery outcome for one peer recipient. */
export interface IrcDeliveryReceipt {
	to: string;
	outcome: "injected" | "woken" | "revived" | "failed";
	error?: string;
}
/** Broker-facing launch parameters; the hub adapts its `ps` op to `list` before calling in. */
export interface LaunchParams {
	op: "start" | "list" | "logs" | "wait" | "send" | "stop" | "restart" | "describe";
	name?: string;
	application?: string;
	args?: string[];
	env?: Record<string, string>;
	cwd?: string;
	pty?: boolean;
	ready?: { log?: string; port?: number; host?: string; timeout?: number };
	restart?: "no" | "on-failure" | "always";
	persist?: boolean;
	detached?: boolean;
	lines?: number;
	head?: boolean;
	grep?: string;
	follow?: boolean;
	cursor?: number;
	for?: "ready" | "exit";
	pattern?: string;
	text?: string;
	enter?: boolean;
	keys?: string[];
	signal?: "SIGINT" | "SIGTERM" | "SIGHUP" | "SIGQUIT" | "SIGKILL";
	timeout?: number;
}

/** Structured launch state retained for compact TUI rendering. */
export interface LaunchToolDetails {
	op: LaunchParams["op"];
	daemon?: DaemonSnapshot;
	daemons?: DaemonSnapshot[];
	cursor?: number;
	timedOut?: boolean;
	/** logs: daemon lifecycle state at read time. */
	state?: DaemonState;
	/** logs: virtual terminal rows for display; model-facing content remains sanitized text. */
	terminalRows?: string[];
	/** wait: output line that satisfied the pattern. */
	matched?: string;
	/** describe: immutable launch spec backing the command/cwd detail lines. */
	spec?: DaemonSpec;
}

/**
 * Human sentences for the readiness conditions still unmet, e.g.
 * `port 5173 on 127.0.0.1 never accepted connections`. `ready` (from the start
 * params) adds the concrete pattern/port; absent it falls back to generic labels.
 */
export function readyPendingSummary(daemon: DaemonSnapshot, ready?: LaunchParams["ready"]): string[] {
	const parts: string[] = [];
	for (const condition of daemon.readyPending ?? []) {
		if (condition === "log") {
			parts.push(ready?.log ? `log pattern /${ready.log}/ never matched` : "the log pattern never matched");
		} else {
			parts.push(
				ready?.port !== undefined
					? `port ${ready.port} on ${ready.host ?? "127.0.0.1"} never accepted connections`
					: "the port never accepted connections",
			);
		}
	}
	return parts;
}

/**
 * What a timed-out `wait` was actually blocked on: the output `pattern`, the
 * process exiting (`for: "exit"`, the default), or the unmet readiness
 * conditions (`for: "ready"`). Never reports readiness for an exit/pattern
 * wait — the process may well be ready and simply still running.
 */
export function waitPendingSummary(daemon: DaemonSnapshot, params: Pick<LaunchParams, "for" | "pattern">): string[] {
	if (params.pattern) return [`output pattern /${params.pattern}/ never matched`];
	if ((params.for ?? "exit") === "exit") return [`process exit (still ${daemon.state})`];
	const pending = readyPendingSummary(daemon);
	return pending.length > 0 ? pending : [`readiness (still ${daemon.state})`];
}
/** Hub roster ordering (running before idle before parked) shared with the child prompt's live-row cap. */
export const LIST_STATUS_ORDER: Record<string, number> = { running: 0, idle: 1, parked: 2 };

// =============================================================================
// TUI Renderer (jobs half)
// =============================================================================

interface JobRenderArgs {
	poll?: string[];
	cancel?: string[];
	list?: boolean;
}

/** Hub args → legacy job-renderer arg shape, preserving the exact frame titles. */
function toJobRenderArgs(args: HubRenderArgs | undefined): JobRenderArgs | undefined {
	if (!args) return undefined;
	switch (args.op) {
		case "wait":
			return { poll: args.ids };
		case "cancel":
			return { cancel: args.ids ?? [] };
		case "jobs":
			return { list: true };
		default:
			return {};
	}
}

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

function describeTarget(args: JobRenderArgs | undefined): string {
	if (args?.list) return "background jobs";
	const poll = args?.poll ?? [];
	const cancel = args?.cancel ?? [];
	const parts: string[] = [];
	if (cancel.length > 0) {
		parts.push(cancel.length === 1 ? `cancel ${cancel[0]}` : `cancel ${cancel.length} jobs`);
	}
	if (poll.length > 0) {
		parts.push(poll.length === 1 ? `poll ${poll[0]}` : `poll ${poll.length} jobs`);
	}
	if (parts.length === 0) return "all running jobs";
	return parts.join(", ");
}

/** Pending-call frame for job ops (wait/cancel/jobs). */
export function jobsRenderCall(args: HubRenderArgs, _options: RenderResultOptions, uiTheme: Theme): Component {
	const text = renderStatusLine({ icon: "pending", title: describeTarget(toJobRenderArgs(args)) || "Job" }, uiTheme);
	return new Text(text, 0, 0);
}

/** Result frame for job snapshots (wait/cancel/jobs and the agents roster). */
export function jobsRenderResult(
	result: { content: Array<{ type: string; text?: string }>; details?: CoordinationDetails; isError?: boolean },
	options: RenderResultOptions,
	uiTheme: Theme,
	hubArgs?: HubRenderArgs,
): Component {
	const args = toJobRenderArgs(hubArgs);
	let jobs = result.details?.jobs ?? [];
	const agents = result.details?.agents ?? [];

	if (jobs.length === 0 && agents.length === 0) {
		const fallback = result.content?.find(c => c.type === "text")?.text || "No jobs to process";
		const header = renderStatusLine({ icon: "warning", title: describeTarget(args) || "Job" }, uiTheme);
		return new Text([header, formatEmptyMessage(fallback, uiTheme)].join("\n"), 0, 0);
	}

	const isPollCall = args ? !args.list && (!args.cancel || args.cancel.length === 0 || args.poll !== undefined) : true;

	// Agent-carrying results (jobs snapshot / empty-wait roster) are real
	// snapshots, not displaceable waiting frames — only agentless waits
	// collapse their still-running rows once sealed.
	if (!options.isPartial && isPollCall && agents.length === 0) {
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
						const icon = formatStatusIcon(
							statusToIcon(job.status),
							uiTheme,
							job.status === "running" ? options.spinnerFrame : undefined,
						);
						const typeBadge = formatBadge(job.type, statusToColor(job.status), uiTheme);
						const exitCodeSuffix =
							job.exitCode === undefined
								? ""
								: `${uiTheme.sep.dot}${uiTheme.fg(job.exitCode === 0 ? "muted" : "error", `exit ${job.exitCode}`)}`;
						const durationSuffix = `${exitCodeSuffix}${uiTheme.sep.dot}${uiTheme.fg("dim", formatDuration(job.durationMs))}`;
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
// TUI Renderer (launch half)
// =============================================================================

/** Args shape visible to the renderer, possibly mid-stream (every field optional). */
export type LaunchRenderArgs = Partial<Omit<LaunchParams, "op">> & { op?: string };

function stateColor(state: DaemonState): ThemeColor {
	switch (state) {
		case "running":
		case "ready":
			return "success";
		case "failed":
			return "error";
		case "exited":
			return "muted";
		default:
			return "warning";
	}
}

/** Compact `state · pid · uptime` fragments for the status-line meta slot. */
function daemonMeta(daemon: DaemonSnapshot, theme: Theme): string[] {
	const meta = [theme.fg(stateColor(daemon.state), daemon.state)];
	if (daemon.readyPending?.length) meta.push(theme.fg("warning", `waiting on ${daemon.readyPending.join("+")}`));
	if (daemon.exitCode !== undefined) {
		meta.push(theme.fg(daemon.exitCode === 0 ? "muted" : "error", `exit ${daemon.exitCode}`));
	} else if (daemon.pid !== undefined) {
		meta.push(`pid ${daemon.pid}`);
	}
	const lifespan = formatDuration((daemon.exitedAt ?? Date.now()) - daemon.startedAt);
	meta.push(daemon.exitedAt === undefined ? `up ${lifespan}` : `ran ${lifespan}`);
	if (daemon.restartCount > 0) meta.push(`restarts ${daemon.restartCount}`);
	if (daemon.detached) meta.push("detached");
	else if (daemon.persist) meta.push("persistent");
	return meta;
}

/** Op-specific call context (command line, log filters, wait condition, send payload). */
function launchCallMeta(args: LaunchRenderArgs): string[] {
	const meta: string[] = [];
	switch (args.op) {
		case "start":
			if (args.application) meta.push([args.application, ...(args.args ?? [])].join(" "));
			break;
		case "logs":
			if (args.follow) meta.push("follow");
			if (args.grep) meta.push(`grep /${args.grep}/`);
			break;
		case "wait":
			meta.push(args.pattern ? `for /${args.pattern}/` : `for ${args.for ?? "exit"}`);
			break;
		case "send":
			if (args.signal) meta.push(args.signal);
			else if (args.text) meta.push(args.text);
			if (args.keys?.length) meta.push(args.keys.join(" "));
			break;
	}
	return meta.map(entry => previewLine(replaceTabs(entry), TRUNCATE_LENGTHS.SHORT));
}

/** Pending-call frame for launch ops; consumes the spinner while the broker call is live. */
export function launchRenderCall(args: LaunchRenderArgs, options: RenderResultOptions, theme: Theme): Component {
	const target = args.name ?? args.application;
	const header = renderStatusLine(
		{
			icon: options.spinnerFrame !== undefined ? "running" : "pending",
			spinnerFrame: options.spinnerFrame,
			title: `Launch ${args.op ?? "…"}`,
			description: target ? replaceTabs(target) : undefined,
			meta: launchCallMeta(args),
		},
		theme,
	);
	return new Text(header, 0, 0);
}

/** Result frame: one status header per op, meta from structured details, capped body lines. */
export function launchRenderResult(
	result: { content: Array<{ type: string; text?: string }>; details?: LaunchToolDetails; isError?: boolean },
	options: RenderResultOptions,
	theme: Theme,
	args?: LaunchRenderArgs,
): Component {
	const details = result.details;
	const params = args ?? {};
	const op = details?.op ?? params.op;
	const isError = result.isError === true;
	const daemon = details?.daemon;
	const failed = isError || daemon?.state === "failed";
	const text =
		result.content
			?.filter(item => item.type === "text")
			.map(item => item.text ?? "")
			.join("\n") ?? "";

	const meta: string[] = [];
	const body: string[] = [];
	let description = params.name ?? daemon?.name;

	if (isError) {
		for (const line of replaceTabs(text.trimEnd()).split("\n")) body.push(theme.fg("error", line));
	} else {
		switch (op) {
			case "start": {
				meta.push(...launchCallMeta(params));
				if (daemon) meta.push(...daemonMeta(daemon, theme));
				if (daemon?.readyMatch) body.push(theme.fg("dim", `log matched: ${replaceTabs(daemon.readyMatch)}`));
				if (daemon?.state === "failed" && daemon.exitReason)
					body.push(theme.fg("error", replaceTabs(daemon.exitReason)));
				if (details?.timedOut) {
					const pending = daemon ? readyPendingSummary(daemon, params.ready) : [];
					body.push(
						theme.fg(
							"warning",
							pending.length > 0
								? `Not ready — ${pending.join("; ")}. Still running.`
								: "Readiness timed out; the process is still running.",
						),
					);
				} else if (params.ready && daemon && daemon.readyAt === undefined && TERMINAL_STATES[daemon.state]) {
					body.push(theme.fg("warning", "Process exited before readiness was observed."));
				}
				break;
			}
			case "send":
				meta.push(...launchCallMeta(params));
				if (daemon) meta.push(...daemonMeta(daemon, theme));
				break;
			case "stop":
			case "restart":
				if (daemon) meta.push(...daemonMeta(daemon, theme));
				break;
			case "wait": {
				meta.push(...launchCallMeta(params));
				if (daemon) meta.push(...daemonMeta(daemon, theme));
				if (details?.matched) body.push(theme.fg("dim", `matched: ${replaceTabs(details.matched)}`));
				if (details?.timedOut) {
					body.push(
						theme.fg(
							"warning",
							daemon
								? `Wait timed out — still waiting on ${waitPendingSummary(daemon, params).join("; ")}.`
								: "Wait timed out.",
						),
					);
				}
				break;
			}
			case "list": {
				const daemons = details?.daemons ?? [];
				description = `${daemons.length || "no"} ${pluralize("process", daemons.length)}`;
				for (const item of daemons) {
					body.push(
						`${theme.fg("accent", replaceTabs(item.name))} ${theme.fg("dim", daemonMeta(item, theme).join(theme.sep.dot))}`,
					);
				}
				break;
			}
			case "logs": {
				if (details?.state) meta.push(theme.fg(stateColor(details.state), details.state));
				if (details?.cursor !== undefined) meta.push(`cursor ${details.cursor}`);
				if (details?.timedOut) meta.push(theme.fg("warning", "follow timed out"));
				// Strip the trailing `[name: state; cursor=N]` status suffix `toolContent` appends.
				const logText = text.replace(/\n?\[[^\n]*\]$/, "").trimEnd();
				const terminalRows = details?.terminalRows;
				if (terminalRows) {
					for (const row of terminalRows) body.push(styleTerminalRow(row, theme.getFgAnsi("toolOutput")));
				} else if (logText) {
					for (const line of logText.split("\n")) body.push(theme.fg("toolOutput", replaceTabs(line)));
				}
				break;
			}
			case "describe": {
				if (daemon) meta.push(...daemonMeta(daemon, theme));
				const spec = details?.spec;
				if (spec) {
					body.push(theme.fg("toolOutput", replaceTabs([spec.application, ...spec.args].join(" "))));
					body.push(theme.fg("dim", `cwd ${shortenPath(spec.cwd)}`));
					const flags = [`pty ${spec.pty}`, `restart ${spec.restart}`];
					if (spec.detached) flags.push("detached");
					else if (spec.persist) flags.push("persistent");
					body.push(theme.fg("dim", flags.join(theme.sep.dot)));
				}
				break;
			}
			default:
				if (text.trim()) {
					for (const line of replaceTabs(text.trimEnd()).split("\n")) body.push(theme.fg("toolOutput", line));
				}
		}
	}

	const header = renderStatusLine(
		{
			...(failed
				? { icon: "error" as const }
				: options.isPartial
					? { icon: "pending" as const }
					: { iconOverride: theme.styledSymbol("tool.launch", "accent") }),
			title: `Launch ${op ?? ""}`.trimEnd(),
			description: description ? replaceTabs(description) : undefined,
			meta,
		},
		theme,
	);

	if (op === "logs") {
		return framedToolCard(theme, ({ contentWidth }) => {
			const rows = body.map(line => truncateToWidth(line, contentWidth));
			return {
				header,
				phase: options.isPartial ? "partial" : failed ? "error" : "success",
				sections: [
					{
						label: theme.fg("toolTitle", "Output"),
						content: capPreviewLines(rows, theme, {
							expanded: options.expanded,
							max: DEFAULT_TERMINAL_PREVIEW_LINES,
						}),
					},
				],
			};
		});
	}

	return createCachedComponent(
		() => options.expanded,
		(width, expanded) => {
			let visible = body;
			if (!expanded && op === "list" && body.length > PREVIEW_LIMITS.COLLAPSED_ITEMS) {
				const remaining = body.length - PREVIEW_LIMITS.COLLAPSED_ITEMS;
				visible = [
					...body.slice(0, PREVIEW_LIMITS.COLLAPSED_ITEMS),
					theme.fg("dim", `${formatMoreItems(remaining, "process")} ${formatExpandHint(theme, false, true)}`),
				];
			}
			return [header, ...visible].map(line => truncateToWidth(line, width));
		},
	);
}

// =============================================================================
// TUI Renderer (messaging half)
// =============================================================================

const BODY_LINES_COLLAPSED = 2;
const BODY_LINES_EXPANDED = 12;
const BODY_LINE_WIDTH = 100;

function ircGlyph(theme: Theme): string {
	return theme.styledSymbol("tool.irc", "accent");
}

function outcomeColor(outcome: IrcDeliveryReceipt["outcome"]): ToolUIColor {
	switch (outcome) {
		case "woken":
			return "success";
		case "revived":
			return "warning";
		case "injected":
			return "accent";
		case "failed":
			return "error";
	}
}

/** Glyph + status word, matching the agent-hub status conventions. */
function peerStatusBadge(status: string, theme: Theme): string {
	switch (status) {
		case "running":
			return theme.fg("accent", `${theme.status.running} running`);
		case "idle":
			return theme.fg("success", `${theme.status.enabled} idle`);
		case "parked":
			return theme.fg("muted", `${theme.status.shadowed} parked`);
		default:
			return theme.fg("error", `${theme.status.aborted} ${status}`);
	}
}

function messageAge(ts: number | undefined): string {
	if (!ts) return "";
	return formatAge(Math.max(1, Math.round((Date.now() - ts) / 1000)));
}

function firstTextBlock(result: { content: Array<{ type: string; text?: string }> }): string {
	return result.content.find(part => part.type === "text")?.text?.trim() ?? "";
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

/** Header title carrying the op direction: `IRC ➤ peer` out, `IRC ⟵ peer` in. */
function callTitle(args: HubRenderArgs | undefined, theme: Theme): string {
	switch (args?.op) {
		case "send":
			return `IRC ${theme.nav.selected} ${args.to?.trim() || "…"}`;
		case "wait":
			return `IRC ${theme.nav.back} ${args.from?.trim() || "anyone"}`;
		case "inbox":
			return "IRC inbox";
		case "list":
			return "IRC peers";
		default:
			return "Hub";
	}
}

function messagingCallMeta(args: HubRenderArgs | undefined): string[] {
	const meta: string[] = [];
	if (args?.op === "send") {
		if (args.to === "all") meta.push("broadcast");
		if (args.await) meta.push("await reply");
		if (args.replyTo) meta.push("reply");
	}
	if (args?.op === "inbox" && args.peek) meta.push("peek");
	return meta;
}

function renderErrorResult(
	result: { content: Array<{ type: string; text?: string }> },
	args: HubRenderArgs | undefined,
	theme: Theme,
): string[] {
	const text = firstTextBlock(result) || "IRC call failed.";
	return [
		renderStatusLine({ icon: "error", title: callTitle(args, theme), meta: messagingCallMeta(args) }, theme),
		formatErrorDetail(text, theme),
	];
}

/**
 * Display-only transcript card for live IRC traffic: `irc:incoming` DMs
 * delivered to this session, `irc:autoreply` side-channel replies sent on
 * this session's behalf, and `irc:relay` observations of agent↔agent
 * traffic. Shares the tool renderer's glyph + quote-border conventions so
 * cards and hub messaging output look identical in the transcript.
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

function renderSendResult(
	result: { content: Array<{ type: string; text?: string }>; isError?: boolean },
	details: Partial<CoordinationDetails>,
	args: HubRenderArgs | undefined,
	expanded: boolean,
	theme: Theme,
): string[] {
	const receipts = details.receipts ?? [];
	const to = details.to ?? args?.to?.trim() ?? "?";
	const title = `IRC ${theme.nav.selected} ${to}`;

	// Pre-delivery failures (validation) and empty broadcasts carry no receipts.
	if (receipts.length === 0) {
		const text = firstTextBlock(result) || (result.isError ? "Send failed." : "Nothing to deliver.");
		return [
			renderStatusLine({ icon: result.isError ? "error" : "warning", title }, theme),
			result.isError ? formatErrorDetail(text, theme) : `  ${theme.fg("muted", replaceTabs(text))}`,
		];
	}

	const delivered = receipts.filter(receipt => receipt.outcome !== "failed");
	const failedCount = receipts.length - delivered.length;
	const waited = details.waited;
	const timedOut = waited === null;

	const meta: string[] = [];
	if (to === "all") meta.push("broadcast");
	if (receipts.length === 1) {
		const receipt = receipts[0]!;
		meta.push(theme.fg(outcomeColor(receipt.outcome), receipt.outcome));
	} else {
		if (delivered.length > 0) meta.push(theme.fg("success", `${delivered.length} delivered`));
		if (failedCount > 0) meta.push(theme.fg("error", `${failedCount} failed`));
	}
	if (timedOut) meta.push(theme.fg("warning", "no reply"));

	const icon = result.isError
		? { icon: "error" as const }
		: timedOut
			? { icon: "warning" as const }
			: { iconOverride: ircGlyph(theme) };
	const lines = [renderStatusLine({ ...icon, title, meta }, theme)];

	const sent = args?.message?.trim();
	if (sent) lines.push(...bodyLines(sent, expanded, theme, { indent: "  ", tone: "dim" }));

	if (receipts.length > 1 || failedCount > 0) {
		lines.push(
			...renderTreeList<IrcDeliveryReceipt>(
				{
					items: receipts,
					expanded,
					maxCollapsed: PREVIEW_LIMITS.COLLAPSED_ITEMS,
					itemType: "recipient",
					renderItem: receipt => {
						const badge = formatBadge(receipt.outcome, outcomeColor(receipt.outcome), theme);
						const error =
							receipt.outcome === "failed" && receipt.error
								? ` ${theme.fg("error", `${theme.format.dash} ${receipt.error}`)}`
								: "";
						return `${theme.fg("toolOutput", receipt.to)} ${badge}${error}`;
					},
				},
				theme,
			),
		);
	}

	if (waited) {
		const age = messageAge(waited.ts);
		lines.push(
			`  ${theme.fg("dim", theme.nav.back)} ${theme.fg("accent", waited.from)}${age ? ` ${theme.fg("dim", age)}` : ""}`,
		);
		lines.push(...bodyLines(waited.body, expanded, theme, { indent: "  " }));
	} else if (timedOut) {
		lines.push(`  ${theme.fg("warning", "No reply yet — they may answer later; check inbox or wait again.")}`);
	}
	return lines;
}

function renderWaitResult(
	result: { content: Array<{ type: string; text?: string }>; isError?: boolean },
	details: Partial<CoordinationDetails>,
	args: HubRenderArgs | undefined,
	expanded: boolean,
	theme: Theme,
): string[] {
	const waited = details.waited;
	if (!waited) {
		const text = firstTextBlock(result) || "No message arrived.";
		return [
			renderStatusLine(
				{ icon: "warning", title: `IRC ${theme.nav.back} ${args?.from?.trim() || "anyone"}`, meta: ["timed out"] },
				theme,
			),
			`  ${theme.fg("muted", replaceTabs(text))}`,
		];
	}
	const meta = [messageAge(waited.ts)];
	if (waited.replyTo) meta.push("reply");
	return [
		renderStatusLine({ iconOverride: ircGlyph(theme), title: `IRC ${theme.nav.back} ${waited.from}`, meta }, theme),
		...bodyLines(waited.body, expanded, theme, { indent: "  " }),
	];
}

function renderInboxResult(
	details: Partial<CoordinationDetails>,
	args: HubRenderArgs | undefined,
	expanded: boolean,
	theme: Theme,
): string[] {
	const messages = details.inbox ?? [];
	if (messages.length === 0) {
		return [renderStatusLine({ iconOverride: ircGlyph(theme), title: "IRC inbox", meta: ["empty"] }, theme)];
	}
	const meta = [`${messages.length} ${messages.length === 1 ? "message" : "messages"}`];
	if (args?.peek) meta.push("peek");
	const header = renderStatusLine({ iconOverride: ircGlyph(theme), title: "IRC inbox", meta }, theme);
	const items = renderTreeList<IrcMessage>(
		{
			items: messages,
			expanded,
			maxCollapsed: PREVIEW_LIMITS.COLLAPSED_ITEMS,
			itemType: "message",
			renderItem: msg => {
				const age = messageAge(msg.ts);
				const replyBadge = msg.replyTo ? ` ${formatBadge("reply", "muted", theme)}` : "";
				const head = `${theme.fg("accent", msg.from)}${age ? ` ${theme.fg("dim", age)}` : ""}${replyBadge}`;
				return [head, ...bodyLines(msg.body, expanded, theme, { collapsedLines: 1 })];
			},
		},
		theme,
	);
	return [header, ...items];
}

function renderListResult(details: Partial<CoordinationDetails>, expanded: boolean, theme: Theme): string[] {
	const peers = [...(details.peers ?? [])].sort(
		(a, b) =>
			(LIST_STATUS_ORDER[a.status] ?? 9) - (LIST_STATUS_ORDER[b.status] ?? 9) || b.lastActivity - a.lastActivity,
	);
	const rosterCounts = details.counts;
	if (peers.length === 0) {
		const meta =
			rosterCounts && rosterCounts.running + rosterCounts.idle + rosterCounts.parked > 0
				? [
						`${rosterCounts.running} running`,
						`${rosterCounts.idle} idle`,
						`${rosterCounts.parked} parked`,
						...(rosterCounts.truncated > 0 ? [`${rosterCounts.truncated} truncated`] : []),
					]
				: ["no other agents"];
		return [renderStatusLine({ icon: "info", title: "IRC peers", meta }, theme)];
	}
	const counts = new Map<string, number>();
	for (const peer of peers) counts.set(peer.status, (counts.get(peer.status) ?? 0) + 1);
	const meta = rosterCounts
		? [
				`${rosterCounts.running} running`,
				`${rosterCounts.idle} idle`,
				`${rosterCounts.parked} parked`,
				...(rosterCounts.truncated > 0 ? [`${rosterCounts.truncated} truncated`] : []),
			]
		: [...counts].map(([status, count]) => `${count} ${status}`);
	const unreadTotal = peers.reduce((sum, peer) => sum + peer.unread, 0);
	if (unreadTotal > 0) meta.push(theme.fg("warning", `${unreadTotal} unread`));
	const header = renderStatusLine({ iconOverride: ircGlyph(theme), title: "IRC peers", meta }, theme);
	const items = renderTreeList(
		{
			items: peers,
			expanded,
			maxCollapsed: PREVIEW_LIMITS.COLLAPSED_ITEMS,
			itemType: "peer",
			renderItem: peer => {
				const kindText = peer.parentId ? `${peer.kind}${theme.sep.dot}of ${peer.parentId}` : peer.kind;
				const unread = peer.unread > 0 ? ` ${formatBadge(`${peer.unread} unread`, "warning", theme)}` : "";
				const age = messageAge(peer.lastActivity);
				const activity = peer.activity ? ` ${theme.fg("dim", replaceTabs(peer.activity))}` : "";
				const name = theme.fg("dim", replaceTabs(peer.displayName));
				return `${peerStatusBadge(peer.status, theme)} ${theme.bold(replaceTabs(peer.id))} ${name} ${theme.fg("dim", kindText)}${activity}${unread}${age ? ` ${theme.fg("dim", age)}` : ""}`;
			},
		},
		theme,
	);
	return [header, ...items];
}
function buildResultLines(
	result: { content: Array<{ type: string; text?: string }>; isError?: boolean },
	details: Partial<CoordinationDetails>,
	args: HubRenderArgs | undefined,
	expanded: boolean,
	theme: Theme,
): string[] {
	switch (details.op ?? args?.op) {
		case "send":
			return renderSendResult(result, details, args, expanded, theme);
		case "wait":
			return renderWaitResult(result, details, args, expanded, theme);
		case "inbox":
			return result.isError
				? renderErrorResult(result, args, theme)
				: renderInboxResult(details, args, expanded, theme);
		case "list":
			return result.isError ? renderErrorResult(result, args, theme) : renderListResult(details, expanded, theme);
		default: {
			const text = firstTextBlock(result) || (result.isError ? "Hub call failed." : "Done.");
			return [
				renderStatusLine({ icon: result.isError ? "error" : "success", title: callTitle(args, theme) }, theme),
				result.isError ? formatErrorDetail(text, theme) : `  ${theme.fg("muted", replaceTabs(text))}`,
			];
		}
	}
}

/** Pending-call frame for messaging ops (send/wait-from/inbox/list). */
export function messagingRenderCall(args: HubRenderArgs, _options: RenderResultOptions, uiTheme: Theme): Component {
	const lines = [
		renderStatusLine({ icon: "pending", title: callTitle(args, uiTheme), meta: messagingCallMeta(args) }, uiTheme),
	];
	if (args?.op === "send" && args.message?.trim()) {
		lines.push(...bodyLines(args.message, false, uiTheme, { indent: "  ", tone: "dim", collapsedLines: 1 }));
	}
	return new Text(lines.join("\n"), 0, 0);
}

/** Result frame for messaging ops and message-carrying `wait` results. */
export function messagingRenderResult(
	result: { content: Array<{ type: string; text?: string }>; details?: CoordinationDetails; isError?: boolean },
	options: RenderResultOptions,
	uiTheme: Theme,
	args?: HubRenderArgs,
): Component {
	const details: Partial<CoordinationDetails> = result.details ?? {};
	return createCachedComponent(
		() => options.expanded,
		(width, expanded) =>
			buildResultLines(result, details, args, expanded, uiTheme).map(line =>
				truncateToWidth(line, width, Ellipsis.Unicode),
			),
	);
}

// =============================================================================
// TUI Renderer — dispatches to the preserved messaging/job/launch renderings.
// =============================================================================

const LAUNCH_OPS: Record<string, true> = {
	start: true,
	ps: true,
	logs: true,
	stop: true,
	restart: true,
	describe: true,
};

/** Launch-style call: an explicit process op, or `send`/`wait` targeting a process `name`. */
function isLaunchStyleArgs(args: HubRenderArgs | undefined): boolean {
	if (!args?.op) return false;
	if (LAUNCH_OPS[args.op]) return true;
	return (args.op === "send" || args.op === "wait") && !!args.name && !args.to && !args.from;
}

/** Job-style call: job ops, or a `wait` that does not target a peer or process. */
function isJobStyleArgs(args: HubRenderArgs | undefined): boolean {
	switch (args?.op) {
		case "jobs":
		case "cancel":
			return true;
		case "wait":
			return !!args.ids?.length || (!args.from && !args.name);
		default:
			return false;
	}
}

/** Launch details carry process/broker state; coordination details never define these keys. */
function isLaunchDetails(details: HubDetails): details is LaunchToolDetails {
	// `state`/`cursor` cover logs results, which may carry neither a daemon
	// snapshot nor terminal rows; coordination details never define these keys.
	return (
		"daemon" in details ||
		"daemons" in details ||
		"terminalRows" in details ||
		"spec" in details ||
		"state" in details ||
		"cursor" in details
	);
}

/** Hub args → launch renderer args: `ps` is the broker's `list`; everything else is verbatim. */
function toLaunchArgs(args: HubRenderArgs | undefined): LaunchRenderArgs {
	if (!args) return {};
	const { op, ...rest } = args;
	return { ...rest, op: op === "ps" ? "list" : op };
}

/** Renders hub messaging, jobs, and supervised processes. */
export const hubToolRenderer = {
	inline: true,
	mergeCallAndResult: true,
	/** Compact one-line activity: op plus its peer, process, or job target. */
	activitySummary(args: unknown): ToolActivitySummary {
		const hubArgs = (args ?? {}) as HubRenderArgs;
		const op = hubArgs.op;
		if (!op) return { label: "Hub" };
		let detail = op;
		if (op === "send" && (hubArgs.to || hubArgs.name)) detail = `send → ${hubArgs.to ?? hubArgs.name}`;
		else if (op === "wait" && (hubArgs.from || hubArgs.name)) detail = `wait ${hubArgs.from ?? hubArgs.name}`;
		else if ((op === "wait" || op === "cancel") && hubArgs.ids?.length) {
			detail = `${op} ${hubArgs.ids.length} job${hubArgs.ids.length === 1 ? "" : "s"}`;
		} else if (hubArgs.name) detail = `${op} ${hubArgs.name}`;
		return { label: "Hub", detail };
	},
	// Only launch pending frames consume the spinner (broker RPC in flight);
	// messaging/job pending frames are static, exactly as before the merge.
	animatedPendingPreview: (args: unknown): boolean => isLaunchStyleArgs(args as HubRenderArgs | undefined),

	renderCall(args: HubRenderArgs, options: RenderResultOptions, uiTheme: Theme): Component {
		if (isLaunchStyleArgs(args)) return launchRenderCall(toLaunchArgs(args), options, uiTheme);
		return isJobStyleArgs(args)
			? jobsRenderCall(args, options, uiTheme)
			: messagingRenderCall(args, options, uiTheme);
	},

	renderResult(
		result: { content: Array<{ type: string; text?: string }>; details?: HubDetails; isError?: boolean },
		options: RenderResultOptions,
		uiTheme: Theme,
		args?: HubRenderArgs,
	): Component {
		// Results dispatch on what actually happened, falling back to the call
		// shape when details are absent (framework-generated errors).
		const details = result.details;
		if (details && isLaunchDetails(details)) {
			return launchRenderResult({ ...result, details }, options, uiTheme, toLaunchArgs(args));
		}
		const coordination = details;
		if (coordination && (Array.isArray(coordination.jobs) || Array.isArray(coordination.agents))) {
			return jobsRenderResult({ ...result, details: coordination }, options, uiTheme, args);
		}
		if (
			coordination &&
			("receipts" in coordination || "waited" in coordination || "inbox" in coordination || "peers" in coordination)
		) {
			return messagingRenderResult({ ...result, details: coordination }, options, uiTheme, args);
		}
		// Detail-less or op-only results (validation errors, disabled gates).
		if (isLaunchStyleArgs(args))
			return launchRenderResult({ ...result, details: undefined }, options, uiTheme, toLaunchArgs(args));
		if (isJobStyleArgs(args)) return jobsRenderResult({ ...result, details: coordination }, options, uiTheme, args);
		return messagingRenderResult({ ...result, details: coordination }, options, uiTheme, args);
	},
} satisfies ToolRenderer<HubRenderArgs, HubDetails>;
