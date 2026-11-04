/**
 * Wire protocol of the root `AsyncJobManager` a subagent worker reaches by
 * reference (kind `"async-job-manager"`).
 *
 * Job rows cross as {@link AsyncJobWire} projections: data only, no
 * `AbortController`, run promise, process handle or widget inputs. The worker
 * rebuilds rows with local equivalents (`./async-jobs-remote`).
 *
 * Inputs the main thread reads synchronously from a job (`process.pids()`,
 * `widgetInputs.sources()`/`brief()`) cannot call back into a worker; a job
 * registered from a worker sends a {@link WireJobFeed} instead, and main keeps
 * the latest {@link JobFeedDelta} it pulled or was pushed.
 *
 * Abort reasons that are symbols cannot cross: {@link toWireReason} maps
 * `ASYNC_JOB_MANAGER_SHUTDOWN_REASON` to a plain sentinel and
 * {@link fromWireReason} maps it back on the receiving thread.
 */
import { isRecord } from "@oh-my-pi/pi-utils";
import type { JobWidgetView } from "@oh-my-pi/pi-tui/tools/job-widget";
import {
	ASYNC_JOB_MANAGER_SHUTDOWN_REASON,
	type AsyncJob,
	type AsyncJobDeliveryState,
	type AsyncJobDetails,
	type AsyncJobFilter,
	type AsyncJobReapResult,
	type AsyncJobRunResult,
	type AsyncJobType,
} from "../../async/job-manager";
import type { JobWidgetBrief } from "../../job-widgets/types";
import type { RpcMethod } from "../rpc";
import type { WireCallback, WireUnsubscribe } from "./support";

/** Remote-object kind of the root `AsyncJobManager`. */
export const ASYNC_JOB_MANAGER_KIND = "async-job-manager";

/** Cloneable projection of one job row. */
export interface AsyncJobWire {
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
	/** The job's process: command line, start directory, and its live pids at projection time. */
	readonly process?: { readonly command: string; readonly cwd: string; readonly pids: readonly number[] };
	/** Whether the job offers widget inputs on the root's thread. */
	readonly hasWidgetInputs: boolean;
}

/** New text of one widget source since the previous delta. */
export interface JobFeedSource {
	readonly id: string;
	readonly label: string;
	readonly text: string;
	readonly open: boolean;
	/** The worker's source object for this id changed: drop the text kept so far. */
	readonly reset?: boolean;
}

/** What changed in a worker-registered job's process and widget inputs. */
export interface JobFeedDelta {
	readonly pids?: readonly number[];
	readonly brief?: JobWidgetBrief;
	readonly sources?: readonly JobFeedSource[];
}

/** Data stand-in for `process` / `widgetInputs` of a job registered from a worker. */
export interface WireJobFeed {
	readonly process?: { readonly command: string; readonly cwd: string };
	/** Present when the job offers widget inputs; their brief at registration. */
	readonly brief?: JobWidgetBrief;
	/** Reads the delta since the previous pull or push (a worker function). */
	readonly pull: () => JobFeedDelta | Promise<JobFeedDelta>;
}

/** Registration options as they cross: live inputs replaced by {@link WireJobFeed}. */
export interface WireRegisterOptions {
	readonly id?: string;
	readonly ownerId?: string;
	readonly agentId?: string;
	readonly onProgress?: (text: string, details?: AsyncJobDetails) => void | Promise<void>;
	readonly queued?: boolean;
	readonly foreground?: boolean;
	readonly intent?: string;
	readonly feed?: WireJobFeed;
}

/** The run context main hands a worker job body. */
export interface WireRunContext {
	readonly jobId: string;
	/** Aborts with the wire form of the job's abort reason (see {@link fromWireReason}). */
	readonly signal: AbortSignal;
	readonly reportProgress: (text: string, details?: AsyncJobDetails) => Promise<void>;
	readonly markRunning: WireCallback<[]>;
	/** Present for jobs registered with a feed: applies the body's final delta before its result lands. */
	readonly pushFeed?: WireCallback<[delta: JobFeedDelta]>;
}

/** A worker job body as main calls it. */
export type WireJobRun = (ctx: WireRunContext) => Promise<string | AsyncJobRunResult>;

/** A worker delivery sink as main calls it. */
export type WireDeliverySink = (jobId: string, text: string, job?: AsyncJobWire) => void | Promise<void>;

/** Remote-object protocol of kind {@link ASYNC_JOB_MANAGER_KIND}; sync methods are served synchronously on main. */
export type AsyncJobManagerProtocol = {
	hasWidgets: RpcMethod<[], boolean>;
	atCapacity: RpcMethod<[], boolean>;
	onJobSettled: RpcMethod<[listener: WireCallback<[]>], WireUnsubscribe>;
	register: RpcMethod<
		[type: AsyncJobType, label: string, run: WireJobRun, options: WireRegisterOptions | undefined],
		string
	>;
	publishCompleted: RpcMethod<
		[
			type: AsyncJobType,
			label: string,
			result: AsyncJobRunResult,
			options: { id?: string; ownerId?: string; agentId?: string },
		],
		string
	>;
	cancel: RpcMethod<[id: string, filter: AsyncJobFilter | undefined], boolean>;
	getJob: RpcMethod<[id: string], AsyncJobWire | undefined>;
	getRunningJobs: RpcMethod<[filter: AsyncJobFilter | undefined], AsyncJobWire[]>;
	getRecentJobs: RpcMethod<[limit: number | undefined, filter: AsyncJobFilter | undefined], AsyncJobWire[]>;
	getAllJobs: RpcMethod<[filter: AsyncJobFilter | undefined], AsyncJobWire[]>;
	backgroundJob: RpcMethod<[jobId: string], boolean>;
	releaseForegroundJob: RpcMethod<[jobId: string], void>;
	getDeliveryState: RpcMethod<[filter: AsyncJobFilter | undefined], AsyncJobDeliveryState>;
	hasPendingDeliveries: RpcMethod<[filter: AsyncJobFilter | undefined], boolean>;
	watchJobs: RpcMethod<[jobIds: string[]], number>;
	unwatchJobs: RpcMethod<[jobIds: string[]], number>;
	acknowledgeDeliveries: RpcMethod<[jobIds: string[]], number>;
	consumeJobResults: RpcMethod<[jobIds: string[]], number>;
	isJobResultConsumed: RpcMethod<[jobId: string], boolean>;
	cancelAll: RpcMethod<[filter: AsyncJobFilter | undefined, reason: unknown], void>;
	evictCompletedJobs: RpcMethod<[filter: AsyncJobFilter | undefined], number>;
	waitForAll: RpcMethod<[], void>;
	registerDeliverySink: RpcMethod<[ownerId: string, sink: WireDeliverySink], WireUnsubscribe>;
	waitForOwnerJobs: RpcMethod<
		[ownerId: string, options: { timeoutMs?: number; excludeSuppressed?: boolean } | undefined],
		boolean
	>;
	cancelAndReapOwnerJobs: RpcMethod<[ownerId: string, deadlineAt: number], AsyncJobReapResult>;
	drainDeliveries: RpcMethod<[options: { timeoutMs?: number; filter?: AsyncJobFilter } | undefined], boolean>;
	isDeliverySuppressed: RpcMethod<[jobId: string], boolean>;
	/** Resolves once the job's run promise settled (immediately for unknown ids). */
	whenSettled: RpcMethod<[jobId: string], void>;
	/** The job's abort signal in wire form, or undefined for unknown ids. */
	signal: RpcMethod<[jobId: string], AbortSignal | undefined>;
	setRetainedArtifactsCleanup: RpcMethod<[jobId: string, cleanup: (() => Promise<void>) | undefined], void>;
	widgetView: RpcMethod<[jobId: string], JobWidgetView | undefined>;
	widgetCaption: RpcMethod<[jobId: string], string | undefined>;
	widgetRequestCaption: RpcMethod<[jobId: string], void>;
	widgetSubscribe: RpcMethod<[listener: WireCallback<[]>], WireUnsubscribe>;
	widgetForget: RpcMethod<[jobId: string], void>;
};

const SHUTDOWN_SENTINEL_KEY = "__ompAsyncJobManagerShutdown";

/** Abort reason as it can cross: the shutdown symbol becomes a sentinel, other symbols their description. */
export function toWireReason(reason: unknown): unknown {
	if (reason === ASYNC_JOB_MANAGER_SHUTDOWN_REASON) return { [SHUTDOWN_SENTINEL_KEY]: true };
	if (typeof reason === "symbol") return String(reason);
	return reason;
}

/** Inverse of {@link toWireReason}. */
export function fromWireReason(reason: unknown): unknown {
	return isRecord(reason) && reason[SHUTDOWN_SENTINEL_KEY] === true ? ASYNC_JOB_MANAGER_SHUTDOWN_REASON : reason;
}

const kWireSignal = Symbol("async-jobs.wireSignal");
const kLocalSignal = Symbol("async-jobs.localSignal");

/**
 * Signal derived from `signal` that aborts with {@link toWireReason} of its reason; one per
 * source signal, cached on it.
 */
export function toWireSignal(signal: AbortSignal): AbortSignal {
	return derivedSignal(signal, kWireSignal, toWireReason);
}

/** Signal derived from a received wire signal that aborts with {@link fromWireReason} of its reason. */
export function fromWireSignal(signal: AbortSignal): AbortSignal {
	return derivedSignal(signal, kLocalSignal, fromWireReason);
}

function derivedSignal(signal: AbortSignal, key: symbol, map: (reason: unknown) => unknown): AbortSignal {
	const cached: unknown = Reflect.get(signal, key);
	if (cached instanceof AbortSignal) return cached;
	const controller = new AbortController();
	if (signal.aborted) controller.abort(map(signal.reason));
	else signal.addEventListener("abort", () => controller.abort(map(signal.reason)), { once: true });
	Reflect.set(signal, key, controller.signal);
	return controller.signal;
}
