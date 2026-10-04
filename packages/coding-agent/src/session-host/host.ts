/**
 * Session host: serves one AgentSession to any number of local clients over a
 * token-authenticated Unix socket (a named pipe on Windows), and advertises
 * itself in the session host registry while it runs.
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as path from "node:path";
import { Readable } from "node:stream";
import { isRecord, logger, postmortem, Snowflake } from "@oh-my-pi/pi-utils";
import { ensurePrivateDir, privateEndpoint, tokenMatches } from "../ipc/private-endpoint";
import type { RpcConnection } from "../modes/rpc/rpc-connection";
import { exitWithDisposeResult } from "../modes/rpc/rpc-mode";
import { RpcServer, type RpcServerOptions } from "../modes/rpc/rpc-server";
import { type AgentSession, SHUTDOWN_CONSOLIDATE_BUDGET_MS } from "../session/agent-session";
import { readSessionHeaderId } from "../session/session-loader";
import { FileSessionStorage } from "../session/session-storage";
import {
	findHostForSession,
	removeHostEntry,
	removeHostEntrySync,
	SESSION_HOST_ENDPOINT_PREFIX,
	SESSION_HOST_REGISTRY_LABEL,
	SESSION_HOST_REGISTRY_VERSION,
	type SessionHostEntry,
	sessionHostsDir,
	writeHostEntry,
} from "./registry";

/** A hello is a few hundred bytes; an unauthenticated peer may not buffer more. */
const MAX_HELLO_BYTES = 64 * 1024;
/** Default {@link SessionHostOptions.helloTimeoutMs}. */
const HELLO_TIMEOUT_MS = 10_000;
/** Default {@link SessionHostOptions.flushTimeoutMs}. */
const FLUSH_TIMEOUT_MS = 5_000;
const UNAUTHORIZED_LINE = `${JSON.stringify({ type: "response", command: "hello", success: false, code: "unauthorized", error: "unauthorized" })}\n`;

export interface SessionHostOptions extends Omit<RpcServerOptions, "onShutdown"> {
	hostId: string;
	registryDir?: string;
	/** Called after the last client's `exit` or an extension's `pi.shutdown()`; the caller disposes and exits. */
	onExit: () => Promise<never>;
	/** A new socket that has not sent its `hello` line by then is closed. Default 10 s. */
	helloTimeoutMs?: number;
	/** A leaving client's queued output that has not drained by then is discarded with the connection. Default 5 s. */
	flushTimeoutMs?: number;
}

interface LeaseClaim {
	/** Repointed when the same session is relocated (`/move`, `/wt`): the lease follows the session id, not the path. */
	file: string;
	sessionId: string;
	release: () => void;
}

/**
 * The parsed first line of `input` (`hello: undefined` when it is not a JSON
 * object or overruns {@link MAX_HELLO_BYTES}) and the stream after it;
 * `undefined` when the stream ends or fails first.
 */
async function readHello(
	input: ReadableStream<Uint8Array>,
): Promise<{ hello: Record<string, unknown> | undefined; rest: ReadableStream<Uint8Array> } | undefined> {
	const reader = input.getReader();
	const rest = (head: Uint8Array): ReadableStream<Uint8Array> =>
		new ReadableStream<Uint8Array>({
			start: controller => {
				if (head.length > 0) controller.enqueue(head);
			},
			pull: async controller => {
				const chunk = await reader.read();
				if (chunk.done) controller.close();
				else controller.enqueue(chunk.value);
			},
			cancel: reason => reader.cancel(reason),
		});
	let buffered: Uint8Array = new Uint8Array(0);
	try {
		for (;;) {
			const chunk = await reader.read();
			if (chunk.done) return undefined;
			buffered = buffered.length === 0 ? chunk.value : Buffer.concat([buffered, chunk.value]);
			const newline = buffered.indexOf(0x0a);
			if (newline < 0 && buffered.length <= MAX_HELLO_BYTES) continue;
			if (newline < 0 || newline > MAX_HELLO_BYTES) return { hello: undefined, rest: rest(buffered) };
			let hello: unknown;
			try {
				hello = JSON.parse(new TextDecoder().decode(buffered.subarray(0, newline)));
			} catch {
				hello = undefined;
			}
			return { hello: isRecord(hello) ? hello : undefined, rest: rest(buffered.subarray(newline + 1)) };
		}
	} catch {
		return undefined;
	}
}

/**
 * Serve `session` until the last client exits or an extension calls
 * `pi.shutdown()`. Claims the session's owner lease, listens, then publishes
 * the registry entry. Rejects if the lease is held or the listener fails.
 */
export async function runSessionHost(session: AgentSession, options: SessionHostOptions): Promise<never> {
	const {
		hostId,
		registryDir: requestedRegistryDir,
		onExit,
		helloTimeoutMs = HELLO_TIMEOUT_MS,
		flushTimeoutMs = FLUSH_TIMEOUT_MS,
		...serverOptions
	} = options;
	// Every use below must name the same directory, whatever the process's cwd is or becomes.
	const registryDir = path.resolve(requestedRegistryDir ?? sessionHostsDir());
	const storage = new FileSessionStorage();
	/**
	 * The lease key: the transcript id the session manager resolved from the header (or minted). Never
	 * `session.sessionId`, the provider routing id, which `--provider-session-id` pins and `/fresh` rotates;
	 * `claimSession` refuses a file whose header holds a different id.
	 */
	const transcriptId = (): string => session.sessionManager.getSessionId();
	const claim = (file: string, sessionId: string): LeaseClaim | undefined => {
		const release = storage.claimSession(sessionId, file);
		return release ? { file, sessionId, release } : undefined;
	};
	/** Whether `held` is the lease of the live session in `file` (a session with no file needs none). */
	const holds = (held: LeaseClaim | undefined, file: string | undefined): boolean =>
		held === undefined ? file === undefined : held.file === file && held.sessionId === transcriptId();

	// The session's own file, then a switch target `onBeforeSwitch` claimed until the switch settles.
	let owned: LeaseClaim | undefined;
	let pending: LeaseClaim | undefined;
	const initialFile = session.sessionFile === undefined ? undefined : path.resolve(session.sessionFile);
	if (initialFile !== undefined) {
		owned = claim(initialFile, transcriptId());
		if (!owned) {
			const host = await findHostForSession(initialFile, registryDir);
			logger.warn("Session host cannot claim its session", { sessionFile: initialFile, owner: host?.hostId });
			throw new Error(`session already open in ${host ? `host ${host.hostId}` : "another process"}`);
		}
	}

	const token = crypto.randomBytes(32).toString("hex");
	const startedAt = Date.now();
	/** Authenticated connections still attached; `detach`/`exit`/close remove them. */
	const clients = new Set<RpcConnection>();
	const sockets = new Set<net.Socket>();
	const lifetime = Promise.withResolvers<never>();
	let busy = false;
	/** Registry writes run only between the first publication and the start of teardown. */
	let published = false;
	let lastEntry = "";
	let writes: Promise<void> = Promise.resolve();
	let stopping: Promise<never> | undefined;
	let endpoint = "";
	/**
	 * What this attempt created, so it removes only that. `bound`: `listen` succeeded, the endpoint is ours (set when
	 * the bind lands, not when the path is chosen). `entryWritten`: the first registry write landed (the entry is
	 * renamed into place last, so a rejected write leaves nothing). A failed bind (`EADDRINUSE`: a live host already
	 * has this id) creates neither, so it cannot remove that host's socket or registry entry.
	 */
	let bound = false;
	let entryWritten = false;

	const entry = (): SessionHostEntry => ({
		version: SESSION_HOST_REGISTRY_VERSION,
		hostId,
		pid: process.pid,
		endpoint,
		token,
		cwd: session.sessionManager.getCwd(),
		sessionFile: session.sessionFile,
		title: session.sessionName,
		clients: clients.size,
		busy,
		startedAt,
	});
	/** Rewrite the entry if it changed, serialized behind every earlier rewrite. */
	const publish = (): void => {
		if (!published || stopping) return;
		const next = entry();
		const json = JSON.stringify(next);
		if (json === lastEntry) return;
		lastEntry = json;
		writes = writes
			.then(() => (stopping || !published ? undefined : writeHostEntry(next, registryDir)))
			.catch(error => {
				// Retry on the next change instead of treating the failed state as published.
				lastEntry = "";
				logger.warn("Session host registry update failed", { hostId, error: String(error) });
			});
	};
	const removeArtifactsSync = (): void => {
		try {
			if (entryWritten) removeHostEntrySync(hostId, registryDir);
			if (bound && process.platform !== "win32") fs.rmSync(endpoint, { force: true });
		} catch {
			// Best-effort: the next registry listing prunes a survivor.
		}
	};
	/**
	 * Withdraws the entry on any process end before stop() removed it. Through postmortem, not the `exit`
	 * event: its SIGTERM/SIGINT/fatal exits end via `reallyExit`, which never emits `exit`. An `exit`
	 * event runs only the synchronous part; a signal exit also outwaits a rewrite already in flight,
	 * which would otherwise land after the removal.
	 */
	const withdraw = async (): Promise<void> => {
		published = false;
		removeArtifactsSync();
		await writes;
		removeArtifactsSync();
	};
	/** A no-op until the host is published and registers {@link withdraw}. */
	let unregisterWithdraw = (): void => {};

	const server = await RpcServer.start(session, {
		...serverOptions,
		hostId,
		// `pi.shutdown()`: the server already disposed the session and wrote every owed response.
		onShutdown: async () => lifetime.resolve(stop()),
	}).catch(error => {
		owned?.release();
		throw error;
	});
	server.onBeforeSwitch = async target => {
		if (target === owned?.file) return undefined;
		// In-process leases are reference-counted, so the registry is asked first.
		const host = await findHostForSession(target, registryDir);
		if (host && host.hostId !== hostId) return { hostId: host.hostId };
		// The lease is keyed by the session id in the target's header. A file with no header (absent or empty) holds
		// no session, so no running writer owns it: the switch proceeds and `onEpochChanged` claims what it creates.
		const targetId = await readSessionHeaderId(target);
		const next = targetId === undefined ? undefined : claim(target, targetId);
		if (targetId !== undefined && !next) return { hostId: "unknown" };
		pending?.release();
		pending = next;
		return undefined;
	};
	server.onEpochChanged = (_epoch, sessionFile) => {
		const file = sessionFile === undefined ? undefined : path.resolve(sessionFile);
		if (!holds(owned, file)) {
			// The switch has completed, so the live session's transcript id is the new session's.
			const next = holds(pending, file) ? pending : file === undefined ? undefined : claim(file, transcriptId());
			if (file !== undefined && !next)
				logger.warn("Session host cannot claim its new session", { sessionFile: file });
			owned?.release();
			owned = next;
		}
		if (pending !== owned) pending?.release();
		pending = undefined;
		publish();
	};
	// `/move` and `/wt` relocate the same session: no entry, no epoch change, and the same id, so the lease stays held
	// (a release and re-claim would open a window for another process). Only the path moved; clients find it again
	// through the registry entry, so it is republished now instead of whenever a later entry happens to be appended.
	server.onSessionRelocated = sessionFile => {
		if (owned && sessionFile !== undefined) owned.file = path.resolve(sessionFile);
		publish();
	};
	// A cancelled or failed switch adopted nothing; a successful one was adopted by `onEpochChanged` above.
	server.onSwitchSettled = () => {
		pending?.release();
		pending = undefined;
	};

	/** Deliver `conn`'s queued output, but never wait on a client that stopped reading past `flushTimeoutMs`. */
	const flush = async (conn: RpcConnection): Promise<void> => {
		const deadline = Promise.withResolvers<void>();
		const timer = setTimeout(deadline.resolve, flushTimeoutMs);
		try {
			await Promise.race([conn.close().catch(() => {}), deadline.promise]);
		} finally {
			clearTimeout(timer);
		}
	};

	/** Last-client `exit` or `pi.shutdown()`: withdraw the host, then hand off to `onExit`. */
	const stop = (): Promise<never> => {
		stopping ??= (async () => {
			unsubscribeEvents();
			unsubscribeEntries();
			// Closing unlinks the POSIX socket; the pipe vanishes with it on Windows.
			listener.close();
			const conns = [...server.connections];
			// drop() discards unflushed output, so every owed frame is flushed first.
			await Promise.all(conns.map(flush));
			for (const conn of conns) void server.disconnect(conn, "session host stopped");
			for (const socket of sockets) socket.destroy();
			await writes;
			try {
				await removeHostEntry(hostId, registryDir);
			} catch (error) {
				logger.warn("Session host registry removal failed", { hostId, error: String(error) });
			}
			// The spawner's log of a clean run; a crash or signal exit never gets here, so its log stays.
			// ponytail: removed before onExit's dispose, so an exit-1 durability mirror on stderr is lost from it (the
			// omp log still records the failure); gate on the exit code if a detached host's stderr must survive.
			await fs.promises.rm(path.join(registryDir, `${hostId}.log`), { force: true }).catch(() => {});
			// Only now: a signal before this point still withdraws the entry. The teardown hook stays: a signal
			// during onExit's dispose must wait for it (dispose() is memoized), not exit mid-dispose.
			unregisterWithdraw();
			pending?.release();
			owned?.release();
			return onExit();
		})();
		return stopping;
	};

	/** `detach`, `exit`, or a closed socket; repeated calls for one connection are no-ops. */
	const leave = (conn: RpcConnection, command: "detach" | "exit"): void => {
		if (!clients.delete(conn)) return;
		if (command === "exit" && clients.size === 0) {
			lifetime.resolve(stop());
			return;
		}
		void (async () => {
			// drop() discards unflushed output: deliver the `detach` response first.
			await flush(conn);
			void server.disconnect(conn, `client ${command}`);
			server.broadcastClients();
			publish();
		})();
	};
	server.onLeave = leave;

	const accept = async (socket: net.Socket): Promise<void> => {
		sockets.add(socket);
		socket.once("close", () => sockets.delete(socket));
		socket.on("error", error => logger.debug("Session host socket error", { hostId, error: String(error) }));
		// Absolute, not an idle timeout: a peer trickling bytes cannot hold the socket open either.
		const helloDeadline = setTimeout(() => socket.destroy(), helloTimeoutMs);
		const read = await readHello(Readable.toWeb(socket) as ReadableStream<Uint8Array>);
		clearTimeout(helloDeadline);
		// Closed before a hello: a registry liveness probe.
		if (!read) {
			socket.destroy();
			return;
		}
		const { hello, rest } = read;
		if (hello?.type !== "hello" || !tokenMatches(token, hello.token)) {
			socket.end(UNAUTHORIZED_LINE, () => socket.destroy());
			return;
		}
		if (stopping || socket.destroyed) {
			socket.destroy();
			return;
		}
		const { client, capabilities, resume, protocolVersion } = hello;
		const conn = server.connect(
			{ input: rest, sink: socket },
			{
				sequenced: true,
				ui: isRecord(capabilities) && capabilities.ui === true,
				clientId: Snowflake.next() as string,
				client:
					isRecord(client) && typeof client.kind === "string"
						? { kind: client.kind, label: typeof client.label === "string" ? client.label : undefined }
						: undefined,
			},
		);
		// Before attach(): `attached`, a resume's replay, and every later frame use v2 chunking instead of v1 shrinking.
		if (protocolVersion === 2) conn.encoder.setProtocolVersion(2);
		// Same tick as connect(): no broadcast can fall between registration and the handshake frame.
		server.attach(
			conn,
			isRecord(resume) &&
				resume.hostId === hostId &&
				typeof resume.epoch === "number" &&
				typeof resume.lastSeq === "number"
				? { epoch: resume.epoch, lastSeq: resume.lastSeq }
				: undefined,
		);
		clients.add(conn);
		// The socket's `close` reports the departure; a reset only ends the input early.
		void conn.inputClosed.catch(() => {});
		socket.once("close", () => leave(conn, "detach"));
		server.broadcastClients();
		publish();
	};

	const listener = net.createServer(socket => {
		// A throw after auth (e.g. snapshot() while the session is disposing) must not become a fatal unhandled rejection.
		void accept(socket).catch(error => {
			logger.warn("Session host accept failed", { hostId, error: String(error) });
			socket.destroy();
		});
	});
	const unsubscribeEvents = session.subscribe(event => {
		if (event.type !== "agent_start" && event.type !== "agent_end") return;
		busy = event.type === "agent_start";
		publish();
	});
	// Title changes land as entries.
	const unsubscribeEntries = session.sessionManager.subscribeEntryAppended(() => publish());

	try {
		await ensurePrivateDir(registryDir, SESSION_HOST_REGISTRY_LABEL);
		endpoint = await privateEndpoint(registryDir, hostId, {
			prefix: SESSION_HOST_ENDPOINT_PREFIX,
			label: SESSION_HOST_REGISTRY_LABEL,
		});
		const listening = Promise.withResolvers<void>();
		listener.once("error", listening.reject);
		listener.listen(endpoint, listening.resolve);
		await listening.promise;
		bound = true;
		listener.off("error", listening.reject);
		listener.on("error", error => logger.warn("Session host listener error", { hostId, error: String(error) }));
		if (process.platform !== "win32") await fs.promises.chmod(endpoint, 0o600);
		const first = entry();
		await writeHostEntry(first, registryDir);
		entryWritten = true;
		lastEntry = JSON.stringify(first);
		published = true;
	} catch (error) {
		unsubscribeEvents();
		unsubscribeEntries();
		listener.close();
		removeArtifactsSync();
		owned?.release();
		throw error;
	}
	unregisterWithdraw = postmortem.register(`session-host-${hostId}`, withdraw, { exitOnly: true });
	// Signal and fatal exits end the process from postmortem's cleanup, so the session is disposed there.
	postmortem.register(
		`session-host-teardown-${hostId}`,
		reason => session.dispose({ reason, mnemopiConsolidateTimeoutMs: SHUTDOWN_CONSOLIDATE_BUDGET_MS }),
		{ exitOnly: true },
	);
	logger.debug("Session host listening", { hostId, endpoint, sessionFile: session.sessionFile });
	return lifetime.promise;
}

/**
 * {@link SessionHostOptions.onExit} for a host process. Disposes the session
 * (after `pi.shutdown()` the server already did; `dispose()` is memoized) and
 * exits like stdio RPC mode: 1 with a stderr mirror when the rejection is the
 * store failure still latched at close, 0 on success. Any other rejection
 * propagates.
 */
export async function exitAfterHostDispose(session: AgentSession): Promise<never> {
	try {
		await session.dispose();
	} catch (error) {
		// Subscribing replays the failure the store still has latched; `close()` rejects with that same error.
		let latched: Error | undefined;
		session.sessionManager.onPersistenceError(failure => {
			latched = failure;
		})();
		if (error !== latched) throw error;
		return exitWithDisposeResult({ persistenceFailure: latched });
	}
	return exitWithDisposeResult({});
}
