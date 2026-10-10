/**
 * Session host registry: one owner-private JSON entry per live host, named
 * `<hostId>.json`, carrying the endpoint and bearer token a client needs to
 * attach. Endpoints die with their host; listing probes each one and prunes
 * entries whose endpoint is gone.
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { getBaseConfigRoot, isEnoent, isRecord } from "@oh-my-pi/pi-utils";
import {
	assertPrivateDir,
	DEFAULT_SOCKET_FALLBACK_BASE,
	ensurePrivateDir,
	pidAlive,
	probeEndpoint,
	socketFallbackDir,
	writePrivateJson,
} from "../ipc/private-endpoint";

export const SESSION_HOST_REGISTRY_VERSION = 1;
export const SESSION_HOST_REGISTRY_LABEL = "session host registry";
/** `privateEndpoint` prefix: `omp-host-<id>` pipes, `omp-host-…` relocated socket dirs. */
export const SESSION_HOST_ENDPOINT_PREFIX = "host";
/** Per-entry liveness probe deadline during listing. */
const PROBE_TIMEOUT_MS = 1_500;
/** `<hostId>.json`. Nothing else in the directory is parsed or pruned: it may not be ours. */
const ENTRY_FILE_NAME = /^[0-9a-f]{16}\.json$/;

export interface SessionHostEntry {
	version: number;
	hostId: string;
	pid: number;
	endpoint: string;
	token: string;
	cwd: string;
	sessionFile: string | undefined;
	title: string | undefined;
	clients: number;
	busy: boolean;
	startedAt: number;
}

export function sessionHostsDir(): string {
	return path.join(getBaseConfigRoot(), "run", "session-hosts");
}

export function newHostId(): string {
	return crypto.randomBytes(8).toString("hex");
}

export async function writeHostEntry(entry: SessionHostEntry, dir = sessionHostsDir()): Promise<void> {
	await ensurePrivateDir(dir, SESSION_HOST_REGISTRY_LABEL);
	await writePrivateJson(path.join(dir, `${entry.hostId}.json`), entry);
}

export async function removeHostEntry(hostId: string, dir = sessionHostsDir()): Promise<void> {
	await fs.promises.rm(path.join(dir, `${hostId}.json`), { force: true });
}

/** For the host's postmortem cleanup, which also runs from the `exit` event, where nothing async runs. */
export function removeHostEntrySync(hostId: string, dir = sessionHostsDir()): void {
	fs.rmSync(path.join(dir, `${hostId}.json`), { force: true });
}

/** A current-version entry, or `null` when a field is missing or mistyped. */
function parseEntry(name: string, raw: Record<string, unknown>): SessionHostEntry | null {
	const { version, hostId, pid, endpoint, token, cwd, sessionFile, title, clients, busy, startedAt } = raw;
	if (version !== SESSION_HOST_REGISTRY_VERSION || typeof hostId !== "string" || name !== `${hostId}.json`)
		return null;
	if (typeof pid !== "number" || typeof endpoint !== "string" || !endpoint || typeof token !== "string" || !token)
		return null;
	if (typeof cwd !== "string" || typeof clients !== "number" || typeof busy !== "boolean") return null;
	if (typeof startedAt !== "number") return null;
	if (sessionFile !== undefined && typeof sessionFile !== "string") return null;
	if (title !== undefined && typeof title !== "string") return null;
	return { version, hostId, pid, endpoint, token, cwd, sessionFile, title, clients, busy, startedAt };
}

/**
 * Remove a dead entry. `endpoint` is unlinked only when it is exactly the
 * socket a host with this entry's id binds here or in the relocated socket
 * directory: entries are untrusted input, and a crafted endpoint must not
 * turn a listing into a deletion tool.
 */
async function pruneEntry(dir: string, name: string, endpoint?: unknown): Promise<void> {
	try {
		await fs.promises.rm(path.join(dir, name), { force: true });
		if (process.platform === "win32" || typeof endpoint !== "string") return;
		const socketName = `${name.slice(0, -".json".length)}.sock`;
		const fallbackDir = socketFallbackDir(dir, DEFAULT_SOCKET_FALLBACK_BASE, SESSION_HOST_ENDPOINT_PREFIX);
		const target = path.resolve(endpoint);
		if (target === path.resolve(dir, socketName) || target === path.resolve(fallbackDir, socketName))
			await fs.promises.rm(target, { force: true });
	} catch {
		// Best-effort: a concurrent lister may have pruned it first.
	}
}

async function listEntry(dir: string, name: string): Promise<SessionHostEntry | null> {
	let text: string;
	try {
		text = await Bun.file(path.join(dir, name)).text();
	} catch {
		return null;
	}
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		raw = undefined;
	}
	const pid = isRecord(raw) ? raw.pid : undefined;
	if (
		!isRecord(raw) ||
		typeof raw.version !== "number" ||
		typeof pid !== "number" ||
		!Number.isInteger(pid) ||
		pid <= 0
	) {
		await pruneEntry(dir, name);
		return null;
	}
	if (raw.version !== SESSION_HOST_REGISTRY_VERSION) {
		// Another omp version owns it, under its own schema: never list it, prune it only once its process is gone.
		if (!pidAlive(pid)) await pruneEntry(dir, name, raw.endpoint);
		return null;
	}
	const entry = parseEntry(name, raw);
	if (!entry) {
		await pruneEntry(dir, name);
		return null;
	}
	// "unknown" (timeout, EMFILE, …) says nothing about liveness: keep and list it.
	if ((await probeEndpoint(entry.endpoint, PROBE_TIMEOUT_MS)) !== "dead") return entry;
	await pruneEntry(dir, name, entry.endpoint);
	return null;
}

/** Live entries only; dead ones (probe "dead") are pruned. */
export async function listSessionHosts(dir = sessionHostsDir()): Promise<SessionHostEntry[]> {
	let names: string[];
	try {
		await assertPrivateDir(dir, SESSION_HOST_REGISTRY_LABEL);
		names = await fs.promises.readdir(dir);
	} catch (err) {
		if (isEnoent(err)) return [];
		throw err;
	}
	const entries = await Promise.all(
		names.filter(name => ENTRY_FILE_NAME.test(name)).map(name => listEntry(dir, name)),
	);
	return entries
		.filter(entry => entry !== null)
		.sort((a, b) => a.startedAt - b.startedAt || a.hostId.localeCompare(b.hostId));
}

/** The live host serving `sessionFile`, compared by `path.resolve`. */
export async function findHostForSession(
	sessionFile: string,
	dir = sessionHostsDir(),
): Promise<SessionHostEntry | undefined> {
	const key = path.resolve(sessionFile);
	return (await listSessionHosts(dir)).find(
		entry => entry.sessionFile !== undefined && path.resolve(entry.sessionFile) === key,
	);
}
