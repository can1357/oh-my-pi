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
import { asyncJobsThreadService, setWorkerHostJob } from "../../src/thread/services/async-jobs";
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

	it("counts a worker's slot against main's cap and frees it on release, on exit, and when exit beats the grant", async () => {
		// The RPC path is not a thin forwarder: it has its own exit race, and it
		// is how production task subagents take slots. The deadlock this branch
		// fixes is in subagent spawning, so this path needs its own guard. Every
		// phase ends by proving a later request is actually granted — "nothing
		// threw" is what let a grant-throwing regression hide here once already.
		const manager = new AsyncJobManager({ maxRunningJobs: 1 });
		managers.push(manager);
		/**
		 * Takes and returns a real slot, so a phase passes only when the cap
		 * genuinely has one to give — "nothing threw" is what hid a regression
		 * here once. Every caller expects the grant, so this awaits the grant
		 * itself; the cap exists only to turn a hang into a named failure, and is
		 * far wider than the work so a loaded box cannot read as "no slot".
		 */
		const slotIsFree = async (): Promise<boolean> => {
			try {
				(await manager.acquireSlot(AbortSignal.timeout(30_000), {}))();
				return true;
			} catch {
				return false;
			}
		};

		const probe = await startWorker();
		const releaseMain = await manager.acquireSlot(new AbortController().signal, {});
		let granted = false;
		const acquired = probe("acquireSlot", manager, "Worker").then(() => {
			granted = true;
		});
		await probe("noop");
		expect(granted).toBe(false);

		releaseMain();
		await acquired;
		expect(manager.atCapacity).toBe(true);
		await probe("releaseSlot");
		expect(await slotIsFree()).toBe(true);

		// A worker that exits holding a slot gives it back.
		await probe("acquireSlot", manager, "Worker");
		expect(manager.atCapacity).toBe(true);
		const entry = started[0];
		if (!entry) throw new Error("no worker");
		for (const service of SERVICES) service.onWorkerExit?.(entry.peer, "crash");
		expect(await slotIsFree()).toBe(true);

		// A worker that exits while it waits gives up its place: its request must
		// reject at the exit, not merely once unrelated work frees a slot, or a
		// dead worker's request could still take the next slot that comes along.
		const releaseAgain = await manager.acquireSlot(new AbortController().signal, {});
		const waiter = await startWorker();
		const waiterRequest = waiter("acquireSlot", manager, "Waiter").then(
			() => "granted",
			() => "rejected",
		);
		await waiter("noop");
		const waiting = started[1];
		if (!waiting) throw new Error("no second worker");
		for (const service of SERVICES) service.onWorkerExit?.(waiting.peer, "crash");
		expect(await waiterRequest).toBe("rejected");
		releaseAgain();
		expect(await slotIsFree()).toBe(true);

		// The exit wins the race after the grant. `releaseLast()` resolves the
		// waiter synchronously inside the grant pump, so firing the exit before
		// awaiting puts it between the grant and the handler resuming — the
		// ordering that tracked the release on a cleanup set that had already
		// run, losing the slot for the manager's life. The premise is asserted:
		// were grants ever deferred, the exit would win before the grant and this
		// phase would quietly become a second copy of the one above.
		const releaseLast = await manager.acquireSlot(new AbortController().signal, {});
		const racer = await startWorker();
		void racer("acquireSlot", manager, "Racer").catch(() => {});
		await racer("noop");
		const racing = started[2];
		if (!racing) throw new Error("no third worker");
		releaseLast();
		// The premise, checked rather than assumed: the racer took the slot inside
		// `releaseLast()`. This catches the slot simply not being taken; it cannot
		// tell a synchronous grant from a deferred one, because `atCapacity` is
		// also true while anything is queued. Defer grants and this phase becomes
		// exit-before-grant coverage instead, which is why the correction it
		// guards is stated in the handler rather than left to this assertion.
		expect(manager.atCapacity).toBe(true);
		for (const service of SERVICES) service.onWorkerExit?.(racing.peer, "crash");
		expect(await slotIsFree()).toBe(true);

		// The hand-down across the link: this is the behaviour the branch exists
		// for, and the worker is where it is hardest, because the manager's own
		// per-run scope cannot cross a thread. The main side records what each
		// worker is running when it places the run, and the handler reads that —
		// never an id the worker sends.
		const hostRelease = Promise.withResolvers<void>();
		const hostId = manager.register(
			"task",
			"WorkerHost",
			async () => {
				await hostRelease.promise;
				return "host done";
			},
			{ id: "WorkerHost", agentId: "WorkerHost", ownerId: "Main" },
		);
		expect(manager.atCapacity).toBe(true);

		// A link with nothing recorded against it names a live job as its host.
		// A supplied id is just a string: honouring one hands the slot that job's
		// own work is waiting for to unrelated work, so it must queue instead.
		const forger = await startWorker();
		let forgedGranted = false;
		void forger("acquireSlot", manager, "Forged.Child", hostId).then(() => {
			forgedGranted = true;
		});
		// Nothing fires when a request correctly waits, so this negative check
		// needs a real moment; a wrong grant returns on the next round trip.
		await Bun.sleep(250);
		expect(forgedGranted).toBe(false);

		// The link the host's run was actually placed on, recorded before it asks
		// as a real placement records it. Same request, and it is granted while
		// the host still holds: the hand-down the branch exists for, over the link.
		const nested = await startWorker();
		const nestedEntry = started.at(-1);
		if (!nestedEntry) throw new Error("no worker entry");
		const forgetHost = setWorkerHostJob(nestedEntry.peer.threadId, hostId);
		// A worker hosts more than one run once the pool is at its worker limit.
		// A sibling placed on the same thread, and then ended, must not take this
		// run's record with it: holding one id per thread would have overwritten
		// it here and dropped it on the undo, and the request below would be
		// refused — or worse, earlier, granted the sibling's slot.
		setWorkerHostJob(nestedEntry.peer.threadId, "SiblingRun")();
		expect(await nested("acquireSlot", manager, "WorkerHost.Child", hostId)).toBe(true);
		// The child runs on its host's slot, not a second counted one: the cap is
		// still full. That is the other half of the documented bound — a hand-down
		// adds a running job without adding a slot the pool could issue.
		expect(manager.atCapacity).toBe(true);
		// And the forged request is still waiting, not riding the same slot.
		expect(forgedGranted).toBe(false);

		await nested("releaseSlot");
		forgetHost();
		hostRelease.resolve();
		// The forged request was never wrong to make, only wrong to hand a borrowed
		// slot: once the host's own pool slot frees it is granted normally, which
		// also proves it had really been queued rather than dropped.
		for (let i = 0; i < 200 && !forgedGranted; i++) await Bun.sleep(25);
		expect(forgedGranted).toBe(true);
		await forger("releaseSlot");
		expect(await slotIsFree()).toBe(true);
		// Four real workers, each paying module init on a shared box. Bun's default
		// 5 s bound is a quiet-machine number: this failed on one run in two under
		// gate contention while every assertion still held. The bound is here to
		// turn a hang into a named failure, not to measure anything, so it is far
		// wider than the work.
	}, 120_000);

	it("a run placed on a worker hosts its own registrations, and each of those hosts the next level", async () => {
		// What the previous rounds could not reach. The carry used to work only
		// when the worker itself named a host, and the one name it sent was the
		// session's agent id — which the manager resolves in a job map, so it
		// named someone else's job or none at all. Two consequences are asserted
		// here: a placed run's own work needs no name, and a job that run
		// registers is nameable in turn, so a grandchild is not stranded.
		const manager = new AsyncJobManager({ maxRunningJobs: 1 });
		managers.push(manager);
		const hostRelease = Promise.withResolvers<void>();
		const hostId = manager.register(
			"task",
			"PlacedHost",
			async () => {
				await hostRelease.promise;
				return "host done";
			},
			// The agent id differs from the job id on purpose: only the job id is
			// a name this manager can resolve.
			{ id: "job-7", agentId: "PlacedHost", ownerId: "Main" },
		);
		expect(hostId).toBe("job-7");
		expect(manager.atCapacity).toBe(true);

		const worker = await startWorker();
		const entry = started.at(-1);
		if (!entry) throw new Error("no worker entry");
		// Exactly what a real placement records now: the job id, not the agent id.
		const forgetHost = setWorkerHostJob(entry.peer.threadId, hostId);

		// The run's own work supplies no host — an async `bash` inside a
		// worker-hosted subagent sends none — and is still granted at a full cap.
		expect(await worker("placedSlot", manager, hostId)).toBe(true);

		// A job that run registers starts on the host's slot rather than queueing,
		// and the cap is unchanged because the slot was handed down, not issued.
		const childId = await worker("placedRegister", manager, hostId, "PlacedHost");
		if (typeof childId !== "string") throw new Error("placedRegister returned no id");
		// No wait: main hands the slot down inside the same `register` call the
		// worker is still blocked on, so the row is already admitted here.
		expect(manager.getJob(childId)?.waitingForSlot).not.toBe(true);
		expect(manager.getJob(childId)?.queued).not.toBe(true);
		expect(manager.atCapacity).toBe(true);

		// The grandchild: work inside the child's run names the child. Before the
		// child was recorded as this thread's own, that name was refused and the
		// grandchild queued behind a parent waiting for it.
		expect(await worker("acquireSlot", manager, "PlacedHost.Child.Leaf", childId)).toBe(true);
		expect(manager.atCapacity).toBe(true);

		await worker("releaseSlot");
		await worker("finish", childId, "child done");
		forgetHost();
		hostRelease.resolve();
		await manager.waitForAll();
	}, 120_000);
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
