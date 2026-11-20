/**
 * Process watch: while a session's background jobs run, the `judge` role is
 * asked now and then whether each one still does what it should, and the jobs
 * that look stalled, failing, or up and waited on as if they would exit are
 * told to the agent, so a user need not ask "are you stuck?".
 *
 * When. Each running job is due for a look at the ages in
 * `async.processWatch.schedule` (30 s, 1, 2, 4, 8 and 16 minutes by default),
 * then every `async.processWatch.everySeconds` (30 minutes): hangs show early,
 * and a job that has run fine for hours is not asked about every minute. When
 * any job is due, one judgment covers every job running, over the session's
 * recent conversation. Nothing running, no ask. A ten-hour job costs about 25
 * asks.
 *
 * What. One choice per job. Jobs whose P(stalled) + P(failing) + P(ready)
 * reach `async.processWatch.threshold` are handed to the host as one notice,
 * which the session delivers at the agent's next turn (or, between runs, the
 * way it delivers a finished job). There is no counter: a job that stays stuck
 * is told again at its next look, each further apart. Nothing here stops a job,
 * and a judge that is unavailable, times out or errors changes nothing.
 *
 * Ported from nace-ai/intern's `process_watch.py` (Apache-2.0).
 */
import { type ChoiceAnswer, type Judge, type JsonValue, judgeQuestions, renderQuestion } from "@oh-my-pi/pi-ai";
import { formatDuration, logger, prompt, truncate, untilAborted } from "@oh-my-pi/pi-utils";
import type { Settings } from "../config/settings";
import questionFile from "../prompts/judge/process-watch.json" with { type: "json" };
import noticeTemplate from "../prompts/system/process-watch-notice.md" with { type: "text" };
import { escapeHarnessTags } from "../session/harness-tags";
import type { CustomMessage } from "../session/messages";
import type { YieldQueue } from "../session/yield-queue";
import {
	cfgAsyncProcessWatchEnabled,
	cfgAsyncProcessWatchEverySeconds,
	cfgAsyncProcessWatchSchedule,
	cfgAsyncProcessWatchThreshold,
} from "../tools/settings";
import { type HostPressure, hostStrain, summarizeHostPressure } from "./host-pressure";
import type { AsyncJob } from "./job-manager";

/** `customType` of the injected process-watch notice. */
export const PROCESS_WATCH_MESSAGE_TYPE = "process-watch";

const QUESTIONS = judgeQuestions(questionFile);

/** One label the judge can give a running job. */
export type ProcessVerdict = keyof (typeof questionFile)["check"]["criteria"];

/** Verdicts the agent is told about. */
const FLAGGED = ["stalled", "failing", "ready"] as const satisfies readonly ProcessVerdict[];
type FlaggedVerdict = (typeof FLAGGED)[number];

/**
 * A look due within this share of a job's age counts as come at a check, so
 * two jobs that started moments apart share one judgment rather than two.
 */
const DUE_SLACK = 0.1;

/**
 * Deadline for one whole look, whatever the judge chain does inside it: a hung
 * provider must not hold the watch, since no later look is armed until this one
 * settles. A look that runs out is aborted and the next comes on schedule.
 */
const LOOK_TIMEOUT_MS = 30_000;

/** Trailing output lines shown to the judge and in the notice. */
const LAST_OUTPUT_LINES = 3;
/** Characters kept of each of those lines. */
const LAST_OUTPUT_LINE_CHARS = 200;
/** Characters of a command shown to the judge and in the notice. */
const COMMAND_CHARS = 400;

/** One job the judge flagged, as the notice tells it. */
export interface ProcessWatchFlag {
	jobId: string;
	command: string;
	ageMs: number;
	quietMs?: number;
	lastOutput?: string;
	verdict: FlaggedVerdict;
}

/** What one look tells the agent. */
export interface ProcessWatchNotice {
	jobs: ProcessWatchFlag[];
	/** Host strain the look's snapshot showed (see {@link hostStrain}), when a flagged job looks stalled. */
	hostStrain?: string[];
}

/** The judge's answer for one job at one look; every look logs them all. */
export interface ProcessWatchVerdictRecord {
	jobId: string;
	command: string;
	ageMs: number;
	verdict: string;
	/** P(stalled) + P(failing) + P(ready). */
	flagProbability: number;
	flagged: boolean;
}

export interface ProcessWatchHost {
	settings: Settings;
	/** The session's running background jobs. */
	runningJobs(): AsyncJob[];
	/** The judge for one look; resolved per look so role and credential changes apply. */
	judge(): Judge;
	/** The session's recent conversation, shown to the judge beside the jobs. */
	recent(): JsonValue;
	/** Host resource snapshot shown to the judge as `host`; omitted or `undefined` leaves it out. */
	hostPressure?(): Promise<HostPressure | undefined>;
	/**
	 * Hands the agent-facing notice of one completed look, with no jobs when
	 * nothing was flagged, so a newer verdict always replaces an older one.
	 * A look that failed or timed out calls nothing.
	 */
	notify(notice: ProcessWatchNotice): void;
}

interface ShownJob {
	job: AsyncJob;
	command: string;
	ageMs: number;
	quietMs?: number;
	lastOutput?: string;
}

/** Watches one session's background jobs; `poke` it whenever a job may have started. */
export class ProcessWatch {
	readonly #host: ProcessWatchHost;
	/** How many looks each running job has had, by job id. */
	readonly #looks = new Map<string, number>();
	#timer: NodeJS.Timeout | undefined;
	#inFlight: AbortController | undefined;
	#disposed = false;

	constructor(host: ProcessWatchHost) {
		this.#host = host;
	}

	/** Watch the jobs running now: (re)arm the timer for the next look due. */
	poke(): void {
		if (this.#disposed || this.#inFlight) return;
		this.#arm();
	}

	/** Stop watching; an in-flight judgment is aborted and its answer ignored. */
	dispose(): void {
		this.#disposed = true;
		clearTimeout(this.#timer);
		this.#timer = undefined;
		this.#inFlight?.abort();
		this.#inFlight = undefined;
		this.#looks.clear();
	}

	#arm(): void {
		clearTimeout(this.#timer);
		this.#timer = undefined;
		if (this.#disposed || !cfgAsyncProcessWatchEnabled.get(this.#host.settings)) return;
		const jobs = this.#running();
		if (jobs.length === 0) return;
		const now = Date.now();
		let wait = Number.POSITIVE_INFINITY;
		for (const job of jobs) wait = Math.min(wait, this.#dueMs(job.id) - (now - job.startTime));
		this.#timer = setTimeout(() => void this.#look(), Math.max(0, wait));
		this.#timer.unref?.();
	}

	/** Running jobs, forgetting the looks of jobs that are gone. */
	#running(): AsyncJob[] {
		const jobs = this.#host.runningJobs().filter(job => job.status === "running");
		const ids = new Set(jobs.map(job => job.id));
		for (const id of this.#looks.keys()) if (!ids.has(id)) this.#looks.delete(id);
		return jobs;
	}

	/** Age, in ms, at which a job's next look is due. */
	#dueMs(jobId: string): number {
		const schedule = cfgAsyncProcessWatchSchedule.get(this.#host.settings);
		const every = cfgAsyncProcessWatchEverySeconds.get(this.#host.settings);
		const n = this.#looks.get(jobId) ?? 0;
		const last = schedule[schedule.length - 1] ?? 0;
		const seconds = n < schedule.length ? schedule[n]! : last + every * (n - schedule.length + 1);
		return seconds * 1000;
	}

	/** Count a look for every job whose next look is due, or nearly. */
	#advance(jobs: readonly AsyncJob[]): void {
		const now = Date.now();
		for (const job of jobs) {
			while (this.#dueMs(job.id) * (1 - DUE_SLACK) <= now - job.startTime) {
				this.#looks.set(job.id, (this.#looks.get(job.id) ?? 0) + 1);
			}
		}
	}

	async #look(): Promise<void> {
		this.#timer = undefined;
		if (this.#disposed || !cfgAsyncProcessWatchEnabled.get(this.#host.settings)) return;
		const jobs = this.#running();
		if (jobs.length === 0) return;
		const controller = new AbortController();
		this.#inFlight = controller;
		const deadline = setTimeout(
			() => controller.abort(new Error(`judge gave no answer within ${LOOK_TIMEOUT_MS / 1000}s`)),
			LOOK_TIMEOUT_MS,
		);
		deadline.unref?.();
		try {
			await this.#check(jobs, controller.signal);
		} catch (error) {
			if (!this.#disposed) {
				const cause = controller.signal.aborted ? controller.signal.reason : error;
				logger.debug("process-watch: look failed", {
					error: cause instanceof Error ? cause.message : String(cause),
				});
			}
		} finally {
			clearTimeout(deadline);
			if (this.#inFlight === controller) this.#inFlight = undefined;
			if (!this.#disposed) {
				// Count the look only for the jobs it judged: a job that started while
				// it was in flight keeps its own schedule.
				const running = new Set(this.#running().map(job => job.id));
				this.#advance(jobs.filter(job => running.has(job.id)));
				this.#arm();
			}
		}
	}

	async #check(jobs: readonly AsyncJob[], signal: AbortSignal): Promise<void> {
		const now = Date.now();
		const shown = jobs.map(job => describe(job, now));
		const questions: Record<string, (typeof QUESTIONS)["check"]> = {};
		for (const [i, entry] of shown.entries()) {
			questions[`p${i}`] = renderQuestion(QUESTIONS.check, {
				id: entry.job.id,
				command: entry.command,
				age: formatDuration(entry.ageMs),
				quiet: entry.quietMs === undefined ? undefined : formatDuration(entry.quietMs),
			});
		}
		// Read inside the look's deadline; a failed read only leaves `host` out.
		const pressure = this.#host.hostPressure
			? await untilAborted(signal, this.#host.hostPressure()).catch(() => undefined)
			: undefined;
		if (signal.aborted) return;
		const state = {
			recent: this.#host.recent(),
			...(pressure ? { host: summarizeHostPressure(pressure) } : {}),
			processes: shown.map(entry => ({
				id: entry.job.id,
				command: entry.command,
				...(entry.job.intent ? { intent: entry.job.intent } : {}),
				running_for: formatDuration(entry.ageMs),
				...(entry.quietMs === undefined ? {} : { quiet_for: formatDuration(entry.quietMs) }),
				...(entry.lastOutput ? { last_output: entry.lastOutput } : {}),
			})),
		};
		const judge = this.#host.judge();
		// Raced against the look's signal: a judge that ignores its abort signal still releases the watch.
		const { answers } = await untilAborted(signal, judge.judge({ state, questions }, { signal }));
		if (signal.aborted || this.#disposed) return;

		const threshold = cfgAsyncProcessWatchThreshold.get(this.#host.settings);
		const verdicts: ProcessWatchVerdictRecord[] = [];
		const flagged: ProcessWatchFlag[] = [];
		for (const [i, entry] of shown.entries()) {
			const answer = answers[`p${i}`];
			if (answer?.type !== "choice") continue;
			const flagProbability = flagShare(answer);
			const isFlagged = flagProbability >= threshold;
			verdicts.push({
				jobId: entry.job.id,
				command: entry.command,
				ageMs: entry.ageMs,
				verdict: answer.choice,
				flagProbability,
				flagged: isFlagged,
			});
			if (isFlagged) {
				flagged.push({
					jobId: entry.job.id,
					command: entry.command,
					ageMs: entry.ageMs,
					...(entry.quietMs === undefined ? {} : { quietMs: entry.quietMs }),
					...(entry.lastOutput ? { lastOutput: entry.lastOutput } : {}),
					verdict: worst(answer),
				});
			}
		}
		logger.info("process-watch: look", { judge: judge.label, threshold, verdicts });
		const strain = pressure && flagged.some(flag => flag.verdict === "stalled") ? hostStrain(pressure) : [];
		this.#host.notify(strain.length > 0 ? { jobs: flagged, hostStrain: strain } : { jobs: flagged });
	}
}

function describe(job: AsyncJob, now: number): ShownJob {
	const command = truncate((job.process?.command ?? job.label).trim().replace(/\s*\r?\n\s*/g, " "), COMMAND_CHARS);
	const lastOutput = lastLines(job.progressText);
	return {
		job,
		command,
		ageMs: Math.max(0, now - job.startTime),
		...(job.lastProgressAt === undefined ? {} : { quietMs: Math.max(0, now - job.lastProgressAt) }),
		...(lastOutput ? { lastOutput } : {}),
	};
}

/** The last non-blank lines of a job's output tail, each clipped. */
function lastLines(text: string | undefined): string | undefined {
	if (!text) return undefined;
	const lines = text
		.split(/\r?\n/)
		.map(line => line.trimEnd())
		.filter(line => line.trim().length > 0);
	if (lines.length === 0) return undefined;
	return lines
		.slice(-LAST_OUTPUT_LINES)
		.map(line => truncate(line, LAST_OUTPUT_LINE_CHARS))
		.join("\n");
}

/** P(stalled) + P(failing) + P(ready). */
function flagShare(answer: ChoiceAnswer): number {
	let share = 0;
	for (const verdict of FLAGGED) share += answer.probabilities[verdict] ?? 0;
	return share;
}

/** Which of stalled, failing and ready the judge put most on. */
function worst(answer: ChoiceAnswer): FlaggedVerdict {
	let best: FlaggedVerdict = FLAGGED[0];
	for (const verdict of FLAGGED) {
		if ((answer.probabilities[verdict] ?? 0) > (answer.probabilities[best] ?? 0)) best = verdict;
	}
	return best;
}

/**
 * Registers process-watch notices on a session's yield queue and returns the
 * {@link ProcessWatchHost.notify} that queues one. The queue injects a notice
 * at the agent's next turn boundary, or between runs starts a turn the way a
 * finished job's result does. Every completed look replaces the notice not yet
 * delivered: a look that flags nothing withdraws it, so a verdict the latest
 * look ruled out never reaches the agent. A notice names only the jobs
 * `isRunning` still reports running when it is injected; once every flagged
 * job ended it is dropped.
 */
export function registerProcessWatchDelivery(
	queue: YieldQueue,
	isRunning: (jobId: string) => boolean,
): (notice: ProcessWatchNotice) => void {
	queue.register<ProcessWatchNotice>(PROCESS_WATCH_MESSAGE_TYPE, {
		isStale: notice => !notice.jobs.some(job => isRunning(job.jobId)),
		build: notices => {
			const latest = notices[notices.length - 1];
			return latest
				? buildMessage(
						latest.jobs.filter(job => isRunning(job.jobId)),
						latest.hostStrain,
					)
				: null;
		},
	});
	return notice => {
		queue.clear(PROCESS_WATCH_MESSAGE_TYPE);
		if (notice.jobs.length > 0) queue.enqueue(PROCESS_WATCH_MESSAGE_TYPE, notice);
	};
}

function buildMessage(
	jobs: ProcessWatchFlag[],
	strain: string[] | undefined,
): CustomMessage<ProcessWatchNotice> | null {
	if (jobs.length === 0) return null;
	const content = prompt.render(noticeTemplate, {
		hostStrain: strain && strain.length > 0 ? strain.join(", ") : undefined,
		jobs: jobs.map(job => ({
			jobId: job.jobId,
			command: escapeHarnessTags(job.command),
			age: formatDuration(job.ageMs),
			quiet: job.quietMs === undefined ? undefined : formatDuration(job.quietMs),
			lastOutput:
				job.lastOutput === undefined ? undefined : escapeHarnessTags(job.lastOutput).replace(/\n/g, "\n  "),
			[job.verdict]: true,
		})),
	});
	return {
		role: "custom",
		customType: PROCESS_WATCH_MESSAGE_TYPE,
		content,
		display: true,
		attribution: "agent",
		details: strain && strain.length > 0 ? { jobs, hostStrain: strain } : { jobs },
		timestamp: Date.now(),
	};
}
