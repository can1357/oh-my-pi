import type { DailyActivityPoint } from "@oh-my-pi/omp-stats/shared-types";
import { logger } from "@oh-my-pi/pi-utils";
import { workerHostEntry } from "@oh-my-pi/pi-utils/worker-host";
import {
	STATS_ACTIVITY_WORKER_ARG,
	type StatsActivityWorkerInbound,
	type StatsActivityWorkerOutbound,
} from "./activity-protocol";

const SMOKE_TEST_TIMEOUT_MS = 30_000;

interface StatsActivityWorker {
	send(message: StatsActivityWorkerInbound): void;
	terminate(): void;
}

/**
 * Spawn the stats activity worker thread and route its messages. `onMessage`
 * receives every outbound message; `onFailure` fires when the worker throws or
 * exits before `terminate()`.
 */
function spawnStatsActivityWorker(
	onMessage: (message: StatsActivityWorkerOutbound) => void,
	onFailure: (error: Error) => void,
): StatsActivityWorker {
	const hostEntry = workerHostEntry();
	const worker = hostEntry
		? new Worker(hostEntry, { type: "module", argv: [STATS_ACTIVITY_WORKER_ARG] })
		: new Worker(new URL("./activity-worker.ts", import.meta.url).href, { type: "module" });
	let terminated = false;
	worker.addEventListener("message", (event: MessageEvent<StatsActivityWorkerOutbound>) => onMessage(event.data));
	worker.addEventListener("error", (event: ErrorEvent) => {
		onFailure(event.error instanceof Error ? event.error : new Error(event.message));
	});
	worker.addEventListener("close", () => {
		if (!terminated) onFailure(new Error("stats activity worker exited unexpectedly"));
	});
	return {
		send: message => worker.postMessage(message),
		terminate: () => {
			terminated = true;
			worker.terminate();
		},
	};
}

function logWorkerMessage(message: Extract<StatsActivityWorkerOutbound, { type: "log" }>): void {
	if (message.level === "debug") logger.debug(message.msg, message.meta);
	else if (message.level === "warn") logger.warn(message.msg, message.meta);
	else logger.error(message.msg, message.meta);
}

/**
 * Stream daily activity for the `/usage` heatmap from a one-shot worker thread:
 * `push` receives the cached DB rows first, then the refreshed rows after an
 * incremental session sync. Resolves once the sync settles and rejects when
 * the worker cannot start, fails, or dies; the worker is terminated either way, and aborting
 * `signal` (dashboard closed) terminates it mid-sync — per-file writes are
 * transactional.
 */
export async function loadDailyActivity(
	push: (points: DailyActivityPoint[]) => void,
	signal?: AbortSignal,
): Promise<void> {
	if (signal?.aborted) return;
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	const requestId = "load";
	const worker = spawnStatsActivityWorker(message => {
		switch (message.type) {
			case "activity":
				if (message.id === requestId) push(message.points);
				return;
			case "done":
				resolve();
				return;
			case "error":
				reject(new Error(message.error));
				return;
			case "log":
				logWorkerMessage(message);
				return;
		}
	}, reject);
	const onAbort = (): void => resolve();
	signal?.addEventListener("abort", onAbort, { once: true });
	worker.send({ type: "load", id: requestId });
	try {
		await promise;
	} finally {
		signal?.removeEventListener("abort", onAbort);
		worker.terminate();
	}
}

/** `omp --smoke-test` probe: spawn the thread through the CLI host, ping, expect `pong`. */
export async function smokeTestStatsActivityWorker({
	timeoutMs = SMOKE_TEST_TIMEOUT_MS,
}: {
	timeoutMs?: number;
} = {}): Promise<void> {
	const label = "stats activity worker";
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	const timer = setTimeout(() => reject(new Error(`${label} did not pong within ${timeoutMs}ms`)), timeoutMs);
	const worker = spawnStatsActivityWorker(message => {
		if (message.type === "pong") resolve();
		else if (message.type !== "log") reject(new Error(`${label}: expected pong, got ${JSON.stringify(message)}`));
	}, reject);
	try {
		worker.send({ type: "ping", id: "smoke" });
		await promise;
	} finally {
		clearTimeout(timer);
		worker.terminate();
	}
}
