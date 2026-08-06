/**
 * Durable Object wrapper around {@link QueueCore}.
 *
 * A single named instance ("default") owns all queue state. Every public
 * RPC method runs inside `blockConcurrencyWhile`, so admission, leasing,
 * heartbeats, and completion are serialized: no other event is delivered
 * while a read-modify-write sequence is in flight, which is the atomicity
 * KV could not provide.
 *
 * A storage alarm is armed to the earliest lease liveness deadline, so
 * silent runners are parked in `reconcile` (and surfaced to Linear) even
 * when no relay is polling. The alarm posts the reconcile notice itself;
 * the /poll path posts through injected worker deps. Both paths transition
 * through the same serialized sweep, so each job is reported exactly once.
 */

import { DurableObject } from "cloudflare:workers";
import { createConfiguredInstallationToken, postGitHubComment } from "./github";
import { postComment, reconcileComment } from "./linear";
import {
	type AdmitOutcome,
	type CompleteOutcome,
	type HeartbeatOutcome,
	type LeaseGrant,
	QueueCore,
	type QueueStorage,
	type ReconcileDisposition,
	type ReconcileOutcome,
	type SweepResult,
} from "./queue-core";
import type { Env, Job, JobResult } from "./types";

class DurableStorageAdapter implements QueueStorage {
	constructor(private readonly storage: DurableObjectStorage) {}

	async get<T>(key: string): Promise<T | undefined> {
		return this.storage.get<T>(key);
	}

	async put(key: string, value: unknown): Promise<void> {
		await this.storage.put(key, value);
	}

	async delete(key: string): Promise<void> {
		await this.storage.delete(key);
	}
}

export class JobQueue extends DurableObject<Env> {
	readonly #core: QueueCore;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.#core = new QueueCore(new DurableStorageAdapter(ctx.storage));
	}

	/** Re-arm the storage alarm to the earliest lease liveness deadline. */
	async #armAlarm(): Promise<void> {
		const next = await this.#core.nextDeadline();
		if (next === null) await this.ctx.storage.deleteAlarm();
		else await this.ctx.storage.setAlarm(next);
	}

	async admit(job: Job): Promise<AdmitOutcome> {
		return this.ctx.blockConcurrencyWhile(() => this.#core.admit(job));
	}

	async lease(leasedBy: string): Promise<LeaseGrant | null> {
		return this.ctx.blockConcurrencyWhile(async () => {
			const grant = await this.#core.lease(leasedBy, Date.now());
			if (grant) await this.#armAlarm();
			return grant;
		});
	}

	async heartbeat(id: string, attemptId: string, leaseToken: string): Promise<HeartbeatOutcome> {
		return this.ctx.blockConcurrencyWhile(async () => {
			const outcome = await this.#core.heartbeat(id, attemptId, leaseToken, Date.now());
			if (outcome.ok) await this.#armAlarm();
			return outcome;
		});
	}

	async sweep(): Promise<SweepResult> {
		return this.ctx.blockConcurrencyWhile(async () => {
			const result = await this.#core.sweep(Date.now());
			await this.#armAlarm();
			return result;
		});
	}

	async resolveReconcile(
		id: string,
		opts: { requeue: boolean; reason: string; attemptId?: string; leaseToken?: string },
	): Promise<ReconcileOutcome> {
		return this.ctx.blockConcurrencyWhile(() => this.#core.resolveReconcile(id, { ...opts, now: Date.now() }));
	}

	async resolveReconcileByRunner(
		runner: string,
		reason: string,
	): Promise<Array<{ job: Job; disposition: ReconcileDisposition }>> {
		return this.ctx.blockConcurrencyWhile(() => this.#core.resolveReconcileByRunner(runner, reason, Date.now()));
	}

	async refreshPrompt(
		issueId: string,
		prompt: string,
		dedupeKey: string,
	): Promise<
		{ ok: true; job: Job; applied: "immediate" | "staged" } | { ok: false; code: "no_active_job" | "duplicate" }
	> {
		return this.ctx.blockConcurrencyWhile(() => this.#core.refreshPrompt(issueId, prompt, dedupeKey));
	}

	async checkFence(id: string, attemptId: string, leaseToken: string): Promise<{ valid: boolean }> {
		return this.ctx.blockConcurrencyWhile(() => this.#core.checkFence(id, attemptId, leaseToken));
	}

	async complete(
		id: string,
		attemptId: string,
		leaseToken: string,
		result: Omit<JobResult, "completedAt">,
	): Promise<CompleteOutcome> {
		return this.ctx.blockConcurrencyWhile(() => this.#core.complete(id, attemptId, leaseToken, result, Date.now()));
	}

	async getJob(id: string): Promise<Job | null> {
		return this.ctx.blockConcurrencyWhile(() => this.#core.getJob(id));
	}

	async listJobs(): Promise<Job[]> {
		return this.ctx.blockConcurrencyWhile(() => this.#core.listJobs());
	}

	/**
	 * Liveness deadline reached: park silent leases in reconcile, re-arm,
	 * then mirror each transition to Linear. Comments run outside the
	 * serialization gate and are best-effort — the parked state itself is
	 * authoritative and visible via /status regardless.
	 */
	async alarm(): Promise<void> {
		const { reconciled } = await this.ctx.blockConcurrencyWhile(async () => {
			const result = await this.#core.sweep(Date.now());
			await this.#armAlarm();
			return result;
		});
		for (const job of reconciled) {
			try {
				if (job.source === "github" && job.github) {
					const token = await createConfiguredInstallationToken(this.env, job.github.installationId);
					await postGitHubComment(
						token.token,
						job.github.owner,
						job.github.repo,
						job.github.number,
						reconcileComment(job),
					);
				} else {
					await postComment(this.env.LINEAR_API_TOKEN, job.issueId, reconcileComment(job));
				}
			} catch (err) {
				console.error(
					`reconcile comment failed for ${job.issueIdentifier}:`,
					err instanceof Error ? err.message : err,
				);
			}
		}
	}
}
