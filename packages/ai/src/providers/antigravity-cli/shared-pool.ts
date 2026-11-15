/**
 * Process-wide shared `agy acp` backend pool keyed by account (`geminiDir`),
 * credential revision, and advertised MCP tool set (`toolsKey`).
 *
 * Sessions with identical `(geminiDir, credentialVersion, toolsKey)` multiplex
 * over one `ClientSideConnection` and one fixed-tool `--ide-mcp-port` `McpBridge`
 * without cross-session tool leakage or schema collisions, reference-counting
 * active leases with an unreferenced idle shutdown timer.
 */
import { postmortem, stableStringifyJson } from "@oh-my-pi/pi-utils";
import { type InitializeResponse, RequestError, type SessionNotification } from "@oh-my-pi/pi-utils/acp";
import {
	getSharedAgyWorkerBridge,
	setSharedAgyMainThreadAcquirer,
	type SharedAgyBridgeLease,
	type SharedAgyBridgeRequest,
} from "../antigravity-cli-state";
import {
	McpBridge,
	type McpCallHandler,
	type McpToolDefinition,
	type McpToolOutput,
	validateMcpTools,
} from "./mcp-bridge";
import {
	type AgyConnection,
	type AgyScheduler,
	type AgySpawnedProcess,
	type AgyTimer,
	type AgyTransport,
	ensureEmptyWorkspace,
	scheduleTimer,
	spawnAgyCliProcess,
	withTimeout,
} from "./process";

const DEFAULT_IDLE_TIMEOUT_MS = 60_000;
const DEFAULT_CLOSE_TIMEOUT_MS = 2_000;
const MAX_EARLY_SESSION_UPDATES = 256;

/** Parameters passed to the shared backend process starter. */
export interface SharedAgyBackendStartOptions {
	geminiDir: string;
	cwd: string;
	tools: readonly McpToolDefinition[];
	onCall: McpCallHandler;
	hasConversation(conversationId: string): boolean;
	onUpdate(notification: SessionNotification): void;
	onDisconnect(): void;
}

/** Configuration and deterministic test seams for {@link SharedAgyPool}. */
export interface SharedAgyPoolOptions {
	idleTimeoutMs?: number;
	closeTimeoutMs?: number;
	schedule?: AgyScheduler;
	startBackend?: (options: SharedAgyBackendStartOptions) => Promise<AgySpawnedProcess>;
	registerProcessHooks?: boolean;
}

interface LeaseState {
	onCall: McpCallHandler;
	onUpdate: (notification: SessionNotification) => void;
	sessions: Set<string>;
	activePrompts: Map<string, Promise<void>>;
	inFlightSetups: Set<Promise<void>>;
	cancelSettled?: Promise<void>;
	abort: AbortController;
	closedDeferred: PromiseWithResolvers<never>;
	exitDeferred: PromiseWithResolvers<number>;
	closed: boolean;
}

function unreferencedSchedule(delayMs: number, callback: () => void): AgyTimer {
	return scheduleTimer(delayMs, callback, { unref: true });
}

async function startSharedBackendProcess(options: SharedAgyBackendStartOptions): Promise<AgySpawnedProcess> {
	let closeProcess: (() => void) | undefined;
	const bridge = new McpBridge(options.tools, options.onCall, {
		onDisconnect: () => closeProcess?.(),
		requireConversationId: true,
		validateConversationId: conversationId => options.hasConversation(conversationId),
	});
	try {
		const proc = await spawnAgyCliProcess({
			geminiDir: options.geminiDir,
			cwd: options.cwd,
			bridge,
			onUpdate: options.onUpdate,
		});
		closeProcess = () => {
			options.onDisconnect();
			proc.close();
		};
		return proc;
	} catch (error) {
		bridge.close();
		throw error;
	}
}

class SharedAgyBackend {
	readonly credentialVersion: string | undefined;
	readonly credentialExpires: number | undefined;
	readonly #geminiDir: string;
	readonly #tools: readonly McpToolDefinition[];
	readonly #idleTimeoutMs: number;
	readonly #closeTimeoutMs: number;
	readonly #schedule: AgyScheduler;
	readonly #startBackend: (options: SharedAgyBackendStartOptions) => Promise<AgySpawnedProcess>;
	readonly #onDisposed: () => void;
	readonly #leases = new Set<LeaseState>();
	readonly #sessionOwners = new Map<string, LeaseState>();
	readonly #earlyUpdates = new Map<string, SessionNotification[]>();
	readonly #ready: Promise<void>;
	readonly #exitSettled = Promise.withResolvers<void>();
	readonly #terminalError = Promise.withResolvers<Error>();
	#proc: AgySpawnedProcess | undefined;
	#initialized: Promise<InitializeResponse> | undefined;
	#idleTimer: AgyTimer | undefined;
	#pendingNewSessions = 0;
	#closingLeases = 0;
	#retiring = false;
	#dead = false;

	constructor(
		geminiDir: string,
		credentialVersion: string | undefined,
		credentialExpires: number | undefined,
		tools: readonly McpToolDefinition[],
		options: Required<Omit<SharedAgyPoolOptions, "registerProcessHooks">>,
		onDisposed: () => void,
	) {
		this.#geminiDir = geminiDir;
		this.credentialVersion = credentialVersion;
		this.credentialExpires = credentialExpires;
		this.#tools = [...tools];
		this.#idleTimeoutMs = options.idleTimeoutMs;
		this.#closeTimeoutMs = options.closeTimeoutMs;
		this.#schedule = options.schedule;
		this.#startBackend = options.startBackend;
		this.#onDisposed = onDisposed;
		this.#ready = this.#boot();
		this.#ready.catch(() => undefined);
	}

	get dead(): boolean {
		return this.#dead;
	}

	get retiring(): boolean {
		return this.#retiring;
	}

	get exitSettled(): Promise<void> {
		return this.#exitSettled.promise;
	}

	retire(): void {
		if (this.#dead || this.#retiring) return;
		this.#retiring = true;
		this.#cancelIdleTimer();
		if (this.#leases.size === 0) this.shutdown();
	}

	shutdown(): void {
		this.#fail(new Error("Antigravity CLI shared process shut down"), 0);
	}

	async acquireLease(request: SharedAgyBridgeRequest): Promise<SharedAgyBridgeLease> {
		request.signal.throwIfAborted();
		if (this.#dead || this.#retiring) throw new Error("Antigravity CLI shared process is unavailable");
		this.#cancelIdleTimer();

		let lease: LeaseState | undefined;
		try {
			lease = {
				onCall: request.onCall,
				onUpdate: request.onUpdate,
				sessions: new Set(),
				activePrompts: new Map(),
				inFlightSetups: new Set(),
				abort: new AbortController(),
				closedDeferred: Promise.withResolvers<never>(),
				exitDeferred: Promise.withResolvers<number>(),
				closed: false,
			};
			lease.closedDeferred.promise.catch(() => undefined);
			this.#leases.add(lease);
			this.#syncProcessRefs();
		} catch (error) {
			this.#scheduleIdleIfEmpty();
			throw error;
		}

		const activeLease = lease;
		const onAbortDuringBoot = () => {
			this.#closeLease(activeLease, request.signal.reason);
		};
		request.signal.addEventListener("abort", onAbortDuringBoot, { once: true });
		try {
			await Promise.race([this.#ready, activeLease.closedDeferred.promise]);
		} finally {
			request.signal.removeEventListener("abort", onAbortDuringBoot);
		}
		request.signal.throwIfAborted();
		if (activeLease.closed || this.#dead) throw new Error("Antigravity CLI shared process is unavailable");

		const connection: AgyConnection = {
			get signal() {
				return activeLease.abort.signal;
			},
			initialize: async () => {
				this.#assertLeaseOpen(activeLease);
				return this.#raceLease(activeLease, this.#ensureInitialized());
			},
			newSession: async params => {
				this.#assertLeaseOpen(activeLease);
				this.#pendingNewSessions++;
				const rawCreated = this.#requireConnection().newSession(params);
				const cleanupIfClosed = rawCreated.then(
					async created => {
						if (activeLease.closed && !this.#dead) {
							await this.#proc?.connection.closeSession({ sessionId: created.sessionId }).catch(() => undefined);
						}
					},
					() => undefined,
				);
				activeLease.inFlightSetups.add(cleanupIfClosed);
				void cleanupIfClosed.finally(() => activeLease.inFlightSetups.delete(cleanupIfClosed));
				try {
					const created = await this.#raceLease(activeLease, rawCreated);
					this.#bindSession(created.sessionId, activeLease);
					const buffered = this.#earlyUpdates.get(created.sessionId);
					if (buffered) {
						this.#earlyUpdates.delete(created.sessionId);
						for (const note of buffered) activeLease.onUpdate(note);
					}
					return created;
				} finally {
					this.#pendingNewSessions--;
					if (this.#pendingNewSessions === 0) this.#earlyUpdates.clear();
				}
			},
			loadSession: async params => {
				this.#assertLeaseOpen(activeLease);
				const existing = this.#sessionOwners.get(params.sessionId);
				if (existing && existing !== activeLease && !existing.closed) {
					throw new Error("Antigravity CLI conversation is already active in another session");
				}
				const wasOwned = existing === activeLease;
				this.#bindSession(params.sessionId, activeLease);
				const rawLoaded = this.#requireConnection().loadSession(params);
				const cleanupIfClosed = rawLoaded.then(
					async () => {
						if (activeLease.closed && !this.#dead) {
							await this.#proc?.connection.closeSession({ sessionId: params.sessionId }).catch(() => undefined);
						}
					},
					() => undefined,
				);
				activeLease.inFlightSetups.add(cleanupIfClosed);
				void cleanupIfClosed.finally(() => activeLease.inFlightSetups.delete(cleanupIfClosed));
				try {
					return await this.#raceLease(activeLease, rawLoaded);
				} catch (error) {
					if (!wasOwned) this.#unbindSession(params.sessionId, activeLease);
					throw error;
				}
			},
			closeSession: async params => {
				if (this.#sessionOwners.get(params.sessionId) !== activeLease) return {};
				this.#unbindSession(params.sessionId, activeLease);
				return this.#raceLease(activeLease, this.#requireConnection().closeSession(params));
			},
			setSessionConfigOption: async params => {
				this.#requireOwnedSession(params.sessionId, activeLease);
				return this.#raceLease(activeLease, this.#requireConnection().setSessionConfigOption(params));
			},
			prompt: async params => {
				this.#requireOwnedSession(params.sessionId, activeLease);
				const rawPrompt = this.#requireConnection().prompt(params);
				const settled = rawPrompt.then(
					() => undefined,
					() => undefined,
				);
				activeLease.activePrompts.set(params.sessionId, settled);
				try {
					return await this.#raceLease(activeLease, rawPrompt);
				} finally {
					if (activeLease.activePrompts.get(params.sessionId) === settled) {
						activeLease.activePrompts.delete(params.sessionId);
					}
				}
			},
			cancel: async params => {
				if (this.#sessionOwners.get(params.sessionId) !== activeLease) return;
				await this.#requireConnection().cancel(params);
			},
		};

		return {
			connection,
			exited: activeLease.exitDeferred.promise,
			credentialVersion: this.credentialVersion,
			credentialExpires: this.credentialExpires,
			close: () => this.#closeLease(activeLease),
		};
	}

	async #boot(): Promise<void> {
		try {
			const spawnCwd = await ensureEmptyWorkspace(this.#geminiDir);
			if (this.#dead) return;
			const proc = await this.#startBackend({
				geminiDir: this.#geminiDir,
				cwd: spawnCwd,
				tools: this.#tools,
				onCall: (name, args, conversationId) => this.#onToolCall(name, args, conversationId),
				hasConversation: conversationId => {
					const owner = this.#sessionOwners.get(conversationId);
					return Boolean(owner && !owner.closed);
				},
				onUpdate: notification => this.#onSessionUpdate(notification),
				onDisconnect: () => {
					if (this.#proc)
						this.#failOnTransportClose(this.#proc, new Error("Antigravity CLI MCP connection closed"));
					else this.#fail(new Error("Antigravity CLI MCP connection closed"), 1);
				},
			});
			if (this.#dead) {
				proc.close();
				void proc.exited.then(
					() => this.#exitSettled.resolve(),
					() => this.#exitSettled.resolve(),
				);
				return;
			}
			this.#proc = proc;
			this.#syncProcessRefs();
			proc.connection.signal.addEventListener(
				"abort",
				() => this.#failOnTransportClose(proc, new Error("Antigravity CLI ACP connection closed")),
				{ once: true },
			);
			if (proc.connection.signal.aborted) {
				this.#failOnTransportClose(proc, new Error("Antigravity CLI ACP connection closed"));
				return;
			}
			void proc.exited.then(
				code => {
					this.#fail(new Error(`Antigravity CLI exited with code ${code}`), code);
					this.#exitSettled.resolve();
				},
				error => {
					this.#fail(error, 1);
					this.#exitSettled.resolve();
				},
			);
			this.#scheduleIdleIfEmpty();
		} catch (error) {
			this.#fail(error, 1);
			this.#exitSettled.resolve();
			throw error;
		}
	}

	async #onToolCall(
		name: string,
		args: Record<string, unknown>,
		conversationId: string | undefined,
	): Promise<McpToolOutput> {
		const owner = conversationId ? this.#sessionOwners.get(conversationId) : undefined;
		if (!owner || owner.closed) {
			return { content: [{ type: "text", text: "Tool call belongs to a closed session." }], isError: true };
		}
		try {
			return await owner.onCall(name, args, conversationId);
		} finally {
			if (owner.closed && owner.cancelSettled) {
				await owner.cancelSettled;
			}
		}
	}

	#requireConnection(): AgyConnection {
		if (!this.#proc || this.#dead) throw new Error("Antigravity CLI shared process is unavailable");
		return this.#proc.connection;
	}

	#assertLeaseOpen(lease: LeaseState): void {
		if (lease.closed || this.#dead) throw new Error("Antigravity CLI session closed");
	}

	#requireOwnedSession(sessionId: string, lease: LeaseState): void {
		this.#assertLeaseOpen(lease);
		if (this.#sessionOwners.get(sessionId) !== lease) {
			throw new Error("Antigravity CLI session does not belong to this host");
		}
	}

	#ensureInitialized(): Promise<InitializeResponse> {
		if (!this.#initialized) {
			this.#initialized = this.#requireConnection().initialize({
				protocolVersion: 1,
				clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
				clientInfo: { name: "bridge", title: "Host tool bridge", version: "1" },
			});
			this.#initialized.catch(() => {
				this.#initialized = undefined;
			});
		}
		return this.#initialized;
	}

	#bindSession(sessionId: string, lease: LeaseState): void {
		lease.sessions.add(sessionId);
		this.#sessionOwners.set(sessionId, lease);
	}

	#unbindSession(sessionId: string, lease: LeaseState): void {
		lease.sessions.delete(sessionId);
		if (this.#sessionOwners.get(sessionId) === lease) this.#sessionOwners.delete(sessionId);
	}

	#onSessionUpdate(notification: SessionNotification): void {
		const owner = this.#sessionOwners.get(notification.sessionId);
		if (owner && !owner.closed) {
			owner.onUpdate(notification);
			return;
		}
		if (this.#pendingNewSessions <= 0) return;
		let buffered = this.#earlyUpdates.get(notification.sessionId);
		if (!buffered) {
			buffered = [];
			this.#earlyUpdates.set(notification.sessionId, buffered);
		}
		if (buffered.length < MAX_EARLY_SESSION_UPDATES) buffered.push(notification);
	}

	#syncProcessRefs(): void {
		if (!this.#proc) return;
		if (!this.#dead && (this.#leases.size > 0 || this.#closingLeases > 0)) {
			this.#proc.ref();
		} else {
			this.#proc.unref();
		}
	}

	#closeLease(lease: LeaseState, reason?: unknown): void {
		if (lease.closed) return;
		lease.closed = true;
		const closedError =
			reason instanceof Error
				? reason
				: new Error(reason !== undefined ? String(reason) : "Antigravity CLI session closed");
		lease.closedDeferred.reject(closedError);
		lease.abort.abort(closedError);
		const activePrompts = [...lease.activePrompts.entries()];
		const inFlightSetups = [...lease.inFlightSetups];
		const ownedSessions = [...lease.sessions];
		lease.activePrompts.clear();
		for (const id of ownedSessions) this.#unbindSession(id, lease);
		this.#leases.delete(lease);
		const proc = this.#proc;
		if (
			this.#dead ||
			!proc ||
			(activePrompts.length === 0 && inFlightSetups.length === 0 && ownedSessions.length === 0)
		) {
			this.#syncProcessRefs();
			if (this.#retiring && this.#leases.size === 0 && this.#closingLeases === 0) this.shutdown();
			else this.#scheduleIdleIfEmpty();
			lease.exitDeferred.resolve(0);
			return;
		}
		this.#closingLeases++;
		this.#syncProcessRefs();

		const cancelWork = (async () => {
			await Promise.all(
				activePrompts.map(async ([sessionId, promptSettled]) => {
					await proc.connection.cancel({ sessionId }).catch(() => undefined);
					await promptSettled;
				}),
			);
			if (inFlightSetups.length > 0) {
				await Promise.allSettled(inFlightSetups);
			}
		})();
		lease.cancelSettled = withTimeout(
			cancelWork,
			this.#closeTimeoutMs,
			"Antigravity CLI cancellation timed out",
			this.#schedule,
		).catch(() => undefined);

		void (async () => {
			try {
				await lease.cancelSettled;
				if (!this.#dead && this.#proc === proc && ownedSessions.length > 0) {
					await withTimeout(
						Promise.all(
							ownedSessions.map(id => proc.connection.closeSession({ sessionId: id }).catch(() => undefined)),
						),
						this.#closeTimeoutMs,
						"Antigravity CLI session close timed out",
						this.#schedule,
					).catch(() => undefined);
				}
			} finally {
				this.#closingLeases--;
				this.#syncProcessRefs();
				if (this.#retiring && this.#leases.size === 0 && this.#closingLeases === 0) {
					this.shutdown();
					await proc.exited.catch(() => undefined);
				} else {
					this.#scheduleIdleIfEmpty();
				}
				lease.exitDeferred.resolve(0);
			}
		})();
	}

	#cancelIdleTimer(): void {
		this.#idleTimer?.cancel();
		this.#idleTimer = undefined;
	}

	#scheduleIdleIfEmpty(): void {
		if (this.#dead || this.#retiring || this.#leases.size > 0 || this.#closingLeases > 0 || this.#idleTimer) return;
		this.#idleTimer = this.#schedule(this.#idleTimeoutMs, () => {
			this.#idleTimer = undefined;
			if (this.#leases.size === 0 && this.#closingLeases === 0) this.shutdown();
		});
	}
	async #raceLease<T>(activeLease: LeaseState, operation: Promise<T>): Promise<T> {
		const leaseClosed = {};
		const outcome = await Promise.race([
			operation.then(
				value => ({ ok: true as const, value }),
				error => ({ ok: false as const, error }),
			),
			activeLease.closedDeferred.promise.catch(error => ({ ok: false as const, error, closed: leaseClosed })),
		]);
		if (outcome.ok) return outcome.value;
		if ("closed" in outcome || outcome.error instanceof RequestError) throw outcome.error;
		if (this.#proc?.connection.signal.aborted || this.#dead) {
			throw await this.#terminalError.promise;
		}
		throw outcome.error;
	}

	#failOnTransportClose(proc: AgySpawnedProcess, fallbackError: Error): void {
		if (this.#dead) return;
		const grace = Promise.withResolvers<null>();
		const timer = unreferencedSchedule(50, () => grace.resolve(null));
		void Promise.race([proc.exited, grace.promise])
			.then(
				code => {
					if (typeof code === "number") {
						this.#fail(new Error(`Antigravity CLI exited with code ${code}`), code);
					} else {
						this.#fail(fallbackError, 1);
					}
				},
				error => this.#fail(error, 1),
			)
			.finally(() => timer.cancel());
	}

	#fail(error: unknown, exitCode: number): void {
		if (this.#dead) return;
		this.#dead = true;
		this.#cancelIdleTimer();
		this.#onDisposed();
		const reason = error instanceof Error ? error : new Error(String(error));
		this.#terminalError.resolve(reason);
		const openLeases = [...this.#leases];
		this.#leases.clear();
		this.#sessionOwners.clear();
		this.#earlyUpdates.clear();
		const proc = this.#proc;
		this.#proc = undefined;
		if (proc) {
			proc.close();
			void proc.exited.then(
				() => this.#exitSettled.resolve(),
				() => this.#exitSettled.resolve(),
			);
		} else {
			this.#exitSettled.resolve();
		}
		for (const lease of openLeases) {
			lease.closed = true;
			lease.closedDeferred.reject(reason);
			lease.abort.abort(reason);
			lease.exitDeferred.resolve(exitCode);
		}
	}
}

/**
 * Manages shared `agy acp` backends keyed by `(geminiDir, credentialVersion, toolsKey)`.
 * Exported as a class for isolated unit tests and as {@link sharedAgyPool} for the process.
 */
export class SharedAgyPool {
	readonly #backends = new Map<string, SharedAgyBackend>();
	readonly #retiringBackends = new Set<SharedAgyBackend>();
	readonly #stoppingBackends = new Set<SharedAgyBackend>();
	readonly #options: Required<Omit<SharedAgyPoolOptions, "registerProcessHooks">>;
	#cleanupRegistered = false;

	constructor(options: SharedAgyPoolOptions = {}) {
		this.#options = {
			idleTimeoutMs: options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS,
			closeTimeoutMs: options.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS,
			schedule: options.schedule ?? unreferencedSchedule,
			startBackend: options.startBackend ?? startSharedBackendProcess,
		};
		if (options.registerProcessHooks !== false) {
			this.#registerExitCleanup();
		}
	}

	/** Number of live (non-dead) backends currently tracked by this pool. */
	get activeBackendCount(): number {
		let count = 0;
		for (const backend of this.#backends.values()) {
			if (!backend.dead) count++;
		}
		for (const backend of this.#retiringBackends) {
			if (!backend.dead) count++;
		}
		return count;
	}

	/** Acquire a session lease on the shared backend for `(geminiDir, credentialVersion, toolsKey)`. */
	async acquire(request: SharedAgyBridgeRequest): Promise<SharedAgyBridgeLease> {
		request.signal.throwIfAborted();
		validateMcpTools(request.tools);
		const toolsKey = stableStringifyJson(request.tools);
		const poolKey = `${request.geminiDir}\0${toolsKey}`;

		let backend = this.#backends.get(poolKey);
		const staleRequest =
			backend !== undefined &&
			backend.credentialExpires !== undefined &&
			request.credentialExpires !== undefined &&
			request.credentialExpires < backend.credentialExpires;
		if (backend && !backend.dead && backend.credentialVersion !== request.credentialVersion && !staleRequest) {
			this.#backends.delete(poolKey);
			this.#retiringBackends.add(backend);
			backend.retire();
			backend = undefined;
		}
		if (!backend || backend.dead || backend.retiring) {
			const created = new SharedAgyBackend(
				request.geminiDir,
				request.credentialVersion,
				request.credentialExpires,
				request.tools,
				this.#options,
				() => {
					if (this.#backends.get(poolKey) === created) this.#backends.delete(poolKey);
					this.#retiringBackends.delete(created);
					this.#stoppingBackends.add(created);
					void created.exitSettled.finally(() => this.#stoppingBackends.delete(created));
				},
			);
			this.#backends.set(poolKey, created);
			backend = created;
		}
		return backend.acquireLease(request);
	}

	/** Immediately terminate all active and retiring shared backends. */
	closeAll(): void {
		const all = [...this.#backends.values(), ...this.#retiringBackends];
		this.#backends.clear();
		this.#retiringBackends.clear();
		for (const backend of all) {
			backend.shutdown();
		}
	}

	/** Close all backends and await full child process termination. */
	async drain(): Promise<void> {
		this.closeAll();
		await Promise.all([...this.#stoppingBackends].map(backend => backend.exitSettled));
	}

	#registerExitCleanup(): void {
		if (this.#cleanupRegistered) return;
		this.#cleanupRegistered = true;
		postmortem.register("antigravity-cli-shared-pool", () => {
			this.closeAll();
		});
	}
}

/** Process-wide shared `agy acp` pool on the main thread. */
export const sharedAgyPool = new SharedAgyPool();

setSharedAgyMainThreadAcquirer(request => sharedAgyPool.acquire(request));

/**
 * Acquire a shared `agy` transport, delegating through the registered worker
 * bridge when running inside a `SubagentWorkerPool` worker thread.
 */
export async function acquireSharedAgyTransport(
	request: SharedAgyBridgeRequest,
	poolOverride?: SharedAgyPool,
): Promise<AgyTransport> {
	if (poolOverride) return poolOverride.acquire(request);
	const bridge = getSharedAgyWorkerBridge();
	if (bridge) return bridge(request);
	return sharedAgyPool.acquire(request);
}

/** Shut down all process-wide shared `agy` backends immediately. */
export function closeAllSharedAgyBackends(): void {
	sharedAgyPool.closeAll();
}
