/**
 * Runtime local Collab host registry.
 *
 * Every successfully connected Collab host publishes a private, per-process
 * IPC endpoint (Unix domain socket on POSIX, named pipe on Windows) so that a
 * separate local process can discover live hosts and retrieve a shareable URL.
 * Full-control and view-only URLs, room keys, and write tokens stay in host
 * memory; disk carries only ephemeral discovery metadata (protocol version,
 * PID, endpoint, creation time, random bearer token) with owner-only
 * permissions. Endpoints die with the host process, so a crash leaves at most
 * stale metadata that the next list operation prunes best-effort.
 *
 * Transport follows the launch daemon broker conventions: node `net` servers,
 * newline-delimited JSON envelopes, per-request bearer authentication, and
 * bounded buffers. Guests never publish; this registry is host-only.
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { getBaseConfigRoot, isEnoent, logger } from "@oh-my-pi/pi-utils";

/** Discovery metadata / IPC protocol version. Mixed omp versions fail safely. */
export const COLLAB_REGISTRY_VERSION = 1;

/** Reject request lines beyond this size; a valid request is <200 bytes. */
const MAX_REQUEST_BYTES = 4 * 1024;
/** Reject snapshot responses beyond this size. */
const MAX_RESPONSE_BYTES = 64 * 1024;
/** Per-entry connect+response deadline during listing. */
const DEFAULT_QUERY_TIMEOUT_MS = 1_500;
/** Concurrency bound for querying discovery entries. */
const LIST_CONCURRENCY = 8;

export type CollabAccessMode = "write" | "view";

/** Live host state, computed by the host process at query time. */
export interface CollabHostSnapshot {
	/** Session ID of the hosted conversation. */
	sessionId: string;
	/** Human-readable session name, when one is set. */
	sessionName: string | null;
	/** Host working directory. */
	cwd: string;
	/** Host process ID. */
	pid: number;
	/** Epoch milliseconds when the host connected to the relay. */
	startedAt: number;
	/** Current participant count, including the host. */
	participants: number;
	/** Access mode the returned URL grants. */
	mode: CollabAccessMode;
	/** Browser URL for the requested access mode. `view` requests never carry the write URL. */
	url: string;
}

/** Computes one live snapshot per request; called by the IPC server. */
export type CollabHostSnapshotProvider = (mode: CollabAccessMode) => Omit<CollabHostSnapshot, "mode">;

/** Handle returned by {@link publishCollabHost}; closing withdraws the host. */
export interface CollabHostPublication {
	/** Endpoint the host listens on (test/diagnostic use; not secret). */
	readonly endpoint: string;
	/** Stop serving snapshots and remove the discovery metadata. Idempotent. */
	close(): Promise<void>;
}

export interface CollabRegistryOptions {
	/** Override the discovery metadata directory (tests). */
	dir?: string;
}

export interface CollabListOptions extends CollabRegistryOptions {
	/** URL capability to request from each host. Defaults to `write`. */
	mode?: CollabAccessMode;
	/** Per-entry query deadline in milliseconds. */
	timeoutMs?: number;
}

/**
 * Discovery metadata directory. Deliberately under the profile-independent
 * config root (`~/.omp/run/collab-hosts`) — unlike the launch broker's
 * profile-scoped runtime dir — so hosts started under any profile are
 * discoverable from any other (issue #6099 user story 18).
 */
export function collabHostsRuntimeDir(): string {
	return path.join(getBaseConfigRoot(), "run", "collab-hosts");
}

interface DiscoveryMetadata {
	version: number;
	pid: number;
	endpoint: string;
	createdAt: number;
	token: string;
}

function parseDiscoveryMetadata(text: string): DiscoveryMetadata | null {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		return null;
	}
	if (typeof raw !== "object" || raw === null) return null;
	const meta = raw as Record<string, unknown>;
	if (typeof meta.version !== "number") return null;
	if (typeof meta.pid !== "number" || !Number.isInteger(meta.pid) || meta.pid <= 0) return null;
	if (typeof meta.endpoint !== "string" || meta.endpoint.length === 0) return null;
	if (typeof meta.createdAt !== "number") return null;
	if (typeof meta.token !== "string" || meta.token.length === 0) return null;
	return {
		version: meta.version,
		pid: meta.pid,
		endpoint: meta.endpoint,
		createdAt: meta.createdAt,
		token: meta.token,
	};
}

function tokenMatches(expected: string, presented: unknown): boolean {
	if (typeof presented !== "string") return false;
	const a = Buffer.from(expected, "utf8");
	const b = Buffer.from(presented, "utf8");
	if (a.length !== b.length) return false;
	return crypto.timingSafeEqual(a, b);
}

function parseSnapshot(raw: unknown, mode: CollabAccessMode): CollabHostSnapshot | null {
	if (typeof raw !== "object" || raw === null) return null;
	const host = raw as Record<string, unknown>;
	if (typeof host.sessionId !== "string") return null;
	if (host.sessionName !== null && typeof host.sessionName !== "string") return null;
	if (typeof host.cwd !== "string") return null;
	if (typeof host.pid !== "number" || !Number.isInteger(host.pid)) return null;
	if (typeof host.startedAt !== "number") return null;
	if (typeof host.participants !== "number") return null;
	if (typeof host.url !== "string" || host.url.length === 0) return null;
	return {
		sessionId: host.sessionId,
		sessionName: host.sessionName,
		cwd: host.cwd,
		pid: host.pid,
		startedAt: host.startedAt,
		participants: host.participants,
		mode,
		url: host.url,
	};
}

/** One request per connection: authenticate, snapshot, respond, close. */
function handleConnection(socket: net.Socket, token: string, provider: CollabHostSnapshotProvider): void {
	let buffer = "";
	let handled = false;
	const respond = (payload: object): void => {
		handled = true;
		socket.end(`${JSON.stringify(payload)}\n`);
	};
	socket.setEncoding("utf8");
	socket.on("error", () => socket.destroy());
	socket.on("data", chunk => {
		if (handled) return;
		buffer += chunk;
		if (Buffer.byteLength(buffer, "utf8") > MAX_REQUEST_BYTES) {
			socket.destroy();
			return;
		}
		const newline = buffer.indexOf("\n");
		if (newline < 0) return;
		const line = buffer.slice(0, newline).trim();
		let request: unknown;
		try {
			request = JSON.parse(line);
		} catch {
			respond({ ok: false, error: "malformed request" });
			return;
		}
		if (typeof request !== "object" || request === null) {
			respond({ ok: false, error: "malformed request" });
			return;
		}
		const { v, token: presented, mode } = request as Record<string, unknown>;
		if (v !== COLLAB_REGISTRY_VERSION) {
			respond({ ok: false, error: "unsupported protocol version" });
			return;
		}
		if (!tokenMatches(token, presented)) {
			respond({ ok: false, error: "authentication failed" });
			return;
		}
		if (mode !== "write" && mode !== "view") {
			respond({ ok: false, error: "invalid access mode" });
			return;
		}
		try {
			// A `view` request receives only the view-only URL; the provider never
			// serializes the full-control URL for it.
			const snapshot = provider(mode);
			respond({ ok: true, v: COLLAB_REGISTRY_VERSION, host: { ...snapshot, mode } });
		} catch {
			// Never let provider errors (or URLs) leak into the wire error.
			respond({ ok: false, error: "snapshot unavailable" });
		}
	});
}

/**
 * Publish a live Collab host to the local registry.
 *
 * Creates the owner-only runtime dir, starts a private IPC endpoint backed by
 * `provider`, and writes discovery metadata (never URLs or room secrets).
 * Call {@link CollabHostPublication.close} on every teardown path; a process
 * exit hook removes the on-disk state for normal shutdown, and the OS closing
 * the endpoint covers crashes.
 */
export async function publishCollabHost(
	provider: CollabHostSnapshotProvider,
	options?: CollabRegistryOptions,
): Promise<CollabHostPublication> {
	const dir = options?.dir ?? collabHostsRuntimeDir();
	await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });

	// Unpredictable instance ID: names the endpoint and the metadata file, so
	// PID reuse cannot attach stale metadata to an unrelated process.
	const instanceId = crypto.randomBytes(8).toString("hex");
	const token = crypto.randomBytes(32).toString("hex");
	const endpoint =
		process.platform === "win32" ? `\\\\.\\pipe\\omp-collab-${instanceId}` : path.join(dir, `${instanceId}.sock`);
	const metaPath = path.join(dir, `${instanceId}.json`);

	const liveSockets = new Set<net.Socket>();
	const server = net.createServer(socket => {
		liveSockets.add(socket);
		socket.once("close", () => liveSockets.delete(socket));
		handleConnection(socket, token, provider);
	});
	const listening = Promise.withResolvers<void>();
	server.once("error", err => listening.reject(err));
	server.listen(endpoint, () => listening.resolve());
	try {
		await listening.promise;
		if (process.platform !== "win32") await fs.promises.chmod(endpoint, 0o600);
		const meta: DiscoveryMetadata = {
			version: COLLAB_REGISTRY_VERSION,
			pid: process.pid,
			endpoint,
			createdAt: Date.now(),
			token,
		};
		// Write-then-rename so a concurrent list never observes a partial file
		// (it would classify the entry as malformed and prune it, leaving this
		// host published but undiscoverable). The temp suffix keeps it outside
		// the `*.json` listing filter; the instance ID makes the name unique.
		const tmpPath = `${metaPath}.tmp`;
		const handle = await fs.promises.open(tmpPath, "wx", 0o600);
		try {
			await handle.writeFile(JSON.stringify(meta), "utf8");
		} finally {
			await handle.close();
		}
		try {
			await fs.promises.rename(tmpPath, metaPath);
		} catch (err) {
			fs.rmSync(tmpPath, { force: true });
			throw err;
		}
	} catch (err) {
		server.close();
		if (process.platform !== "win32") fs.rmSync(endpoint, { force: true });
		throw err;
	}

	const removeArtifactsSync = (): void => {
		try {
			fs.rmSync(metaPath, { force: true });
			if (process.platform !== "win32") fs.rmSync(endpoint, { force: true });
		} catch {
			// Best-effort; a survivor is pruned by the next list.
		}
	};
	// Normal process shutdown without an explicit stop still withdraws the host.
	process.once("exit", removeArtifactsSync);

	let closed = false;
	return {
		endpoint,
		async close(): Promise<void> {
			if (closed) return;
			closed = true;
			process.off("exit", removeArtifactsSync);
			const done = Promise.withResolvers<void>();
			server.close(() => done.resolve());
			// Sever any lingering clients so close() cannot hang on an open socket.
			for (const socket of liveSockets) socket.destroy();
			removeArtifactsSync();
			await done.promise;
		},
	};
}

/** Query one endpoint: connect, authenticate, read one bounded response line. */
function querySnapshot(
	meta: DiscoveryMetadata,
	mode: CollabAccessMode,
	timeoutMs: number,
): Promise<{ status: "ok"; host: CollabHostSnapshot } | { status: "dead" } | { status: "skip" }> {
	const { promise, resolve } = Promise.withResolvers<
		{ status: "ok"; host: CollabHostSnapshot } | { status: "dead" } | { status: "skip" }
	>();
	let buffer = "";
	const socket = net.createConnection({ path: meta.endpoint });
	const timer = setTimeout(() => finish({ status: "skip" }), timeoutMs);
	const finish = (
		result: { status: "ok"; host: CollabHostSnapshot } | { status: "dead" } | { status: "skip" },
	): void => {
		clearTimeout(timer);
		socket.destroy();
		resolve(result);
	};
	socket.setEncoding("utf8");
	socket.once("error", err => {
		const code = (err as NodeJS.ErrnoException).code;
		finish({
			status: code === "ENOENT" || code === "ECONNREFUSED" ? "dead" : "skip",
		});
	});
	socket.once("connect", () => {
		socket.write(`${JSON.stringify({ v: COLLAB_REGISTRY_VERSION, token: meta.token, mode })}\n`);
	});
	socket.on("data", chunk => {
		buffer += chunk;
		if (Buffer.byteLength(buffer, "utf8") > MAX_RESPONSE_BYTES) {
			finish({ status: "skip" });
			return;
		}
		const newline = buffer.indexOf("\n");
		if (newline < 0) return;
		let response: unknown;
		try {
			response = JSON.parse(buffer.slice(0, newline));
		} catch {
			finish({ status: "skip" });
			return;
		}
		if (typeof response !== "object" || response === null || (response as Record<string, unknown>).ok !== true) {
			// Authentication failure or structured error: an unrelated endpoint
			// cannot satisfy stale metadata without the matching token.
			finish({ status: "skip" });
			return;
		}
		const host = parseSnapshot((response as Record<string, unknown>).host, mode);
		finish(host ? { status: "ok", host } : { status: "skip" });
	});
	socket.once("close", () => finish({ status: "skip" }));
	return promise;
}

function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function pruneEntry(dir: string, name: string, meta: DiscoveryMetadata | null): Promise<void> {
	try {
		await fs.promises.rm(path.join(dir, name), { force: true });
		if (meta && process.platform !== "win32" && meta.endpoint.startsWith(dir + path.sep)) {
			await fs.promises.rm(meta.endpoint, { force: true });
		}
	} catch {
		// Best-effort cleanup only.
	}
}

async function listEntry(
	dir: string,
	name: string,
	mode: CollabAccessMode,
	timeoutMs: number,
): Promise<CollabHostSnapshot | null> {
	let text: string;
	try {
		text = await Bun.file(path.join(dir, name)).text();
	} catch (err) {
		if (isEnoent(err)) return null;
		return null;
	}
	const meta = parseDiscoveryMetadata(text);
	if (!meta) {
		// Malformed metadata can never become listable; remove it.
		await pruneEntry(dir, name, null);
		return null;
	}
	if (meta.version !== COLLAB_REGISTRY_VERSION) {
		// A different omp version owns this entry. Never show it; prune only
		// once the owning process is gone so newer versions keep their state.
		if (!pidAlive(meta.pid)) await pruneEntry(dir, name, meta);
		return null;
	}
	const result = await querySnapshot(meta, mode, timeoutMs);
	if (result.status === "ok") return result.host;
	if (result.status === "dead") await pruneEntry(dir, name, meta);
	return null;
}

/**
 * List live Collab hosts under this config root.
 *
 * Reads every discovery entry, queries the live hosts concurrently (bounded,
 * short independent deadlines), prunes stale or malformed entries
 * best-effort, and returns healthy hosts sorted by start time then PID.
 * Unreachable, unauthenticated, malformed, or version-mismatched entries are
 * omitted without failing the listing.
 */
export async function listCollabHosts(options?: CollabListOptions): Promise<CollabHostSnapshot[]> {
	const dir = options?.dir ?? collabHostsRuntimeDir();
	const mode = options?.mode ?? "write";
	const timeoutMs = options?.timeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS;
	let names: string[];
	try {
		names = await fs.promises.readdir(dir);
	} catch (err) {
		if (isEnoent(err)) return [];
		logger.warn("Collab registry listing failed", { error: String(err) });
		return [];
	}
	const entries = names.filter(name => name.endsWith(".json")).sort();
	const hosts: CollabHostSnapshot[] = [];
	// Bounded worker pool: LIST_CONCURRENCY entries in flight at once.
	let next = 0;
	const worker = async (): Promise<void> => {
		while (next < entries.length) {
			const name = entries[next++];
			const host = await listEntry(dir, name, mode, timeoutMs);
			if (host) hosts.push(host);
		}
	};
	await Promise.all(Array.from({ length: Math.min(LIST_CONCURRENCY, entries.length) }, worker));
	hosts.sort((a, b) => a.startedAt - b.startedAt || a.pid - b.pid);
	return hosts;
}
