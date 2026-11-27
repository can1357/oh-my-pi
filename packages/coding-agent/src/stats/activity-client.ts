import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { DailyActivityPoint } from "@oh-my-pi/omp-stats/shared-types";
import { logger } from "@oh-my-pi/pi-utils";
import { TempDir } from "@oh-my-pi/pi-utils/temp";
import { workerHostEntry } from "@oh-my-pi/pi-utils/worker-host";
import { CURRENT_SESSION_VERSION, type ModelUsageEntry, type SessionHeader } from "../session/session-entries";
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
	env?: Record<string, string>,
): StatsActivityWorker {
	const hostEntry = workerHostEntry();
	const worker = hostEntry
		? new Worker(hostEntry, { type: "module", argv: [STATS_ACTIVITY_WORKER_ARG], env })
		: new Worker(new URL("./activity-worker.ts", import.meta.url).href, { type: "module", env });
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
export function loadDailyActivity(push: (points: DailyActivityPoint[]) => void, signal?: AbortSignal): Promise<void> {
	return loadActivity(push, signal);
}

async function loadActivity(
	push: (points: DailyActivityPoint[]) => void,
	signal?: AbortSignal,
	env?: Record<string, string>,
): Promise<void> {
	if (signal?.aborted) return;
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	const requestId = "load";
	const worker = spawnStatsActivityWorker(
		message => {
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
		},
		reject,
		env,
	);
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

/** `omp --smoke-test` probe: sync a fresh transcript and check the resulting heatmap. */
export async function smokeTestStatsActivityWorker({
	timeoutMs = SMOKE_TEST_TIMEOUT_MS,
}: {
	timeoutMs?: number;
} = {}): Promise<void> {
	// Bun's os.homedir() can ignore a worker's HOME override. Use a private
	// config root relative to the real home, not the user's profile or stats DB.
	const home = os.homedir();
	await fs.mkdir(home, { recursive: true });
	await using temp = await TempDir.create(path.join(home, ".omp-activity-smoke-"));
	const timestamp = new Date().toISOString();
	const header: SessionHeader = {
		type: "session",
		version: CURRENT_SESSION_VERSION,
		id: Bun.randomUUIDv7(),
		timestamp,
		cwd: temp.path(),
	};
	const usage: ModelUsageEntry = {
		type: "model_usage",
		id: "00000001",
		parentId: null,
		timestamp,
		purpose: "title",
		api: "openai-responses",
		provider: "openai",
		model: "gpt-5",
		stopReason: "stop",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	};
	// A new transcript forces Linux/Windows to spawn the nested sync worker;
	// an empty or already synced directory would never exercise that path.
	await Bun.write(
		temp.join("agent", "sessions", "fixture", `${header.id}.jsonl`),
		`${JSON.stringify(header)}\n${JSON.stringify(usage)}\n`,
	);

	const signal = AbortSignal.timeout(timeoutMs);
	let requests = 0;
	await loadActivity(
		points => {
			requests = points.reduce((sum, point) => sum + point.requests, 0);
		},
		signal,
		{ HOME: home, USERPROFILE: home, PI_CONFIG_DIR: path.basename(temp.path()) },
	);
	if (signal.aborted) throw new Error(`stats activity worker did not finish within ${timeoutMs}ms`);
	if (requests !== 1) throw new Error(`stats activity worker reported ${requests} requests for one fixture request`);
}
