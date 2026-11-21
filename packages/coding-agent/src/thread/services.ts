/**
 * Contract for everything that crosses a main↔subagent-worker link.
 *
 * A {@link ThreadService} contributes both halves of one bridged concern
 * (agent registry, async jobs, auth, settings, …): on the main thread it adds
 * codecs/exported classes to each new worker link and hands the worker its
 * boot globals; on the worker it adds the matching imports and installs the
 * remote implementations as that thread's globals. The full list lives in
 * `./services/index.ts`; the pool and the worker entry install it in order.
 */
import type { ThreadId } from "./identity";
import type { MainThreadLink, WorkerThreadLink } from "./protocol";

/** Main-thread view of one worker, passed to service hooks. */
export interface WorkerPeer {
	readonly threadId: ThreadId;
	readonly link: MainThreadLink;
	/** Hold the worker alive (and its idle shutdown off) while main depends on it; returns an idempotent release. */
	retain?(): () => void;
}

/** One bridged concern; every hook is optional. */
export interface ThreadService {
	/** Key of this service's entry in the boot globals. */
	readonly name: string;
	/** Main thread: register codecs, exported classes, and handlers on a new worker's link before it boots. */
	installMain?(peer: WorkerPeer): void;
	/** Main thread: value handed to the worker's {@link boot} (typically exported objects or snapshots). */
	globals?(peer: WorkerPeer): unknown;
	/** Main thread: the worker exited (crash or shutdown) and its link is closed. */
	onWorkerExit?(peer: WorkerPeer, reason: string): void;
	/** Worker thread: register codecs, imported classes, and handlers before boot. */
	installWorker?(link: WorkerThreadLink): void;
	/** Worker thread: consume this service's globals and install remote implementations. */
	boot?(globals: unknown, link: WorkerThreadLink): void | Promise<void>;
}
