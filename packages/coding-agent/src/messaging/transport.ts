import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { getBaseConfigRoot, isEnoent } from "@oh-my-pi/pi-utils";
import {
	assertPrivateDir,
	ensurePrivateDir,
	type LocalEndpointQueryResult,
	type LocalEndpointRegistry,
	listLocalEndpoints,
	publishLocalEndpoint,
	tokenMatches,
} from "../ipc/local-endpoint-registry";
import {
	type AuthLine,
	type InboxRequest,
	type InboxResponse,
	LINE_DEADLINE_MS,
	MAX_SERIALIZED_CHARS,
	MESSAGING_WIRE_VERSION,
	MessagingUnavailableError,
	parseInboxRequest,
	SEND_TIMEOUT_MS,
	SNAPSHOT_TIMEOUT_MS,
} from "./protocol";

export type InboxAuth = "own-child" | "peer";
export interface InboxPublication {
	readonly entryId: string;
	readonly endpoint: string;
	readonly token: string;
	close(): Promise<void>;
}
export interface InboxEntry {
	readonly version: number;
	readonly entryId: string;
	readonly pid: number;
	readonly endpoint: string;
	readonly createdAt: number;
}

export function messagingRegistryDir(): string {
	return path.join(getBaseConfigRoot(), "run", "messaging");
}

function registryFor(dir: string): LocalEndpointRegistry {
	return {
		dir,
		pipePrefix: "omp-msg",
		version: MESSAGING_WIRE_VERSION,
		maxRequestBytes: MAX_SERIALIZED_CHARS,
		maxResponseBytes: MAX_SERIALIZED_CHARS,
		socketFallbackDir: `/tmp/omp-socks-${process.getuid?.() ?? 0}`,
	};
}

async function resolveRegistry(dir: string, create: boolean): Promise<LocalEndpointRegistry> {
	const registry = registryFor(dir);
	try {
		if (create) await ensurePrivateDir(registry, dir);
		else await assertPrivateDir(registry, dir);
		return registry;
	} catch (err) {
		if (!create && isEnoent(err)) return registry;
		if (process.platform === "win32") {
			throw new MessagingUnavailableError(err instanceof Error ? err.message : "Cannot open messaging registry");
		}
	}
	const fallback = registryFor(registry.socketFallbackDir!);
	try {
		if (create) await ensurePrivateDir(fallback, fallback.dir);
		else await assertPrivateDir(fallback, fallback.dir);
		return fallback;
	} catch (err) {
		if (!create && isEnoent(err)) return fallback;
		throw new MessagingUnavailableError(err instanceof Error ? err.message : "Cannot open messaging registry");
	}
}

// Share in-flight creation only; closed/replaced registries never inherit cached secrets.
const peerKeyReads = new Map<string, Promise<string>>();
async function readPeerKey(registry: LocalEndpointRegistry): Promise<string> {
	const keyPath = path.join(registry.dir, "peer.key");
	const pending = peerKeyReads.get(keyPath);
	if (pending) return pending;
	const read = (async (): Promise<string> => {
		try {
			const handle = await fs.promises.open(keyPath, "wx", 0o600);
			const key = crypto.randomBytes(32).toString("hex");
			try {
				await handle.writeFile(key, "utf8");
			} finally {
				await handle.close();
			}
			return key;
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
		}
		// Windows relies on the private profile ACL, not a SID-owner API.
		const handle = await fs.promises.open(keyPath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
		try {
			const stat = await handle.stat();
			if (!stat.isFile() || (process.platform !== "win32" && stat.uid !== process.getuid?.())) {
				throw new Error("Messaging peer key is not a current-user file");
			}
			if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) await handle.chmod(0o600);
			// An O_EXCL winner in another process may still be writing its 64-byte key.
			const deadline = Date.now() + 1_000;
			let key = await handle.readFile("utf8");
			while (key.length === 0 && Date.now() < deadline) {
				await Bun.sleep(5);
				key = await handle.readFile("utf8");
			}
			if (!/^[0-9a-f]{64}$/.test(key)) throw new Error("Invalid messaging peer key");
			return key;
		} finally {
			await handle.close();
		}
	})();
	peerKeyReads.set(keyPath, read);
	try {
		return await read;
	} finally {
		peerKeyReads.delete(keyPath);
	}
}

/** JSONL connection boundary; requireAuth also lets tests exercise Windows framing on POSIX. */
export function handleInboxConnection(
	socket: net.Socket,
	handle: (req: InboxRequest, auth: InboxAuth) => Promise<InboxResponse>,
	options: { sessionToken: string; peerKey: string; requireAuth: boolean },
): void {
	let buffer = "";
	let firstLine = true;
	let claimed = false;
	let auth: InboxAuth = "peer";
	let deadline = setTimeout(() => socket.destroy(), LINE_DEADLINE_MS);
	const respond = (response: InboxResponse): void => {
		claimed = true;
		clearTimeout(deadline);
		if (!socket.destroyed) socket.end(`${JSON.stringify(response)}\n`);
	};
	socket.setEncoding("utf8");
	socket.on("error", () => socket.destroy());
	socket.once("close", () => clearTimeout(deadline));
	socket.on("data", chunk => {
		if (claimed) return;
		buffer += chunk;
		while (!claimed) {
			const newline = buffer.indexOf("\n");
			if (newline < 0) {
				if (buffer.length > MAX_SERIALIZED_CHARS) {
					if (firstLine && options.requireAuth) socket.destroy();
					else respond({ ok: false, error: "too_large" });
				}
				return;
			}
			const line = buffer.slice(0, newline);
			buffer = buffer.slice(newline + 1);
			clearTimeout(deadline);
			if (line.length > MAX_SERIALIZED_CHARS) {
				if (firstLine && options.requireAuth) socket.destroy();
				else respond({ ok: false, error: "too_large" });
				return;
			}
			let raw: unknown;
			try {
				raw = JSON.parse(line);
			} catch {
				socket.destroy();
				return;
			}
			if (firstLine) {
				firstLine = false;
				if (typeof raw === "object" && raw !== null && (raw as AuthLine).type === "auth") {
					const value = raw as AuthLine;
					if (Object.keys(value).length !== 2 || typeof value.token !== "string") {
						socket.destroy();
						return;
					}
					if (tokenMatches(options.sessionToken, value.token)) auth = "own-child";
					else if (!tokenMatches(options.peerKey, value.token)) {
						socket.destroy();
						return;
					}
					deadline = setTimeout(() => socket.destroy(), LINE_DEADLINE_MS);
					continue;
				}
				if (options.requireAuth) {
					socket.destroy();
					return;
				}
			}
			if (JSON.stringify(raw).length > MAX_SERIALIZED_CHARS) {
				respond({ ok: false, error: "too_large" });
				return;
			}
			const request = parseInboxRequest(raw);
			if (!request) {
				socket.destroy();
				return;
			}
			claimed = true;
			buffer = "";
			void Promise.resolve()
				.then(() => handle(request, auth))
				.then(respond, () => respond({ ok: false, error: "internal" }));
		}
	});
}

export async function publishInbox(
	handle: (req: InboxRequest, auth: InboxAuth) => Promise<InboxResponse>,
	options?: { dir?: string },
): Promise<InboxPublication> {
	try {
		const registry = await resolveRegistry(options?.dir ?? messagingRegistryDir(), true);
		const peerKey = await readPeerKey(registry);
		const token = crypto.randomBytes(32).toString("hex");
		const entryId = crypto.randomBytes(8).toString("hex");
		const publication = await publishLocalEndpoint(
			registry,
			socket =>
				handleInboxConnection(socket, handle, {
					sessionToken: token,
					peerKey,
					requireAuth: process.platform === "win32",
				}),
			{ instanceId: entryId, entryId, extra: { entryId, version: MESSAGING_WIRE_VERSION }, maxConnections: 64 },
		);
		return { entryId, endpoint: publication.endpoint, token, close: () => publication.close() };
	} catch (err) {
		if (err instanceof MessagingUnavailableError) throw err;
		throw new MessagingUnavailableError(err instanceof Error ? err.message : "Cannot publish messaging inbox");
	}
}

export async function listInboxEntries(options?: { dir?: string; signal?: AbortSignal }): Promise<InboxEntry[]> {
	if (options?.signal?.aborted) return [];
	const registry = await resolveRegistry(options?.dir ?? messagingRegistryDir(), false);
	const live = await listLocalEndpoints(
		registry,
		entry => {
			const { promise, resolve } = Promise.withResolvers<LocalEndpointQueryResult<InboxEntry>>();
			const socket = net.createConnection({ path: entry.meta.endpoint });
			let finished = false;
			const finish = (result: LocalEndpointQueryResult<InboxEntry>): void => {
				if (finished) return;
				finished = true;
				clearTimeout(timer);
				options?.signal?.removeEventListener("abort", abort);
				socket.destroy();
				resolve(result);
			};
			const timer = setTimeout(() => finish({ status: "skip" }), SNAPSHOT_TIMEOUT_MS);
			const abort = (): void => finish({ status: "skip" });
			socket.once("error", err => {
				const code = (err as NodeJS.ErrnoException).code;
				finish({ status: code === "ENOENT" || code === "ECONNREFUSED" ? "dead" : "skip" });
			});
			socket.once("connect", () =>
				finish({
					status: "ok",
					value: {
						version: entry.meta.version,
						entryId: entry.entryId,
						pid: entry.meta.pid,
						endpoint: entry.meta.endpoint,
						createdAt: entry.meta.createdAt,
					},
				}),
			);
			socket.once("close", () => finish({ status: "skip" }));
			options?.signal?.addEventListener("abort", abort, { once: true });
			if (options?.signal?.aborted) abort();
			return promise;
		},
		{ ...options, includeAllVersions: true },
	);
	return live.map(({ value }) => value);
}

async function vetEndpoint(registry: LocalEndpointRegistry, endpoint: string): Promise<string | undefined> {
	if (process.platform === "win32") return undefined;
	try {
		const stat = await fs.promises.lstat(endpoint);
		if (stat.isSymbolicLink()) return "Refusing to send: reply target is a symlink";
		const dir = path.dirname(path.resolve(endpoint));
		if (
			!stat.isSocket() ||
			stat.uid !== process.getuid?.() ||
			(dir !== path.resolve(registry.dir) && dir !== path.resolve(registry.socketFallbackDir!))
		)
			return "Refusing to send: cannot vet reply target";
		await assertPrivateDir(registry, dir);
		return undefined;
	} catch (error) {
		// A vanished socket is a session that exited, not a target we failed to vet.
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return "unreachable";
		return "Refusing to send: cannot vet reply target";
	}
}

function parseResponse(raw: unknown): InboxResponse | undefined {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
	const value = raw as Record<string, unknown>;
	if (value.ok === false && typeof value.error === "string") return { ok: false, error: value.error };
	if (value.ok !== true) return undefined;
	if (
		typeof value.outcome === "string" &&
		["delivered", "queued", "held", "refused", "subscribed"].includes(value.outcome)
	) {
		return value as InboxResponse;
	}
	if (
		value.outcome === "dropped" &&
		typeof value.reason === "string" &&
		["queue_full", "rate", "repeat", "relay_loop"].includes(value.reason)
	) {
		return value as InboxResponse;
	}
	if (typeof value.snapshot !== "object" || value.snapshot === null || Array.isArray(value.snapshot)) return undefined;
	const s = value.snapshot as Record<string, unknown>;
	if (
		typeof s.v !== "number" ||
		!Number.isFinite(s.v) ||
		(s.name !== null && (typeof s.name !== "string" || s.name.length > 200)) ||
		typeof s.shortId !== "string" ||
		!/^[0-9a-f]{8}$/.test(s.shortId) ||
		(s.title !== null && typeof s.title !== "string") ||
		typeof s.cwd !== "string" ||
		s.cwd.length > 4096 ||
		typeof s.busy !== "boolean" ||
		typeof s.pid !== "number" ||
		!Number.isInteger(s.pid) ||
		s.pid <= 0 ||
		typeof s.startedAt !== "number" ||
		!Number.isFinite(s.startedAt)
	)
		return undefined;
	return value as InboxResponse;
}

export async function requestInbox(
	entry: InboxEntry,
	request: InboxRequest,
	options?: { timeoutMs?: number; signal?: AbortSignal; dir?: string },
): Promise<InboxResponse> {
	if (options?.signal?.aborted) return { ok: false, error: "aborted" };
	const serialized = JSON.stringify(request);
	let peerKey: string;
	try {
		const registry = await resolveRegistry(options?.dir ?? messagingRegistryDir(), false);
		const refusal = await vetEndpoint(registry, entry.endpoint);
		if (refusal) return { ok: false, error: refusal };
		if (serialized.length > MAX_SERIALIZED_CHARS) return { ok: false, error: "too_large" };
		peerKey = await readPeerKey(registry);
	} catch {
		return { ok: false, error: "Refusing to send: cannot vet reply target" };
	}
	if (options?.signal?.aborted) return { ok: false, error: "aborted" };
	const { promise, resolve } = Promise.withResolvers<InboxResponse>();
	const socket = net.createConnection({ path: entry.endpoint });
	let buffer = "";
	let finished = false;
	const finish = (response: InboxResponse): void => {
		if (finished) return;
		finished = true;
		clearTimeout(timer);
		options?.signal?.removeEventListener("abort", abort);
		socket.destroy();
		resolve(response);
	};
	const timer = setTimeout(
		() => finish({ ok: false, error: "unreachable" }),
		options?.timeoutMs ?? (request.type === "snapshot" ? SNAPSHOT_TIMEOUT_MS : SEND_TIMEOUT_MS),
	);
	const abort = (): void => finish({ ok: false, error: "aborted" });
	socket.setEncoding("utf8");
	socket.once("error", () => finish({ ok: false, error: "unreachable" }));
	socket.once("close", () => finish({ ok: false, error: "unreachable" }));
	socket.once("connect", () => {
		if (!finished) socket.write(`${JSON.stringify({ type: "auth", token: peerKey })}\n${serialized}\n`);
	});
	socket.on("data", chunk => {
		if (finished) return;
		buffer += chunk;
		const newline = buffer.indexOf("\n");
		if ((newline < 0 ? buffer.length : newline) > MAX_SERIALIZED_CHARS) {
			finish({ ok: false, error: "too_large" });
			return;
		}
		if (newline < 0) return;
		try {
			finish(parseResponse(JSON.parse(buffer.slice(0, newline))) ?? { ok: false, error: "invalid_response" });
		} catch {
			finish({ ok: false, error: "invalid_response" });
		}
	});
	options?.signal?.addEventListener("abort", abort, { once: true });
	if (options?.signal?.aborted) abort();
	return promise;
}
