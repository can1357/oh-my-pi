import { describe, expect, it } from "bun:test";
import { QueueCore, type QueueStorage } from "../src/queue-core";
import type { Job } from "../src/types";

/**
 * In-memory QueueStorage. The Durable Object serializes every public op via
 * `blockConcurrencyWhile`; these tests exercise the state-transition contract
 * the core must uphold under that serialization: no lost jobs, single active
 * lease, fenced completion, idempotent duplicates, and liveness handling —
 * a silent lease parks in `reconcile` and is never re-granted directly.
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

	it("retains the issue claim while a job is parked in reconcile", async () => {
		const core = new QueueCore(new MemoryStorage(), { leaseMs: 100 });
		const job = makeJob({ issueId: "issue-parked" });
		await core.admit(job);
		await core.lease("relay-1", T0);
		await core.sweep(T0 + 101);
		expect((await core.getJob(job.id))?.status).toBe("reconcile");

		const during = await core.admit(makeJob({ issueId: "issue-parked" }));
		expect(during).toEqual({ accepted: false, reason: "active_job_exists", jobId: job.id });
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

	it("fences a superseded attempt out after park, resolve, and re-grant", async () => {
		const core = new QueueCore(new MemoryStorage(), { leaseMs: 100, maxAttempts: 5 });
		const job = makeJob();
		await core.admit(job);
		const stale = await core.lease("relay-1", T0);
		// The lease goes silent; it parks in reconcile and is NOT re-granted.
		await core.sweep(T0 + 101);
		expect(await core.lease("relay-2", T0 + 102)).toBeNull();
		// Termination is confirmed; the job requeues and relay-2 takes attempt 2.
		const resolved = await core.resolveReconcile(job.id, {
			requeue: true,
			reason: "runner terminated",
			now: T0 + 110,
		});
		expect(resolved).toMatchObject({ ok: true, disposition: "requeued" });
		const fresh = await core.lease("relay-2", T0 + 120);
		expect(fresh?.job.id).toBe(job.id);
		expect(fresh?.job.attempts).toBe(2);
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
		await core.sweep(T0 + 101);
		await core.resolveReconcile(job.id, { requeue: true, reason: "terminated", now: T0 + 105 });
		const fresh = await core.lease("relay-2", T0 + 110);
		await core.complete(job.id, fresh!.attemptId, fresh!.leaseToken, { success: true, output: "kept" }, T0 + 120);

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

describe("heartbeats", () => {
	it("re-arms the lease so a beating runner is never parked", async () => {
		const core = new QueueCore(new MemoryStorage(), { leaseMs: 100 });
		const job = makeJob();
		await core.admit(job);
		const grant = await core.lease("relay-1", T0);

		const beat = await core.heartbeat(job.id, grant!.attemptId, grant!.leaseToken, T0 + 80);
		expect(beat).toMatchObject({ ok: true, restored: false });

		// Past the original expiry (T0+100) but inside the re-armed window.
		expect((await core.sweep(T0 + 150)).reconciled).toHaveLength(0);
		expect((await core.getJob(job.id))?.status).toBe("leased");

		// Silence after the last beat eventually parks it.
		expect((await core.sweep(T0 + 181)).reconciled.map(j => j.id)).toEqual([job.id]);
	});

	it("parks a lease after two missed heartbeats even before lease expiry", async () => {
		const core = new QueueCore(new MemoryStorage(), { leaseMs: 10_000, heartbeatMs: 100 });
		const job = makeJob();
		await core.admit(job);
		await core.lease("relay-1", T0);

		expect((await core.sweep(T0 + 150)).reconciled).toHaveLength(0);
		const swept = await core.sweep(T0 + 201);
		expect(swept.reconciled.map(j => j.id)).toEqual([job.id]);
		const parked = await core.getJob(job.id);
		expect(parked?.status).toBe("reconcile");
		expect(parked?.reconcileReason).toContain("no heartbeat");
	});

	it("rejects unfenced, unknown, and unleased heartbeats", async () => {
		const core = new QueueCore(new MemoryStorage());
		const job = makeJob();
		await core.admit(job);
		expect(await core.heartbeat(job.id, "a", "t", T0)).toEqual({ ok: false, code: "not_leased" });
		expect(await core.heartbeat("missing", "a", "t", T0)).toEqual({ ok: false, code: "not_found" });
		const grant = await core.lease("relay-1", T0);
		expect(await core.heartbeat(job.id, grant!.attemptId, "forged", T0 + 1)).toEqual({ ok: false, code: "fenced" });
	});

	it("restores a parked job on a fenced beat and lets it complete normally", async () => {
		const core = new QueueCore(new MemoryStorage(), { leaseMs: 100 });
		const job = makeJob();
		await core.admit(job);
		const grant = await core.lease("relay-1", T0);
		await core.sweep(T0 + 101);
		expect((await core.getJob(job.id))?.status).toBe("reconcile");

		const beat = await core.heartbeat(job.id, grant!.attemptId, grant!.leaseToken, T0 + 120);
		expect(beat).toMatchObject({ ok: true, restored: true });
		expect((await core.getJob(job.id))?.status).toBe("leased");
		// Restored means live: later sweeps inside the window leave it alone.
		expect((await core.sweep(T0 + 150)).reconciled).toHaveLength(0);

		const done = await core.complete(job.id, grant!.attemptId, grant!.leaseToken, { success: true, output: "ok" }, T0 + 160);
		expect(done).toMatchObject({ ok: true, duplicate: false });
	});
});

describe("reconcile resolution", () => {
	it("accepts a late fenced completion from a parked job and releases the claim", async () => {
		const core = new QueueCore(new MemoryStorage(), { leaseMs: 100 });
		const job = makeJob({ issueId: "issue-late" });
		await core.admit(job);
		const grant = await core.lease("relay-1", T0);
		await core.sweep(T0 + 101);

		const late = await core.complete(
			job.id,
			grant!.attemptId,
			grant!.leaseToken,
			{ success: true, output: "finished after all" },
			T0 + 200,
		);
		expect(late).toMatchObject({ ok: true, duplicate: false });
		expect((await core.getJob(job.id))?.status).toBe("done");
		expect((await core.admit(makeJob({ issueId: "issue-late" }))).accepted).toBe(true);
	});

	it("requeues preserving the attempt count and dead-letters on budget exhaustion", async () => {
		const core = new QueueCore(new MemoryStorage(), { leaseMs: 100, maxAttempts: 2 });
		const job = makeJob({ issueId: "issue-budget" });
		await core.admit(job);
		await core.lease("relay-1", T0);
		await core.sweep(T0 + 101);
		const first = await core.resolveReconcile(job.id, { requeue: true, reason: "terminated", now: T0 + 110 });
		expect(first).toMatchObject({ ok: true, disposition: "requeued" });
		expect((await core.getJob(job.id))?.attempts).toBe(1);

		await core.lease("relay-1", T0 + 120);
		await core.sweep(T0 + 300);
		const second = await core.resolveReconcile(job.id, { requeue: true, reason: "terminated again", now: T0 + 310 });
		expect(second).toMatchObject({ ok: true, disposition: "dead_lettered" });
		const dead = await core.getJob(job.id);
		expect(dead?.status).toBe("failed");
		expect(dead?.result?.error).toContain("retry budget exhausted");
		expect((await core.admit(makeJob({ issueId: "issue-budget" }))).accepted).toBe(true);
	});

	it("fails a job outright on explicit terminate", async () => {
		const core = new QueueCore(new MemoryStorage(), { leaseMs: 100 });
		const job = makeJob();
		await core.admit(job);
		await core.lease("relay-1", T0);
		await core.sweep(T0 + 101);
		const outcome = await core.resolveReconcile(job.id, {
			requeue: false,
			reason: "operator terminated the VM",
			now: T0 + 110,
		});
		expect(outcome).toMatchObject({ ok: true, disposition: "failed" });
		expect((await core.getJob(job.id))?.result?.error).toBe("operator terminated the VM");
	});

	it("rejects resolution with a mismatched fence or wrong state", async () => {
		const core = new QueueCore(new MemoryStorage(), { leaseMs: 100 });
		const job = makeJob();
		await core.admit(job);
		const grant = await core.lease("relay-1", T0);
		expect(
			await core.resolveReconcile(job.id, { requeue: true, reason: "r", now: T0 + 10 }),
		).toEqual({ ok: false, code: "not_reconcile" });

		await core.sweep(T0 + 101);
		expect(
			await core.resolveReconcile(job.id, {
				requeue: true,
				reason: "r",
				now: T0 + 110,
				attemptId: grant!.attemptId,
				leaseToken: "forged",
			}),
		).toEqual({ ok: false, code: "fenced" });
		expect((await core.getJob(job.id))?.status).toBe("reconcile");
	});

	it("resolves by runner only for that runner's parked jobs", async () => {
		const core = new QueueCore(new MemoryStorage(), { leaseMs: 100 });
		const mine = makeJob();
		const theirs = makeJob();
		await core.admit(mine);
		await core.admit(theirs);
		await core.lease("relay-1", T0);
		await core.lease("relay-2", T0);
		await core.sweep(T0 + 101);

		const resolved = await core.resolveReconcileByRunner("relay-1", "relay-1 restarted", T0 + 110);
		expect(resolved.map(r => r.job.id)).toEqual([mine.id]);
		expect(resolved[0]!.disposition).toBe("requeued");
		expect((await core.getJob(mine.id))?.status).toBe("pending");
		expect((await core.getJob(theirs.id))?.status).toBe("reconcile");
	});
});

describe("retry classification and backoff", () => {
	it("schedules transient failures behind the backoff gate without starving FIFO", async () => {
		const core = new QueueCore(new MemoryStorage(), { maxAttempts: 3, backoffScheduleMs: [100, 200] });
		const flaky = makeJob();
		const steady = makeJob();
		await core.admit(flaky);
		await core.admit(steady);
		const grant = await core.lease("relay-1", T0);
		const outcome = await core.complete(
			flaky.id,
			grant!.attemptId,
			grant!.leaseToken,
			{ success: false, output: "", error: "socket hang up", failureClass: "transient" },
			T0 + 10,
		);
		expect(outcome).toMatchObject({ ok: true, retryScheduled: true });
		const parked = await core.getJob(flaky.id);
		expect(parked?.status).toBe("pending");
		expect(parked?.notBefore).toBe(new Date(T0 + 110).toISOString());
		expect(parked?.lastError).toBe("socket hang up");

		// The gated retry does not starve later arrivals.
		const next = await core.lease("relay-1", T0 + 20);
		expect(next?.job.id).toBe(steady.id);
		// Closed gate: nothing grantable.
		expect(await core.lease("relay-2", T0 + 50)).toBeNull();
		// Open gate: fresh fence, attempt 2, gate cleared.
		const retry = await core.lease("relay-2", T0 + 111);
		expect(retry?.job.id).toBe(flaky.id);
		expect(retry?.job.attempts).toBe(2);
		expect(retry?.job.notBefore).toBeUndefined();
		// The second transient failure takes the next backoff step.
		await core.complete(
			flaky.id,
			retry!.attemptId,
			retry!.leaseToken,
			{ success: false, output: "", error: "reset", failureClass: "transient" },
			T0 + 120,
		);
		expect((await core.getJob(flaky.id))?.notBefore).toBe(new Date(T0 + 320).toISOString());
	});

	it("dead-letters a transient failure once the attempt budget is exhausted", async () => {
		const core = new QueueCore(new MemoryStorage(), { maxAttempts: 2, backoffScheduleMs: [10] });
		const job = makeJob({ issueId: "issue-flaky" });
		await core.admit(job);
		const first = await core.lease("relay-1", T0);
		await core.complete(
			job.id,
			first!.attemptId,
			first!.leaseToken,
			{ success: false, output: "", error: "timeout", failureClass: "transient" },
			T0 + 5,
		);
		const second = await core.lease("relay-1", T0 + 100);
		const final = await core.complete(
			job.id,
			second!.attemptId,
			second!.leaseToken,
			{ success: false, output: "", error: "timeout again", failureClass: "transient" },
			T0 + 200,
		);
		expect(final).toMatchObject({ ok: true, duplicate: false, retryScheduled: false });
		const dead = await core.getJob(job.id);
		expect(dead?.status).toBe("failed");
		expect(dead?.result?.error).toBe("timeout again; retry budget exhausted after 2 attempt(s)");
		expect((await core.admit(makeJob({ issueId: "issue-flaky" }))).accepted).toBe(true);
	});

	it("keeps permanent and unclassified failures terminal with budget remaining", async () => {
		const core = new QueueCore(new MemoryStorage(), { maxAttempts: 5 });
		for (const failureClass of ["permanent", undefined] as const) {
			const job = makeJob();
			await core.admit(job);
			const grant = await core.lease("relay-1", T0);
			const outcome = await core.complete(
				job.id,
				grant!.attemptId,
				grant!.leaseToken,
				{ success: false, output: "", error: "verification failed", ...(failureClass ? { failureClass } : {}) },
				T0 + 1,
			);
			expect(outcome).toMatchObject({ ok: true, retryScheduled: false });
			const terminal = await core.getJob(job.id);
			expect(terminal?.status).toBe("failed");
			expect(terminal?.result?.error).toBe("verification failed");
		}
	});

	it("rejects a duplicate submit of a retried attempt", async () => {
		const core = new QueueCore(new MemoryStorage(), { backoffScheduleMs: [1_000] });
		const job = makeJob();
		await core.admit(job);
		const grant = await core.lease("relay-1", T0);
		await core.complete(
			job.id,
			grant!.attemptId,
			grant!.leaseToken,
			{ success: false, output: "", failureClass: "transient" },
			T0 + 1,
		);
		const dupe = await core.complete(
			job.id,
			grant!.attemptId,
			grant!.leaseToken,
			{ success: false, output: "", failureClass: "transient" },
			T0 + 2,
		);
		expect(dupe).toEqual({ ok: false, code: "not_leased" });
	});
});

describe("attempt identity and fence introspection", () => {
	it("stamps a logical attempt key per grant, with an unknown-org fallback", async () => {
		const core = new QueueCore(new MemoryStorage(), { backoffScheduleMs: [10] });
		const job = makeJob({ organizationId: "org-9" });
		const anon = makeJob();
		await core.admit(job);
		await core.admit(anon);

		const first = await core.lease("relay-1", T0);
		expect(first?.job.logicalAttemptKey).toBe(`linear:org-9:${job.issueId}:1`);
		const second = await core.lease("relay-1", T0);
		expect(second?.job.logicalAttemptKey).toBe(`linear:unknown:${anon.issueId}:1`);

		// The key advances with the attempt counter on re-grant.
		await core.complete(job.id, first!.attemptId, first!.leaseToken, {
			success: false,
			output: "",
			failureClass: "transient",
		}, T0 + 1);
		const retry = await core.lease("relay-2", T0 + 100);
		expect(retry?.job.logicalAttemptKey).toBe(`linear:org-9:${job.issueId}:2`);
	});

	it("treats a reconcile-parked fence as current and terminal fences as invalid", async () => {
		const core = new QueueCore(new MemoryStorage(), { leaseMs: 100 });
		const job = makeJob();
		await core.admit(job);
		const grant = await core.lease("relay-1", T0);

		expect(await core.checkFence(job.id, grant!.attemptId, grant!.leaseToken)).toEqual({ valid: true });
		expect(await core.checkFence(job.id, grant!.attemptId, "forged")).toEqual({ valid: false });
		expect(await core.checkFence("missing", "a", "t")).toEqual({ valid: false });

		// Parked in reconcile: the original runner still holds the current
		// attempt, so its branch pushes remain legitimate.
		await core.sweep(T0 + 101);
		expect(await core.checkFence(job.id, grant!.attemptId, grant!.leaseToken)).toEqual({ valid: true });

		// Terminal: nothing may push under this job's identity.
		await core.complete(job.id, grant!.attemptId, grant!.leaseToken, { success: true, output: "ok" }, T0 + 120);
		expect(await core.checkFence(job.id, grant!.attemptId, grant!.leaseToken)).toEqual({ valid: false });
	});

	it("latest revision wins when refreshes stack up while in flight", async () => {
		const core = new QueueCore(new MemoryStorage(), { backoffScheduleMs: [10] });
		const job = makeJob();
		await core.admit(job);
		const grant = await core.lease("relay-1", T0);

		expect(await core.refreshPrompt(job.issueId, "revision A", "d-1")).toMatchObject({ ok: true, applied: "staged" });
		expect(await core.refreshPrompt(job.issueId, "revision B", "d-2")).toMatchObject({ ok: true, applied: "staged" });
		expect(await core.refreshPrompt(job.issueId, "revision B again", "d-2")).toEqual({ ok: false, code: "duplicate" });

		await core.complete(job.id, grant!.attemptId, grant!.leaseToken, {
			success: false,
			output: "",
			failureClass: "transient",
		}, T0 + 1);
		const regrant = await core.lease("relay-1", T0 + 100);
		expect(regrant?.job.prompt).toBe("revision B");

		// Terminal job: refresh reports no active job.
		await core.complete(job.id, regrant!.attemptId, regrant!.leaseToken, { success: true, output: "done" }, T0 + 200);
		expect(await core.refreshPrompt(job.issueId, "too late", "d-3")).toEqual({ ok: false, code: "no_active_job" });
	});
});
