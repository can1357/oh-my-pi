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
 */

import type { Job, JobResult } from "./types";

export interface QueueStorage {
	get<T>(key: string): Promise<T | undefined>;
	put(key: string, value: unknown): Promise<void>;
	delete(key: string): Promise<void>;
}

export interface QueueLimits {
	/** Lease duration before a job becomes reclaimable. */
	leaseMs: number;
	/** Attempts (initial + re-leases) before a job dead-letters as failed. */
	maxAttempts: number;
}

export const DEFAULT_QUEUE_LIMITS: QueueLimits = {
	leaseMs: 30 * 60_000,
	maxAttempts: 5,
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
	| { ok: true; job: Job; duplicate: boolean }
	| { ok: false; code: "not_found" | "not_leased" | "fenced" | "stale" };

const PENDING_KEY = "queue:pending";
const LEASED_KEY = "queue:leased";

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

	constructor(storage: QueueStorage, limits: QueueLimits = DEFAULT_QUEUE_LIMITS) {
		this.#storage = storage;
		this.#limits = limits;
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

	/**
	 * Admit a job exactly once per dedupe key, with at most one active
	 * (pending/leased) job per issue.
	 */
	async admit(job: Job): Promise<AdmitOutcome> {
		const existingByDedupe = await this.#storage.get<{ jobId: string }>(dedupeStorageKey(job.dedupeKey));
		if (existingByDedupe) {
			return { accepted: false, reason: "duplicate", jobId: existingByDedupe.jobId };
		}
		const activeForIssue = await this.#storage.get<{ jobId: string }>(issueKey(job.issueId));
		if (activeForIssue) {
			const active = await this.#job(activeForIssue.jobId);
			if (active && (active.status === "pending" || active.status === "leased")) {
				return { accepted: false, reason: "active_job_exists", jobId: active.id };
			}
			await this.#storage.delete(issueKey(job.issueId));
		}
		await this.#saveJob(job);
		const pending = await this.#ids(PENDING_KEY);
		pending.push(job.id);
		await this.#storage.put(PENDING_KEY, pending);
		await this.#storage.put(dedupeStorageKey(job.dedupeKey), { jobId: job.id });
		await this.#storage.put(issueKey(job.issueId), { jobId: job.id });
		return { accepted: true, jobId: job.id };
	}

	/**
	 * Grant the next lease: expired leases are reclaimed first (re-lease or
	 * dead-letter on attempt exhaustion), then the oldest pending job.
	 */
	async lease(leasedBy: string, now: number): Promise<LeaseGrant | null> {
		const leased = await this.#ids(LEASED_KEY);
		for (const id of [...leased]) {
			const job = await this.#job(id);
			if (job?.status !== "leased") {
				await this.#storage.put(
					LEASED_KEY,
					(await this.#ids(LEASED_KEY)).filter(entry => entry !== id),
				);
				continue;
			}
			const expiresAt = job.leaseExpiresAt ? Date.parse(job.leaseExpiresAt) : 0;
			if (expiresAt > now) continue;
			if (job.attempts >= this.#limits.maxAttempts) {
				job.status = "failed";
				job.leaseToken = undefined;
				job.result = {
					success: false,
					output: "",
					error: `lease expired after ${job.attempts} attempt(s); retry budget exhausted`,
					completedAt: new Date(now).toISOString(),
				};
				await this.#saveJob(job);
				await this.#storage.delete(issueKey(job.issueId));
				await this.#storage.put(
					LEASED_KEY,
					(await this.#ids(LEASED_KEY)).filter(entry => entry !== id),
				);
				continue;
			}
			return this.#grant(job, leasedBy, now, false);
		}

		const pending = await this.#ids(PENDING_KEY);
		while (pending.length > 0) {
			const id = pending.shift();
			await this.#storage.put(PENDING_KEY, pending);
			if (!id) continue;
			const job = await this.#job(id);
			if (job?.status !== "pending") continue;
			return this.#grant(job, leasedBy, now, true);
		}
		return null;
	}

	async #grant(job: Job, leasedBy: string, now: number, addToLeased: boolean): Promise<LeaseGrant> {
		job.status = "leased";
		job.attempts += 1;
		job.attemptId = crypto.randomUUID();
		job.leaseToken = crypto.randomUUID();
		job.leasedAt = new Date(now).toISOString();
		job.leaseExpiresAt = new Date(now + this.#limits.leaseMs).toISOString();
		job.leasedBy = leasedBy;
		await this.#saveJob(job);
		if (addToLeased) {
			const leased = await this.#ids(LEASED_KEY);
			if (!leased.includes(job.id)) {
				leased.push(job.id);
				await this.#storage.put(LEASED_KEY, leased);
			}
		}
		return { job, attemptId: job.attemptId, leaseToken: job.leaseToken };
	}

	/**
	 * Fenced completion: only the current lease holder may complete. The
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
				return { ok: true, job, duplicate: true };
			}
			return { ok: false, code: "stale" };
		}
		if (job.status !== "leased") return { ok: false, code: "not_leased" };
		if (!job.attemptId || !job.leaseToken || job.attemptId !== attemptId || job.leaseToken !== leaseToken) {
			return { ok: false, code: "fenced" };
		}
		job.status = result.success ? "done" : "failed";
		job.result = { ...result, completedAt: new Date(now).toISOString() };
		job.completedAttemptId = attemptId;
		job.completedLeaseToken = leaseToken;
		job.leaseToken = undefined;
		job.leaseExpiresAt = undefined;
		await this.#saveJob(job);
		await this.#storage.put(
			LEASED_KEY,
			(await this.#ids(LEASED_KEY)).filter(entry => entry !== id),
		);
		await this.#storage.delete(issueKey(job.issueId));
		return { ok: true, job, duplicate: false };
	}

	async getJob(id: string): Promise<Job | null> {
		return (await this.#job(id)) ?? null;
	}

	async listJobs(limit = 50): Promise<Job[]> {
		const ids = [...(await this.#ids(PENDING_KEY)), ...(await this.#ids(LEASED_KEY))];
		const jobs: Job[] = [];
		for (const id of ids.slice(0, limit)) {
			const job = await this.#job(id);
			if (job) jobs.push(job);
		}
		return jobs;
	}
}
