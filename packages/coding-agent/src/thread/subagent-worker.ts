/**
 * Main-thread side of subagent host workers.
 *
 * {@link SubagentWorker} owns one Bun worker running `./subagent-worker-entry`:
 * it posts the raw init (thread id + sync reply channel), writes the worker's
 * log records from spawn on (`./worker-log`), builds the
 * {@link MainThreadLink}, installs every {@link ThreadService}'s main hooks,
 * boots the worker with their globals, and turns any worker death (crash,
 * exit, undeliverable message, termination) into exactly one link close plus
 * one `onWorkerExit` per service.
 *
 * {@link SubagentWorkerPool} places each run main places (a top-level spawn, a
 * cold revival) on the main thread or a worker. Workers pay off only once
 * enough subagents run at once: with `n` runs in flight (counting the one being
 * placed) it may use {@link allowedSubagentWorkers}`(n)` of them, none below
 * {@link SUBAGENT_WORKER_THRESHOLD} and one more per doubling, up to
 * `task.workerThreads`. Among the main thread and those worker slots, the run
 * goes where the fewest runs are in flight; resident (idle, kept-alive)
 * sessions keep a worker alive but do not count. A worker starts when a slot
 * is needed and empty, or ahead of a streaming spawn that will need it
 * ({@link prewarmSubagentWorker}), and terminates after `idleMs` with neither
 * runs nor resident sessions. {@link subagentWorkerPool} returns the
 * process-wide pool, or `undefined` when worker mode is off (subagents then run
 * in-process); `task.workerThreads` is read live on every placement.
 */
import { MessageChannel } from "node:worker_threads";
import { getProjectDir, logger, postmortem } from "@oh-my-pi/pi-utils";
import { workerHostEntry } from "@oh-my-pi/pi-utils/worker-host";
import { SUBAGENT_WORKER_ARG } from "../cli/worker-selectors";
import type { ModelRegistry } from "../config/model-registry";
import type { Settings } from "../config/settings";
import { cfgTaskWorkerThreads } from "../task/settings";
import { isMainThread, type ThreadId } from "./identity";
import type { MainThreadLink, SubagentWorkerInit } from "./protocol";
import { type RpcFrame, RpcLink } from "./rpc";
import type { ThreadService, WorkerPeer } from "./services";
import { prewarmModelRegistryMirror } from "./services/auth";
import { THREAD_SERVICES } from "./services/index";
import { isSubagentWorkerLog, receiveWorkerLog } from "./worker-log";

const DEFAULT_INIT_TIMEOUT_MS = 30_000;
/**
 * A worker costs ~100–300 MB (its own VM, module graph, and catalog mirror), so it does
 * not outlive subagent activity by much. 60s spans the usual gap between a turn's
 * successive spawns (the model reading one result and writing the next call) and the
 * parent's next turn, so those land warm, while a finished batch releases its memory
 * within a minute; a later spawn pays one ~0.2s boot that its streaming tool call hides.
 */
const DEFAULT_IDLE_MS = 60_000;

/**
 * Concurrent subagent runs below which every run stays on the main thread. A worker costs
 * ~100–300 MB and a ~0.2–0.5s boot, while subagents mostly wait on model streams, so a
 * handful of them share the main thread fine; past this, the main thread (which also
 * drives the TUI) gets its first helper, and one more per doubling.
 */
export const SUBAGENT_WORKER_THRESHOLD = 9;

/**
 * Worker threads the pool may use with `inFlight` subagent runs main placed (counting the
 * one being placed): 0 below `threshold`, then one per doubling — [9,18) → 1, [18,36) → 2,
 * [36,72) → 3, … — capped at `maxWorkers`.
 */
export function allowedSubagentWorkers(
	inFlight: number,
	maxWorkers: number,
	threshold = SUBAGENT_WORKER_THRESHOLD,
): number {
	const max = Math.max(0, Math.floor(maxWorkers));
	if (max === 0 || inFlight < threshold) return 0;
	return Math.min(max, Math.floor(Math.log2(inFlight / threshold)) + 1);
}

let nextThreadNumber = 1;

/** Options shared by standalone and pooled workers. */
export interface SubagentWorkerSpawnOptions {
	/** Bound on start-up (ready handshake + boot); default 30s. */
	readonly initTimeoutMs?: number;
	/** Main-side service hooks to install; defaults to `THREAD_SERVICES`. */
	readonly services?: readonly ThreadService[];
	/** Tests only: module to load instead of the subagent entry, bypassing the CLI worker host. */
	readonly entry?: URL;
	/**
	 * Pay the worker's one-time first-run costs after boot, before {@link SubagentWorker.ready}
	 * resolves. A failure is logged and leaves the worker usable (the first run pays instead).
	 */
	readonly warmUp?: (worker: SubagentWorker) => Promise<void>;
}

/** Options for one {@link SubagentWorker}. */
export interface SubagentWorkerOptions extends SubagentWorkerSpawnOptions {
	/** Called once after the worker died and its link closed. */
	readonly onExit?: (worker: SubagentWorker, reason: string) => void;
	/** Called after every run or hold starts or ends, and once the worker booted. */
	readonly onLoadChange?: (worker: SubagentWorker) => void;
}

function isFrame(value: unknown): value is RpcFrame {
	return typeof value === "object" && value !== null && typeof Reflect.get(value, "t") === "string";
}

function spawnBunWorker(entry: URL | undefined): Worker {
	if (entry) return new Worker(entry.href, { type: "module" });
	const hostEntry = workerHostEntry();
	return hostEntry
		? new Worker(hostEntry, { type: "module", argv: [SUBAGENT_WORKER_ARG] })
		: new Worker(new URL("./subagent-worker-entry.ts", import.meta.url).href, { type: "module" });
}

/** An idempotent release fn that runs `release` once. */
function once(release: () => void): () => void {
	let released = false;
	return () => {
		if (released) return;
		released = true;
		release();
	};
}

/** One subagent host worker thread and its RPC link. */
export class SubagentWorker implements WorkerPeer {
	/** Pool-unique id, never reused within the process. */
	readonly threadId: ThreadId;
	/** Link to the worker; closed when the worker dies. */
	readonly link: MainThreadLink;
	/** Resolves once the worker booted every service; rejects (and terminates the worker) on failure. */
	readonly ready: Promise<void>;
	readonly #worker: Worker;
	readonly #services: readonly ThreadService[];
	readonly #options: SubagentWorkerOptions;
	readonly #replyPort: MessagePort;
	readonly #handshake = Promise.withResolvers<void>();
	#runs = 0;
	#holds = 0;
	#booted = false;
	#exitReason: string | undefined;

	constructor(options: SubagentWorkerOptions = {}) {
		this.threadId = `w${nextThreadNumber++}`;
		this.#options = options;
		this.#services = options.services ?? THREAD_SERVICES;
		const worker = spawnBunWorker(options.entry);
		this.#worker = worker;
		// Unref'd until someone holds it: a booting spare never keeps the process alive.
		worker.unref();
		const channel = new MessageChannel();
		const counter = new SharedArrayBuffer(4);
		this.#replyPort = channel.port1;
		let frames: ((frame: RpcFrame) => void) | undefined;
		// Attached at spawn, before the link exists: the worker's log records arrive from its first module on.
		worker.addEventListener("message", (event: MessageEvent) => {
			const data: unknown = event.data;
			if (isFrame(data)) frames?.(data);
			else if (isSubagentWorkerLog(data)) receiveWorkerLog(this.threadId, data);
			else if (typeof data === "object" && data !== null && Reflect.get(data, "type") === "subagent-worker-ready")
				this.#handshake.resolve();
			else logger.warn("Subagent worker sent an unknown message", { threadId: this.threadId });
		});
		this.link = new RpcLink(
			{
				send: frame => worker.postMessage(frame),
				listen: handler => {
					frames = handler;
					return () => {
						if (frames === handler) frames = undefined;
					};
				},
			},
			{ name: `main↔${this.threadId}`, syncReplies: { port: channel.port1, counter: new Int32Array(counter) } },
		);
		worker.addEventListener("error", event => {
			const message = event.error instanceof Error ? event.error.message : event.message;
			this.#die(`worker crashed: ${message}`);
		});
		worker.addEventListener("messageerror", () => this.#die("worker sent an undeliverable message"));
		worker.addEventListener("close", event => this.#die(`worker exited with code ${event.code}`));
		this.#handshake.promise.catch(() => {});
		this.ready = this.#start(channel.port2, counter);
		// Callers that never await `ready` must not turn a failed start into an unhandled rejection.
		this.ready.catch(() => {});
	}

	/** Runs in flight here ({@link beginRun}); what pool placement balances. */
	get runs(): number {
		return this.#runs;
	}

	/** Runs plus resident holds ({@link retain}); a worker at 0 is idle. */
	get load(): number {
		return this.#runs + this.#holds;
	}

	/** Whether the worker finished booting and is still alive. */
	get booted(): boolean {
		return this.#booted && this.#exitReason === undefined;
	}

	/** Whether the worker is still running (starting or booted). */
	get alive(): boolean {
		return this.#exitReason === undefined;
	}

	/** Why the worker died, once it has. */
	get exitReason(): string | undefined {
		return this.#exitReason;
	}

	/**
	 * Hold the worker for a resident (an open session, a revive): keeps it and the process
	 * alive and its idle shutdown off, without counting for placement. The release fn is idempotent.
	 */
	retain(): () => void {
		this.#holds++;
		this.#loadChanged();
		return once(() => {
			this.#holds--;
			this.#loadChanged();
		});
	}

	/** Count one run in flight here (see {@link retain} for what holding implies); the end fn is idempotent. */
	beginRun(): () => void {
		this.#runs++;
		this.#loadChanged();
		return once(() => {
			this.#runs--;
			this.#loadChanged();
		});
	}

	/** Stop the worker; the link closes and exit hooks run with `reason`. Idempotent. */
	terminate(reason = "terminated"): void {
		this.#die(reason);
	}

	async #start(replyPort: MessagePort, counter: SharedArrayBuffer): Promise<void> {
		const timeoutMs = this.#options.initTimeoutMs ?? DEFAULT_INIT_TIMEOUT_MS;
		const deadline = Promise.withResolvers<never>();
		const timer = setTimeout(
			() => deadline.reject(new Error(`Subagent worker ${this.threadId} did not start within ${timeoutMs}ms`)),
			timeoutMs,
		);
		timer.unref();
		const startedAt = performance.now();
		let bootMs = 0;
		try {
			this.link.handle("ping", nonce => nonce);
			for (const service of this.#services) service.installMain?.(this);
			const init: SubagentWorkerInit = {
				type: "subagent-worker-init",
				threadId: this.threadId,
				replyPort,
				counter,
			};
			this.#worker.postMessage(init, [replyPort]);
			await Promise.race([this.#handshake.promise, deadline.promise]);
			const globals: Record<string, unknown> = {};
			for (const service of this.#services) {
				if (service.globals) globals[service.name] = service.globals(this);
			}
			await Promise.race([this.link.call("boot", globals), deadline.promise]);
			bootMs = performance.now() - startedAt;
			if (this.#options.warmUp) {
				try {
					await this.#options.warmUp(this);
				} catch (error) {
					if (this.#exitReason !== undefined) throw error;
					logger.warn("Subagent worker warm-up failed", { threadId: this.threadId, err: error });
				}
			}
		} catch (error) {
			const reason = `start failed: ${error instanceof Error ? error.message : String(error)}`;
			this.#die(reason);
			throw new Error(`Subagent worker ${this.threadId} ${reason}`, { cause: error });
		} finally {
			clearTimeout(timer);
		}
		this.#booted = true;
		logger.debug("Subagent worker booted", {
			threadId: this.threadId,
			bootMs: Math.round(bootMs),
			warmUpMs: Math.round(performance.now() - startedAt - bootMs),
		});
		this.#loadChanged();
	}

	#loadChanged(): void {
		if (this.#exitReason === undefined) {
			if (this.load > 0) this.#worker.ref();
			else this.#worker.unref();
		}
		try {
			this.#options.onLoadChange?.(this);
		} catch (error) {
			logger.error("Subagent worker load listener failed", { threadId: this.threadId, err: error });
		}
	}

	#die(reason: string): void {
		if (this.#exitReason !== undefined) return;
		this.#exitReason = reason;
		this.#worker.terminate();
		this.#handshake.reject(new Error(`Subagent worker ${this.threadId} exited before ready: ${reason}`));
		this.link.close(reason);
		this.#replyPort.close();
		for (const service of this.#services) {
			try {
				service.onWorkerExit?.(this, reason);
			} catch (error) {
				logger.error("Thread service onWorkerExit failed", {
					service: service.name,
					threadId: this.threadId,
					err: error,
				});
			}
		}
		try {
			this.#options.onExit?.(this, reason);
		} catch (error) {
			logger.error("Subagent worker exit listener failed", { threadId: this.threadId, err: error });
		}
	}
}

/** Where the pool placed one run; call {@link release} when the run ends. */
export interface SubagentPlacement {
	/** The worker the run goes to; `undefined` runs it on the main thread. */
	readonly worker: SubagentWorker | undefined;
	/** End the run's count; idempotent. */
	release(): void;
}

/** Options for {@link SubagentWorkerPool}. */
export interface SubagentWorkerPoolOptions {
	/** Live upper bound on workers, read on every placement (0 keeps every run on the main thread). */
	readonly maxWorkers: () => number;
	/** How long a worker without runs or resident sessions lives on before it terminates; default 60s. */
	readonly idleMs?: number;
	/** Concurrency at which the first worker is allowed; default {@link SUBAGENT_WORKER_THRESHOLD}. */
	readonly threshold?: number;
	/**
	 * Whether the main thread hosts runs; default true. Tests only: `false` places every run
	 * on a worker (at least one worker slot), so they can exercise worker routing serially.
	 */
	readonly hostsOnMain?: boolean;
	/**
	 * Options for every spawned worker. Its `warmUp` runs only on workers started ahead of
	 * demand ({@link SubagentWorkerPool.prewarm}); a worker a placement has to start cold
	 * goes straight to its run, which pays those first-run costs itself.
	 */
	readonly worker?: SubagentWorkerSpawnOptions;
}

/** Main-thread placement of subagent runs over the main thread and a pool of host workers. */
export class SubagentWorkerPool {
	readonly #options: SubagentWorkerPoolOptions;
	readonly #workers = new Map<ThreadId, SubagentWorker>();
	readonly #idleTimers = new Map<ThreadId, NodeJS.Timeout>();
	readonly #exitListeners = new Set<(worker: SubagentWorker, reason: string) => void>();
	/** Runs in flight on the main thread that count for placement ({@link beginMainRun}). */
	#mainRuns = 0;
	/** Prewarm spawns scheduled for the next macrotask. */
	#pendingSpawns = 0;
	#disposed = false;

	constructor(options: SubagentWorkerPoolOptions) {
		this.#options = options;
	}

	/** Runs in flight that main placed: its own counted runs plus the runs it sent to workers. */
	get runsInFlight(): number {
		let runs = this.#mainRuns;
		for (const worker of this.#workers.values()) runs += worker.runs;
		return runs;
	}

	/** Runs in flight on the main thread that count for placement. */
	get mainRuns(): number {
		return this.#mainRuns;
	}

	/**
	 * Place one run now, synchronously, so concurrent placements spread out and never
	 * over-spawn: among the main thread and the first {@link allowedSubagentWorkers} worker
	 * slots, the one with the fewest runs in flight, starting a worker for an empty slot.
	 * Ties go to an existing worker over the main thread (which also drives the TUI), and to
	 * the main thread over starting a worker. A worker placement's worker may still be
	 * starting; {@link settle} waits for it.
	 */
	place(): SubagentPlacement {
		if (this.#disposed) throw new Error("Subagent worker pool is disposed");
		const worker = this.#select();
		if (!worker) return { worker: undefined, release: this.beginMainRun() };
		return { worker, release: worker.beginRun() };
	}

	/** Wait until `placement`'s worker is ready; a failed start releases the placement and rejects. */
	async settle(placement: SubagentPlacement): Promise<SubagentPlacement> {
		const worker = placement.worker;
		if (!worker) return placement;
		try {
			await worker.ready;
		} catch (error) {
			placement.release();
			throw error;
		}
		return placement;
	}

	/** {@link place} then {@link settle}. */
	acquire(): Promise<SubagentPlacement> {
		return this.settle(this.place());
	}

	/**
	 * Count a run on the main thread that did not go through {@link place} (a follow-up turn
	 * of a main-homed session), so placement sees the main thread's real load. The end fn is
	 * idempotent.
	 */
	beginMainRun(): () => void {
		this.#mainRuns++;
		let ended = false;
		return () => {
			if (ended) return;
			ended = true;
			this.#mainRuns--;
		};
	}

	/**
	 * `expectedSpawns` spawns are imminent (a parent model is streaming the call): when they
	 * would bring the runs in flight into a bracket whose worker slot is empty, start that
	 * worker now, warmed, in the background (next macrotask, unref'd), so the placement finds
	 * it booted; an idle worker those spawns may use gets its idle countdown restarted.
	 */
	prewarm(expectedSpawns = 1): void {
		if (this.#disposed) return;
		const slots = this.#slots(this.runsInFlight + Math.max(1, expectedSpawns));
		let slot = 0;
		for (const worker of this.#workers.values()) {
			if (slot++ >= slots) break;
			if (worker.runs === 0) this.#onLoadChange(worker);
		}
		const missing = slots - this.#workers.size - this.#pendingSpawns;
		for (let i = 0; i < missing; i++) {
			this.#pendingSpawns++;
			setImmediate(() => {
				this.#pendingSpawns--;
				if (this.#disposed || this.#workers.size >= slots) return;
				this.#spawn(true);
			});
		}
	}

	/** The live worker with this thread id. */
	forThread(id: ThreadId): SubagentWorker | undefined {
		return this.#workers.get(id);
	}

	/** Snapshot of live workers (including ones still starting), in slot order. */
	workers(): SubagentWorker[] {
		return [...this.#workers.values()];
	}

	/** Observe worker deaths (crash, idle shutdown, dispose); returns an unsubscribe fn. */
	onWorkerExit(listener: (worker: SubagentWorker, reason: string) => void): () => void {
		this.#exitListeners.add(listener);
		return () => {
			this.#exitListeners.delete(listener);
		};
	}

	/** Terminate every worker; later placements throw. */
	dispose(): void {
		this.#disposed = true;
		for (const worker of [...this.#workers.values()]) worker.terminate("worker pool disposed");
	}

	/** Worker slots open to `inFlight` runs. */
	#slots(inFlight: number): number {
		const max = this.#options.maxWorkers();
		const slots = allowedSubagentWorkers(inFlight, max, this.#options.threshold);
		return this.#options.hostsOnMain === false && max >= 1 ? Math.max(1, slots) : slots;
	}

	/** See {@link place}; `undefined` is the main thread. */
	#select(): SubagentWorker | undefined {
		const slots = this.#slots(this.runsInFlight + 1);
		let least: SubagentWorker | undefined;
		let slot = 0;
		for (const worker of this.#workers.values()) {
			if (slot++ >= slots) break;
			if (!least || worker.runs < least.runs) least = worker;
		}
		const hostsOnMain = this.#options.hostsOnMain !== false;
		let fewest = least?.runs ?? Number.POSITIVE_INFINITY;
		let onMain = false;
		if (hostsOnMain && this.#mainRuns < fewest) {
			onMain = true;
			fewest = this.#mainRuns;
		}
		if (this.#workers.size < slots && fewest > 0) return this.#spawn(false);
		return onMain ? undefined : least;
	}

	/** Start a worker; `warm` ones run the configured warm-up before they report ready. */
	#spawn(warm: boolean): SubagentWorker {
		const worker = new SubagentWorker({
			...this.#options.worker,
			warmUp: warm ? this.#options.worker?.warmUp : undefined,
			onExit: (exited, reason) => this.#onExit(exited, reason),
			onLoadChange: changed => this.#onLoadChange(changed),
		});
		if (worker.alive) this.#workers.set(worker.threadId, worker);
		return worker;
	}

	#onLoadChange(worker: SubagentWorker): void {
		const timer = this.#idleTimers.get(worker.threadId);
		if (timer) {
			clearTimeout(timer);
			this.#idleTimers.delete(worker.threadId);
		}
		if (worker.load > 0 || !worker.alive) return;
		const idle = setTimeout(() => {
			this.#idleTimers.delete(worker.threadId);
			if (worker.load === 0) worker.terminate("idle");
		}, this.#options.idleMs ?? DEFAULT_IDLE_MS);
		idle.unref();
		this.#idleTimers.set(worker.threadId, idle);
	}

	#onExit(worker: SubagentWorker, reason: string): void {
		this.#workers.delete(worker.threadId);
		const timer = this.#idleTimers.get(worker.threadId);
		if (timer) {
			clearTimeout(timer);
			this.#idleTimers.delete(worker.threadId);
		}
		for (const listener of this.#exitListeners) {
			try {
				listener(worker, reason);
			} catch (error) {
				logger.error("Subagent worker pool exit listener failed", { threadId: worker.threadId, err: error });
			}
		}
	}
}

let processPool: SubagentWorkerPool | undefined;
let processPoolSettings: Settings | undefined;
/** The registry of the session about to spawn: its subagents mirror it, so warm-ups build that mirror. */
let processPoolRegistry: ModelRegistry | undefined;
let testPool: SubagentWorkerPool | undefined;

/**
 * The process-wide pool when worker mode is on: main thread, `task.workerThreads > 0`,
 * and a CLI worker host (or a pool injected by tests). `undefined` means run subagents in-process.
 */
export function subagentWorkerPool(settings: Settings): SubagentWorkerPool | undefined {
	if (testPool) return testPool;
	if (!isMainThread() || workerHostEntry() === null || cfgTaskWorkerThreads.get(settings) <= 0) return undefined;
	processPoolSettings = settings;
	if (!processPool) {
		const pool = new SubagentWorkerPool({
			maxWorkers: () => (processPoolSettings ? cfgTaskWorkerThreads.get(processPoolSettings) : 0),
			worker: {
				warmUp: async worker => {
					const registry = processPoolRegistry;
					// The warm-up session runs on the mirror, so build that first.
					if (registry) await prewarmModelRegistryMirror(worker, registry);
					// A run already waiting here pays the first-session costs itself, sooner than after a
					// throwaway session would: then only the discoveries it shares are warmed.
					await worker.link.call("warmUp", {
						cwd: getProjectDir(),
						settings: processPoolSettings,
						modelRegistry: worker.runs > 0 ? undefined : registry,
					});
				},
			},
		});
		processPool = pool;
		postmortem.register("subagent-worker-pool", () => pool.dispose(), { exitOnly: true });
	}
	return processPool;
}

/**
 * A main-thread session is about to spawn `expectedSpawns` subagents (its model is streaming
 * a spawning tool call): when worker mode is on and they will need a worker that is not
 * there yet, start it now, warmed with a mirror of `modelRegistry` (the registry its
 * subagents inherit), so the spawn lands on a booted worker; see
 * {@link SubagentWorkerPool.prewarm}. A no-op when worker mode is off.
 */
export function prewarmSubagentWorker(settings: Settings, modelRegistry: ModelRegistry, expectedSpawns: number): void {
	const pool = subagentWorkerPool(settings);
	if (!pool) return;
	processPoolRegistry = modelRegistry;
	pool.prewarm(expectedSpawns);
}

/**
 * The pool that may already host subagents (the test pool, or the process pool once
 * worker mode created it), without creating one. Main uses it to reach the home worker
 * of a worker-homed session.
 */
export function existingSubagentWorkerPool(): SubagentWorkerPool | undefined {
	return testPool ?? processPool;
}

/** Tests only: make {@link subagentWorkerPool} return `pool` regardless of settings or worker host; `undefined` restores. */
export function setSubagentWorkerPoolForTests(pool: SubagentWorkerPool | undefined): void {
	testPool = pool;
}

/** Smoke probe: spawn and boot one worker, ping through it (async + worker→main sync), terminate. */
export async function smokeTestSubagentWorker(): Promise<void> {
	const worker = new SubagentWorker();
	const release = worker.retain();
	try {
		await worker.ready;
		const nonce = Math.floor(Math.random() * 0x7fffffff);
		const echoed = await worker.link.call("ping", nonce);
		if (echoed !== nonce) throw new Error(`subagent worker smoke failed: ping returned ${echoed}, expected ${nonce}`);
	} finally {
		release();
		worker.terminate("smoke test done");
	}
}
