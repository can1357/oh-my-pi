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
	DAEMON_IDLE_GRACE_ENV,
	DAEMON_OUTPUT_MONITOR_CAPABILITY,
	DAEMON_PROJECT_DIR_ENV,
	DAEMON_RUNTIME_DIR_ENV,
	type DaemonCompletionNotification,
	type DaemonMonitorNotification,
	type DaemonMonitorWireNotification,
	type DaemonOperation,
	type DaemonOutputSubscription,
	type DaemonOutputWireSubscription,
	type DaemonRpcResult,
	type DaemonWireMessage,
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

function publicMonitorNotification(message: DaemonMonitorWireNotification): DaemonMonitorNotification {
	if (message.event === "daemon-output") {
		const { registrationId, ...notification } = message;
		void registrationId;
		return notification;
	}
	const { registrationId, ...notification } = message;
	void registrationId;
	return notification;
}

interface OutputSinkRegistration {
	subscription: DaemonOutputSubscription;
	registrationId: string;
	sink: (notification: DaemonMonitorNotification) => Promise<void> | void;
	/** Daemon incarnation bound by the first matching notification. */
	daemonId?: string;
	/** Resolves once broker acknowledgement or terminal delivery confirms this subscription. */
	resolveReady: () => void;
	rejectReady: (error: Error) => void;
	/** Connection generation whose rejected callback suppresses already-queued deliveries. */
	failedDeliveryGeneration?: number;
	/** A callback rejection permanently suppresses terminal delivery to this sink. */
	completionBlocked?: boolean;
	/** Broker registration epoch of the last output batch delivered to the sink. */
	lastEpoch?: string;
	/** Highest seq delivered for {@link lastEpoch}; advertised as a cumulative replay ack. */
	lastSeq?: number;
	/** Artifact size behind the last delivered batch; a fresh broker registration appends past it. */
	lastArtifactBytes?: number;
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

/** Synchronous output detachment plus acknowledgement of broker publication. */
export interface DaemonOutputUnregister {
	(): void;
	readonly ready: Promise<void>;
}

/** Persistent per-process connection to one project or global daemon broker. */
export interface DaemonBrokerClient {
	onCompletion(
		owner: string,
		sink: (notification: DaemonCompletionNotification) => Promise<void> | void,
	): (options?: DaemonCompletionUnregisterOptions) => void;
	/**
	 * Register a live output sink. {@link DaemonOutputUnregister.ready} settles
	 * after the broker acknowledges both the subscription and output-monitor
	 * capability negotiation, or when terminal delivery proves publication first.
	 */
	onOutput?(
		subscription: DaemonOutputSubscription,
		sink: (notification: DaemonMonitorNotification) => Promise<void> | void,
	): DaemonOutputUnregister;
	/** Canonical project directory or synthetic directory identifying a global scope. */
	readonly projectDir: string;
	request(operation: DaemonOperation, signal?: AbortSignal): Promise<DaemonRpcResult>;
	close(): void;
}

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

function outputMonitoringUnsupportedError(): Error {
	return new Error("The running daemon broker does not support output monitoring; restart it with this omp build");
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
	readonly #outputSinks = new Map<string, OutputSinkRegistration>();
	readonly #notificationDeliveryTails = new Map<string, Map<string, Promise<void>>>();
	readonly #completionUnsubscribes = new Set<string>();
	readonly #preservedCompletionOwners = new Set<string>();
	readonly #completionReplays = new Set<string>();
	readonly #inFlightCompletionIds = new Set<string>();
	readonly #completionSubscriptionId = crypto.randomUUID();
	readonly #outputSubscriptionId = crypto.randomUUID();
	#socket: net.Socket | undefined;
	#connectPromise: Promise<void> | undefined;
	#buffer = "";
	#closed = false;
	#completionReconnectTimer: NodeJS.Timeout | undefined;
	#brokerCapabilities: string[] | undefined;
	#socketGeneration = 0;

	constructor(projectDir: string, runtimeDir: string, token: string, options: DaemonBrokerClientOptions) {
		this.projectDir = projectDir;
		this.#runtimeDir = runtimeDir;
		this.#endpoint = daemonBrokerEndpoint(projectDir, runtimeDir);
		this.#token = token;
		this.#idleGraceMs = options.idleGraceMs;
	}

	request(operation: DaemonOperation, signal?: AbortSignal): Promise<DaemonRpcResult> {
		return this.#request(operation, signal, false);
	}

	async #request(
		operation: DaemonOperation,
		signal: AbortSignal | undefined,
		publishOutputSubscriptions: boolean,
	): Promise<DaemonRpcResult> {
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
				...(publishOutputSubscriptions
					? {
							outputSubscriptions: this.#outputSubscriptionPayloads(),
							outputSubscriptionId: this.#outputSubscriptionId,
						}
					: {}),
				operation,
			})}\n`,
		);
		const result = await promise;
		if (result.op === "ping") this.#brokerCapabilities = result.capabilities ?? [];
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
		clearTimeout(this.#completionReconnectTimer);
		this.#completionReconnectTimer = undefined;
		this.#socket?.destroy();
		for (const registration of this.#outputSinks.values()) {
			registration.rejectReady(new Error("Daemon broker client closed before output registration was acknowledged"));
		}
		this.#completionSinks.clear();
		this.#outputSinks.clear();
		this.#notificationDeliveryTails.clear();
		this.#preservedCompletionOwners.clear();
		this.#completionReplays.clear();
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
		this.#publishCompletionOwners();
		return options => {
			if (this.#completionSinks.get(owner) !== sink) return;
			this.#completionSinks.delete(owner);
			if (options?.preservePending) {
				this.#preservedCompletionOwners.add(owner);
			} else {
				this.#preservedCompletionOwners.delete(owner);
				this.#completionUnsubscribes.add(owner);
			}
			if (this.#completionSinks.size === 0 && this.#outputSinks.size === 0 && this.#completionReconnectTimer) {
				clearTimeout(this.#completionReconnectTimer);
				this.#completionReconnectTimer = undefined;
			}
			this.#publishCompletionOwners();
		};
	}

	onOutput(
		subscription: DaemonOutputSubscription,
		sink: (notification: DaemonMonitorNotification) => Promise<void> | void,
	): DaemonOutputUnregister {
		if (this.#closed) throw new Error("Daemon broker client is closed");
		const { promise: ready, resolve, reject } = Promise.withResolvers<void>();
		let readySettled = false;
		// Callers may only need synchronous detachment. Mark the rejection
		// observed without changing what consumers awaiting `ready` receive.
		void ready.catch(() => undefined);
		const registration: OutputSinkRegistration = {
			subscription,
			registrationId: crypto.randomUUID(),
			sink,
			resolveReady: () => {
				if (readySettled) return;
				readySettled = true;
				resolve();
			},
			rejectReady: error => {
				if (readySettled) return;
				readySettled = true;
				reject(error);
			},
		};
		const previous = this.#outputSinks.get(subscription.id);
		if (previous) {
			this.#outputSinks.delete(subscription.id);
			previous.rejectReady(new Error("Daemon output registration was replaced before it was acknowledged"));
		}

		if (
			this.#brokerCapabilities !== undefined &&
			!this.#brokerCapabilities.includes(DAEMON_OUTPUT_MONITOR_CAPABILITY)
		) {
			registration.rejectReady(outputMonitoringUnsupportedError());
		} else {
			this.#outputSinks.set(subscription.id, registration);
			this.#publishSubscriptions();
		}

		const unregister = (): void => {
			const current = this.#outputSinks.get(subscription.id);
			if (current !== registration) return;
			this.#outputSinks.delete(subscription.id);
			registration.rejectReady(new Error("Daemon output registration was removed before it was acknowledged"));
			if (this.#completionSinks.size === 0 && this.#outputSinks.size === 0 && this.#completionReconnectTimer) {
				clearTimeout(this.#completionReconnectTimer);
				this.#completionReconnectTimer = undefined;
			}
			this.#publishSubscriptions();
		};
		return Object.defineProperty(unregister, "ready", { value: ready }) as DaemonOutputUnregister;
	}

	/**
	 * Advertised subscriptions carry the cumulative delivery ack so a
	 * reconnecting envelope replays only retained batches the sink never saw,
	 * plus the artifact size that ack covers so a re-created registration
	 * continues the capture instead of truncating it.
	 */
	#outputSubscriptionPayloads(): DaemonOutputWireSubscription[] {
		return [...this.#outputSinks.values()].map(entry => ({
			...entry.subscription,
			registrationId: entry.registrationId,
			...(entry.lastEpoch === undefined ? {} : { lastEpoch: entry.lastEpoch, lastSeq: entry.lastSeq ?? 0 }),
			...(entry.lastArtifactBytes === undefined ? {} : { artifactBytes: entry.lastArtifactBytes }),
		}));
	}

	#publishCompletionOwners(): void {
		if (this.#closed) return;
		this.#publishSubscriptions();
	}

	#publishSubscriptions(): void {
		if (this.#closed) return;
		const registrations = [...this.#outputSinks.entries()];
		void this.#request({ op: "ping" }, undefined, true)
			.then(result => {
				if (result.op !== "ping" || !result.capabilities?.includes(DAEMON_OUTPUT_MONITOR_CAPABILITY)) {
					const error = outputMonitoringUnsupportedError();
					for (const [id, registration] of this.#outputSinks) {
						this.#outputSinks.delete(id);
						registration.rejectReady(error);
					}
					return;
				}
				for (const [id, registration] of registrations) {
					if (this.#outputSinks.get(id) === registration) registration.resolveReady();
				}
			})
			.catch(error => {
				if (this.#closed) return;
				if (!this.#socket || this.#socket.destroyed) {
					this.#scheduleCompletionReconnect();
					return;
				}
				const publicationError = error instanceof Error ? error : new Error(String(error));
				for (const [id, registration] of registrations) {
					if (this.#outputSinks.get(id) !== registration) continue;
					this.#outputSinks.delete(id);
					registration.rejectReady(publicationError);
				}
			});
	}

	#scheduleCompletionReconnect(): void {
		if (
			this.#closed ||
			(this.#completionSinks.size === 0 && this.#outputSinks.size === 0) ||
			this.#completionReconnectTimer !== undefined ||
			(this.#socket !== undefined && !this.#socket.destroyed)
		) {
			return;
		}
		this.#completionReconnectTimer = setTimeout(() => {
			this.#completionReconnectTimer = undefined;
			this.#publishCompletionOwners();
		}, CONNECT_RETRY_MS);
		this.#completionReconnectTimer.unref();
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
		const generation = ++this.#socketGeneration;
		this.#socket = socket;
		this.#brokerCapabilities = undefined;
		this.#buffer = "";
		socket.setEncoding("utf8");
		socket.on("data", chunk => this.#onData(chunk, generation));
		socket.on("error", () => {
			// The close handler rejects pending requests with one stable error.
		});
		socket.on("close", () => {
			if (this.#socket === socket) this.#socket = undefined;
			this.#rejectPending(new Error("Daemon broker connection closed"));
			this.#scheduleCompletionReconnect();
		});
	}

	#onData(chunk: string | Buffer, generation: number): void {
		if (generation !== this.#socketGeneration) return;
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
					logger.warn("Ignoring malformed daemon notification", { error: parseError.message });
					continue;
				}
				this.#rejectPending(parseError);
				continue;
			}
			if ("event" in message) {
				if (message.event === "daemon-completed") {
					void this.#queueNotificationDelivery(message.daemon.id, `completion:${message.owner}`, async () => {
						if (this.#closed || generation !== this.#socketGeneration) return;
						await this.#deliverCompletion(message);
					});
				} else {
					void this.#deliverOutput(message, generation);
				}
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

	#queueNotificationDelivery(daemonId: string, consumerId: string, deliver: () => Promise<void>): Promise<void> {
		let consumerTails = this.#notificationDeliveryTails.get(daemonId);
		if (!consumerTails) {
			consumerTails = new Map();
			this.#notificationDeliveryTails.set(daemonId, consumerTails);
		}
		const previous = consumerTails.get(consumerId);
		const delivery = previous ? previous.then(deliver, deliver) : deliver();
		consumerTails.set(consumerId, delivery);
		const cleanup = (): void => {
			if (consumerTails.get(consumerId) !== delivery) return;
			consumerTails.delete(consumerId);
			if (consumerTails.size === 0) this.#notificationDeliveryTails.delete(daemonId);
		};
		void delivery.then(cleanup, cleanup);
		return delivery;
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

	async #deliverOutput(message: DaemonMonitorWireNotification, generation: number): Promise<void> {
		const entry = this.#outputSinks.get(message.monitorId);
		if (!entry) return;
		const notificationDaemonId = message.event === "daemon-monitor-completed" ? message.daemon.id : message.daemonId;
		const deliver = async (): Promise<void> => {
			if (this.#closed || generation !== this.#socketGeneration) return;
			if (this.#outputSinks.get(message.monitorId) !== entry) return;
			if (message.registrationId !== entry.registrationId) return;
			const notificationName = message.event === "daemon-monitor-completed" ? message.daemon.name : message.name;
			if (notificationName !== entry.subscription.name) return;
			if (entry.daemonId === undefined) entry.daemonId = notificationDaemonId;
			else if (entry.daemonId !== notificationDaemonId) return;
			// Destroying a socket does not retract frames already parsed from that
			// socket. Once this connection's callback rejects, suppress everything
			// queued behind it instead of invoking the sink again.
			if (entry.failedDeliveryGeneration === generation) return;
			if (message.event !== "daemon-output" && entry.completionBlocked) {
				entry.resolveReady();
				this.#outputSinks.delete(message.monitorId);
				this.#publishSubscriptions();
				return;
			}
			const notification = publicMonitorNotification(message);
			if (message.event === "daemon-output" && message.epoch !== undefined) {
				// A reconnect replays broker-retained batches; the epoch-scoped
				// cumulative ack identifies the ones this sink already consumed.
				if (message.epoch === entry.lastEpoch && message.seq <= (entry.lastSeq ?? 0)) return;
				await entry.sink(notification);
				if (message.artifactBytes !== undefined) entry.lastArtifactBytes = message.artifactBytes;
				if (message.epoch === entry.lastEpoch) entry.lastSeq = Math.max(entry.lastSeq ?? 0, message.seq);
				else {
					entry.lastEpoch = message.epoch;
					entry.lastSeq = message.seq;
				}
				this.#publishDeliveryAcks();
				return;
			}
			await entry.sink(notification);
			if (message.event !== "daemon-output" && this.#outputSinks.get(message.monitorId) === entry) {
				entry.resolveReady();
				this.#outputSinks.delete(message.monitorId);
				this.#publishSubscriptions();
			}
		};
		await this.#queueNotificationDelivery(notificationDaemonId, `monitor:${entry.registrationId}`, async () => {
			try {
				await deliver();
			} catch (error) {
				entry.failedDeliveryGeneration = generation;
				entry.completionBlocked = true;
				logger.warn("Daemon output sink failed", {
					monitorId: message.monitorId,
					error: error instanceof Error ? error.message : String(error),
				});
				if (generation === this.#socketGeneration) this.#socket?.destroy();
			}
		});
	}

	#ackCompletion(completionId: string): void {
		this.#publishDeliveryAcks([completionId]);
	}

	#publishDeliveryAcks(completionAcks?: string[]): void {
		const socket = this.#socket;
		if (!socket || socket.destroyed) return;
		socket.write(
			`${JSON.stringify({
				id: crypto.randomUUID(),
				token: this.#token,
				owners: [...this.#completionSinks.keys()],
				detachedOwners: [...this.#preservedCompletionOwners],
				completionEvents: true,
				...(completionAcks ? { completionAcks } : {}),
				completionUnsubscribes: [...this.#completionUnsubscribes],
				completionSubscriptionId: this.#completionSubscriptionId,
				outputSubscriptions: this.#outputSubscriptionPayloads(),
				outputSubscriptionId: this.#outputSubscriptionId,
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

/** Create an independent socket connection to one daemon broker scope. */
export async function createDaemonBrokerClient(
	projectDir: string,
	options: DaemonBrokerClientOptions = {},
): Promise<DaemonBrokerClient> {
	const canonical = await canonicalProjectDir(projectDir);
	const runtimeDir = options.runtimeDir ?? daemonRuntimeDir(canonical);
	const token = await readOrCreateToken(runtimeDir);
	return new SocketDaemonClient(canonical, runtimeDir, token, options);
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
	// Keep the broker's runtime dir under a private parent this process owns, so
	// the broker's dead-scope sweep (pruneDeadDaemonRuntimeDirs, fired on startup)
	// can only ever reclaim siblings inside it — never unrelated neighbours in
	// os.tmpdir() such as tmux/ssh sockets or build trees (issue #8721).
	const smokeRoot = await fs.mkdtemp(path.join(os.tmpdir(), "omp-daemon-smoke-"));
	const projectDir = path.join(smokeRoot, "project");
	const runtimeDir = path.join(smokeRoot, "run");
	await fs.mkdir(projectDir, { recursive: true });
	const client = await createDaemonBrokerClient(projectDir, { runtimeDir, idleGraceMs: 5_000 });
	try {
		const ping = await client.request({ op: "ping" });
		if (ping.op !== "ping" || ping.projectDir !== client.projectDir) throw new Error("daemon broker ping mismatch");
		await client.request({ op: "shutdown" });
	} finally {
		client.close();
		await fs.rm(smokeRoot, { recursive: true, force: true });
	}
}
