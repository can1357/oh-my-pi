/**
 * The root `AsyncJobManager` across subagent worker links (kind
 * `"async-job-manager"`, protocol in `./async-jobs-protocol`).
 *
 * Main side: every manager crossing to a worker is served by reference. Job ids,
 * rows, the running-job cap, delivery queues and sinks stay on the root's
 * manager; a worker-registered job's body runs in the worker (its `run`
 * function crosses), and main's cancellation aborts it through the run
 * context's signal. Delivery sinks, settle listeners and widget subscriptions a
 * worker registered are dropped when it exits, so owned deliveries dead-letter
 * exactly as for a disposed in-process session.
 *
 * A worker job's `process` and `widgetInputs` arrive as a {@link WireJobFeed};
 * {@link JobFeedMirror} keeps the latest pids, brief and source text main
 * pulled (each synchronous read starts one background pull) or the body pushed
 * as it settled, so the widget registry's final read sees the job's last output.
 *
 * Worker side: see `./async-jobs-remote`.
 */
import {
	type AsyncJob,
	AsyncJobError,
	AsyncJobManager,
	type AsyncJobProcess,
	type AsyncJobRegisterOptions,
} from "../../async/job-manager";
import { TextTap } from "../../job-widgets/text-tap";
import type { JobTextSource, JobWidgetBrief, JobWidgetInputs } from "../../job-widgets/types";
import type { ThreadId } from "../identity";
import { registerRpcError, type RpcServe } from "../rpc";
import type { ThreadService, WorkerPeer } from "../services";
import {
	ASYNC_JOB_MANAGER_KIND,
	type AsyncJobManagerProtocol,
	type AsyncJobWire,
	fromWireReason,
	type JobFeedDelta,
	toWireSignal,
	type WireJobFeed,
	type WireRegisterOptions,
	type WireRunContext,
} from "./async-jobs-protocol";
import { RemoteAsyncJobManager } from "./async-jobs-remote";
import { ignoreSettle, PeerCleanups } from "./support";

registerRpcError("AsyncJobError", message => new AsyncJobError(message));

// ─────────────────────────────────────────────────────────────────────────────
// Main side
// ─────────────────────────────────────────────────────────────────────────────

/** Main-side mirror of a worker job's process. */
class MirroredProcess implements AsyncJobProcess {
	constructor(
		readonly command: string,
		readonly cwd: string,
		readonly mirror: JobFeedMirror,
	) {}

	pids(): readonly number[] {
		this.mirror.refresh();
		return this.mirror.pids;
	}
}

/** Main-side mirror of one worker widget source: the text received so far. */
class MirroredSource extends TextTap {}

/** Latest data of a worker job's {@link WireJobFeed}; implements its widget inputs over it. */
class JobFeedMirror implements JobWidgetInputs {
	readonly process: MirroredProcess | undefined;
	readonly widgetInputs: JobWidgetInputs | undefined;
	pids: readonly number[] = [];
	#brief: JobWidgetBrief | undefined;
	readonly #sources = new Map<string, MirroredSource>();
	readonly #pull: WireJobFeed["pull"];
	#pulling = false;
	#done = false;

	constructor(feed: WireJobFeed) {
		this.#pull = feed.pull;
		this.#brief = feed.brief;
		this.process = feed.process ? new MirroredProcess(feed.process.command, feed.process.cwd, this) : undefined;
		this.widgetInputs = feed.brief ? this : undefined;
	}

	/** Start one background pull unless one is in flight or the job settled. */
	refresh(): void {
		if (this.#pulling || this.#done) return;
		this.#pulling = true;
		Promise.resolve(this.#pull()).then(
			delta => {
				this.#pulling = false;
				if (!this.#done) this.apply(delta);
			},
			() => {
				// Closed link or dead worker: keep the last data, stop pulling.
				this.#done = true;
			},
		);
	}

	/** Adopt a delta; `final` is the settled body's last one, after which no pulls run. */
	apply(delta: JobFeedDelta, final = false): void {
		if (delta.pids) this.pids = delta.pids;
		if (delta.brief) this.#brief = delta.brief;
		for (const source of delta.sources ?? []) {
			let mirror = this.#sources.get(source.id);
			if (!mirror || source.reset) {
				mirror = new MirroredSource(source.id, source.label);
				this.#sources.set(source.id, mirror);
			}
			mirror.append(source.text);
			if (!source.open) mirror.close();
		}
		if (final) {
			this.#done = true;
			this.pids = [];
			for (const mirror of this.#sources.values()) mirror.close();
		}
	}

	sources(): readonly JobTextSource[] {
		this.refresh();
		return Array.from(this.#sources.values());
	}

	brief(): JobWidgetBrief {
		this.refresh();
		if (!this.#brief) throw new Error("Job has no widget brief");
		return this.#brief;
	}
}

/** Cloneable projection of a main job row. */
export function toJobWire(job: AsyncJob): AsyncJobWire {
	const process = job.process;
	return {
		id: job.id,
		type: job.type,
		status: job.status,
		startTime: job.startTime,
		endTime: job.endTime,
		label: job.label,
		intent: job.intent,
		resultText: job.resultText,
		errorText: job.errorText,
		structured: job.structured,
		progressText: job.progressText,
		latestDetails: job.latestDetails,
		ownerId: job.ownerId,
		agentId: job.agentId,
		agentOutputPublished: job.agentOutputPublished,
		queued: job.queued,
		foreground: job.foreground,
		process: process
			? {
					command: process.command,
					cwd: process.cwd,
					// A mirror's cached pids: projecting must not pull from the worker that runs the job.
					pids:
						job.status !== "running"
							? []
							: process instanceof MirroredProcess
								? process.mirror.pids
								: [...process.pids()],
				}
			: undefined,
		hasWidgetInputs: job.widgetInputs !== undefined,
	};
}

function toJobWires(jobs: readonly AsyncJob[]): AsyncJobWire[] {
	return jobs.map(toJobWire);
}

/** Main-side registration options for a worker job. */
function mainRegisterOptions(options: WireRegisterOptions | undefined, feed: JobFeedMirror | undefined) {
	const result: AsyncJobRegisterOptions = {
		id: options?.id,
		ownerId: options?.ownerId,
		agentId: options?.agentId,
		onProgress: options?.onProgress,
		queued: options?.queued,
		foreground: options?.foreground,
		intent: options?.intent,
		process: feed?.process,
		widgetInputs: feed?.widgetInputs,
	};
	return result;
}

/** Everything workers registered on main managers (sinks, listeners, subscriptions). */
const cleanups = new PeerCleanups(ASYNC_JOB_MANAGER_KIND);

function serveManager(threadId: ThreadId): RpcServe<AsyncJobManager, AsyncJobManagerProtocol> {
	return {
		hasWidgets: manager => manager.widgets !== undefined,
		atCapacity: manager => manager.atCapacity,
		onJobSettled: (manager, listener) =>
			cleanups.track(
				threadId,
				manager.onJobSettled(() => ignoreSettle(listener())),
			),
		register: (manager, type, label, run, options) => {
			const feed = options?.feed ? new JobFeedMirror(options.feed) : undefined;
			return manager.register(
				type,
				label,
				ctx => {
					const wire: WireRunContext = {
						jobId: ctx.jobId,
						signal: toWireSignal(ctx.signal),
						reportProgress: ctx.reportProgress,
						markRunning: ctx.markRunning,
						pushFeed: feed ? delta => feed.apply(delta, true) : undefined,
					};
					return run(wire);
				},
				mainRegisterOptions(options, feed),
			);
		},
		publishCompleted: (manager, type, label, result, options) =>
			manager.publishCompleted(type, label, result, options),
		cancel: (manager, id, filter) => manager.cancel(id, filter),
		getJob: (manager, id) => {
			const job = manager.getJob(id);
			return job ? toJobWire(job) : undefined;
		},
		getRunningJobs: (manager, filter) => toJobWires(manager.getRunningJobs(filter)),
		getRecentJobs: (manager, limit, filter) => toJobWires(manager.getRecentJobs(limit, filter)),
		getAllJobs: (manager, filter) => toJobWires(manager.getAllJobs(filter)),
		backgroundJob: (manager, jobId) => manager.backgroundJob(jobId),
		releaseForegroundJob: (manager, jobId) => manager.releaseForegroundJob(jobId),
		getDeliveryState: (manager, filter) => manager.getDeliveryState(filter),
		hasPendingDeliveries: (manager, filter) => manager.hasPendingDeliveries(filter),
		watchJobs: (manager, jobIds) => manager.watchJobs(jobIds),
		unwatchJobs: (manager, jobIds) => manager.unwatchJobs(jobIds),
		acknowledgeDeliveries: (manager, jobIds) => manager.acknowledgeDeliveries(jobIds),
		consumeJobResults: (manager, jobIds) => manager.consumeJobResults(jobIds),
		isJobResultConsumed: (manager, jobId) => manager.isJobResultConsumed(jobId),
		cancelAll: (manager, filter, reason) => manager.cancelAll(filter, fromWireReason(reason)),
		evictCompletedJobs: (manager, filter) => manager.evictCompletedJobs(filter),
		waitForAll: manager => manager.waitForAll(),
		registerDeliverySink: (manager, ownerId, sink) =>
			cleanups.track(
				threadId,
				manager.registerDeliverySink(ownerId, (jobId, text, job) =>
					sink(jobId, text, job ? toJobWire(job) : undefined),
				),
			),
		waitForOwnerJobs: (manager, ownerId, options) => manager.waitForOwnerJobs(ownerId, options),
		cancelAndReapOwnerJobs: (manager, ownerId, deadlineAt) => manager.cancelAndReapOwnerJobs(ownerId, deadlineAt),
		drainDeliveries: (manager, options) => manager.drainDeliveries(options),
		isDeliverySuppressed: (manager, jobId) => manager.isDeliverySuppressed(jobId),
		whenSettled: async (manager, jobId) => {
			await manager.getJob(jobId)?.promise;
		},
		signal: (manager, jobId) => {
			const job = manager.getJob(jobId);
			return job ? toWireSignal(job.abortController.signal) : undefined;
		},
		setRetainedArtifactsCleanup: (manager, jobId, cleanup) => {
			const job = manager.getJob(jobId);
			if (job) job.retainedArtifactsCleanup = cleanup;
		},
		widgetView: (manager, jobId) => {
			const job = manager.getJob(jobId);
			return job ? manager.widgets?.view(job) : undefined;
		},
		widgetCaption: (manager, jobId) => {
			const job = manager.getJob(jobId);
			return job ? manager.widgets?.caption(job) : undefined;
		},
		widgetRequestCaption: (manager, jobId) => {
			const job = manager.getJob(jobId);
			if (job) manager.widgets?.requestCaption(job);
		},
		widgetSubscribe: (manager, listener) => {
			const widgets = manager.widgets;
			if (!widgets) return () => {};
			return cleanups.track(
				threadId,
				widgets.subscribe(() => ignoreSettle(listener())),
			);
		},
		widgetForget: (manager, jobId) => manager.widgets?.forget(jobId),
	};
}

function installMain(peer: WorkerPeer): void {
	peer.link.exportClass<AsyncJobManager, AsyncJobManagerProtocol>(
		ASYNC_JOB_MANAGER_KIND,
		(value): value is AsyncJobManager => value instanceof AsyncJobManager,
		serveManager(peer.threadId),
	);
}

/**
 * Root `AsyncJobManager`s for subagent workers: main serves them by reference, workers use
 * {@link RemoteAsyncJobManager}. See the module doc.
 */
export const asyncJobsThreadService: ThreadService = {
	name: ASYNC_JOB_MANAGER_KIND,
	installMain,
	onWorkerExit: peer => cleanups.release(peer.threadId),
	installWorker(link) {
		link.importClass<RemoteAsyncJobManager, AsyncJobManagerProtocol>(
			ASYNC_JOB_MANAGER_KIND,
			remote => new RemoteAsyncJobManager(remote),
		);
	},
};
