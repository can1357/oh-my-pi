/**
 * Live ingest for a running dashboard: background session sync, rollup
 * refresh, and a status stream the client subscribes to (`/api/events`).
 *
 * The dashboard never waits for ingest. {@link StatsLive.start} kicks a full
 * sync in the background and watches the sessions directory; changed
 * transcripts are re-synced (only those files) shortly after they are written.
 * Every committed batch bumps {@link LiveStatus.version} (throttled), so open
 * pages refetch and fill in while parsing is still running.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { getSessionsDir, logger } from "@oh-my-pi/pi-utils";
import { syncAllSessions } from "./aggregator";
import { initDb } from "./db";
import { getRollupStatus, refreshRollups } from "./rollup";
import type { LiveStatus, LiveSyncStatus } from "./shared-types";

/** Wait this long after the last transcript write before syncing it. */
const WATCH_DEBOUNCE_MS = 800;
/** Full resync cadence, catching anything the watcher missed (or everything, without one). */
const FULL_SYNC_INTERVAL_MS = 5 * 60 * 1000;
/** Minimum spacing of `version` bumps; each bump makes open pages refetch. */
const VERSION_THROTTLE_MS = 1000;
/** Delay before retrying a failed sync (typically a lock held by another omp process). */
const SYNC_RETRY_MS = 10_000;
/** Minimum spacing of progress-only status events. */
const PROGRESS_THROTTLE_MS = 150;

type Listener = (status: LiveStatus) => void;

/** One per process; owned by the dashboard server (see `startServer`). */
export class StatsLive {
	#version = 1;
	#sync: LiveSyncStatus = { phase: "idle", current: 0, total: 0, processed: 0, lastSyncedAt: null, error: null };
	#indexingHours = 0;
	#listeners = new Set<Listener>();

	#started = false;
	#watcher: fs.FSWatcher | null = null;
	#fullSyncTimer: NodeJS.Timeout | null = null;
	#debounceTimer: NodeJS.Timeout | null = null;
	#versionTimer: NodeJS.Timeout | null = null;
	#progressTimer: NodeJS.Timeout | null = null;
	#retryTimer: NodeJS.Timeout | null = null;
	#lastVersionAt = 0;

	/** Queued work: specific files, or `"all"` for a full sync. */
	#queued: Set<string> | "all" | null = null;
	#syncing = false;
	#refreshing = false;
	#refreshAgain = false;

	status(): LiveStatus {
		return { version: this.#version, sync: { ...this.#sync }, indexingHours: this.#indexingHours };
	}

	/** Receive every status change; returns the unsubscribe function. */
	subscribe(listener: Listener): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	/** Begin background ingest: an immediate full sync, the transcript watcher, and periodic resyncs. Idempotent. */
	start(): void {
		if (this.#started) return;
		this.#started = true;
		this.#watch();
		this.#fullSyncTimer = setInterval(() => this.requestSync(), FULL_SYNC_INTERVAL_MS);
		this.#fullSyncTimer.unref?.();
		this.requestSync();
	}

	stop(): void {
		this.#started = false;
		this.#watcher?.close();
		this.#watcher = null;
		clearInterval(this.#fullSyncTimer ?? undefined);
		for (const timer of [this.#debounceTimer, this.#versionTimer, this.#progressTimer, this.#retryTimer]) {
			clearTimeout(timer ?? undefined);
		}
		this.#fullSyncTimer = this.#debounceTimer = this.#versionTimer = this.#progressTimer = this.#retryTimer = null;
		this.#queued = null;
	}

	/**
	 * Queue a sync of `files`, or of every session when omitted. Requests made
	 * while a sync runs coalesce into one follow-up run.
	 */
	requestSync(files?: readonly string[]): void {
		if (!files) this.#queued = "all";
		else if (this.#queued !== "all") {
			this.#queued ??= new Set();
			for (const file of files) this.#queued.add(file);
		}
		void this.#drain();
	}

	async #drain(): Promise<void> {
		if (this.#syncing) return;
		this.#syncing = true;
		try {
			while (this.#queued) {
				const work = this.#queued;
				this.#queued = null;
				await this.#runSync(work === "all" ? undefined : [...work]);
			}
		} finally {
			this.#syncing = false;
		}
	}

	async #runSync(files: string[] | undefined): Promise<void> {
		// Targeted syncs of a file or two stay quiet; only full syncs show progress.
		const visible = files === undefined;
		if (visible) {
			this.#sync = { ...this.#sync, phase: "syncing", current: 0, total: 0, processed: 0, error: null };
			this.#emit();
		}
		let committed = 0;
		try {
			await initDb();
			const result = await syncAllSessions({
				files,
				onProgress: event => {
					if (visible) {
						this.#sync = {
							...this.#sync,
							current: event.current,
							total: event.total,
							processed: event.processed,
						};
						this.#emitProgress();
					}
					if (event.processed > committed) {
						committed = event.processed;
						this.#changed();
					}
				},
			});
			this.#sync = {
				...this.#sync,
				phase: "idle",
				processed: visible ? result.processed : this.#sync.processed,
				lastSyncedAt: Date.now(),
				error: null,
			};
		} catch (error) {
			logger.warn("Stats live sync failed", { error: String(error) });
			this.#sync = { ...this.#sync, phase: "error", error: error instanceof Error ? error.message : String(error) };
			// Usually lock contention with another omp process writing the same
			// database; committed batches are kept, so a retry resumes where it stopped.
			if (this.#started) {
				clearTimeout(this.#retryTimer ?? undefined);
				this.#retryTimer = setTimeout(() => {
					this.#retryTimer = null;
					this.requestSync(files);
				}, SYNC_RETRY_MS);
			}
		}
		// Another process may have ingested too; always let clients revalidate.
		this.#changed();
		this.#emit();
	}

	/** Stored data changed: refresh rollups and (throttled) bump the version. */
	#changed(): void {
		void this.#refresh();
		if (this.#versionTimer) return;
		const wait = Math.max(0, this.#lastVersionAt + VERSION_THROTTLE_MS - Date.now());
		this.#versionTimer = setTimeout(() => {
			this.#versionTimer = null;
			this.#lastVersionAt = Date.now();
			this.#version++;
			this.#indexingHours = getRollupStatus().dirtyHours;
			this.#emit();
		}, wait);
	}

	async #refresh(): Promise<void> {
		if (this.#refreshing) {
			this.#refreshAgain = true;
			return;
		}
		this.#refreshing = true;
		try {
			do {
				this.#refreshAgain = false;
				await refreshRollups({
					onProgress: remaining => {
						this.#indexingHours = remaining;
						// Each rolled batch fills in more history for open pages.
						if (remaining > 0) this.#changed();
					},
				});
			} while (this.#refreshAgain);
		} catch (error) {
			logger.warn("Stats rollup refresh failed", { error: String(error) });
		} finally {
			this.#refreshing = false;
		}
		this.#indexingHours = getRollupStatus().dirtyHours;
		this.#emit();
	}

	#watch(): void {
		const root = getSessionsDir();
		const pending = new Set<string>();
		try {
			this.#watcher = fs.watch(root, { recursive: true }, (_event, filename) => {
				if (!filename?.endsWith(".jsonl")) return;
				pending.add(path.join(root, filename));
				clearTimeout(this.#debounceTimer ?? undefined);
				this.#debounceTimer = setTimeout(() => {
					this.#debounceTimer = null;
					const files = [...pending];
					pending.clear();
					this.requestSync(files);
				}, WATCH_DEBOUNCE_MS);
			});
			this.#watcher.on("error", error => {
				logger.warn("Stats session watcher failed; relying on periodic sync", { error: String(error) });
				this.#watcher?.close();
				this.#watcher = null;
			});
		} catch (error) {
			// No sessions dir yet, or recursive watch unsupported: periodic full syncs cover it.
			logger.debug("Stats session watcher unavailable", { root, error: String(error) });
		}
	}

	#emitProgress(): void {
		if (this.#progressTimer) return;
		this.#progressTimer = setTimeout(() => {
			this.#progressTimer = null;
			this.#emit();
		}, PROGRESS_THROTTLE_MS);
	}

	#emit(): void {
		const status = this.status();
		for (const listener of this.#listeners) {
			try {
				listener(status);
			} catch (error) {
				logger.warn("Stats live listener failed", { error: String(error) });
			}
		}
	}
}

let instance: StatsLive | null = null;

/** The process-wide live hub. */
export function statsLive(): StatsLive {
	instance ??= new StatsLive();
	return instance;
}
