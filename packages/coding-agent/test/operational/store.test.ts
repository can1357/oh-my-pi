import { afterEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { TempDir } from "@pk-nerdsaver-ai/pi-utils";
import {
	capJsonPayload,
	DEFAULT_MAX_EVENT_PAYLOAD_BYTES,
	type JsonValue,
	OperationalStore,
	serializeJsonValue,
} from "../../src/operational";

class TestClock {
	#now: number;
	constructor(start: number) {
		this.#now = start;
	}
	now = (): number => this.#now;
	set(value: number): void {
		this.#now = value;
	}
	advance(ms: number): void {
		this.#now += ms;
	}
}

class TestIds {
	#n = 0;
	next = (): string => {
		this.#n += 1;
		return `id-${this.#n}`;
	};
}

describe("OperationalStore", () => {
	let tempDir: TempDir | undefined;
	let store: OperationalStore | undefined;

	afterEach(async () => {
		store?.close();
		store = undefined;
		if (tempDir) {
			try {
				await tempDir.remove();
			} catch {
				// ignore cleanup races on Windows
			}
			tempDir = undefined;
		}
	});

	function openStore(options?: { clock?: TestClock; ids?: TestIds; maxEventPayloadBytes?: number }): OperationalStore {
		tempDir = TempDir.createSync("@omp-operational-");
		const clock = options?.clock ?? new TestClock(1_700_000_000_000);
		const ids = options?.ids ?? new TestIds();
		store = OperationalStore.open({
			dbPath: path.join(tempDir.path(), "operational.db"),
			now: clock.now,
			createId: ids.next,
			durability: "normal",
			maxEventPayloadBytes: options?.maxEventPayloadBytes,
		});
		return store;
	}

	it("isolates user and project scoped state CRUD", () => {
		const s = openStore();
		const user = { kind: "user" as const };
		const projectA = { kind: "project" as const, projectPath: "/repos/a" };
		const projectB = { kind: "project" as const, projectPath: "/repos/b" };

		s.setState(user, "theme", "dark");
		s.setState(projectA, "theme", "light");
		s.setState(projectB, "theme", "solarized");
		s.setState(projectA, "feature.flag", true);

		expect(s.getState(user, "theme")).toBe("dark");
		expect(s.getState(projectA, "theme")).toBe("light");
		expect(s.getState(projectB, "theme")).toBe("solarized");
		expect(s.getState(projectA, "missing")).toBeNull();

		expect(s.listState(projectA).map(entry => entry.key)).toEqual(["feature.flag", "theme"]);
		expect(s.listState(projectA, "feature.").map(entry => entry.value)).toEqual([true]);

		expect(s.deleteState(user, "theme")).toBe(true);
		expect(s.getState(user, "theme")).toBeNull();
		expect(s.getState(projectA, "theme")).toBe("light");
	});

	it("rejects project scope without projectPath", () => {
		const s = openStore();
		expect(() => s.setState({ kind: "project", projectPath: "  " }, "k", 1)).toThrow(/projectPath/);
	});

	it("searches episodes across sessions", () => {
		const s = openStore();
		s.createEpisode({
			sessionId: "sess-1",
			title: "Fix lease recovery",
			summary: "Recover expired running jobs back to queued",
			tags: ["jobs", "leases"],
		});
		s.createEpisode({
			sessionId: "sess-2",
			title: "Theme polish",
			summary: "Adjust dark mode contrast",
			tags: ["ui"],
		});
		s.createEpisode({
			sessionId: "sess-3",
			title: "Lease docs",
			summary: "Document claim and recovery semantics",
			tags: ["jobs"],
		});

		const hits = s.searchEpisodes("lease recovery");
		expect(hits.length).toBeGreaterThanOrEqual(1);
		expect(hits.some(hit => hit.sessionId === "sess-1")).toBe(true);
		expect(hits.some(hit => hit.sessionId === "sess-3")).toBe(true);
		expect(hits.every(hit => hit.sessionId !== "sess-2")).toBe(true);

		const scoped = s.searchEpisodes("lease", { sessionId: "sess-3" });
		expect(scoped).toHaveLength(1);
		expect(scoped[0]?.sessionId).toBe("sess-3");
	}, 15_000);

	it("claims jobs, recovers expired leases, and round-trips checkpoints", () => {
		const clock = new TestClock(1_000);
		const s = openStore({ clock });
		const job = s.createJob({ type: "shell", payload: { cmd: "echo hi" } });
		expect(job.status).toBe("queued");

		const claimed = s.claimJob("worker-a", 500);
		expect(claimed?.id).toBe(job.id);
		expect(claimed?.status).toBe("running");
		expect(claimed?.leaseOwner).toBe("worker-a");
		expect(claimed?.leaseExpiresAt).toBe(1_500);

		const checkpoint = s.setCheckpoint(job.id, { step: 2, cursor: "abc" });
		expect(checkpoint.data).toEqual({ step: 2, cursor: "abc" });
		expect(s.getCheckpoint(job.id)?.data).toEqual({ step: 2, cursor: "abc" });

		clock.set(1_600);
		const recovered = s.recoverExpiredLeases();
		expect(recovered).toHaveLength(1);
		expect(recovered[0]?.status).toBe("queued");
		expect(recovered[0]?.leaseOwner).toBeNull();
		expect(s.getCheckpoint(job.id)?.data).toEqual({ step: 2, cursor: "abc" });

		const reclaimed = s.claimJob("worker-b", 1_000);
		expect(reclaimed?.leaseOwner).toBe("worker-b");
		const completed = s.transitionJob(job.id, {
			to: "completed",
			leaseOwner: "worker-b",
			result: { ok: true },
		});
		expect(completed.status).toBe("completed");
		expect(completed.result).toEqual({ ok: true });
		expect(completed.leaseOwner).toBeNull();
	});

	it("rejects invalid transitions and stale lease owners", () => {
		const s = openStore();
		const job = s.createJob({ type: "task" });
		s.claimJob("owner-1", 10_000);

		expect(() => s.transitionJob(job.id, { to: "completed", leaseOwner: "other" })).toThrow(/stale lease/);
		expect(() => s.transitionJob(job.id, { to: "queued", leaseOwner: "owner-1" })).not.toThrow();

		const again = s.claimJob("owner-2", 10_000);
		expect(again?.id).toBe(job.id);
		s.transitionJob(job.id, { to: "completed", leaseOwner: "owner-2", result: null });
		expect(() => s.transitionJob(job.id, { to: "running", leaseOwner: "owner-2" })).toThrow(/invalid job transition/);
	});

	it("round-trips recurring schedule cron and nextRunAt", () => {
		const clock = new TestClock(5_000);
		const s = openStore({ clock });
		const created = s.upsertSchedule({
			id: "sched-1",
			name: "nightly",
			cron: "0 2 * * *",
			nextRunAt: 9_000,
			payload: { channel: "ops" },
		});
		expect(created.cron).toBe("0 2 * * *");
		expect(created.nextRunAt).toBe(9_000);
		expect(created.enabled).toBe(true);

		clock.advance(10);
		const updated = s.upsertSchedule({
			id: "sched-1",
			name: "nightly",
			cron: "15 2 * * *",
			nextRunAt: 12_000,
			enabled: false,
			payload: { channel: "ops", muted: true },
		});
		expect(updated.cron).toBe("15 2 * * *");
		expect(updated.nextRunAt).toBe(12_000);
		expect(updated.enabled).toBe(false);
		expect(updated.createdAt).toBe(created.createdAt);
		expect(updated.updatedAt).toBeGreaterThan(created.updatedAt);
		expect(s.listSchedules()).toHaveLength(1);
	});

	it("appends events in order, exports JSONL, and caps payloads", () => {
		const clock = new TestClock(100);
		const s = openStore({ clock, maxEventPayloadBytes: 256 });

		clock.set(100);
		s.appendEvent({ kind: "model_decision", payload: { choice: "a" }, sessionId: "s1" });
		clock.set(110);
		s.appendEvent({ kind: "tool_decision", payload: { tool: "bash" }, sessionId: "s1" });
		clock.set(120);
		s.appendEvent({ kind: "outcome", payload: { ok: true }, sessionId: "s1" });

		const listed = s.listEvents({ sessionId: "s1" });
		expect(listed.map(event => event.kind)).toEqual(["model_decision", "tool_decision", "outcome"]);
		expect(listed.map(event => event.createdAt)).toEqual([100, 110, 120]);

		const jsonl = s.exportEventsJsonl({ sessionId: "s1" });
		const lines = jsonl.trimEnd().split("\n");
		expect(lines).toHaveLength(3);
		expect(JSON.parse(lines[0]!).kind).toBe("model_decision");
		expect(JSON.parse(lines[2]!).kind).toBe("outcome");

		const huge: JsonValue = { blob: "x".repeat(2_000) };
		const cappedEvent = s.appendEvent({ kind: "patch", payload: huge });
		expect(cappedEvent.payload).toMatchObject({ truncated: true });
		const stored = s.listEvents({ kind: "patch" })[0];
		expect(stored?.payload).toMatchObject({ truncated: true, maxBytes: 256 });
	});

	it("renews leases for the owning worker and rejects stale owners", () => {
		const clock = new TestClock(1_000);
		const s = openStore({ clock });
		const job = s.createJob({ type: "lease" });
		s.claimJob("owner-a", 500);
		clock.set(1_200);
		const renewed = s.renewLease(job.id, "owner-a", 1_000);
		expect(renewed.leaseExpiresAt).toBe(2_200);
		expect(() => s.renewLease(job.id, "other", 1_000)).toThrow(/stale lease/);
	});

	it("CAS-materializes a due schedule into exactly one queued job", () => {
		const clock = new TestClock(5_000);
		const s = openStore({ clock });
		s.upsertSchedule({
			id: "sched",
			name: "due",
			cron: "0 * * * *",
			nextRunAt: 5_000,
			payload: { jobType: "tick", jobPayload: { n: 1 } },
		});
		expect(s.listDueSchedules(5_000)).toHaveLength(1);

		const first = s.materializeDueSchedule({
			scheduleId: "sched",
			expectedNextRunAt: 5_000,
			nextRunAt: 3_605_000,
			jobType: "tick",
			jobPayload: { n: 1 },
			jobId: "job-1",
		});
		const second = s.materializeDueSchedule({
			scheduleId: "sched",
			expectedNextRunAt: 5_000,
			nextRunAt: 3_605_000,
			jobType: "tick",
			jobPayload: { n: 1 },
			jobId: "job-2",
		});
		expect(first?.id).toBe("job-1");
		expect(second).toBeNull();
		expect(s.listJobs()).toHaveLength(1);
		expect(s.getSchedule("sched")?.nextRunAt).toBe(3_605_000);
		expect(s.listDueSchedules(5_000)).toHaveLength(0);
	});

	it("allows pausing queued jobs and rejects claiming paused work", () => {
		const s = openStore();
		const job = s.createJob({ type: "paused-job", status: "paused" });
		expect(s.claimJob("worker")).toBeNull();
		const queued = s.transitionJob(job.id, { to: "queued" });
		expect(queued.status).toBe("queued");
		const claimed = s.claimJob("worker");
		expect(claimed?.id).toBe(job.id);
		const paused = s.transitionJob(job.id, { to: "paused", leaseOwner: "worker" });
		expect(paused.status).toBe("paused");
	});

	it("fences checkpoint writes by the active lease owner", () => {
		const clock = new TestClock(1_000);
		const s = openStore({ clock });
		const job = s.createJob({ type: "fenced" });
		s.claimJob("owner-a", 10);
		s.setCheckpointForLease(job.id, "owner-a", { step: 1 });
		clock.set(1_011);
		s.recoverExpiredLeases();
		s.claimJob("owner-b", 100);
		expect(() => s.setCheckpointForLease(job.id, "owner-a", { step: 2 })).toThrow(/stale lease/);
		expect(s.setCheckpointForLease(job.id, "owner-b", { step: 3 }).data).toEqual({ step: 3 });
	});

	it("reopens persisted operational state across processes", () => {
		tempDir = TempDir.createSync("@omp-operational-reopen-");
		const dbPath = path.join(tempDir.path(), "state.db");
		const first = new OperationalStore({
			dbPath,
			now: () => 100,
			createId: new TestIds().next,
			durability: "normal",
		});
		first.setState({ kind: "user" }, "preference", "concise");
		const job = first.createJob({ type: "resume" });
		first.claimJob("owner", 1_000);
		first.setCheckpointForLease(job.id, "owner", { step: 4 });
		first.appendEvent({ kind: "job_state", jobId: job.id, payload: { status: "running" } });
		first.close();

		const second = new OperationalStore({
			dbPath,
			now: () => 200,
			createId: new TestIds().next,
			durability: "normal",
		});
		store = second;
		expect(second.getState({ kind: "user" }, "preference")).toBe("concise");
		expect(second.getJob(job.id)?.status).toBe("running");
		expect(second.getCheckpoint(job.id)?.data).toEqual({ step: 4 });
		expect(second.listEvents({ jobId: job.id })).toHaveLength(1);
	});

	it("serializes JSON safely and documents default payload cap constant", () => {
		const cyclic: { self?: unknown } = {};
		cyclic.self = cyclic;
		expect(() => serializeJsonValue(cyclic)).not.toThrow();
		expect(JSON.parse(serializeJsonValue({ n: 1n }))).toEqual({ n: "1" });
		expect(DEFAULT_MAX_EVENT_PAYLOAD_BYTES).toBeGreaterThan(0);
		const capped = capJsonPayload({ text: "y".repeat(50_000) }, 128);
		expect(capped).toMatchObject({ truncated: true });
	});
});
