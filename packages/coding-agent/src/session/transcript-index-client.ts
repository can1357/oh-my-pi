/**
 * Runs transcript index syncs on a worker thread: the first sync reads every
 * transcript, far too long for any event loop that serves others. The daemon's
 * `transcripts` module holds one {@link TranscriptIndexer} for every omp
 * process; a process the daemon cannot serve holds its own.
 */
import { workerHostEntry } from "@oh-my-pi/pi-utils/worker-host";
import { TRANSCRIPT_INDEX_WORKER_ARG } from "../cli/worker-selectors";
import type { TranscriptSyncResult } from "./transcript-index";
import type {
	TranscriptIndexWorkerInbound,
	TranscriptIndexWorkerOutbound,
	TranscriptSyncTarget,
} from "./transcript-index-worker";

const SMOKE_TEST_TIMEOUT_MS = 30_000;

interface PendingSync {
	resolve(result: TranscriptSyncResult): void;
	reject(error: Error): void;
}

/**
 * One worker thread running syncs. A sync asked for while one of the same store
 * runs joins it. The worker starts with the first sync and exits once none has
 * been pending for `idleMs`; it fails every pending sync when it dies.
 */
export class TranscriptIndexer {
	readonly #idleMs: number;
	#worker: Worker | undefined;
	#idleTimer: Timer | undefined;
	#nextId = 0;
	readonly #pending = new Map<number, PendingSync>();
	/** Running syncs by store path. */
	readonly #running = new Map<string, Promise<TranscriptSyncResult>>();

	constructor({ idleMs }: { idleMs: number }) {
		this.#idleMs = idleMs;
	}

	/** Brings `target.dbPath` up to date. Rejects when the worker fails or the indexer closes first. */
	sync(target: TranscriptSyncTarget): Promise<TranscriptSyncResult> {
		let running = this.#running.get(target.dbPath);
		if (!running) {
			running = this.#request(target).finally(() => this.#running.delete(target.dbPath));
			this.#running.set(target.dbPath, running);
		}
		return running;
	}

	/** Stops the worker; pending syncs reject. The next sync starts a new one. */
	close(): void {
		clearTimeout(this.#idleTimer);
		this.#idleTimer = undefined;
		const worker = this.#worker;
		this.#worker = undefined;
		worker?.terminate();
		this.#failPending(new Error("transcript indexer closed"));
	}

	#request(target: TranscriptSyncTarget): Promise<TranscriptSyncResult> {
		clearTimeout(this.#idleTimer);
		this.#idleTimer = undefined;
		const id = this.#nextId++;
		const { promise, resolve, reject } = Promise.withResolvers<TranscriptSyncResult>();
		this.#pending.set(id, { resolve, reject });
		this.#ensureWorker().postMessage({ type: "sync", id, target } satisfies TranscriptIndexWorkerInbound);
		return promise;
	}

	#ensureWorker(): Worker {
		if (this.#worker) return this.#worker;
		const worker = spawnWorker();
		worker.addEventListener("message", (event: MessageEvent<TranscriptIndexWorkerOutbound>) => {
			const message = event.data;
			if (message.type === "pong") return;
			const pending = this.#pending.get(message.id);
			if (!pending) return;
			this.#pending.delete(message.id);
			if (message.type === "synced") pending.resolve(message.result);
			else pending.reject(new Error(message.error));
			if (this.#pending.size === 0) this.#scheduleIdle();
		});
		const died = (error: Error) => {
			if (this.#worker !== worker) return;
			this.#worker = undefined;
			this.#failPending(error);
		};
		worker.addEventListener("error", (event: ErrorEvent) =>
			died(event.error instanceof Error ? event.error : new Error(event.message)),
		);
		worker.addEventListener("close", () => died(new Error("transcript index worker exited unexpectedly")));
		this.#worker = worker;
		return worker;
	}

	#scheduleIdle(): void {
		clearTimeout(this.#idleTimer);
		this.#idleTimer = setTimeout(() => {
			this.#idleTimer = undefined;
			if (this.#pending.size > 0) return;
			const worker = this.#worker;
			this.#worker = undefined;
			worker?.terminate();
		}, this.#idleMs);
		// An idle worker never holds its host open.
		this.#idleTimer.unref();
	}

	#failPending(error: Error): void {
		for (const pending of this.#pending.values()) pending.reject(error);
		this.#pending.clear();
	}
}

function spawnWorker(): Worker {
	const hostEntry = workerHostEntry();
	return hostEntry
		? new Worker(hostEntry, { type: "module", argv: [TRANSCRIPT_INDEX_WORKER_ARG] })
		: new Worker(new URL("./transcript-index-worker.ts", import.meta.url).href, { type: "module" });
}

/** `omp --smoke-test` probe: spawn the thread through the CLI host, ping, expect `pong`. */
export async function smokeTestTranscriptIndexWorker({
	timeoutMs = SMOKE_TEST_TIMEOUT_MS,
}: {
	timeoutMs?: number;
} = {}): Promise<void> {
	const label = "transcript index worker";
	const worker = spawnWorker();
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	const timer = setTimeout(() => reject(new Error(`${label} did not pong within ${timeoutMs}ms`)), timeoutMs);
	worker.addEventListener("message", (event: MessageEvent<TranscriptIndexWorkerOutbound>) => {
		if (event.data.type === "pong") resolve();
		else reject(new Error(`${label}: expected pong, got ${JSON.stringify(event.data)}`));
	});
	worker.addEventListener("error", (event: ErrorEvent) => reject(new Error(`${label}: ${event.message}`)));
	try {
		worker.postMessage({ type: "ping" } satisfies TranscriptIndexWorkerInbound);
		await promise;
	} finally {
		clearTimeout(timer);
		worker.terminate();
	}
}
