import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { MessageChannel } from "node:worker_threads";
import { ASYNC_JOB_MANAGER_SHUTDOWN_REASON, AsyncJobManager } from "../../src/async/job-manager";
import { Settings } from "../../src/config/settings";
import { AgentStorage } from "../../src/session/agent-storage";
import { ArtifactManager } from "../../src/session/artifacts";
import { CostGate } from "../../src/session/cost-gate";
import { cfgSessionMaxCost } from "../../src/session/settings";
import type { MainThreadLink, SubagentMainApi, SubagentWorkerApi } from "../../src/thread/protocol";
import { type RpcFrame, RpcLink } from "../../src/thread/rpc";
import type { ThreadService, WorkerPeer } from "../../src/thread/services";
import { asyncJobsThreadService } from "../../src/thread/services/async-jobs";
import { runtimeThreadService } from "../../src/thread/services/runtime";
import { settingsThreadService } from "../../src/thread/services/settings";
import { EventBus } from "../../src/utils/event-bus";

/** Main-side view of the fixture's probe: every call is async across the link. */
type Probe = (op: string, ...args: unknown[]) => Promise<unknown>;

const SERVICES: readonly ThreadService[] = [settingsThreadService, runtimeThreadService, asyncJobsThreadService];

interface Started {
	worker: Worker;
	peer: WorkerPeer;
	probe: Probe;
}

const started: Started[] = [];
const managers: AsyncJobManager[] = [];
let tmp = "";
let nextWorker = 1;

beforeEach(() => {
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), "omp-runtime-service-"));
});

afterEach(async () => {
	for (const manager of managers.splice(0)) await manager.dispose({ timeoutMs: 100 });
	for (const { worker, peer } of started.splice(0)) {
		for (const service of SERVICES) service.onWorkerExit?.(peer, "test end");
		peer.link.close("test end");
		worker.terminate();
	}
	AgentStorage.close();
	fs.rmSync(tmp, { recursive: true, force: true });
});

function newManager(): AsyncJobManager {
	const manager = new AsyncJobManager({});
	managers.push(manager);
	return manager;
}

async function startWorker(): Promise<Probe> {
	const spawned = new Worker(new URL("../fixtures/runtime-service-worker.ts", import.meta.url).href, {
		type: "module",
	});
	const channel = new MessageChannel();
	const counter = new SharedArrayBuffer(4);
	const { promise: ready, resolve } = Promise.withResolvers<void>();
	const onReady = (event: MessageEvent): void => {
		if (event.data?.ready) {
			spawned.removeEventListener("message", onReady);
			resolve();
		}
	};
	spawned.addEventListener("message", onReady);
	spawned.postMessage({ sync: channel.port2, counter }, [channel.port2]);
	await ready;
	const threadId = `w${nextWorker++}` as const;
	const link: MainThreadLink = new RpcLink<SubagentMainApi, SubagentWorkerApi>(
		{
			send: frame => spawned.postMessage(frame),
			listen: handler => {
				const listener = (event: MessageEvent<RpcFrame>): void => handler(event.data);
				spawned.addEventListener("message", listener);
				return () => spawned.removeEventListener("message", listener);
			},
		},
		{ name: `main↔${threadId}`, syncReplies: { port: channel.port1, counter: new Int32Array(counter) } },
	);
	link.handle("ping", nonce => nonce);
	const peer: WorkerPeer = { threadId, link };
	for (const service of SERVICES) service.installMain?.(peer);
	let probe: Probe | undefined;
	await link.call("boot", {
		settings: settingsThreadService.globals?.(peer),
		probe: (registered: Probe) => {
			probe = registered;
		},
	});
	if (!probe) throw new Error("fixture did not register its probe");
	started.push({ worker: spawned, peer, probe });
	return probe;
}

async function jobId(probe: Probe, manager: AsyncJobManager, ownerId: string, withInputs = false): Promise<string> {
	const id = await probe("register", manager, ownerId, withInputs);
	if (typeof id !== "string") throw new Error("register returned no id");
	return id;
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
	});

	it("routes a worker job's agent progress through main's batcher to a worker progress sink", async () => {
		const manager = newManager();
		const probe = await startWorker();
		await probe("progressSink", manager, "Worker");
		const id = await probe("register", manager, "Worker", false, "ambient");
		if (typeof id !== "string") throw new Error("register returned no id");
		expect(manager.getJob(id)?.progressDelivery).toBe("ambient");

		await probe("agentProgress", id, "line one");
		expect(await probe("awaitProgressDeliveries")).toEqual([
			{ jobId: id, text: expect.stringContaining("line one"), seq: 1, delivery: "ambient", isRow: true },
		]);

		await probe("finish", id, "done");
		await manager.getJob(id)?.promise;
	});

	it("returns and consumes a job settled during a worker-homed eval wait", async () => {
		const manager = newManager();
		const probe = await startWorker();
		const id = await jobId(probe, manager, "Worker");

		const waited = probe("evalWait", manager, "Worker", id);
		await probe("awaitWaitStart", id);
		await probe("finish", id, "all done");

		expect(await waited).toEqual({ items: [{ kind: "agent", id, status: "completed", text: "all done" }] });
		expect(manager.isJobResultConsumed(id)).toBe(true);
	});

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
	});

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
	});

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
	});

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
	});

	it("dead-letters a dead worker's owned deliveries instead of calling its closed sink", async () => {
		const manager = newManager();
		const probe = await startWorker();
		await probe("sink", manager, "Worker");
		const entry = started[0];
		if (!entry) throw new Error("no worker");
		for (const service of SERVICES) service.onWorkerExit?.(entry.peer, "crash");
		entry.peer.link.close("crash");
		manager.publishCompleted("task", "after exit", { text: "late" }, { ownerId: "Worker" });
		expect(await manager.drainDeliveries({ timeoutMs: 1_000 })).toBe(true);
	});
});

describe("runtime thread services: cost gate, event bus, artifacts, storage", () => {
	it("trips main's cap with a cost recorded in a worker", async () => {
		const settings = Settings.isolated({ [cfgSessionMaxCost.id]: 1 });
		const gate = new CostGate(settings, 0, () => {});
		const probe = await startWorker();
		expect(await probe("cost", gate, 2)).toEqual({ spent: 2, capped: true, capError: true });
		expect(gate.spent).toBe(2);
		expect(gate.check()?.cap).toBe(1);
	});

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
	});

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
	});

	it("allocates artifact ids on main so two workers never collide", async () => {
		const artifacts = new ArtifactManager(path.join(tmp, "artifacts"));
		const [first, second] = await Promise.all([startWorker(), startWorker()]);
		const [a, b] = await Promise.all([first("allocate", artifacts, 40), second("allocate", artifacts, 40)]);
		if (!Array.isArray(a) || !Array.isArray(b)) throw new Error("allocate returned no ids");
		const all = new Set<unknown>([...a, ...b]);
		expect(all.size).toBe(80);
		expect(artifacts.allocateId()).toBe(80);

		const saved = await first("save", artifacts, "worker content");
		expect(saved).toMatchObject({ dir: artifacts.dir });
		const id = typeof saved === "object" && saved !== null ? Reflect.get(saved, "id") : undefined;
		if (typeof id !== "string") throw new Error("save returned no id");
		const file = await artifacts.getPath(id);
		if (!file) throw new Error("saved artifact not found on main");
		expect(fs.readFileSync(file, "utf8")).toBe("worker content");
	});

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
	});
});
