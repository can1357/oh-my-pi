import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { IpcConnection } from "@oh-my-pi/pi-natives";
import { getBaseConfigRoot, isEnoent, isFsError } from "@oh-my-pi/pi-utils";
import {
	type AuthLine,
	type InboxRequest,
	isMailboxSessionId,
	type InboxResponse,
	LINE_DEADLINE_MS,
	MAX_PEER_TEXT_CHARS,
	MAX_SERIALIZED_CHARS,
	MessagingUnavailableError,
	parseInboxRequest,
	SEND_TIMEOUT_MS,
	SNAPSHOT_TIMEOUT_MS,
} from "./protocol";
import {
	assertPrivateDir,
	ensurePrivateDir,
	type InboxEntry,
	listLiveEntries,
	ownsEndpoint,
	publishEntry,
	readEntries,
} from "./registry";

const MAX_FRAME_BYTES = 3 * MAX_SERIALIZED_CHARS;

export type InboxAuth = "own-child" | "peer";
export interface InboxPublication {
	readonly registryDir: string;
	readonly entryId: string;
	readonly endpoint: string;
	readonly token: string;
	close(): Promise<void>;
}

export function messagingRegistryDir(): string {
	return path.join(getBaseConfigRoot(), "run", "messaging");
}

export async function resolveRegistry(dir: string, create: boolean): Promise<string> {
	const fallback = `/tmp/omp-socks-${process.getuid?.() ?? 0}`;
	try {
		if (create) await ensurePrivateDir(dir);
		else await assertPrivateDir(dir);
		return dir;
	} catch (err) {
		if (!create && isEnoent(err)) {
			if (process.platform !== "win32") {
				try {
					await assertPrivateDir(fallback);
					return fallback;
				} catch {
					// Missing or unsafe fallback directories are not discoverable.
				}
			}
			return dir;
		}
		if (process.platform === "win32") {
			throw new MessagingUnavailableError(err instanceof Error ? err.message : "Cannot open messaging registry");
		}
	}
	try {
		if (create) await ensurePrivateDir(fallback);
		else await assertPrivateDir(fallback);
		return fallback;
	} catch (err) {
		if (!create && isEnoent(err)) return fallback;
		throw new MessagingUnavailableError(err instanceof Error ? err.message : "Cannot open messaging registry");
	}
}

function tokenMatches(expected: string, presented: string): boolean {
	const a = Buffer.from(expected, "utf8");
	const b = Buffer.from(presented, "utf8");
	return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** One native line-framed request per connection; claim it before awaiting the handler. */
export function handleInboxConnection(
	connection: IpcConnection,
	handle: (req: InboxRequest, auth: InboxAuth) => Promise<InboxResponse>,
	options: { sessionToken: string; onClose?: () => void },
): void {
	let firstLine = true;
	let claimed = false;
	let auth: InboxAuth = "peer";
	let deadline = setTimeout(() => connection.destroy(), LINE_DEADLINE_MS);
	const respond = (response: InboxResponse): void => {
		claimed = true;
		clearTimeout(deadline);
		if (!connection.closed) {
			connection.send(JSON.stringify(response));
			connection.end();
		}
	};
	connection.start(
		line => {
			if (claimed || connection.closed) return;
			if (line.length > MAX_SERIALIZED_CHARS) {
				respond({ ok: false, error: "too_large" });
				return;
			}
			let raw: unknown;
			try {
				raw = JSON.parse(line);
			} catch {
				connection.destroy();
				return;
			}
			if (firstLine) {
				firstLine = false;
				if (typeof raw === "object" && raw !== null && (raw as AuthLine).type === "auth") {
					const value = raw as AuthLine;
					if (
						Object.keys(value).length !== 2 ||
						typeof value.token !== "string" ||
						!tokenMatches(options.sessionToken, value.token)
					) {
						connection.destroy();
						return;
					}
					auth = "own-child";
					clearTimeout(deadline);
					deadline = setTimeout(() => connection.destroy(), LINE_DEADLINE_MS);
					return;
				}
			}
			if (JSON.stringify(raw).length > MAX_SERIALIZED_CHARS) {
				respond({ ok: false, error: "too_large" });
				return;
			}
			const request = parseInboxRequest(raw);
			if (!request) {
				connection.destroy();
				return;
			}
			claimed = true;
			clearTimeout(deadline);
			void Promise.resolve()
				.then(() => handle(request, auth))
				.then(respond, () => respond({ ok: false, error: "internal" }));
		},
		() => {
			clearTimeout(deadline);
			options.onClose?.();
		},
	);
}

export async function publishInbox(
	handle: (req: InboxRequest, auth: InboxAuth) => Promise<InboxResponse>,
	options: { dir?: string; sessionId: string },
): Promise<InboxPublication> {
	try {
		const dir = await resolveRegistry(options.dir ?? messagingRegistryDir(), true);
		const token = crypto.randomBytes(32).toString("hex");
		const entryId = crypto.randomBytes(8).toString("hex");
		const publication = await publishEntry(dir, {
			entryId,
			sessionId: options.sessionId,
			maxConnections: 64,
			maxFrameBytes: MAX_FRAME_BYTES,
			onConnection: (connection, onClose) =>
				handleInboxConnection(connection, handle, { sessionToken: token, onClose }),
		});
		return {
			registryDir: dir,
			entryId,
			endpoint: publication.endpoint,
			token,
			close: () => publication.close(),
		};
	} catch (err) {
		if (err instanceof MessagingUnavailableError) throw err;
		throw new MessagingUnavailableError(err instanceof Error ? err.message : "Cannot publish messaging inbox");
	}
}

/** Metadata-only discovery for the mailbox handoff; never opens a socket. */
export async function readInboxEntries(options: { dir: string; signal?: AbortSignal }): Promise<InboxEntry[]> {
	return readEntries(options.dir, { signal: options.signal });
}

export async function listInboxEntries(options?: { dir?: string; signal?: AbortSignal }): Promise<InboxEntry[]> {
	if (options?.signal?.aborted) return [];
	return listLiveEntries(await resolveRegistry(options?.dir ?? messagingRegistryDir(), false), {
		timeoutMs: SNAPSHOT_TIMEOUT_MS,
		signal: options?.signal,
	});
}

async function vetEndpoint(dir: string, entry: InboxEntry): Promise<string | undefined> {
	if (process.platform === "win32") return undefined;
	try {
		const stat = await fs.promises.lstat(entry.endpoint);
		if (stat.isSymbolicLink()) return "Refusing to send: reply target is a symlink";
		if (!stat.isSocket() || stat.uid !== process.getuid?.() || !ownsEndpoint(dir, entry.entryId, entry.endpoint))
			return "Refusing to send: cannot vet reply target";
		await assertPrivateDir(path.dirname(path.resolve(entry.endpoint)));
		return undefined;
	} catch (error) {
		// A vanished socket is a session that exited, not a target we failed to vet.
		if (isEnoent(error)) return "unreachable";
		return "Refusing to send: cannot vet reply target";
	}
}

function parseResponse(raw: unknown): InboxResponse | undefined {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return undefined;
	const value = raw as Record<string, unknown>;
	if (value.ok === false && typeof value.error === "string") return { ok: false, error: value.error };
	if (value.ok !== true) return undefined;
	if (value.receivingSuspended !== undefined && (value.outcome !== "queued" || value.receivingSuspended !== true))
		return undefined;
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
		!isMailboxSessionId(s.sessionId) ||
		(s.name !== null && (typeof s.name !== "string" || s.name.length > MAX_PEER_TEXT_CHARS)) ||
		typeof s.shortId !== "string" ||
		!/^[0-9a-f]{8}$/.test(s.shortId) ||
		(s.title !== null && (typeof s.title !== "string" || s.title.length > MAX_PEER_TEXT_CHARS)) ||
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
	try {
		const dir = await resolveRegistry(options?.dir ?? messagingRegistryDir(), false);
		const refusal = await vetEndpoint(dir, entry);
		if (refusal) return { ok: false, error: refusal };
		if (serialized.length > MAX_SERIALIZED_CHARS) return { ok: false, error: "too_large" };
	} catch {
		return { ok: false, error: "Refusing to send: cannot vet reply target" };
	}
	if (options?.signal?.aborted) return { ok: false, error: "aborted" };
	const { promise, resolve } = Promise.withResolvers<InboxResponse>();
	const timeoutMs = options?.timeoutMs ?? (request.type === "snapshot" ? SNAPSHOT_TIMEOUT_MS : SEND_TIMEOUT_MS);
	let connection: IpcConnection | undefined;
	let finished = false;
	const finish = (response: InboxResponse): void => {
		if (finished) return;
		finished = true;
		clearTimeout(timer);
		options?.signal?.removeEventListener("abort", abort);
		connection?.destroy();
		resolve(response);
	};
	// A deadline means the peer is alive but slow; only a failed/closed connection is "unreachable".
	const timer = setTimeout(() => finish({ ok: false, error: "timeout" }), timeoutMs);
	const abort = (): void => finish({ ok: false, error: "aborted" });
	options?.signal?.addEventListener("abort", abort, { once: true });
	if (options?.signal?.aborted) abort();
	IpcConnection.connect(entry.endpoint, { framing: "lines", timeoutMs, maxFrameBytes: MAX_FRAME_BYTES }).then(
		conn => {
			if (finished) {
				conn.destroy();
				return;
			}
			connection = conn;
			conn.start(
				line => {
					if (line.length > MAX_SERIALIZED_CHARS) {
						finish({ ok: false, error: "too_large" });
						return;
					}
					try {
						finish(parseResponse(JSON.parse(line)) ?? { ok: false, error: "invalid_response" });
					} catch {
						finish({ ok: false, error: "invalid_response" });
					}
				},
				reason => finish({ ok: false, error: reason?.startsWith("EMSGSIZE") ? "too_large" : "unreachable" }),
			);
			if (!finished) conn.send(serialized);
		},
		(err: unknown) => {
			finish({ ok: false, error: isFsError(err) && err.code === "ETIMEDOUT" ? "timeout" : "unreachable" });
		},
	);
	return promise;
}
