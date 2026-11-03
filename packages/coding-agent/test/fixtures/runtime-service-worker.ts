import { type MessagePort, parentPort } from "node:worker_threads";
import {
	ASYNC_JOB_MANAGER_SHUTDOWN_REASON,
	type AsyncJobManagerApi,
	type AsyncJobRunResult,
} from "../../src/async/job-manager";
import { Settings } from "../../src/config/settings";
import { TextTap } from "../../src/job-widgets/text-tap";
import type { ArtifactManagerApi } from "../../src/session/artifacts";
import { CostCapError, type CostGateApi } from "../../src/session/cost-gate";
import type { SubagentMainApi, SubagentWorkerApi, WorkerThreadLink } from "../../src/thread/protocol";
import { type RpcFrame, RpcLink } from "../../src/thread/rpc";
import { asyncJobsThreadService } from "../../src/thread/services/async-jobs";
import { RemoteAsyncJob, RemoteAsyncJobManager } from "../../src/thread/services/async-jobs-remote";
import { runtimeThreadService } from "../../src/thread/services/runtime";
import { RemoteArtifactManager, RemoteCostGate, RemoteEventBus } from "../../src/thread/services/runtime-remote";
import { settingsThreadService } from "../../src/thread/services/settings";
import { EventBus, emitSubagentFrame } from "../../src/utils/event-bus";

/** Worker-side probe the test calls through the function it registers at boot. */
export type RuntimeProbe = (op: string, ...args: unknown[]) => unknown;

const port = parentPort;
if (!port) throw new Error("fixture must run in a worker");

interface Body {
	finish: PromiseWithResolvers<string | AsyncJobRunResult>;
	signal?: AbortSignal;
	report?: (text: string) => Promise<void>;
	tap?: TextTap;
}

const bodies = new Map<string, Body>();
const deliveries: unknown[] = [];
const events: unknown[] = [];

function manager(value: unknown): AsyncJobManagerApi {
	if (!(value instanceof RemoteAsyncJobManager)) throw new Error("expected a remote job manager");
	return value;
}

function body(id: unknown): Body {
	const found = typeof id === "string" ? bodies.get(id) : undefined;
	if (!found) throw new Error(`no job body ${String(id)}`);
	return found;
}

function bus(value: unknown): EventBus | undefined {
	if (value === undefined || value === null) return undefined;
	if (!(value instanceof EventBus)) throw new Error("expected an event bus");
	return value;
}

function registerBody(jobs: AsyncJobManagerApi, ownerId: string, withInputs: boolean): string {
	const entry: Body = { finish: Promise.withResolvers() };
	const tap = withInputs ? new TextTap("out", "fixture output") : undefined;
	entry.tap = tap;
	const id = jobs.register(
		"bash",
		"fixture job",
		async ({ signal, reportProgress, markRunning }) => {
			entry.signal = signal;
			entry.report = text => reportProgress(text);
			markRunning();
			const aborted = Promise.withResolvers<never>();
			signal.addEventListener("abort", () => aborted.reject(new Error("aborted")), { once: true });
			try {
				return await Promise.race([entry.finish.promise, aborted.promise]);
			} finally {
				tap?.close();
			}
		},
		{
			ownerId,
			...(tap
				? {
						process: { command: "fixture --run", cwd: "/fixture", pids: () => [4242] },
						widgetInputs: {
							sources: () => [tap],
							brief: () => ({ kind: "bash" as const, command: "fixture --run" }),
						},
					}
				: {}),
		},
	);
	bodies.set(id, entry);
	return id;
}

const probe: RuntimeProbe = async (op, ...args) => {
	switch (op) {
		case "noop":
			return true;
		case "register":
			return registerBody(manager(args[0]), String(args[1]), args[2] === true);
		case "progress":
			await body(args[0]).report?.(String(args[1]));
			return true;
		case "finish":
			body(args[0]).finish.resolve(String(args[1]));
			return true;
		case "append":
			body(args[0]).tap?.append(String(args[1]));
			return true;
		case "abortState": {
			const signal = body(args[0]).signal;
			return {
				aborted: signal?.aborted === true,
				shutdown: signal?.reason === ASYNC_JOB_MANAGER_SHUTDOWN_REASON,
			};
		}
		case "awaitJob": {
			const jobs = manager(args[0]);
			const job = jobs.getJob(String(args[1]));
			if (!job) return null;
			const aborted = job.abortController.signal.aborted;
			await job.promise;
			const settled = jobs.getJob(String(args[1]));
			return {
				isRow: job instanceof RemoteAsyncJob,
				abortedBefore: aborted,
				abortedAfter: job.abortController.signal.aborted,
				status: settled?.status,
				resultText: settled?.resultText,
			};
		}
		case "localInputs": {
			const job = manager(args[0]).getJob(String(args[1]));
			return { hasWidgetInputs: job?.widgetInputs !== undefined, pids: job?.process?.pids() ?? null };
		}
		case "cancelAllShutdown":
			manager(args[0]).cancelAll(undefined, ASYNC_JOB_MANAGER_SHUTDOWN_REASON);
			return true;
		case "sink":
			manager(args[0]).registerDeliverySink(String(args[1]), (jobId, text, job) => {
				deliveries.push({ jobId, text, status: job?.status, isRow: job instanceof RemoteAsyncJob });
			});
			return true;
		case "deliveries":
			return deliveries.splice(0);
		case "cost": {
			const gate = costGate(args[0]);
			gate.record(Number(args[1]));
			let capError = false;
			try {
				gate.admit();
			} catch (error) {
				capError = error instanceof CostCapError;
			}
			return { spent: gate.spent, capped: gate.capped, capError };
		}
		case "emit":
			emitSubagentFrame(bus(args[0]), bus(args[1]), String(args[2]), args[3]);
			return { same: args[0] === args[1], remote: args[0] instanceof RemoteEventBus };
		case "hasListeners":
			return bus(args[0])?.hasListeners(String(args[1])) ?? false;
		case "listen":
			bus(args[0])?.on(String(args[1]), data => {
				events.push(data);
			});
			return true;
		case "events":
			return events.splice(0);
		case "allocate": {
			const artifacts = artifactManager(args[0]);
			const ids: number[] = [];
			const count = Number(args[1]);
			for (let i = 0; i < count; i++) {
				ids.push(artifacts.allocateId());
				// Interleave with the other worker's allocations.
				if (i % 5 === 0) await Bun.sleep(0);
			}
			return ids;
		}
		case "save": {
			const artifacts = artifactManager(args[0]);
			const id = await artifacts.save(String(args[1]), "fixture");
			return { id, dir: artifacts.dir };
		}
		case "storage": {
			const target = args[0];
			if (!(target instanceof Settings)) throw new Error("expected settings");
			const storage = target.getStorage();
			if (!storage) return { isNull: true };
			storage.setCache("fixture:key", "fixture-value", Math.floor(Date.now() / 1000) + 3_600);
			storage.recordModelUsage("fixture/model");
			return { isNull: false, cache: storage.getCache("fixture:key"), usage: storage.getModelUsageOrder()[0] };
		}
		default:
			throw new Error(`unknown probe ${op}`);
	}
};

function costGate(value: unknown): CostGateApi {
	if (!(value instanceof RemoteCostGate)) throw new Error("expected a remote cost gate");
	return value;
}

function artifactManager(value: unknown): ArtifactManagerApi {
	if (!(value instanceof RemoteArtifactManager)) throw new Error("expected a remote artifact manager");
	return value;
}

function isRegister(value: unknown): value is (probe: RuntimeProbe) => Promise<void> {
	return typeof value === "function";
}

port.once("message", (init: { sync: MessagePort; counter: SharedArrayBuffer }) => {
	const link: WorkerThreadLink = new RpcLink<SubagentWorkerApi, SubagentMainApi>(
		{
			send: frame => port.postMessage(frame),
			listen: handler => {
				const listener = (frame: RpcFrame): void => handler(frame);
				port.on("message", listener);
				return () => port.off("message", listener);
			},
		},
		{ name: "runtime-fixture", sync: { port: init.sync, counter: new Int32Array(init.counter) } },
	);
	settingsThreadService.installWorker?.(link);
	runtimeThreadService.installWorker?.(link);
	asyncJobsThreadService.installWorker?.(link);
	link.handle("boot", async globals => {
		await settingsThreadService.boot?.(globals.settings, link);
		const register = globals.probe;
		if (!isRegister(register)) throw new Error("boot expects a probe registrar");
		await register(probe);
	});
	link.handle("ping", nonce => nonce);
	port.postMessage({ ready: true });
});
