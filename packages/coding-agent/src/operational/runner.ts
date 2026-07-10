/**
 * Crash-recoverable durable job runner over {@link OperationalStore}.
 *
 * Semantics:
 * - Execution is at-least-once: a process crash while `running` requeues the
 *   job after lease expiry, so executors MUST be idempotent enough to tolerate
 *   duplicate runs.
 * - Schedule materialization is exactly-once per occurrence via compare-and-swap
 *   on `schedules.next_run_at` inside one SQLite transaction.
 * - Process-local maps (abort controllers, in-flight flags) are never the
 *   source of truth; job status/leases/checkpoints live in the store.
 * - {@link NotificationSink} delivery is best-effort. Auth, transport security,
 *   and remote endpoint trust are the sink owner's responsibility. Sink
 *   failures are recorded as trajectory events and never flip job outcome.
 */

import { getNextOccurrenceUtc, validateCron } from "./cron";
import type { OperationalStore } from "./store";
import type {
	CreateJobInput,
	DurableJob,
	JobListFilter,
	JsonValue,
	NotificationRecord,
	ScheduledJobPayload,
} from "./types";

const SECRET_TEXT_RE =
	/(?:bearer\s+[a-z0-9._~+/=-]+|sk-[a-z0-9]{8,}|(?:api[_-]?key|token|secret|password)\s*[:=]\s*\S+)/gi;
const DEFAULT_LEASE_MS = 60_000;
const DEFAULT_POLL_INTERVAL_MS = 1_000;

export interface JobExecutorContext {
	readonly job: DurableJob;
	readonly signal: AbortSignal;
	readonly checkpoint: JsonValue | null;
	readonly checkpointWrite: (data: JsonValue) => void;
	readonly heartbeat: () => boolean;
}

export type JobExecutor = (ctx: JobExecutorContext) => Promise<JsonValue | undefined>;

/**
 * Optional completion notifier. Implementations own remote auth/TLS/trust;
 * this runner only persists notifications locally and isolates sink errors.
 */
export interface NotificationSink {
	notify(notification: NotificationRecord): void | Promise<void>;
}

export interface DurableRunnerOptions {
	readonly store: OperationalStore;
	readonly executor: JobExecutor;
	readonly workerId?: string;
	readonly leaseMs?: number;
	readonly pollIntervalMs?: number;
	readonly notificationSink?: NotificationSink;
	readonly now?: () => number;
	readonly createId?: () => string;
}

export function parseScheduledJobPayload(value: JsonValue): ScheduledJobPayload {
	if (value === null || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("schedule payload must be an object with jobType/jobPayload");
	}
	const record = value as { readonly [key: string]: JsonValue };
	const jobType = record.jobType;
	if (typeof jobType !== "string" || !jobType.trim()) {
		throw new Error("schedule payload.jobType must be a non-empty string");
	}
	const jobPayload = record.jobPayload === undefined ? null : record.jobPayload;
	return { jobType: jobType.trim(), jobPayload };
}

function errorMessage(error: unknown): string {
	if (error instanceof Error) return error.message;
	return String(error);
}

function errorType(error: unknown): string {
	if (error instanceof Error && error.name) return error.name;
	return "Error";
}

async function sleepWithSignal(ms: number, signal?: AbortSignal): Promise<void> {
	if (!signal) {
		await Bun.sleep(ms);
		return;
	}
	if (signal.aborted) return;
	const aborted = Promise.withResolvers<void>();
	const onAbort = (): void => aborted.resolve();
	signal.addEventListener("abort", onAbort, { once: true });
	try {
		await Promise.race([Bun.sleep(ms), aborted.promise]);
	} finally {
		signal.removeEventListener("abort", onAbort);
	}
}

function isAbortError(error: unknown): boolean {
	if (!error || typeof error !== "object") return false;
	const name = (error as { name?: unknown }).name;
	return name === "AbortError" || name === "TimeoutError";
}

export class DurableRunner {
	readonly #store: OperationalStore;
	readonly #executor: JobExecutor;
	readonly #workerId: string;
	readonly #leaseMs: number;
	readonly #pollIntervalMs: number;
	readonly #notificationSink: NotificationSink | undefined;
	readonly #now: () => number;
	readonly #createId: () => string;
	readonly #controllers = new Map<string, AbortController>();
	readonly #localIntent = new Map<string, "pause" | "cancel">();
	#disposed = false;
	#runningLoop = false;

	constructor(options: DurableRunnerOptions) {
		this.#store = options.store;
		this.#executor = options.executor;
		this.#workerId = (options.workerId ?? `worker-${Bun.randomUUIDv7()}`).trim();
		if (!this.#workerId) throw new Error("workerId is required");
		this.#leaseMs = Math.max(1, options.leaseMs ?? DEFAULT_LEASE_MS);
		this.#pollIntervalMs = Math.max(0, options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
		this.#notificationSink = options.notificationSink;
		this.#now = options.now ?? (() => Date.now());
		this.#createId = options.createId ?? (() => Bun.randomUUIDv7());
	}

	get workerId(): string {
		return this.#workerId;
	}

	enqueue(input: CreateJobInput): DurableJob {
		this.#assertOpen();
		const job = this.#store.createJob(input);
		this.#store.appendEvent({
			kind: "job_state",
			jobId: job.id,
			payload: { status: job.status, type: job.type, action: "enqueue" },
		});
		return job;
	}

	get(id: string): DurableJob | null {
		this.#assertOpen();
		return this.#store.getJob(id);
	}

	list(filter: JobListFilter = {}): DurableJob[] {
		this.#assertOpen();
		return this.#store.listJobs(filter);
	}

	pause(id: string): DurableJob {
		this.#assertOpen();
		const job = this.#requireJob(id);
		if (job.status === "paused") return job;
		if (job.status === "queued") {
			const paused = this.#store.transitionJob(id, { to: "paused" });
			this.#recordState(paused, "pause");
			return paused;
		}
		if (job.status === "running") {
			this.#localIntent.set(id, "pause");
			this.#controllers.get(id)?.abort();
			const owner = job.leaseOwner ?? this.#workerId;
			const paused = this.#store.transitionJob(id, { to: "paused", leaseOwner: owner });
			this.#recordState(paused, "pause");
			return paused;
		}
		throw new Error(`cannot pause job ${id} in status ${job.status}`);
	}

	resume(id: string): DurableJob {
		this.#assertOpen();
		const job = this.#requireJob(id);
		if (job.status !== "paused" && job.status !== "failed") {
			throw new Error(`cannot resume job ${id} in status ${job.status}`);
		}
		let resumable = job;
		if (job.status === "paused" && job.leaseOwner !== null) {
			if (job.leaseExpiresAt === null || job.leaseExpiresAt > this.#now()) {
				throw new Error(`cannot resume job ${id} until the running worker acknowledges the pause`);
			}
			resumable = this.#store.releasePausedLease(id, job.leaseOwner);
		}
		const resumed = this.#store.transitionJob(id, {
			to: "queued",
			leaseOwner: resumable.leaseOwner,
		});
		this.#recordState(resumed, "resume");
		return resumed;
	}

	cancel(id: string): DurableJob {
		this.#assertOpen();
		const job = this.#requireJob(id);
		if (job.status === "cancelled") return job;
		if (job.status === "completed" || job.status === "failed") {
			throw new Error(`cannot cancel job ${id} in status ${job.status}`);
		}
		if (job.status === "running") {
			this.#localIntent.set(id, "cancel");
			this.#controllers.get(id)?.abort();
			const owner = job.leaseOwner ?? this.#workerId;
			const cancelled = this.#store.transitionJob(id, {
				to: "cancelled",
				leaseOwner: owner,
				error: "cancelled",
			});
			this.#recordState(cancelled, "cancel");
			return cancelled;
		}
		const cancelled = this.#store.transitionJob(id, {
			to: "cancelled",
			leaseOwner: job.leaseOwner,
			error: "cancelled",
		});
		this.#recordState(cancelled, "cancel");
		return cancelled;
	}

	/** Renew the lease for a running job owned by this worker. */
	renewLease(jobId: string, leaseMs = this.#leaseMs): DurableJob {
		this.#assertOpen();
		return this.#store.renewLease(jobId, this.#workerId, leaseMs);
	}

	/**
	 * Materialize due schedules (CAS), recover expired leases, and execute at
	 * most one claimed job.
	 */
	async runOnce(signal?: AbortSignal): Promise<DurableJob | null> {
		this.#assertOpen();
		if (signal?.aborted) return null;

		this.#reconcileTerminalJobs();
		await this.#drainNotifications();
		this.#materializeDueSchedules();
		const recovered = this.#store.recoverExpiredLeases();
		for (const job of recovered) {
			this.#store.appendEvent({
				kind: "job_state",
				jobId: job.id,
				payload: { status: "queued", action: "lease_recovered" },
			});
		}

		const claimed = this.#store.claimJob(this.#workerId, this.#leaseMs);
		if (!claimed) return null;
		this.#store.appendEvent({
			kind: "job_state",
			jobId: claimed.id,
			payload: { status: "running", action: "claim", workerId: this.#workerId },
		});

		return await this.#executeClaimed(claimed, signal);
	}

	async runLoop(signal?: AbortSignal): Promise<void> {
		this.#assertOpen();
		if (this.#runningLoop) throw new Error("runLoop is already active");
		this.#runningLoop = true;
		try {
			while (!this.#disposed && !signal?.aborted) {
				let ran: DurableJob | null = null;
				try {
					ran = await this.runOnce(signal);
				} catch (error) {
					try {
						this.#store.appendEvent({
							kind: "outcome",
							payload: { action: "worker_iteration_error", errorType: errorType(error) },
						});
					} catch {
						// Keep the worker alive; the next iteration can retry storage access.
					}
				}
				if (this.#disposed || signal?.aborted) break;
				if (!ran) {
					await sleepWithSignal(this.#pollIntervalMs, signal);
					if (signal?.aborted) break;
				}
			}
		} finally {
			this.#runningLoop = false;
		}
	}

	dispose(): void {
		if (this.#disposed) return;
		this.#disposed = true;
		for (const controller of this.#controllers.values()) {
			controller.abort();
		}
		this.#controllers.clear();
		this.#localIntent.clear();
	}

	#materializeDueSchedules(): void {
		const now = this.#now();
		const due = this.#store.listDueSchedules(now);
		for (const schedule of due) {
			if (schedule.nextRunAt === null) continue;
			let payload: ScheduledJobPayload;
			try {
				payload = parseScheduledJobPayload(schedule.payload);
				validateCron(schedule.cron);
			} catch (error) {
				this.#store.appendEvent({
					kind: "outcome",
					payload: {
						action: "schedule_materialize_error",
						scheduleId: schedule.id,
						errorType: errorType(error),
					},
				});
				continue;
			}

			let nextRunAt: number | null = null;
			try {
				nextRunAt = getNextOccurrenceUtc(schedule.cron, Math.max(schedule.nextRunAt, now));
			} catch (error) {
				this.#store.appendEvent({
					kind: "outcome",
					payload: {
						action: "schedule_advance_error",
						scheduleId: schedule.id,
						errorType: errorType(error),
					},
				});
				nextRunAt = null;
			}

			const job = this.#store.materializeDueSchedule({
				scheduleId: schedule.id,
				expectedNextRunAt: schedule.nextRunAt,
				nextRunAt,
				jobType: payload.jobType,
				jobPayload: payload.jobPayload,
				jobId: this.#createId(),
			});
			if (!job) continue;
			this.#store.appendEvent({
				kind: "job_state",
				jobId: job.id,
				payload: {
					status: "queued",
					action: "schedule_materialized",
					scheduleId: schedule.id,
					occurrenceAt: schedule.nextRunAt,
				},
			});
		}
	}

	async #executeClaimed(claimed: DurableJob, outerSignal?: AbortSignal): Promise<DurableJob> {
		const controller = new AbortController();
		this.#controllers.set(claimed.id, controller);
		const onOuterAbort = (): void => {
			controller.abort();
		};
		if (outerSignal) {
			if (outerSignal.aborted) controller.abort();
			else outerSignal.addEventListener("abort", onOuterAbort, { once: true });
		}

		try {
			const checkpoint = this.#store.getCheckpoint(claimed.id)?.data ?? claimed.checkpoint;
			let result: JsonValue | undefined;
			try {
				result = await this.#executor({
					job: claimed,
					signal: controller.signal,
					checkpoint,
					checkpointWrite: (data: JsonValue) => {
						try {
							this.#store.setCheckpointForLease(claimed.id, this.#workerId, data);
						} catch (error) {
							controller.abort();
							throw error;
						}
					},
					heartbeat: () => {
						try {
							this.#store.renewLease(claimed.id, this.#workerId, this.#leaseMs);
							return true;
						} catch {
							controller.abort();
							return false;
						}
					},
				});
			} catch (error) {
				const intent = this.#localIntent.get(claimed.id);
				const current = this.#store.getJob(claimed.id);
				if (intent === "cancel" || current?.status === "cancelled") {
					return current ?? claimed;
				}
				if (intent === "pause" || current?.status === "paused") {
					if (current?.status === "paused" && current.leaseOwner === this.#workerId) {
						return this.#store.releasePausedLease(claimed.id, this.#workerId);
					}
					return current ?? claimed;
				}
				if (outerSignal?.aborted) {
					const interrupted = this.#store.transitionJob(claimed.id, {
						to: "queued",
						leaseOwner: this.#workerId,
					});
					this.#recordState(interrupted, "worker_interrupted");
					return interrupted;
				}
				if (controller.signal.aborted || isAbortError(error)) {
					const cancelled = this.#store.transitionJob(claimed.id, {
						to: "cancelled",
						leaseOwner: this.#workerId,
						error: errorMessage(error) || "aborted",
					});
					this.#recordState(cancelled, "abort");
					return cancelled;
				}
				const failed = this.#store.transitionJob(claimed.id, {
					to: "failed",
					leaseOwner: this.#workerId,
					error: errorMessage(error),
				});
				this.#store.appendEvent({
					kind: "outcome",
					jobId: failed.id,
					payload: { ok: false, errorType: errorType(error) },
				});
				this.#recordState(failed, "fail");
				this.#recordEpisode(failed);
				await this.#notifyCompletion(failed);
				return failed;
			}

			const current = this.#store.getJob(claimed.id);
			if (!current) return claimed;
			if (current.status !== "running") return current;

			const completed = this.#store.transitionJob(claimed.id, {
				to: "completed",
				leaseOwner: this.#workerId,
				result: result === undefined ? null : result,
			});
			this.#store.appendEvent({
				kind: "outcome",
				jobId: completed.id,
				payload: { ok: true, hasResult: completed.result !== null },
			});
			this.#recordState(completed, "complete");
			this.#recordEpisode(completed);
			await this.#notifyCompletion(completed);
			return completed;
		} finally {
			if (outerSignal) outerSignal.removeEventListener("abort", onOuterAbort);
			this.#controllers.delete(claimed.id);
			this.#localIntent.delete(claimed.id);
		}
	}

	async #notifyCompletion(job: DurableJob): Promise<void> {
		const notification = this.#createCompletionNotification(job);
		await this.#deliverNotification(notification, job.id);
	}

	#createCompletionNotification(job: DurableJob): NotificationRecord {
		const existing = this.#store.listNotifications(10_000).find(notification => {
			if (
				notification.metadata === null ||
				Array.isArray(notification.metadata) ||
				typeof notification.metadata !== "object"
			)
				return false;
			return notification.metadata.jobId === job.id && notification.metadata.status === job.status;
		});
		if (existing) return existing;
		return this.#store.createNotification({
			kind: job.status === "completed" ? "job_completed" : "job_failed",
			title: `Job ${job.id} ${job.status}`,
			body: job.status === "completed" ? "Durable job completed" : "Durable job failed; inspect local runtime state",
			metadata: { jobId: job.id, type: job.type, status: job.status },
		});
	}

	async #deliverNotification(notification: NotificationRecord, jobId: string): Promise<void> {
		if (!this.#notificationSink || notification.read) return;
		try {
			await this.#notificationSink.notify(notification);
			this.#store.markNotificationRead(notification.id);
		} catch (error) {
			this.#store.appendEvent({
				kind: "outcome",
				jobId,
				payload: {
					action: "notification_sink_error",
					notificationId: notification.id,
					errorType: errorType(error),
				},
			});
		}
	}

	async #drainNotifications(): Promise<void> {
		if (!this.#notificationSink) return;
		for (const notification of this.#store.listNotifications(1_000)) {
			if (notification.read) continue;
			let jobId = "notification";
			if (
				notification.metadata !== null &&
				!Array.isArray(notification.metadata) &&
				typeof notification.metadata === "object"
			) {
				const candidate = notification.metadata.jobId;
				if (typeof candidate === "string") jobId = candidate;
			}
			await this.#deliverNotification(notification, jobId);
		}
	}

	#reconcileTerminalJobs(): void {
		for (const status of ["completed", "failed"] as const) {
			for (const job of this.#store.listJobs({ status, limit: 10_000 })) {
				const outcomes = this.#store.listEvents({ kind: "outcome", jobId: job.id, limit: 10_000 });
				const finalized = outcomes.some(
					event =>
						event.payload !== null &&
						typeof event.payload === "object" &&
						!Array.isArray(event.payload) &&
						"ok" in event.payload,
				);
				if (!finalized) {
					this.#store.appendEvent({
						kind: "outcome",
						jobId: job.id,
						payload:
							status === "completed"
								? { ok: true, recoveredFinalization: true }
								: { ok: false, recoveredFinalization: true },
					});
				}
				this.#recordEpisode(job);
				this.#createCompletionNotification(job);
			}
		}
	}

	#recordEpisode(job: DurableJob): void {
		const episodeId = `job:${job.id}`;
		if (this.#store.getEpisode(episodeId)) return;
		let prompt: string | undefined;
		if (job.payload !== null && !Array.isArray(job.payload) && typeof job.payload === "object") {
			const candidate = job.payload.prompt;
			if (typeof candidate === "string" && candidate.trim()) {
				prompt = candidate
					.replace(SECRET_TEXT_RE, "[redacted]")
					.replace(/[\t\r\n]+/g, " ")
					.trim();
			}
		}
		const title = (prompt?.split(/\r?\n/, 1)[0] ?? `${job.type} job`).slice(0, 160);
		const summary = prompt
			? `${job.status}: ${prompt.slice(0, 1_000)}`
			: `${job.status} durable ${job.type} job ${job.id}`;
		try {
			this.#store.createEpisode({
				id: episodeId,
				title,
				summary,
				tags: ["durable-job", job.type, job.status],
				metadata: { jobId: job.id, jobType: job.type, status: job.status },
			});
		} catch (error) {
			this.#store.appendEvent({
				kind: "outcome",
				jobId: job.id,
				payload: { action: "episode_persist_error", errorType: errorType(error) },
			});
		}
	}

	#recordState(job: DurableJob, action: string): void {
		this.#store.appendEvent({
			kind: "job_state",
			jobId: job.id,
			payload: { status: job.status, action },
		});
	}

	#requireJob(id: string): DurableJob {
		const job = this.#store.getJob(id);
		if (!job) throw new Error(`job not found: ${id}`);
		return job;
	}

	#assertOpen(): void {
		if (this.#disposed) throw new Error("DurableRunner is disposed");
	}
}
