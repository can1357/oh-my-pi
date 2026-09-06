import * as fs from "node:fs/promises";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { getGlobalDaemonRuntimeDir, isEexist, isEnoent, logger, postmortem } from "@oh-my-pi/pi-utils";
import { hostHasInheritableConsole } from "../eval/py/spawn-options";
import { resolveWorkerSpawnCmd, workerEnvFromParent } from "../subprocess/worker-client";
import { canonicalProjectDir, daemonBrokerEndpoint, daemonRuntimeDir } from "./paths";
import {
	DAEMON_BROKER_WORKER_ARG,
	DAEMON_CAPABILITY_LIVE_SESSIONS,
	DAEMON_IDLE_GRACE_ENV,
	DAEMON_PROJECT_DIR_ENV,
	DAEMON_RUNTIME_DIR_ENV,
	type DaemonCompletionNotification,
	type DaemonOperation,
	type DaemonRpcResult,
	type DaemonWireMessage,
	LIVE_SESSION_PROTOCOL_VERSION,
	type LiveSessionMessageNotification,
	type LiveSessionRegistration,
	parseDaemonRpcResult,
	parseDaemonWireMessage,
} from "./protocol";
import { resolveDaemonSpawnOptions } from "./spawn-options";

const CONNECT_TIMEOUT_MS = 10_000;
const CONNECT_RETRY_MS = 50;
const TOKEN_FILE = "broker.token";
const BROKER_SPAWN_OPTIONS = resolveDaemonSpawnOptions({
	platform: process.platform,
	hostHasInheritableConsole: hostHasInheritableConsole(),
});

interface PendingRequest {
	operation: DaemonOperation;
	resolve: (result: DaemonRpcResult) => void;
	reject: (error: Error) => void;
	timer: NodeJS.Timeout;
	removeAbort?: () => void;
}

/** Broker location and lifecycle overrides used by smoke tests and isolated consumers. */
export interface DaemonBrokerClientOptions {
	/** Runtime directory override; defaults to the project-scoped config path. */
	runtimeDir?: string;
	/** Last-client shutdown grace override in milliseconds. */
	idleGraceMs?: number;
}

export interface DaemonCompletionUnregisterOptions {
	/** Detach this process without deleting broker-persisted pending notifications. */
	preservePending?: boolean;
}

/** Persistent per-process connection to one project or global daemon broker. */
export interface DaemonBrokerClient {
	onCompletion(
		owner: string,
		sink: (notification: DaemonCompletionNotification) => Promise<void> | void,
	): (options?: DaemonCompletionUnregisterOptions) => void;
	/** Canonical project directory or synthetic directory identifying a global scope. */
	readonly projectDir: string;
	request(operation: DaemonOperation, signal?: AbortSignal): Promise<DaemonRpcResult>;
	close(): void;
}

export interface LiveSessionHost {
	update(registration: LiveSessionRegistration): Promise<void>;
	close(): Promise<void>;
}

export type LiveSessionMessageSink = (message: string) => Promise<void> | void;

/** A request reached the broker and the broker rejected the operation. */
export class DaemonBrokerRejectedError extends Error {}

async function readOrCreateToken(runtimeDir: string): Promise<string> {
	await fs.mkdir(runtimeDir, { recursive: true, mode: 0o700 });
	const tokenPath = path.join(runtimeDir, TOKEN_FILE);
	const tokenFile = Bun.file(tokenPath);
	for (let attempt = 0; attempt < 100; attempt++) {
		try {
			const token = (await tokenFile.text()).trim();
			if (token.length > 0) return token;
		} catch (error) {
			if (!isEnoent(error)) throw error;
		}

		try {
			const handle = await fs.open(tokenPath, "wx", 0o600);
			try {
				const token = crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
				await handle.writeFile(token, "utf8");
				return token;
			} finally {
				await handle.close();
			}
		} catch (error) {
			if (!isEexist(error)) throw error;
		}
		await Bun.sleep(10);
	}
	throw new Error(`Timed out initializing daemon broker token in ${runtimeDir}`);
}

function requestTimeoutMs(operation: DaemonOperation): number {
	switch (operation.op) {
		case "start":
			return (operation.spec.ready?.timeoutMs ?? CONNECT_TIMEOUT_MS) + 5_000;
		case "wait":
		case "logs":
		case "stop":
			return operation.timeoutMs + 5_000;
		default:
			return 30_000;
	}
}

function openSocket(endpoint: string, timeoutMs: number): Promise<net.Socket> {
	const { promise, resolve, reject } = Promise.withResolvers<net.Socket>();
	const socket = net.createConnection({ path: endpoint });
	const timer = setTimeout(() => {
		socket.destroy();
		reject(new Error(`Timed out connecting to daemon broker at ${endpoint}`));
	}, timeoutMs);
	const cleanup = (): void => {
		clearTimeout(timer);
		socket.off("connect", onConnect);
		socket.off("error", onError);
	};
	const onConnect = (): void => {
		cleanup();
		resolve(socket);
	};
	const onError = (error: Error): void => {
		cleanup();
		socket.destroy();
		reject(error);
	};
	socket.once("connect", onConnect);
	socket.once("error", onError);
	return promise;
}

class SocketDaemonClient implements DaemonBrokerClient {
	readonly projectDir: string;
	readonly #runtimeDir: string;
	readonly #endpoint: string;
	readonly #token: string;
	readonly #seenCompletionIds = new Set<string>();
	readonly #idleGraceMs: number | undefined;
	readonly #pending = new Map<string, PendingRequest>();
	readonly #completionSinks = new Map<string, (notification: DaemonCompletionNotification) => Promise<void> | void>();
	readonly #completionUnsubscribes = new Set<string>();
	readonly #preservedCompletionOwners = new Set<string>();
	readonly #completionReplays = new Set<string>();
	readonly #inFlightCompletionIds = new Set<string>();
	readonly #completionSubscriptionId = crypto.randomUUID();
	#socket: net.Socket | undefined;
	#connectPromise: Promise<void> | undefined;
	#buffer = "";
	#closed = false;
	#eventReconnectTimer: NodeJS.Timeout | undefined;
	#liveSession:
		| {
				registration: LiveSessionRegistration;
				sink: (message: LiveSessionMessageNotification) => Promise<void> | void;
		  }
		| undefined;

	constructor(projectDir: string, runtimeDir: string, token: string, options: DaemonBrokerClientOptions) {
		this.projectDir = projectDir;
		this.#runtimeDir = runtimeDir;
		this.#endpoint = daemonBrokerEndpoint(projectDir, runtimeDir);
		this.#token = token;
		this.#idleGraceMs = options.idleGraceMs;
	}

	async request(operation: DaemonOperation, signal?: AbortSignal): Promise<DaemonRpcResult> {
		if (this.#closed) throw new Error("Daemon broker client is closed");
		if (signal?.aborted) throw new Error("Daemon broker request aborted");
		await this.#connect();
		const socket = this.#socket;
		if (!socket || socket.destroyed) throw new Error("Daemon broker socket is unavailable");

		const completionUnsubscribes = [...this.#completionUnsubscribes];
		const completionReplays = [...this.#completionReplays];
		const id = crypto.randomUUID();
		const { promise, resolve, reject } = Promise.withResolvers<DaemonRpcResult>();
		const timer = setTimeout(() => {
			const pending = this.#pending.get(id);
			if (!pending) return;
			this.#pending.delete(id);
			pending.removeAbort?.();
			reject(new Error(`Daemon ${operation.op} request timed out`));
		}, requestTimeoutMs(operation));
		const pending: PendingRequest = { operation, resolve, reject, timer };
		if (signal) {
			const abort = (): void => {
				if (!this.#pending.delete(id)) return;
				clearTimeout(timer);
				reject(new Error("Daemon broker request aborted"));
			};
			signal.addEventListener("abort", abort, { once: true });
			pending.removeAbort = () => signal.removeEventListener("abort", abort);
		}
		this.#pending.set(id, pending);
		socket.write(
			`${JSON.stringify({
				id,
				token: this.#token,
				owners: [...this.#completionSinks.keys()],
				detachedOwners: [...this.#preservedCompletionOwners],
				completionEvents: true,
				completionUnsubscribes,
				completionReplays,
				completionSubscriptionId: this.#completionSubscriptionId,
				liveSessionEvents: true,
				liveSession: this.#liveSession?.registration,
				operation,
			})}\n`,
		);
		const result = await promise;
		for (const owner of completionUnsubscribes) {
			if (!this.#completionSinks.has(owner)) this.#completionUnsubscribes.delete(owner);
		}
		for (const owner of completionReplays) {
			if (this.#completionSinks.has(owner)) this.#completionReplays.delete(owner);
		}
		return result;
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		clearTimeout(this.#eventReconnectTimer);
		this.#eventReconnectTimer = undefined;
		this.#socket?.destroy();
		this.#completionSinks.clear();
		this.#preservedCompletionOwners.clear();
		this.#completionReplays.clear();
		this.#liveSession = undefined;
		this.#socket = undefined;
		this.#rejectPending(new Error("Daemon broker client closed"));
	}

	onCompletion(
		owner: string,
		sink: (notification: DaemonCompletionNotification) => Promise<void> | void,
	): (options?: DaemonCompletionUnregisterOptions) => void {
		this.#completionUnsubscribes.delete(owner);
		if (this.#preservedCompletionOwners.delete(owner)) this.#completionReplays.add(owner);
		this.#completionSinks.set(owner, sink);
		this.#publishRegistrations();
		return options => {
			if (this.#completionSinks.get(owner) !== sink) return;
			this.#completionSinks.delete(owner);
			if (options?.preservePending) {
				this.#preservedCompletionOwners.add(owner);
			} else {
				this.#preservedCompletionOwners.delete(owner);
				this.#completionUnsubscribes.add(owner);
			}
			if (this.#completionSinks.size === 0 && !this.#liveSession && this.#eventReconnectTimer) {
				clearTimeout(this.#eventReconnectTimer);
				this.#eventReconnectTimer = undefined;
			}
			this.#publishRegistrations();
		};
	}

	async hostLiveSession(
		registration: LiveSessionRegistration,
		sink: (message: LiveSessionMessageNotification) => Promise<void> | void,
	): Promise<void> {
		if (this.#closed) throw new Error("Daemon broker client is closed");
		this.#liveSession = { registration, sink };
		const ping = await this.request({ op: "ping" });
		if (ping.op !== "ping" || !ping.capabilities?.includes(DAEMON_CAPABILITY_LIVE_SESSIONS)) {
			this.#liveSession = undefined;
			throw new Error("The running daemon broker must restart before live session attachment is available");
		}
	}

	async clearLiveSession(): Promise<void> {
		if (!this.#liveSession) return;
		this.#liveSession = undefined;
		await this.request({ op: "ping" });
	}

	#publishRegistrations(): void {
		if (this.#closed) return;
		void this.request({ op: "ping" }).catch(() => this.#scheduleEventReconnect());
	}

	#scheduleEventReconnect(): void {
		if (
			this.#closed ||
			(this.#completionSinks.size === 0 && !this.#liveSession) ||
			this.#eventReconnectTimer !== undefined ||
			(this.#socket !== undefined && !this.#socket.destroyed)
		) {
			return;
		}
		this.#eventReconnectTimer = setTimeout(() => {
			this.#eventReconnectTimer = undefined;
			this.#publishRegistrations();
		}, CONNECT_RETRY_MS);
		this.#eventReconnectTimer.unref();
	}

	async #connect(): Promise<void> {
		if (this.#socket && !this.#socket.destroyed) return;
		if (this.#connectPromise) return this.#connectPromise;
		this.#connectPromise = this.#connectOnce();
		try {
			await this.#connectPromise;
		} finally {
			this.#connectPromise = undefined;
		}
	}

	async #connectOnce(): Promise<void> {
		try {
			this.#bindSocket(await openSocket(this.#endpoint, 250));
			return;
		} catch {
			// No live broker. Multiple clients may race to spawn; the broker's PID
			// lease selects one winner before any candidate touches the socket.
		}
		this.#spawnBroker();
		const deadline = Date.now() + CONNECT_TIMEOUT_MS;
		let lastError: Error | undefined;
		while (Date.now() < deadline) {
			try {
				this.#bindSocket(await openSocket(this.#endpoint, 250));
				return;
			} catch (error) {
				lastError = error instanceof Error ? error : new Error(String(error));
				await Bun.sleep(CONNECT_RETRY_MS);
			}
		}
		throw new Error(`Failed to start daemon broker: ${lastError?.message ?? "socket unavailable"}`);
	}

	#spawnBroker(): void {
		const spawn = resolveWorkerSpawnCmd(DAEMON_BROKER_WORKER_ARG);
		const overlay: Record<string, string> = {
			[DAEMON_PROJECT_DIR_ENV]: this.projectDir,
			[DAEMON_RUNTIME_DIR_ENV]: this.#runtimeDir,
		};
		if (this.#idleGraceMs !== undefined) overlay[DAEMON_IDLE_GRACE_ENV] = String(this.#idleGraceMs);
		const child = Bun.spawn(spawn.cmd, {
			cwd: spawn.cwd,
			env: workerEnvFromParent(overlay),
			stdin: "ignore",
			stdout: "ignore",
			stderr: "ignore",
			...BROKER_SPAWN_OPTIONS,
		});
		child.unref();
	}

	#bindSocket(socket: net.Socket): void {
		this.#socket = socket;
		this.#buffer = "";
		socket.setEncoding("utf8");
		socket.on("data", chunk => this.#onData(chunk));
		socket.on("error", () => {
			// The close handler rejects pending requests with one stable error.
		});
		socket.on("close", () => {
			if (this.#socket === socket) this.#socket = undefined;
			this.#rejectPending(new Error("Daemon broker connection closed"));
			this.#scheduleEventReconnect();
		});
	}

	#onData(chunk: string | Buffer): void {
		this.#buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
		for (;;) {
			const newline = this.#buffer.indexOf("\n");
			if (newline < 0) return;
			const line = this.#buffer.slice(0, newline);
			this.#buffer = this.#buffer.slice(newline + 1);
			if (line.length === 0) continue;
			let decoded: unknown;
			try {
				decoded = JSON.parse(line);
			} catch (error) {
				this.#rejectPending(error instanceof Error ? error : new Error(String(error)));
				continue;
			}
			let message: DaemonWireMessage;
			try {
				message = parseDaemonWireMessage(decoded);
			} catch (error) {
				const parseError = error instanceof Error ? error : new Error(String(error));
				if (typeof decoded === "object" && decoded !== null && "event" in decoded) {
					logger.warn("Ignoring malformed daemon broker event", { error: parseError.message });
					continue;
				}
				this.#rejectPending(parseError);
				continue;
			}
			if ("event" in message) {
				if (message.event === "daemon-completed") void this.#deliverCompletion(message);
				else void this.#deliverLiveSessionMessage(message);
				continue;
			}
			const response = message;
			const pending = this.#pending.get(response.id);
			if (!pending) continue;
			this.#pending.delete(response.id);
			clearTimeout(pending.timer);
			pending.removeAbort?.();
			if (!response.ok) {
				pending.reject(new DaemonBrokerRejectedError(response.error));
				continue;
			}
			try {
				pending.resolve(parseDaemonRpcResult(pending.operation, response.result));
			} catch (error) {
				pending.reject(error instanceof Error ? error : new Error(String(error)));
			}
		}
	}

	async #deliverCompletion(message: DaemonCompletionNotification): Promise<void> {
		if (this.#seenCompletionIds.has(message.completionId)) {
			this.#ackCompletion(message.completionId);
			return;
		}
		if (this.#inFlightCompletionIds.has(message.completionId)) return;
		const sink = this.#completionSinks.get(message.owner);
		if (!sink) return;
		this.#inFlightCompletionIds.add(message.completionId);
		try {
			await sink(message);
			if (this.#seenCompletionIds.size >= 512) {
				const oldest = this.#seenCompletionIds.values().next().value;
				if (oldest !== undefined) this.#seenCompletionIds.delete(oldest);
			}
			this.#seenCompletionIds.add(message.completionId);
			this.#ackCompletion(message.completionId);
		} catch (error) {
			logger.warn("Daemon completion sink failed", {
				owner: message.owner,
				completionId: message.completionId,
				error: error instanceof Error ? error.message : String(error),
			});
			this.#socket?.destroy();
		} finally {
			this.#inFlightCompletionIds.delete(message.completionId);
		}
	}

	async #deliverLiveSessionMessage(message: LiveSessionMessageNotification): Promise<void> {
		const hosted = this.#liveSession;
		if (
			!hosted ||
			hosted.registration.endpointId !== message.endpointId ||
			hosted.registration.sessionId !== message.sessionId
		) {
			this.#ackLiveSessionMessage(message.deliveryId, "Live session registration changed before delivery");
			return;
		}
		try {
			await hosted.sink(message);
			this.#ackLiveSessionMessage(message.deliveryId);
		} catch (error) {
			const detail = error instanceof Error ? error.message : String(error);
			logger.warn("Live session message sink failed", {
				endpointId: message.endpointId,
				deliveryId: message.deliveryId,
				error: detail,
			});
			this.#ackLiveSessionMessage(message.deliveryId, detail);
		}
	}

	#ackLiveSessionMessage(deliveryId: string, error?: string): void {
		const socket = this.#socket;
		if (!socket || socket.destroyed) return;
		socket.write(
			`${JSON.stringify({
				id: crypto.randomUUID(),
				token: this.#token,
				owners: [...this.#completionSinks.keys()],
				detachedOwners: [...this.#preservedCompletionOwners],
				completionEvents: true,
				completionUnsubscribes: [...this.#completionUnsubscribes],
				completionSubscriptionId: this.#completionSubscriptionId,
				liveSessionEvents: true,
				liveSession: this.#liveSession?.registration,
				liveSessionMessageAcks: [{ deliveryId, error }],
				operation: { op: "ping" },
			})}\n`,
		);
	}

	#ackCompletion(completionId: string): void {
		const socket = this.#socket;
		if (!socket || socket.destroyed) return;
		socket.write(
			`${JSON.stringify({
				id: crypto.randomUUID(),
				token: this.#token,
				owners: [...this.#completionSinks.keys()],
				detachedOwners: [...this.#preservedCompletionOwners],
				completionEvents: true,
				completionAcks: [completionId],
				completionUnsubscribes: [...this.#completionUnsubscribes],
				completionSubscriptionId: this.#completionSubscriptionId,
				liveSessionEvents: true,
				liveSession: this.#liveSession?.registration,
				operation: { op: "ping" },
			})}\n`,
		);
	}

	#rejectPending(error: Error): void {
		for (const pending of this.#pending.values()) {
			clearTimeout(pending.timer);
			pending.removeAbort?.();
			pending.reject(error);
		}
		this.#pending.clear();
	}
}

const sharedClients = new Map<string, Promise<DaemonBrokerClient>>();
let cancelExitCleanup: (() => void) | undefined;

function sharedDaemonClient(key: string, create: () => Promise<DaemonBrokerClient>): Promise<DaemonBrokerClient> {
	let pending = sharedClients.get(key);
	if (!pending) {
		pending = create();
		sharedClients.set(key, pending);
		if (!cancelExitCleanup) {
			cancelExitCleanup = postmortem.register("daemon-broker-clients", () => closeDaemonClients());
		}
	}
	return pending;
}

async function createSocketDaemonClient(
	projectDir: string,
	options: DaemonBrokerClientOptions,
): Promise<SocketDaemonClient> {
	const canonical = await canonicalProjectDir(projectDir);
	const runtimeDir = options.runtimeDir ?? daemonRuntimeDir(canonical);
	const token = await readOrCreateToken(runtimeDir);
	return new SocketDaemonClient(canonical, runtimeDir, token, options);
}

/** Create an independent socket connection to one daemon broker scope. */
export function createDaemonBrokerClient(
	projectDir: string,
	options: DaemonBrokerClientOptions = {},
): Promise<DaemonBrokerClient> {
	return createSocketDaemonClient(projectDir, options);
}

/** Host one interactive session on an independent broker connection. */
export async function createLiveSessionHost(
	projectDir: string,
	registration: LiveSessionRegistration,
	sink: LiveSessionMessageSink,
	options: DaemonBrokerClientOptions = {},
): Promise<LiveSessionHost> {
	const client = await createSocketDaemonClient(projectDir, options);
	let closed = false;
	try {
		await client.hostLiveSession(registration, notification => sink(notification.message));
	} catch (error) {
		client.close();
		throw error;
	}
	return {
		async update(nextRegistration: LiveSessionRegistration): Promise<void> {
			if (closed) throw new Error("Live session host is closed");
			await client.hostLiveSession(nextRegistration, notification => sink(notification.message));
		},
		async close(): Promise<void> {
			if (closed) return;
			closed = true;
			try {
				await client.clearLiveSession();
			} finally {
				client.close();
			}
		},
	};
}

/** Get the process-shared daemon broker client for one canonical project directory. */
export async function daemonClientForProject(projectDir: string): Promise<DaemonBrokerClient> {
	const canonical = await canonicalProjectDir(projectDir);
	return sharedDaemonClient(`project:${canonical}`, () => createDaemonBrokerClient(canonical));
}

/** Get the process-shared client that leases one profile-independent, machine-global daemon broker. */
export async function daemonClientForGlobal(service: string): Promise<DaemonBrokerClient> {
	const runtimeDir = getGlobalDaemonRuntimeDir(service);
	// Canonicalize only after creation so the first caller and later callers
	// derive the same Windows pipe key even when an ancestor is a symlink.
	await fs.mkdir(runtimeDir, { recursive: true, mode: 0o700 });
	const canonical = await fs.realpath(runtimeDir);
	return sharedDaemonClient(`global:${canonical}`, () =>
		createDaemonBrokerClient(canonical, {
			runtimeDir: canonical,
		}),
	);
}

/** Close every project and machine-global broker connection held by this omp process. */
export async function closeDaemonClients(): Promise<void> {
	const pending = [...sharedClients.values()];
	sharedClients.clear();
	for (const client of await Promise.all(pending)) client.close();
	cancelExitCleanup?.();
	cancelExitCleanup = undefined;
}

/** Exercise worker-host broker startup and authenticated RPC for distribution smoke tests. */
export async function smokeTestDaemonBroker(): Promise<void> {
	const smokeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-daemon-smoke-"));
	const projectDir = path.join(smokeRoot, "project");
	const runtimeDir = path.join(smokeRoot, "run");
	await fs.mkdir(projectDir, { recursive: true });
	const options = { runtimeDir, idleGraceMs: 5_000 };
	const client = await createDaemonBrokerClient(projectDir, options);
	let host: LiveSessionHost | undefined;
	let deliveredMessage: string | undefined;
	try {
		const ping = await client.request({ op: "ping" });
		if (
			ping.op !== "ping" ||
			ping.projectDir !== client.projectDir ||
			!ping.capabilities?.includes(DAEMON_CAPABILITY_LIVE_SESSIONS)
		) {
			throw new Error("daemon broker ping mismatch");
		}
		host = await createLiveSessionHost(
			projectDir,
			{
				version: LIVE_SESSION_PROTOCOL_VERSION,
				endpointId: "smoke-endpoint",
				sessionId: "smoke-session",
				title: "Broker smoke",
				startedAt: new Date().toISOString(),
			},
			message => {
				deliveredMessage = message;
			},
			options,
		);
		const listed = await client.request({ op: "session-list" });
		if (listed.op !== "session-list" || listed.sessions[0]?.sessionId !== "smoke-session") {
			throw new Error("live session registration was not listed");
		}
		const sent = await client.request({
			op: "session-send",
			endpointId: "smoke-endpoint",
			sessionId: "smoke-session",
			message: "smoke message",
		});
		if (sent.op !== "session-send" || deliveredMessage !== "smoke message") {
			throw new Error("live session message was not delivered");
		}
		await host.close();
		host = undefined;
		const afterClose = await client.request({ op: "session-list" });
		if (afterClose.op !== "session-list" || afterClose.sessions.length !== 0) {
			throw new Error("closed live session remained registered");
		}
		await client.request({ op: "shutdown" });
	} finally {
		await host?.close().catch(() => undefined);
		client.close();
		await fs.rm(smokeRoot, { recursive: true, force: true });
	}
}
