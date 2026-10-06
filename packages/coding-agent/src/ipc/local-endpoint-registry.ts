/** Private local endpoints, atomic discovery metadata, and bounded JSONL helpers. */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils";
import { mapWithConcurrencyLimit } from "../task/parallel";

export interface LocalEndpointRegistry {
	/** Private metadata directory (created 0700 on POSIX; symlink/foreign-owner rejected). */
	readonly dir: string;
	/** Windows endpoint: `\\\\.\\pipe\\${pipePrefix}-${entryId}`; POSIX: `${dir}/${entryId}.sock` (or short fallback). */
	readonly pipePrefix: string;
	/** Wire + metadata version; any mismatch fails safely. */
	readonly version: number;
	readonly maxRequestBytes: number;
	readonly maxResponseBytes: number;
	/** Optional short socket directory for a protocol-specific fallback. */
	readonly socketFallbackDir?: string;
	/** Collab requires the discovery bearer token; inbox metadata carries no secret. */
	readonly requireToken?: boolean;
}

export interface LocalEndpointMetadata {
	version: number;
	instanceId: string; // /^[a-z0-9-]{8,64}$/
	pid: number;
	endpoint: string;
	createdAt: number;
	[key: string]: unknown;
}

export type LocalEndpointResponse = { ok: true; [key: string]: unknown } | { ok: false; error: string };
/** Called after version + token checks pass. Throwing responds { ok:false, error:"handler_failed" }. */
export type LocalEndpointHandler = (
	request: Readonly<Record<string, unknown>>,
) => LocalEndpointResponse | Promise<LocalEndpointResponse>;

export interface LocalEndpointPublication {
	readonly entryId: string;
	readonly endpoint: string;
	/** Stop serving, destroy live clients, remove metadata (+ POSIX socket). Idempotent. */
	close(): Promise<void>;
}

export type LocalEndpointQueryResult<T> =
	| { status: "ok"; value: T }
	| { status: "dead" }
	| { status: "skip"; error?: string };
export interface LocalEndpointEntry {
	readonly entryId: string;
	readonly meta: LocalEndpointMetadata;
}

const INSTANCE_ID_PATTERN = /^[a-z0-9-]{8,64}$/;
const SUN_PATH_LIMIT = process.platform === "darwin" ? 104 : 108;
const DEFAULT_SOCKET_FALLBACK_BASE = "/tmp";

/** Another OS's transport cannot be probed for liveness in this process. */
function isForeignTransport(endpoint: string): boolean {
	return process.platform === "win32" ? endpoint.startsWith("/") : endpoint.toLowerCase().startsWith("\\\\.\\pipe\\");
}

function parseMetadata(
	registry: LocalEndpointRegistry,
	text: string,
): LocalEndpointMetadata | "foreign_transport" | null {
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		return null;
	}
	if (typeof raw !== "object" || raw === null) return null;
	const meta = raw as Record<string, unknown>;
	if (typeof meta.endpoint === "string" && isForeignTransport(meta.endpoint)) return "foreign_transport";
	if (typeof meta.version !== "number") return null;
	if (typeof meta.instanceId !== "string" || !INSTANCE_ID_PATTERN.test(meta.instanceId)) return null;
	if (typeof meta.pid !== "number" || !Number.isInteger(meta.pid) || meta.pid <= 0) return null;
	if (typeof meta.endpoint !== "string" || meta.endpoint.length === 0) return null;
	if (typeof meta.createdAt !== "number") return null;
	if (registry.requireToken && (typeof meta.token !== "string" || meta.token.length === 0)) return null;
	return {
		...meta,
		version: meta.version,
		instanceId: meta.instanceId,
		pid: meta.pid,
		endpoint: meta.endpoint,
		createdAt: meta.createdAt,
	};
}

/** Constant-time check of a presented bearer token. */
export function tokenMatches(expected: string, presented: unknown): boolean {
	if (typeof presented !== "string") return false;
	const a = Buffer.from(expected, "utf8");
	const b = Buffer.from(presented, "utf8");
	if (a.length !== b.length) return false;
	return crypto.timingSafeEqual(a, b);
}

/** One request per connection; claim it before awaiting an asynchronous handler. */
export function handleLocalEndpointRequest(
	socket: net.Socket,
	registry: LocalEndpointRegistry,
	token: string,
	handler: LocalEndpointHandler,
): void {
	let buffer = "";
	let handled = false;
	const respond = (payload: LocalEndpointResponse): void => {
		handled = true;
		// Keep the Collab envelope's key order while adding the version centrally.
		const { ok, ...fields } = payload;
		const envelope = { ok, v: registry.version, ...fields };
		envelope.v = registry.version;
		socket.end(`${JSON.stringify(envelope)}\n`);
	};
	const fail = (error: string): void => respond({ ok: false, error });
	socket.setEncoding("utf8");
	socket.on("error", () => socket.destroy());
	socket.on("data", async chunk => {
		if (handled) return;
		buffer += chunk;
		if (Buffer.byteLength(buffer, "utf8") > registry.maxRequestBytes) {
			handled = true;
			socket.destroy();
			return;
		}
		const newline = buffer.indexOf("\n");
		if (newline < 0) return;
		handled = true;
		let request: unknown;
		try {
			request = JSON.parse(buffer.slice(0, newline).trim());
		} catch {
			fail("malformed_request");
			return;
		}
		if (typeof request !== "object" || request === null) {
			fail("malformed_request");
			return;
		}
		const record = request as Record<string, unknown>;
		if (record.v !== registry.version) {
			fail("unsupported_protocol");
			return;
		}
		if (!tokenMatches(token, record.token)) {
			fail("authentication_failed");
			return;
		}
		try {
			respond(await handler(record));
		} catch {
			// Never expose a handler's exception (which may contain capabilities).
			fail("handler_failed");
		}
	});
}

/** Listing also checks this: pruning must never follow a planted directory symlink. */
export async function assertPrivateDir(registry: LocalEndpointRegistry, dir: string): Promise<void> {
	const stat = await fs.promises.lstat(dir);
	const label = `${registry.pipePrefix.replace(/^omp-/, "")} registry`;
	if (stat.isSymbolicLink()) throw new Error(`${label} directory is a symlink: ${dir}`);
	if (!stat.isDirectory()) throw new Error(`${label} path is not a directory: ${dir}`);
	// Windows inherits the profile ACL; no SID-owner probing.
	if (process.platform === "win32") return;
	const uid = process.getuid?.();
	if (uid !== undefined && stat.uid !== uid) {
		throw new Error(`${label} directory is not owned by the current user: ${dir}`);
	}
	if ((stat.mode & 0o077) !== 0) await fs.promises.chmod(dir, 0o700);
}

export async function ensurePrivateDir(registry: LocalEndpointRegistry, dir: string): Promise<void> {
	await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
	await assertPrivateDir(registry, dir);
}

/** Short owner-private directory, keyed by uid and canonical metadata directory. */
function socketFallbackDir(registry: LocalEndpointRegistry, base: string): string {
	const key = new Bun.CryptoHasher("sha256")
		.update(String(process.getuid?.() ?? 0))
		.update("\0")
		.update(registry.dir)
		.digest("hex")
		.slice(0, 20);
	return path.join(base, `${registry.pipePrefix}-${key}`);
}

async function resolveSocketEndpoint(
	registry: LocalEndpointRegistry,
	entryId: string,
	fallbackBase: string,
): Promise<string> {
	const canonical = path.join(registry.dir, `${entryId}.sock`);
	if (Buffer.byteLength(canonical) < SUN_PATH_LIMIT) return canonical;
	const shortDir = registry.socketFallbackDir ?? socketFallbackDir(registry, fallbackBase);
	await ensurePrivateDir(registry, shortDir);
	return path.join(shortDir, `${entryId}.sock`);
}

export async function publishLocalEndpoint(
	registry: LocalEndpointRegistry,
	onConnection: (socket: net.Socket) => void,
	options?: {
		instanceId?: string;
		entryId?: string;
		socketFallbackBase?: string;
		idleTimeoutMs?: number;
		maxConnections?: number;
		extra?: Record<string, unknown>;
	},
): Promise<LocalEndpointPublication> {
	await ensurePrivateDir(registry, registry.dir);
	const instanceId = options?.instanceId ?? crypto.randomBytes(8).toString("hex");
	if (!INSTANCE_ID_PATTERN.test(instanceId)) {
		throw new Error(`invalid ${registry.pipePrefix.replace(/^omp-/, "")} registry instance id`);
	}
	// Unique publication IDs prevent crash pruning from deleting a successor.
	const entryId = options?.entryId ?? crypto.randomBytes(8).toString("hex");
	if (!INSTANCE_ID_PATTERN.test(entryId)) throw new Error("invalid local endpoint entry id");
	const endpoint =
		process.platform === "win32"
			? `\\\\.\\pipe\\${registry.pipePrefix}-${entryId}`
			: await resolveSocketEndpoint(registry, entryId, options?.socketFallbackBase ?? DEFAULT_SOCKET_FALLBACK_BASE);
	const metaPath = path.join(registry.dir, `${entryId}.json`);
	const liveSockets = new Set<net.Socket>();
	const server = net.createServer(socket => {
		if (options?.maxConnections !== undefined && liveSockets.size >= options.maxConnections) {
			socket.destroy();
			return;
		}
		liveSockets.add(socket);
		socket.once("close", () => liveSockets.delete(socket));
		if (options?.idleTimeoutMs) socket.setTimeout(options.idleTimeoutMs, () => socket.destroy());
		onConnection(socket);
	});
	if (options?.maxConnections !== undefined) server.maxConnections = options.maxConnections;
	const listening = Promise.withResolvers<void>();
	server.once("error", err => listening.reject(err));
	server.listen(endpoint, () => listening.resolve());
	try {
		await listening.promise;
		if (process.platform !== "win32") await fs.promises.chmod(endpoint, 0o600);
		const meta: LocalEndpointMetadata = {
			version: registry.version,
			instanceId,
			pid: process.pid,
			endpoint,
			createdAt: Date.now(),
			...options?.extra,
		};
		// Publish atomically: a concurrent list must never see partial metadata.
		const tmpPath = `${metaPath}.tmp`;
		const handle = await fs.promises.open(tmpPath, "wx", 0o600);
		try {
			try {
				await handle.writeFile(JSON.stringify(meta), "utf8");
			} finally {
				await handle.close();
			}
			await fs.promises.rename(tmpPath, metaPath);
		} catch (err) {
			fs.rmSync(tmpPath, { force: true });
			throw err;
		}
	} catch (err) {
		server.close();
		for (const socket of liveSockets) socket.destroy();
		if (process.platform !== "win32") fs.rmSync(endpoint, { force: true });
		throw err;
	}

	const removeArtifactsSync = (): void => {
		try {
			fs.rmSync(metaPath, { force: true });
			if (process.platform !== "win32") fs.rmSync(endpoint, { force: true });
		} catch {
			// A survivor is pruned by the next list.
		}
	};
	process.once("exit", removeArtifactsSync);
	let closing: Promise<void> | undefined;
	return {
		entryId,
		endpoint,
		close(): Promise<void> {
			if (closing) return closing;
			const done = Promise.withResolvers<void>();
			closing = done.promise;
			process.off("exit", removeArtifactsSync);
			server.close(() => done.resolve());
			for (const socket of liveSockets) socket.destroy();
			removeArtifactsSync();
			return closing;
		},
	};
}

/** Sends `{ ...request, v, token }`; reads one bounded response line. */
export function queryLocalEndpoint(
	registry: LocalEndpointRegistry,
	meta: LocalEndpointMetadata,
	request: object,
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<LocalEndpointQueryResult<Record<string, unknown>>> {
	if (signal?.aborted) return Promise.resolve({ status: "skip", error: "aborted" });
	if (meta.version !== registry.version) return Promise.resolve({ status: "skip", error: "unsupported_protocol" });
	if (isForeignTransport(meta.endpoint)) return Promise.resolve({ status: "skip", error: "foreign_transport" });
	const { promise, resolve } = Promise.withResolvers<LocalEndpointQueryResult<Record<string, unknown>>>();
	let buffer = "";
	let finished = false;
	const socket = net.createConnection({ path: meta.endpoint });
	const timer = setTimeout(() => finish({ status: "skip" }), timeoutMs);
	const finish = (result: LocalEndpointQueryResult<Record<string, unknown>>): void => {
		if (finished) return;
		finished = true;
		clearTimeout(timer);
		signal?.removeEventListener("abort", abort);
		socket.destroy();
		resolve(result);
	};
	const abort = (): void => finish({ status: "skip", error: "aborted" });
	socket.setEncoding("utf8");
	socket.once("error", err => {
		// Resource/permission errors say nothing about liveness; never prune them.
		const code = (err as NodeJS.ErrnoException).code;
		finish({ status: code === "ENOENT" || code === "ECONNREFUSED" ? "dead" : "skip" });
	});
	socket.once("connect", () => {
		if (finished) return;
		socket.write(`${JSON.stringify({ v: registry.version, token: meta.token, ...request })}\n`);
	});
	socket.on("data", chunk => {
		if (finished) return;
		buffer += chunk;
		if (Buffer.byteLength(buffer, "utf8") > registry.maxResponseBytes) {
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
		const record = response as Record<string, unknown>;
		if (record.v !== registry.version) {
			finish({ status: "skip", error: "unsupported_protocol" });
			return;
		}
		if (record.ok !== true) {
			finish({ status: "skip", error: typeof record.error === "string" ? record.error : undefined });
			return;
		}
		finish({ status: "ok", value: record });
	});
	socket.once("close", () => finish({ status: "skip" }));
	signal?.addEventListener("abort", abort, { once: true });
	if (signal?.aborted) abort();
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

/** Artifact names are unique per publication, never shared with its successor. */
async function pruneEntry(
	registry: LocalEndpointRegistry,
	name: string,
	meta: LocalEndpointMetadata | null,
): Promise<void> {
	try {
		if (meta && isForeignTransport(meta.endpoint)) return;
		if (meta && meta.version !== registry.version && pidAlive(meta.pid)) return;
		const metaPath = path.join(registry.dir, name);
		if (process.platform !== "win32") {
			const stat = await fs.promises.lstat(metaPath);
			if (!stat.isFile() || stat.uid !== process.getuid?.()) return;
		}
		await fs.promises.rm(metaPath, { force: true });
		// Only remove sockets in locations this registry could have created.
		const ownsEndpoint =
			meta !== null &&
			process.platform !== "win32" &&
			(meta.endpoint.startsWith(registry.dir + path.sep) ||
				meta.endpoint.startsWith(
					(registry.socketFallbackDir ?? socketFallbackDir(registry, DEFAULT_SOCKET_FALLBACK_BASE)) + path.sep,
				));
		if (ownsEndpoint) await fs.promises.rm(meta.endpoint, { force: true });
	} catch {
		// Best-effort; another process may already have pruned it.
	}
}

async function readEntries(
	registry: LocalEndpointRegistry,
	prune: boolean,
	signal?: AbortSignal,
	includeAllVersions = false,
): Promise<LocalEndpointEntry[]> {
	let names: string[];
	try {
		await assertPrivateDir(registry, registry.dir);
		names = await fs.promises.readdir(registry.dir);
	} catch (err) {
		if (isEnoent(err)) return [];
		throw err;
	}
	const entries: LocalEndpointEntry[] = [];
	for (const name of names.filter(name => name.endsWith(".json")).sort()) {
		if (signal?.aborted) break;
		let text: string;
		try {
			const metaPath = path.join(registry.dir, name);
			if (process.platform !== "win32") {
				const stat = await fs.promises.lstat(metaPath);
				if (!stat.isFile() || stat.uid !== process.getuid?.()) continue;
			}
			text = await Bun.file(metaPath).text();
		} catch {
			continue;
		}
		const meta = parseMetadata(registry, text);
		if (meta === "foreign_transport") continue;
		if (!meta) {
			if (prune && !signal?.aborted) await pruneEntry(registry, name, null);
			continue;
		}
		if (meta.version !== registry.version) {
			if (!pidAlive(meta.pid)) {
				if (prune && !signal?.aborted) await pruneEntry(registry, name, meta);
				continue;
			}
			if (!includeAllVersions) continue;
		}
		entries.push({ entryId: name.slice(0, -".json".length), meta });
	}
	return entries;
}

/** Valid metadata entries (malformed/version-mismatched skipped), without probing. */
export function readLocalEndpointEntries(registry: LocalEndpointRegistry): Promise<LocalEndpointEntry[]> {
	return readEntries(registry, false);
}

/**
 * Probe compatible entries (concurrency 8), or all versions when requested.
 * Prune dead entries, but preserve foreign-version artifacts while their owning pid is alive.
 */
export async function listLocalEndpoints<T>(
	registry: LocalEndpointRegistry,
	probe: (entry: LocalEndpointEntry) => Promise<LocalEndpointQueryResult<T>>,
	options?: { signal?: AbortSignal; includeAllVersions?: boolean },
): Promise<Array<{ entry: LocalEndpointEntry; value: T }>> {
	if (options?.signal?.aborted) return [];
	const entries = await readEntries(registry, true, options?.signal, options?.includeAllVersions);
	const live: Array<{ entry: LocalEndpointEntry; value: T }> = [];
	await mapWithConcurrencyLimit(
		entries,
		8,
		async entry => {
			const result = await probe(entry);
			if (options?.signal?.aborted) return;
			if (result.status === "ok") live.push({ entry, value: result.value });
			else if (result.status === "dead") await pruneEntry(registry, `${entry.entryId}.json`, entry.meta);
		},
		options?.signal,
	);
	return live;
}
