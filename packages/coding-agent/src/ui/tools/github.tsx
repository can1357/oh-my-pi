/** @jsxImportSource @oh-my-pi/pi-tui */
/**
 * GitHub: the operation as the title (`GitHub Search Issues`), its subject
 * (repo, query, branch) after it. Results are the CLI's markdown; a run
 * watch shows each workflow run with its jobs (folded to a summary of the
 * current or failed step) and their steps, then the failed jobs' log tails.
 *
 * Terminal look: `github` (`src/ui/styles/tools/github.ts`).
 */
import type { TspSpan, TspTone } from "@oh-my-pi/pi-wire";
import { replaceTabs } from "@oh-my-pi/pi-tui/text/width";
import { sanitizeText } from "@oh-my-pi/pi-utils";
import { sanitizeDisplayWarning } from "../../utils/render-utils";
import type { ToolPresenter, ToolView } from "./contract";
import { resultText } from "./default";
import { registerToolPresenter } from "./registry";

/** GitHub args. */
export interface GithubArgs {
	readonly op?: string;
	readonly repo?: string;
	readonly query?: string;
	readonly pr?: string | readonly string[];
	readonly run?: string;
	readonly branch?: string;
}

/** A workflow step. */
export interface GithubStep {
	readonly number: number;
	readonly name: string;
	readonly status?: string;
	readonly conclusion?: string | null;
	readonly durationSeconds?: number;
}

/** A workflow job. */
export interface GithubJob {
	readonly id: number;
	readonly name: string;
	readonly status?: string;
	readonly conclusion?: string | null;
	readonly durationSeconds?: number;
	readonly steps?: readonly GithubStep[];
}

/** A workflow run. */
export interface GithubRun {
	readonly id: number;
	readonly workflowName?: string;
	readonly status?: string;
	readonly conclusion?: string | null;
	readonly jobs?: readonly GithubJob[];
}

/** A run watch's state. */
export interface GithubWatch {
	readonly mode?: "run" | "commit";
	readonly state?: string;
	readonly repo?: string;
	readonly headSha?: string;
	readonly run?: GithubRun;
	readonly runs?: readonly GithubRun[];
	/** Log tails of failed jobs (or why a tail is missing). */
	readonly failedLogs?: readonly GithubFailedLog[];
}

/** A failed job's captured log tail. */
export interface GithubFailedLog {
	readonly runId: number;
	readonly workflowName?: string;
	readonly jobName: string;
	readonly tail?: string;
	readonly available: boolean;
	readonly unavailableReason?: string;
}

/** A failed job's log as the terminal draws it. */
export interface GithubTermFailedLog {
	readonly jobName: string;
	/** `CI  #77` or `run #77`. */
	readonly context: string;
	/** Non-empty tail lines; undefined when the tail is unavailable. */
	readonly tail?: readonly string[];
	/** Why the tail is missing, one row (`log tail unavailable: …`). */
	readonly unavailable?: string;
}

/** GitHub result details. */
export interface GithubDetails {
	readonly watch?: GithubWatch;
}

/** A step as the terminal draws it. */
export interface GithubTermStep {
	readonly number: number;
	readonly name: string;
	readonly state: GithubState;
	/** `success`, `in progress`, `cancelled`. */
	readonly status: string;
	readonly duration?: string;
}

/** A job as the terminal draws it. */
export interface GithubTermJob {
	readonly id: number;
	readonly name: string;
	readonly state: GithubState;
	readonly duration?: string;
	/** The folded job's one-line summary. */
	readonly summary?: string;
	readonly steps: readonly GithubTermStep[];
}

/** A run as the terminal draws it. */
export interface GithubTermRun {
	readonly id: number;
	readonly name: string;
	readonly jobs: readonly GithubTermJob[];
}

/** How a run, job or step stands. */
export type GithubState = "success" | "running" | "failure" | "pending";

/** Terminal facts of the `github` look. */
export type GithubTerm = {
	readonly look: "github";
	readonly result?: boolean;
	readonly title: string;
	/** The call's subject (repo, query, `#77`). */
	readonly subject?: string;
	/** A run watch call: the subject follows after two spaces. */
	readonly watch?: boolean;
	/** The watched subject is a branch name (drawn plain, not muted). */
	readonly branch?: boolean;
	/** Output lines. */
	readonly lines?: readonly string[];
	/** The output was empty (`no output`). */
	readonly empty?: string;
	readonly runs?: readonly GithubTermRun[];
	/** Failed jobs' log tails, in a `failed logs` section under the runs. */
	readonly failedLogs?: readonly GithubTermFailedLog[];
	readonly error?: string;
};

/** Body rows shown while collapsed. */
const PREVIEW_LINES = 10;

const OP_TITLES: Readonly<Record<string, string>> = {
	pr_view: "",
	repo_view: "Repo",
	issue_view: "Issue",
	pr_push: "PR Push",
	pr_diff: "PR Diff",
	pr_checkout: "PR Checkout",
	run_watch: "Run Watch",
};

const WORD_TITLES: Readonly<Record<string, string>> = { pr: "PR", prs: "PRs", ci: "CI" };

const STATE_TONE: Readonly<Record<GithubState, TspTone>> = {
	success: "success",
	running: "warning",
	failure: "error",
	pending: "muted",
};

/** `GitHub`, `GitHub Search Issues`. */
export function githubTitle(op: string | undefined): string {
	const name = op?.trim();
	if (!name) return "GitHub";
	const title =
		OP_TITLES[name] ??
		name
			.split("_")
			.map(word => WORD_TITLES[word] ?? `${word[0]?.toUpperCase() ?? ""}${word.slice(1)}`)
			.join(" ");
	return title ? `GitHub ${title}` : "GitHub";
}

/** What a call is about: a watch's run/branch, else its query and repo. */
function callSubject(args: GithubArgs | undefined): string[] {
	if (args?.op?.trim() === "run_watch") {
		if (args.run) return [`#${args.run}`];
		return [args.branch || "current HEAD"];
	}
	const parts: string[] = [];
	if (args?.query) parts.push(args.query);
	if (args?.repo) parts.push(args.repo);
	return parts;
}

function label(title: string, subject: readonly string[] = []): TspSpan[] {
	const spans: TspSpan[] = [{ s: "toolTitle strong", t: title }];
	for (const part of subject) spans.push({ t: " " }, { s: "muted", t: part });
	return spans;
}

/** Output lines without leading and trailing blank ones. */
function outputLines(text: string): string[] {
	const lines = text.split("\n");
	while (lines.length > 0 && lines[0]!.trim() === "") lines.shift();
	while (lines.length > 0 && lines[lines.length - 1]!.trim() === "") lines.pop();
	return lines;
}

function stateOf(status: string | undefined, conclusion: string | null | undefined): GithubState {
	if (status === "in_progress") return "running";
	if (status !== "completed") return "pending";
	return conclusion === "success" || conclusion === "skipped" || conclusion === "neutral" ? "success" : "failure";
}

function statusText(status: string | undefined, conclusion: string | null | undefined): string {
	if (status === "completed") return (conclusion ?? "completed").replace(/_/g, " ");
	return (status ?? "queued").replace(/_/g, " ");
}

function seconds(value: number | undefined): string | undefined {
	if (value === undefined) return undefined;
	if (value < 60) return `${Math.round(value)}s`;
	return `${Math.floor(value / 60)}m${Math.round(value % 60)}s`;
}

function termJob(job: GithubJob): GithubTermJob {
	const steps = (job.steps ?? []).map(step => ({
		number: step.number,
		name: replaceTabs(step.name),
		state: stateOf(step.status, step.conclusion),
		status: statusText(step.status, step.conclusion),
		duration: seconds(step.durationSeconds),
	}));
	const state = stateOf(job.status, job.conclusion);
	let summary: string | undefined;
	const running = steps.findIndex(step => step.state === "running");
	const failed = steps.findIndex(step => step.state === "failure");
	if (running >= 0) {
		const step = steps[running]!;
		summary = `${running + 1}/${steps.length} #${step.number} ${step.name} · ${step.status}`;
	} else if (failed >= 0) {
		const step = steps[failed]!;
		summary = `#${step.number} ${step.name} · ${step.status} · ${failed + 1}/${steps.length}`;
	}
	return {
		id: job.id,
		name: replaceTabs(job.name),
		state,
		duration: seconds(job.durationSeconds),
		summary,
		steps,
	};
}

function RunSection(props: { readonly run: GithubTermRun; readonly expanded: boolean }) {
	const { run } = props;
	return (
		<section
			key={`run:${run.id}`}
			head={[{ s: "accent", t: run.name }, { t: "  " }, { s: "muted", t: `#${run.id}` }]}
		>
			<col key="jobs">
				{run.jobs.map(job => {
					const tone = STATE_TONE[job.state];
					const head: TspSpan[] = [{ s: tone, t: job.name }];
					if (job.summary) head.push({ t: "  " }, { s: tone, t: job.summary });
					if (job.duration) head.push({ s: tone, t: `  ${job.duration}` });
					const id = job.id;
					return (
						<section key={`job:${id}`} head={head} collapsible collapsed={!props.expanded}>
							<list key={`steps:${id}`}>
								{job.steps.map(step => {
									const stepTone = STATE_TONE[step.state];
									const value: TspSpan[] = [{ s: stepTone, t: step.status }];
									if (step.duration) value.push({ t: " " }, { s: "muted", t: step.duration });
									return (
										<item
											key={`step:${step.number}`}
											label={[
												{ s: "muted", t: `#${step.number} ` },
												{ s: stepTone, t: step.name },
											]}
											tone={stepTone}
											value={value}
										/>
									);
								})}
							</list>
						</section>
					);
				})}
			</col>
		</section>
	);
}

function termFailedLog(entry: GithubFailedLog): GithubTermFailedLog {
	const context = entry.workflowName
		? `${replaceTabs(sanitizeText(entry.workflowName))}  #${entry.runId}`
		: `run #${entry.runId}`;
	const jobName = replaceTabs(sanitizeText(entry.jobName));
	if (!entry.available || !entry.tail) {
		const reason = entry.unavailableReason ? sanitizeDisplayWarning(entry.unavailableReason) : "";
		return { jobName, context, unavailable: `log tail unavailable${reason ? `: ${reason}` : ""}` };
	}
	const tail = replaceTabs(sanitizeText(entry.tail))
		.split("\n")
		.filter(line => line.length > 0);
	return { jobName, context, tail };
}

function FailedLogs(props: { readonly logs: readonly GithubTermFailedLog[] }) {
	return (
		<section key="failed" head={[{ s: "error", t: "failed logs" }]} tone="error">
			{props.logs.flatMap((log, index) => [
				<text
					key={`failed:${index}`}
					spans={[
						{ s: "error", t: log.jobName },
						{ s: "muted", t: `  ${log.context}` },
					]}
					wrap="none"
				/>,
				log.tail ? (
					<code key={`tail:${index}`} text={log.tail.join("\n")} lang="text" />
				) : (
					<text key={`note:${index}`} spans={[{ s: "dim", t: log.unavailable ?? "" }]} wrap="none" />
				),
			])}
		</section>
	);
}

function watchView(watch: GithubWatch, title: string, expanded: boolean, failed: boolean): ToolView {
	const runs = watch.mode === "commit" ? (watch.runs ?? []) : watch.run ? [watch.run] : [];
	const subject =
		watch.mode === "commit"
			? `watching ${(watch.headSha ?? "").slice(0, 12)} on ${watch.repo ?? ""}`
			: `watching run #${watch.run?.id ?? "?"} on ${watch.repo ?? ""}`;
	const termRuns = runs.map(run => ({
		id: run.id,
		name: replaceTabs(run.workflowName ?? `Run ${run.id}`),
		jobs: (run.jobs ?? []).map(termJob),
	}));
	const failedLogs = (watch.failedLogs ?? []).map(termFailedLog);
	return {
		label: label(title, [subject]),
		...(failed ? { tone: "error" as const } : {}),
		body: [
			...termRuns.map(run => <RunSection run={run} expanded={expanded} />),
			failedLogs.length > 0 ? <FailedLogs logs={failedLogs} /> : undefined,
		],
		term: {
			look: "github",
			result: true,
			title,
			subject,
			runs: termRuns,
			...(failedLogs.length > 0 ? { failedLogs } : {}),
			...(failed ? { error: "" } : {}),
		} satisfies GithubTerm,
	};
}

export const githubPresenter: ToolPresenter<GithubArgs, GithubDetails> = {
	merge: true,
	call(args) {
		const title = githubTitle(args?.op);
		const parts = callSubject(args);
		const subject = parts.length > 0 ? parts.join(" · ") : undefined;
		const watch = args?.op?.trim() === "run_watch";
		return {
			label: label(title, parts),
			body: watch ? <text spans={[{ s: "muted", t: "waiting for workflow data..." }]} wrap="word" /> : undefined,
			term: {
				look: "github",
				title,
				subject,
				watch,
				branch: watch && !args?.run && Boolean(args?.branch),
			} satisfies GithubTerm,
		};
	},
	result(result, state, args): ToolView {
		const title = githubTitle(args?.op);
		const watch = result.details?.watch;
		if (watch) return watchView(watch, title, state.expanded, result.isError === true);
		const text = resultText(result);
		const parts = callSubject(args);
		const subject = parts.length > 0 ? parts.join(" · ") : undefined;
		if (result.isError) {
			const message = text.trim() || "request failed";
			return {
				label: label(title, parts),
				tone: "error",
				body: <text role="omp.tool.error" spans={[{ s: "error", t: message }]} wrap="word" />,
				term: {
					look: "github",
					result: true,
					title,
					subject,
					error: message,
					lines: text.trim() ? outputLines(text) : undefined,
					empty: text.trim() ? undefined : message,
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
				result: true,
				title,
				subject,
				lines: outputLines(text),
			} satisfies GithubTerm,
		};
	},
};

registerToolPresenter("github", githubPresenter);
