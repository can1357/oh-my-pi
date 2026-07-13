/**
 * Durable Object wrapper around {@link QueueCore}.
 *
 * A single named instance ("default") owns all queue state. Every public
 * RPC method runs inside `blockConcurrencyWhile`, so admission, leasing,
 * and completion are serialized: no other event is delivered while a
 * read-modify-write sequence is in flight, which is the atomicity KV could
 * not provide.
 */

import { DurableObject } from "cloudflare:workers";
import { type AdmitOutcome, type CompleteOutcome, type LeaseGrant, QueueCore, type QueueStorage } from "./queue-core";
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

	async admit(job: Job): Promise<AdmitOutcome> {
		return this.ctx.blockConcurrencyWhile(() => this.#core.admit(job));
	}

	async lease(leasedBy: string): Promise<LeaseGrant | null> {
		return this.ctx.blockConcurrencyWhile(() => this.#core.lease(leasedBy, Date.now()));
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
}
