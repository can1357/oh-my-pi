import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as path from "node:path";
import type { AuthStorage } from "@oh-my-pi/pi-ai";
import { getActiveProfile, logger, popLoopPhase, postmortem, pushLoopPhase, VERSION } from "@oh-my-pi/pi-utils";
import { ModelRegistry } from "../config/model-registry";
import { MCPManagerPool } from "../mcp";
import { type CreateAgentSessionOptions, discoverAuthStorage } from "../sdk";
import { listAllSessions, listSessions } from "../session/session-listing";
import { FileSessionStorage } from "../session/session-storage";
import { daemonBuildStamp } from "./build-stamp";
import {
	DAEMON_OWNER_FILE,
	daemonEndpoint,
	daemonRuntimeDir,
	ensureDaemonRuntimeDir,
	readOrCreateDaemonToken,
} from "./paths";
import {
	DAEMON_MAX_FRAME_BYTES,
	DAEMON_PROTOCOL_MAJOR,
	type DaemonErrorCode,
	type DaemonFrame,
	type DaemonHello,
	type DaemonOperation,
	DaemonProtocolError,
	type DaemonRequest,
	type DaemonServerStatus,
	decodeDaemonFrame,
	encodeDaemonFrame,
} from "./protocol";
import { DaemonSessionRegistry, RegistryError } from "./session-registry";
import { createAgentSessionRuntime, type DaemonSessionRuntimeFactory } from "./session-runtime";
import type { DaemonProfile } from "./status";

const DEFAULT_MAX_CLIENTS = 64;
const OWNER_FILE = DAEMON_OWNER_FILE;
/** How long a contender waits out a live-but-unbound owner (starting or draining). */
const OWNER_LEASE_WAIT_MS = 10_000;
const TAKEOVER_FILE = "daemon.takeover";
const OWNER_TERMINATE_GRACE_MS = 1_000;
const SKIP_DISPATCH = Symbol("skip daemon dispatch");
class DaemonEndpointOwnedError extends Error {}

type Connection = {
	socket: net.Socket;
	buffer: string;
	authenticated: boolean;
	attachments: Set<string>;
	requestIds: Set<string>;
	closed: boolean;
	generation: number;
};

type DaemonOwnerLease = {
	pid: number;
	daemonId: string;
	startedAt: number;
};
type DaemonOwnerIdentity = "match" | "mismatch" | "unknown";

export type DaemonServerOptions = {
	profile: DaemonProfile;
	runtimeDir?: string;
	endpoint?: string;
	token?: string;
	daemonId?: string;
	serverVersion?: string;
	/** Build pairing identity override (tests); defaults to daemonBuildStamp(). */
	buildStamp?: string;
	/** Lease patience override (tests); defaults to OWNER_LEASE_WAIT_MS. */
	ownerLeaseWaitMs?: number;
	/** Process identity override for isolated owner-takeover tests. */
	ownerProcessVerifier?: (
		owner: Readonly<{ pid: number; daemonId: string; startedAt: number }>,
	) => boolean | undefined | Promise<boolean | undefined>;
	runtimeFactory?: DaemonSessionRuntimeFactory;
	registry?: DaemonSessionRegistry;
	now?: () => number;
	maxClients?: number;
	sessionDir?: string;
};

export type DaemonShutdownResult = {
	shutdown: boolean;
	blockers: Array<"clients" | "sessions" | "protected_jobs">;
};

function unknownErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): DaemonErrorCode {
	if (error instanceof RegistryError) return error.code;
	if (error instanceof DaemonProtocolError) return error.code;
	return "internal";
}

function requestIdOf(value: unknown): string | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value) || !("requestId" in value)) return undefined;
	const requestId = value.requestId;
	return typeof requestId === "string" && requestId.length > 0 ? requestId : undefined;
}

function constantTimeTokenEquals(expected: string, provided: string): boolean {
	const left = Buffer.from(expected, "utf8");
	const right = Buffer.from(provided, "utf8");
	return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function frameType(value: unknown): string | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value) || !("type" in value)) return undefined;
	const type = value.type;
	return typeof type === "string" ? type : undefined;
}

function frameSeq(value: unknown): number | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value) || !("seq" in value)) return undefined;
	const seq = value.seq;
	return typeof seq === "number" && Number.isInteger(seq) ? seq : undefined;
}

/** Authenticated per-profile Unix socket daemon. */
export class DaemonServer {
	readonly profile: DaemonProfile;
	readonly #runtimeDirOverride: string | undefined;
	readonly #endpointOverride: string | undefined;
	readonly #tokenOverride: string | undefined;
	readonly #daemonId: string;
	readonly #serverVersion: string;
	readonly #buildStampOverride: string | undefined;
	#buildStamp: string | undefined;
	readonly #runtimeFactory: DaemonSessionRuntimeFactory;
	readonly #registryOverride: DaemonSessionRegistry | undefined;
	readonly #ownerLeaseWaitMs: number;
	readonly #ownerProcessVerifier:
		| ((owner: Readonly<DaemonOwnerLease>) => boolean | undefined | Promise<boolean | undefined>)
		| undefined;
	readonly #now: () => number;
	readonly #maxClients: number;
	readonly #sessionDir: string | undefined;
	readonly #usesDefaultRuntimeFactory: boolean;
	readonly #startedAt: number;
	readonly #connections = new Set<Connection>();
	/**
	 * Every accepted kernel socket, including pre-handshake and half-closed
	 * ones already released from #connections. net.Server.close() waits for
	 * ALL of them; shutdown destroys the set so one lingering peer cannot
	 * park the daemon exit forever.
	 */
	readonly #rawSockets = new Set<net.Socket>();
	/** Per-session serialization chains for lifecycle ops (see {@link #serializationKey}). */
	#lifecycleQueues = new Map<string, Promise<void>>();
	/** Every in-flight lifecycle op; shutdown drains these before registry dispose. */
	#inflightLifecycle = new Set<Promise<unknown>>();
	#registry: DaemonSessionRegistry | undefined;
	#server: net.Server | undefined;
	#runtimeDir: string | undefined;
	#endpoint: string | undefined;
	#token: string | undefined;
	#closed = false;
	#ownerHandle: fs.FileHandle | undefined;
	#ownerPath: string | undefined;
	#postmortemCancel: (() => void) | undefined;
	#shutdownPromise: Promise<DaemonShutdownResult> | undefined;
	#sharedAuthStorage: AuthStorage | undefined;
	#sharedMcpManagerPool: MCPManagerPool | undefined;
	#sessionBaseOptions: CreateAgentSessionOptions | undefined;
	readonly #runtimeReady = Promise.withResolvers<void>();
	#runPromise: Promise<this> | undefined;

	constructor(options: DaemonServerOptions) {
		this.profile = options.profile;
		this.#runtimeDirOverride = options.runtimeDir;
		this.#endpointOverride = options.endpoint;
		this.#tokenOverride = options.token;
		this.#daemonId = options.daemonId ?? crypto.randomUUID();
		this.#serverVersion = options.serverVersion ?? VERSION;
		this.#buildStampOverride = options.buildStamp;
		this.#ownerLeaseWaitMs =
			Number.isFinite(options.ownerLeaseWaitMs) && options.ownerLeaseWaitMs! >= 1
				? Math.floor(options.ownerLeaseWaitMs!)
				: OWNER_LEASE_WAIT_MS;
		this.#ownerProcessVerifier = options.ownerProcessVerifier;
		this.#runtimeFactory = options.runtimeFactory ?? createAgentSessionRuntime;
		this.#usesDefaultRuntimeFactory = options.runtimeFactory === undefined;
		this.#registryOverride = options.registry;
		this.#now = options.now ?? Date.now;
		this.#maxClients = Math.max(1, Math.trunc(options.maxClients ?? DEFAULT_MAX_CLIENTS));
		this.#sessionDir = options.sessionDir;
		this.#startedAt = this.#now();
	}

	get registry(): DaemonSessionRegistry {
		if (!this.#registry) throw new Error("daemon server is not running");
		return this.#registry;
	}

	get endpoint(): string | undefined {
		return this.#endpoint;
	}

	get token(): string | undefined {
		return this.#token;
	}

	get closed(): boolean {
		return this.#closed;
	}

	/** Start listening after runtime/token/socket permissions are established. */
	async run(): Promise<this> {
		this.#runPromise ??= this.#start();
		return this.#runPromise;
	}

	async #start(): Promise<this> {
		this.#runtimeDir = this.#runtimeDirOverride ?? daemonRuntimeDir();
		this.#endpoint = this.#endpointOverride ?? daemonEndpoint(this.#runtimeDir);
		await ensureDaemonRuntimeDir(this.#runtimeDir);
		this.#token = this.#tokenOverride ?? (await readOrCreateDaemonToken(this.#runtimeDir));
		await this.#acquireOwnerLease();
		try {
			// The pairing identity MUST exist before the socket accepts a single
			// `hello`: `hello_ok` omits an unset stamp, and a client that reads no
			// stamp classifies this daemon as a pre-pairing build and shuts it
			// down — including the replacement it just spawned itself, which is a
			// `connect ENOENT` loop until the client's start deadline expires.
			this.#buildStamp = this.#buildStampOverride ?? (await daemonBuildStamp());
			for (;;) {
				const server = net.createServer(socket => this.#accept(socket));
				server.on("error", error => logger.error("Daemon server error", { error: unknownErrorMessage(error) }));
				this.#server = server;
				const listening = Promise.withResolvers<void>();
				const onError = (error: Error): void => listening.reject(error);
				server.once("error", onError);
				server.listen(this.#endpoint, () => {
					server.off("error", onError);
					listening.resolve();
				});
				try {
					await listening.promise;
					break;
				} catch (error) {
					server.off("error", onError);
					this.#server = undefined;
					if (error instanceof Error && "code" in error && error.code === "EADDRINUSE") {
						if (await this.#probeEndpoint())
							throw new DaemonEndpointOwnedError(`daemon endpoint is already owned: ${this.#endpoint}`);
						await fs.rm(this.#endpoint, { force: true });
						continue;
					}
					throw error;
				}
			}
			await fs.chmod(this.#endpoint, 0o600);
			this.#postmortemCancel = postmortem.register("daemon-server", async () => {
				await this.shutdown(true);
			});

			if (this.#usesDefaultRuntimeFactory) {
				this.#sharedAuthStorage = await discoverAuthStorage();
				const modelRegistry = new ModelRegistry(this.#sharedAuthStorage);
				this.#sharedMcpManagerPool = new MCPManagerPool();
				this.#sessionBaseOptions = {
					authStorage: this.#sharedAuthStorage,
					modelRegistry,
					mcpManagerPool: this.#sharedMcpManagerPool,
				};
			}
			const runtimeFactory: DaemonSessionRuntimeFactory = this.#usesDefaultRuntimeFactory
				? options => this.#runtimeFactory({ ...options, baseOptions: this.#sessionBaseOptions })
				: this.#runtimeFactory;
			this.#registry =
				this.#registryOverride ??
				new DaemonSessionRegistry({
					runtimeFactory,
					sessionDir: this.#sessionDir,
					listSessions: () =>
						this.#sessionDir ? listSessions(this.#sessionDir, new FileSessionStorage()) : listAllSessions(),
				});
			this.#runtimeReady.resolve();
			return this;
		} catch (error) {
			this.#closed = true;
			for (const socket of this.#rawSockets) socket.destroy();
			const server = this.#server;
			this.#server = undefined;
			if (server) {
				const closed = Promise.withResolvers<void>();
				server.close(() => closed.resolve());
				await closed.promise;
			}
			this.#postmortemCancel?.();
			this.#postmortemCancel = undefined;
			if ((await this.#ownsCurrentLease()) && this.#endpoint) await fs.rm(this.#endpoint, { force: true });
			await this.#disposeSharedResources();
			await this.#releaseOwnerLease();
			throw error;
		}
	}
	async #acquireOwnerLease(): Promise<void> {
		const ownerPath = path.join(this.#runtimeDir!, OWNER_FILE);
		this.#ownerPath = ownerPath;
		// A live owner without a responsive endpoint is initially transient: it
		// may still be starting or draining. Every stale-owner mutation is
		// serialized by an owner-generation-specific takeover lease.
		const deadline = Date.now() + this.#ownerLeaseWaitMs;
		for (;;) {
			try {
				const handle = await fs.open(ownerPath, "wx", 0o600);
				await handle.writeFile(
					JSON.stringify({ pid: process.pid, daemonId: this.#daemonId, startedAt: this.#startedAt }),
					"utf8",
				);
				this.#ownerHandle = handle;
				return;
			} catch (error) {
				const code = error instanceof Error && "code" in error ? error.code : undefined;
				if (code !== "EEXIST") throw error;
				if (await this.#probeEndpoint())
					throw new DaemonEndpointOwnedError(`daemon endpoint is already owned: ${this.#endpoint}`);
				const owner = await this.#readOwnerLease(ownerPath);
				const outcome = await this.#takeOverUnresponsiveOwner(ownerPath, owner, Date.now() >= deadline);
				if (outcome === "owned") return;
				if (outcome === "unsafe")
					throw new Error(`daemon owner is still starting or draining; replacement is unsafe: ${this.#endpoint}`);
				await Bun.sleep(100);
			}
		}
	}

	async #takeOverUnresponsiveOwner(
		ownerPath: string,
		expectedOwner: DaemonOwnerLease | undefined,
		replaceLiveOwner: boolean,
	): Promise<"owned" | "waiting" | "unsafe"> {
		const generation = expectedOwner?.daemonId ?? "invalid";
		const takeoverPath = path.join(this.#runtimeDir!, `${TAKEOVER_FILE}.${generation}`);
		let takeoverHandle: fs.FileHandle;
		try {
			takeoverHandle = await fs.open(takeoverPath, "wx", 0o600);
			await takeoverHandle.writeFile(
				JSON.stringify({ pid: process.pid, daemonId: this.#daemonId, startedAt: this.#startedAt }),
				"utf8",
			);
		} catch (error) {
			const code = error instanceof Error && "code" in error ? error.code : undefined;
			if (code === "EEXIST") return "waiting";
			throw error;
		}
		try {
			if (await this.#probeEndpoint()) return "waiting";
			const owner = await this.#readOwnerLease(ownerPath);
			if (expectedOwner && (owner?.pid !== expectedOwner.pid || owner.daemonId !== expectedOwner.daemonId)) {
				return "waiting";
			}
			if (!expectedOwner && owner) return "waiting";
			if (owner && this.#processAlive(owner.pid)) {
				if (!replaceLiveOwner) return "waiting";
				const identity = await this.#ownerProcessIdentity(owner);
				if (identity === "unknown" && this.#processAlive(owner.pid)) return "unsafe";
				if (identity === "match") {
					process.kill(owner.pid, "SIGTERM");
					if (!(await this.#waitForProcessExit(owner.pid, OWNER_TERMINATE_GRACE_MS))) {
						process.kill(owner.pid, "SIGKILL");
						if (!(await this.#waitForProcessExit(owner.pid, OWNER_TERMINATE_GRACE_MS))) return "unsafe";
					}
				}
			}
			const current = await this.#readOwnerLease(ownerPath);
			if (
				(owner === undefined && current === undefined) ||
				(owner !== undefined && current?.pid === owner.pid && current.daemonId === owner.daemonId)
			) {
				await fs.rm(ownerPath, { force: true });
			} else {
				return "waiting";
			}
			try {
				const handle = await fs.open(ownerPath, "wx", 0o600);
				await handle.writeFile(
					JSON.stringify({ pid: process.pid, daemonId: this.#daemonId, startedAt: this.#startedAt }),
					"utf8",
				);
				this.#ownerHandle = handle;
				return "owned";
			} catch (error) {
				const code = error instanceof Error && "code" in error ? error.code : undefined;
				if (code === "EEXIST") return "waiting";
				throw error;
			}
		} finally {
			await takeoverHandle.close().catch(() => undefined);
			await fs.rm(takeoverPath, { force: true });
		}
	}

	async #readOwnerLease(ownerPath: string): Promise<DaemonOwnerLease | undefined> {
		try {
			const owner = JSON.parse(await Bun.file(ownerPath).text()) as Partial<DaemonOwnerLease>;
			if (
				typeof owner.pid !== "number" ||
				!Number.isInteger(owner.pid) ||
				owner.pid <= 0 ||
				typeof owner.daemonId !== "string" ||
				owner.daemonId.length === 0 ||
				typeof owner.startedAt !== "number" ||
				!Number.isFinite(owner.startedAt)
			) {
				return undefined;
			}
			return { pid: owner.pid, daemonId: owner.daemonId, startedAt: owner.startedAt };
		} catch {
			return undefined;
		}
	}

	#processAlive(pid: number): boolean {
		try {
			process.kill(pid, 0);
			return true;
		} catch (error) {
			const code = error instanceof Error && "code" in error ? error.code : undefined;
			return code !== "ESRCH";
		}
	}

	async #ownerProcessIdentity(owner: DaemonOwnerLease): Promise<DaemonOwnerIdentity> {
		if (this.#ownerProcessVerifier) {
			const matches = await this.#ownerProcessVerifier(owner);
			return matches === undefined ? "unknown" : matches ? "match" : "mismatch";
		}
		if (process.platform !== "linux") return "unknown";
		try {
			const [processStat, commandLine] = await Promise.all([
				fs.stat(`/proc/${owner.pid}`),
				Bun.file(`/proc/${owner.pid}/cmdline`).text(),
			]);
			// A recycled PID belongs to a process created after this lease. The
			// proc directory ctime is the process creation time on Linux. The
			// worker selector additionally distinguishes an OMP daemon host from
			// an unrelated process that later inherited the same PID.
			if (processStat.ctimeMs > owner.startedAt + 1_000) return "mismatch";
			return commandLine.split("\0").includes("__omp_worker_daemon_server") ? "match" : "mismatch";
		} catch {
			return "unknown";
		}
	}

	async #waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
		const deadline = Date.now() + timeoutMs;
		while (this.#processAlive(pid)) {
			if (Date.now() >= deadline) return false;
			await Bun.sleep(20);
		}
		return true;
	}

	async #ownsCurrentLease(): Promise<boolean> {
		if (!this.#ownerPath) return false;
		const owner = await this.#readOwnerLease(this.#ownerPath);
		return owner?.pid === process.pid && owner.daemonId === this.#daemonId;
	}

	async #probeEndpoint(): Promise<boolean> {
		const endpoint = this.#endpoint;
		const token = this.#token;
		if (!endpoint || !token) return false;
		const { promise, resolve } = Promise.withResolvers<boolean>();
		const socket = net.createConnection({ path: endpoint });
		let buffer = "";
		let settled = false;
		const finish = (healthy: boolean): void => {
			if (settled) return;
			settled = true;
			socket.destroy();
			resolve(healthy);
		};
		const timer = setTimeout(() => finish(false), 250);
		socket.setEncoding("utf8");
		socket.on("connect", () => {
			socket.write(
				encodeDaemonFrame({
					v: DAEMON_PROTOCOL_MAJOR,
					tag: "hello",
					requestId: `probe-${this.#daemonId}`,
					profile: this.profile,
					token,
				}),
			);
		});
		socket.on("data", chunk => {
			buffer += String(chunk);
			const newline = buffer.indexOf("\n");
			if (newline < 0) return;
			clearTimeout(timer);
			try {
				const frame = decodeDaemonFrame(buffer.slice(0, newline));
				finish(frame.tag === "hello_ok");
			} catch {
				finish(false);
			}
		});
		socket.once("error", () => {
			clearTimeout(timer);
			finish(false);
		});
		socket.once("close", () => {
			clearTimeout(timer);
			finish(false);
		});
		return promise;
	}

	async #releaseOwnerLease(): Promise<void> {
		const handle = this.#ownerHandle;
		const ownerPath = this.#ownerPath;
		this.#ownerHandle = undefined;
		this.#ownerPath = undefined;
		if (!handle || !ownerPath) return;
		await handle.close().catch(() => undefined);
		try {
			const owner = JSON.parse(await Bun.file(ownerPath).text()) as { daemonId?: unknown };
			if (owner.daemonId === this.#daemonId) await fs.rm(ownerPath, { force: true });
		} catch {
			// A stale-owner contender or external cleanup may already have removed it.
		}
	}

	status(): DaemonServerStatus {
		const counts = this.#registry?.status() ?? { sessionCount: 0, attachmentCount: 0, protectedJobCount: 0 };
		return {
			daemonId: this.#daemonId,
			serverVersion: this.#serverVersion,
			protocolVersion: DAEMON_PROTOCOL_MAJOR,
			shard: {
				profile: this.profile,
			},
			sessionCount: counts.sessionCount,
			attachmentCount: counts.attachmentCount,
			protectedJobCount: counts.protectedJobCount,
			uptimeMs: Math.max(0, this.#now() - this.#startedAt),
			...(this.#buildStamp === undefined ? {} : { buildStamp: this.#buildStamp }),
		};
	}

	idleShutdownEligible(): boolean {
		return (
			this.#connections.size === 0 &&
			!this.#registry?.hasLiveSessions &&
			(this.#registry?.protectedJobCount ?? 0) === 0
		);
	}

	async #disposeSharedResources(): Promise<void> {
		const mcpManagerPool = this.#sharedMcpManagerPool;
		const authStorage = this.#sharedAuthStorage;
		this.#sharedMcpManagerPool = undefined;
		this.#sharedAuthStorage = undefined;
		this.#sessionBaseOptions = undefined;
		try {
			await mcpManagerPool?.dispose();
		} finally {
			authStorage?.close();
		}
	}

	async shutdown(force = false): Promise<DaemonShutdownResult> {
		if (this.#shutdownPromise) return this.#shutdownPromise;
		const blockers = this.#shutdownBlockers();
		if (blockers.length > 0 && !force) return { shutdown: false, blockers };
		this.#shutdownPromise = (async () => {
			this.#closed = true;
			for (const connection of [...this.#connections]) {
				connection.socket.destroy();
				this.#releaseConnection(connection);
			}
			// Half-closed or handshake-orphaned sockets may already be out of
			// #connections while net.Server still counts them; a single lingering
			// socket parks server.close() — and this shutdown — forever.
			for (const socket of [...this.#rawSockets]) socket.destroy();
			try {
				// Drain in-flight lifecycle ops (bounded): a session_create whose
				// runtime factory is mid-await would otherwise install into a
				// disposed registry and leak the runtime.
				if (this.#inflightLifecycle.size > 0) {
					await Promise.race([Promise.allSettled([...this.#inflightLifecycle]), Bun.sleep(5_000)]);
				}
				await this.#registry?.dispose();
				const server = this.#server;
				this.#server = undefined;
				if (server) {
					await new Promise<void>(resolve => {
						let settled = false;
						const finish = (): void => {
							if (settled) return;
							settled = true;
							clearTimeout(timer);
							resolve();
						};
						const timer = setTimeout(() => {
							// Deterministic exit beats a perfect close: destroy
							// whatever lingers and stop waiting. close() settles
							// later on its own; nothing awaits it anymore.
							for (const socket of [...this.#rawSockets]) socket.destroy();
							finish();
						}, 2_000);
						server.close(() => finish());
					});
				}
				if (this.#endpoint && (await this.#ownsCurrentLease())) await fs.rm(this.#endpoint, { force: true });
				return { shutdown: true, blockers: [] };
			} finally {
				try {
					await this.#disposeSharedResources();
				} finally {
					try {
						await this.#releaseOwnerLease();
					} finally {
						const cancel = this.#postmortemCancel;
						this.#postmortemCancel = undefined;
						cancel?.();
					}
				}
			}
		})();
		return this.#shutdownPromise;
	}

	#shutdownBlockers(excluded?: Connection): Array<"clients" | "sessions" | "protected_jobs"> {
		const blockers: Array<"clients" | "sessions" | "protected_jobs"> = [];
		if ([...this.#connections].some(connection => connection !== excluded)) blockers.push("clients");
		// In-flight lifecycle ops count as live sessions: a mid-create session
		// is about to exist and must not be shut down out from under.
		if (this.#registry?.hasLiveSessions || this.#inflightLifecycle.size > 0) blockers.push("sessions");
		if ((this.#registry?.protectedJobCount ?? 0) > 0) blockers.push("protected_jobs");
		return blockers;
	}

	#accept(socket: net.Socket): void {
		this.#rawSockets.add(socket);
		socket.on("close", () => this.#rawSockets.delete(socket));
		if (this.#closed || this.#connections.size >= this.#maxClients) {
			socket.destroy();
			return;
		}
		const connection: Connection = {
			socket,
			buffer: "",
			authenticated: false,
			attachments: new Set(),
			requestIds: new Set(),
			closed: false,
			generation: 0,
		};
		this.#connections.add(connection);
		socket.setEncoding("utf8");
		socket.on("data", chunk => this.#onData(connection, typeof chunk === "string" ? chunk : chunk.toString("utf8")));
		socket.on("error", () => undefined);
		socket.on("end", () => this.#releaseConnection(connection));
		socket.on("close", () => this.#releaseConnection(connection));
	}

	#releaseConnection(connection: Connection): void {
		if (connection.closed) return;
		connection.closed = true;
		connection.generation++;
		// A half-close ('end') removes the connection from tracking while the
		// kernel socket stays open; net.Server.close() would wait on it forever.
		connection.socket.destroy();
		for (const key of connection.attachments) {
			const separator = key.indexOf("\0");
			if (separator > 0) this.#registry?.disconnect(key.slice(0, separator), key.slice(separator + 1));
		}
		connection.attachments.clear();
		this.#connections.delete(connection);
	}
	#onData(connection: Connection, chunk: string): void {
		connection.buffer += chunk;
		if (Buffer.byteLength(connection.buffer, "utf8") > DAEMON_MAX_FRAME_BYTES && !connection.buffer.includes("\n")) {
			connection.socket.destroy();
			return;
		}
		for (;;) {
			const newline = connection.buffer.indexOf("\n");
			if (newline < 0) return;
			const line = connection.buffer.slice(0, newline).replace(/\r$/, "");
			connection.buffer = connection.buffer.slice(newline + 1);
			if (!line) continue;
			this.#onLine(connection, line);
			if (connection.socket.destroyed) return;
		}
	}

	#onLine(connection: Connection, line: string): void {
		let frame: DaemonFrame;
		try {
			frame = decodeDaemonFrame(line);
		} catch (error) {
			this.#sendProtocolError(connection, requestIdOf(this.#parseRaw(line)), error);
			connection.socket.destroy();
			return;
		}
		if (!connection.authenticated) {
			if (frame.tag !== "hello") {
				this.#sendError(
					connection,
					requestIdOf(frame),
					"authentication_failed",
					"hello is required before requests",
				);
				connection.socket.destroy();
				return;
			}
			void this.#hello(connection, frame);
			return;
		}
		if (frame.tag !== "request") {
			this.#sendError(connection, requestIdOf(frame), "invalid_request", "request frame required");
			return;
		}
		if (connection.requestIds.has(frame.requestId)) {
			this.#sendError(connection, frame.requestId, "invalid_request", "duplicate requestId");
			return;
		}
		connection.requestIds.add(frame.requestId);
		const generation = connection.generation;
		void this.#dispatch(connection, frame, generation).finally(() => connection.requestIds.delete(frame.requestId));
	}

	async #hello(connection: Connection, hello: DaemonHello): Promise<void> {
		const profileMatches = hello.profile === this.profile;
		const tokenMatches = typeof this.#token === "string" && constantTimeTokenEquals(this.#token, hello.token);
		if (!profileMatches || !tokenMatches) {
			const reason = !profileMatches ? "profile mismatch" : "token mismatch";
			this.#sendError(
				connection,
				hello.requestId,
				"authentication_failed",
				`daemon authentication failed: ${reason}`,
			);
			connection.socket.destroy();
			return;
		}
		connection.authenticated = true;
		this.#send(connection, {
			v: DAEMON_PROTOCOL_MAJOR,
			tag: "hello_ok",
			requestId: hello.requestId,
			daemonId: this.#daemonId,
			serverVersion: this.#serverVersion,
			protocolVersion: DAEMON_PROTOCOL_MAJOR,
			shard: { profile: this.profile },
			capabilities: ["snapshot", "events", "server_status"],
			...(this.#buildStamp === undefined ? {} : { buildStamp: this.#buildStamp }),
		});
	}
	/**
	 * Route an operation to its serialization domain. ONE global chain used to
	 * order EVERY request, so one slow awaited task — a session_create doing
	 * network I/O during runtime init, a long-running session command — stalled
	 * ping/attach/commands for EVERY connected instance (observed live: all
	 * instances frozen behind the first session's first web request).
	 *
	 * - Session lifecycle ops serialize PER SESSION ID: check-then-install
	 *   windows in the registry span awaits, so same-id create/load/close must
	 *   not interleave — but different sessions never wait on each other.
	 * - An id-less create gets no key: its identity is decided by the runtime
	 *   it builds, and `#install` is the atomic final guard.
	 * - Everything else runs directly: commands are already serialized per
	 *   session record by the registry, and reads are synchronous snapshots.
	 */
	#serializationKey(operation: DaemonOperation): string | undefined {
		switch (operation.op) {
			case "session_create":
			case "session_load":
			case "session_resume":
			case "session_close":
			case "attach":
			case "detach":
				return "sessionId" in operation && typeof operation.sessionId === "string"
					? `session:${operation.sessionId}`
					: undefined;
			default:
				return undefined;
		}
	}

	/** Lifecycle ops mutate registry state across awaits; shutdown must drain them. */
	#isLifecycleOp(operation: DaemonOperation): boolean {
		switch (operation.op) {
			case "session_create":
			case "session_load":
			case "session_resume":
			case "session_close":
			case "attach":
			case "detach":
				return true;
			default:
				return false;
		}
	}

	async #dispatch(connection: Connection, request: DaemonRequest, generation: number): Promise<void> {
		if (!this.#connectionActive(connection, generation)) return;
		try {
			const run = (): Promise<unknown | typeof SKIP_DISPATCH> => {
				if (!this.#connectionActive(connection, generation)) return Promise.resolve(SKIP_DISPATCH);
				return this.#execute(connection, request.operation, generation);
			};
			const key = this.#serializationKey(request.operation);
			const pending = key === undefined ? run() : this.#serializeKeyed(key, run);
			if (this.#isLifecycleOp(request.operation)) {
				this.#inflightLifecycle.add(pending);
				void pending.catch(() => undefined).finally(() => this.#inflightLifecycle.delete(pending));
			}
			const result = await pending;
			if (result === SKIP_DISPATCH || !this.#connectionActive(connection, generation)) return;
			this.#send(connection, {
				v: DAEMON_PROTOCOL_MAJOR,
				tag: "response",
				requestId: request.requestId,
				ok: true,
				result,
			});
		} catch (error) {
			if (this.#connectionActive(connection, generation)) {
				this.#sendError(connection, request.requestId, errorCode(error), unknownErrorMessage(error));
			}
		}
	}

	async #execute(
		connection: Connection,
		operation: DaemonOperation,
		generation: number,
	): Promise<unknown | typeof SKIP_DISPATCH> {
		if (!this.#connectionActive(connection, generation)) return SKIP_DISPATCH;
		if (operation.op === "ping") return { ok: true, daemonId: this.#daemonId };
		if (operation.op === "server_status") return this.status();
		await this.#runtimeReady.promise;
		if (!this.#connectionActive(connection, generation)) return SKIP_DISPATCH;
		const registry = this.registry;
		switch (operation.op) {
			case "session_create":
				return registry.create(operation.sessionId, operation.cwd, operation.overrides);
			case "session_list":
				return registry.list();
			case "session_load":
				return registry.load(operation.sessionId);
			case "session_resume":
				return registry.resume(operation.sessionId);
			case "session_close":
				return registry.close(operation.sessionId);
			case "attach": {
				const key = `${operation.sessionId}\0${operation.attachmentId}`;
				const attached = await registry.attach(
					operation.sessionId,
					operation.attachmentId,
					operation.mode,
					frame => this.#sendAttachmentFrame(connection, operation.sessionId, operation.attachmentId, frame),
					operation.lastSeq,
					operation.delivery,
				);
				if (!this.#connectionActive(connection, generation)) {
					registry.disconnect(operation.sessionId, operation.attachmentId);
					return SKIP_DISPATCH;
				}
				connection.attachments.add(key);
				for (const frame of attached.frames)
					this.#sendAttachmentFrame(connection, operation.sessionId, operation.attachmentId, frame);
				return {
					sessionId: attached.sessionId,
					attachmentId: attached.attachmentId,
					mode: attached.mode,
					barrierSeq: attached.barrierSeq,
				};
			}
			case "detach": {
				this.#requireAttachmentOwnership(connection, operation.sessionId, operation.attachmentId);
				const detached = registry.detach(operation.sessionId, operation.attachmentId);
				connection.attachments.delete(`${operation.sessionId}\0${operation.attachmentId}`);
				return detached;
			}
			case "session_command":
				this.#requireAttachmentOwnership(connection, operation.sessionId, operation.attachmentId);
				return registry.command(operation.sessionId, operation.attachmentId, operation.command);
			case "snapshot_ack":
				this.#requireAttachmentOwnership(connection, operation.sessionId, operation.attachmentId);
				return registry.snapshotAck(operation.sessionId, operation.attachmentId, operation.seq);
			case "shutdown": {
				const blockers = this.#shutdownBlockers(connection);
				if (blockers.length > 0) return { shutdown: false, blockers };
				setTimeout(() => {
					void this.shutdown(true);
				}, 0);
				return { shutdown: true, blockers: [] };
			}
		}
	}

	#connectionActive(connection: Connection, generation: number): boolean {
		return (
			!connection.closed &&
			connection.generation === generation &&
			this.#connections.has(connection) &&
			!connection.socket.destroyed
		);
	}

	#requireAttachmentOwnership(connection: Connection, sessionId: string, attachmentId: string): void {
		if (!connection.attachments.has(`${sessionId}\0${attachmentId}`))
			throw new RegistryError("not_found", `attachment ${attachmentId} is not owned by this connection`);
	}

	async #serializeKeyed<T>(key: string, task: () => Promise<T>): Promise<T> {
		const previous = this.#lifecycleQueues.get(key) ?? Promise.resolve();
		const deferred = Promise.withResolvers<T>();
		const next = previous.then(async () => {
			try {
				deferred.resolve(await task());
			} catch (error) {
				deferred.reject(error);
			}
		});
		this.#lifecycleQueues.set(key, next);
		void next.finally(() => {
			if (this.#lifecycleQueues.get(key) === next) this.#lifecycleQueues.delete(key);
		});
		return deferred.promise;
	}

	#sendAttachmentFrame(connection: Connection, sessionId: string, attachmentId: string, frame: unknown): void {
		if (connection.socket.destroyed) return;
		const type = frameType(frame);
		if (!type) return;
		try {
			this.#sendAttachmentFrameInner(connection, sessionId, attachmentId, frame, type);
		} catch (error) {
			// A frame that cannot encode (oversized, unserializable) would throw
			// SYNCHRONOUSLY through the session's subscribe listener and wedge the
			// whole event pipeline. Registry-level bounding makes this unreachable
			// for session events; if anything else slips through, surface it as an
			// observable disconnect so the client reattaches and replays cleanly.
			logger.warn("Dropping unencodable attachment frame; recycling connection", {
				sessionId,
				attachmentId,
				frameType: type,
				error: String(error),
			});
			connection.socket.destroy();
		}
	}

	#sendAttachmentFrameInner(
		connection: Connection,
		sessionId: string,
		attachmentId: string,
		frame: unknown,
		type: string,
	): void {
		if (type === "event") {
			const seq = frameSeq(frame);
			if (
				seq === undefined ||
				typeof frame !== "object" ||
				frame === null ||
				Array.isArray(frame) ||
				!("event" in frame)
			)
				return;
			this.#send(connection, { v: DAEMON_PROTOCOL_MAJOR, tag: "event", sessionId, seq, event: frame.event });
			return;
		}
		if (typeof frame !== "object" || frame === null || Array.isArray(frame)) return;
		const barrierSeq = "barrierSeq" in frame && typeof frame.barrierSeq === "number" ? frame.barrierSeq : undefined;
		if (type !== "snapshot_restart" && barrierSeq === undefined) return;
		if (type === "snapshot_begin") {
			this.#send(connection, {
				v: DAEMON_PROTOCOL_MAJOR,
				tag: "snapshot_begin",
				barrierSeq: barrierSeq ?? 0,
				sessionId,
				attachmentId,
			});
		} else if (type === "snapshot_chunk" && "index" in frame && typeof frame.index === "number" && "chunk" in frame) {
			this.#send(connection, {
				v: DAEMON_PROTOCOL_MAJOR,
				tag: "snapshot_chunk",
				barrierSeq: barrierSeq ?? 0,
				sessionId,
				attachmentId,
				index: frame.index,
				chunk: frame.chunk,
			});
		} else if (type === "snapshot_end" && "nextSeq" in frame && typeof frame.nextSeq === "number") {
			this.#send(connection, {
				v: DAEMON_PROTOCOL_MAJOR,
				tag: "snapshot_end",
				barrierSeq: barrierSeq ?? 0,
				sessionId,
				attachmentId,
				nextSeq: frame.nextSeq,
			});
		} else if (
			type === "snapshot_restart" &&
			"reason" in frame &&
			(frame.reason === "overflow" || frame.reason === "gap") &&
			"previousBarrierSeq" in frame &&
			typeof frame.previousBarrierSeq === "number"
		) {
			this.#send(connection, {
				v: DAEMON_PROTOCOL_MAJOR,
				tag: "snapshot_restart",
				sessionId,
				attachmentId,
				previousBarrierSeq: frame.previousBarrierSeq,
				reason: frame.reason,
			});
		}
	}

	#send(connection: Connection, frame: DaemonFrame): void {
		if (connection.socket.destroyed) return;
		const eventType =
			frame.tag === "event" && typeof frame.event === "object" && frame.event !== null && "type" in frame.event
				? String(frame.event.type).slice(0, 128)
				: undefined;
		pushLoopPhase(eventType ? `daemon:send:event:${eventType}` : `daemon:send:${frame.tag}`);
		try {
			connection.socket.write(encodeDaemonFrame(frame));
		} finally {
			popLoopPhase();
		}
	}

	#sendError(connection: Connection, requestId: string | undefined, code: DaemonErrorCode, message: string): void {
		if (!requestId) return;
		this.#send(connection, {
			v: DAEMON_PROTOCOL_MAJOR,
			tag: "response",
			requestId,
			ok: false,
			error: { code, message },
		});
	}

	#sendProtocolError(connection: Connection, requestId: string | undefined, error: unknown): void {
		this.#sendError(connection, requestId, errorCode(error), unknownErrorMessage(error));
	}

	#parseRaw(line: string): unknown {
		try {
			return JSON.parse(line) as unknown;
		} catch {
			return undefined;
		}
	}
}

export type StartDaemonServerOptions = Omit<DaemonServerOptions, "profile"> & {
	profile?: DaemonProfile;
};

/** Hidden-worker entrypoint used by cli.ts. */
export async function startDaemonServerFromEnvironment(
	options: StartDaemonServerOptions = {},
): Promise<DaemonServer | undefined> {
	const profile = options.profile === undefined ? (getActiveProfile() ?? null) : options.profile;
	const runtimeDir = options.runtimeDir ?? process.env.OMP_DAEMON_RUNTIME_DIR;
	const server = new DaemonServer({ ...options, profile, runtimeDir });
	try {
		await server.run();
		return server;
	} catch (error) {
		// Concurrent CLI launches may both decide that the daemon needs to be
		// spawned. The owner lease elects one winner; the losing hidden worker
		// has completed successfully and must not leak an expected stack trace.
		if (error instanceof DaemonEndpointOwnedError) return undefined;
		throw error;
	}
}

/** Start one shard server when the caller owns the process lifecycle. */
export async function ensureDaemonServer(options: DaemonServerOptions): Promise<DaemonServer> {
	const server = new DaemonServer(options);
	await server.run();
	return server;
}
