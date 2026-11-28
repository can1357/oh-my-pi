import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { ASYNC_JOB_MANAGER_SHUTDOWN_REASON, type AsyncJob, type AsyncJobManager } from "../../src/async/job-manager";
import { Settings } from "../../src/config/settings";
import type { JobWidgetInputs } from "../../src/job-widgets/types";
import { AgentStorage } from "../../src/session/agent-storage";
import { ArtifactManager } from "../../src/session/artifacts";
import { CostGate } from "../../src/session/cost-gate";
import { cfgSessionMaxCost } from "../../src/session/settings";
import { EventBus } from "../../src/utils/event-bus";
import { runEach } from "../helpers/cleanup";
import { collectGarbage } from "../helpers/heap-snapshot";
import { type Probe, RuntimeWorkers } from "../helpers/runtime-service-workers";

/** The timeout of each case's teardown: far past what stopping its workers takes. */
const TEARDOWN_TIMEOUT_MS = 30_000;

const workers = new RuntimeWorkers();
let tmp = "";

beforeEach(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), "omp-runtime-service-"));
});

afterEach(
	() =>
		runEach([
			() => workers.stop(),
			() => AgentStorage.close(),
			() => fs.rmSync(tmp, { recursive: true, force: true }),
		]),
	TEARDOWN_TIMEOUT_MS,
);

function newManager(): AsyncJobManager {
	return workers.newManager();
}

/** A worker of the fixture, recorded at its spawn; its case's 30 s timeout is past the fixture's 20 s readiness cap. */
function startWorker(): Promise<Probe> {
	return workers.start();
}

async function jobId(probe: Probe, manager: AsyncJobManager, ownerId: string, withInputs = false): Promise<string> {
	const id = await probe("register", manager, ownerId, withInputs);
	if (typeof id !== "string") throw new Error("register returned no id");
	return id;
}

/** A job the fixture registers with `options` (see its `registerJob` probe), keeping its tap only weakly. */
async function heldContextJob(
	probe: Probe,
	manager: AsyncJobManager,
	options: { id?: string; foreground?: boolean; inputs?: boolean },
): Promise<string> {
	const id = await probe("registerJob", manager, "Worker", options);
	if (typeof id !== "string") throw new Error("registerJob returned no id");
	return id;
}

/** Run the body of `id` to its end and wait until main's row settled. */
async function settle(probe: Probe, manager: AsyncJobManager, id: string): Promise<void> {
	const settled = manager.getJob(id)?.promise;
	if (!settled) throw new Error(`no row ${id} on main`);
	await probe("finish", id, "done");
	await settled;
}

/** Weak references to main's row of `id` and to its mirrored widget inputs; nothing else here holds them. */
function mainRefs(manager: AsyncJobManager, id: string): { row: WeakRef<AsyncJob>; feed: WeakRef<JobWidgetInputs> } {
	const row = manager.getJob(id);
	if (!row?.widgetInputs) throw new Error(`no mirrored widget inputs for ${id}`);
	return { row: new WeakRef(row), feed: new WeakRef(row.widgetInputs) };
}

/** Full collections in both threads; the second round lets the release frames of the first one land. */
async function collectBothThreads(probe: Probe): Promise<void> {
	for (let round = 0; round < 2; round++) {
		await probe("gc");
		await collectGarbage();
	}
}

describe("runtime thread services: async jobs", () => {
	it("runs a worker-registered job in the worker, visible on main, delivering to a worker sink", async () => {
		const manager = newManager();
		const probe = await startWorker();
		await probe("sink", manager, "Worker");

		const id = await jobId(probe, manager, "Worker");
		expect(id).toBe("bg_1");
		const job = manager.getJob(id);
		expect(job?.status).toBe("running");
		expect(job?.ownerId).toBe("Worker");
		expect(manager.getRunningJobs({ ownerId: "Worker" }).map(row => row.id)).toEqual([id]);

		await probe("progress", id, "halfway");
		expect(manager.getJob(id)?.progressText).toBe("halfway");

		const awaited = probe("awaitJob", manager, id);
		await probe("finish", id, "all done");
		await job?.promise;
		expect(manager.getJob(id)?.status).toBe("completed");
		expect(manager.getJob(id)?.resultText).toBe("all done");
		expect(await awaited).toEqual({
			isRow: true,
			abortedBefore: false,
			abortedAfter: false,
			status: "completed",
			resultText: "all done",
		});

		expect(await manager.drainDeliveries({ timeoutMs: 5_000 })).toBe(true);
		expect(await probe("deliveries")).toEqual([{ jobId: id, text: "all done", status: "completed", isRow: true }]);
	}, 30_000);

	it("returns and consumes a job settled during a worker-homed eval wait", async () => {
		const manager = newManager();
		const probe = await startWorker();
		const id = await jobId(probe, manager, "Worker");

		const waited = probe("evalWait", manager, "Worker", id);
		await probe("awaitWaitStart", id);
		await probe("finish", id, "all done");

		expect(await waited).toEqual({ items: [{ kind: "agent", id, status: "completed", text: "all done" }] });
		expect(manager.isJobResultConsumed(id)).toBe(true);
	}, 30_000);

	it("emits progress published while a worker-homed eval wait is open", async () => {
		const manager = newManager();
		const probe = await startWorker();
		const id = await jobId(probe, manager, "Worker");

		const waited = probe("evalWaitProgress", manager, "Worker", id);
		await probe("awaitWaitStart", id);
		await probe("progress", id, "halfway", "investigate");
		await probe("finish", id, "all done");

		expect(await waited).toMatchObject({
			result: { items: [{ kind: "agent", id, status: "completed", text: "all done" }] },
			progress: [{ op: "agent", id, taskPreview: "investigate" }],
		});
	}, 30_000);

	it("retains a settled result after eviction while another handle remains running", async () => {
		const manager = newManager();
		const probe = await startWorker();
		const first = await jobId(probe, manager, "Worker");
		const second = await jobId(probe, manager, "Worker");

		const waited = probe("evalWait", manager, "Worker", first, second);
		await probe("awaitWaitStart", first);
		await probe("finish", first, "first done");
		await probe("awaitJob", manager, first);
		expect(manager.evictCompletedJobs({ ownerId: "Worker" })).toBe(1);
		expect(manager.getJob(first)).toBeUndefined();
		await probe("finish", second, "second done");

		expect(await waited).toEqual({
			items: [
				{ kind: "agent", id: first, status: "completed", text: "first done" },
				{ kind: "agent", id: second, status: "completed", text: "second done" },
			],
		});
	}, 30_000);

	it("cancels the worker body from main and keeps the shutdown reason a symbol", async () => {
		const manager = newManager();
		const probe = await startWorker();

		const cancelled = await jobId(probe, manager, "Worker");
		const awaited = probe("awaitJob", manager, cancelled);
		expect(manager.cancel(cancelled)).toBe(true);
		await manager.getJob(cancelled)?.promise;
		expect(manager.getJob(cancelled)?.status).toBe("cancelled");
		expect(await probe("abortState", cancelled)).toEqual({ aborted: true, shutdown: false });
		expect(await awaited).toMatchObject({ status: "cancelled", abortedAfter: true });

		const shutDown = await jobId(probe, manager, "Worker");
		manager.cancelAll(undefined, ASYNC_JOB_MANAGER_SHUTDOWN_REASON);
		await manager.getJob(shutDown)?.promise;
		expect(await probe("abortState", shutDown)).toEqual({ aborted: true, shutdown: true });

		// And the other way: a worker's shutdown cancel reaches main's signal as the symbol.
		const mainSide = Promise.withResolvers<unknown>();
		manager.register("task", "main job", ({ signal }) => {
			signal.addEventListener("abort", () => mainSide.resolve(signal.reason), { once: true });
			return new Promise<string>(() => {});
		});
		await probe("cancelAllShutdown", manager);
		expect(await mainSide.promise).toBe(ASYNC_JOB_MANAGER_SHUTDOWN_REASON);
	}, 30_000);

	it("mirrors a worker job's process and widget inputs on main, ending with the body's last output", async () => {
		const manager = newManager();
		const probe = await startWorker();
		const id = await jobId(probe, manager, "Worker", true);
		const job = manager.getJob(id);
		const inputs = job?.widgetInputs;
		if (!job || !inputs) throw new Error("worker job has no mirrored widget inputs");
		expect(inputs.brief()).toEqual({ kind: "bash", command: "fixture --run" });
		expect(job.process?.command).toBe("fixture --run");

		await probe("append", id, "line one\n");
		inputs.sources();
		await probe("noop");
		const [source] = inputs.sources();
		expect(source?.id).toBe("out");
		expect(source?.read(0).text).toBe("line one\n");
		expect(job.process?.pids()).toEqual([4242]);
		expect(await probe("localInputs", manager, id)).toEqual({ hasWidgetInputs: true, pids: [4242] });

		await probe("append", id, "last line\n");
		await probe("finish", id, "done");
		await job.promise;
		const [final] = inputs.sources();
		expect(final?.read(0)).toMatchObject({ text: "line one\nlast line\n", open: false });
		expect(job.process?.pids()).toEqual([]);
	}, 30_000);

	it("lets a released foreground job's row on main and its tap on the worker be collected once its run settles, and keeps a background job's local inputs readable after it settles", async () => {
		// If this regresses, each foreground bash call of a worker subagent keeps its output twice after it
		// returned: on main in its job row and mirrored feed, on the worker in its tap, for as long as the
		// body keeps its run context. Every body here keeps it, as `entry.report` in the fixture.
		const manager = newManager();
		const probe = await startWorker();

		const releasedFirst = await heldContextJob(probe, manager, {
			id: "released-first",
			foreground: true,
			inputs: true,
		});
		const releasedFirstRefs = mainRefs(manager, releasedFirst);
		await probe("appendHeld", releasedFirst, "released, then settled\n");
		await probe("releaseForeground", manager, releasedFirst);
		await settle(probe, manager, releasedFirst);

		const settledFirst = await heldContextJob(probe, manager, {
			id: "settled-first",
			foreground: true,
			inputs: true,
		});
		const settledFirstRefs = mainRefs(manager, settledFirst);
		await probe("appendHeld", settledFirst, "settled, then released\n");
		await settle(probe, manager, settledFirst);
		expect(manager.getJob(settledFirst)?.status).toBe("completed");
		await probe("releaseForeground", manager, settledFirst);
		await probe("noop");
		expect(manager.getJob(releasedFirst)).toBeUndefined();
		expect(manager.getJob(settledFirst)).toBeUndefined();

		const background = await heldContextJob(probe, manager, { id: "background", inputs: true });
		await probe("appendHeld", background, "kept output\n");
		await settle(probe, manager, background);

		await collectBothThreads(probe);
		const alive = (refs: { row: WeakRef<AsyncJob>; feed: WeakRef<JobWidgetInputs> }) => ({
			mainRow: refs.row.deref() !== undefined,
			mainFeed: refs.feed.deref() !== undefined,
		});
		expect({
			releasedThenSettled: { ...alive(releasedFirstRefs), workerTap: await probe("tapAlive", releasedFirst) },
			settledThenReleased: { ...alive(settledFirstRefs), workerTap: await probe("tapAlive", settledFirst) },
			background: {
				mainStatus: manager.getJob(background)?.status,
				workerTap: await probe("tapAlive", background),
				workerSources: await probe("localSources", manager, background),
			},
		}).toEqual({
			releasedThenSettled: { mainRow: false, mainFeed: false, workerTap: false },
			settledThenReleased: { mainRow: false, mainFeed: false, workerTap: false },
			background: {
				mainStatus: "completed",
				workerTap: true,
				workerSources: [{ text: "kept output\n", open: false }],
			},
		});
	}, 30_000);

	it("ignores a worker job's progress call made after its result arrived", async () => {
		// If this regresses, a body that reports after its result reached main rewrites the ended job's
		// progress line, and job views show progress for a job that has already settled.
		const manager = newManager();
		const probe = await startWorker();
		const id = await jobId(probe, manager, "Worker");
		await probe("progress", id, "halfway");
		await settle(probe, manager, id);

		expect(await probe("progress", id, "after the result")).toBe(true);
		const row = manager.getJob(id);
		expect({ status: row?.status, progressText: row?.progressText }).toEqual({
			status: "completed",
			progressText: "halfway",
		});
	}, 30_000);

	it("clears a reused job id's leftover state on the worker", async () => {
		// If this regresses, a job registered under an id main reuses shows, on the worker (where
		// `proc://<id>` reads it), the process and output of the earlier job that had that id.
		const manager = newManager();
		const probe = await startWorker();

		// A released foreground job gives its auto id back to the next job.
		const released = await heldContextJob(probe, manager, { foreground: true, inputs: true });
		await probe("appendHeld", released, "the earlier job's output\n");
		await settle(probe, manager, released);
		await probe("releaseForeground", manager, released);
		const reusedAuto = await jobId(probe, manager, "Worker");
		expect(reusedAuto).toBe(released);

		// An evicted background job's id, named again.
		const named = await heldContextJob(probe, manager, { id: "named", inputs: true });
		await probe("appendHeld", named, "the earlier job's output\n");
		await settle(probe, manager, named);
		expect(manager.evictCompletedJobs({ ownerId: "Worker" })).toBe(1);
		expect(await heldContextJob(probe, manager, { id: "named" })).toBe(named);

		const none = { hasWidgetInputs: false, pids: null };
		expect({
			reusedAuto: await probe("localInputs", manager, reusedAuto),
			reusedNamed: await probe("localInputs", manager, named),
		}).toEqual({ reusedAuto: none, reusedNamed: none });
	}, 30_000);

	it("dead-letters a dead worker's owned deliveries instead of calling its closed sink", async () => {
		const manager = newManager();
		const probe = await startWorker();
		await probe("sink", manager, "Worker");
		workers.exitLatest("crash");
		manager.publishCompleted("task", "after exit", { text: "late" }, { ownerId: "Worker" });
		expect(await manager.drainDeliveries({ timeoutMs: 1_000 })).toBe(true);
	}, 30_000);
});

describe("runtime thread services: cost gate, event bus, artifacts, storage", () => {
	it("trips main's cap with a cost recorded in a worker", async () => {
		const settings = Settings.isolated({ [cfgSessionMaxCost.id]: 1 });
		const gate = new CostGate(settings, 0, () => {});
		const probe = await startWorker();
		expect(await probe("cost", gate, 2)).toEqual({ spent: 2, capped: true, capError: true });
		expect(gate.spent).toBe(2);
		expect(gate.check()?.cap).toBe(1);
	}, 30_000);

	it("enforces a cap set on main after a worker saw the tree uncapped", async () => {
		const settings = Settings.isolated();
		const gate = new CostGate(settings, 0, () => {});
		const probe = await startWorker();
		expect(await probe("cost", gate, 2)).toEqual({ spent: 2, capped: false, capError: false });

		// Settings listeners run a microtask after the write; the cap push they send then reaches
		// the worker ahead of this probe call (frames are ordered).
		cfgSessionMaxCost.override(settings, 1);
		await Promise.resolve();
		expect(await probe("cost", gate, 0)).toEqual({ spent: 2, capped: true, capError: true });
	}, 30_000);

	it("delivers worker frames to main listeners once and worker listeners receive main frames", async () => {
		const bus = new EventBus();
		const other = new EventBus();
		const seen: unknown[] = [];
		const otherSeen: unknown[] = [];
		bus.on("chan", data => {
			seen.push(data);
		});
		other.on("chan", data => {
			otherSeen.push(data);
		});
		const probe = await startWorker();

		expect(await probe("emit", bus, bus, "chan", { n: 1 })).toEqual({ same: true, remote: true });
		await probe("noop");
		expect(seen).toEqual([{ n: 1 }]);

		await probe("emit", bus, other, "chan", { n: 2 });
		await probe("noop");
		expect(seen).toEqual([{ n: 1 }, { n: 2 }]);
		expect(otherSeen).toEqual([{ n: 2 }]);

		// No main listener: the worker drops the frame, then follows main's listener appearing.
		expect(await probe("hasListeners", bus, "late")).toBe(false);
		const late: unknown[] = [];
		bus.on("late", data => {
			late.push(data);
		});
		await probe("noop");
		expect(await probe("hasListeners", bus, "late")).toBe(true);
		await probe("emit", bus, undefined, "late", "hello");
		await probe("noop");
		expect(late).toEqual(["hello"]);

		await probe("listen", bus, "to-worker");
		bus.emit("to-worker", 7);
		await probe("noop");
		expect(await probe("events")).toEqual([7]);
	}, 30_000);

	it("allocates artifact ids on main so two workers never collide", async () => {
		const sessionDir = path.join(tmp, "session");
		const artifacts = new ArtifactManager(path.join(sessionDir, "local"), sessionDir);
		const [first, second] = await Promise.all([startWorker(), startWorker()]);
		const [a, b] = await Promise.all([first("allocate", artifacts, 40), second("allocate", artifacts, 40)]);
		if (!Array.isArray(a) || !Array.isArray(b)) throw new Error("allocate returned no ids");
		const all = new Set<unknown>([...a, ...b]);
		expect(all.size).toBe(80);
		expect((await artifacts.allocatePath()).id).toBe("80");

		const saved = await first("save", artifacts, "worker content");
		expect(saved).toMatchObject({ dir: artifacts.dir, sessionDir });
		const id = typeof saved === "object" && saved !== null ? Reflect.get(saved, "id") : undefined;
		if (typeof id !== "string") throw new Error("save returned no id");
		const file = await artifacts.getPath(id);
		if (!file) throw new Error("saved artifact not found on main");
		expect(fs.readFileSync(file, "utf8")).toBe("worker content");
	}, 30_000);

	it("gives worker settings mirrors main's storage", async () => {
		const storage = await AgentStorage.open(path.join(tmp, "agent.db"));
		const settings = Settings.isolated({}, { storage });
		const probe = await startWorker();
		expect(await probe("storage", settings)).toEqual({
			isNull: false,
			cache: "fixture-value",
			usage: "fixture/model",
		});
		expect(storage.getCache("fixture:key")).toBe("fixture-value");
		expect(storage.getModelUsageOrder()[0]).toBe("fixture/model");
		expect(await probe("storage", Settings.isolated())).toEqual({ isNull: true });
	}, 30_000);
});
