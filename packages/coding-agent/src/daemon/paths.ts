/** Filesystem layout of the single per-user omp daemon. */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { ipcEndpoint } from "@oh-my-pi/pi-natives";
import { getDaemonDir, hasFsCode, isEacces, isEisdir, isEnoent } from "@oh-my-pi/pi-utils";
import { DAEMON_DIR_ENV, DAEMON_TCP_ENV } from "./protocol";

/** Runtime directory of the daemon: `OMP_DAEMON_DIR`, else the profile-independent `run/daemon`. */
export function daemonDir(): string {
	return process.env[DAEMON_DIR_ENV] || getDaemonDir();
}

/** Unix socket or Windows named pipe the daemon listens on. */
export function daemonEndpoint(): string {
	return ipcEndpoint(daemonDir(), "daemon");
}

/** The daemon's sqlite store. */
export function daemonDbPath(): string {
	return path.join(daemonDir(), "daemon.db");
}

/** Shared secret required in every hello (mode 0600). */
export function daemonTokenPath(): string {
	return path.join(daemonDir(), "token");
}

/** Single-instance lock held for the daemon's whole lifetime. */
export function daemonLockPath(): string {
	return path.join(daemonDir(), "daemon.lock");
}

/**
 * Written by a daemon right before it releases the lock to re-exec itself:
 * `{ pid, startedAt }`. A daemon that wins the lock while that process is
 * still alive steps aside so the successor image can take the lock back.
 */
export function daemonHandoverPath(): string {
	return path.join(daemonDir(), "handover.json");
}

/** Output logs of one unit. */
export function unitLogDir(id: string): string {
	return path.join(daemonDir(), "units", id);
}

/** Private state directory of one module kind. */
export function moduleStateDir(kind: string): string {
	return path.join(daemonDir(), "modules", kind);
}

/** Loopback TCP address from `OMP_DAEMON_TCP=host:port`; undefined when unset. Throws when malformed. */
export function daemonTcpAddress(): { host: string; port: number } | undefined {
	const raw = process.env[DAEMON_TCP_ENV]?.trim();
	if (!raw) return undefined;
	const colon = raw.lastIndexOf(":");
	if (colon <= 0) throw new Error(`${DAEMON_TCP_ENV} must be host:port, got ${raw}`);
	let host = raw.slice(0, colon);
	if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
	const port = Number.parseInt(raw.slice(colon + 1), 10);
	if (!Number.isInteger(port) || port < 0 || port > 65_535) {
		throw new Error(`${DAEMON_TCP_ENV} has an invalid port: ${raw}`);
	}
	return { host, port };
}

/**
 * Canonicalize a project directory the same way every client does, so project
 * scopes agree across processes. Missing paths and permission-denied lookups
 * resolve without realpath instead of failing.
 */
export async function canonicalProjectDir(projectDir: string): Promise<string> {
	const resolved = path.resolve(projectDir);
	try {
		return await fs.realpath(resolved);
	} catch (error) {
		if (isEnoent(error) || isEisdir(error) || isEacces(error) || hasFsCode(error, "EPERM")) return resolved;
		throw error;
	}
}
