import type { ImageContent } from "@oh-my-pi/pi-ai";
import { logger } from "@oh-my-pi/pi-utils";
import type { StructuredSubagentOutput } from "../task/types";
import {
	buildLineSnappedPreview,
	buildProgressPreview,
	flattenPreviewText,
	mergeProgressPreviews,
	type ProgressPreview,
} from "../session/progress-preview";
import { type ProgressBatch, ProgressBatcher, type ProgressReminder } from "./progress-batcher";
import { type ProgressStreamProvenance, progressStreamProvenanceForText } from "./progress-lines";

const DELIVERY_RETRY_BASE_MS = 500;
const DELIVERY_RETRY_MAX_MS = 30_000;
const DELIVERY_RETRY_JITTER_MS = 200;
const DEFAULT_RETENTION_MS = 5 * 60 * 1000;
/**
 * Extra delay after an `async-result` delivery settles (its `ASIDE_MESSAGE_COMMIT`
 * hook fires, resolving `enqueueWithReceipt()`) before retained artifacts are
 * removed. The commit hook fires when the follow-up is inserted into the
 * transcript, not after the model's next provider call has actually read it —
 * this window gives that round trip time to complete before the backing
 * `<id>.md`/`.json` files disappear out from under an advertised `agent://` URL.
 */
const RETAINED_ARTIFACTS_CLEANUP_GRACE_MS = 60_000;
/**
 * Upper bound on how long retained-artifacts cleanup waits for a hung
 * delivery sink before giving up and running cleanup anyway. Without this,
 * a sink that never settles (e.g. a yield-queue receipt whose owning
 * session is gone) would leak the temp directory for the process lifetime
 * (PR #10625 review). Matches {@link DEFAULT_RETENTION_MS}: by the time a
 * job would have been evicted anyway, there is no realistic path left for
 * the model to still read the advertised `agent://` pointer.
 */
const RETAINED_ARTIFACTS_CLEANUP_MAX_WAIT_MS = DEFAULT_RETENTION_MS;
const DEFAULT_MAX_RUNNING_JOBS = 15;
/** Abort reason used only when the owning session shuts down the entire manager. */
export const ASYNC_JOB_MANAGER_SHUTDOWN_REASON = Symbol("AsyncJobManager shutdown");

/**
 * Adaptive ("smart") `hub` poll-wait ladder (ms). A tight poll loop climbs
 * these rungs so each immediate re-poll backs off and stops spending turns on
 * "still running" frames; the floor (first rung) is the shortest wait and the
 * top rung is the longest a smart poll will ever block. Only used when
 * `async.pollWaitDuration` is set to `smart`; fixed durations wait verbatim.
 */
const POLL_WAIT_LADDER_MS = [5_000, 10_000, 30_000, 60_000, 300_000] as const;
/**
 * Going at least this long between poll calls means the agent stepped out of
 * the poll loop to do real work — the next poll drops back to the ladder floor.
 */
const POLL_ESCALATION_RESET_MS = 60_000;

interface PollEscalationState {
	/** Index into POLL_WAIT_LADDER_MS used for the most recent poll wait. */
	level: number;
	/** Timestamp (ms) when the most recent poll wait returned. */
	lastPollEndAt: number;
}

/** Kind of work a managed job runs; drives job-row badges and delivery labels. */
export type AsyncJobType = "bash" | "task" | "eval";

/**
 * Job-body failure that still carries the run's structured output, so a
 * strict-mode schema violation fails the job without dropping the parsed
 * (invalid) payload.
 */
export class AsyncJobError extends Error {
	constructor(
		message: string,
		readonly structured?: StructuredSubagentOutput,
	) {
		super(message);
	}
}

/** Progress metadata retained for renderers and multimodal completion delivery. */
export interface AsyncJobDetails extends Record<string, unknown> {
	/** Images recovered from command output, independent of text truncation. */
	images?: ImageContent[];
}

export interface AsyncJob {
	id: string;
	type: AsyncJobType;
	status: "running" | "completed" | "failed" | "cancelled";
	startTime: number;
	label: string;
	abortController: AbortController;
	promise: Promise<void>;
	resultText?: string;
	errorText?: string;
	/**
	 * Parsed structured completion for a job whose work selected an output
	 * schema. Set from the body's {@link AsyncJobRunResult} or from an
	 * {@link AsyncJobError}. The job row is the carrier — every delivery
	 * attempt, redelivery, and `hub` snapshot reads it from here.
	 */
	structured?: StructuredSubagentOutput;
	/** Latest tool-render details reported by the running job. */
	latestDetails?: AsyncJobDetails;
	/**
	 * Registry id of the agent that registered the job (e.g. "Main",
	 * "AuthLoader"). Used by scoped cancel/list APIs so a subagent's teardown
	 * does not cancel its parent's jobs. Undefined for callers that don't
	 * supply an id (e.g. legacy tests, SDK consumers without an agent context).
	 */
	ownerId?: string;
	/**
	 * Registry id of the subagent this job runs (task/tan/vibe jobs). Lets
	 * job-view code link a job row to its AgentRegistry ref even when the job
	 * id differs from the agent id (vibe turn jobs, tan clones).
	 */
	agentId?: string;
	/**
	 * Job is registered but parked behind a caller-managed gate (e.g. a task
	 * batch semaphore). Queued jobs do not count toward the running-job limit
	 * until the caller invokes `markRunning()` from the run context.
	 */
	queued?: boolean;
	/**
	 * Disposal closure for a detached spawn's temporary artifacts directory
	 * that `runStructuredSubagent()` retained past completion (so a
	 * delayed `agent://<id>` handle in an `async-result` delivery still
	 * resolves). The manager invokes and clears this exactly once — on
	 * eviction or manager disposal — so the retained directory does not
	 * outlive the job row it was kept alive for.
	 */
	retainedArtifactsCleanup?: () => Promise<void>;
	/** How intentional progress reaches the owning agent; undefined keeps the channel off. */
	progressDelivery?: AsyncJobProgressDelivery;
	/** Progress batches actually handed to the owner sink; >0 means the agent has seen live output. */
	progressDeliveredCount?: number;
	/** Undelivered progress captured at settlement, folded into the completion delivery. */
	completionLeftover?: AsyncJobCompletionLeftover;
	/** Stable artifact containing the complete raw output behind bounded progress previews. */
	progressArtifactId?: string;
	/**
	 * Whether the successful terminal result was derived from the exact raw
	 * stream already covered by progress, or contains terminal-only
	 * post-processing that must remain in the completion.
	 */
	terminalTextProvenance?: "progress" | "terminal";
}
type ProgressDeliveryCoverage = "continuous" | "gapped";

interface ManagedAsyncJob extends AsyncJob {
	/** Manager-local generation key; rotated whenever progress suppression ends. */
	progressKey: string;
	/** Whether delivered progress still continuously covers the job's raw stream. */
	progressDeliveryCoverage: ProgressDeliveryCoverage;
}

/** Progress content that never reached the agent before the job settled. */
export interface AsyncJobCompletionLeftover extends ProgressPreview {
	suppressedEvents?: number;
}

export type AsyncJobProgressDelivery = "ambient" | "wake";

export interface AsyncJobProgressInfo {
	artifactId?: string;
	truncated?: boolean;
	suppressedEvents?: number;
	reminder?: ProgressReminder;
	/**
	 * Fixed-size cumulative identity of the exact raw stream represented through
	 * this sample. Producers should omit it when their preview is transformed.
	 */
	streamProvenance?: ProgressStreamProvenance;
}

interface AsyncJobProgressRecord extends AsyncJobProgressInfo {
	text: string;
}

interface DeliveredAgentProgress {
	/** Bounded model-facing batch text retained for legacy exact comparisons. */
	text: string;
	/** Cumulative raw-stream identity at the end of this delivered batch. */
	streamProvenance?: ProgressStreamProvenance;
}

function laterStreamProvenance(
	left: ProgressStreamProvenance | undefined,
	right: ProgressStreamProvenance | undefined,
): ProgressStreamProvenance | undefined {
	if (!left) return right;
	if (!right) return left;
	return right.codeUnits >= left.codeUnits ? right : left;
}

function streamProvenanceMatchesText(provenance: ProgressStreamProvenance | undefined, text: string): boolean {
	if (!provenance || provenance.codeUnits !== text.length) return false;
	return provenance.sha256 === progressStreamProvenanceForText(text).sha256;
}

function mergeAsyncJobProgressRecords(
	left: AsyncJobProgressRecord,
	right: AsyncJobProgressRecord,
): AsyncJobProgressRecord {
	const preview = mergeProgressPreviews(
		buildProgressPreview(left.text, left.truncated),
		buildProgressPreview(right.text, right.truncated),
	);
	const suppressedEvents = (left.suppressedEvents ?? 0) + (right.suppressedEvents ?? 0);
	return {
		text: flattenPreviewText(preview),
		artifactId: right.artifactId ?? left.artifactId,
		truncated: preview.truncated,
		suppressedEvents: suppressedEvents || undefined,
		reminder: right.reminder ?? left.reminder,
		streamProvenance: laterStreamProvenance(left.streamProvenance, right.streamProvenance),
	};
}

/**
 * Preserve metadata from a suppressed value displaced out of the bounded
 * outer-text window. `kept.text` is deliberately untouched: only the manager's
 * delivery boundary joins retained outer values.
 */
function mergeAsyncJobProgressMetadata(
	kept: AsyncJobProgressRecord,
	displaced: AsyncJobProgressRecord,
): AsyncJobProgressRecord {
	const suppressedEvents = (kept.suppressedEvents ?? 0) + (displaced.suppressedEvents ?? 0);
	return {
		...kept,
		artifactId: kept.artifactId ?? displaced.artifactId,
		truncated: kept.truncated === true || displaced.truncated === true || undefined,
		suppressedEvents: suppressedEvents || undefined,
		streamProvenance: laterStreamProvenance(kept.streamProvenance, displaced.streamProvenance),
		reminder: kept.reminder ?? displaced.reminder,
	};
}

/** Delivery callback for a settled job's result text. */
export type AsyncJobDeliverySink = (jobId: string, text: string, job?: AsyncJob) => void | Promise<void>;

/** Best-effort owner-routed delivery for progress from a still-running job. */
export interface AsyncJobProgressSink {
	deliver(jobId: string, text: string, job: AsyncJob, seq: number, info: AsyncJobProgressInfo): void | Promise<void>;
	/** Permanently discard progress that the owner already queued before this job was acknowledged. */
	acknowledge?(jobId: string): void;
}

/**
 * Terminal payload a job's run callback may resolve with instead of a plain
 * string. `structured` carries the parsed structured output of a subagent
 * yield. `details` carries executor metadata (`exitCode`, `timedOut`, …)
 * that the manager merges into {@link AsyncJob.latestDetails} at settlement.
 * Tools overwrite `latestDetails` with render payloads on every
 * `reportProgress` call, so without this merge a completion delivery would
 * read whatever the last progress report happened to contain.
 */
export interface AsyncJobRunResult {
	text: string;
	structured?: StructuredSubagentOutput;
	details?: AsyncJobDetails;
	/**
	 * Pre-format source represented by `text`. Bash uses this to exclude
	 * completion-only timing notices from raw-stream comparison while still
	 * detecting minimizer, truncation, and other output transformations.
	 */
	terminalTextSource?: string;
}

/**
 * Failure-path counterpart of {@link AsyncJobRunResult}: a run callback that
 * throws this error attaches executor metadata (`exitCode`, `timedOut`, …)
 * which the manager merges into {@link AsyncJob.latestDetails} at settlement.
 */
export class AsyncJobRunError extends Error {
	readonly details: AsyncJobDetails;

	constructor(message: string, details: AsyncJobDetails, options?: ErrorOptions) {
		super(message, options);
		this.name = "AsyncJobRunError";
		this.details = details;
	}
}

export interface AsyncJobManagerOptions {
	/**
	 * Delivery sink for UNOWNED completions (jobs registered without an
	 * `ownerId`). Owned deliveries route exclusively through
	 * {@link AsyncJobManager.registerDeliverySink}; when the owner has no live
	 * sink they are dead-lettered (dropped with a warning; the job row keeps
	 * the result text until retention eviction) — never routed here, which
	 * would leak one agent's result into another session.
	 */
	onJobComplete?: AsyncJobDeliverySink;
	maxRunningJobs?: number;
	retentionMs?: number;
	/**
	 * Delay after a job's `async-result` delivery settles before its retained
	 * artifacts are removed (see {@link RETAINED_ARTIFACTS_CLEANUP_GRACE_MS}).
	 * Defaults to that constant; tests override to `0` to assert cleanup
	 * without a real-time wait.
	 */
	retainedArtifactsCleanupGraceMs?: number;
	/**
	 * Upper bound on how long retained-artifacts cleanup waits for a job's
	 * delivery to settle before giving up and running cleanup anyway (see
	 * {@link RETAINED_ARTIFACTS_CLEANUP_MAX_WAIT_MS}). Defaults to that
	 * constant; tests override to a small value to assert the bound without
	 * a real-time wait.
	 */
	retainedArtifactsCleanupMaxWaitMs?: number;
}

interface AsyncJobDelivery {
	jobId: string;
	text: string;
	attempt: number;
	nextAttemptAt: number;
	lastError?: string;
	ownerId?: string;
	promise?: Promise<void>;
	/**
	 * Job-body metadata a sink needs to render the delivered result,
	 * snapshotted at enqueue time. `#deliverDelivery` falls back to
	 * reconstructing an `AsyncJob`-shaped record from this when the live job
	 * row has already been evicted (retention elapsed while delivery kept
	 * retrying) — without it, a recovered delivery would silently drop
	 * `structured` even though `text` survives on the delivery itself.
	 */
	jobSnapshot?: Pick<AsyncJob, "type" | "status" | "startTime" | "label" | "structured" | "agentId" | "latestDetails">;
}

export interface AsyncJobDeliveryState {
	queued: number;
	delivering: boolean;
	nextRetryAt?: number;
	pendingJobIds: string[];
}

export interface AsyncJobReapResult {
	settled: boolean;
	pendingJobIds: string[];
	completion: Promise<void>;
}

export interface AsyncJobRegisterOptions {
	id?: string;
	/** Registry id of the agent that owns this job; used to scope cancelAll. */
	ownerId?: string;
	/** Registry id of the subagent this job runs; see {@link AsyncJob.agentId}. */
	agentId?: string;
	onProgress?: (text: string, details?: AsyncJobDetails) => void | Promise<void>;
	/** Register the job in queued state; see {@link AsyncJob.queued}. */
	queued?: boolean;
	/** Opt into model-facing progress and choose whether it wakes an idle agent. */
	progressDelivery?: AsyncJobProgressDelivery;
}

/**
 * Filter applied to job query/cancel APIs. With `ownerId`, results are
 * restricted to jobs registered by that agent (registry id from
 * `AgentRegistry`, e.g. "Main", "AuthLoader").
 */
export interface AsyncJobFilter {
	ownerId?: string;
}

export class AsyncJobManager {
	static #instance: AsyncJobManager | undefined;

	/** Process-global instance shared by internal URL protocol handlers and tools. */
	static instance(): AsyncJobManager | undefined {
		return AsyncJobManager.#instance;
	}

	/** Install or clear the process-global instance. */
	static setInstance(value: AsyncJobManager | undefined): void {
		AsyncJobManager.#instance = value;
	}

	/** Reset the process-global instance. Test-only. */
	static resetForTests(): void {
		AsyncJobManager.#instance = undefined;
	}

	readonly #jobs = new Map<string, ManagedAsyncJob>();
	readonly #deliveries: AsyncJobDelivery[] = [];
	readonly #inFlightDeliveries: AsyncJobDelivery[] = [];
	readonly #suppressedDeliveries = new Set<string>();
	readonly #watchedJobs = new Set<string>();
	readonly #consumedJobResults = new Set<string>();
	readonly #evictionTimers = new Map<string, NodeJS.Timeout>();
	readonly #pollEscalation = new Map<string | undefined, PollEscalationState>();
	readonly #deliverySinks = new Map<string, AsyncJobDeliverySink>();
	readonly #progressSinks = new Map<string, AsyncJobProgressSink>();
	readonly #lastDeliveredAgentProgress = new Map<string, DeliveredAgentProgress>();
	readonly #progressJobs = new Map<string, ManagedAsyncJob>();
	readonly #progressBatcher = new ProgressBatcher<AsyncJobProgressRecord>(
		(progressKey, batch) => this.#deliverAgentProgress(progressKey, batch),
		{
			merge: mergeAsyncJobProgressRecords,
			mergeDisplacedMetadata: mergeAsyncJobProgressMetadata,
		},
	);
	readonly #onJobComplete: AsyncJobManagerOptions["onJobComplete"];
	readonly #maxRunningJobs: number;
	readonly #retentionMs: number;
	readonly #retainedArtifactsCleanupGraceMs: number;
	readonly #retainedArtifactsCleanupMaxWaitMs: number;
	#deliveryLoop: Promise<void> | undefined;
	#deliveryQueueChanged = Promise.withResolvers<void>();
	#disposed = false;
	#nextProgressGeneration = 0;

	#filterJobs(jobs: Iterable<AsyncJob>, filter?: AsyncJobFilter): AsyncJob[] {
		const ownerId = filter?.ownerId;
		if (!ownerId) return Array.from(jobs);
		const out: AsyncJob[] = [];
		for (const job of jobs) {
			if (job.ownerId === ownerId) out.push(job);
		}
		return out;
	}

	constructor(options: AsyncJobManagerOptions) {
		this.#onJobComplete = options.onJobComplete;
		this.#maxRunningJobs = Math.max(1, Math.floor(options.maxRunningJobs ?? DEFAULT_MAX_RUNNING_JOBS));
		this.#retentionMs = Math.max(0, Math.floor(options.retentionMs ?? DEFAULT_RETENTION_MS));
		this.#retainedArtifactsCleanupGraceMs = Math.max(
			0,
			Math.floor(options.retainedArtifactsCleanupGraceMs ?? RETAINED_ARTIFACTS_CLEANUP_GRACE_MS),
		);
		this.#retainedArtifactsCleanupMaxWaitMs = Math.max(
			0,
			Math.floor(options.retainedArtifactsCleanupMaxWaitMs ?? RETAINED_ARTIFACTS_CLEANUP_MAX_WAIT_MS),
		);
	}

	/** True when the running-job count has reached the configured cap. */
	get atCapacity(): boolean {
		if (this.#disposed) return true;
		// Mirror register(): queued jobs hold no execution slot.
		let activeCount = 0;
		for (const job of this.#jobs.values()) {
			if (job.status === "running" && !job.queued) activeCount++;
		}
		return activeCount >= this.#maxRunningJobs;
	}

	register(
		type: AsyncJobType,
		label: string,
		run: (ctx: {
			jobId: string;
			signal: AbortSignal;
			reportProgress: (text: string, details?: AsyncJobDetails) => Promise<void>;
			/** Report intentional progress to the owning model, separately from TUI updates. */
			reportAgentProgress: (text: string, info?: AsyncJobProgressInfo) => void;
			/** Clear the queued flag once the job actually starts executing. */
			markRunning: () => void;
		}) => Promise<string | AsyncJobRunResult>,
		options?: AsyncJobRegisterOptions,
	): string {
		if (this.#disposed) {
			throw new Error("Async job manager is disposed");
		}
		// Queued jobs hold no execution slot yet — only count jobs that are
		// actually running so a large parked batch cannot starve registration.
		let activeCount = 0;
		for (const existing of this.#jobs.values()) {
			if (existing.status === "running" && !existing.queued) activeCount++;
		}
		if (activeCount >= this.#maxRunningJobs) {
			throw new Error(
				`Background job limit reached (${this.#maxRunningJobs}). Wait for running jobs to finish or cancel one.`,
			);
		}

		const id = this.#resolveJobId(options?.id);
		this.#suppressedDeliveries.delete(id);
		this.#consumedJobResults.delete(id);
		const abortController = new AbortController();
		const startTime = Date.now();

		const job: ManagedAsyncJob = {
			id,
			type,
			status: "running",
			startTime,
			label,
			abortController,
			promise: Promise.resolve(),
			ownerId: options?.ownerId,
			agentId: options?.agentId,
			queued: options?.queued === true,
			progressDelivery: options?.progressDelivery,
			progressKey: `${id}\0${++this.#nextProgressGeneration}`,
			progressDeliveryCoverage: "continuous",
		};
		this.#progressJobs.set(job.progressKey, job);

		const reportProgress = async (text: string, details?: AsyncJobDetails): Promise<void> => {
			if (details) job.latestDetails = details;
			if (!options?.onProgress) return;
			try {
				await options.onProgress(text, details);
			} catch (error) {
				logger.warn("Async job progress callback failed", {
					jobId: id,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		};
		job.promise = (async () => {
			try {
				const outcome = await run({
					jobId: id,
					signal: abortController.signal,
					reportProgress,
					reportAgentProgress: (text, info) => this.#recordAgentProgress(job, text, info),
					markRunning: () => {
						job.queued = false;
					},
				});
				const text = typeof outcome === "string" ? outcome : outcome.text;
				const structured = typeof outcome === "string" ? undefined : outcome.structured;
				if (structured) job.structured = structured;
				const terminalTextSource = typeof outcome === "string" ? text : (outcome.terminalTextSource ?? text);
				// Settlement metadata wins over the last reportProgress payload:
				// tools overwrite latestDetails with render details on every
				// progress call, so the completion delivery must read the
				// executor's real exitCode/timedOut from here.
				if (typeof outcome !== "string") this.#mergeSettledDetails(job, outcome.details);
				if (this.#isCancelled(job)) {
					job.resultText = text;
					this.#scheduleEviction(job);
					return;
				}
				await this.#settleAgentProgress(job, text, terminalTextSource);
				// Cancellation may win while final progress is awaiting its
				// asynchronous sink. Never overwrite that terminal state or
				// enqueue a completion after cancel() returned true.
				if (this.#isCancelled(job)) {
					job.resultText = text;
					this.#scheduleEviction(job);
					return;
				}
				job.status = "completed";
				job.resultText = text;
				this.#enqueueDelivery(id, text);
				this.#scheduleEviction(job);
			} catch (error) {
				if (error instanceof AsyncJobError && error.structured) job.structured = error.structured;
				if (error instanceof AsyncJobRunError) this.#mergeSettledDetails(job, error.details);
				const errorText = error instanceof Error ? error.message : String(error);
				job.terminalTextProvenance = "terminal";
				if (this.#isCancelled(job)) {
					job.errorText = errorText;
					this.#scheduleEviction(job);
					return;
				}
				await this.#settleAgentProgress(job);
				// Mirror the success-path guard: cancellation can occur while
				// the failure waits for its final progress sink to drain.
				if (this.#isCancelled(job)) {
					job.errorText = errorText;
					this.#scheduleEviction(job);
					return;
				}
				job.status = "failed";
				job.errorText = errorText;
				this.#enqueueDelivery(id, errorText);
				this.#scheduleEviction(job);
			}
		})();

		this.#jobs.set(id, job);
		return id;
	}

	#mergeSettledDetails(job: AsyncJob, details: AsyncJobDetails | undefined): void {
		if (!details) return;
		job.latestDetails = { ...job.latestDetails, ...details };
	}

	#isCancelled(job: AsyncJob): boolean {
		return job.status === "cancelled";
	}

	/**
	 * Cancel a single job by id. When `filter.ownerId` is set and does not
	 * match the job's owner, the call is treated as not-found (returns false)
	 * so cross-agent cancellation is rejected at the manager level.
	 */
	cancel(id: string, filter?: AsyncJobFilter): boolean {
		const job = this.#jobs.get(id);
		if (!job) return false;
		if (filter?.ownerId && job.ownerId !== filter.ownerId) return false;
		if (job.status !== "running") return false;
		this.acknowledgeDeliveries([id]);
		job.status = "cancelled";
		job.abortController.abort();
		this.#scheduleEviction(job);
		return true;
	}

	getJob(id: string): AsyncJob | undefined {
		return this.#jobs.get(id);
	}

	getRunningJobs(filter?: AsyncJobFilter): AsyncJob[] {
		return this.#filterJobs(this.#jobs.values(), filter).filter(job => job.status === "running");
	}

	getRecentJobs(limit = 10, filter?: AsyncJobFilter): AsyncJob[] {
		return this.#filterJobs(this.#jobs.values(), filter)
			.filter(job => job.status !== "running")
			.sort((a, b) => b.startTime - a.startTime)
			.slice(0, limit);
	}

	getAllJobs(filter?: AsyncJobFilter): AsyncJob[] {
		return this.#filterJobs(this.#jobs.values(), filter);
	}

	getDeliveryState(filter?: AsyncJobFilter): AsyncJobDeliveryState {
		const deliveries = this.#filterDeliveries(filter);
		const inFlightDeliveries = this.#filterInFlightDeliveries(filter);
		const nextRetryAt = deliveries.reduce<number | undefined>((next, delivery) => {
			if (next === undefined) return delivery.nextAttemptAt;
			return Math.min(next, delivery.nextAttemptAt);
		}, undefined);

		return {
			queued: deliveries.length + inFlightDeliveries.length,
			delivering: inFlightDeliveries.length > 0 || (this.#deliveryLoop !== undefined && deliveries.length > 0),
			nextRetryAt,
			pendingJobIds: deliveries.concat(inFlightDeliveries).map(delivery => delivery.jobId),
		};
	}

	hasPendingDeliveries(filter?: AsyncJobFilter): boolean {
		return this.getDeliveryState(filter).queued > 0;
	}

	watchJobs(jobIds: string[]): number {
		const uniqueJobIds = Array.from(new Set(jobIds.map(id => id.trim()).filter(id => id.length > 0)));
		for (const jobId of uniqueJobIds) {
			this.#watchedJobs.add(jobId);
			const job = this.#jobs.get(jobId);
			if (job) this.#clearAgentProgress(job);
		}
		this.#notifyDeliveryQueueChanged();
		return uniqueJobIds.length;
	}

	unwatchJobs(jobIds: string[]): number {
		const uniqueJobIds = Array.from(new Set(jobIds.map(id => id.trim()).filter(id => id.length > 0)));
		let removed = 0;
		for (const jobId of uniqueJobIds) {
			if (!this.#watchedJobs.delete(jobId)) continue;
			removed += 1;
			const job = this.#jobs.get(jobId);
			if (job) this.#resumeAgentProgress(job);
		}
		return removed;
	}

	/**
	 * Compute the next adaptive ("smart") wait (ms) for a blocking `hub` wait by
	 * the given owner. Consecutive polls — those starting within
	 * POLL_ESCALATION_RESET_MS of the previous poll returning — climb
	 * POLL_WAIT_LADDER_MS so a tight wait loop backs off; a longer gap means the
	 * agent left to do real work, so the wait resets to the floor. Pair each call
	 * with `recordPollWaitEnd()` once the wait returns.
	 */
	nextPollWaitMs(ownerId: string | undefined, now: number = Date.now()): number {
		const prev = this.#pollEscalation.get(ownerId);
		const reset = !prev || now - prev.lastPollEndAt >= POLL_ESCALATION_RESET_MS;
		const level = reset ? 0 : Math.min(prev.level + 1, POLL_WAIT_LADDER_MS.length - 1);
		this.#pollEscalation.set(ownerId, { level, lastPollEndAt: prev?.lastPollEndAt ?? now });
		return POLL_WAIT_LADDER_MS[level];
	}

	/**
	 * Mark a blocking poll wait as finished so the idle-reset window is measured
	 * from now. Polling again before POLL_ESCALATION_RESET_MS elapses keeps
	 * climbing the ladder; waiting longer resets it to the floor.
	 */
	recordPollWaitEnd(ownerId: string | undefined, now: number = Date.now()): void {
		const prev = this.#pollEscalation.get(ownerId);
		this.#pollEscalation.set(ownerId, { level: prev?.level ?? 0, lastPollEndAt: now });
	}

	acknowledgeDeliveries(jobIds: string[]): number {
		const uniqueJobIds = Array.from(new Set(jobIds.map(id => id.trim()).filter(id => id.length > 0)));
		if (uniqueJobIds.length === 0) return 0;

		for (const jobId of uniqueJobIds) {
			const job = this.#jobs.get(jobId);
			if (job?.ownerId !== undefined) this.#progressSinks.get(job.ownerId)?.acknowledge?.(jobId);
			this.#suppressedDeliveries.add(jobId);
			if (job) this.#clearAgentProgress(job);
		}

		const before = this.#deliveries.length;
		this.#deliveries.splice(
			0,
			this.#deliveries.length,
			...this.#deliveries.filter(delivery => !this.isDeliverySuppressed(delivery.jobId)),
		);
		this.#notifyDeliveryQueueChanged();
		return before - this.#deliveries.length;
	}

	/**
	 * Mark settled job results as recovered by a foreground snapshot.
	 *
	 * Suppresses queued delivery and marks retained bodies as consumed so later
	 * snapshots report execution state without replaying the same result.
	 */
	consumeJobResults(jobIds: string[]): number {
		const uniqueJobIds = Array.from(new Set(jobIds.map(id => id.trim()).filter(id => id.length > 0)));
		this.acknowledgeDeliveries(uniqueJobIds);
		let consumed = 0;
		for (const jobId of uniqueJobIds) {
			if (this.#consumeJobResult(jobId)) consumed += 1;
		}
		return consumed;
	}

	/** True once a result was auto-delivered or recovered by a foreground snapshot. */
	isJobResultConsumed(jobId: string): boolean {
		return this.#consumedJobResults.has(jobId);
	}

	/**
	 * Lift a foreground-wait suppression set via `acknowledgeDeliveries`. If the
	 * job already finished while suppressed (its delivery enqueue was skipped),
	 * re-enqueue the completion so the result is still delivered exactly once.
	 */
	resumeDeliveries(jobIds: string[]): void {
		for (const rawId of jobIds) {
			const jobId = rawId.trim();
			if (!jobId) continue;
			if (!this.#suppressedDeliveries.delete(jobId)) continue;
			const job = this.#jobs.get(jobId);
			if (!job) continue;
			this.#resumeAgentProgress(job);
			if (job.status !== "completed" && job.status !== "failed") continue;
			const queued =
				this.#deliveries.some(delivery => delivery.jobId === jobId) ||
				this.#inFlightDeliveries.some(delivery => delivery.jobId === jobId);
			if (queued) continue;
			this.#enqueueDelivery(jobId, job.status === "completed" ? (job.resultText ?? "") : (job.errorText ?? ""));
		}
	}

	/**
	 * Cancel running jobs. With `filter.ownerId` set, cancels only jobs the
	 * matching agent registered; with no filter, cancels every running job
	 * (used by `dispose()` to nuke the manager's state).
	 *
	 * `reason` is forwarded to each job's `AbortController.abort`, so a session
	 * teardown can tag its owned jobs with {@link ASYNC_JOB_MANAGER_SHUTDOWN_REASON}
	 * before `dispose()` runs — the task executor reads it to park (not
	 * tombstone) a subagent interrupted purely by process shutdown.
	 */
	cancelAll(filter?: AsyncJobFilter, reason?: unknown): void {
		this.#cancelJobs(filter, reason);
	}

	#cancelJobs(filter?: AsyncJobFilter, reason?: unknown): void {
		const jobs: ManagedAsyncJob[] = [];
		for (const publicJob of this.getRunningJobs(filter)) {
			const job = this.#jobs.get(publicJob.id);
			if (job === publicJob) jobs.push(job);
		}
		this.acknowledgeDeliveries(jobs.map(job => job.id));
		for (const job of jobs) {
			job.status = "cancelled";
			job.abortController.abort(reason);
			this.#scheduleEviction(job);
		}
	}

	/**
	 * Immediately evict completed and failed jobs matching the filter instead of
	 * waiting for retention expiry, dropping every queued delivery so a prior
	 * session's result can never be injected into a later transcript. Returns the
	 * number of jobs evicted.
	 *
	 * A delivery whose sink call is already in flight (or drained onto a caller's
	 * yield queue) is guarded by the owner's delivery generation, not the per-id
	 * suppression marker — that marker is cleared when the id is reused.
	 */
	evictCompletedJobs(filter?: AsyncJobFilter): number {
		let evicted = 0;
		for (const publicJob of this.#filterJobs(this.#jobs.values(), filter)) {
			const job = this.#jobs.get(publicJob.id);
			if (job !== publicJob || (job.status !== "completed" && job.status !== "failed")) continue;
			this.acknowledgeDeliveries([job.id]);
			if (this.#evictJob(job)) evicted += 1;
		}
		return evicted;
	}

	async waitForAll(): Promise<void> {
		await Promise.all(Array.from(this.#jobs.values()).map(job => job.promise));
	}

	/**
	 * Route completions for jobs owned by `ownerId` to `sink`. Sessions register
	 * their own sink at construction and unregister on dispose. Owned deliveries
	 * with no live sink are dead-lettered — `onJobComplete` serves only unowned
	 * deliveries.
	 *
	 * Last registration wins for an owner id; the returned unregister clears the
	 * mapping only while it still points at `sink`, so a revived session's fresh
	 * registration survives its parked predecessor's late cleanup.
	 */
	registerDeliverySink(ownerId: string, sink: AsyncJobDeliverySink): () => void {
		this.#deliverySinks.set(ownerId, sink);
		return () => {
			if (this.#deliverySinks.get(ownerId) === sink) this.#deliverySinks.delete(ownerId);
		};
	}

	/**
	 * Route progress for jobs owned by `ownerId`. The newest registration wins,
	 * matching completion delivery ownership.
	 */
	registerProgressSink(ownerId: string, sink: AsyncJobProgressSink): () => void {
		this.#progressSinks.set(ownerId, sink);
		return () => {
			if (this.#progressSinks.get(ownerId) === sink) this.#progressSinks.delete(ownerId);
		};
	}

	/** Enable model-facing progress for a running job after a caller-managed foreground phase. */
	activateProgressDelivery(jobId: string, delivery: AsyncJobProgressDelivery): boolean {
		const job = this.#jobs.get(jobId);
		if (job?.status !== "running") return false;
		job.progressDelivery = delivery;
		this.#resumeAgentProgress(job);
		return true;
	}

	#recordAgentProgress(job: ManagedAsyncJob, text: string, info: AsyncJobProgressInfo = {}): void {
		if (this.#disposed || job.status !== "running" || job.progressDelivery === undefined) return;
		if (this.isDeliverySuppressed(job.id)) {
			job.progressDeliveryCoverage = "gapped";
			return;
		}
		if (job.ownerId === undefined || !this.#progressSinks.has(job.ownerId)) return;
		if (info.artifactId) job.progressArtifactId = info.artifactId;
		// Registration can report synchronously before the public map is populated.
		// Otherwise the public map must still identify this exact generation.
		const currentJob = this.#jobs.get(job.id);
		if (currentJob === undefined && this.#progressJobs.get(job.progressKey) !== job) return;
		if (currentJob !== undefined && currentJob !== job) return;
		// Upstream producers (e.g. broker monitor batches) may arrive already
		// rate-limited: carry their suppression metadata into the record so this
		// second batcher's merge preserves the suppressed-event count and any
		// chatty-monitor reminder instead of silently dropping them.
		this.#progressBatcher.push(job.progressKey, { text, ...info });
	}

	async #deliverAgentProgress(progressKey: string, batch: ProgressBatch<AsyncJobProgressRecord>): Promise<void> {
		const job = this.#progressJobs.get(progressKey);
		const currentJob = job ? this.#jobs.get(job.id) : undefined;
		if (!job || (currentJob !== undefined && currentJob !== job) || job.status !== "running") return;
		if (this.isDeliverySuppressed(job.id)) return;
		if (batch.kind === "artifact-only") return;
		const sink = job.ownerId === undefined ? undefined : this.#progressSinks.get(job.ownerId);
		if (!sink) return;
		const recordSuppressedEvents = batch.values.reduce((total, record) => total + (record.suppressedEvents ?? 0), 0);
		const suppressedEvents = batch.suppressedEvents + recordSuppressedEvents;
		const info: AsyncJobProgressInfo = {
			artifactId:
				batch.values.findLast(record => record.artifactId !== undefined)?.artifactId ?? job.progressArtifactId,
			truncated: suppressedEvents > 0 || batch.values.some(record => record.truncated === true),
			suppressedEvents: suppressedEvents || undefined,
			reminder: batch.reminder ?? batch.values.findLast(record => record.reminder !== undefined)?.reminder,
		};
		const deliveredText = batch.values.map(record => record.text).join("\n");
		try {
			await sink.deliver(job.id, deliveredText, job, batch.seq, info);
			if (this.#jobs.get(job.id) !== job || this.#progressJobs.get(progressKey) !== job) return;
			// Retain fixed-size cumulative raw-stream provenance, plus only this
			// bounded delivery for callers without provenance. Multi-batch Bash
			// output can therefore be recognized despite line framing/newline
			// normalization, while minimized or otherwise transformed output does
			// not match and remains terminal-visible.
			this.#lastDeliveredAgentProgress.set(progressKey, {
				text: deliveredText,
				streamProvenance: batch.values.reduce<ProgressStreamProvenance | undefined>(
					(latest, record) => laterStreamProvenance(latest, record.streamProvenance),
					undefined,
				),
			});
			// An ambient sink may only ENQUEUE this batch while the owner is
			// idle; that still counts as delivered because the owner folds any
			// still-queued ambient progress into the completion-triggered flush
			// ahead of the result (AgentSession's async-result sink), so a
			// completion never outruns output this counter claims was delivered.
			job.progressDeliveredCount = (job.progressDeliveredCount ?? 0) + 1;
		} catch (error) {
			job.progressDeliveryCoverage = "gapped";
			logger.warn("Async job progress delivery failed", {
				jobId: job.id,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	#flushAgentProgress(job: ManagedAsyncJob): Promise<void> {
		return this.#progressBatcher.finish(job.progressKey);
	}

	/**
	 * Settle the progress channel at job completion. Once the agent has seen
	 * live output and an artifact holds the complete stream, the completion
	 * delivery only needs the never-delivered remainder — capture the pending
	 * window instead of racing one last progress message ahead of the result.
	 * Jobs whose progress never reached the agent keep the old flush so their
	 * recorded output is not lost.
	 */
	async #settleAgentProgress(
		job: ManagedAsyncJob,
		terminalText?: string,
		terminalTextSource = terminalText,
	): Promise<void> {
		try {
			await this.#settleAgentProgressInner(job, terminalText, terminalTextSource);
		} catch (error) {
			logger.warn("Async job progress settlement failed", {
				jobId: job.id,
				error: error instanceof Error ? error.message : String(error),
			});
			if (this.#jobs.get(job.id) !== job) return;
			if (terminalText !== undefined && terminalTextSource !== undefined) {
				job.terminalTextProvenance = "terminal";
			}
			this.#clearAgentProgress(job);
		}
	}

	async #settleAgentProgressInner(
		job: ManagedAsyncJob,
		terminalText?: string,
		terminalTextSource = terminalText,
	): Promise<void> {
		let pendingCoversTerminal = false;
		if (
			job.progressDelivery === undefined ||
			(job.progressDeliveredCount ?? 0) === 0 ||
			job.progressArtifactId === undefined
		) {
			await this.#flushAgentProgress(job);
		} else {
			const pending = await this.#progressBatcher.takePending(job.progressKey);
			if (this.#jobs.get(job.id) !== job) return;
			if (pending) {
				const record =
					pending.values.length === 0 ? undefined : pending.values.reduce(mergeAsyncJobProgressRecords);
				const suppressedEvents =
					pending.suppressedEvents +
					pending.values.reduce((total, value) => total + (value.suppressedEvents ?? 0), 0);
				const sourceTruncated = suppressedEvents > 0 || pending.values.some(value => value.truncated === true);
				const preview = record ? buildLineSnappedPreview(record.text, sourceTruncated) : { truncated: true };
				job.completionLeftover = { ...preview, suppressedEvents: suppressedEvents || undefined };
				pendingCoversTerminal =
					terminalText !== undefined &&
					terminalTextSource !== undefined &&
					(streamProvenanceMatchesText(record?.streamProvenance, terminalTextSource) ||
						record?.text === terminalText ||
						pending.values.some(value => value.text === terminalText));
			}
		}
		if (this.#jobs.get(job.id) !== job) return;
		if (terminalText !== undefined && terminalTextSource !== undefined) {
			const delivered = this.#lastDeliveredAgentProgress.get(job.progressKey);
			job.terminalTextProvenance =
				job.progressDeliveryCoverage === "continuous" &&
				(pendingCoversTerminal ||
					streamProvenanceMatchesText(delivered?.streamProvenance, terminalTextSource) ||
					delivered?.text === terminalText)
					? "progress"
					: "terminal";
		}
		this.#lastDeliveredAgentProgress.delete(job.progressKey);
	}

	#resumeAgentProgress(job: ManagedAsyncJob): void {
		if (
			this.#jobs.get(job.id) !== job ||
			job.status !== "running" ||
			job.progressDelivery === undefined ||
			this.isDeliverySuppressed(job.id) ||
			this.#progressJobs.get(job.progressKey) === job
		)
			return;
		job.progressKey = `${job.id}\0${++this.#nextProgressGeneration}`;
		this.#progressJobs.set(job.progressKey, job);
	}

	#clearAgentProgress(job: ManagedAsyncJob): void {
		job.progressDeliveryCoverage = "gapped";
		this.#progressBatcher.clear(job.progressKey);
		this.#lastDeliveredAgentProgress.delete(job.progressKey);
		this.#progressJobs.delete(job.progressKey);
	}

	#clearAllAgentProgress(): void {
		this.#progressBatcher.dispose();
		this.#lastDeliveredAgentProgress.clear();
		this.#progressJobs.clear();
	}

	/**
	 * Wait until every job owned by `ownerId` has settled — its run promise
	 * resolved, which for cancelled jobs means the underlying process actually
	 * exited. Jobs registered while waiting (e.g. by a follow-up turn) are
	 * awaited too. Returns false when `timeoutMs` elapses first.
	 *
	 * `excludeSuppressed` skips jobs whose delivery is suppressed (acknowledged
	 * or `hub`-watched): those can never re-wake a run, so quiescence barriers
	 * pass it to share one contract with the pending-async-wake predicate.
	 * Teardown reaps omit it — worktree safety concerns every owner process.
	 */
	async waitForOwnerJobs(
		ownerId: string,
		options?: { timeoutMs?: number; excludeSuppressed?: boolean },
	): Promise<boolean> {
		const deadline =
			options?.timeoutMs === undefined ? Number.POSITIVE_INFINITY : Date.now() + Math.max(0, options.timeoutMs);
		const awaited = new Set<AsyncJob>();
		for (;;) {
			const pending = this.#filterJobs(this.#jobs.values(), { ownerId }).filter(
				job => !awaited.has(job) && (options?.excludeSuppressed !== true || !this.isDeliverySuppressed(job.id)),
			);
			if (pending.length === 0) return true;
			for (const job of pending) awaited.add(job);
			const settled = await this.#waitForDeliveryPromise(
				Promise.all(pending.map(job => job.promise)).then(() => {}),
				deadline,
			);
			if (!settled) return false;
		}
	}

	/**
	 * Cancel every job owned by `ownerId`, then wait only until `deadlineAt`.
	 * The returned completion keeps waiting for actual process settlement when
	 * the deadline expires, so callers can move that cleanup out of the
	 * user-visible Task wait without losing ownership of the live work.
	 */
	async cancelAndReapOwnerJobs(ownerId: string, deadlineAt: number): Promise<AsyncJobReapResult> {
		this.cancelAll({ ownerId });
		const timeoutMs = Math.max(0, deadlineAt - Date.now());
		const settled = await this.waitForOwnerJobs(ownerId, { timeoutMs });
		if (settled) {
			return { settled: true, pendingJobIds: [], completion: Promise.resolve() };
		}
		const pendingJobIds = this.getAllJobs({ ownerId })
			.filter(job => job.status === "running" || job.status === "cancelled")
			.map(job => job.id);
		const completion = this.waitForOwnerJobs(ownerId).then(() => {});
		return { settled: false, pendingJobIds, completion };
	}

	async #waitForAllUntil(deadline: number): Promise<boolean> {
		const promises = Array.from(this.#jobs.values()).map(job => job.promise);
		if (promises.length === 0) return true;
		if (deadline === Number.POSITIVE_INFINITY) {
			await Promise.all(promises);
			return true;
		}
		const remainingMs = deadline - Date.now();
		if (remainingMs <= 0) return false;

		const timeout = Promise.withResolvers<"timeout">();
		const timer = setTimeout(() => timeout.resolve("timeout"), remainingMs);
		timer.unref();
		try {
			const result = await Promise.race([Promise.all(promises).then(() => "settled" as const), timeout.promise]);
			return result === "settled";
		} finally {
			clearTimeout(timer);
		}
	}

	async drainDeliveries(options?: { timeoutMs?: number; filter?: AsyncJobFilter }): Promise<boolean> {
		const timeoutMs = options?.timeoutMs;
		const filter = options?.filter;
		const hasDeadline = timeoutMs !== undefined;
		const deadline = hasDeadline ? Date.now() + Math.max(timeoutMs, 0) : Number.POSITIVE_INFINITY;

		while (this.hasPendingDeliveries(filter)) {
			if (filter?.ownerId) {
				const delivered = await this.#deliverNextFiltered(filter, deadline);
				if (delivered) continue;
				return false;
			}
			const inFlightDeliveries = this.#filterInFlightDeliveries();
			if (inFlightDeliveries.length > 0 && this.#filterDeliveries().length === 0) {
				const delivered = await this.#waitForDeliveryPromise(inFlightDeliveries[0]?.promise, deadline);
				if (delivered) continue;
				return false;
			}

			this.#ensureDeliveryLoop();
			const loop = this.#deliveryLoop;
			if (!loop) {
				continue;
			}

			if (!hasDeadline) {
				await loop;
				continue;
			}

			const remainingMs = deadline - Date.now();
			if (remainingMs <= 0) {
				return false;
			}

			await Promise.race([loop, Bun.sleep(remainingMs)]);
			if (Date.now() >= deadline && this.hasPendingDeliveries(filter)) {
				return false;
			}
		}

		return true;
	}

	async dispose(options?: { timeoutMs?: number }): Promise<boolean> {
		this.#disposed = true;
		this.#clearEvictionTimers();
		this.#cancelJobs(undefined, ASYNC_JOB_MANAGER_SHUTDOWN_REASON);
		const timeoutMs = Math.max(options?.timeoutMs ?? 3_000, 0);
		const deadline = Date.now() + timeoutMs;
		const jobsSettled = await this.#waitForAllUntil(deadline);
		const drained = await this.drainDeliveries({ timeoutMs: Math.max(deadline - Date.now(), 0) });
		this.#clearEvictionTimers();
		// Bypass the grace-period sleep: dispose has already drained/cancelled
		// deliveries above, so there is nothing left for the model to read via
		// `agent://<id>` — sleeping the retention window here would only leak
		// temp dirs for up to `retainedArtifactsCleanupGraceMs` (or past
		// process exit, since dispose does not await these cleanups).
		for (const job of this.#jobs.values()) this.#runRetainedArtifactsCleanup(job, { bypassGrace: true });
		this.#jobs.clear();
		this.#deliveries.length = 0;
		this.#notifyDeliveryQueueChanged();
		this.#inFlightDeliveries.length = 0;
		this.#suppressedDeliveries.clear();
		this.#watchedJobs.clear();
		this.#consumedJobResults.clear();
		this.#pollEscalation.clear();
		this.#deliverySinks.clear();
		this.#progressSinks.clear();
		this.#clearAllAgentProgress();
		return jobsSettled && drained;
	}

	#consumeJobResult(jobId: string): boolean {
		const job = this.#jobs.get(jobId);
		if (!job || job.status === "running" || this.#consumedJobResults.has(jobId)) return false;
		if (job.resultText === undefined && job.errorText === undefined) return false;
		this.#consumedJobResults.add(jobId);
		return true;
	}

	#resolveJobId(preferredId?: string): string {
		preferredId = preferredId?.trim();
		if (!preferredId) {
			let candidate = 1;
			while (true) {
				const id = `bg_${candidate}`;
				if (!this.#jobs.has(id)) {
					return id;
				}
				candidate += 1;
			}
		}

		const base = preferredId.trim();
		if (!this.#jobs.has(base)) return base;

		let suffix = 2;
		let candidate = `${base}-${suffix}`;
		while (this.#jobs.has(candidate)) {
			suffix += 1;
			candidate = `${base}-${suffix}`;
		}
		return candidate;
	}

	/**
	 * Fire a retained temporary artifacts cleanup exactly once, deferred
	 * until this job's `async-result` delivery has settled (delivered,
	 * dead-lettered, or given up retrying) plus a grace period. Job-row
	 * eviction happens on its own timer independent of delivery — a still-
	 * streaming owner session can leave a delivery in flight (its sink
	 * awaits `yieldQueue.enqueueWithReceipt()`) well past the retention
	 * window, and deleting the retained directory before that receipt
	 * settles would advertise an `agent://` URL whose backing files are
	 * already gone.
	 * The receipt itself resolves at `ASIDE_MESSAGE_COMMIT` — when the
	 * follow-up is inserted into the transcript, but *before* the next
	 * provider call that actually shows it to the model (agent-loop fires
	 * the commit hook, then starts the call). Running cleanup immediately
	 * on settlement would delete the artifacts before the model's very next
	 * turn has any chance to read the pointer via a tool call, so a grace
	 * period covers that round trip.
	 * Errors are logged, not thrown — a failed disposal must not block job
	 * eviction or manager teardown.
	 */
	#runRetainedArtifactsCleanup(job: AsyncJob, options?: { bypassGrace?: boolean }): void {
		const cleanup = job.retainedArtifactsCleanup;
		if (!cleanup) return;
		job.retainedArtifactsCleanup = undefined;
		const jobId = job.id;
		const bypassGrace = options?.bypassGrace === true;
		void this.#waitForJobDeliverySettledBounded(jobId)
			.then(() =>
				!bypassGrace && this.#retainedArtifactsCleanupGraceMs > 0
					? Bun.sleep(this.#retainedArtifactsCleanupGraceMs)
					: undefined,
			)
			.then(cleanup)
			.catch(error => {
				logger.warn("Async job retained artifacts cleanup failed", {
					jobId,
					error: error instanceof Error ? error.message : String(error),
				});
			});
	}

	/**
	 * Bounded variant of {@link #waitForJobDeliverySettled}: gives up and
	 * resolves after {@link #retainedArtifactsCleanupMaxWaitMs} even if the
	 * delivery sink never settles (e.g. a yield-queue receipt whose owning
	 * session is gone) so a hung sink cannot leak the retained temp
	 * directory for the process lifetime (PR #10625 review). The unbounded
	 * wait keeps running in the background after the bound trips; it is
	 * harmless once orphaned since cleanup no longer depends on it.
	 */
	async #waitForJobDeliverySettledBounded(jobId: string): Promise<void> {
		const timedOut = Promise.withResolvers<true>();
		const timer = setTimeout(() => timedOut.resolve(true), this.#retainedArtifactsCleanupMaxWaitMs);
		timer.unref();
		try {
			const timedOutFirst = await Promise.race([
				this.#waitForJobDeliverySettled(jobId).then(() => false as const),
				timedOut.promise,
			]);
			if (timedOutFirst) {
				logger.warn(
					"Async job delivery did not settle before the retained artifacts cleanup bound; running cleanup anyway",
					{
						jobId,
						maxWaitMs: this.#retainedArtifactsCleanupMaxWaitMs,
					},
				);
			}
		} finally {
			clearTimeout(timer);
		}
	}

	/**
	 * Resolve once no delivery for `jobId` is queued or in flight. Loops
	 * because a failed in-flight attempt may requeue itself for retry;
	 * terminates once the delivery succeeds, is dead-lettered (no live
	 * sink), or stops retrying (job already evicted from `#jobs`).
	 */
	async #waitForJobDeliverySettled(jobId: string): Promise<void> {
		for (;;) {
			const inFlight = this.#inFlightDeliveries.find(delivery => delivery.jobId === jobId);
			if (inFlight) {
				await inFlight.promise?.catch(() => {});
				continue;
			}
			const queued = this.#deliveries.find(delivery => delivery.jobId === jobId);
			if (!queued) return;
			this.#ensureDeliveryLoop();
			await this.#waitForDeliveryQueueChange(Math.max(50, queued.nextAttemptAt - Date.now()));
		}
	}

	#evictJob(job: ManagedAsyncJob): boolean {
		if (this.#jobs.get(job.id) !== job) return false;
		clearTimeout(this.#evictionTimers.get(job.id));
		this.#evictionTimers.delete(job.id);
		this.#suppressedDeliveries.delete(job.id);
		this.#watchedJobs.delete(job.id);
		this.#consumedJobResults.delete(job.id);
		this.#clearAgentProgress(job);
		this.#runRetainedArtifactsCleanup(job);
		return this.#jobs.delete(job.id);
	}

	#scheduleEviction(job: ManagedAsyncJob): void {
		if (this.#jobs.get(job.id) !== job) return;
		this.#clearAgentProgress(job);
		if (this.#disposed) return;
		if (this.#retentionMs <= 0) {
			this.#evictJob(job);
			return;
		}
		const existing = this.#evictionTimers.get(job.id);
		clearTimeout(existing);
		const timer = setTimeout(() => {
			this.#evictJob(job);
		}, this.#retentionMs);
		timer.unref();
		this.#evictionTimers.set(job.id, timer);
	}

	#clearEvictionTimers(): void {
		for (const timer of this.#evictionTimers.values()) {
			clearTimeout(timer);
		}
		this.#evictionTimers.clear();
	}

	#filterDeliveries(filter?: AsyncJobFilter): AsyncJobDelivery[] {
		const ownerId = filter?.ownerId;
		if (!ownerId) return this.#deliveries.filter(delivery => !this.isDeliverySuppressed(delivery.jobId));
		return this.#deliveries.filter(
			delivery => delivery.ownerId === ownerId && !this.isDeliverySuppressed(delivery.jobId),
		);
	}

	#filterInFlightDeliveries(filter?: AsyncJobFilter): AsyncJobDelivery[] {
		const ownerId = filter?.ownerId;
		if (!ownerId) return this.#inFlightDeliveries.filter(delivery => !this.isDeliverySuppressed(delivery.jobId));
		return this.#inFlightDeliveries.filter(
			delivery => delivery.ownerId === ownerId && !this.isDeliverySuppressed(delivery.jobId),
		);
	}

	async #deliverNextFiltered(filter: AsyncJobFilter, deadline: number): Promise<boolean> {
		while (true) {
			let selected: AsyncJobDelivery | undefined;
			for (const delivery of this.#deliveries) {
				if (delivery.ownerId !== filter.ownerId) continue;
				if (this.isDeliverySuppressed(delivery.jobId)) continue;
				if (!selected || delivery.nextAttemptAt < selected.nextAttemptAt) {
					selected = delivery;
				}
			}

			if (!selected) {
				const inFlight = this.#filterInFlightDeliveries(filter);
				if (inFlight.length === 0) return true;
				return this.#waitForDeliveryPromise(inFlight[0]?.promise, deadline);
			}

			const now = Date.now();
			if (selected.nextAttemptAt > now) {
				if (selected.nextAttemptAt > deadline) return false;
				await this.#waitForDeliveryQueueChange(selected.nextAttemptAt - now);
				continue;
			}

			const index = this.#deliveries.indexOf(selected);
			if (index === -1) continue;
			this.#deliveries.splice(index, 1);
			this.#notifyDeliveryQueueChanged();
			if (this.isDeliverySuppressed(selected.jobId)) continue;

			return this.#waitForDeliveryPromise(this.#deliverDelivery(selected), deadline);
		}
	}

	isDeliverySuppressed(jobId: string): boolean {
		return this.#suppressedDeliveries.has(jobId) || this.#watchedJobs.has(jobId);
	}

	#enqueueDelivery(jobId: string, text: string): void {
		// Skip delivery if already acknowledged
		if (this.isDeliverySuppressed(jobId)) {
			return;
		}
		const job = this.#jobs.get(jobId);
		this.#queueDelivery({
			jobId,
			text,
			attempt: 0,
			nextAttemptAt: Date.now(),
			ownerId: job?.ownerId,
			jobSnapshot: job
				? {
						type: job.type,
						status: job.status,
						startTime: job.startTime,
						label: job.label,
						structured: job.structured,
						agentId: job.agentId,
						latestDetails: job.latestDetails,
					}
				: undefined,
		});
		this.#ensureDeliveryLoop();
	}

	#ensureDeliveryLoop(): void {
		if (this.#deliveryLoop) {
			return;
		}

		this.#deliveryLoop = this.#runDeliveryLoop()
			.catch(error => {
				logger.error("Async job delivery loop crashed", { error: String(error) });
			})
			.finally(() => {
				this.#deliveryLoop = undefined;
				if (this.#deliveries.length > 0) {
					this.#ensureDeliveryLoop();
				}
			});
	}

	async #runDeliveryLoop(): Promise<void> {
		while (this.#deliveries.length > 0) {
			const delivery = this.#deliveries[0];
			if (this.isDeliverySuppressed(delivery.jobId)) {
				this.#deliveries.shift();
				continue;
			}
			const waitMs = delivery.nextAttemptAt - Date.now();
			if (waitMs > 0) {
				await this.#waitForDeliveryQueueChange(waitMs);
				continue;
			}
			if (this.#deliveries[0] !== delivery) {
				continue;
			}
			if (this.isDeliverySuppressed(delivery.jobId)) {
				this.#deliveries.shift();
				continue;
			}

			this.#deliveries.shift();
			void this.#deliverDelivery(delivery);
		}
	}

	/**
	 * Resolve the sink for one delivery attempt: owned deliveries route ONLY to
	 * their owner's registered sink (a missing sink dead-letters — never the
	 * default, which would misroute a dead owner's result into another
	 * session); unowned deliveries use the constructor default. Resolved per
	 * attempt so a sink registered between retries (e.g. a revived session)
	 * picks up the retry.
	 */
	#resolveDeliverySink(ownerId: string | undefined): AsyncJobDeliverySink | undefined {
		if (ownerId !== undefined) return this.#deliverySinks.get(ownerId);
		return this.#onJobComplete;
	}

	#deliverDelivery(delivery: AsyncJobDelivery): Promise<void> {
		const sink = this.#resolveDeliverySink(delivery.ownerId);
		if (!sink) {
			// Dead-letter: owned delivery with no live sink (session disposed or
			// parked), or unowned delivery with no default sink. Drop it — the
			// job row keeps its result/error text until retention eviction, so
			// the outcome stays inspectable via job queries and agent:// reads.
			logger.warn("Async job delivery dead-lettered: no delivery sink", {
				jobId: delivery.jobId,
				ownerId: delivery.ownerId,
			});
			delivery.promise = Promise.resolve();
			return delivery.promise;
		}
		const promise = (async () => {
			this.#inFlightDeliveries.push(delivery);
			try {
				await sink(
					delivery.jobId,
					delivery.text,
					this.#jobs.get(delivery.jobId) ?? this.#reconstructEvictedJob(delivery),
				);
				this.#consumeJobResult(delivery.jobId);
			} catch (error) {
				delivery.attempt += 1;
				delivery.lastError = error instanceof Error ? error.message : String(error);
				delivery.nextAttemptAt = Date.now() + this.#getRetryDelay(delivery.attempt);
				if (!this.isDeliverySuppressed(delivery.jobId) && this.#jobs.has(delivery.jobId)) {
					this.#queueDelivery(delivery);
				}
				logger.warn("Async job completion delivery failed", {
					jobId: delivery.jobId,
					attempt: delivery.attempt,
					nextRetryAt: delivery.nextAttemptAt,
					error: delivery.lastError,
				});
			} finally {
				const index = this.#inFlightDeliveries.indexOf(delivery);
				if (index !== -1) this.#inFlightDeliveries.splice(index, 1);
				if (this.#deliveries.length > 0) this.#ensureDeliveryLoop();
			}
		})();
		delivery.promise = promise;
		return promise;
	}

	/**
	 * Rebuild a minimal {@link AsyncJob} from a delivery's enqueue-time
	 * snapshot when the live job row was already evicted by the time this
	 * delivery attempt runs (retention elapsed while delivery kept retrying).
	 * Lets the sink still render `type`/`label`/`structured` instead of
	 * silently losing them, matching what `job.resultText` would have carried
	 * had the row survived.
	 */
	#reconstructEvictedJob(delivery: AsyncJobDelivery): AsyncJob | undefined {
		const snapshot = delivery.jobSnapshot;
		if (!snapshot) return undefined;
		return {
			id: delivery.jobId,
			type: snapshot.type,
			status: snapshot.status,
			startTime: snapshot.startTime,
			label: snapshot.label,
			abortController: new AbortController(),
			promise: Promise.resolve(),
			resultText: delivery.text,
			structured: snapshot.structured,
			agentId: snapshot.agentId,
			latestDetails: snapshot.latestDetails,
		};
	}

	#queueDelivery(delivery: AsyncJobDelivery): void {
		const index = this.#deliveries.findIndex(candidate => candidate.nextAttemptAt > delivery.nextAttemptAt);
		if (index === -1) this.#deliveries.push(delivery);
		else this.#deliveries.splice(index, 0, delivery);
		this.#notifyDeliveryQueueChanged();
	}

	async #waitForDeliveryQueueChange(delayMs: number): Promise<void> {
		const timerElapsed = Promise.withResolvers<void>();
		const timer = setTimeout(timerElapsed.resolve, delayMs);
		timer.unref();
		try {
			await Promise.race([timerElapsed.promise, this.#deliveryQueueChanged.promise]);
		} finally {
			clearTimeout(timer);
		}
	}

	#notifyDeliveryQueueChanged(): void {
		this.#deliveryQueueChanged.resolve();
		this.#deliveryQueueChanged = Promise.withResolvers<void>();
	}

	async #waitForDeliveryPromise(promise: Promise<void> | undefined, deadline: number): Promise<boolean> {
		if (!promise) return true;
		if (deadline === Number.POSITIVE_INFINITY) {
			await promise;
			return true;
		}
		const remainingMs = deadline - Date.now();
		if (remainingMs <= 0) return false;
		let timedOut = false;
		await Promise.race([
			promise,
			Bun.sleep(remainingMs).then(() => {
				timedOut = true;
			}),
		]);
		return !timedOut;
	}

	#getRetryDelay(attempt: number): number {
		const exp = Math.min(Math.max(attempt - 1, 0), 8);
		const backoffMs = DELIVERY_RETRY_BASE_MS * 2 ** exp;
		const jitterMs = Math.floor(Math.random() * DELIVERY_RETRY_JITTER_MS);
		return Math.min(DELIVERY_RETRY_MAX_MS, backoffMs + jitterMs);
	}
}
