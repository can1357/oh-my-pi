/**
 * Keeps `transcripts.db` current from a worker thread: a sync reads whole
 * session files the first time, far too long for the UI thread. Each sync
 * runs on a fresh worker that exits when it is done.
 */
import { workerHostEntry } from "@oh-my-pi/pi-utils/worker-host";
import { TRANSCRIPT_INDEX_WORKER_ARG } from "../cli/worker-selectors";
import type { TranscriptSyncResult } from "./transcript-index";
import type { TranscriptIndexWorkerInbound, TranscriptIndexWorkerOutbound } from "./transcript-index-worker";

const SMOKE_TEST_TIMEOUT_MS = 30_000;

let inFlight: Promise<TranscriptSyncResult> | undefined;

/**
 * Spawns the worker and sends `request`; `onMessage` resolves the exchange.
 * Rejects when the worker fails or exits first, or `signal` aborts. The worker
 * is terminated once the exchange settles.
 */
async function exchange<T>(
	request: TranscriptIndexWorkerInbound,
	onMessage: (
		message: TranscriptIndexWorkerOutbound,
		resolve: (value: T) => void,
		reject: (error: Error) => void,
	) => void,
	signal?: AbortSignal,
): Promise<T> {
	const hostEntry = workerHostEntry();
	const worker = hostEntry
		? new Worker(hostEntry, { type: "module", argv: [TRANSCRIPT_INDEX_WORKER_ARG] })
		: new Worker(new URL("./transcript-index-worker.ts", import.meta.url).href, { type: "module" });
	const { promise, resolve, reject } = Promise.withResolvers<T>();
	worker.addEventListener("message", (event: MessageEvent<TranscriptIndexWorkerOutbound>) =>
		onMessage(event.data, resolve, reject),
	);
	worker.addEventListener("error", (event: ErrorEvent) =>
		reject(event.error instanceof Error ? event.error : new Error(event.message)),
	);
	worker.addEventListener("close", () => reject(new Error("transcript index worker exited unexpectedly")));
	signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
	worker.postMessage(request);
	try {
		return await promise;
	} finally {
		worker.terminate();
	}
}

/**
 * Brings the transcript index up to date on a worker thread. Joins the sync
 * this process already runs instead of starting another. Rejects when the
 * worker fails.
 */
export function syncTranscriptsInBackground(): Promise<TranscriptSyncResult> {
	inFlight ??= exchange<TranscriptSyncResult>({ type: "sync" }, (message, resolve, reject) => {
		if (message.type === "synced") resolve(message.result);
		else if (message.type === "error") reject(new Error(message.error));
	}).finally(() => {
		inFlight = undefined;
	});
	return inFlight;
}

/** `omp --smoke-test` probe: spawn the thread through the CLI host, ping, expect `pong`. */
export async function smokeTestTranscriptIndexWorker({
	timeoutMs = SMOKE_TEST_TIMEOUT_MS,
}: {
	timeoutMs?: number;
} = {}): Promise<void> {
	const label = "transcript index worker";
	try {
		await exchange<void>(
			{ type: "ping" },
			(message, resolve, reject) => {
				if (message.type === "pong") resolve();
				else reject(new Error(`${label}: expected pong, got ${JSON.stringify(message)}`));
			},
			AbortSignal.timeout(timeoutMs),
		);
	} catch (error) {
		if (error instanceof DOMException && error.name === "TimeoutError") {
			throw new Error(`${label} did not pong within ${timeoutMs}ms`);
		}
		throw error;
	}
}
