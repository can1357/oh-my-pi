import * as os from "node:os";
import * as path from "node:path";
import { getWorkerSocketDir, isBunTestRuntime, VERSION } from "@pk-nerdsaver-ai/pi-utils";

/** `"0"`/`"false"` forces one subprocess per instance; default on, except under `bun test`. */
export const SHARED_WORKERS_ENV = "OMP_SHARED_WORKERS";
/** Daemon exits after this long with zero connected clients. */
export const DAEMON_IDLE_ENV = "OMP_WORKER_DAEMON_IDLE_MS";
/** Cold-start budget for the compiled binary to bind its socket. */
export const DAEMON_CONNECT_TIMEOUT_MS = 20_000;
export const DEFAULT_DAEMON_IDLE_MS = 10 * 60 * 1000;
/** Linux `sun_path` is 108 bytes; keep a margin for the NUL and platform quirks. */
const MAX_SOCKET_PATH_LEN = 100;

export type SharedWorkerKind = "tiny" | "embed";

export function sharedWorkersEnabled(): boolean {
	const raw = Bun.env[SHARED_WORKERS_ENV]?.trim().toLowerCase();
	if (raw === "0" || raw === "false") return false;
	if (raw === "1" || raw === "true") return true;
	return !isBunTestRuntime();
}

export function resolveDaemonIdleMs(): number {
	const raw = Bun.env[DAEMON_IDLE_ENV];
	if (raw) {
		const parsed = Number.parseInt(raw, 10);
		if (Number.isFinite(parsed) && parsed > 0) return parsed;
	}
	return DEFAULT_DAEMON_IDLE_MS;
}

/**
 * Socket path for a worker kind + config fingerprint. VERSION is folded in so a
 * binary upgrade never talks to a stale daemon (the stale one exits on idle).
 * Falls back to os.tmpdir() when the config-root path would exceed sun_path.
 */
export function workerSocketPath(kind: SharedWorkerKind, fingerprint: string): string {
	const safeFingerprint = fingerprint.replace(/[^A-Za-z0-9._-]+/g, "_");
	const name = `${kind}-${VERSION}-${safeFingerprint}.sock`;
	const preferred = path.join(getWorkerSocketDir(), name);
	return preferred.length <= MAX_SOCKET_PATH_LEN ? preferred : path.join(os.tmpdir(), `ompk-${name}`);
}

/**
 * Sidecar claimed (`wx`) by the one client allowed to spawn the daemon for a
 * socket; the daemon deletes it once bound. Shared by client and daemon so the
 * two sides never disagree on the path.
 */
export function spawnLockPath(socketPath: string): string {
	return `${socketPath}.spawning`;
}
