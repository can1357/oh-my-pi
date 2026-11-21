/**
 * `transcripts` daemon module: keeps the full-text transcript index of every
 * omp process current (`session/transcript-index.ts`), so no process indexes
 * on its own thread and concurrent searches share one sync.
 *
 * Call-only: {@link TRANSCRIPTS_SYNC_METHOD} syncs the store a client names
 * on the daemon's {@link TranscriptIndexer}, whose worker thread keeps the
 * daemon's event loop free and exits after a few idle minutes. Clients name
 * their own store and sessions root: the daemon serves every profile, so its
 * own environment says nothing about the caller's.
 *
 * The client half ({@link syncTranscripts}) lives here too so both ends of the
 * contract stay in one file. It falls back to a worker thread of the calling
 * process when the daemon cannot serve it.
 */
import { type } from "@oh-my-pi/omptype";
import { getSessionsDir, getTranscriptIndexDbPath, logger, untilAborted } from "@oh-my-pi/pi-utils";
import { isBunTestRuntime } from "@oh-my-pi/pi-utils/env";
import type { TranscriptSyncResult } from "../../session/transcript-index";
import { TranscriptIndexer } from "../../session/transcript-index-client";
import { daemonClient } from "../client";
import type { DaemonModule } from "../module";
import type { DaemonClient } from "../protocol";

/** Module kind and `caps` key. */
export const TRANSCRIPTS_KIND = "transcripts";
/** Bumped on incompatible changes to {@link TRANSCRIPTS_SYNC_METHOD}'s params or result. */
export const TRANSCRIPTS_VERSION = 1;
/** Call method: params `{ dbPath, sessionsRoot }`, result {@link TranscriptSyncResult}. */
export const TRANSCRIPTS_SYNC_METHOD = "sync";
/** How long the daemon's indexer worker outlives its last sync. */
const DAEMON_WORKER_IDLE_MS = 5 * 60_000;

const SyncTarget = type({ dbPath: "string > 0", sessionsRoot: "string > 0", "+": "reject" });

let daemonIndexer: TranscriptIndexer | undefined;

function noUnits(): never {
	throw new Error("the transcripts module serves calls only");
}

/** Syncs transcript index stores for every omp process on one shared worker thread. */
export const transcriptsModule: DaemonModule = {
	kind: TRANSCRIPTS_KIND,
	version: TRANSCRIPTS_VERSION,
	policy: noUnits,
	open: noUnits,
	async call(_context, method, params) {
		if (method !== TRANSCRIPTS_SYNC_METHOD) throw new Error(`unknown transcripts method: ${method}`);
		const target = SyncTarget(params);
		if (target instanceof type.errors) throw new Error(`invalid transcripts sync target: ${target.summary}`);
		daemonIndexer ??= new TranscriptIndexer({ idleMs: DAEMON_WORKER_IDLE_MS });
		return daemonIndexer.sync(target);
	},
	async dispose() {
		daemonIndexer?.close();
		daemonIndexer = undefined;
	},
};

// ── Client half ──────────────────────────────────────────────────────

/** This process's indexer, used only when the daemon cannot serve it; its worker exits with each sync. */
let localIndexer: TranscriptIndexer | undefined;

/**
 * Brings the current agent dir's transcript index up to date through the
 * daemon, or on a worker thread of this process when the daemon is
 * unreachable, predates the module, or would be the user's own under the test
 * runner. Rejects when the sync fails, or when `signal` aborts first; the sync
 * itself runs on.
 */
export async function syncTranscripts(signal?: AbortSignal): Promise<TranscriptSyncResult> {
	const target = { dbPath: getTranscriptIndexDbPath(), sessionsRoot: getSessionsDir() };
	const daemon = await untilAborted(signal, transcriptsDaemon());
	if (daemon) return daemon.call<TranscriptSyncResult>(TRANSCRIPTS_KIND, TRANSCRIPTS_SYNC_METHOD, target, { signal });
	localIndexer ??= new TranscriptIndexer({ idleMs: 0 });
	return untilAborted(signal, localIndexer.sync(target));
}

/** The daemon when it serves this module; `undefined` (after a debug log) otherwise. */
async function transcriptsDaemon(): Promise<DaemonClient | undefined> {
	if (isBunTestRuntime()) return undefined;
	try {
		const daemon = await daemonClient();
		if (daemon.welcome.caps[TRANSCRIPTS_KIND] === TRANSCRIPTS_VERSION) return daemon;
		logger.debug("Daemon lacks the transcripts module; indexing transcripts in-process");
	} catch (error) {
		logger.debug("Daemon unavailable; indexing transcripts in-process", { error: String(error) });
	}
	return undefined;
}
