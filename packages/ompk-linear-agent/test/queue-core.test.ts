import { describe, expect, it } from "bun:test";
import { QueueCore, type QueueStorage } from "../src/queue-core";
import type { Job } from "../src/types";

/**
 * In-memory QueueStorage. The Durable Object serializes every public op via
 * `blockConcurrencyWhile`; these tests exercise the state-transition contract
 * the core must uphold under that serialization: no lost jobs, single active
 * lease, fenced completion, idempotent duplicates, deterministic expiry.
 */
class MemoryStorage implements QueueStorage {
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

let jobCounter = 0;
function makeJob(overrides: Partial<Job> = {}): Job {
	jobCounter += 1;
	return {
		id: `job-${jobCounter}`,
		issueId: `issue-${jobCounter}`,
		issueIdentifier: `OMP-${jobCounter}`,
		model: "combo-a",
		prompt: "title\n\nbody",
		status: "pending",
		createdAt: new Date(0).toISOString(),
		dedupeKey: `delivery-${jobCounter}:issue-${jobCounter}:rev-1`,
		attempts: 0,
		...overrides,
	};
}

const T0 = 1_000_000;

describe("queue admission", () => {
	it("keeps every admitted job and preserves FIFO order", async () => {
		const core = new QueueCore(new MemoryStorage());
		const first = makeJob();
		const second = makeJob();
		expect((await core.admit(first)).accepted).toBe(true);
		expect((await core.admit(second)).accepted).toBe(true);

		const listed = await core.listJobs();
		expect(listed.map(job => job.id)).toEqual([first.id, second.id]);

		const leaseA = await core.lease("relay-1", T0);
		const leaseB = await core.lease("relay-1", T0);
		expect(leaseA?.job.id).toBe(first.id);
		expect(leaseB?.job.id).toBe(second.id);
	});

	it("rejects a replayed dedupe key and reports the original job id", async () => {
		const core = new QueueCore(new MemoryStorage());
		const original = makeJob({ dedupeKey: "delivery-x:issue-x:rev-1" });
		await core.admit(original);
		const replay = makeJob({ issueId: original.issueId, dedupeKey: "delivery-x:issue-x:rev-1" });
		const outcome = await core.admit(replay);
		expect(outcome).toEqual({ accepted: false, reason: "duplicate", jobId: original.id });
	});

	it("rejects a second active job for the same issue and allows one after completion", async () => {
		const core = new QueueCore(new MemoryStorage());
		const first = makeJob({ issueId: "issue-same" });
		await core.admit(first);
		const whileActive = await core.admit(makeJob({ issueId: "issue-same" }));
		expect(whileActive).toEqual({ accepted: false, reason: "active_job_exists", jobId: first.id });

		const grant = await core.lease("relay-1", T0);
		expect(grant).not.toBeNull();
		await core.complete(first.id, grant!.attemptId, grant!.leaseToken, { success: true, output: "ok" }, T0 + 1);

		const afterDone = await core.admit(makeJob({ issueId: "issue-same" }));
		expect(afterDone.accepted).toBe(true);
	});
});

describe("lease fencing", () => {
	it("never leases the same job to two relays while the lease is live", async () => {
		const core = new QueueCore(new MemoryStorage());
		const job = makeJob();
		await core.admit(job);
		const first = await core.lease("relay-1", T0);
		const second = await core.lease("relay-2", T0);
		expect(first?.job.id).toBe(job.id);
		expect(second).toBeNull();
	});

	it("rejects completion with an invalid token", async () => {
		const core = new QueueCore(new MemoryStorage());
		const job = makeJob();
		await core.admit(job);
		const grant = await core.lease("relay-1", T0);
		const outcome = await core.complete(job.id, grant!.attemptId, "forged-token", { success: true, output: "x" }, T0);
		expect(outcome).toEqual({ ok: false, code: "fenced" });
		expect((await core.getJob(job.id))?.status).toBe("leased");
	});

	it("fences a stale lease out of completing a newer attempt", async () => {
		const core = new QueueCore(new MemoryStorage(), { leaseMs: 100, maxAttempts: 5 });
		const job = makeJob();
		await core.admit(job);
		const stale = await core.lease("relay-1", T0);
		// Lease expires; a second relay picks the job up as a new attempt.
		const fresh = await core.lease("relay-2", T0 + 101);
		expect(fresh?.job.id).toBe(job.id);
		expect(fresh?.leaseToken).not.toBe(stale?.leaseToken);

		const staleOutcome = await core.complete(
			job.id,
			stale!.attemptId,
			stale!.leaseToken,
			{ success: true, output: "stale result" },
			T0 + 150,
		);
		expect(staleOutcome).toEqual({ ok: false, code: "fenced" });

		const freshOutcome = await core.complete(
			job.id,
			fresh!.attemptId,
			fresh!.leaseToken,
			{ success: true, output: "fresh result" },
			T0 + 160,
		);
		expect(freshOutcome.ok).toBe(true);
		expect((await core.getJob(job.id))?.result?.output).toBe("fresh result");
	});

	it("cannot complete a terminal job from a superseded attempt", async () => {
		const core = new QueueCore(new MemoryStorage(), { leaseMs: 100, maxAttempts: 5 });
		const job = makeJob();
		await core.admit(job);
		const stale = await core.lease("relay-1", T0);
		const fresh = await core.lease("relay-2", T0 + 101);
		await core.complete(job.id, fresh!.attemptId, fresh!.leaseToken, { success: true, output: "kept" }, T0 + 110);

		const lateStale = await core.complete(
			job.id,
			stale!.attemptId,
			stale!.leaseToken,
			{ success: false, output: "", error: "late" },
			T0 + 200,
		);
		expect(lateStale).toEqual({ ok: false, code: "stale" });
		expect((await core.getJob(job.id))?.result?.output).toBe("kept");
	});
});

describe("idempotent completion", () => {
	it("acknowledges duplicate completion of the accepted attempt without mutating state", async () => {
		const core = new QueueCore(new MemoryStorage());
		const job = makeJob();
		await core.admit(job);
		const grant = await core.lease("relay-1", T0);
		const first = await core.complete(
			job.id,
			grant!.attemptId,
			grant!.leaseToken,
			{ success: true, output: "one" },
			T0,
		);
		expect(first).toMatchObject({ ok: true, duplicate: false });
		const firstCompletedAt = (await core.getJob(job.id))?.result?.completedAt;

		const second = await core.complete(
			job.id,
			grant!.attemptId,
			grant!.leaseToken,
			{ success: true, output: "one" },
			T0 + 5_000,
		);
		expect(second).toMatchObject({ ok: true, duplicate: true });
		expect((await core.getJob(job.id))?.result?.completedAt).toBe(firstCompletedAt);
	});

	it("returns not_found for unknown jobs", async () => {
		const core = new QueueCore(new MemoryStorage());
		expect(await core.complete("missing", "a", "t", { success: true, output: "" }, T0)).toEqual({
			ok: false,
			code: "not_found",
		});
	});
});

describe("lease expiry and retry budget", () => {
	it("re-leases an expired job with a fresh attempt while budget remains", async () => {
		const core = new QueueCore(new MemoryStorage(), { leaseMs: 100, maxAttempts: 3 });
		const job = makeJob();
		await core.admit(job);
		const first = await core.lease("relay-1", T0);
		expect(first?.job.attempts).toBe(1);
		const second = await core.lease("relay-1", T0 + 101);
		expect(second?.job.id).toBe(job.id);
		expect(second?.job.attempts).toBe(2);
	});

	it("dead-letters a job when the retry budget is exhausted", async () => {
		const core = new QueueCore(new MemoryStorage(), { leaseMs: 100, maxAttempts: 1 });
		const job = makeJob();
		await core.admit(job);
		await core.lease("relay-1", T0);
		// Budget is spent; the expired lease is dead-lettered instead of re-leased.
		expect(await core.lease("relay-1", T0 + 101)).toBeNull();
		const dead = await core.getJob(job.id);
		expect(dead?.status).toBe("failed");
		expect(dead?.result?.error).toContain("retry budget exhausted");
	});
});
