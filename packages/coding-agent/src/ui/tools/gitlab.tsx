/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * GitLab: the operation as the title (`GitLab MR Discussions`), its subject
 * (MR/issue/pipeline/path/repo/query) after it. Pipeline watch renders stage-
 * grouped jobs and failed job log tails using the shared `github` terminal look.
 */
import { replaceTabs } from "@oh-my-pi/pi-tui/text/width";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import type { TspTone } from "@oh-my-pi/pi-wire";
import type {
	GlPipelineWatchFailedLogDetails,
	GlPipelineWatchJobDetails,
	GlPipelineWatchViewDetails,
	GlToolDetails,
} from "../../tools/details/gitlab";
import { sanitizeDisplayLines, sanitizeDisplayWarning, shortenEmbeddedPaths } from "../../utils/render-utils";
import type { ToolPresenter, ToolView } from "./contract";
import { resultText } from "./default";
import type { GithubState, GithubTerm, GithubTermFailedLog, GithubTermJob, GithubTermRun } from "./github";
import { label, seconds } from "./github";
import { registerToolPresenter } from "./registry";

export interface GitlabArgs {
	readonly op?: string;
	readonly repo?: string;
	readonly group?: string;
	readonly ref?: string;
	readonly path?: string;
	readonly mr?: string | readonly string[];
	readonly issue?: string;
	readonly query?: string;
	readonly pipeline?: string;
	readonly job?: string;
}

const PREVIEW_LINES = 10;

const OP_TITLES: Readonly<Record<string, string>> = {
	repo_view: "Project",
	file_read: "File",
	issue_view: "Issue",
	mr_create: "MR Create",
	mr_update: "MR Update",
	mr_checkout: "MR Checkout",
	mr_push: "MR Push",
	mr_discussions: "MR Discussions",
	mr_note: "MR Note",
	mr_discussion_resolve: "MR Resolve",
	search_mrs: "MR Search",
	search_issues: "Issue Search",
	search_code: "Code Search",
	search_commits: "Commit Search",
	search_projects: "Project Search",
	pipeline_list: "Pipelines",
	pipeline_view: "Pipeline",
	pipeline_watch: "Pipeline Watch",
	job_log: "Job Log",
	job_retry: "Job Retry",
	ci_lint: "CI Lint",
};

const WORD_TITLES: Readonly<Record<string, string>> = { mr: "MR", mrs: "MRs", ci: "CI" };

const SUCCESS_STATUSES = new Set(["success", "skipped", "manual"]);
const FAILURE_STATUSES = new Set(["failed", "canceled"]);
const RUNNING_STATUSES = new Set(["running"]);

const STATE_TONE: Readonly<Record<GithubState, TspTone>> = {
	success: "success",
	running: "warning",
	failure: "error",
	pending: "muted",
};

export function gitlabTitle(op: string | undefined): string {
	const name = op?.trim();
	if (!name) return "GitLab";
	const title =
		OP_TITLES[name] ??
		name
			.split("_")
			.map(word => WORD_TITLES[word] ?? `${word[0]?.toUpperCase() ?? ""}${word.slice(1)}`)
			.join(" ");
	return title ? `GitLab ${title}` : "GitLab";
}

function formatWatchTarget(value: string, prefix: "#" | "!", urlPattern: RegExp): string {
	const trimmed = value.trim();
	const direct = /^[!#]?(\d+)$/.exec(trimmed);
	if (direct) return `${prefix}${direct[1]}`;
	const match = urlPattern.exec(trimmed);
	if (match) return `${prefix}${match[1]}`;
	return trimmed;
}

function callSubject(args: GitlabArgs | undefined): string[] {
	if (args?.op?.trim() === "pipeline_watch") {
		if (args.pipeline) return [formatWatchTarget(args.pipeline, "#", /\/pipelines\/(\d+)/)];
		if (typeof args.mr === "string" && args.mr) {
			return [formatWatchTarget(args.mr, "!", /\/merge_requests\/(\d+)/)];
		}
		return [args.ref || "current branch"];
	}
	const parts: string[] = [];
	if (args?.query) parts.push(args.query);
	if (args?.path) parts.push(args.path);
	if (args?.repo) parts.push(args.repo);
	else if (args?.group) parts.push(args.group);
	return parts;
}

function outputLines(text: string): string[] {
	const lines = replaceTabs(text).split("\n");
	while (lines.length > 0 && lines[0]!.trim() === "") lines.shift();
	while (lines.length > 0 && lines[lines.length - 1]!.trim() === "") lines.pop();
	return lines;
}

function jobStateOf(job: GlPipelineWatchJobDetails): GithubState {
	const status = job.status ?? "";
	if (SUCCESS_STATUSES.has(status)) return "success";
	if (FAILURE_STATUSES.has(status)) return job.allowFailure ? "pending" : "failure";
	if (RUNNING_STATUSES.has(status)) return "running";
	return "pending";
}

function formatFailedLog(log: GlPipelineWatchFailedLogDetails): GithubTermFailedLog {
	const jobName = sanitizeText(log.jobName);
	const context = log.stage ? `${sanitizeText(log.stage)} #${log.jobId}` : `job #${log.jobId}`;
	if (!log.available || !log.tail) {
		const reason = log.unavailableReason ? sanitizeDisplayWarning(log.unavailableReason) : "";
		return { jobName, context, unavailable: `log tail unavailable${reason ? `: ${reason}` : ""}` };
	}
	return { jobName, context, tail: replaceTabs(sanitizeText(log.tail)).split("\n").filter(Boolean) };
}

function watchView(watch: GlPipelineWatchViewDetails, title: string, failed: boolean, rawText: string): ToolView {
	const shortSha = watch.headSha?.slice(0, 12);
	const subject = `${watch.pipelineId !== undefined ? `pipeline #${watch.pipelineId}` : "pipeline"} on ${watch.repo}${shortSha ? ` (${shortSha})` : ""}`;
	const isWatching = watch.state === "watching";

	if (!isWatching && watch.jobs.length === 0 && watch.pipelineId === undefined) {
		const summary = sanitizeDisplayLines(shortenEmbeddedPaths(rawText)).join("\n").trim() || "No pipelines found.";
		return {
			label: label(title, [subject]),
			tone: failed ? "error" : "warning",
			preview: { lines: PREVIEW_LINES },
			body: <text spans={[{ s: failed ? "error" : "muted", t: summary }]} wrap="word" />,
			term: {
				look: "github",
				icon: "tool.gl",
				result: true,
				title,
				subject,
				lines: outputLines(summary),
				...(failed ? { error: summary } : {}),
			} satisfies GithubTerm,
		};
	}

	const termJobs: GithubTermJob[] = watch.jobs.map(job => ({
		id: job.id,
		name: job.allowFailure ? `${sanitizeText(job.name)} (allowed to fail)` : sanitizeText(job.name),
		state: jobStateOf(job),
		duration: seconds(job.durationSeconds),
		steps: [],
	}));

	const termRun: GithubTermRun = {
		id: watch.pipelineId ?? 0,
		name: watch.ref ? `${sanitizeText(watch.ref)} · ${watch.status ?? "unknown"}` : (watch.status ?? "pipeline"),
		jobs: termJobs,
	};

	const failedLogs = (watch.failedLogs ?? []).map(formatFailedLog);
	const note = watch.note ? sanitizeText(watch.note) : undefined;
	const emptyJobsText = isWatching ? "waiting for pipeline jobs..." : "no jobs reported.";

	return {
		label: label(title, [subject]),
		tone: failed ? "error" : undefined,
		body: [
			note ? <text spans={[{ s: "muted", t: note }]} wrap="word" /> : undefined,
			<section head={[{ s: "accent strong", t: termRun.name }]}>
				{termJobs.length === 0 ? (
					<text spans={[{ s: "muted", t: emptyJobsText }]} wrap="word" />
				) : (
					<list>
						{termJobs.map(job => (
							<item
								key={`job:${job.id}`}
								tone={STATE_TONE[job.state]}
								icon={job.state === "success" ? "check" : undefined}
								label={[{ s: STATE_TONE[job.state], t: job.name }]}
								value={job.duration ? [{ s: "muted", t: job.duration }] : undefined}
							/>
						))}
					</list>
				)}
			</section>,
			failedLogs.length > 0 ? (
				<section head={[{ s: "error strong", t: "failed logs" }]} tone="error">
					{failedLogs.map((entry, idx) => (
						<col key={`log:${idx}`}>
							<text
								spans={[
									{ s: "error", t: entry.jobName },
									{ s: "muted", t: `  ${entry.context}` },
								]}
							/>
							{entry.tail ? (
								<ansi text={entry.tail.join("\n")} follow={true} preview={{ lines: 10 }} />
							) : (
								<text spans={[{ s: "muted", t: entry.unavailable ?? "log tail unavailable" }]} wrap="word" />
							)}
						</col>
					))}
				</section>
			) : undefined,
		],
		term: {
			look: "github",
			icon: "tool.gl",
			result: true,
			title,
			subject,
			runs: [termRun],
			...(failedLogs.length > 0 ? { failedLogs } : {}),
			...(failed ? { error: "" } : {}),
		} satisfies GithubTerm,
	};
}

export const gitlabPresenter: ToolPresenter<GitlabArgs, GlToolDetails> = {
	merge: true,
	call(args) {
		const title = gitlabTitle(args?.op);
		const parts = callSubject(args);
		const subject = parts.length > 0 ? parts.join(" · ") : undefined;
		const watch = args?.op?.trim() === "pipeline_watch";
		return {
			label: label(title, parts),
			body: watch ? <text spans={[{ s: "muted", t: "waiting for pipeline data..." }]} wrap="word" /> : undefined,
			term: {
				look: "github",
				icon: "tool.gl",
				waitText: "waiting for pipeline data...",
				title,
				subject,
				watch,
				branch: watch && !args?.pipeline && Boolean(args?.ref),
			} satisfies GithubTerm,
		};
	},
	result(result, _state, args): ToolView {
		const title = gitlabTitle(args?.op);
		const text = resultText(result);
		const watch = result.details?.watch;
		if (watch) return watchView(watch, title, result.isError === true, text);
		const parts = callSubject(args);
		const subject = parts.length > 0 ? parts.join(" · ") : undefined;
		if (result.isError) {
			const sanitizedLines = sanitizeDisplayLines(shortenEmbeddedPaths(text));
			const message = sanitizedLines.join("\n").trim() || "request failed";
			return {
				label: label(title, parts),
				tone: "error",
				preview: { lines: PREVIEW_LINES },
				body: <text role="omp.tool.error" spans={[{ s: "error", t: message }]} wrap="word" />,
				term: {
					look: "github",
					icon: "tool.gl",
					result: true,
					title,
					subject,
					error: message,
					lines: sanitizedLines.length > 0 ? sanitizedLines : undefined,
					empty: sanitizedLines.length > 0 ? undefined : message,
				} satisfies GithubTerm,
			};
		}
		const body = replaceTabs(text.trim());
		if (!body) {
			return {
				label: label(title, parts),
				tone: "warning",
				body: <text spans={[{ s: "muted", t: "no output" }]} wrap="word" />,
				term: {
					look: "github",
					icon: "tool.gl",
					result: true,
					title,
					subject,
					empty: "no output",
				} satisfies GithubTerm,
			};
		}
		return {
			label: label(title, parts),
			preview: { lines: PREVIEW_LINES },
			body: <md text={body} />,
			term: {
				look: "github",
				icon: "tool.gl",
				result: true,
				title,
				subject,
				lines: outputLines(text),
			} satisfies GithubTerm,
		};
	},
};

registerToolPresenter("gitlab", gitlabPresenter);
