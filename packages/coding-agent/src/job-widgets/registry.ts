/**
 * The widgets of one root session's jobs: derives each shown job's view from
 * its live output, asks the cheap model for a spec once the job has output
 * worth describing, and pushes refreshed views to subscribers while jobs run.
 */
import type { JobWidgetView } from "@oh-my-pi/pi-tui/tools/job-widget";
import { logger } from "@oh-my-pi/pi-utils";
import type { AsyncJob } from "../async/job-manager";
import type { JobWidgetAuthor, JobWidgetAuthorRequest } from "./author";
import { JobWidgetRuntime, sampleLines } from "./runtime";
import { type JobWidgetSpec, jobWidgetSkip, validateJobWidgetSpec } from "./spec";
import type { JobWidgetBrief, JobWidgetRegistry } from "./types";

/** Tunables; the defaults are the product behavior, tests shrink the clocks. */
export interface JobWidgetsOptions {
	/** Writes specs; absent = fallback views only. */
	author?: JobWidgetAuthor;
	/** Whether widgets are on (`async.widgets`); read on every call. */
	enabled?: () => boolean;
	now?: () => number;
	/** Background refresh period while subscribers watch running widgets. */
	refreshMs?: number;
	/** Minimum time between two reads of one job's sources. */
	minIngestMs?: number;
	/** Job age before a spec may be requested. */
	authorAfterMs?: number;
	/** Spec requests in flight at once, across jobs. */
	maxInFlight?: number;
	/** Spec requests (each with its one retry) per job. */
	maxAttempts?: number;
	/** Unmatched lines on the rules' sources that suggest the spec stopped fitting. */
	driftLines?: number;
	/** Age of the newest matched data past which drift re-authors. */
	driftStaleMs?: number;
}

const DEFAULTS = {
	refreshMs: 1000,
	minIngestMs: 250,
	authorAfterMs: 15_000,
	maxInFlight: 2,
	maxAttempts: 3,
	driftLines: 200,
	driftStaleMs: 90_000,
} as const;

/** Lines a source needs before its output is worth a spec. */
const MIN_AUTHOR_LINES = 3;

interface WidgetEntry {
	job: AsyncJob;
	runtime: JobWidgetRuntime;
	view: JobWidgetView;
	/** `JSON.stringify(view)`, to tell a changed view from a recomputed identical one. */
	viewKey: string;
	lastIngestAt: number;
	shown: boolean;
	/** Settled and flushed: the view never changes again. */
	frozen: boolean;
	attempts: number;
	/** No model can write specs: stop asking. */
	authorUnavailable: boolean;
	request?: AbortController;
	/** Whether the installed spec was written knowing the task's `watch` hint. */
	specHadWatch: boolean;
	/**
	 * Set once the author declined (`skip`): the task's `watch` hint at the
	 * time, `""` without one. A command's job is never asked again; a task's
	 * is asked again once its subagent names something else to watch.
	 */
	skippedWatch?: string;
	/** A spec dropped for no longer fitting the output, sent back as rejected with the next request. */
	misfit?: { answer: string; errors: string[] };
}

/** {@link JobWidgetRegistry} for one root `AsyncJobManager`. */
export class JobWidgets implements JobWidgetRegistry {
	readonly #entries = new Map<string, WidgetEntry>();
	readonly #listeners = new Set<() => void>();
	readonly #author: JobWidgetAuthor | undefined;
	readonly #enabled: () => boolean;
	readonly #now: () => number;
	readonly #options: Required<Omit<JobWidgetsOptions, "author" | "enabled" | "now">>;
	#inFlight = 0;
	#timer: NodeJS.Timeout | undefined;
	#disposed = false;

	constructor(options: JobWidgetsOptions = {}) {
		this.#author = options.author;
		this.#enabled = options.enabled ?? (() => true);
		this.#now = options.now ?? Date.now;
		this.#options = {
			refreshMs: options.refreshMs ?? DEFAULTS.refreshMs,
			minIngestMs: options.minIngestMs ?? DEFAULTS.minIngestMs,
			authorAfterMs: options.authorAfterMs ?? DEFAULTS.authorAfterMs,
			maxInFlight: options.maxInFlight ?? DEFAULTS.maxInFlight,
			maxAttempts: options.maxAttempts ?? DEFAULTS.maxAttempts,
			driftLines: options.driftLines ?? DEFAULTS.driftLines,
			driftStaleMs: options.driftStaleMs ?? DEFAULTS.driftStaleMs,
		};
	}

	view(job: AsyncJob): JobWidgetView | undefined {
		if (this.#disposed || !job.widgetInputs) return undefined;
		if (!this.#enabled()) {
			this.#entries.get(job.id)?.request?.abort();
			this.#syncTimer();
			return undefined;
		}
		let entry = this.#entries.get(job.id);
		if (!entry || entry.job !== job) {
			entry?.request?.abort();
			const runtime = new JobWidgetRuntime(undefined, job.startTime, this.#now);
			entry = {
				job,
				runtime,
				view: runtime.view({ label: job.label, authoring: false }),
				viewKey: "",
				lastIngestAt: Number.NEGATIVE_INFINITY,
				shown: false,
				frozen: false,
				attempts: 0,
				authorUnavailable: false,
				specHadWatch: false,
			};
			this.#entries.set(job.id, entry);
		}
		entry.shown = true;
		this.#refresh(entry, false);
		this.#syncTimer();
		return entry.view;
	}

	subscribe(listener: () => void): () => void {
		this.#listeners.add(listener);
		this.#syncTimer();
		return () => {
			this.#listeners.delete(listener);
			this.#syncTimer();
		};
	}

	forget(jobId: string): void {
		const entry = this.#entries.get(jobId);
		if (!entry) return;
		entry.request?.abort();
		this.#entries.delete(jobId);
		this.#syncTimer();
	}

	dispose(): void {
		this.#disposed = true;
		for (const entry of this.#entries.values()) entry.request?.abort();
		this.#entries.clear();
		this.#listeners.clear();
		this.#syncTimer();
	}

	/**
	 * Read new output and recompute the view, at most every `minIngestMs`
	 * unless `force`; a settled job gets one final flushing read and freezes.
	 * Returns whether the view changed.
	 */
	#refresh(entry: WidgetEntry, force: boolean): boolean {
		if (entry.frozen) return false;
		const now = this.#now();
		const settled = entry.job.status !== "running";
		if (!settled && !force && now - entry.lastIngestAt < this.#options.minIngestMs) return false;
		entry.lastIngestAt = now;
		const inputs = entry.job.widgetInputs;
		if (!inputs) return false;
		let brief: JobWidgetBrief;
		try {
			if (entry.runtime.ingest(inputs.sources(), settled)) this.#dropMisfit(entry);
			brief = inputs.brief();
		} catch (error) {
			logger.warn("Job widget refresh failed", { jobId: entry.job.id, error: String(error) });
			return false;
		}
		if (settled) {
			entry.frozen = true;
			entry.request?.abort();
		} else {
			this.#maybeAuthor(entry, brief, now);
		}
		return this.#recompute(entry, brief);
	}

	#recompute(entry: WidgetEntry, brief: JobWidgetBrief): boolean {
		const view = entry.runtime.view({
			label: entry.job.label,
			stage: brief.stage,
			// A subagent's tool results are file contents and search hits; only a command's newest line says what it does.
			lineStage: brief.kind === "bash",
			authoring: entry.request !== undefined,
		});
		const key = JSON.stringify(view);
		if (key === entry.viewKey) return false;
		entry.view = view;
		entry.viewKey = key;
		return true;
	}

	/**
	 * Start a spec request when the job is old and talkative enough, or
	 * re-author a spec that stopped fitting. A subagent's job waits for its
	 * `watch` hint: most subagents read and edit code, and only the subagent
	 * knows whether some output of its work shows progress.
	 */
	#maybeAuthor(entry: WidgetEntry, brief: JobWidgetBrief, now: number): void {
		if (!this.#enabled() || !this.#author || entry.request || entry.authorUnavailable || !entry.shown) return;
		if (entry.attempts >= this.#options.maxAttempts || this.#inFlight >= this.#options.maxInFlight) return;
		if (now - entry.job.startTime < this.#options.authorAfterMs) return;
		if (brief.kind === "task" && !brief.watch) return;
		const skipped = entry.skippedWatch;
		if (skipped !== undefined && (brief.kind !== "task" || skipped === brief.watch)) return;
		const runtime = entry.runtime;
		let previous: JobWidgetAuthorRequest["previous"];
		if (runtime.spec) {
			const reason = this.#reauthorReason(entry, brief, now);
			if (!reason) return;
			previous = { spec: runtime.spec, reason };
		} else if (brief.kind === "bash" && !runtime.samples().some(sample => sample.lines >= MIN_AUTHOR_LINES)) {
			return;
		}
		void this.#writeSpec(entry, brief, previous);
	}

	#reauthorReason(entry: WidgetEntry, brief: JobWidgetBrief, now: number): string | undefined {
		if (brief.watch && !entry.specHadWatch) return `the subagent now says what to watch: ${brief.watch}`;
		const runtime = entry.runtime;
		if (runtime.unmatchedLines < this.#options.driftLines) return undefined;
		const newest = runtime.lastMatchAt;
		if (newest !== undefined && now - newest <= this.#options.driftStaleMs) return undefined;
		return `no rule matched the last ${runtime.unmatchedLines} lines`;
	}

	/** One spec request (plus one retry on a rejected answer); installs the spec when it validates. */
	async #writeSpec(
		entry: WidgetEntry,
		brief: JobWidgetBrief,
		previous: JobWidgetAuthorRequest["previous"],
	): Promise<void> {
		const author = this.#author;
		if (!author) return;
		const controller = new AbortController();
		entry.request = controller;
		entry.attempts += 1;
		this.#inFlight += 1;
		if (this.#recompute(entry, brief)) this.#notify();
		const samples = entry.runtime.samples();
		const request: JobWidgetAuthorRequest = {
			jobId: entry.job.id,
			brief,
			sources: samples,
			previous,
			...(entry.misfit ? { rejected: entry.misfit } : {}),
		};
		entry.misfit = undefined;
		// Where a spec's constant totals and targets may come from, besides the samples.
		const stated = [brief.command, brief.task, brief.intent, brief.watch, brief.stage].filter(Boolean).join("\n");
		let installable: JobWidgetRuntime | undefined;
		try {
			for (let round = 0; round < 2 && !installable; round++) {
				const answer = await author(request, controller.signal);
				if (controller.signal.aborted || !this.#enabled()) return;
				if (answer === undefined) {
					entry.authorUnavailable = true;
					break;
				}
				const skip = jobWidgetSkip(answer);
				if (skip !== undefined) {
					logger.debug("Job widget declined", { jobId: entry.job.id, reason: skip });
					entry.skippedWatch = brief.watch ?? "";
					break;
				}
				const checked = validateJobWidgetSpec(answer, sampleLines(samples), stated);
				let errors: string[];
				if (checked.ok) {
					// The samples are a few lines; what else a loose rule matches shows only on the whole output.
					const candidate = this.#build(entry.job, checked.spec);
					errors = candidate.problems();
					if (errors.length === 0) installable = candidate;
				} else {
					errors = checked.errors;
				}
				if (errors.length > 0) {
					logger.debug("Job widget spec rejected", { jobId: entry.job.id, errors });
					request.rejected = { answer: JSON.stringify(answer), errors };
				}
			}
		} catch (error) {
			if (!controller.signal.aborted) {
				logger.debug("Job widget spec request failed", { jobId: entry.job.id, error: String(error) });
			}
		} finally {
			this.#inFlight -= 1;
			if (entry.request === controller) entry.request = undefined;
		}
		if (controller.signal.aborted || !this.#enabled() || this.#entries.get(entry.job.id) !== entry) return;
		if (installable) this.#install(entry, installable, brief);
		if (this.#recompute(entry, brief)) this.#notify();
		this.#syncTimer();
	}

	/** A runtime driven by `spec` (none: the fallback) that has read every source from its oldest retained text. */
	#build(job: AsyncJob, spec: JobWidgetSpec | undefined): JobWidgetRuntime {
		const runtime = new JobWidgetRuntime(spec, job.startTime, this.#now);
		const inputs = job.widgetInputs;
		try {
			if (inputs) runtime.ingest(inputs.sources(), job.status !== "running");
		} catch (error) {
			logger.warn("Job widget refresh failed", { jobId: job.id, error: String(error) });
		}
		return runtime;
	}

	/** Drive the widget by a runtime `#build` made and `problems()` cleared. */
	#install(entry: WidgetEntry, runtime: JobWidgetRuntime, brief: JobWidgetBrief): void {
		logger.debug("Job widget spec installed", { jobId: entry.job.id, spec: runtime.spec });
		entry.runtime = runtime;
		entry.specHadWatch = brief.watch !== undefined && brief.watch.length > 0;
		entry.lastIngestAt = this.#now();
	}

	/**
	 * Fall back from a spec that new output shows draws something other than
	 * progress (see `JobWidgetRuntime.problems`), so a misfit never reaches the
	 * screen; the next request sends it back with why.
	 */
	#dropMisfit(entry: WidgetEntry): void {
		const { spec } = entry.runtime;
		if (!spec) return;
		const errors = entry.runtime.problems();
		if (errors.length === 0) return;
		logger.debug("Job widget spec dropped", { jobId: entry.job.id, errors });
		entry.misfit = { answer: JSON.stringify(spec), errors };
		entry.runtime = this.#build(entry.job, undefined);
	}

	#notify(): void {
		for (const listener of this.#listeners) {
			try {
				listener();
			} catch (error) {
				logger.warn("Job widget listener failed", { error: String(error) });
			}
		}
	}

	/** Shown widgets whose views can still change. */
	#hasLiveWidgets(): boolean {
		for (const entry of this.#entries.values()) if (entry.shown && !entry.frozen) return true;
		return false;
	}

	#syncTimer(): void {
		const wanted = !this.#disposed && this.#enabled() && this.#listeners.size > 0 && this.#hasLiveWidgets();
		if (wanted && !this.#timer) {
			this.#timer = setInterval(() => this.#tick(), this.#options.refreshMs);
			this.#timer.unref();
		} else if (!wanted && this.#timer) {
			clearInterval(this.#timer);
			this.#timer = undefined;
		}
	}

	#tick(): void {
		if (!this.#enabled()) {
			for (const entry of this.#entries.values()) entry.request?.abort();
			this.#syncTimer();
			return;
		}
		let changed = false;
		for (const entry of this.#entries.values()) {
			if (!entry.shown || entry.frozen) continue;
			if (this.#refresh(entry, true)) changed = true;
		}
		if (changed) this.#notify();
		this.#syncTimer();
	}
}
