/**
 * Runtime local Collab host registry.
 *
 * Every connected Collab host publishes a private, per-process IPC endpoint
 * (Unix domain socket on POSIX, named pipe on Windows) so that a separate local
 * process can discover live hosts and, on explicit request, retrieve a
 * shareable URL. The registry exposes two contracts over that endpoint:
 *
 * - `snapshot`: non-capability metadata (identity, session, cwd, model,
 *   participants, relay/attention state) suitable for listing and polling;
 * - `link`: one browser URL for one exact host generation and access level,
 *   rejected when the generation moved or the access level is not published.
 *
 * Full-control and view-only URLs, room keys, and write tokens stay in host
 * memory; disk carries only ephemeral discovery metadata (protocol version,
 * instance ID, PID, endpoint, creation time, random bearer token) with
 * owner-only permissions. Endpoints die with the host process, so a crash
 * leaves at most stale metadata that the next list operation prunes best-effort.
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

/** Reject request lines beyond this size; a valid request is <300 bytes. */
const MAX_REQUEST_BYTES = 4 * 1024;
/** Reject responses beyond this size. */
const MAX_RESPONSE_BYTES = 64 * 1024;
/** Per-entry connect+response deadline during listing. */
const DEFAULT_QUERY_TIMEOUT_MS = 1_500;
/** Concurrency bound for querying discovery entries. */
const LIST_CONCURRENCY = 8;

/** Access a link grants: `view` (bare room key) or `control` (room key + write token). */
export type CollabAccess = "view" | "control";

/** Non-capability host state, computed by the host process at query time. */
export interface CollabHostSnapshot {
	/** Random per-process identity; stable across the host's room generations. */
	instanceId: string;
	/** Increments every time this process starts a new room (session switch, restart). */
	generation: number;
	/** Host process ID. */
	pid: number;
	/** Session ID of the hosted conversation. */
	sessionId: string;
	/** Human-readable session name, when one is set. */
	sessionName: string | null;
	/** Host working directory. */
	cwd: string;
	/** Model the host session is currently using, when one is selected. */
	model: { provider: string; id: string } | null;
	/** Epoch milliseconds when the host first connected to the relay. */
	startedAt: number;
	/** Current participant count, including the host. */
	participants: number;
	/** Whether the host currently holds an open relay connection. */
	relayConnected: boolean;
	/** Whether a host-side question is waiting for an answer a writable guest could give. */
	inputRequired: boolean;
	/** Highest access the registry will hand out for this host. */
	access: CollabAccess;
}

/** Live host state served over the IPC endpoint. */
export interface CollabHostRegistrySource {
	/** Current metadata; throws when the host can no longer vouch for its session. */
	snapshot(): CollabHostSnapshot;
	/** Browser URL for `access`, or `null` when that access is not published. */
	link(access: CollabAccess): string | null;
}

/** One resolved capability returned by {@link resolveCollabHostLink}. */
export interface CollabResolvedLink {
	instanceId: string;
	generation: number;
	access: CollabAccess;
	url: string;
}

/** Handle returned by {@link publishCollabHost}; closing withdraws the host. */
export interface CollabHostPublication {
	/** Endpoint the host listens on (test/diagnostic use; not secret). */
	readonly endpoint: string;
	/** Stop serving requests and remove the discovery metadata. Idempotent. */
	close(): Promise<void>;
}

export interface CollabRegistryOptions {
	/** Override the discovery metadata directory (tests). */
	dir?: string;
}

export interface CollabPublishOptions extends CollabRegistryOptions {
	/**
	 * Names the endpoint and metadata file. Defaults to a fresh random ID; a
	 * host that rotates rooms passes its process-lifetime instance ID so the
	 * replacement publication reuses the same entry.
	 */
	instanceId?: string;
}

export interface CollabListOptions extends CollabRegistryOptions {
	/** Per-entry query deadline in milliseconds. */
	timeoutMs?: number;
}

/** Stable failure codes for {@link resolveCollabHostLink}; never carry URLs. */
export type CollabLinkErrorCode = "not_found" | "ambiguous" | "stale_generation" | "access_unavailable" | "unreachable";

export class CollabLinkError extends Error {
	readonly code: CollabLinkErrorCode;
	constructor(code: CollabLinkErrorCode, message: string) {
		super(message);
		this.name = "CollabLinkError";
		this.code = code;
	}
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
	instanceId: string;
	pid: number;
	endpoint: string;
	createdAt: number;
	token: string;
}

const INSTANCE_ID_PATTERN = /^[a-z0-9-]{8,64}$/;

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
	if (typeof meta.instanceId !== "string" || !INSTANCE_ID_PATTERN.test(meta.instanceId)) return null;
	if (typeof meta.pid !== "number" || !Number.isInteger(meta.pid) || meta.pid <= 0) return null;
	if (typeof meta.endpoint !== "string" || meta.endpoint.length === 0) return null;
	if (typeof meta.createdAt !== "number") return null;
	if (typeof meta.token !== "string" || meta.token.length === 0) return null;
	return {
		version: meta.version,
		instanceId: meta.instanceId,
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

function isAccess(value: unknown): value is CollabAccess {
	return value === "view" || value === "control";
}

function parseSnapshot(raw: unknown): CollabHostSnapshot | null {
	if (typeof raw !== "object" || raw === null) return null;
	const host = raw as Record<string, unknown>;
	if (typeof host.instanceId !== "string" || !INSTANCE_ID_PATTERN.test(host.instanceId)) return null;
	if (typeof host.generation !== "number" || !Number.isInteger(host.generation) || host.generation < 1) return null;
	if (typeof host.pid !== "number" || !Number.isInteger(host.pid)) return null;
	if (typeof host.sessionId !== "string") return null;
	if (host.sessionName !== null && typeof host.sessionName !== "string") return null;
	if (typeof host.cwd !== "string") return null;
	let model: CollabHostSnapshot["model"] = null;
	if (host.model !== null) {
		if (typeof host.model !== "object" || host.model === null) return null;
		const { provider, id } = host.model as Record<string, unknown>;
		if (typeof provider !== "string" || typeof id !== "string") return null;
		model = { provider, id };
	}
	if (typeof host.startedAt !== "number") return null;
	if (typeof host.participants !== "number") return null;
	if (typeof host.relayConnected !== "boolean") return null;
	if (typeof host.inputRequired !== "boolean") return null;
	if (!isAccess(host.access)) return null;
	return {
		instanceId: host.instanceId,
		generation: host.generation,
		pid: host.pid,
		sessionId: host.sessionId,
		sessionName: host.sessionName,
		cwd: host.cwd,
		model,
		startedAt: host.startedAt,
		participants: host.participants,
		relayConnected: host.relayConnected,
		inputRequired: host.inputRequired,
		access: host.access,
	};
}

/** One request per connection: authenticate, dispatch the op, respond, close. */
function handleConnection(socket: net.Socket, token: string, source: CollabHostRegistrySource): void {
	let buffer = "";
	let handled = false;
	const respond = (payload: object): void => {
		handled = true;
		socket.end(`${JSON.stringify(payload)}\n`);
	};
	const fail = (error: string): void => respond({ ok: false, v: COLLAB_REGISTRY_VERSION, error });
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
			fail("malformed_request");
			return;
		}
		if (typeof request !== "object" || request === null) {
			fail("malformed_request");
			return;
		}
		const { v, token: presented, op, access, generation } = request as Record<string, unknown>;
		if (v !== COLLAB_REGISTRY_VERSION) {
			fail("unsupported_protocol");
			return;
		}
		if (!tokenMatches(token, presented)) {
			fail("authentication_failed");
			return;
		}
		let snapshot: CollabHostSnapshot;
		try {
			snapshot = source.snapshot();
		} catch {
			// Never let source errors (or URLs) leak into the wire error.
			fail("snapshot_unavailable");
			return;
		}
		if (op === "snapshot") {
			respond({ ok: true, v: COLLAB_REGISTRY_VERSION, snapshot });
			return;
		}
		if (op !== "link") {
			fail("invalid_operation");
			return;
		}
		if (!isAccess(access)) {
			fail("invalid_access");
			return;
		}
		// A capability is bound to the exact generation the caller listed: a room
		// that rotated underneath a stale card must not hand out its successor.
		if (generation !== snapshot.generation) {
			fail("stale_generation");
			return;
		}
		if (access === "control" && snapshot.access !== "control") {
			fail("access_unavailable");
			return;
		}
		let url: string | null;
		try {
			url = source.link(access);
		} catch {
			fail("snapshot_unavailable");
			return;
		}
		if (!url) {
			fail("access_unavailable");
			return;
		}
		respond({ ok: true, v: COLLAB_REGISTRY_VERSION, url });
	});
}

/**
 * The registry directory must be a real directory owned by the current user
 * (POSIX). Both publication and listing check this: listing prunes malformed
 * entries, so following a symlink into an unrelated directory would let a
 * planted link turn `omp collab list` into a deletion tool.
 */
async function assertPrivateDir(dir: string): Promise<fs.Stats | null> {
	if (process.platform === "win32") return null;
	const stat = await fs.promises.lstat(dir);
	if (stat.isSymbolicLink()) throw new Error(`collab registry directory is a symlink: ${dir}`);
	if (!stat.isDirectory()) throw new Error(`collab registry path is not a directory: ${dir}`);
	const uid = process.getuid?.();
	if (uid !== undefined && stat.uid !== uid) {
		throw new Error(`collab registry directory is not owned by the current user: ${dir}`);
	}
	return stat;
}

/**
 * Create the registry directory owner-only. `mkdir` with a mode leaves an
 * existing directory's permissions alone, so an already-present directory is
 * tightened explicitly; a symlink or a directory owned by another user is
 * refused rather than published into.
 */
async function ensurePrivateDir(dir: string): Promise<void> {
	await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
	const stat = await assertPrivateDir(dir);
	if (stat && (stat.mode & 0o077) !== 0) await fs.promises.chmod(dir, 0o700);
}

/**
 * Publish a live Collab host to the local registry.
 *
 * Creates the owner-only runtime dir, starts a private IPC endpoint backed by
 * `source`, and writes discovery metadata (never URLs or room secrets).
 * Call {@link CollabHostPublication.close} on every teardown path; a process
 * exit hook removes the on-disk state for normal shutdown, and the OS closing
 * the endpoint covers crashes.
 */
export async function publishCollabHost(
	source: CollabHostRegistrySource,
	options?: CollabPublishOptions,
): Promise<CollabHostPublication> {
	const dir = options?.dir ?? collabHostsRuntimeDir();
	await ensurePrivateDir(dir);

	// Unpredictable instance ID: names the endpoint and the metadata file, so
	// PID reuse cannot attach stale metadata to an unrelated process.
	const instanceId = options?.instanceId ?? crypto.randomBytes(8).toString("hex");
	if (!INSTANCE_ID_PATTERN.test(instanceId)) throw new Error("invalid collab registry instance id");
	const token = crypto.randomBytes(32).toString("hex");
	const endpoint =
		process.platform === "win32" ? `\\\\.\\pipe\\omp-collab-${instanceId}` : path.join(dir, `${instanceId}.sock`);
	const metaPath = path.join(dir, `${instanceId}.json`);

	const liveSockets = new Set<net.Socket>();
	const server = net.createServer(socket => {
		liveSockets.add(socket);
		socket.once("close", () => liveSockets.delete(socket));
		handleConnection(socket, token, source);
	});
	const listening = Promise.withResolvers<void>();
	server.once("error", err => listening.reject(err));
	server.listen(endpoint, () => listening.resolve());
	try {
		await listening.promise;
		if (process.platform !== "win32") await fs.promises.chmod(endpoint, 0o600);
		const meta: DiscoveryMetadata = {
			version: COLLAB_REGISTRY_VERSION,
			instanceId,
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

type QueryResult<T> = { status: "ok"; value: T } | { status: "dead" } | { status: "skip"; error?: string };

/** Query one endpoint: connect, authenticate, send one request, read one bounded response line. */
function query(meta: DiscoveryMetadata, request: object, timeoutMs: number): Promise<QueryResult<unknown>> {
	const { promise, resolve } = Promise.withResolvers<QueryResult<unknown>>();
	let buffer = "";
	const socket = net.createConnection({ path: meta.endpoint });
	const timer = setTimeout(() => finish({ status: "skip" }), timeoutMs);
	const finish = (result: QueryResult<unknown>): void => {
		clearTimeout(timer);
		socket.destroy();
		resolve(result);
	};
	socket.setEncoding("utf8");
	socket.once("error", err => {
		// Endpoints die with their host process: a refused or missing socket
		// means the host is gone. Any other error (EMFILE, EACCES, EAGAIN, …)
		// says nothing about liveness and must not prune a live host.
		const code = (err as NodeJS.ErrnoException).code;
		finish({ status: code === "ENOENT" || code === "ECONNREFUSED" ? "dead" : "skip" });
	});
	socket.once("connect", () => {
		socket.write(`${JSON.stringify({ v: COLLAB_REGISTRY_VERSION, token: meta.token, ...request })}\n`);
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
		if (typeof response !== "object" || response === null) {
			finish({ status: "skip" });
			return;
		}
		const { ok, error } = response as Record<string, unknown>;
		if (ok !== true) {
			// Authentication failure or structured error: an unrelated endpoint
			// cannot satisfy stale metadata without the matching token.
			finish({ status: "skip", error: typeof error === "string" ? error : undefined });
			return;
		}
		finish({ status: "ok", value: response });
	});
	socket.once("close", () => finish({ status: "skip" }));
	return promise;
}

async function querySnapshot(meta: DiscoveryMetadata, timeoutMs: number): Promise<QueryResult<CollabHostSnapshot>> {
	const result = await query(meta, { op: "snapshot" }, timeoutMs);
	if (result.status !== "ok") return result;
	const snapshot = parseSnapshot((result.value as Record<string, unknown>).snapshot);
	return snapshot ? { status: "ok", value: snapshot } : { status: "skip" };
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
		if (meta) {
			// A host that rotated rooms republishes under the same instance name.
			// If the entry on disk is no longer the one that failed to answer,
			// the failure belongs to the previous room: leave the successor alone.
			const current = parseDiscoveryMetadata(await Bun.file(path.join(dir, name)).text());
			if (!current || current.token !== meta.token || current.endpoint !== meta.endpoint) return;
		}
		await fs.promises.rm(path.join(dir, name), { force: true });
		if (meta && process.platform !== "win32" && meta.endpoint.startsWith(dir + path.sep)) {
			await fs.promises.rm(meta.endpoint, { force: true });
		}
	} catch {
		// Best-effort cleanup only (a missing file means someone else already pruned it).
	}
}

interface LiveEntry {
	meta: DiscoveryMetadata;
	snapshot: CollabHostSnapshot;
}

async function listEntry(dir: string, name: string, timeoutMs: number): Promise<LiveEntry | null> {
	let text: string;
	try {
		text = await Bun.file(path.join(dir, name)).text();
	} catch {
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
	const result = await querySnapshot(meta, timeoutMs);
	if (result.status === "ok") return { meta, snapshot: result.value };
	if (result.status === "dead") await pruneEntry(dir, name, meta);
	return null;
}

async function listLiveEntries(options?: CollabListOptions): Promise<LiveEntry[]> {
	const dir = options?.dir ?? collabHostsRuntimeDir();
	const timeoutMs = options?.timeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS;
	let names: string[];
	try {
		await assertPrivateDir(dir);
		names = await fs.promises.readdir(dir);
	} catch (err) {
		if (isEnoent(err)) return [];
		logger.warn("Collab registry listing failed", { error: String(err) });
		return [];
	}
	const entries = names.filter(name => name.endsWith(".json")).sort();
	const live: LiveEntry[] = [];
	// Bounded worker pool: LIST_CONCURRENCY entries in flight at once.
	let next = 0;
	const worker = async (): Promise<void> => {
		while (next < entries.length) {
			const name = entries[next++];
			const entry = await listEntry(dir, name, timeoutMs);
			if (entry) live.push(entry);
		}
	};
	await Promise.all(Array.from({ length: Math.min(LIST_CONCURRENCY, entries.length) }, worker));
	live.sort(
		(a, b) =>
			a.snapshot.startedAt - b.snapshot.startedAt ||
			a.snapshot.pid - b.snapshot.pid ||
			a.snapshot.instanceId.localeCompare(b.snapshot.instanceId),
	);
	return live;
}

/**
 * List live Collab hosts under this config root.
 *
 * Reads every discovery entry, queries the live hosts concurrently (bounded,
 * short independent deadlines), prunes stale or malformed entries
 * best-effort, and returns healthy hosts sorted by start time, PID, then
 * instance ID. Unreachable, unauthenticated, malformed, or version-mismatched
 * entries are omitted without failing the listing. The result carries no URLs.
 */
export async function listCollabHosts(options?: CollabListOptions): Promise<CollabHostSnapshot[]> {
	return (await listLiveEntries(options)).map(entry => entry.snapshot);
}

/**
 * Resolve one browser URL for the host selected by `selector` — an exact
 * instance ID, or a PID when no instance matches. The link request carries the
 * generation observed while listing, so a host that rotated rooms in between
 * answers `stale_generation` instead of leaking its successor's capability.
 */
export async function resolveCollabHostLink(
	selector: string,
	access: CollabAccess,
	options?: CollabListOptions,
): Promise<CollabResolvedLink> {
	const wanted = selector.trim();
	const live = await listLiveEntries(options);
	let matches = live.filter(entry => entry.snapshot.instanceId === wanted);
	if (matches.length === 0 && /^[1-9][0-9]*$/.test(wanted)) {
		const pid = Number(wanted);
		matches = live.filter(entry => entry.snapshot.pid === pid);
	}
	if (matches.length === 0) {
		throw new CollabLinkError("not_found", `no active Collab host matches ${wanted}`);
	}
	if (matches.length > 1) {
		const ids = matches.map(entry => entry.snapshot.instanceId).join(", ");
		throw new CollabLinkError("ambiguous", `${wanted} matches more than one Collab host; use an instance id: ${ids}`);
	}
	const [{ meta, snapshot }] = matches;
	if (access === "control" && snapshot.access !== "control") {
		throw new CollabLinkError("access_unavailable", `host ${snapshot.instanceId} publishes view access only`);
	}
	const timeoutMs = options?.timeoutMs ?? DEFAULT_QUERY_TIMEOUT_MS;
	const result = await query(meta, { op: "link", access, generation: snapshot.generation }, timeoutMs);
	if (result.status === "ok") {
		const { url } = result.value as Record<string, unknown>;
		if (typeof url === "string" && url.length > 0) {
			return { instanceId: snapshot.instanceId, generation: snapshot.generation, access, url };
		}
		throw new CollabLinkError("unreachable", `host ${snapshot.instanceId} returned an invalid link response`);
	}
	if (result.status === "skip" && result.error === "stale_generation") {
		throw new CollabLinkError(
			"stale_generation",
			`host ${snapshot.instanceId} started a new room since it was listed; list again and retry`,
		);
	}
	if (result.status === "skip" && result.error === "access_unavailable") {
		throw new CollabLinkError("access_unavailable", `host ${snapshot.instanceId} does not publish ${access} access`);
	}
	throw new CollabLinkError("unreachable", `host ${snapshot.instanceId} did not answer the link request`);
}
