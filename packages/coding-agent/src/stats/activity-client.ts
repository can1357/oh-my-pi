import type { DailyActivityPoint } from "@oh-my-pi/omp-stats/shared-types";
import {
	createUnavailableWorker,
	createWorkerHandle,
	createWorkerSubprocess,
	logWorkerMessage,
	resolveWorkerSpawnCmd,
	SMOKE_TEST_TIMEOUT_MS,
	type SpawnedSubprocess,
	smokeTestWorker,
	spawnWorkerOrUnavailable,
	type WorkerHandle,
	workerEnvFromParent,
} from "../subprocess/worker-client";
import { safeSend } from "../utils/ipc";
import {
	STATS_ACTIVITY_WORKER_ARG,
	type StatsActivityWorkerInbound,
	type StatsActivityWorkerOutbound,
} from "./activity-protocol";

type StatsActivityWorkerHandle = WorkerHandle<StatsActivityWorkerInbound, StatsActivityWorkerOutbound>;

/**
 * Spawn the stats activity worker as a subprocess. Exported for the smoke
 * probe; production callers go through {@link loadDailyActivity}.
 */
export function createStatsActivitySubprocess(): SpawnedSubprocess<StatsActivityWorkerOutbound> {
	return createWorkerSubprocess<StatsActivityWorkerOutbound>({
		spawnCommand: resolveWorkerSpawnCmd(STATS_ACTIVITY_WORKER_ARG),
		env: workerEnvFromParent(),
		exitLabel: "stats activity subprocess",
		// One-shot: a request is always in flight until `terminate()`, so keep
		// the child referenced or an idle parent loop can starve its IPC reads.
		unref: false,
	});
}

function wrapSubprocess(spawned: SpawnedSubprocess<StatsActivityWorkerOutbound>): StatsActivityWorkerHandle {
	return createWorkerHandle<StatsActivityWorkerInbound, StatsActivityWorkerOutbound>(spawned, message =>
		safeSend(spawned.proc, message, "stats-activity"),
	);
}

function spawnStatsActivityWorker(): StatsActivityWorkerHandle {
	return spawnWorkerOrUnavailable(
		() => wrapSubprocess(createStatsActivitySubprocess()),
		createUnavailableWorker<StatsActivityWorkerInbound, StatsActivityWorkerOutbound>,
		"stats activity worker spawn failed; usage history unavailable",
	);
}

/**
 * Stream daily activity for the `/usage` heatmap from a one-shot subprocess:
 * `push` receives the cached DB rows first, then the refreshed rows after an
 * incremental session sync. Resolves once the sync settles and rejects when
 * the worker fails or dies; the child is SIGKILLed either way, and aborting
 * `signal` (dashboard closed) kills it mid-sync — per-file writes are
 * transactional and the OS-owned sync lock is released with the process.
 */
export async function loadDailyActivity(
	push: (points: DailyActivityPoint[]) => void,
	signal?: AbortSignal,
): Promise<void> {
	if (signal?.aborted) return;
	const worker = spawnStatsActivityWorker();
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	const requestId = "load";
	const offMessage = worker.onMessage(message => {
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
	});
	const offError = worker.onError(reject);
	const onAbort = (): void => resolve();
	signal?.addEventListener("abort", onAbort, { once: true });
	worker.send({ type: "load", id: requestId });
	try {
		await promise;
	} finally {
		signal?.removeEventListener("abort", onAbort);
		offMessage();
		offError();
		await worker.terminate();
	}
}

export async function smokeTestStatsActivityWorker({
	timeoutMs = SMOKE_TEST_TIMEOUT_MS,
}: {
	timeoutMs?: number;
} = {}): Promise<void> {
	await smokeTestWorker(wrapSubprocess(createStatsActivitySubprocess()), "stats activity worker", timeoutMs);
}
