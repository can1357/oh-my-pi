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
	fromWireSignal,
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
		waitingForSlot: job.waitingForSlot,
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

/**
 * The subagent runs each worker thread is hosting, recorded on this side as
 * each run is placed. A worker's registrations hand their slots down from the
 * run that made them, and the worker names which one — but the name is only
 * honoured if this side placed that run on that thread.
 *
 * A set, not one id: the pool gives a worker a second run once it has as many
 * workers as `task.workerThreads` allows, so several runs share a thread and
 * each must be able to name its own. Keeping one id per thread would hand a
 * run the slot of whichever sibling was placed last — an unrelated job's —
 * and leave the other's work queued behind it, which is the deadlock this
 * branch exists to remove.
 */
const workerHostJobs = new Map<ThreadId, Set<string>>();

/** Record that `threadId` is hosting `jobId`'s run; returns the undo for that one run. */
export function setWorkerHostJob(threadId: ThreadId, jobId: string): () => void {
	let hosted = workerHostJobs.get(threadId);
	if (!hosted) {
		hosted = new Set();
		workerHostJobs.set(threadId, hosted);
	}
	hosted.add(jobId);
	return () => {
		const live = workerHostJobs.get(threadId);
		if (!live?.delete(jobId)) return;
		if (live.size === 0) workerHostJobs.delete(threadId);
	};
}

/** The host a worker may name: one this side placed on that thread, or none. */
function placedHostJob(threadId: ThreadId, named: string | undefined): string | undefined {
	return named !== undefined && workerHostJobs.get(threadId)?.has(named) === true ? named : undefined;
}

/** Main-side registration options for a worker job. */
function mainRegisterOptions(
	options: WireRegisterOptions | undefined,
	feed: JobFeedMirror | undefined,
	threadId: ThreadId,
) {
	const result: AsyncJobRegisterOptions = {
		id: options?.id,
		ownerId: options?.ownerId,
		agentId: options?.agentId,
		onProgress: options?.onProgress,
		queued: options?.queued,
		startImmediately: options?.startImmediately,
		hostJobId: placedHostJob(threadId, options?.hostJobId),
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
			// A job this worker registered is this worker's own, so the worker may
			// name it as the host of the work that job's run starts — which is how a
			// grandchild two levels down a worker chain reaches a slot at all.
			// Assigned right after `register` returns and cleared when the run ends;
			// a job cancelled before it ran leaves its entry to the thread's exit.
			const recorded: { forget?: () => void } = {};
			const id = manager.register(
				type,
				label,
				async ctx => {
					const wire: WireRunContext = {
						jobId: ctx.jobId,
						signal: toWireSignal(ctx.signal),
						reportProgress: ctx.reportProgress,
						markRunning: ctx.markRunning,
						pushFeed: feed ? delta => feed.apply(delta, true) : undefined,
					};
					try {
						return await run(wire);
					} finally {
						recorded.forget?.();
					}
				},
				mainRegisterOptions(options, feed, threadId),
			);
			recorded.forget = setWorkerHostJob(threadId, id);
			cleanups.track(threadId, () => recorded.forget?.());
			return id;
		},
		// Tracked, so a worker that exits holding a slot gives it back. A worker
		// that exits while still waiting gives up its place in line too, so a dead
		// worker never shrinks the cap for good: the link's close aborts imported
		// signals, and this exit watch does not depend on that ordering. An OS
		// process the worker started and did not kill outlives both and is
		// nobody's slot — killing a dead worker's children is process-group
		// teardown, not job accounting.
		acquireSlot: async (manager, signal, request) => {
			// Same as registration: the host comes from what this link is running,
			// never from the request, so a supplied id cannot borrow another job's
			// slot. A worker's spawn is registered before its run asks for a slot,
			// so the recorded host is already on the job by the time this runs.
			const scoped = { ...request, hostJobId: placedHostJob(threadId, request?.hostJobId) };
			const exited = new AbortController();
			const stopWatchingExit = cleanups.track(threadId, () => exited.abort(new Error("Worker exited")));
			let release: () => void;
			// Only the worker's exit aborts `exited`; the caller's own wire signal
			// aborts the combined signal instead. So reading it is exactly "the
			// worker exited" — but it must be read BEFORE the teardown call, because
			// `cleanups.track` hands back a run-once invoker of the tracked body, not
			// an untracker, so that call aborts `exited` itself. Reading it after
			// would be true every time and throw at the caller of every grant.
			let exitWon: boolean;
			try {
				release = await manager.acquireSlot(AbortSignal.any([fromWireSignal(signal), exited.signal]), scoped);
			} finally {
				exitWon = exited.signal.aborted;
				stopWatchingExit();
			}
			// The exit can also win after the grant: the slot is held, and this
			// worker's cleanup set has already run. Tracking the release here would
			// open a fresh set nothing will ever run, and the closed link cannot
			// carry the release back, so the slot would be lost for the manager's
			// life. Give it back here instead — the caller is gone either way.
			if (exitWon) {
				release();
				throw exited.signal.reason;
			}
			return cleanups.track(threadId, release);
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
