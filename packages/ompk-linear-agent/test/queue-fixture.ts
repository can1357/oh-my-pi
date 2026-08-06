import { QueueCore, type QueueStorage } from "../src/queue-core";
import type { Job, JobResult } from "../src/types";
import type { JobQueueStub } from "../src/worker";

export class MemoryStorage implements QueueStorage {
	readonly #data = new Map<string, unknown>();

	async get<T>(key: string): Promise<T | undefined> {
		return this.#data.get(key) as T | undefined;
	}

	async put(key: string, value: unknown): Promise<void> {
		this.#data.set(key, structuredClone(value));
	}

	async delete(key: string): Promise<void> {
		this.#data.delete(key);
	}
}

/** Fake stub running the REAL queue core, so endpoint tests exercise production queue semantics. */
export class FakeQueueStub implements JobQueueStub {
	readonly core = new QueueCore(new MemoryStorage());
	/** Simulated clock skew so endpoint tests can trigger liveness parking. */
	nowOffsetMs = 0;

	#now(): number {
		return Date.now() + this.nowOffsetMs;
	}

	async admit(job: Job) {
		return this.core.admit(job);
	}

	async lease(leasedBy: string) {
		return this.core.lease(leasedBy, this.#now());
	}

	async complete(id: string, attemptId: string, leaseToken: string, result: Omit<JobResult, "completedAt">) {
		return this.core.complete(id, attemptId, leaseToken, result, this.#now());
	}

	async heartbeat(id: string, attemptId: string, leaseToken: string) {
		return this.core.heartbeat(id, attemptId, leaseToken, this.#now());
	}

	async sweep() {
		return this.core.sweep(this.#now());
	}

	async resolveReconcile(
		id: string,
		opts: { requeue: boolean; reason: string; attemptId?: string; leaseToken?: string },
	) {
		return this.core.resolveReconcile(id, { ...opts, now: this.#now() });
	}

	async resolveReconcileByRunner(runner: string, reason: string) {
		return this.core.resolveReconcileByRunner(runner, reason, this.#now());
	}

	async getJob(id: string) {
		return this.core.getJob(id);
	}

	async listJobs() {
		return this.core.listJobs();
	}

	async refreshPrompt(issueId: string, prompt: string, dedupeKey: string) {
		return this.core.refreshPrompt(issueId, prompt, dedupeKey);
	}

	async checkFence(id: string, attemptId: string, leaseToken: string) {
		return this.core.checkFence(id, attemptId, leaseToken);
	}
}
