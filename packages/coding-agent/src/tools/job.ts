import type {
	AgentTool,
	AgentToolContext,
	AgentToolResult,
	AgentToolUpdateCallback,
} from "@pk-nerdsaver-ai/pi-agent-core";
import type { Component } from "@pk-nerdsaver-ai/pi-tui";
import { Text } from "@pk-nerdsaver-ai/pi-tui";
import { prompt } from "@pk-nerdsaver-ai/pi-utils";
import { type } from "arktype";
import type { AsyncJob, AsyncJobManager } from "../async";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import { shimmerEnabled, shimmerText } from "../modes/theme/shimmer";
import type { Theme } from "../modes/theme/theme";
import jobDescription from "../prompts/tools/job.md" with { type: "text" };
import { Ellipsis, Hasher, type RenderCache, renderStatusLine, renderTreeList, truncateToWidth } from "../tui";
import type { ToolSession } from "./index";
import {
	formatBadge,
	formatDuration,
	formatEmptyMessage,
	formatStatusIcon,
	getPreviewLines,
	PREVIEW_LIMITS,
	replaceTabs,
	type ToolUIColor,
	type ToolUIStatus,
} from "./render-utils";
import { ToolError } from "./tool-errors";

const jobSchema = type({
	"poll?": type("string[]").describe("job ids to wait for; omit to wait on all running jobs"),
	"cancel?": type("string[]").describe("job ids to cancel"),
	"list?": type("boolean").describe("snapshot all jobs"),
});

type JobParams = typeof jobSchema.infer;

const WAIT_DURATION_MS: Record<string, number> = {
	"5s": 5_000,
	"10s": 10_000,
	"30s": 30_000,
	"1m": 60_000,
	"5m": 5 * 60_000,
};

function parseWaitDurationMs(value: string | undefined): number {
	return (value ? WAIT_DURATION_MS[value] : undefined) ?? WAIT_DURATION_MS["30s"];
}

interface JobSnapshot {
	id: string;
	type: "bash" | "task";
	status: "running" | "completed" | "failed" | "cancelled";
	label: string;
	durationMs: number;
	resultText?: string;
	errorText?: string;
}

type CancelStatus = "cancelled" | "not_found" | "already_completed";

interface CancelOutcome {
	id: string;
	status: CancelStatus;
	message: string;
}

export interface JobToolDetails {
	jobs: JobSnapshot[];
	cancelled?: { id: string; status: CancelStatus }[];
}

/**
 * A poll snapshot where every watched job is still running and nothing was
 * cancelled — pure "still waiting" noise once a newer poll exists. The TUI
 * keeps such a block un-finalized (displaceable) so a follow-up `job` call
 * replaces it instead of stacking another waiting frame in the transcript.
 */
export function isWaitingPollDetails(details: unknown): boolean {
	const d = details as JobToolDetails | undefined;
	if (!d || !Array.isArray(d.jobs) || d.jobs.length === 0) return false;
	if (d.cancelled?.length) return false;
	return d.jobs.every(job => job?.status === "running");
}

export class JobTool implements AgentTool<typeof jobSchema, JobToolDetails> {
	readonly name = "job";
	readonly approval = "read" as const;
	readonly label = "Job";
	readonly summary = "Manage long-running background jobs (async bash/python)";
	readonly description: string;
	readonly parameters = jobSchema;
	readonly strict = true;
	readonly interruptible = true;
	readonly loadMode = "discoverable";
	constructor(private readonly session: ToolSession) {
		this.description = prompt.render(jobDescription);
	}

	async execute(
		_toolCallId: string,
		params: JobParams,
		signal?: AbortSignal,
		onUpdate?: AgentToolUpdateCallback<JobToolDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<JobToolDetails>> {
		const manager = this.session.asyncJobManager;
		if (!manager) {
			return {
				content: [{ type: "text", text: "Async execution is disabled; no background jobs are available." }],
				details: { jobs: [] },
			};
		}

		// Scope every visible operation to the calling agent. Tests / SDK
		// consumers without an agent id see everything (legacy behavior).
		const ownerId = this.session.getAgentId?.() ?? undefined;
		const ownerFilter = ownerId ? { ownerId } : undefined;

		// `list` is a read-only snapshot mode. Replaces the legacy `jobs://` URL.
		// It never acknowledges deliveries: a snapshot is not a wait, so pending
		// completions must still reach their owner sessions.
		if (params.list) {
			if (params.cancel?.length || params.poll?.length) {
				throw new ToolError("`list` cannot be combined with `poll` or `cancel`.");
			}
			return this.#buildResult(manager, manager.getAllJobs(ownerFilter), [], { acknowledge: false });
		}

		const cancelIds = params.cancel ?? [];
		const cancelOutcomes: CancelOutcome[] = [];
		for (const id of cancelIds) {
			const existing = manager.getJob(id);
			if (!existing || (ownerId && existing.ownerId !== ownerId)) {
				cancelOutcomes.push({ id, status: "not_found", message: `Background job not found: ${id}` });
				continue;
			}
			if (existing.status !== "running") {
				cancelOutcomes.push({
					id,
					status: "already_completed",
					message: `Background job ${id} is already ${existing.status}.`,
				});
				continue;
			}
			const cancelled = manager.cancel(id, ownerFilter);
			cancelOutcomes.push(
				cancelled
					? { id, status: "cancelled", message: `Cancelled background job ${id}.` }
					: { id, status: "already_completed", message: `Background job ${id} is already completed.` },
			);
		}

		const requestedPollIds = params.poll;
		// If only `cancel` was provided (no `poll`), don't wait \u2014 return immediately.
		const shouldPoll = requestedPollIds !== undefined || cancelIds.length === 0;

		if (!shouldPoll) {
			const cancelledJobs = this.#visibleJobs(manager, cancelIds, ownerId);
			return this.#buildResult(manager, cancelledJobs, cancelOutcomes);
		}

		// Resolve which jobs to watch.
		// - If `poll` was passed explicitly, watch exactly those (filtered to existing).
		// - If `poll` was omitted (and so was `cancel`), default to all running jobs.
		const jobsToWatch = requestedPollIds
			? this.#visibleJobs(manager, requestedPollIds, ownerId)
			: manager.getRunningJobs(ownerFilter);

		if (jobsToWatch.length === 0) {
			if (cancelOutcomes.length > 0) {
				const cancelledJobs = this.#visibleJobs(manager, cancelIds, ownerId);
				return this.#buildResult(manager, cancelledJobs, cancelOutcomes);
			}
			const message = requestedPollIds?.length
				? `No matching jobs found for IDs: ${requestedPollIds.join(", ")}`
				: "No running background jobs to wait for.";
			return {
				content: [{ type: "text", text: message }],
				details: { jobs: [] },
				// Nothing found / nothing to wait for is noise once consumed —
				// the follow-up call has already corrected course.
				useless: true,
			};
		}

		// If all watched jobs are already done, build immediate result.
		const runningJobs = jobsToWatch.filter(j => j.status === "running");
		if (runningJobs.length === 0) {
			const cancelledJobs = cancelIds.map(id => manager.getJob(id)).filter(j => j != null);
			return this.#buildResult(manager, [...cancelledJobs, ...jobsToWatch], cancelOutcomes);
		}

		// Wait until at least one running job finishes, the wait window elapses,
		// or the call is aborted. With `async.pollWaitDuration` set to `smart`,
		// the window adapts: it starts at the ladder floor and climbs as the agent
		// polls in a tight loop, then resets to the floor once the agent steps
		// away from polling (see AsyncJobManager.nextPollWaitMs). Any fixed value
		// waits that exact duration every time.
		const racePromises: Promise<unknown>[] = runningJobs.map(j => j.promise);
		const pollSetting = this.session.settings.get("async.pollWaitDuration");
		const smartPoll = pollSetting === "smart";
		const waitMs = smartPoll ? manager.nextPollWaitMs(ownerId) : parseWaitDurationMs(pollSetting);
		const { promise: timeoutPromise, resolve: timeoutResolve } = Promise.withResolvers<void>();
		const timeoutHandle = setTimeout(() => timeoutResolve(), waitMs);
		racePromises.push(timeoutPromise);

		const watchedJobIds = runningJobs.map(job => job.id);
		manager.watchJobs(watchedJobIds);

		const cancelledJobs = this.#visibleJobs(manager, cancelIds, ownerId);
		const allTrackedJobs = [...cancelledJobs, ...jobsToWatch];

		const PROGRESS_INTERVAL_MS = 500;
		const emitProgress = () => {
			if (!onUpdate) return;
			const snapshot = this.#snapshotJobs(allTrackedJobs);
			onUpdate({
				content: [{ type: "text", text: "" }],
				details: {
					jobs: snapshot,
					...(cancelOutcomes.length
						? { cancelled: cancelOutcomes.map(({ id, status }) => ({ id, status })) }
						: {}),
				},
			});
		};
		const progressTimer = onUpdate ? setInterval(emitProgress, PROGRESS_INTERVAL_MS) : undefined;
		emitProgress();

		try {
			if (signal) {
				const { promise: abortPromise, resolve: abortResolve } = Promise.withResolvers<void>();
				const onAbort = () => abortResolve();
				signal.addEventListener("abort", onAbort, { once: true });
				racePromises.push(abortPromise);
				try {
					await Promise.race(racePromises);
				} finally {
					signal.removeEventListener("abort", onAbort);
				}
			} else {
				await Promise.race(racePromises);
			}
		} finally {
			manager.unwatchJobs(watchedJobIds);
			clearTimeout(timeoutHandle);
			if (progressTimer) clearInterval(progressTimer);
			if (smartPoll) {
				// Reset the idle-gap clock: escalate if the agent polls again soon,
				// drop back to the floor once it goes quiet for a while.
				manager.recordPollWaitEnd(ownerId);
			}
		}

		return this.#buildResult(manager, allTrackedJobs, cancelOutcomes);
	}

	/**
	 * Resolve a list of job ids to job records visible to the calling agent.
	 * Drops missing ids and ids owned by other agents, so cross-agent inspection
	 * via the `job` tool is impossible.
	 */
	#visibleJobs(manager: AsyncJobManager, ids: string[], ownerId: string | undefined): AsyncJob[] {
		const out: AsyncJob[] = [];
		for (const id of ids) {
			const job = manager.getJob(id);
			if (!job) continue;
			if (ownerId && job.ownerId !== ownerId) continue;
			out.push(job);
		}
		return out;
	}

	#snapshotJobs(
		jobs: {
			id: string;
			type: "bash" | "task";
			status: string;
			label: string;
			startTime: number;
			resultText?: string;
			errorText?: string;
		}[],
	): JobSnapshot[] {
		const now = Date.now();
		return jobs.map(j => {
			const current = this.session.asyncJobManager?.getJob(j.id);
			const latest = current ?? j;
			return {
				id: latest.id,
				type: latest.type,
				status: latest.status as JobSnapshot["status"],
				label: latest.label,
				durationMs: Math.max(0, now - latest.startTime),
				...(latest.resultText ? { resultText: latest.resultText } : {}),
				...(latest.errorText ? { errorText: latest.errorText } : {}),
			};
		});
	}

	#buildResult(
		manager: AsyncJobManager,
		jobs: {
			id: string;
			type: "bash" | "task";
			status: string;
			label: string;
			startTime: number;
			resultText?: string;
			errorText?: string;
		}[],
		cancelOutcomes: CancelOutcome[],
		options?: { acknowledge?: boolean },
	): AgentToolResult<JobToolDetails> {
		// Deduplicate by id (cancelled jobs may also appear in the watched set).
		const seen = new Set<string>();
		const uniqueJobs = jobs.filter(j => {
			if (seen.has(j.id)) return false;
			seen.add(j.id);
			return true;
		});
		const jobResults = this.#snapshotJobs(uniqueJobs);

		if (options?.acknowledge !== false) {
			manager.acknowledgeDeliveries(jobResults.filter(j => j.status !== "running").map(j => j.id));
		}

		const completed = jobResults.filter(j => j.status !== "running");
		const running = jobResults.filter(j => j.status === "running");

		const lines: string[] = [];

		if (cancelOutcomes.length > 0) {
			lines.push(`## Cancelled (${cancelOutcomes.length})\n`);
			for (const o of cancelOutcomes) lines.push(`- ${o.message}`);
			lines.push("");
		}

		if (completed.length > 0) {
			lines.push(`## Completed (${completed.length})\n`);
			for (const j of completed) {
				lines.push(`### ${j.id} [${j.type}] — ${j.status}`);
				lines.push(`Label: ${j.label}`);
				if (j.resultText) {
					lines.push("```", j.resultText, "```");
				}
				if (j.errorText) {
					lines.push(`Error: ${j.errorText}`);
				}
				lines.push("");
			}
		}

		if (running.length > 0) {
			lines.push(`## Still Running (${running.length})\n`);
			for (const j of running) {
				lines.push(`- \`${j.id}\` [${j.type}] — ${j.label}`);
			}
		}

		const details: JobToolDetails = {
			jobs: jobResults,
			...(cancelOutcomes.length ? { cancelled: cancelOutcomes.map(({ id, status }) => ({ id, status })) } : {}),
		};
		return {
			content: [{ type: "text", text: lines.join("\n").trimEnd() }],
			details,
			// A poll where everything is still running carries no new information
			// once a later poll exists — same predicate the TUI uses to displace
			// stale waiting frames.
			...(isWaitingPollDetails(details) ? { useless: true } : {}),
		};
	}
}

// =============================================================================
// TUI Renderer
// =============================================================================

interface JobRenderArgs {
	poll?: string[];
	cancel?: string[];
	list?: boolean;
}

const COLLAPSED_LIST_LIMIT = PREVIEW_LIMITS.COLLAPSED_ITEMS;
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

export const jobToolRenderer = {
	inline: true,

	renderCall(args: JobRenderArgs, _options: RenderResultOptions, uiTheme: Theme): Component {
		const text = renderStatusLine({ icon: "pending", title: describeTarget(args) || "Job" }, uiTheme);
		return new Text(text, 0, 0);
	},

	renderResult(
		result: { content: Array<{ type: string; text?: string }>; details?: JobToolDetails; isError?: boolean },
		options: RenderResultOptions,
		uiTheme: Theme,
		args?: JobRenderArgs,
	): Component {
		let jobs = result.details?.jobs ?? [];

		if (jobs.length === 0) {
			const fallback = result.content?.find(c => c.type === "text")?.text || "No jobs to process";
			const header = renderStatusLine({ icon: "warning", title: describeTarget(args) || "Job" }, uiTheme);
			return new Text([header, formatEmptyMessage(fallback, uiTheme)].join("\n"), 0, 0);
		}

		const isPollCall = args
			? !args.list && (!args.cancel || args.cancel.length === 0 || args.poll !== undefined)
			: true;

		if (!options.isPartial && isPollCall) {
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

		const headerIcon: ToolUIStatus = counts.failed > 0 ? "warning" : counts.running > 0 ? "info" : "success";
		const jobsNoun = jobs.length === 1 ? "job" : "jobs";
		const description =
			counts.running > 0
				? counts.running === jobs.length
					? `waiting on ${jobs.length} ${jobsNoun}`
					: `waiting on ${counts.running} of ${jobs.length} ${jobsNoun}`
				: `${jobs.length} ${jobsNoun} settled`;

		const header = renderStatusLine(
			{
				icon: headerIcon,
				spinnerFrame: counts.running > 0 ? options.spinnerFrame : undefined,
				title: description,
				meta,
			},
			uiTheme,
		);

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
				// Running-job labels shimmer while the poll block is live; the band
				// phase is Date.now()-sampled at render time, so serving cached bytes
				// would pin it to the ~12.5fps spinner-glyph cadence instead of the
				// 30fps redraw. Bypass the cache while any row animates, and key on
				// the animation state so a sealed block never hits stale shimmered
				// bytes (spinnerFrame falls back to 0 on both sides of the seal).
				const shimmerActive = counts.running > 0 && options.spinnerFrame !== undefined && shimmerEnabled();
				const key = new Hasher().bool(expanded).u32(width).u32(spinnerFrame).bool(shimmerActive).digest();
				if (!shimmerActive && cached?.key === key) return cached.lines;

				const itemLines = renderTreeList<JobSnapshot>(
					{
						items: sortedJobs,
						expanded,
						maxCollapsed: COLLAPSED_LIST_LIMIT,
						itemType: "job",
						renderItem: job => {
							const lines: string[] = [];
							const icon = formatStatusIcon(
								statusToIcon(job.status),
								uiTheme,
								job.status === "running" ? options.spinnerFrame : undefined,
							);
							const typeBadge = formatBadge(job.type, statusToColor(job.status), uiTheme);
							// Task jobs label themselves with their agent id, which is also
							// the job id — drop the id column instead of stuttering it twice.
							const idPart = job.label.trim() === job.id ? "" : ` ${uiTheme.fg("muted", job.id)}`;
							const rawLabelLines = (job.label || "(no label)").split(/\r?\n/);
							const maxLabelLines = expanded ? LABEL_LINES_EXPANDED : LABEL_LINES_COLLAPSED;
							const visibleLabelLines = rawLabelLines
								.slice(0, maxLabelLines)
								.map(l => truncateToWidth(replaceTabs(l), LABEL_MAX_WIDTH, Ellipsis.Unicode));
							if (rawLabelLines.length > maxLabelLines && visibleLabelLines.length > 0) {
								const last = visibleLabelLines[visibleLabelLines.length - 1]!;
								visibleLabelLines[visibleLabelLines.length - 1] = `${last} …`;
							}
							const durationText = uiTheme.fg("dim", formatDuration(job.durationMs));
							// Running rows in a live block shimmer their label; once the block
							// stops animating (sealed, or a settled snapshot — spinnerFrame
							// cleared) they render static so scrollback never keeps a mid-sweep
							// shimmer band.
							const live = job.status === "running" && options.spinnerFrame !== undefined;
							const headRaw = visibleLabelLines[0] ?? "";
							const headLabel = live
								? shimmerEnabled()
									? shimmerText(headRaw, uiTheme)
									: uiTheme.fg("accent", headRaw)
								: uiTheme.fg("toolOutput", headRaw);
							lines.push(`${icon}${idPart} ${typeBadge} ${headLabel} ${durationText}`);
							for (let i = 1; i < visibleLabelLines.length; i++) {
								lines.push(`  ${uiTheme.fg("toolOutput", visibleLabelLines[i]!)}`);
							}

							const preview = flattenStructuredPreview(
								stripTaskResultEnvelope(job.errorText?.trim() || job.resultText?.trim() || ""),
							);
							if (preview) {
								const maxLines = expanded ? PREVIEW_LINES_EXPANDED : PREVIEW_LINES_COLLAPSED;
								const previewLines = getPreviewLines(preview, maxLines, PREVIEW_LINE_WIDTH, Ellipsis.Unicode);
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

				const all = [header, ...itemLines].map(l => truncateToWidth(l, width, Ellipsis.Unicode));
				cached = { key, lines: all };
				return all;
			},
			invalidate() {
				cached = undefined;
			},
		};
	},

	mergeCallAndResult: true,
};
