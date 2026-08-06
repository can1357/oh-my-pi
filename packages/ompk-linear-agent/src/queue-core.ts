/**
 * Queue state machine shared by the Durable Object and its tests.
 *
 * All methods MUST run serialized (the Durable Object wraps every public
 * operation in `blockConcurrencyWhile`); the core itself only guarantees
 * correctness of the state transitions, not cross-call interleaving.
 *
 * Fencing model: every lease grants a fresh `attemptId` + unguessable
 * `leaseToken`. Completion requires the job id, the attempt id, and the
 * token of the CURRENT lease. A re-leased job invalidates all prior tokens,
 * so a stale relay can never overwrite a newer attempt or repeat side
 * effects — duplicate completion of the accepted attempt is reported as
 * `duplicate: true` so callers skip external side effects.
 *
 * Liveness model (docs/multi-agent-fork-collaboration.md, target automation
 * contract): a leased runner heartbeats every `heartbeatMs`; each fenced
 * heartbeat re-arms the lease. A leased job that misses two heartbeats (or
 * outlives its lease) moves to `reconcile` via {@link QueueCore.sweep} — it
 * is NEVER re-granted directly. Reconcile resolves only by:
 * - a fenced heartbeat (the runner was alive all along → restored to leased);
 * - a fenced completion (a late result proves the attempt finished);
 * - {@link QueueCore.resolveReconcile} after the prior runner is confirmed
 *   terminated — requeued while attempts remain, otherwise dead-lettered.
 *
 * `sweep` is the ONLY leased→reconcile authority; `lease` grants strictly
 * from the pending list, so a replacement can never start while liveness is
 * merely uncertain.
 */

import type { Job, JobResult } from "./types";

export interface QueueStorage {
	get<T>(key: string): Promise<T | undefined>;
	put(key: string, value: unknown): Promise<void>;
	delete(key: string): Promise<void>;
}

export interface QueueLimits {
	/** Lease duration; a fenced heartbeat re-arms it. */
	leaseMs: number;
	/** Attempts (initial + requeues) before a job dead-letters as failed. */
	maxAttempts: number;
	/** Expected heartbeat cadence; two missed beats move a lease to reconcile. */
	heartbeatMs: number;
	/**
	 * Backoff before retry N+1 after transient failure N (last entry
	 * repeats). Doc target: 30s / 2m / 5m / 15m / 30m.
	 */
	backoffScheduleMs: readonly number[];
}

export const DEFAULT_QUEUE_LIMITS: QueueLimits = {
	leaseMs: 30 * 60_000,
	maxAttempts: 5,
	heartbeatMs: 10 * 60_000,
	backoffScheduleMs: [30_000, 120_000, 300_000, 900_000, 1_800_000],
};

export interface AdmitOutcome {
	accepted: boolean;
	reason?: "duplicate" | "active_job_exists";
	jobId: string;
}

export interface LeaseGrant {
	job: Job;
	attemptId: string;
	leaseToken: string;
}

export type CompleteOutcome =
	| { ok: true; job: Job; duplicate: boolean; retryScheduled: boolean }
	| { ok: false; code: "not_found" | "not_leased" | "fenced" | "stale" };

export type HeartbeatOutcome =
	| { ok: true; job: Job; leaseExpiresAt: string; restored: boolean }
	| { ok: false; code: "not_found" | "not_leased" | "fenced" };

export type ReconcileDisposition = "requeued" | "dead_lettered" | "failed";

export type ReconcileOutcome =
	| { ok: true; job: Job; disposition: ReconcileDisposition }
	| { ok: false; code: "not_found" | "not_reconcile" | "fenced" };

export interface SweepResult {
	/** Jobs that transitioned leased → reconcile in this sweep. */
	reconciled: Job[];
	/** Earliest liveness deadline among still-live leases, for alarm arming. */
	nextDeadlineAt: number | null;
}

const PENDING_KEY = "queue:pending";
const LEASED_KEY = "queue:leased";
const RECONCILE_KEY = "queue:reconcile";

function jobKey(id: string): string {
	return `job:${id}`;
}

function dedupeStorageKey(key: string): string {
	return `dedupe:${key}`;
}

function issueKey(issueId: string): string {
	return `issue-active:${issueId}`;
}

export class QueueCore {
	readonly #storage: QueueStorage;
	readonly #limits: QueueLimits;

	constructor(storage: QueueStorage, limits: Partial<QueueLimits> = {}) {
		this.#storage = storage;
		this.#limits = { ...DEFAULT_QUEUE_LIMITS, ...limits };
	}

	async #ids(key: string): Promise<string[]> {
		return (await this.#storage.get<string[]>(key)) ?? [];
	}

	async #job(id: string): Promise<Job | undefined> {
		return this.#storage.get<Job>(jobKey(id));
	}

	async #saveJob(job: Job): Promise<void> {
		await this.#storage.put(jobKey(job.id), job);
	}

	async #removeFromList(key: string, id: string): Promise<void> {
		await this.#storage.put(
			key,
			(await this.#ids(key)).filter(entry => entry !== id),
		);
	}

	async #addToList(key: string, id: string): Promise<void> {
		const ids = await this.#ids(key);
		if (!ids.includes(id)) {
			ids.push(id);
			await this.#storage.put(key, ids);
		}
	}

	/**
	 * A lease is presumed dead at the earlier of its expiry and two missed
	 * heartbeats. Jobs leased before the heartbeat era fall back to expiry.
	 */
	#livenessDeadline(job: Job): number {
		const leaseExpiry = job.leaseExpiresAt ? Date.parse(job.leaseExpiresAt) : 0;
		const lastBeat = job.lastHeartbeatAt ?? job.leasedAt;
		if (!lastBeat) return leaseExpiry;
		return Math.min(leaseExpiry, Date.parse(lastBeat) + 2 * this.#limits.heartbeatMs);
	}

	/**
	 * Admit a job exactly once per dedupe key, with at most one active
	 * (pending/leased/reconcile) job per issue. Reconcile retains the issue
	 * claim: liveness uncertainty must be resolved, not papered over by a
	 * second admission.
	 */
	async admit(job: Job): Promise<AdmitOutcome> {
		const existingByDedupe = await this.#storage.get<{ jobId: string }>(dedupeStorageKey(job.dedupeKey));
		if (existingByDedupe) {
			return { accepted: false, reason: "duplicate", jobId: existingByDedupe.jobId };
		}
		const activeForIssue = await this.#storage.get<{ jobId: string }>(issueKey(job.issueId));
		if (activeForIssue) {
			const active = await this.#job(activeForIssue.jobId);
			if (active && (active.status === "pending" || active.status === "leased" || active.status === "reconcile")) {
				return { accepted: false, reason: "active_job_exists", jobId: active.id };
			}
			await this.#storage.delete(issueKey(job.issueId));
		}
		await this.#saveJob(job);
		await this.#addToList(PENDING_KEY, job.id);
		await this.#storage.put(dedupeStorageKey(job.dedupeKey), { jobId: job.id });
		await this.#storage.put(issueKey(job.issueId), { jobId: job.id });
		return { accepted: true, jobId: job.id };
	}

	/**
	 * Move every leased job past its liveness deadline to `reconcile`.
	 * Fence identity is retained so a late fenced heartbeat or completion
	 * from the original runner can still resolve the uncertainty.
	 */
	async sweep(now: number): Promise<SweepResult> {
		const leased = await this.#ids(LEASED_KEY);
		const reconciled: Job[] = [];
		const remaining: string[] = [];
		let nextDeadlineAt: number | null = null;
		let dirty = false;
		for (const id of leased) {
			const job = await this.#job(id);
			if (job?.status !== "leased") {
				dirty = true;
				continue;
			}
			const deadline = this.#livenessDeadline(job);
			if (deadline > now) {
				remaining.push(id);
				nextDeadlineAt = nextDeadlineAt === null ? deadline : Math.min(nextDeadlineAt, deadline);
				continue;
			}
			job.status = "reconcile";
			job.reconcileAt = new Date(now).toISOString();
			job.reconcileReason = job.lastHeartbeatAt
				? `no heartbeat since ${job.lastHeartbeatAt}`
				: `no heartbeat since lease at ${job.leasedAt ?? "unknown"}`;
			await this.#saveJob(job);
			await this.#addToList(RECONCILE_KEY, id);
			reconciled.push(job);
			dirty = true;
		}
		if (dirty) await this.#storage.put(LEASED_KEY, remaining);
		return { reconciled, nextDeadlineAt };
	}

	/** Earliest liveness deadline among leased jobs; `null` when none are leased. */
	async nextDeadline(): Promise<number | null> {
		let next: number | null = null;
		for (const id of await this.#ids(LEASED_KEY)) {
			const job = await this.#job(id);
			if (job?.status !== "leased") continue;
			const deadline = this.#livenessDeadline(job);
			next = next === null ? deadline : Math.min(next, deadline);
		}
		return next;
	}

	/**
	 * Grant the oldest pending job. Expired or silent leases are NOT
	 * re-granted here; they are parked by {@link sweep} until explicitly
	 * resolved.
	 */
	async lease(leasedBy: string, now: number): Promise<LeaseGrant | null> {
		const pending = await this.#ids(PENDING_KEY);
		const kept: string[] = [];
		let granted: Job | null = null;
		for (const id of pending) {
			if (granted) {
				kept.push(id);
				continue;
			}
			const job = await this.#job(id);
			if (job?.status !== "pending") continue;
			if (job.notBefore && Date.parse(job.notBefore) > now) {
				// Backoff gate: hold this retry without starving later jobs.
				kept.push(id);
				continue;
			}
			granted = job;
		}
		if (granted || kept.length !== pending.length) {
			await this.#storage.put(PENDING_KEY, kept);
		}
		return granted ? this.#grant(granted, leasedBy, now) : null;
	}

	async #grant(job: Job, leasedBy: string, now: number): Promise<LeaseGrant> {
		job.status = "leased";
		job.attempts += 1;
		job.attemptId = crypto.randomUUID();
		job.leaseToken = crypto.randomUUID();
		job.logicalAttemptKey = `${job.source ?? "linear"}:${job.organizationId ?? "unknown"}:${job.issueId}:${job.attempts}`;
		if (job.stagedPrompt !== undefined) {
			// The issue was revised between attempts: latest revision wins.
			job.prompt = job.stagedPrompt;
			job.stagedPrompt = undefined;
		}
		job.leasedAt = new Date(now).toISOString();
		job.lastHeartbeatAt = job.leasedAt;
		job.leaseExpiresAt = new Date(now + this.#limits.leaseMs).toISOString();
		job.leasedBy = leasedBy;
		job.reconcileAt = undefined;
		job.reconcileReason = undefined;
		job.notBefore = undefined;
		await this.#saveJob(job);
		await this.#addToList(LEASED_KEY, job.id);
		return { job, attemptId: job.attemptId, leaseToken: job.leaseToken };
	}

	/**
	 * Apply an issue revision to the active job instead of failing closed.
	 * A `pending` job takes the new prompt immediately; an in-flight
	 * (`leased`/`reconcile`) job stages it for the next grant — the current
	 * attempt keeps the prompt it started with. Latest revision wins, and
	 * the delivery is recorded in the dedupe map so replays no-op.
	 */
	async refreshPrompt(
		issueId: string,
		prompt: string,
		dedupeKey: string,
	): Promise<
		{ ok: true; job: Job; applied: "immediate" | "staged" } | { ok: false; code: "no_active_job" | "duplicate" }
	> {
		const existingByDedupe = await this.#storage.get<{ jobId: string }>(dedupeStorageKey(dedupeKey));
		if (existingByDedupe) return { ok: false, code: "duplicate" };
		const activeForIssue = await this.#storage.get<{ jobId: string }>(issueKey(issueId));
		if (!activeForIssue) return { ok: false, code: "no_active_job" };
		const job = await this.#job(activeForIssue.jobId);
		if (!job || (job.status !== "pending" && job.status !== "leased" && job.status !== "reconcile")) {
			return { ok: false, code: "no_active_job" };
		}
		// Content idempotency: re-deliveries of the same revision (different
		// delivery ids, identical body) must not report a refresh.
		if ((job.stagedPrompt ?? job.prompt) === prompt) return { ok: false, code: "duplicate" };
		if (job.status === "pending") {
			job.prompt = prompt;
			job.stagedPrompt = undefined;
		} else {
			job.stagedPrompt = prompt;
		}
		await this.#saveJob(job);
		await this.#storage.put(dedupeStorageKey(dedupeKey), { jobId: job.id });
		return { ok: true, job, applied: job.status === "pending" ? "immediate" : "staged" };
	}

	/**
	 * Read-only fence introspection for branch-mutation guards: valid only
	 * while the presented fence is the CURRENT lease of a live attempt.
	 * Terminal, pending, and superseded fences are all invalid.
	 */
	async checkFence(id: string, attemptId: string, leaseToken: string): Promise<{ valid: boolean }> {
		const job = await this.#job(id);
		if (!job) return { valid: false };
		if (job.status !== "leased" && job.status !== "reconcile") return { valid: false };
		if (!job.attemptId || !job.leaseToken) return { valid: false };
		return { valid: job.attemptId === attemptId && job.leaseToken === leaseToken };
	}

	/**
	 * Fenced liveness signal. Re-arms the lease; a fenced beat on a
	 * `reconcile` job proves the runner is alive and restores it to `leased`
	 * (`restored: true`), so no replacement can be admitted around it.
	 */
	async heartbeat(id: string, attemptId: string, leaseToken: string, now: number): Promise<HeartbeatOutcome> {
		const job = await this.#job(id);
		if (!job) return { ok: false, code: "not_found" };
		if (job.status !== "leased" && job.status !== "reconcile") return { ok: false, code: "not_leased" };
		if (!job.attemptId || !job.leaseToken || job.attemptId !== attemptId || job.leaseToken !== leaseToken) {
			return { ok: false, code: "fenced" };
		}
		const restored = job.status === "reconcile";
		job.status = "leased";
		job.lastHeartbeatAt = new Date(now).toISOString();
		job.leaseExpiresAt = new Date(now + this.#limits.leaseMs).toISOString();
		job.reconcileAt = undefined;
		job.reconcileReason = undefined;
		await this.#saveJob(job);
		if (restored) {
			await this.#removeFromList(RECONCILE_KEY, id);
			await this.#addToList(LEASED_KEY, id);
		}
		return { ok: true, job, leaseExpiresAt: job.leaseExpiresAt, restored };
	}

	/**
	 * Fenced completion: only the current lease holder may complete. Valid
	 * from `leased` AND `reconcile` — a late fenced result resolves liveness
	 * uncertainty positively instead of discarding finished work. The
	 * accepted attempt may repeat its completion idempotently
	 * (`duplicate: true`, no state change); anything else is rejected.
	 */
	async complete(
		id: string,
		attemptId: string,
		leaseToken: string,
		result: Omit<JobResult, "completedAt">,
		now: number,
	): Promise<CompleteOutcome> {
		const job = await this.#job(id);
		if (!job) return { ok: false, code: "not_found" };
		if (job.status === "done" || job.status === "failed") {
			if (job.completedAttemptId === attemptId && job.completedLeaseToken === leaseToken) {
				return { ok: true, job, duplicate: true, retryScheduled: false };
			}
			return { ok: false, code: "stale" };
		}
		if (job.status !== "leased" && job.status !== "reconcile") return { ok: false, code: "not_leased" };
		if (!job.attemptId || !job.leaseToken || job.attemptId !== attemptId || job.leaseToken !== leaseToken) {
			return { ok: false, code: "fenced" };
		}
		if (!result.success && result.failureClass === "transient" && job.attempts < this.#limits.maxAttempts) {
			// Scheduled retry: this attempt ends, the job returns to pending
			// behind a backoff gate; no terminal result is recorded. A
			// duplicate submit of the same fence now reports not_leased —
			// the fence died with the attempt.
			const schedule = this.#limits.backoffScheduleMs;
			const delay = schedule[Math.min(job.attempts - 1, schedule.length - 1)] ?? 0;
			job.status = "pending";
			job.lastError = result.error;
			job.notBefore = new Date(now + delay).toISOString();
			job.attemptId = undefined;
			job.leaseToken = undefined;
			job.leasedAt = undefined;
			job.leasedBy = undefined;
			job.lastHeartbeatAt = undefined;
			job.leaseExpiresAt = undefined;
			job.reconcileAt = undefined;
			job.reconcileReason = undefined;
			await this.#saveJob(job);
			await this.#removeFromList(LEASED_KEY, id);
			await this.#removeFromList(RECONCILE_KEY, id);
			await this.#addToList(PENDING_KEY, id);
			return { ok: true, job, duplicate: false, retryScheduled: true };
		}
		job.status = result.success ? "done" : "failed";
		const exhausted = !result.success && result.failureClass === "transient";
		const error = exhausted
			? `${result.error ?? "transient failure"}; retry budget exhausted after ${job.attempts} attempt(s)`
			: result.error;
		job.result = { ...result, ...(error !== undefined ? { error } : {}), completedAt: new Date(now).toISOString() };
		job.completedAttemptId = attemptId;
		job.completedLeaseToken = leaseToken;
		job.leaseToken = undefined;
		job.leaseExpiresAt = undefined;
		job.reconcileAt = undefined;
		job.reconcileReason = undefined;
		job.notBefore = undefined;
		await this.#saveJob(job);
		await this.#removeFromList(LEASED_KEY, id);
		await this.#removeFromList(RECONCILE_KEY, id);
		await this.#storage.delete(issueKey(job.issueId));
		return { ok: true, job, duplicate: false, retryScheduled: false };
	}

	/**
	 * Resolve a reconcile-parked job after its runner's fate is known.
	 * When `attemptId`/`leaseToken` are provided they must match the parked
	 * attempt (runner self-report); admin resolution omits them. `requeue`
	 * re-queues while attempts remain and dead-letters on budget exhaustion;
	 * `requeue: false` fails the job outright.
	 */
	async resolveReconcile(
		id: string,
		opts: { requeue: boolean; reason: string; now: number; attemptId?: string; leaseToken?: string },
	): Promise<ReconcileOutcome> {
		const job = await this.#job(id);
		if (!job) return { ok: false, code: "not_found" };
		if (job.status !== "reconcile") return { ok: false, code: "not_reconcile" };
		if (opts.attemptId !== undefined || opts.leaseToken !== undefined) {
			if (job.attemptId !== opts.attemptId || job.leaseToken !== opts.leaseToken) {
				return { ok: false, code: "fenced" };
			}
		}
		return this.#resolveParked(job, opts.requeue, opts.reason, opts.now);
	}

	/**
	 * Resolve every reconcile-parked job owned by `runner` as terminated,
	 * requeueing each (or dead-lettering on budget exhaustion). Called when
	 * a runner restarts and attests it has no live children.
	 */
	async resolveReconcileByRunner(
		runner: string,
		reason: string,
		now: number,
	): Promise<Array<{ job: Job; disposition: ReconcileDisposition }>> {
		const resolved: Array<{ job: Job; disposition: ReconcileDisposition }> = [];
		for (const id of [...(await this.#ids(RECONCILE_KEY))]) {
			const job = await this.#job(id);
			if (job?.status !== "reconcile" || job.leasedBy !== runner) continue;
			const outcome = await this.#resolveParked(job, true, reason, now);
			if (outcome.ok) resolved.push({ job: outcome.job, disposition: outcome.disposition });
		}
		return resolved;
	}

	async #resolveParked(job: Job, requeue: boolean, reason: string, now: number): Promise<ReconcileOutcome> {
		await this.#removeFromList(RECONCILE_KEY, job.id);
		job.attemptId = undefined;
		job.leaseToken = undefined;
		job.leaseExpiresAt = undefined;
		job.lastHeartbeatAt = undefined;
		job.reconcileAt = undefined;
		job.reconcileReason = undefined;
		if (requeue && job.attempts < this.#limits.maxAttempts) {
			job.status = "pending";
			job.leasedAt = undefined;
			job.leasedBy = undefined;
			await this.#saveJob(job);
			await this.#addToList(PENDING_KEY, job.id);
			return { ok: true, job, disposition: "requeued" };
		}
		job.status = "failed";
		job.result = {
			success: false,
			output: "",
			error: requeue ? `${reason}; retry budget exhausted after ${job.attempts} attempt(s)` : reason,
			completedAt: new Date(now).toISOString(),
		};
		await this.#saveJob(job);
		await this.#storage.delete(issueKey(job.issueId));
		return { ok: true, job, disposition: requeue ? "dead_lettered" : "failed" };
	}

	async getJob(id: string): Promise<Job | null> {
		return (await this.#job(id)) ?? null;
	}

	async listJobs(limit = 50): Promise<Job[]> {
		const ids = [
			...(await this.#ids(PENDING_KEY)),
			...(await this.#ids(LEASED_KEY)),
			...(await this.#ids(RECONCILE_KEY)),
		];
		const jobs: Job[] = [];
		for (const id of ids.slice(0, limit)) {
			const job = await this.#job(id);
			if (job) jobs.push(job);
		}
		return jobs;
	}
}
