import { scheduler } from "node:timers/promises";
import type { AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import { logger } from "@oh-my-pi/pi-utils";
import { gitlab } from "../utils/gitlab";
import type {
	GlPipelineWatchFailedLogDetails,
	GlPipelineWatchJobDetails,
	GlPipelineWatchViewDetails,
	GlToolDetails,
} from "./details/gitlab";
import {
	normalizeOptionalString,
	parsePositiveDecimalInt,
	requireCurrentGitBranch,
	requireNonEmpty,
	saveArtifactText,
} from "./gh-common";
import { formatShortSha, pushLine } from "./gh-format";
import {
	isRateLimitedGhError,
	parseTimestampMs,
	resolveTailLimit,
	RUN_WATCH_FAST_WINDOW_MS,
	RUN_WATCH_GRACE_DEFAULT,
	RUN_WATCH_INTERVAL_DEFAULT,
	RUN_WATCH_INTERVAL_SLOW,
	RUN_WATCH_MAX_POLL_FAILURES,
	RUN_WATCH_NO_RUNS_GIVE_UP_MS,
	tailLogLines,
} from "./gh-run-watch";
import { resolveSearchLimit } from "./gh-search";
import { formatGitlabProjectArg } from "./glab-mr";
import {
	buildGlTextResult,
	encodeProjectPath,
	glabApiJson,
	glabApiPaginated,
	glabApiText,
	parseGitlabJobUrl,
	parseGitlabMrUrl,
	parseGitlabPipelineUrl,
	requireConsistentUrlProject,
	resolveGitlabMrIid,
	resolveGitlabProject,
	type GitlabProjectRef,
} from "./gl-common";
import { toGitlabIsoDateBound } from "./gl-search";
import type { GitlabInput, GlBridgeApi, GlJobApi, GlMrApi, GlPipelineApi, GlPipelineSummaryApi } from "./gl-types";
import type { ToolSession } from ".";
import { throwIfAborted, ToolAbortError, ToolError } from "./tool-errors";

const JOB_LOG_TAIL_DEFAULT = 200;
const JOB_LOG_TAIL_MAX = 2000;
const TERMINAL_PIPELINE_STATUSES = new Set(["success", "failed", "canceled", "skipped", "manual", "blocked"]);
const GITLAB_SECTION_MARKER_PATTERN = new RegExp("\\u001b\\[0Ksection_(?:start|end):[^\\r\\n]*\\r?", "g");
const GLAB_TRUNCATED_SUFFIX_PATTERN = /\n?\[glab subprocess output truncated after 8 MiB\]\n?$/;

export function stripGitlabTraceAnsi(raw: string): string {
	const withoutSections = raw.replace(GITLAB_SECTION_MARKER_PATTERN, "");
	const stripped = Bun.stripANSI(withoutSections);
	return stripped.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
}

function parseTraceCapture(raw: string): { text: string; truncated: boolean } {
	const truncated = GLAB_TRUNCATED_SUFFIX_PATTERN.test(raw);
	const body = truncated ? raw.replace(GLAB_TRUNCATED_SUFFIX_PATTERN, "") : raw;
	return { text: stripGitlabTraceAnsi(body), truncated };
}

function isRealFailedJob(job: GlJobApi): boolean {
	return job.status === "failed" && job.allow_failure !== true;
}

function isRealFailedBridge(bridge: GlBridgeApi): boolean {
	return bridge.status === "failed" && bridge.allow_failure !== true;
}

function getJobDurationSeconds(
	job: { duration?: number | null; started_at?: string | null; finished_at?: string | null },
	observedAtMs: number,
): number | undefined {
	if (typeof job.duration === "number" && Number.isFinite(job.duration)) {
		return Math.max(0, Math.round(job.duration));
	}
	const startedMs = parseTimestampMs(job.started_at ?? undefined);
	if (startedMs === undefined) return undefined;
	const endMs = parseTimestampMs(job.finished_at ?? undefined) ?? observedAtMs;
	return Math.max(0, Math.round((endMs - startedMs) / 1000));
}

function requireSingleMrString(mr: string | string[] | undefined): string | undefined {
	if (Array.isArray(mr)) {
		throw new ToolError("mr must be a single merge request identifier for pipeline/job operations.");
	}
	return normalizeOptionalString(mr);
}

interface ResolvedPipelineTarget {
	pipelineId: number;
	/** Numeric project ID owning the pipeline (may differ from target project on fork MRs). */
	pipelineProjectId?: number;
	mrIid?: number;
	ref?: string;
}

function pipelineApiProjectPath(projectRef: GitlabProjectRef, pipelineProjectId: number | undefined): string {
	return pipelineProjectId !== undefined ? String(pipelineProjectId) : encodeProjectPath(projectRef.path);
}

async function resolvePipelineTarget(
	cwd: string,
	projectRef: GitlabProjectRef,
	params: GitlabInput,
	signal: AbortSignal | undefined,
): Promise<ResolvedPipelineTarget | undefined> {
	const encodedPath = encodeProjectPath(projectRef.path);
	const explicitPipeline = normalizeOptionalString(params.pipeline);
	if (explicitPipeline) {
		if (explicitPipeline.startsWith("-")) {
			throw new ToolError(`Invalid pipeline identifier '${explicitPipeline}'. Pass a pipeline ID or URL.`);
		}
		const fromUrl = parseGitlabPipelineUrl(explicitPipeline);
		const pipelineId = fromUrl.pipelineId ?? parsePositiveDecimalInt(explicitPipeline.replace(/^#/, ""));
		if (pipelineId === undefined) {
			throw new ToolError(`Invalid GitLab pipeline identifier '${explicitPipeline}'. Pass a numeric ID or URL.`);
		}
		return { pipelineId };
	}

	const explicitMr = requireSingleMrString(params.mr);
	if (explicitMr) {
		const iid = await resolveGitlabMrIid(cwd, projectRef, explicitMr, signal);
		const mr = await glabApiJson<GlMrApi>(
			cwd,
			projectRef.host,
			`projects/${encodedPath}/merge_requests/${iid}`,
			undefined,
			signal,
		);
		let selected = mr.head_pipeline ?? mr.pipeline ?? undefined;
		if (selected?.id === undefined) {
			const mrPipelines = await glabApiJson<GlPipelineSummaryApi[]>(
				cwd,
				projectRef.host,
				`projects/${encodedPath}/merge_requests/${iid}/pipelines`,
				{ query: { per_page: 1 } },
				signal,
			);
			selected = mrPipelines[0];
		}
		return selected?.id !== undefined
			? {
					pipelineId: selected.id,
					pipelineProjectId: selected.project_id ?? mr.source_project_id,
					mrIid: iid,
					ref: mr.source_branch,
				}
			: undefined;
	}

	const explicitRef = normalizeOptionalString(params.ref);
	if (explicitRef) {
		const pipelines = await glabApiJson<GlPipelineSummaryApi[]>(
			cwd,
			projectRef.host,
			`projects/${encodedPath}/pipelines`,
			{ query: { ref: explicitRef, per_page: 1 } },
			signal,
		);
		const selected = pipelines[0];
		return selected?.id !== undefined
			? { pipelineId: selected.id, pipelineProjectId: selected.project_id, ref: explicitRef }
			: undefined;
	}

	const branch = await requireCurrentGitBranch(cwd, signal);
	const mrs = await glabApiJson<GlMrApi[]>(
		cwd,
		projectRef.host,
		`projects/${encodedPath}/merge_requests`,
		{ query: { source_branch: branch, state: "opened", per_page: 5 } },
		signal,
	);
	const openMrs = mrs.filter(mr => mr.iid !== undefined);
	if (openMrs.length > 1) {
		const ids = openMrs.map(mr => `!${mr.iid}`).join(", ");
		throw new ToolError(
			`Ambiguous open merge requests for current branch '${branch}' in ${projectRef.full} (${ids}). Pass \`mr\` or \`pipeline\` explicitly.`,
		);
	}
	const openMr = openMrs[0];
	if (openMr?.iid !== undefined) {
		let selected = openMr.head_pipeline ?? openMr.pipeline ?? undefined;
		if (selected?.id === undefined) {
			const mrPipelines = await glabApiJson<GlPipelineSummaryApi[]>(
				cwd,
				projectRef.host,
				`projects/${encodedPath}/merge_requests/${openMr.iid}/pipelines`,
				{ query: { per_page: 1 } },
				signal,
			);
			selected = mrPipelines[0];
		}
		if (selected?.id !== undefined) {
			return {
				pipelineId: selected.id,
				pipelineProjectId: selected.project_id ?? openMr.source_project_id,
				mrIid: openMr.iid,
				ref: branch,
			};
		}
	}

	const pipelines = await glabApiJson<GlPipelineSummaryApi[]>(
		cwd,
		projectRef.host,
		`projects/${encodedPath}/pipelines`,
		{ query: { ref: branch, per_page: 1 } },
		signal,
	);
	const selected = pipelines[0];
	return selected?.id !== undefined
		? { pipelineId: selected.id, pipelineProjectId: selected.project_id, ref: branch }
		: undefined;
}

async function resolveJobInProject(
	cwd: string,
	projectRef: GitlabProjectRef,
	params: GitlabInput,
	signal: AbortSignal | undefined,
): Promise<{ jobId: number; pipelineId?: number; projectApiId: string }> {
	const jobInput = requireNonEmpty(normalizeOptionalString(params.job), "job");
	if (jobInput.startsWith("-")) {
		throw new ToolError(`Invalid job identifier '${jobInput}'. Pass a job ID, URL, or job name.`);
	}
	const defaultProjectApiId = encodeProjectPath(projectRef.path);
	const fromUrl = parseGitlabJobUrl(jobInput);
	if (fromUrl.jobId !== undefined) {
		return { jobId: fromUrl.jobId, projectApiId: defaultProjectApiId };
	}
	const directId = parsePositiveDecimalInt(jobInput.replace(/^#/, ""));
	if (directId !== undefined) {
		return { jobId: directId, projectApiId: defaultProjectApiId };
	}

	const target = await resolvePipelineTarget(cwd, projectRef, params, signal);
	if (!target) {
		throw new ToolError(`Could not find a pipeline in ${projectRef.full} to look up job '${jobInput}'.`);
	}
	const projectApiId = pipelineApiProjectPath(projectRef, target.pipelineProjectId);
	const jobs = await glabApiPaginated<GlJobApi>(
		cwd,
		projectRef.host,
		`projects/${projectApiId}/pipelines/${target.pipelineId}/jobs`,
		{},
		10,
		signal,
	);
	const matching = jobs
		.filter(job => job.name === jobInput && job.id !== undefined)
		.sort((a, b) => (b.id ?? 0) - (a.id ?? 0));
	const match = matching[0];
	if (!match?.id) {
		const available = [...new Set(jobs.map(job => job.name).filter((name): name is string => Boolean(name)))];
		throw new ToolError(
			`Job '${jobInput}' not found in pipeline #${target.pipelineId}. Available jobs: ${available.join(", ") || "(none)"}.`,
		);
	}
	return { jobId: match.id, pipelineId: target.pipelineId, projectApiId };
}

function groupJobsByStage(jobs: readonly GlJobApi[]): Array<{ stage: string; jobs: GlJobApi[] }> {
	const groups = new Map<string, GlJobApi[]>();
	for (const job of jobs) {
		const stage = job.stage ?? "default";
		let list = groups.get(stage);
		if (!list) {
			list = [];
			groups.set(stage, list);
		}
		list.push(job);
	}
	return Array.from(groups.entries(), ([stage, stageJobs]) => ({ stage, jobs: stageJobs }));
}

export async function executePipelineList(
	session: ToolSession,
	params: GitlabInput,
	signal: AbortSignal | undefined,
): Promise<AgentToolResult<GlToolDetails>> {
	const mrStr = requireSingleMrString(params.mr);
	const mrUrl = parseGitlabMrUrl(mrStr);
	const ref = await resolveGitlabProject(session.cwd, normalizeOptionalString(params.repo), mrUrl.project, signal);
	const encodedPath = encodeProjectPath(ref.path);
	const limit = resolveSearchLimit(params.limit);

	let pipelines: GlPipelineSummaryApi[];
	let scopeNote: string | undefined;
	if (mrStr) {
		const iid = await resolveGitlabMrIid(session.cwd, ref, mrStr, signal);
		scopeNote = `MR !${iid}`;
		pipelines = await glabApiJson<GlPipelineSummaryApi[]>(
			session.cwd,
			ref.host,
			`projects/${encodedPath}/merge_requests/${iid}/pipelines`,
			{ query: { per_page: limit } },
			signal,
		);
	} else {
		const since = normalizeOptionalString(params.since);
		const until = normalizeOptionalString(params.until);
		const refFilter = normalizeOptionalString(params.ref);
		const statusFilter = normalizeOptionalString(params.state);
		if (refFilter) scopeNote = `ref ${refFilter}`;
		pipelines = await glabApiJson<GlPipelineSummaryApi[]>(
			session.cwd,
			ref.host,
			`projects/${encodedPath}/pipelines`,
			{
				query: {
					per_page: limit,
					ref: refFilter,
					status: statusFilter,
					updated_after: since ? toGitlabIsoDateBound(since, "start") : undefined,
					updated_before: until ? toGitlabIsoDateBound(until, "end") : undefined,
				},
			},
			signal,
		);
	}

	const lines = [`# GitLab Pipelines in ${ref.full}`, ""];
	pushLine(lines, "Scope", scopeNote);
	pushLine(lines, "Count", pipelines.length);
	if (pipelines.length === 0) {
		lines.push("", "No pipelines found.");
	} else {
		for (const pipeline of pipelines) {
			lines.push("");
			lines.push(`- #${pipeline.id ?? "?"} [${pipeline.status ?? "unknown"}]`);
			pushLine(lines, "  Ref", pipeline.ref);
			pushLine(lines, "  Commit", formatShortSha(pipeline.sha));
			pushLine(lines, "  Source", pipeline.source);
			pushLine(lines, "  Updated", pipeline.updated_at ?? pipeline.created_at);
			pushLine(lines, "  URL", pipeline.web_url);
		}
	}

	return buildGlTextResult(lines.join("\n").trim(), `https://${ref.host}/${ref.path}/-/pipelines`, {
		repo: ref.full,
	});
}

async function fetchPipelineSnapshot(
	cwd: string,
	host: string,
	projectApiId: string,
	pipelineId: number,
	signal: AbortSignal | undefined,
): Promise<{ pipeline: GlPipelineApi; jobs: GlJobApi[]; bridges: GlBridgeApi[] }> {
	const [pipeline, jobs, bridges] = await Promise.all([
		glabApiJson<GlPipelineApi>(cwd, host, `projects/${projectApiId}/pipelines/${pipelineId}`, undefined, signal),
		glabApiPaginated<GlJobApi>(cwd, host, `projects/${projectApiId}/pipelines/${pipelineId}/jobs`, {}, 10, signal),
		glabApiPaginated<GlBridgeApi>(
			cwd,
			host,
			`projects/${projectApiId}/pipelines/${pipelineId}/bridges`,
			{},
			5,
			signal,
		).catch(err => {
			if (err instanceof ToolAbortError) throw err;
			logger.debug("gl: ignoring bridges lookup error", { err: String(err) });
			return [] as GlBridgeApi[];
		}),
	]);
	return { pipeline, jobs, bridges };
}

export async function executePipelineView(
	session: ToolSession,
	params: GitlabInput,
	signal: AbortSignal | undefined,
): Promise<AgentToolResult<GlToolDetails>> {
	const pipelineUrl = parseGitlabPipelineUrl(normalizeOptionalString(params.pipeline));
	const mrUrl = parseGitlabMrUrl(requireSingleMrString(params.mr));
	const urlProject = requireConsistentUrlProject([pipelineUrl.project, mrUrl.project]);
	const ref = await resolveGitlabProject(session.cwd, normalizeOptionalString(params.repo), urlProject, signal);
	const target = await resolvePipelineTarget(session.cwd, ref, params, signal);
	if (!target) {
		throw new ToolError(`No pipeline found in ${ref.full} for the requested target.`);
	}

	const projectApiId = pipelineApiProjectPath(ref, target.pipelineProjectId);
	const { pipeline, jobs, bridges } = await fetchPipelineSnapshot(
		session.cwd,
		ref.host,
		projectApiId,
		target.pipelineId,
		signal,
	);

	const nowMs = Date.now();
	const lines = [`# Pipeline #${pipeline.id ?? target.pipelineId} [${pipeline.status ?? "unknown"}]`, ""];
	pushLine(lines, "Project", ref.full);
	pushLine(lines, "Ref", pipeline.ref);
	pushLine(lines, "Commit", formatShortSha(pipeline.sha));
	pushLine(lines, "Source", pipeline.source);
	if (pipeline.duration != null) pushLine(lines, "Duration", `${Math.round(pipeline.duration)}s`);
	pushLine(lines, "Created", pipeline.created_at);
	pushLine(lines, "Finished", pipeline.finished_at ?? undefined);
	pushLine(lines, "URL", pipeline.web_url);

	if (jobs.length === 0) {
		lines.push("", "## Jobs", "", "No jobs reported.");
	} else {
		lines.push("", `## Jobs (${jobs.length})`);
		for (const group of groupJobsByStage(jobs)) {
			lines.push("", `### Stage: ${group.stage}`, "");
			for (const job of group.jobs) {
				const dur = getJobDurationSeconds(job, nowMs);
				const durText = dur !== undefined ? ` (${dur}s)` : "";
				const allowBadge = job.allow_failure ? " (allowed to fail)" : "";
				const reason = job.failure_reason ? ` — ${job.failure_reason}` : "";
				const idText = job.id !== undefined ? `  id:${job.id}` : "";
				lines.push(`- [${job.status ?? "unknown"}] ${job.name ?? "job"}${durText}${allowBadge}${reason}${idText}`);
				if (job.web_url) pushLine(lines, "  URL", job.web_url);
			}
		}
	}

	if (bridges.length > 0) {
		lines.push("", `## Downstream Bridges (${bridges.length})`, "");
		for (const bridge of bridges) {
			const downstream = bridge.downstream_pipeline
				? ` → #${bridge.downstream_pipeline.id} [${bridge.downstream_pipeline.status ?? "unknown"}] ${bridge.downstream_pipeline.web_url ?? ""}`
				: "";
			lines.push(
				`- [${bridge.status ?? "unknown"}] ${bridge.name ?? "bridge"} (${bridge.stage ?? "default"})${downstream}`,
			);
		}
	}

	return buildGlTextResult(lines.join("\n").trim(), pipeline.web_url, {
		repo: ref.full,
		branch: pipeline.ref,
		headSha: pipeline.sha,
		pipelineId: pipeline.id ?? target.pipelineId,
		status: pipeline.status,
	});
}

function buildWatchDetails(
	repo: string,
	pipeline: GlPipelineApi | undefined,
	jobs: readonly GlJobApi[],
	bridges: readonly GlBridgeApi[],
	options: {
		state: "watching" | "completed";
		pollCount?: number;
		note?: string;
		failedLogs?: GlPipelineWatchFailedLogDetails[];
		ref?: string;
	},
): GlPipelineWatchViewDetails {
	const nowMs = Date.now();
	const watchJobs: GlPipelineWatchJobDetails[] = jobs
		.filter((job): job is GlJobApi & { id: number } => typeof job.id === "number")
		.map(job => ({
			id: job.id,
			name: job.name ?? `job-${job.id}`,
			stage: job.stage,
			status: job.status,
			allowFailure: job.allow_failure,
			failureReason: job.failure_reason ?? undefined,
			durationSeconds: getJobDurationSeconds(job, nowMs),
			url: job.web_url,
		}));
	for (const bridge of bridges) {
		if (typeof bridge.id !== "number") continue;
		const downstream = bridge.downstream_pipeline
			? ` → #${bridge.downstream_pipeline.id} [${bridge.downstream_pipeline.status ?? "unknown"}]`
			: "";
		watchJobs.push({
			id: bridge.id,
			name: `${bridge.name ?? `trigger-${bridge.id}`} [trigger]${downstream}`,
			stage: bridge.stage,
			status: bridge.status,
			allowFailure: bridge.allow_failure,
			durationSeconds: getJobDurationSeconds(bridge, nowMs),
			url: bridge.web_url,
		});
	}
	return {
		state: options.state,
		repo,
		pipelineId: pipeline?.id,
		status: pipeline?.status,
		ref: pipeline?.ref ?? options.ref,
		headSha: pipeline?.sha,
		source: pipeline?.source,
		url: pipeline?.web_url,
		pollCount: options.pollCount,
		note: options.note,
		jobs: watchJobs,
		failedLogs: options.failedLogs,
	};
}

function formatWatchSnapshotText(
	repo: string,
	pipeline: GlPipelineApi | undefined,
	jobs: readonly GlJobApi[],
	bridges: readonly GlBridgeApi[],
	pollCount: number,
	note?: string,
): string {
	if (!pipeline) {
		return [`Watching ${repo} (poll ${pollCount})`, note].filter(Boolean).join("\n");
	}
	const lines = [
		`Watching pipeline #${pipeline.id ?? "?"} on ${repo} [${pipeline.status ?? "unknown"}] (poll ${pollCount})`,
	];
	pushLine(lines, "Ref", pipeline.ref);
	pushLine(lines, "Commit", formatShortSha(pipeline.sha));
	if (note) lines.push(note);
	if (jobs.length > 0 || bridges.length > 0) {
		lines.push("");
		for (const job of jobs) {
			const allow = job.allow_failure ? " (allowed to fail)" : "";
			lines.push(`- [${job.status ?? "unknown"}] ${job.stage ?? "default"}/${job.name ?? "job"}${allow}`);
		}
		for (const bridge of bridges) {
			const allow = bridge.allow_failure ? " (allowed to fail)" : "";
			const downstream = bridge.downstream_pipeline
				? ` → #${bridge.downstream_pipeline.id} [${bridge.downstream_pipeline.status ?? "unknown"}]`
				: "";
			lines.push(
				`- [${bridge.status ?? "unknown"}] ${bridge.stage ?? "default"}/${bridge.name ?? "trigger"} [trigger]${allow}${downstream}`,
			);
		}
	}
	return lines.join("\n").trim();
}

interface FailedJobTrace {
	job: {
		id?: number;
		name?: string;
		stage?: string;
		status?: string;
		failure_reason?: string | null;
		web_url?: string;
	};
	full?: string;
	tail?: string;
	available: boolean;
	truncated?: boolean;
	unavailableReason?: string;
}

const MAX_FAILED_JOB_TRACES = 20;
const TRACE_FETCH_CONCURRENCY = 4;

async function fetchFailedJobTraces(
	cwd: string,
	host: string,
	projectApiId: string,
	failedJobs: readonly GlJobApi[],
	failedBridges: readonly GlBridgeApi[],
	tail: number,
	signal: AbortSignal | undefined,
): Promise<FailedJobTrace[]> {
	const toFetch = failedJobs.slice(0, MAX_FAILED_JOB_TRACES);
	const skipped = failedJobs.slice(MAX_FAILED_JOB_TRACES);
	const jobTraces: FailedJobTrace[] = Array.from({ length: toFetch.length });
	let nextIndex = 0;

	const worker = async (): Promise<void> => {
		while (nextIndex < toFetch.length) {
			const idx = nextIndex++;
			const job = toFetch[idx]!;
			if (job.id === undefined) {
				jobTraces[idx] = { job, available: false, unavailableReason: "missing job ID" };
				continue;
			}
			try {
				const raw = await glabApiText(
					cwd,
					host,
					`projects/${projectApiId}/jobs/${job.id}/trace`,
					{ trimOutput: false },
					signal,
				);
				const captured = parseTraceCapture(raw);
				const tailed = tailLogLines(captured.text, tail);
				jobTraces[idx] = {
					job,
					full: captured.text,
					tail: tailed ?? "(empty log)",
					available: true,
					truncated: captured.truncated,
				};
			} catch (err) {
				if (err instanceof ToolAbortError) throw err;
				jobTraces[idx] = {
					job,
					available: false,
					unavailableReason: err instanceof Error ? err.message : String(err),
				};
			}
		}
	};

	const workerCount = Math.min(TRACE_FETCH_CONCURRENCY, toFetch.length);
	await Promise.all(Array.from({ length: workerCount }, () => worker()));

	for (const job of skipped) {
		jobTraces.push({
			job,
			available: false,
			unavailableReason: `skipped trace fetch (exceeded ${MAX_FAILED_JOB_TRACES} failed jobs limit)`,
		});
	}

	const bridgeEntries: FailedJobTrace[] = failedBridges.map(bridge => {
		const downstream = bridge.downstream_pipeline
			? `downstream pipeline #${bridge.downstream_pipeline.id} [${bridge.downstream_pipeline.status ?? "unknown"}]${bridge.downstream_pipeline.web_url ? ` ${bridge.downstream_pipeline.web_url}` : ""}`
			: "no downstream pipeline info";
		return {
			job: {
				id: bridge.id,
				name: `${bridge.name ?? "trigger"} [trigger]`,
				stage: bridge.stage,
				status: bridge.status,
				web_url: bridge.web_url,
			},
			available: false,
			unavailableReason: `trigger job failed (${downstream}); trigger jobs have no trace log`,
		};
	});

	return [...jobTraces, ...bridgeEntries];
}

function formatWatchFinalResult(
	project: string,
	pipeline: GlPipelineApi,
	jobs: readonly GlJobApi[],
	bridges: readonly GlBridgeApi[],
	failedTraces: readonly FailedJobTrace[],
	tail: number,
	mode: "tail" | "full",
): string {
	const nowMs = Date.now();
	const lines = [`# Pipeline #${pipeline.id ?? "?"} [${pipeline.status ?? "unknown"}]`, ""];
	pushLine(lines, "Project", project);
	pushLine(lines, "Ref", pipeline.ref);
	pushLine(lines, "Commit", formatShortSha(pipeline.sha));
	pushLine(lines, "Source", pipeline.source);
	if (pipeline.duration != null) pushLine(lines, "Duration", `${Math.round(pipeline.duration)}s`);
	pushLine(lines, "URL", pipeline.web_url);

	if (jobs.length > 0) {
		lines.push("", `## Jobs (${jobs.length})`);
		for (const group of groupJobsByStage(jobs)) {
			lines.push("", `### Stage: ${group.stage}`, "");
			for (const job of group.jobs) {
				const dur = getJobDurationSeconds(job, nowMs);
				const durText = dur !== undefined ? ` (${dur}s)` : "";
				const allow = job.allow_failure ? " (allowed to fail)" : "";
				lines.push(`- [${job.status ?? "unknown"}] ${job.name ?? "job"}${durText}${allow}`);
			}
		}
	}

	if (bridges.length > 0) {
		lines.push("", `## Downstream Bridges (${bridges.length})`, "");
		for (const bridge of bridges) {
			const allow = bridge.allow_failure ? " (allowed to fail)" : "";
			const downstream = bridge.downstream_pipeline
				? ` → #${bridge.downstream_pipeline.id} [${bridge.downstream_pipeline.status ?? "unknown"}] ${bridge.downstream_pipeline.web_url ?? ""}`
				: "";
			lines.push(
				`- [${bridge.status ?? "unknown"}] ${bridge.name ?? "bridge"} (${bridge.stage ?? "default"})${allow}${downstream}`,
			);
		}
	}

	if (failedTraces.length > 0) {
		lines.push("", "## Failed Jobs", "");
		for (const entry of failedTraces) {
			lines.push(`### ${entry.job.name ?? "job"} [${entry.job.status ?? "failed"}]`);
			pushLine(lines, "Stage", entry.job.stage);
			pushLine(lines, "Job ID", entry.job.id);
			pushLine(lines, "Failure reason", entry.job.failure_reason ?? undefined);
			pushLine(lines, "URL", entry.job.web_url);
			lines.push("");
			const text = mode === "full" ? entry.full : entry.tail;
			if (entry.available && text !== undefined) {
				lines.push(
					mode === "full"
						? entry.truncated
							? "Partial log (capture truncated after 8 MiB; end of job log not captured):"
							: "Full log:"
						: entry.truncated
							? `Last ${tail} captured log lines (capture truncated after 8 MiB; end of job log not captured):`
							: `Last ${tail} log lines:`,
				);
				lines.push("```text");
				lines.push(text);
				lines.push("```");
			} else {
				lines.push(mode === "full" ? "Full log unavailable." : "Log tail unavailable.");
				if (entry.unavailableReason) pushLine(lines, "Reason", entry.unavailableReason);
			}
			lines.push("");
		}
	}

	return lines.join("\n").trim();
}

export async function executePipelineWatch(
	session: ToolSession,
	params: GitlabInput,
	signal: AbortSignal | undefined,
	onUpdate: AgentToolUpdateCallback<GlToolDetails> | undefined,
): Promise<AgentToolResult<GlToolDetails>> {
	const pipelineUrl = parseGitlabPipelineUrl(normalizeOptionalString(params.pipeline));
	const mrUrl = parseGitlabMrUrl(requireSingleMrString(params.mr));
	const urlProject = requireConsistentUrlProject([pipelineUrl.project, mrUrl.project]);
	const projectRef = await resolveGitlabProject(session.cwd, normalizeOptionalString(params.repo), urlProject, signal);
	const tail = resolveTailLimit(params.tail);
	const graceSeconds = RUN_WATCH_GRACE_DEFAULT;
	const watchStartMs = Date.now();
	const currentIntervalSeconds = () =>
		Date.now() - watchStartMs < RUN_WATCH_FAST_WINDOW_MS ? RUN_WATCH_INTERVAL_DEFAULT : RUN_WATCH_INTERVAL_SLOW;

	let consecutivePollFailures = 0;
	const handlePollError = async (err: unknown): Promise<void> => {
		if (signal?.aborted) throw err;
		consecutivePollFailures += 1;
		if (!isRateLimitedGhError(err) || consecutivePollFailures > RUN_WATCH_MAX_POLL_FAILURES) throw err;
		await scheduler.wait(RUN_WATCH_INTERVAL_SLOW * 1000, { signal });
	};

	let pollCount = 0;
	let target: ResolvedPipelineTarget | undefined;
	while (true) {
		try {
			target = await resolvePipelineTarget(session.cwd, projectRef, params, signal);
			consecutivePollFailures = 0;
			break;
		} catch (err) {
			await handlePollError(err);
		}
	}
	while (!target) {
		throwIfAborted(signal);
		if (Date.now() - watchStartMs >= RUN_WATCH_NO_RUNS_GIVE_UP_MS) {
			const elapsedSec = Math.round((Date.now() - watchStartMs) / 1000);
			const completedWatch = buildWatchDetails(projectRef.full, undefined, [], [], {
				state: "completed",
				pollCount,
				ref: normalizeOptionalString(params.ref),
			});
			return buildGlTextResult(
				`No pipelines found for ${projectRef.full} after ${elapsedSec}s (${pollCount} polls). Pass \`pipeline\`, \`mr\`, or \`ref\` explicitly.`,
				undefined,
				{ repo: projectRef.full, watch: completedWatch },
				{ useless: true },
			);
		}
		pollCount += 1;
		const note = "Waiting for pipeline to appear...";
		const waitingWatch = buildWatchDetails(projectRef.full, undefined, [], [], {
			state: "watching",
			pollCount,
			note,
			ref: normalizeOptionalString(params.ref),
		});
		onUpdate?.({
			content: [
				{ type: "text", text: formatWatchSnapshotText(projectRef.full, undefined, [], [], pollCount, note) },
			],
			details: { repo: projectRef.full, watch: waitingWatch },
		});
		await scheduler.wait(currentIntervalSeconds() * 1000, { signal });
		try {
			target = await resolvePipelineTarget(session.cwd, projectRef, params, signal);
			consecutivePollFailures = 0;
		} catch (err) {
			await handlePollError(err);
		}
	}

	const projectApiId = pipelineApiProjectPath(projectRef, target.pipelineProjectId);
	const pipelineId = target.pipelineId;

	while (true) {
		throwIfAborted(signal);
		pollCount += 1;

		let pipeline: GlPipelineApi;
		let jobs: GlJobApi[];
		let bridges: GlBridgeApi[];
		try {
			({ pipeline, jobs, bridges } = await fetchPipelineSnapshot(
				session.cwd,
				projectRef.host,
				projectApiId,
				pipelineId,
				signal,
			));
		} catch (err) {
			await handlePollError(err);
			continue;
		}
		consecutivePollFailures = 0;

		const watchingDetails = buildWatchDetails(projectRef.full, pipeline, jobs, bridges, {
			state: "watching",
			pollCount,
		});
		onUpdate?.({
			content: [
				{ type: "text", text: formatWatchSnapshotText(projectRef.full, pipeline, jobs, bridges, pollCount) },
			],
			details: {
				repo: projectRef.full,
				branch: pipeline.ref,
				headSha: pipeline.sha,
				pipelineId,
				status: pipeline.status,
				watch: watchingDetails,
			},
		});

		let failedJobs = jobs.filter(isRealFailedJob);
		let failedBridges = bridges.filter(isRealFailedBridge);
		let isTerminal = pipeline.status !== undefined && TERMINAL_PIPELINE_STATUSES.has(pipeline.status);

		if (failedJobs.length > 0 || failedBridges.length > 0) {
			if (!isTerminal && graceSeconds > 0) {
				const note = `Failure detected. Waiting ${graceSeconds}s to capture concurrent failures before fetching logs.`;
				const graceWatch = buildWatchDetails(projectRef.full, pipeline, jobs, bridges, {
					state: "watching",
					pollCount,
					note,
				});
				onUpdate?.({
					content: [
						{
							type: "text",
							text: formatWatchSnapshotText(projectRef.full, pipeline, jobs, bridges, pollCount, note),
						},
					],
					details: {
						repo: projectRef.full,
						branch: pipeline.ref,
						headSha: pipeline.sha,
						pipelineId,
						status: pipeline.status,
						watch: graceWatch,
					},
				});
				await scheduler.wait(graceSeconds * 1000, { signal });
				try {
					const refetched = await fetchPipelineSnapshot(
						session.cwd,
						projectRef.host,
						projectApiId,
						pipelineId,
						signal,
					);
					// Always adopt the fresher snapshot: if an auto-retry replaced the failed attempt,
					// refetched failures drop to 0 and we must resume watching or report the new status.
					pipeline = refetched.pipeline;
					jobs = refetched.jobs;
					bridges = refetched.bridges;
					failedJobs = jobs.filter(isRealFailedJob);
					failedBridges = bridges.filter(isRealFailedBridge);
					isTerminal = pipeline.status !== undefined && TERMINAL_PIPELINE_STATUSES.has(pipeline.status);
				} catch (err) {
					if (signal?.aborted) throw err;
					if (isRateLimitedGhError(err)) {
						await handlePollError(err);
						continue;
					}
				}
			}

			if (failedJobs.length > 0 || failedBridges.length > 0) {
				const failedTraces = await fetchFailedJobTraces(
					session.cwd,
					projectRef.host,
					projectApiId,
					failedJobs,
					failedBridges,
					tail,
					signal,
				);
				const failedLogDetails: GlPipelineWatchFailedLogDetails[] = failedTraces.map(entry => ({
					pipelineId,
					jobId: entry.job.id ?? 0,
					jobName: entry.job.name ?? `job-${entry.job.id ?? "?"}`,
					stage: entry.job.stage,
					status: entry.job.status,
					tail: entry.tail,
					available: entry.available,
					unavailableReason: entry.unavailableReason,
				}));
				const finalWatch = buildWatchDetails(projectRef.full, pipeline, jobs, bridges, {
					state: "completed",
					pollCount,
					failedLogs: failedLogDetails,
				});
				const anyTruncated = failedTraces.some(entry => entry.truncated === true);
				const artifactId = await saveArtifactText(
					session,
					formatWatchFinalResult(projectRef.full, pipeline, jobs, bridges, failedTraces, tail, "full"),
				);
				const prefix = anyTruncated ? "Partial log (capture truncated after 8 MiB)" : "Full log";
				const artifactLabel =
					failedTraces.length === 1
						? `${prefix} for failed job '${failedTraces[0]!.job.name ?? failedTraces[0]!.job.id}'`
						: `${prefix}s for ${failedTraces.length} failed jobs`;

				return buildGlTextResult(
					formatWatchFinalResult(projectRef.full, pipeline, jobs, bridges, failedTraces, tail, "tail"),
					pipeline.web_url,
					{
						repo: projectRef.full,
						branch: pipeline.ref,
						headSha: pipeline.sha,
						pipelineId,
						status: pipeline.status,
						failedJobs: [
							...failedJobs.map(job => job.name ?? String(job.id ?? "job")),
							...failedBridges.map(bridge => `${bridge.name ?? String(bridge.id ?? "trigger")} [trigger]`),
						],
						artifactId,
						watch: finalWatch,
					},
					{ artifactId, artifactLabel },
				);
			}
		}

		if (isTerminal) {
			const finalWatch = buildWatchDetails(projectRef.full, pipeline, jobs, bridges, {
				state: "completed",
				pollCount,
			});
			return buildGlTextResult(
				formatWatchFinalResult(projectRef.full, pipeline, jobs, bridges, [], tail, "tail"),
				pipeline.web_url,
				{
					repo: projectRef.full,
					branch: pipeline.ref,
					headSha: pipeline.sha,
					pipelineId,
					status: pipeline.status,
					watch: finalWatch,
				},
			);
		}

		await scheduler.wait(currentIntervalSeconds() * 1000, { signal });
	}
}

export async function executeJobLog(
	session: ToolSession,
	params: GitlabInput,
	signal: AbortSignal | undefined,
): Promise<AgentToolResult<GlToolDetails>> {
	if (params.tail !== undefined && (!Number.isFinite(params.tail) || params.tail < 1)) {
		throw new ToolError("tail must be a positive number (>= 1)");
	}
	const tail = Math.min(Math.max(1, Math.floor(params.tail ?? JOB_LOG_TAIL_DEFAULT)), JOB_LOG_TAIL_MAX);
	const jobUrl = parseGitlabJobUrl(normalizeOptionalString(params.job));
	const pipelineUrl = parseGitlabPipelineUrl(normalizeOptionalString(params.pipeline));
	const mrUrl = parseGitlabMrUrl(requireSingleMrString(params.mr));
	const urlProject = requireConsistentUrlProject([jobUrl.project, pipelineUrl.project, mrUrl.project]);
	const ref = await resolveGitlabProject(session.cwd, normalizeOptionalString(params.repo), urlProject, signal);
	const resolved = await resolveJobInProject(session.cwd, ref, params, signal);

	const [job, rawTrace] = await Promise.all([
		glabApiJson<GlJobApi>(
			session.cwd,
			ref.host,
			`projects/${resolved.projectApiId}/jobs/${resolved.jobId}`,
			undefined,
			signal,
		),
		glabApiText(
			session.cwd,
			ref.host,
			`projects/${resolved.projectApiId}/jobs/${resolved.jobId}/trace`,
			{ trimOutput: false },
			signal,
		),
	]);

	const captured = parseTraceCapture(rawTrace);
	const normalizedTrace = captured.text.endsWith("\n") ? captured.text.slice(0, -1) : captured.text;
	const lines = normalizedTrace.length === 0 ? [] : normalizedTrace.split("\n");
	let artifactId: string | undefined;
	let body: string;
	if (lines.length > tail || captured.truncated) {
		artifactId = await saveArtifactText(session, captured.text);
		body = lines.length > tail ? lines.slice(-tail).join("\n") : normalizedTrace;
	} else {
		body = normalizedTrace;
	}

	const headerLines = [`# Job #${job.id ?? resolved.jobId}: ${job.name ?? "job"} [${job.status ?? "unknown"}]`, ""];
	pushLine(headerLines, "Project", ref.full);
	pushLine(headerLines, "Stage", job.stage);
	pushLine(headerLines, "Pipeline", job.pipeline?.id ?? resolved.pipelineId);
	pushLine(headerLines, "Ref", job.ref);
	if (job.failure_reason) pushLine(headerLines, "Failure reason", job.failure_reason);
	pushLine(headerLines, "URL", job.web_url);
	headerLines.push("");
	if (captured.truncated) {
		headerLines.push(
			lines.length > tail
				? `Last ${tail} of ${lines.length} captured log lines (trace truncated after 8 MiB; end of job log not captured):`
				: `Partial log (${lines.length} lines; trace truncated after 8 MiB; end of job log not captured):`,
		);
	} else {
		headerLines.push(
			lines.length > tail ? `Last ${tail} of ${lines.length} log lines:` : `Log (${lines.length} lines):`,
		);
	}
	headerLines.push("```text");
	headerLines.push(body);
	headerLines.push("```");

	return buildGlTextResult(
		headerLines.join("\n").trim(),
		job.web_url,
		{
			repo: ref.full,
			branch: job.ref,
			pipelineId: job.pipeline?.id ?? resolved.pipelineId,
			jobId: job.id ?? resolved.jobId,
			status: job.status,
			artifactId,
		},
		{
			artifactId,
			artifactLabel: captured.truncated ? "Partial job log (capture truncated after 8 MiB)" : "Full job log",
		},
	);
}

export async function executeJobRetry(
	session: ToolSession,
	params: GitlabInput,
	signal: AbortSignal | undefined,
): Promise<AgentToolResult<GlToolDetails>> {
	const jobUrl = parseGitlabJobUrl(normalizeOptionalString(params.job));
	const pipelineUrl = parseGitlabPipelineUrl(normalizeOptionalString(params.pipeline));
	const mrUrl = parseGitlabMrUrl(requireSingleMrString(params.mr));
	const urlProject = requireConsistentUrlProject([jobUrl.project, pipelineUrl.project, mrUrl.project]);
	const ref = await resolveGitlabProject(session.cwd, normalizeOptionalString(params.repo), urlProject, signal);
	const resolved = await resolveJobInProject(session.cwd, ref, params, signal);

	const retried = await glabApiJson<GlJobApi>(
		session.cwd,
		ref.host,
		`projects/${resolved.projectApiId}/jobs/${resolved.jobId}/retry`,
		{ method: "POST" },
		signal,
	);

	const lines = [`# Retried Job #${resolved.jobId}`, ""];
	pushLine(lines, "New job ID", retried.id);
	pushLine(lines, "Name", retried.name);
	pushLine(lines, "Stage", retried.stage);
	pushLine(lines, "Status", retried.status);
	pushLine(lines, "Pipeline", retried.pipeline?.id ?? resolved.pipelineId);
	pushLine(lines, "URL", retried.web_url);

	return buildGlTextResult(lines.join("\n").trim(), retried.web_url, {
		repo: ref.full,
		pipelineId: retried.pipeline?.id ?? resolved.pipelineId,
		jobId: retried.id,
		status: retried.status,
	});
}

export async function executeCiLint(
	session: ToolSession,
	params: GitlabInput,
	signal: AbortSignal | undefined,
): Promise<AgentToolResult<GlToolDetails>> {
	const explicitRepo = normalizeOptionalString(params.repo);
	const ref = explicitRepo ? await resolveGitlabProject(session.cwd, explicitRepo, undefined, signal) : undefined;
	const args = ["ci", "lint"];
	if (ref) {
		args.push("-R", formatGitlabProjectArg(ref.full));
	}
	if (params.dryRun === true) args.push("--dry-run");
	const refFlag = normalizeOptionalString(params.ref);
	if (refFlag) args.push("--ref", refFlag);
	if (params.includeJobs === true) args.push("--include-jobs");
	const ciPath = normalizeOptionalString(params.path);
	if (ciPath) {
		if (ciPath.startsWith("-")) {
			throw new ToolError(`Invalid CI config path '${ciPath}': path must not start with '-'.`);
		}
		args.push(ciPath);
	}

	const output = await gitlab.text(session.cwd, args, signal);
	return buildGlTextResult(output.trim() || "CI configuration is valid.", undefined, {
		repo: ref?.full,
		branch: refFlag,
	});
}
