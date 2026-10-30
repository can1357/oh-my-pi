import * as fs from "node:fs";
import * as path from "node:path";
import { getAgentDbPath, getStatsDbPath, workerHostEntry } from "@oh-my-pi/pi-utils";
import { withFileLock } from "@oh-my-pi/pi-utils/file-lock";
import {
	applySessionParseResults,
	completeSessionSync,
	getRecentErrors as dbGetRecentErrors,
	getRecentRequests as dbGetRecentRequests,
	type FileOffset,
	getFileOffsets,
	getMessageById,
	getMessageCount,
	initDb,
	markSessionBackfillsComplete,
	type ParsedSession,
	prepareSessionSync,
} from "./db";
import {
	getSessionEntry,
	listAllSessionFiles,
	matchesSessionFile,
	type ParseSessionResult,
	parseSessionFile,
	type SessionParserState,
} from "./parser";
import {
	getCostTimeSeries,
	getModelPerformanceSeries,
	getModelTimeSeries,
	getOverallStats,
	getProviderHourlyBurn,
	getProviderTimeSeries,
	getStatsByAgentType,
	getStatsByFolder,
	getStatsByModel,
	getStatsByProvider,
	getTimeSeries,
	getToolStats,
	getToolStatsByModel,
	getToolTimeSeries,
	type RangeWindow,
} from "./rollup";
import type { SyncWorkerRequest, SyncWorkerResponse } from "./sync-worker";
// Coding-agent binary/bundle workers route through the CLI entrypoint with a
// hidden argv mode, so the compiled binary and npm bundle only need one
// JavaScript entry. Standalone source `omp-stats` keeps using this package's
// own sync-worker source file.
import type {
	DashboardStats,
	FolderStats,
	MessageStats,
	ProviderDashboardStats,
	ProviderWindowStats,
	RequestDetails,
	ToolDashboardStats,
} from "./types";
import { computeUsageWindowStats, fetchUsageData, type UsageDataSnapshot } from "./usage-windows";

const STATS_SYNC_LOCK_RETRY_MS = 25;
const STATS_SYNC_LOCK_WAIT_MS = 60 * 60 * 1000;
// Bound queued results by both file count and derived rows; never hold a SQLite transaction across I/O.
const SYNC_BATCH_FILES = 512;
const SYNC_BATCH_ROWS = 8192;
const SYNC_METADATA_FILES = 128;
const SYNC_INLINE_READS = 8;

/**
 * Serialize stats ingestion and archive reconciliation across processes.
 * The lock covers file discovery, parsing, and the final SQLite write so a
 * parse result for a session moved by GC can never commit after cleanup.
 * The native lock is owned by an operating-system primitive, so an interrupted
 * owner is released automatically and a live owner is never displaced.
 */
export async function withStatsSyncLock<T>(dbPath: string, fn: () => Promise<T>): Promise<T> {
	await fs.promises.mkdir(path.dirname(dbPath), { recursive: true });
	return await withFileLock(`${dbPath}.sync`, fn, {
		retryDelayMs: STATS_SYNC_LOCK_RETRY_MS,
		retries: Math.ceil(STATS_SYNC_LOCK_WAIT_MS / STATS_SYNC_LOCK_RETRY_MS),
	});
}

/**
 * Progress event emitted after each session file is fully processed.
 * `current` is the number of files completed (skipped + parsed),
 * `total` is the size of the work set. `processed` is the running total
 * of inserted rows. Parsed files are reported only after their batch commits.
 * `changes` is the running total of stored rows the sync inserted, updated or
 * deleted (0 while every transcript is unchanged).
 */
export interface SyncProgress {
	current: number;
	total: number;
	processed: number;
	changes: number;
	sessionFile: string;
}

export interface SyncOptions {
	/** Called after each file completes. Synchronous; keep it cheap. */
	onProgress?: (event: SyncProgress) => void;
	/**
	 * Worker pool size. Defaults to a sensible value derived from the host
	 * (capped to avoid drowning a small machine in workers). Set to `1` to
	 * parse on the calling thread without spawning workers. File I/O is pipelined.
	 */
	workers?: number;
	/**
	 * Sync only these transcripts (e.g. files a watcher saw change) instead of
	 * listing every session. Missing files are skipped.
	 */
	files?: readonly string[];
}

function defaultWorkerCount(): number {
	// Bun 1.3.x can abort the macOS process when stats sync workers re-enter
	// the compiled `omp` binary. Keep macOS on the documented serial path.
	if (process.platform === "darwin") return 1;
	// `navigator.hardwareConcurrency` is the portable answer in Bun; fall
	// back to a small fixed pool if it's somehow unavailable.
	const hw = typeof navigator !== "undefined" ? (navigator.hardwareConcurrency ?? 0) : 0;
	const raw = hw > 0 ? hw : 4;
	// Cap at 8 - parse is JSON-bound, and SQLite writes serialize on main
	// thread anyway, so more workers stop helping.
	return Math.min(8, Math.max(2, Math.floor(raw)));
}

interface WorkerHandle {
	worker: Worker;
	busy: boolean;
	resolve: ((res: ParseSessionResult) => void) | null;
	reject: ((err: Error) => void) | null;
}

/**
 * Create a fresh sync worker. When the process was started from a
 * self-dispatching CLI entry (omp in source, npm-bundle, or compiled form),
 * re-enter that entry with a worker argv selector; otherwise (standalone
 * omp-stats, bun test, SDK embedding) load the worker module directly, so this
 * package keeps zero runtime dependency on `@oh-my-pi/pi-coding-agent`.
 */
function createSyncWorker(): Worker {
	const hostEntry = workerHostEntry();
	if (hostEntry) {
		return new Worker(hostEntry, { type: "module", argv: ["__omp_worker_stats_sync"] });
	}
	return new Worker(new URL("./sync-worker.ts", import.meta.url).href, { type: "module" });
}

function spawnWorker(): WorkerHandle {
	const worker = createSyncWorker();
	const handle: WorkerHandle = { worker, busy: false, resolve: null, reject: null };
	worker.onmessage = (event: MessageEvent<SyncWorkerResponse>) => {
		const { resolve, reject } = handle;
		handle.resolve = null;
		handle.reject = null;
		handle.busy = false;
		if (!resolve || !reject) return;
		const data = event.data;
		if (!data.ok) {
			reject(new Error(data.error));
			return;
		}
		if (data.kind === "pong") {
			reject(new Error("sync worker: unexpected pong on parse channel"));
			return;
		}
		resolve(data.result);
	};
	worker.onerror = (event: ErrorEvent) => {
		const { reject } = handle;
		handle.resolve = null;
		handle.reject = null;
		handle.busy = false;
		reject?.(event.error instanceof Error ? event.error : new Error(event.message || "worker error"));
	};
	return handle;
}

function dispatch(handle: WorkerHandle, request: SyncWorkerRequest): Promise<ParseSessionResult> {
	if (handle.busy) {
		return Promise.reject(new Error("worker is busy - this is a bug in the dispatcher"));
	}
	const { promise, resolve, reject } = Promise.withResolvers<ParseSessionResult>();
	handle.busy = true;
	handle.resolve = resolve;
	handle.reject = reject;
	handle.worker.postMessage(request);
	return promise;
}

/**
 * Smoke test: spawns one sync worker, pings it, asserts the pong response,
 * then terminates. Used by `omp --smoke-test` so the install-method CI jobs
 * catch the silent worker-load failure that hit compiled binaries in #1011
 * and #1027 — neither `--version` nor `stats --summary` exercises the worker
 * spawn path on a fresh install (no session files = early return), so a
 * dedicated probe is the only reliable signal.
 *
 * No-op on darwin: `syncAllSessions` keeps macOS on the serial parser path
 * (see {@link defaultWorkerCount}) so the worker spawn surface is unreachable
 * from the CLI, and probing it under the hardened runtime in
 * `scripts/ci-macos-sign.sh` would re-enter the Bun-worker abort surface that
 * motivated the darwin serial default in the first place.
 *
 * Rejects on transport error, error response, or timeout.
 */
export async function smokeTestSyncWorker({ timeoutMs = 5_000 }: { timeoutMs?: number } = {}): Promise<void> {
	if (process.platform === "darwin") return;
	const worker = createSyncWorker();
	const { promise, resolve, reject } = Promise.withResolvers<void>();
	const timer = setTimeout(() => reject(new Error(`sync worker did not pong within ${timeoutMs}ms`)), timeoutMs);
	worker.onmessage = (event: MessageEvent<SyncWorkerResponse>) => {
		const data = event.data;
		if (!data.ok) {
			reject(new Error(data.error));
			return;
		}
		if (data.kind !== "pong") {
			reject(new Error(`sync worker: expected pong, got ${JSON.stringify(data)}`));
			return;
		}
		resolve();
	};
	worker.onerror = (event: ErrorEvent) => {
		reject(event.error instanceof Error ? event.error : new Error(event.message || "worker error"));
	};
	try {
		worker.postMessage({ kind: "ping" } satisfies SyncWorkerRequest);
		await promise;
	} finally {
		clearTimeout(timer);
		worker.terminate();
	}
}

/**
 * Sync all session files to the database.
 *
 * `workers: 1` pipelines file reads and parses inline, committing in discovery order.
 * Larger pools fan parsing out across workers
 * (one in-flight job per worker) while DB writes and offset bookkeeping stay on
 * the calling thread. Bounded batches commit rows and cursors atomically without
 * holding a database transaction open during file I/O.
 * `onProgress` fires once per completed file (skipped files included so the
 * bar walks at a steady rate).
 */
export async function syncAllSessions(opts?: SyncOptions): Promise<{ processed: number; files: number }> {
	return withStatsSyncLock(getStatsDbPath(), async () => {
		let processed = 0;
		let files = 0;
		while (true) {
			const result = await syncAllSessionsLocked(opts);
			processed += result.processed;
			files += result.files;
			if (!result.reconcile) return { processed, files };
		}
	});
}

/** Recency tiers for {@link orderForIngest}, newest first. */
const INGEST_TIERS_MS = [24 * 60 * 60 * 1000, 7 * 24 * 60 * 60 * 1000];

/**
 * Order a full sync so recent activity lands first: transcripts modified in
 * the last day, then the last week, then the rest. Within a tier files go in
 * creation order, so a fork still follows its parent and the parent keeps
 * ownership of the entries the fork copied (first writer wins). The only
 * exception is a from-scratch ingest where a fork was touched more recently
 * than a parent idle for a day: the fork then owns the copied entries, which
 * changes per-session attribution but never totals.
 */
async function orderForIngest(files: string[]): Promise<string[]> {
	const now = Date.now();
	const ranked: { file: string; tier: number; born: number; index: number }[] = [];
	for (let start = 0; start < files.length; start += SYNC_METADATA_FILES) {
		const batch = files.slice(start, start + SYNC_METADATA_FILES);
		const stats = await Promise.all(batch.map(file => fs.promises.stat(file).catch(() => null)));
		for (let i = 0; i < batch.length; i++) {
			const stat = stats[i];
			const age = stat ? now - stat.mtimeMs : Number.POSITIVE_INFINITY;
			const tier = INGEST_TIERS_MS.findIndex(limit => age <= limit);
			ranked.push({
				file: batch[i],
				tier: tier === -1 ? INGEST_TIERS_MS.length : tier,
				born: stat ? stat.birthtimeMs || stat.ctimeMs : 0,
				index: start + i,
			});
		}
	}
	ranked.sort((a, b) => a.tier - b.tier || a.born - b.born || a.index - b.index);
	return ranked.map(entry => entry.file);
}

async function syncAllSessionsLocked(
	opts?: SyncOptions,
): Promise<{ processed: number; files: number; reconcile: boolean }> {
	await initDb();
	const replay = prepareSessionSync();

	const files = opts?.files ?? (await orderForIngest(await listAllSessionFiles()));
	let totalProcessed = 0;
	let totalChanges = 0;
	let filesProcessed = 0;
	let completed = 0;
	let cursor = 0;
	let reconcile = false;
	let pending: ParsedSession[] = [];
	let pendingRows = 0;
	let failed = false;
	let metadataStart = 0;
	let metadataEnd = 0;
	let metadata: Promise<{ fileStats?: fs.Stats; stored?: FileOffset }[]> = Promise.resolve([]);

	const report = (sessionFile: string) => {
		completed++;
		opts?.onProgress?.({
			current: completed,
			total: files.length,
			processed: totalProcessed,
			changes: totalChanges,
			sessionFile,
		});
	};

	const flush = () => {
		if (pending.length === 0) return;
		const batch = pending;
		const applied = applySessionParseResults(batch);
		pending = [];
		pendingRows = 0;
		totalProcessed += applied.processed;
		totalChanges += applied.changes;
		filesProcessed += applied.files;
		reconcile ||= applied.reconcile;
		// Report only durable progress: callbacks may interrupt the sync.
		for (const { sessionFile } of batch) report(sessionFile);
	};

	const finish = () => {
		flush();
		// A targeted sync cannot settle reconciliation or backfills (they need
		// every transcript); leave their markers for the next full sync.
		if (opts?.files) return { processed: totalProcessed, files: filesProcessed, reconcile: false };
		completeSessionSync(reconcile);
		markSessionBackfillsComplete();
		return { processed: totalProcessed, files: filesProcessed, reconcile };
	};
	if (files.length === 0) return finish();

	const prepareFile = async (
		index: number,
		parse: (
			sessionFile: string,
			fromOffset: number,
			state?: SessionParserState,
			replay?: boolean,
		) => Promise<ParseSessionResult>,
	): Promise<ParsedSession | null> => {
		if (index >= metadataEnd) {
			const batch = files.slice(index, index + SYNC_METADATA_FILES);
			const offsets = getFileOffsets(batch);
			metadataStart = index;
			metadataEnd = index + batch.length;
			metadata = Promise.all(
				batch.map(async sessionFile => {
					const stored = offsets.get(sessionFile);
					try {
						return { fileStats: await fs.promises.stat(sessionFile), stored };
					} catch {
						return {};
					}
				}),
			);
		}
		// Capture the position before awaiting: another worker can start the next metadata batch.
		const metadataIndex = index - metadataStart;
		const { fileStats, stored } = (await metadata)[metadataIndex];
		if (failed || !fileStats) return null;
		if (
			!replay &&
			stored?.parserState &&
			stored.lastModified === fileStats.mtimeMs &&
			stored.parserState.size === fileStats.size &&
			matchesSessionFile(stored.parserState, fileStats)
		) {
			return null;
		}

		const sessionFile = files[index];
		const unknownIdentity = stored !== undefined && !stored.parserState;
		const fromOffset = unknownIdentity ? 0 : (stored?.offset ?? 0);
		const result = await parse(sessionFile, fromOffset, stored?.parserState, replay);
		if (unknownIdentity && result.parserState) result.reset = true;
		return {
			sessionFile,
			result,
			// During a full replay, a changed file can be a rewrite even if its old tail checkpoint matches.
			rebuild:
				!stored?.parserState ||
				(replay &&
					(result.parserState?.size !== stored.parserState.size ||
						result.parserState?.mtimeMs !== stored.parserState.mtimeMs)),
			replay,
		};
	};

	const acceptFile = (sessionFile: string, parsed: ParsedSession | null) => {
		if (!parsed) {
			report(sessionFile);
			return;
		}
		pending.push(parsed);
		const { result } = parsed;
		pendingRows +=
			result.stats.length +
			result.userStats.length +
			result.userLinks.length +
			result.toolCalls.length +
			result.toolResults.length;
		if (pending.length >= SYNC_BATCH_FILES || pendingRows >= SYNC_BATCH_ROWS) flush();
	};

	let requestedWorkers = Math.max(1, Math.floor(opts?.workers ?? defaultWorkerCount()));
	// A few already-tracked transcripts (the watcher's usual work) need only
	// kilobyte tail reads: parsing them inline beats starting a worker.
	if (requestedWorkers > 1 && opts?.workers === undefined && files.length <= SYNC_INLINE_READS) {
		const offsets = getFileOffsets([...files]);
		if (files.every(file => offsets.get(file)?.parserState)) requestedWorkers = 1;
	}
	if (requestedWorkers === 1) {
		for (let start = 0; start < files.length; start += SYNC_INLINE_READS) {
			const results = await Promise.allSettled(
				Array.from({ length: Math.min(SYNC_INLINE_READS, files.length - start) }, (_, offset) =>
					prepareFile(start + offset, parseSessionFile),
				),
			);
			// Preserve fork ownership order and drain reads before a callback can release the sync lock.
			for (let offset = 0; offset < results.length; offset++) {
				const result = results[offset];
				if (result.status === "rejected") throw result.reason;
				acceptFile(files[start + offset], result.value);
			}
		}
		return finish();
	}

	const poolSize = Math.min(files.length, requestedWorkers);

	const handles: WorkerHandle[] = [];

	// Each lane spawns its worker on its first real parse, so unchanged transcripts cost no worker.
	async function drain(): Promise<void> {
		let handle: WorkerHandle | null = null;
		try {
			while (!failed) {
				const idx = cursor++;
				if (idx >= files.length) return;
				const parsed = await prepareFile(idx, (file, fromOffset, parserState, replay) => {
					if (!handle) {
						handle = spawnWorker();
						handles.push(handle);
					}
					return dispatch(handle, { sessionFile: file, fromOffset, parserState, replay });
				});
				if (!failed) acceptFile(files[idx], parsed);
			}
		} catch (error) {
			failed = true;
			throw error;
		}
	}

	try {
		// Drain in-flight work before releasing the sync lock, even after a failed batch.
		const results = await Promise.allSettled(Array.from({ length: poolSize }, drain));
		for (const result of results) {
			if (result.status === "rejected") throw result.reason;
		}
	} finally {
		for (const handle of handles) handle.worker.terminate();
	}

	return finish();
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

type TimeRange = "1h" | "24h" | "7d" | "30d" | "90d" | "all";

const DEFAULT_TIME_RANGE: TimeRange = "24h";

/** Span and series bucket per range; mirrored by the client's `data/range.ts`. */
const TIME_RANGES: Record<TimeRange, { spanMs: number | null; bucketMs: number }> = {
	"1h": { spanMs: HOUR_MS, bucketMs: 5 * 60 * 1000 },
	"24h": { spanMs: DAY_MS, bucketMs: HOUR_MS },
	"7d": { spanMs: 7 * DAY_MS, bucketMs: DAY_MS },
	"30d": { spanMs: 30 * DAY_MS, bucketMs: DAY_MS },
	"90d": { spanMs: 90 * DAY_MS, bucketMs: DAY_MS },
	all: { spanMs: null, bucketMs: DAY_MS },
};

/** Most folders the projects payload carries (busiest first); the tail is thousands of temp dirs. */
const FOLDER_LIMIT = 2000;

/** Resolve a `?range=` value (default 24h) to its cutoff and series bucket size. */
export function getTimeRangeConfig(range?: string | null): RangeWindow {
	const normalized = range?.trim().toLowerCase() ?? DEFAULT_TIME_RANGE;
	const config = TIME_RANGES[normalized as TimeRange] ?? TIME_RANGES[DEFAULT_TIME_RANGE];
	return {
		cutoff: config.spanMs === null ? null : Date.now() - config.spanMs,
		bucketMs: config.bucketMs,
	};
}

/**
 * Get all dashboard stats.
 */
export async function getDashboardStats(range?: string | null): Promise<DashboardStats> {
	await initDb();
	const window = getTimeRangeConfig(range);
	return {
		overall: getOverallStats(window.cutoff),
		byModel: getStatsByModel(window.cutoff),
		byFolder: getStatsByFolder(window.cutoff, FOLDER_LIMIT),
		byAgentType: getStatsByAgentType(window.cutoff),
		timeSeries: getTimeSeries(window),
		modelSeries: getModelTimeSeries(window),
		modelPerformanceSeries: getModelPerformanceSeries(window),
		costSeries: getCostTimeSeries(window.cutoff),
	};
}

export async function getOverviewStats(
	range?: string | null,
): Promise<Pick<DashboardStats, "overall" | "byAgentType" | "timeSeries">> {
	await initDb();
	const window = getTimeRangeConfig(range);
	return {
		overall: getOverallStats(window.cutoff),
		byAgentType: getStatsByAgentType(window.cutoff),
		timeSeries: getTimeSeries(window),
	};
}

export async function getModelDashboardStats(
	range?: string | null,
): Promise<Pick<DashboardStats, "byModel" | "modelSeries" | "modelPerformanceSeries">> {
	await initDb();
	const window = getTimeRangeConfig(range);
	return {
		byModel: getStatsByModel(window.cutoff),
		modelSeries: getModelTimeSeries(window),
		modelPerformanceSeries: getModelPerformanceSeries(window),
	};
}

export async function getCostDashboardStats(range?: string | null): Promise<Pick<DashboardStats, "costSeries">> {
	await initDb();
	return { costSeries: getCostTimeSeries(getTimeRangeConfig(range).cutoff) };
}

export async function getFolderStats(range?: string | null): Promise<FolderStats[]> {
	await initDb();
	return getStatsByFolder(getTimeRangeConfig(range).cutoff, FOLDER_LIMIT);
}

export async function getRecentRequests(limit?: number): Promise<MessageStats[]> {
	await initDb();
	return dbGetRecentRequests(limit);
}

export async function getRecentErrors(range?: string | null, limit?: number): Promise<MessageStats[]> {
	await initDb();
	return dbGetRecentErrors(limit, getTimeRangeConfig(range).cutoff);
}

export async function getRequestDetails(id: number): Promise<RequestDetails | null> {
	await initDb();
	const msg = getMessageById(id);
	if (!msg) return null;

	const entry = await getSessionEntry(msg.sessionFile, msg.entryId);
	// Role-model attempts (judge, auto-thinking, …) journal only a `model_usage`
	// record: usage and outcome, no request or response payload.
	if (entry?.type === "model_usage") return { ...msg, messages: [entry], output: null };
	if (entry?.type !== "message" || !("message" in entry)) return null;

	return {
		...msg,
		messages: [entry],
		output: entry.message,
	};
}

/**
 * Get the current message count in the database.
 */
export async function getTotalMessageCount(): Promise<number> {
	await initDb();
	return getMessageCount();
}

/**
 * Get the tools dashboard payload: per-tool totals, per-(tool, model)
 * breakdown, and the call time series.
 */
export async function getToolDashboardStats(range?: string | null): Promise<ToolDashboardStats> {
	await initDb();
	const window = getTimeRangeConfig(range);
	return {
		byTool: getToolStats(window.cutoff),
		byToolModel: getToolStatsByModel(window.cutoff),
		series: getToolTimeSeries(window),
	};
}

/**
 * Get the providers dashboard payload: per-provider totals, peak-burn-hours
 * histogram and provider token time series. Subscription windows are served
 * separately by {@link getProviderWindowStats}.
 */
export async function getProviderDashboardStats(range?: string | null): Promise<ProviderDashboardStats> {
	await initDb();
	const window = getTimeRangeConfig(range);
	return {
		providers: getStatsByProvider(window.cutoff),
		hourly: getProviderHourlyBurn(window.cutoff),
		series: getProviderTimeSeries(window),
	};
}

const USAGE_CACHE_TTL_MS = 60_000;
let usageCache: { key: string; at: number; data: Promise<UsageDataSnapshot> } | null = null;

/**
 * Usage snapshots since `sinceMs`, memoized for a minute per hour-aligned
 * cutoff and source database: the broker fetch takes seconds and the
 * dashboard asks on every range switch and live refresh.
 */
function cachedUsageData(sinceMs: number): Promise<UsageDataSnapshot> {
	const sinceHour = Math.floor(sinceMs / HOUR_MS) * HOUR_MS;
	const key = `${getAgentDbPath()}:${sinceHour}`;
	const now = Date.now();
	if (usageCache?.key === key && now - usageCache.at < USAGE_CACHE_TTL_MS) {
		return usageCache.data;
	}
	const data = fetchUsageData(sinceHour);
	usageCache = { key, at: now, data };
	data.catch(() => {
		if (usageCache?.data === data) usageCache = null;
	});
	return data;
}

/**
 * Subscription-window analytics derived from recorded usage-limit snapshots:
 * insights for every provider window, plus utilization series for `provider`
 * only (all series can number in the thousands).
 *
 * Window token estimates use broker-held fleet token burn when a broker is
 * configured — the window fractions cover every install sharing the broker's
 * credentials, so dividing them into local-only tokens would undercount.
 */
export async function getProviderWindowStats(
	range?: string | null,
	provider?: string | null,
): Promise<ProviderWindowStats> {
	await initDb();
	const { cutoff } = getTimeRangeConfig(range);
	const usage = await cachedUsageData(cutoff ?? 0);
	const tokensByProvider =
		usage.fleetTokensByProvider ?? new Map(getStatsByProvider(cutoff).map(p => [p.provider, p.totalTokens]));
	const { usageSeries, windowInsights } = computeUsageWindowStats(usage.rows, tokensByProvider);
	return {
		windowInsights,
		usageSeries: provider ? usageSeries.filter(series => series.provider === provider) : [],
	};
}
