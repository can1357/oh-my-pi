import { scheduler } from "node:timers/promises";
import type { AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import { github } from "../utils/github";
import type { ToolSession } from ".";
import type {
	GhRunWatchFailedLogDetails,
	GhRunWatchJobDetails,
	GhRunWatchRunDetails,
	GhRunWatchViewDetails,
	GhToolDetails,
} from "./gh";
import {
	buildTextResult,
	formatRepoRef,
	ghApiHostArgs,
	githubRepoSlugEquals,
	normalizeBlock,
	normalizeOptionalString,
	parseRepoRef,
	pushLine,
	requireCurrentGitBranch,
	requireCurrentGitHead,
	requireNonEmpty,
	resolveGitHubRepo,
	saveArtifactText,
	tryResolveCurrentRepoFresh,
} from "./gh-common";
import { formatShortSha } from "./gh-format";
import type {
	GhActionsJobApi,
	GhActionsJobsResponse,
	GhActionsRunApi,
	GhActionsRunListResponse,
	GhBranchApiResponse,
	GhFailedJobLog,
	GhRunJobSnapshot,
	GhRunReference,
	GhRunSnapshot,
	GithubInput,
} from "./gh-types";
import { ToolError, throwIfAborted } from "./tool-errors";

export const RUN_WATCH_INTERVAL_DEFAULT = 3;
export const RUN_WATCH_INTERVAL_SLOW = 15;
export const RUN_WATCH_FAST_WINDOW_MS = 60_000;
export const RUN_WATCH_NO_RUNS_GIVE_UP_MS = 90_000;
export const RUN_WATCH_MAX_POLL_FAILURES = 5;
export const RUN_WATCH_GRACE_DEFAULT = 5;
export const RUN_WATCH_TAIL_DEFAULT = 15;
export const RUN_WATCH_TAIL_MAX = 200;

export const RUN_JOBS_PAGE_SIZE = 100;

export function resolveTailLimit(value: number | undefined): number {
	if (value === undefined) {
		return RUN_WATCH_TAIL_DEFAULT;
	}

	if (!Number.isFinite(value) || value <= 0) {
		throw new ToolError("tail must be a positive number");
	}

	return Math.min(Math.floor(value), RUN_WATCH_TAIL_MAX);
}

export const RUN_URL_PATTERN = /^https:\/\/([^/]+)\/([^/]+\/[^/]+)\/actions\/runs\/(\d+)(?:\/.*)?$/;
export const RUN_SUCCESS_CONCLUSIONS = new Set(["success", "neutral", "skipped"]);
export const RUN_FAILURE_CONCLUSIONS = new Set([
	"failure",
	"timed_out",
	"cancelled",
	"action_required",
	"startup_failure",
]);
export const JOB_FAILURE_CONCLUSIONS = new Set(["failure", "timed_out", "cancelled", "action_required"]);

export function parseRunReference(value: string | undefined): GhRunReference {
	const run = normalizeOptionalString(value);
	if (!run) {
		return {};
	}

	if (/^\d+$/.test(run)) {
		return { runId: Number(run) };
	}

	const match = run.match(RUN_URL_PATTERN);
	if (!match) {
		throw new ToolError("run must be a numeric workflow run ID or a full GitHub Actions run URL");
	}

	return {
		repo: formatRepoRef(match[1], match[2]),
		runId: Number(match[3]),
	};
}

export function normalizeRunJob(job: GhActionsJobApi): GhRunJobSnapshot | null {
	if (typeof job.id !== "number") {
		return null;
	}

	return {
		id: job.id,
		name: normalizeOptionalString(job.name) ?? `job-${job.id}`,
		status: normalizeOptionalString(job.status),
		conclusion: normalizeOptionalString(job.conclusion),
		startedAt: normalizeOptionalString(job.started_at),
		completedAt: normalizeOptionalString(job.completed_at),
		url: normalizeOptionalString(job.html_url),
	};
}

export function normalizeRunSnapshot(run: GhActionsRunApi, jobs: GhRunJobSnapshot[]): GhRunSnapshot {
	if (typeof run.id !== "number") {
		throw new ToolError("GitHub Actions run response did not include a run ID.");
	}

	return {
		id: run.id,
		workflowName: normalizeOptionalString(run.name),
		displayTitle: normalizeOptionalString(run.display_title),
		status: normalizeOptionalString(run.status),
		conclusion: normalizeOptionalString(run.conclusion),
		branch: normalizeOptionalString(run.head_branch),
		headSha: normalizeOptionalString(run.head_sha),
		createdAt: normalizeOptionalString(run.created_at),
		updatedAt: normalizeOptionalString(run.updated_at),
		url: normalizeOptionalString(run.html_url),
		jobs,
	};
}

export function getRunOutcome(value: string | undefined): "success" | "failure" | "pending" {
	if (!value) {
		return "pending";
	}

	if (RUN_SUCCESS_CONCLUSIONS.has(value)) {
		return "success";
	}

	if (RUN_FAILURE_CONCLUSIONS.has(value)) {
		return "failure";
	}

	return "pending";
}

export function getRunSnapshotOutcome(run: GhRunSnapshot): "success" | "failure" | "pending" {
	if (run.status !== "completed") {
		return "pending";
	}

	return getRunOutcome(run.conclusion);
}

export function getRunCollectionOutcome(runs: GhRunSnapshot[]): "success" | "failure" | "pending" {
	if (runs.length === 0) {
		return "pending";
	}

	let pending = false;
	for (const run of runs) {
		if (run.jobs.some(isFailedJob)) {
			return "failure";
		}

		const outcome = getRunSnapshotOutcome(run);
		if (outcome === "failure") {
			return "failure";
		}
		if (outcome === "pending") {
			pending = true;
		}
	}

	return pending ? "pending" : "success";
}

export function getRunCollectionSignature(runs: GhRunSnapshot[]): string {
	return runs
		.map(run => run.id)
		.sort((left, right) => left - right)
		.join(",");
}

export function isFailedJob(job: GhRunJobSnapshot): boolean {
	return job.conclusion !== undefined && JOB_FAILURE_CONCLUSIONS.has(job.conclusion);
}

export const GH_RATE_LIMIT_ERROR_PATTERN = /rate limit|HTTP 429|abuse detection/i;

/**
 * Rate-limit / secondary-limit gh failures are transient; the run_watch poll
 * loops back off and retry them instead of discarding the whole watch.
 */
export function isRateLimitedGhError(err: unknown): boolean {
	return err instanceof ToolError && GH_RATE_LIMIT_ERROR_PATTERN.test(err.message);
}

export function formatJobState(job: GhRunJobSnapshot): string {
	return job.conclusion ?? job.status ?? "unknown";
}

export function parseTimestampMs(value: string | undefined): number | undefined {
	if (!value) {
		return undefined;
	}

	const timestamp = Date.parse(value);
	return Number.isNaN(timestamp) ? undefined : timestamp;
}

export function getJobDurationSeconds(job: GhRunJobSnapshot, observedAtMs: number): number | undefined {
	const startedAtMs = parseTimestampMs(job.startedAt);
	if (startedAtMs === undefined) {
		return undefined;
	}

	const completedAtMs = parseTimestampMs(job.completedAt) ?? observedAtMs;
	return Math.max(0, Math.floor((completedAtMs - startedAtMs) / 1000));
}

export function buildRunWatchJobDetails(job: GhRunJobSnapshot, observedAtMs: number): GhRunWatchJobDetails {
	return {
		id: job.id,
		name: job.name,
		status: job.status,
		conclusion: job.conclusion,
		durationSeconds: getJobDurationSeconds(job, observedAtMs),
		url: job.url,
	};
}

export function buildRunWatchRunDetails(run: GhRunSnapshot, observedAtMs: number): GhRunWatchRunDetails {
	return {
		id: run.id,
		workflowName: run.workflowName,
		displayTitle: run.displayTitle,
		status: run.status,
		conclusion: run.conclusion,
		branch: run.branch,
		headSha: run.headSha,
		url: run.url,
		jobs: run.jobs.map(job => buildRunWatchJobDetails(job, observedAtMs)),
	};
}

export function buildFailedLogDetails(failedJobLogs: GhFailedJobLog[]): GhRunWatchFailedLogDetails[] {
	return failedJobLogs.map(entry => ({
		runId: entry.run.id,
		workflowName: entry.run.workflowName,
		jobName: entry.job.name,
		conclusion: entry.job.conclusion,
		tail: entry.tail,
		available: entry.available,
	}));
}

export function renderJobsSection(jobs: GhRunJobSnapshot[]): string[] {
	if (jobs.length === 0) {
		return ["## Jobs", "", "No jobs reported yet."];
	}

	const lines: string[] = [`## Jobs (${jobs.length})`, ""];
	for (const job of jobs) {
		lines.push(`- [${formatJobState(job)}] ${job.name}`);
		if (job.startedAt) {
			pushLine(lines, "  Started", job.startedAt);
		}
		if (job.completedAt) {
			pushLine(lines, "  Completed", job.completedAt);
		}
		if (job.url) {
			pushLine(lines, "  URL", job.url);
		}
	}

	return lines;
}

export function renderFailedJobLogs(
	failedJobLogs: GhFailedJobLog[],
	options: { mode: "tail"; tail: number } | { mode: "full" },
): string[] {
	if (failedJobLogs.length === 0) {
		return [];
	}

	const lines: string[] = ["## Failed Jobs", ""];
	for (const entry of failedJobLogs) {
		lines.push(`### ${entry.job.name} [${entry.job.conclusion ?? "failed"}]`);
		pushLine(lines, "Run", `#${entry.run.id}`);
		pushLine(lines, "Workflow", entry.run.workflowName ?? undefined);
		if (entry.job.startedAt) {
			pushLine(lines, "Started", entry.job.startedAt);
		}
		if (entry.job.completedAt) {
			pushLine(lines, "Completed", entry.job.completedAt);
		}
		if (entry.job.url) {
			pushLine(lines, "URL", entry.job.url);
		}
		lines.push("");
		const logText = options.mode === "full" ? entry.full : entry.tail;
		if (entry.available && logText) {
			lines.push(options.mode === "full" ? "Full log:" : `Last ${options.tail} log lines:`);
			lines.push("```text");
			lines.push(logText);
			lines.push("```");
		} else {
			lines.push(options.mode === "full" ? "Full log unavailable." : "Log tail unavailable.");
		}
		lines.push("");
	}

	return lines;
}

export function renderRunSection(run: GhRunSnapshot): string[] {
	const label = run.workflowName ? `### Run #${run.id} - ${run.workflowName}` : `### Run #${run.id}`;
	const lines: string[] = [label, ""];
	pushLine(lines, "Title", run.displayTitle ?? undefined);
	pushLine(lines, "Branch", run.branch ?? undefined);
	pushLine(lines, "Commit", formatShortSha(run.headSha));
	pushLine(lines, "Status", run.status);
	pushLine(lines, "Conclusion", run.conclusion ?? undefined);
	pushLine(lines, "Created", run.createdAt);
	pushLine(lines, "Updated", run.updatedAt);
	pushLine(lines, "URL", run.url);
	lines.push("");
	lines.push(...renderJobsSection(run.jobs));
	return lines;
}

export function formatRunWatchSnapshot(
	repo: string,
	run: GhRunSnapshot,
	pollCount: number,
	note?: string,
	includeOutcome: boolean = false,
): string {
	const failedJobs = run.jobs.filter(isFailedJob);
	const lines: string[] = [`# Watching GitHub Actions Run #${run.id}`, ""];
	pushLine(lines, "Repository", repo);
	pushLine(lines, "Workflow", run.workflowName ?? undefined);
	pushLine(lines, "Title", run.displayTitle ?? undefined);
	pushLine(lines, "Branch", run.branch ?? undefined);
	pushLine(lines, "Status", run.status);
	pushLine(lines, "Conclusion", run.conclusion ?? undefined);
	pushLine(lines, "Created", run.createdAt);
	pushLine(lines, "Updated", run.updatedAt);
	pushLine(lines, "URL", run.url);
	pushLine(lines, "Poll", pollCount);
	pushLine(lines, "Failed jobs", failedJobs.length || undefined);

	if (note) {
		lines.push("");
		lines.push(`Note: ${note}`);
	}

	lines.push("");
	lines.push(...renderJobsSection(run.jobs));

	if (includeOutcome) {
		lines.push("");
		lines.push(failedJobs.length > 0 ? "Failures detected." : "All jobs passed.");
	}

	return lines.join("\n").trim();
}

export function formatRunWatchResult(
	repo: string,
	run: GhRunSnapshot,
	failedJobLogs: GhFailedJobLog[],
	tail: number,
	options?: { mode?: "tail" | "full" },
): string {
	const failedJobs = run.jobs.filter(isFailedJob);
	const lines: string[] = [`# GitHub Actions Run #${run.id}`, ""];
	pushLine(lines, "Repository", repo);
	pushLine(lines, "Workflow", run.workflowName ?? undefined);
	pushLine(lines, "Title", run.displayTitle ?? undefined);
	pushLine(lines, "Branch", run.branch ?? undefined);
	pushLine(lines, "Status", run.status);
	pushLine(lines, "Conclusion", run.conclusion ?? undefined);
	pushLine(lines, "Created", run.createdAt);
	pushLine(lines, "Updated", run.updatedAt);
	pushLine(lines, "URL", run.url);
	lines.push("");
	lines.push(...renderJobsSection(run.jobs));

	if (failedJobs.length > 0) {
		lines.push("");
		lines.push(
			...renderFailedJobLogs(failedJobLogs, options?.mode === "full" ? { mode: "full" } : { mode: "tail", tail }),
		);
		lines.push("Run failed.");
	} else if (getRunOutcome(run.conclusion) === "success") {
		lines.push("");
		lines.push("All jobs passed.");
	} else {
		lines.push("");
		lines.push("Run completed without successful jobs, but no failed job logs were available.");
	}

	return lines.join("\n").trim();
}

export function formatCommitRunWatchSnapshot(
	repo: string,
	headSha: string,
	branch: string | undefined,
	runs: GhRunSnapshot[],
	pollCount: number,
	note?: string,
): string {
	const failedJobs = runs.flatMap(run => run.jobs.filter(isFailedJob));
	const completedRuns = runs.filter(run => run.status === "completed").length;
	const lines: string[] = [`# Watching GitHub Actions for ${formatShortSha(headSha) ?? headSha}`, ""];
	pushLine(lines, "Repository", repo);
	pushLine(lines, "Branch", branch);
	pushLine(lines, "Commit", headSha);
	pushLine(lines, "Poll", pollCount);
	pushLine(lines, "Runs", runs.length);
	pushLine(lines, "Completed runs", `${completedRuns}/${runs.length}`);
	pushLine(lines, "Failed jobs", failedJobs.length || undefined);

	if (note) {
		lines.push("");
		lines.push(`Note: ${note}`);
	}

	if (runs.length === 0) {
		lines.push("");
		lines.push("Waiting for workflow runs for this commit.");
		return lines.join("\n").trim();
	}

	for (const run of runs) {
		lines.push("");
		lines.push(...renderRunSection(run));
	}

	return lines.join("\n").trim();
}

export function formatCommitRunWatchResult(
	repo: string,
	headSha: string,
	branch: string | undefined,
	runs: GhRunSnapshot[],
	failedJobLogs: GhFailedJobLog[],
	tail: number,
	options?: { mode?: "tail" | "full" },
): string {
	const outcome = getRunCollectionOutcome(runs);
	const lines: string[] = [`# GitHub Actions for ${formatShortSha(headSha) ?? headSha}`, ""];
	pushLine(lines, "Repository", repo);
	pushLine(lines, "Branch", branch);
	pushLine(lines, "Commit", headSha);
	pushLine(lines, "Runs", runs.length);

	for (const run of runs) {
		lines.push("");
		lines.push(...renderRunSection(run));
	}

	if (failedJobLogs.length > 0) {
		lines.push("");
		lines.push(
			...renderFailedJobLogs(failedJobLogs, options?.mode === "full" ? { mode: "full" } : { mode: "tail", tail }),
		);
		lines.push("Workflow runs for this commit failed.");
	} else if (outcome === "success") {
		lines.push("");
		lines.push("All workflow runs for this commit passed.");
	} else {
		lines.push("");
		lines.push("Workflow runs for this commit did not complete successfully.");
	}

	return lines.join("\n").trim();
}

export function buildGhDetails(repo: string, run: GhRunSnapshot): GhToolDetails {
	return {
		repo,
		branch: run.branch,
		headSha: run.headSha,
		runId: run.id,
		runIds: [run.id],
		status: run.status,
		conclusion: run.conclusion,
		failedJobs: run.jobs.filter(isFailedJob).map(job => job.name),
	};
}

export function buildRunWatchDetails(
	repo: string,
	run: GhRunSnapshot,
	options?: {
		state?: GhRunWatchViewDetails["state"];
		pollCount?: number;
		note?: string;
		failedJobLogs?: GhFailedJobLog[];
	},
): GhToolDetails {
	const observedAtMs = Date.now();
	return {
		...buildGhDetails(repo, run),
		watch: {
			mode: "run",
			state: options?.state ?? "completed",
			repo,
			branch: run.branch,
			headSha: run.headSha,
			pollCount: options?.pollCount,
			note: options?.note,
			run: buildRunWatchRunDetails(run, observedAtMs),
			failedLogs: buildFailedLogDetails(options?.failedJobLogs ?? []),
		},
	};
}

export function buildGhRunCollectionDetails(
	repo: string,
	headSha: string,
	branch: string | undefined,
	runs: GhRunSnapshot[],
): GhToolDetails {
	const outcome = getRunCollectionOutcome(runs);
	return {
		repo,
		branch,
		headSha,
		runIds: runs.map(run => run.id),
		status: runs.length > 0 && runs.every(run => run.status === "completed") ? "completed" : "in_progress",
		conclusion: outcome,
		failedJobs: runs.flatMap(run =>
			run.jobs.filter(isFailedJob).map(job => `${run.workflowName ?? `run ${run.id}`}: ${job.name}`),
		),
	};
}

export function buildCommitRunWatchDetails(
	repo: string,
	headSha: string,
	branch: string | undefined,
	runs: GhRunSnapshot[],
	options?: {
		state?: GhRunWatchViewDetails["state"];
		pollCount?: number;
		note?: string;
		failedJobLogs?: GhFailedJobLog[];
	},
): GhToolDetails {
	const observedAtMs = Date.now();
	return {
		...buildGhRunCollectionDetails(repo, headSha, branch, runs),
		watch: {
			mode: "commit",
			state: options?.state ?? "completed",
			repo,
			branch,
			headSha,
			pollCount: options?.pollCount,
			note: options?.note,
			runs: runs.map(run => buildRunWatchRunDetails(run, observedAtMs)),
			failedLogs: buildFailedLogDetails(options?.failedJobLogs ?? []),
		},
	};
}

export async function resolveGitHubBranchHead(
	cwd: string,
	repo: string,
	branch: string,
	signal?: AbortSignal,
): Promise<string> {
	const ref = parseRepoRef(repo);
	const response = await github.json<GhBranchApiResponse>(
		cwd,
		["api", ...ghApiHostArgs(ref), "--method", "GET", `/repos/${ref.slug}/branches/${encodeURIComponent(branch)}`],
		signal,
		{ repoProvided: true },
	);
	return requireNonEmpty(response.commit?.sha, `head SHA for branch ${branch}`);
}

export async function fetchRunsForCommit(
	cwd: string,
	repo: string,
	headSha: string,
	signal?: AbortSignal,
	completedRunJobsCache?: Map<number, GhRunJobSnapshot[]>,
): Promise<GhRunSnapshot[]> {
	// Filter only by `head_sha`. The SHA uniquely identifies the commit, so
	// adding the GitHub `branch=` filter would wrongly exclude workflow runs
	// whose `head_branch` is not the local checkout — e.g. tag-push triggered
	// release workflows (`head_branch=v1.2.3`) or PR-triggered runs
	// (`head_branch=<pr head>`). See coding-agent issue tracker for details.
	const ref = parseRepoRef(repo);
	const response = await github.json<GhActionsRunListResponse>(
		cwd,
		[
			"api",
			...ghApiHostArgs(ref),
			"--method",
			"GET",
			`/repos/${ref.slug}/actions/runs`,
			"-F",
			`head_sha=${headSha}`,
			"-F",
			`per_page=${RUN_JOBS_PAGE_SIZE}`,
		],
		signal,
		{ repoProvided: true },
	);

	return Promise.all(
		(response.workflow_runs ?? [])
			.filter((run): run is GhActionsRunApi & { id: number } => typeof run.id === "number")
			.map(async run => {
				// Completed runs' job lists are stable until a re-run flips
				// `status` off "completed"; reuse them across watch polls so a
				// long watch does not refetch every finished run's jobs. A run
				// observed non-completed evicts its entry — when the re-run
				// completes, `status` flips back to "completed" and a stale
				// entry would serve the FIRST attempt's jobs and logs forever.
				const completed = run.status === "completed";
				if (!completed) completedRunJobsCache?.delete(run.id);
				let jobs = completed ? completedRunJobsCache?.get(run.id) : undefined;
				if (!jobs) {
					jobs = await fetchRunJobs(cwd, repo, run.id, signal);
					if (completed) completedRunJobsCache?.set(run.id, jobs);
				}
				return normalizeRunSnapshot(run, jobs);
			}),
	);
}

export async function fetchRunJobs(
	cwd: string,
	repo: string,
	runId: number,
	signal?: AbortSignal,
): Promise<GhRunJobSnapshot[]> {
	const ref = parseRepoRef(repo);
	const jobs: GhRunJobSnapshot[] = [];
	let page = 1;

	while (true) {
		const response = await github.json<GhActionsJobsResponse>(
			cwd,
			[
				"api",
				...ghApiHostArgs(ref),
				"--method",
				"GET",
				`/repos/${ref.slug}/actions/runs/${runId}/jobs`,
				"-F",
				`per_page=${RUN_JOBS_PAGE_SIZE}`,
				"-F",
				`page=${page}`,
			],
			signal,
			{ repoProvided: true },
		);
		const rawPage = response.jobs ?? [];
		const pageJobs = rawPage.map(job => normalizeRunJob(job)).filter((job): job is GhRunJobSnapshot => job !== null);
		jobs.push(...pageJobs);

		// Compare the raw page length: normalizeRunJob drops malformed items,
		// and a post-filter short page must not end pagination early.
		if (rawPage.length < RUN_JOBS_PAGE_SIZE) {
			break;
		}

		if ((response.total_count ?? 0) <= jobs.length) {
			break;
		}

		page += 1;
	}

	return jobs;
}

export async function fetchRunSnapshot(
	cwd: string,
	repo: string,
	runId: number,
	signal?: AbortSignal,
): Promise<GhRunSnapshot> {
	const ref = parseRepoRef(repo);
	const [run, jobs] = await Promise.all([
		github.json<GhActionsRunApi>(
			cwd,
			["api", ...ghApiHostArgs(ref), "--method", "GET", `/repos/${ref.slug}/actions/runs/${runId}`],
			signal,
			{
				repoProvided: true,
			},
		),
		fetchRunJobs(cwd, repo, runId, signal),
	]);

	return normalizeRunSnapshot(run, jobs);
}

export function tailLogLines(log: string, tail: number): string | undefined {
	const normalized = normalizeBlock(log);
	if (!normalized) {
		return undefined;
	}

	const lines = normalized.split("\n");
	return lines.slice(-tail).join("\n").trimEnd();
}

export async function fetchFailedJobLogs(
	cwd: string,
	repo: string,
	failedJobs: Array<{ run: GhRunSnapshot; job: GhRunJobSnapshot }>,
	tail: number,
	signal?: AbortSignal,
): Promise<GhFailedJobLog[]> {
	const ref = parseRepoRef(repo);
	return Promise.all(
		failedJobs.map(async entry => {
			const result = await github.run(
				cwd,
				["api", ...ghApiHostArgs(ref), `/repos/${ref.slug}/actions/jobs/${entry.job.id}/logs`],
				signal,
			);
			const fullLog = result.exitCode === 0 ? normalizeBlock(result.stdout) : undefined;
			const logTail = fullLog ? tailLogLines(fullLog, tail) : undefined;
			return {
				run: entry.run,
				job: entry.job,
				full: fullLog,
				tail: logTail,
				available: Boolean(fullLog),
			};
		}),
	);
}

export async function executeRunWatch(
	session: ToolSession,
	toolName: string,
	params: GithubInput,
	signal: AbortSignal | undefined,
	onUpdate: AgentToolUpdateCallback<GhToolDetails> | undefined,
): Promise<AgentToolResult<GhToolDetails>> {
	const branchInput = normalizeOptionalString(params.branch);
	const explicitRepo = normalizeOptionalString(params.repo);
	const runReference = parseRunReference(params.run);
	const repo = await resolveGitHubRepo(session.cwd, explicitRepo, runReference.repo, signal);
	const graceSeconds = RUN_WATCH_GRACE_DEFAULT;
	const tail = resolveTailLimit(params.tail);
	const watchStartMs = Date.now();
	// Fast polls for the first minute for snappy feedback, then back off:
	// every commit-watch poll is one runs-list call plus one jobs call per
	// non-completed run, and long builds must not burn the shared
	// authenticated REST quota.
	const currentIntervalSeconds = () =>
		Date.now() - watchStartMs < RUN_WATCH_FAST_WINDOW_MS ? RUN_WATCH_INTERVAL_DEFAULT : RUN_WATCH_INTERVAL_SLOW;
	let consecutivePollFailures = 0;
	const handlePollError = async (err: unknown): Promise<void> => {
		if (signal?.aborted) throw err;
		consecutivePollFailures += 1;
		if (!isRateLimitedGhError(err) || consecutivePollFailures > RUN_WATCH_MAX_POLL_FAILURES) throw err;
		// Rate-limited: back off with the slow interval and retry instead of
		// discarding the whole watch (and its accumulated context).
		await scheduler.wait(RUN_WATCH_INTERVAL_SLOW * 1000, { signal });
	};
	if (runReference.runId !== undefined) {
		const runId = runReference.runId;
		let pollCount = 0;

		while (true) {
			throwIfAborted(signal);
			pollCount += 1;

			let run: GhRunSnapshot;
			try {
				run = await fetchRunSnapshot(session.cwd, repo, runId, signal);
			} catch (err) {
				await handlePollError(err);
				continue;
			}
			consecutivePollFailures = 0;
			const details = buildRunWatchDetails(repo, run, {
				state: "watching",
				pollCount,
			});
			onUpdate?.({
				content: [{ type: "text", text: formatRunWatchSnapshot(repo, run, pollCount) }],
				details,
			});

			let failedJobs = run.jobs.filter(isFailedJob);
			const runCompleted = run.status === "completed";

			if (failedJobs.length > 0) {
				if (!runCompleted && graceSeconds > 0) {
					const note = `Failure detected. Waiting ${graceSeconds}s to capture concurrent failures before fetching logs.`;
					onUpdate?.({
						content: [
							{
								type: "text",
								text: formatRunWatchSnapshot(repo, run, pollCount, note),
							},
						],
						details: buildRunWatchDetails(repo, run, {
							state: "watching",
							pollCount,
							note,
						}),
					});
					await scheduler.wait(graceSeconds * 1000, { signal });
					try {
						const refetched = await fetchRunSnapshot(session.cwd, repo, runId, signal);
						const refetchedFailed = refetched.jobs.filter(isFailedJob);
						// An auto-retry can reset job conclusions between
						// detection and refetch; keep the originally-detected
						// failure list (and its snapshot) when the refetch no
						// longer shows any failures so the watch never ends
						// with a failure result and zero logs.
						if (refetchedFailed.length > 0) {
							run = refetched;
							failedJobs = refetchedFailed;
						}
					} catch (err) {
						if (signal?.aborted) throw err;
						// Refetch failure: report from the original snapshot.
					}
				}

				const failedJobLogs = await fetchFailedJobLogs(
					session.cwd,
					repo,
					failedJobs.map(job => ({ run, job })),
					tail,
					signal,
				);
				const finalDetails = buildRunWatchDetails(repo, run, {
					state: "completed",
					failedJobLogs,
				});
				const artifactId = await saveArtifactText(
					session,
					toolName,
					formatRunWatchResult(repo, run, failedJobLogs, tail, { mode: "full" }),
				);
				return buildTextResult(
					formatRunWatchResult(repo, run, failedJobLogs, tail),
					run.url,
					{ ...finalDetails, artifactId },
					{ artifactId, artifactLabel: "Full failed-job logs" },
				);
			}

			if (runCompleted) {
				const finalDetails = buildRunWatchDetails(repo, run, {
					state: "completed",
				});
				return buildTextResult(formatRunWatchResult(repo, run, [], tail), run.url, finalDetails);
			}

			await scheduler.wait(currentIntervalSeconds() * 1000, { signal });
		}
	}

	let branch: string;
	let headSha: string;
	if (branchInput) {
		branch = branchInput;
		headSha = await resolveGitHubBranchHead(session.cwd, repo, branch, signal);
	} else {
		// No branch/run selector — derive the commit from the current checkout,
		// but only when cwd actually points at `repo`. Otherwise we'd watch an
		// unrelated commit SHA against the explicit repo and silently stream a
		// confident wrong-repo status (issue #1949). GitHub `owner/repo` slugs
		// are case-insensitive — `gh repo view` returns the canonical casing
		// while callers may pass any casing — so the equality check normalizes
		// both sides before deciding the cwd is a different repo (PR #1951).
		const cwdRepo = await tryResolveCurrentRepoFresh(session.cwd, signal);
		if (!githubRepoSlugEquals(cwdRepo, repo)) {
			throw new ToolError(
				`Cannot infer the watched commit for ${repo}: current checkout is ${cwdRepo ?? "not a GitHub repository"}. Pass \`branch\` or \`run\` to scope the watch.`,
			);
		}
		branch = await requireCurrentGitBranch(session.cwd, signal);
		headSha = await requireCurrentGitHead(session.cwd, signal);
	}
	let pollCount = 0;
	let settledSuccessSignature: string | undefined;
	let everSawRuns = false;
	const completedRunJobsCache = new Map<number, GhRunJobSnapshot[]>();

	while (true) {
		throwIfAborted(signal);
		pollCount += 1;

		let runs: GhRunSnapshot[];
		try {
			runs = await fetchRunsForCommit(session.cwd, repo, headSha, signal, completedRunJobsCache);
		} catch (err) {
			await handlePollError(err);
			continue;
		}
		consecutivePollFailures = 0;
		if (runs.length > 0) everSawRuns = true;
		const details = buildCommitRunWatchDetails(repo, headSha, branch, runs, {
			state: "watching",
			pollCount,
		});
		onUpdate?.({
			content: [{ type: "text", text: formatCommitRunWatchSnapshot(repo, headSha, branch, runs, pollCount) }],
			details,
		});

		const outcome = getRunCollectionOutcome(runs);
		if (outcome === "failure") {
			let failedPairs = runs.flatMap(run => run.jobs.filter(isFailedJob).map(job => ({ run, job })));
			if (graceSeconds > 0) {
				const note = `Failure detected. Waiting ${graceSeconds}s to capture concurrent failures before fetching logs.`;
				onUpdate?.({
					content: [
						{
							type: "text",
							text: formatCommitRunWatchSnapshot(repo, headSha, branch, runs, pollCount, note),
						},
					],
					details: buildCommitRunWatchDetails(repo, headSha, branch, runs, {
						state: "watching",
						pollCount,
						note,
					}),
				});
				await scheduler.wait(graceSeconds * 1000, { signal });
				try {
					const refetched = await fetchRunsForCommit(session.cwd, repo, headSha, signal, completedRunJobsCache);
					const refetchedPairs = refetched.flatMap(run => run.jobs.filter(isFailedJob).map(job => ({ run, job })));
					// Keep the originally-detected failure list when an
					// auto-retry reset the conclusions during the grace window
					// (see the run-id branch above).
					if (refetchedPairs.length > 0) {
						runs = refetched;
						failedPairs = refetchedPairs;
					}
				} catch (err) {
					if (signal?.aborted) throw err;
					// Refetch failure: report from the original snapshots.
				}
			}

			const failedJobLogs = await fetchFailedJobLogs(session.cwd, repo, failedPairs, tail, signal);
			const finalDetails = buildCommitRunWatchDetails(repo, headSha, branch, runs, {
				state: "completed",
				failedJobLogs,
			});
			const artifactId = await saveArtifactText(
				session,
				toolName,
				formatCommitRunWatchResult(repo, headSha, branch, runs, failedJobLogs, tail, { mode: "full" }),
			);
			return buildTextResult(
				formatCommitRunWatchResult(repo, headSha, branch, runs, failedJobLogs, tail),
				undefined,
				{ ...finalDetails, artifactId },
				{ artifactId, artifactLabel: "Full failed-job logs" },
			);
		}

		if (outcome === "success") {
			const signature = getRunCollectionSignature(runs);
			if (signature === settledSuccessSignature) {
				const finalDetails = buildCommitRunWatchDetails(repo, headSha, branch, runs, {
					state: "completed",
				});
				return buildTextResult(
					formatCommitRunWatchResult(repo, headSha, branch, runs, [], tail),
					undefined,
					finalDetails,
				);
			}

			settledSuccessSignature = signature;
			const confirmWaitSeconds = currentIntervalSeconds();
			const note = `All known workflow runs completed successfully. Waiting ${confirmWaitSeconds}s to ensure no additional runs appear for this commit.`;
			onUpdate?.({
				content: [
					{
						type: "text",
						text: formatCommitRunWatchSnapshot(repo, headSha, branch, runs, pollCount, note),
					},
				],
				details: buildCommitRunWatchDetails(repo, headSha, branch, runs, {
					state: "watching",
					pollCount,
					note,
				}),
			});
			await scheduler.wait(confirmWaitSeconds * 1000, { signal });
			continue;
		}

		settledSuccessSignature = undefined;
		if (!everSawRuns && Date.now() - watchStartMs >= RUN_WATCH_NO_RUNS_GIVE_UP_MS) {
			// A repo with no Actions configured (or Actions disabled) never
			// produces a run for this commit; give up with a clear message
			// instead of polling forever.
			const elapsedSec = Math.round((Date.now() - watchStartMs) / 1000);
			return buildTextResult(
				`No workflow runs found for ${repo}@${formatShortSha(headSha) ?? headSha} after ${elapsedSec}s (${pollCount} polls). The commit may not trigger any GitHub Actions workflows, or Actions may be disabled for this repository. Pass \`run\` to watch a specific run.`,
				undefined,
				buildCommitRunWatchDetails(repo, headSha, branch, runs, { state: "completed", pollCount }),
				{ useless: true },
			);
		}
		await scheduler.wait(currentIntervalSeconds() * 1000, { signal });
	}
}
