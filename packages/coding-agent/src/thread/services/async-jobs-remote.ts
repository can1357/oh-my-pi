/**
 * Worker-side {@link AsyncJobManagerApi} over the root's main-thread manager.
 *
 * Every query and command runs on main: synchronous methods through
 * `callSync` (`releaseForegroundJob`, which returns nothing, as an ordered
 * notification), async ones through `call`. Job rows come back as
 * {@link RemoteAsyncJob}s built from {@link AsyncJobWire} projections, with
 * local equivalents of the live fields:
 *
 * - `promise` resolves when main's run promise settles (one `whenSettled`
 *   call per job id while anyone awaits it);
 * - `abortController` is a local controller aborted with main's reason;
 * - `process` and `widgetInputs` are the original live objects for jobs this
 *   worker registered, and a pids snapshot otherwise;
 * - assigning `retainedArtifactsCleanup` forwards the closure to main's row.
 *
 * A job registered here keeps its body in this thread: main calls the `run`
 * function across the link and aborts it through the run context's signal.
 * Its `process` / `widgetInputs` stay here too; main reads them through a
 * {@link WireJobFeed} whose pulls and final push this module answers.
 */
import type { JobWidgetView } from "@oh-my-pi/pi-tui/tools/job-widget";
import type {
	AsyncJob,
	AsyncJobDeliverySink,
	AsyncJobDeliveryState,
	AsyncJobDetails,
	AsyncJobFilter,
	AsyncJobManagerApi,
	AsyncJobProcess,
	AsyncJobReapResult,
	AsyncJobRegisterOptions,
	AsyncJobRun,
	AsyncJobRunResult,
	AsyncJobType,
} from "../../async/job-manager";
import type { JobTextSource, JobWidgetInputs, JobWidgetRegistry } from "../../job-widgets/types";
import type { RemoteObject } from "../rpc";
import {
	type AsyncJobManagerProtocol,
	type AsyncJobWire,
	fromWireSignal,
	type JobFeedDelta,
	type JobFeedSource,
	toWireReason,
	type WireJobFeed,
	type WireJobRun,
	type WireRegisterOptions,
} from "./async-jobs-protocol";
import { ignoreSettle, localUnsubscribe } from "./support";

/**
 * How long a settled job's live `process` / `widgetInputs` stay readable here
 * (e.g. `proc://<id>/streams` after the job ended). Longer than main's default
 * row retention, so the row is gone first.
 */
const LOCAL_INPUTS_RETENTION_MS = 10 * 60 * 1000;

type Remote = RemoteObject<AsyncJobManagerProtocol>;

/** Live inputs of a job registered from this worker. */
interface LocalInputs {
	readonly process?: AsyncJobProcess;
	readonly widgetInputs?: JobWidgetInputs;
}

/** Reads a worker job's live inputs as {@link JobFeedDelta}s: each source's text since the last read. */
class WorkerJobFeed {
	readonly #inputs: LocalInputs;
	readonly #offsets = new Map<string, { source: JobTextSource; end: number; open: boolean }>();

	constructor(inputs: LocalInputs) {
		this.#inputs = inputs;
	}

	wire(): WireJobFeed {
		const { process, widgetInputs } = this.#inputs;
		return {
			process: process ? { command: process.command, cwd: process.cwd } : undefined,
			brief: widgetInputs?.brief(),
			pull: () => this.delta(),
		};
	}

	delta(): JobFeedDelta {
		const { process, widgetInputs } = this.#inputs;
		if (!widgetInputs) return { pids: process ? [...process.pids()] : undefined };
		const sources: JobFeedSource[] = [];
		for (const source of widgetInputs.sources()) {
			const known = this.#offsets.get(source.id);
			const reset = known !== undefined && known.source !== source;
			const from = known && !reset ? known.end : 0;
			const chunk = source.read(from);
			this.#offsets.set(source.id, { source, end: chunk.end, open: chunk.open });
			if (chunk.text.length === 0 && known && !reset && known.open === chunk.open) continue;
			sources.push({
				id: source.id,
				label: source.label,
				text: chunk.text,
				open: chunk.open,
				...(reset ? { reset: true } : {}),
			});
		}
		return { pids: process ? [...process.pids()] : undefined, brief: widgetInputs.brief(), sources };
	}
}

/** Worker-side job row: a projection of main's row plus local stand-ins for its live fields. */
export class RemoteAsyncJob implements AsyncJob {
	readonly id: string;
	readonly type: AsyncJobType;
	readonly status: AsyncJob["status"];
	readonly startTime: number;
	readonly endTime?: number;
	readonly label: string;
	readonly intent?: string;
	readonly resultText?: string;
	readonly errorText?: string;
	readonly structured?: AsyncJob["structured"];
	readonly progressText?: string;
	readonly latestDetails?: AsyncJobDetails;
	readonly ownerId?: string;
	readonly agentId?: string;
	readonly agentOutputPublished?: boolean;
	readonly queued?: boolean;
	readonly foreground?: boolean;
	readonly process?: AsyncJobProcess;
	readonly widgetInputs?: JobWidgetInputs;
	readonly #manager: RemoteAsyncJobManager;
	#cleanup: (() => Promise<void>) | undefined;

	constructor(manager: RemoteAsyncJobManager, wire: AsyncJobWire, local: LocalInputs | undefined) {
		this.#manager = manager;
		this.id = wire.id;
		this.type = wire.type;
		this.status = wire.status;
		this.startTime = wire.startTime;
		this.endTime = wire.endTime;
		this.label = wire.label;
		this.intent = wire.intent;
		this.resultText = wire.resultText;
		this.errorText = wire.errorText;
		this.structured = wire.structured;
		this.progressText = wire.progressText;
		this.latestDetails = wire.latestDetails;
		this.ownerId = wire.ownerId;
		this.agentId = wire.agentId;
		this.agentOutputPublished = wire.agentOutputPublished;
		this.queued = wire.queued;
		this.foreground = wire.foreground;
		const pids = wire.process?.pids ?? [];
		this.process =
			local?.process ??
			(wire.process ? { command: wire.process.command, cwd: wire.process.cwd, pids: () => pids } : undefined);
		this.widgetInputs = local?.widgetInputs;
	}

	/** Settles when main's run promise settles; never rejects. */
	get promise(): Promise<void> {
		return this.#manager.whenSettled(this.id);
	}

	/** Local controller aborted when main aborts the job. */
	get abortController(): AbortController {
		return this.#manager.controllerFor(this.id);
	}

	get retainedArtifactsCleanup(): (() => Promise<void>) | undefined {
		return this.#cleanup;
	}

	/** Hands the cleanup to main's row, which runs it on eviction. */
	set retainedArtifactsCleanup(cleanup: (() => Promise<void>) | undefined) {
		this.#cleanup = cleanup;
		this.#manager.setRetainedArtifactsCleanup(this.id, cleanup);
	}
}

/** Worker-side {@link JobWidgetRegistry} over the root's main-thread widgets. */
class RemoteJobWidgets implements JobWidgetRegistry {
	readonly #remote: Remote;

	constructor(remote: Remote) {
		this.#remote = remote;
	}

	view(job: AsyncJob): JobWidgetView | undefined {
		return this.#remote.callSync("widgetView", job.id);
	}

	caption(job: AsyncJob): string | undefined {
		return this.#remote.callSync("widgetCaption", job.id);
	}

	requestCaption(job: AsyncJob): void {
		this.#remote.notify("widgetRequestCaption", job.id);
	}

	subscribe(listener: () => void): () => void {
		return localUnsubscribe(this.#remote.callSync("widgetSubscribe", listener));
	}

	forget(jobId: string): void {
		this.#remote.notify("widgetForget", jobId);
	}

	/** The root session owns the widgets; a worker never disposes them. */
	dispose(): void {}
}

/** Worker-side root job manager; see the module doc. */
export class RemoteAsyncJobManager implements AsyncJobManagerApi {
	readonly #remote: Remote;
	readonly #local = new Map<string, LocalInputs>();
	readonly #settled = new Map<string, Promise<void>>();
	readonly #controllers = new Map<string, AbortController>();
	#widgets: RemoteJobWidgets | null | undefined;

	constructor(remote: Remote) {
		this.#remote = remote;
	}

	get widgets(): JobWidgetRegistry | undefined {
		if (this.#widgets === undefined) {
			this.#widgets = this.#remote.callSync("hasWidgets") ? new RemoteJobWidgets(this.#remote) : null;
		}
		return this.#widgets ?? undefined;
	}

	get atCapacity(): boolean {
		return this.#remote.callSync("atCapacity");
	}

	onJobSettled(listener: () => void): () => void {
		return localUnsubscribe(this.#remote.callSync("onJobSettled", listener));
	}

	register(type: AsyncJobType, label: string, run: AsyncJobRun, options?: AsyncJobRegisterOptions): string {
		const local: LocalInputs | undefined =
			options?.process || options?.widgetInputs
				? { process: options.process, widgetInputs: options.widgetInputs }
				: undefined;
		const feed = local ? new WorkerJobFeed(local) : undefined;
		const wired: WireJobRun = async ctx => {
			try {
				return await run({
					jobId: ctx.jobId,
					signal: fromWireSignal(ctx.signal),
					reportProgress: ctx.reportProgress,
					markRunning: () => ignoreSettle(ctx.markRunning()),
				});
			} finally {
				// Sent ahead of the result, so main's final widget read sees the job's last output.
				if (feed && ctx.pushFeed) ignoreSettle(ctx.pushFeed(feed.delta()));
				if (local) this.#expireLocal(ctx.jobId, local);
			}
		};
		const wireOptions: WireRegisterOptions = {
			id: options?.id,
			ownerId: options?.ownerId,
			agentId: options?.agentId,
			onProgress: options?.onProgress,
			queued: options?.queued,
			foreground: options?.foreground,
			intent: options?.intent,
			feed: feed?.wire(),
		};
		const id = this.#remote.callSync("register", type, label, wired, wireOptions);
		if (local) this.#local.set(id, local);
		return id;
	}

	publishCompleted(
		type: AsyncJobType,
		label: string,
		result: AsyncJobRunResult,
		options: { id?: string; ownerId?: string; agentId?: string },
	): string {
		return this.#remote.callSync("publishCompleted", type, label, result, options);
	}

	cancel(id: string, filter?: AsyncJobFilter): boolean {
		return this.#remote.callSync("cancel", id, filter);
	}

	getJob(id: string): AsyncJob | undefined {
		const wire = this.#remote.callSync("getJob", id);
		if (!wire) {
			this.#local.delete(id);
			return undefined;
		}
		return this.#row(wire);
	}

	getRunningJobs(filter?: AsyncJobFilter): AsyncJob[] {
		return this.#rows(this.#remote.callSync("getRunningJobs", filter));
	}

	getRecentJobs(limit?: number, filter?: AsyncJobFilter): AsyncJob[] {
		return this.#rows(this.#remote.callSync("getRecentJobs", limit, filter));
	}

	getAllJobs(filter?: AsyncJobFilter): AsyncJob[] {
		return this.#rows(this.#remote.callSync("getAllJobs", filter));
	}

	backgroundJob(jobId: string): boolean {
		return this.#remote.callSync("backgroundJob", jobId);
	}

	/** A notification: nothing to wait for, and every later call reaches main after it. */
	releaseForegroundJob(jobId: string): void {
		this.#remote.notify("releaseForegroundJob", jobId);
	}

	getDeliveryState(filter?: AsyncJobFilter): AsyncJobDeliveryState {
		return this.#remote.callSync("getDeliveryState", filter);
	}

	hasPendingDeliveries(filter?: AsyncJobFilter): boolean {
		return this.#remote.callSync("hasPendingDeliveries", filter);
	}

	watchJobs(jobIds: string[]): number {
		return this.#remote.callSync("watchJobs", jobIds);
	}

	unwatchJobs(jobIds: string[]): number {
		return this.#remote.callSync("unwatchJobs", jobIds);
	}

	acknowledgeDeliveries(jobIds: string[]): number {
		return this.#remote.callSync("acknowledgeDeliveries", jobIds);
	}

	consumeJobResults(jobIds: string[]): number {
		return this.#remote.callSync("consumeJobResults", jobIds);
	}

	isJobResultConsumed(jobId: string): boolean {
		return this.#remote.callSync("isJobResultConsumed", jobId);
	}

	cancelAll(filter?: AsyncJobFilter, reason?: unknown): void {
		this.#remote.callSync("cancelAll", filter, toWireReason(reason));
	}

	evictCompletedJobs(filter?: AsyncJobFilter): number {
		return this.#remote.callSync("evictCompletedJobs", filter);
	}

	waitForAll(): Promise<void> {
		return this.#remote.call("waitForAll");
	}

	registerDeliverySink(ownerId: string, sink: AsyncJobDeliverySink): () => void {
		return localUnsubscribe(
			this.#remote.callSync("registerDeliverySink", ownerId, (jobId, text, job) =>
				sink(jobId, text, job ? this.#row(job) : undefined),
			),
		);
	}

	waitForOwnerJobs(ownerId: string, options?: { timeoutMs?: number; excludeSuppressed?: boolean }): Promise<boolean> {
		return this.#remote.call("waitForOwnerJobs", ownerId, options);
	}

	cancelAndReapOwnerJobs(ownerId: string, deadlineAt: number): Promise<AsyncJobReapResult> {
		return this.#remote.call("cancelAndReapOwnerJobs", ownerId, deadlineAt);
	}

	drainDeliveries(options?: { timeoutMs?: number; filter?: AsyncJobFilter }): Promise<boolean> {
		return this.#remote.call("drainDeliveries", options);
	}

	isDeliverySuppressed(jobId: string): boolean {
		return this.#remote.callSync("isDeliverySuppressed", jobId);
	}

	/** One main `whenSettled` call per job id while it is pending; resolves (never rejects) on settle or link loss. */
	whenSettled(jobId: string): Promise<void> {
		let settled = this.#settled.get(jobId);
		if (!settled) {
			settled = this.#remote.call("whenSettled", jobId).then(
				() => {
					this.#settled.delete(jobId);
				},
				() => {
					this.#settled.delete(jobId);
				},
			);
			this.#settled.set(jobId, settled);
		}
		return settled;
	}

	/** Local controller for `jobId`, aborted with main's (unmapped) reason; one per job while it runs. */
	controllerFor(jobId: string): AbortController {
		const existing = this.#controllers.get(jobId);
		if (existing) return existing;
		const controller = new AbortController();
		const signal = this.#remote.callSync("signal", jobId);
		if (!signal) return controller;
		const local = fromWireSignal(signal);
		if (local.aborted) {
			controller.abort(local.reason);
			return controller;
		}
		this.#controllers.set(jobId, controller);
		local.addEventListener("abort", () => controller.abort(local.reason), { once: true });
		void this.whenSettled(jobId).then(() => {
			if (this.#controllers.get(jobId) === controller) this.#controllers.delete(jobId);
		});
		return controller;
	}

	/** Forward a row's `retainedArtifactsCleanup` assignment to main. */
	setRetainedArtifactsCleanup(jobId: string, cleanup: (() => Promise<void>) | undefined): void {
		this.#remote.notify("setRetainedArtifactsCleanup", jobId, cleanup);
	}

	#row(wire: AsyncJobWire): RemoteAsyncJob {
		return new RemoteAsyncJob(this, wire, this.#local.get(wire.id));
	}

	#rows(wires: AsyncJobWire[]): AsyncJob[] {
		return wires.map(wire => this.#row(wire));
	}

	/** Drop a settled job's live inputs once main's row is certainly gone. */
	#expireLocal(jobId: string, local: LocalInputs): void {
		const timer = setTimeout(() => {
			if (this.#local.get(jobId) === local) this.#local.delete(jobId);
		}, LOCAL_INPUTS_RETENTION_MS);
		timer.unref();
	}
}
