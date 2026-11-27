import { AuthBrokerError } from "@oh-my-pi/pi-ai/auth-broker";
import { ConfigurationError } from "@oh-my-pi/pi-ai/error";
import { isRecord, logger } from "@oh-my-pi/pi-utils";
import {
	AUTH_DAEMON_BIND_TIMEOUT_MS,
	AUTH_DAEMON_KEY,
	AUTH_DAEMON_KIND,
	AUTH_DAEMON_QUEUE_BYTES,
	AUTH_DAEMON_QUEUE_LENGTH,
	AUTH_DAEMON_VERSION,
	type AuthDaemonDownPacket,
	AuthDaemonFrameDecoder,
	type AuthDaemonIncoming,
	encodeAuthDaemonFrame,
	isAuthDaemonHttpStatus,
	parseAuthDaemonBinding,
	parseAuthDaemonPacket,
} from "../../session/auth-daemon-contract";
import { type AuthDaemonLease, AuthDaemonOwner } from "../../session/auth-daemon-owner";
import { authDaemonSessionHandlers } from "../../session/auth-daemon-sessions";
import type { DaemonModule, ModuleTunnel, ModuleUnit } from "../module";
import { daemonTcpAddress } from "../paths";

/** The handler validates its domain arguments and projects only its allowed reply fields. */
export type AuthDaemonRequestHandler = (lease: AuthDaemonLease, params: unknown) => unknown | Promise<unknown>;

const AUTH_IDLE_MS = 30_000;
const CONCURRENT_REQUESTS = 8;
const CONCURRENT_SCOPE_MUTATIONS = 2;

interface RequestScope {
	session: string;
	otherSession?: string;
	provider?: string;
}

interface QueuedRequest {
	packet: AuthDaemonIncoming;
	bytes: number;
	mutation: boolean;
	scope?: RequestScope;
}

function requestScope(packet: AuthDaemonIncoming): RequestScope | undefined {
	if (packet.type !== "request" || !isRecord(packet.params)) return undefined;
	const { sessionId, provider, sourceSessionId, targetSessionId } = packet.params;
	if (packet.method === "session-inherit") {
		if (typeof sourceSessionId === "string" && typeof targetSessionId === "string") {
			return { session: sourceSessionId, otherSession: targetSessionId };
		}
		return undefined;
	}
	if (typeof sessionId !== "string") return undefined;
	return { session: sessionId, provider: typeof provider === "string" ? provider : undefined };
}

function conflicts(a: QueuedRequest, b: QueuedRequest): boolean {
	if ((!a.mutation && !b.mutation) || !a.scope || !b.scope) return false;
	const x = a.scope;
	const y = b.scope;
	if (x.provider !== undefined && y.provider !== undefined && x.provider !== y.provider) return false;
	return (
		x.session === y.session ||
		x.session === y.otherSession ||
		x.otherSession === y.session ||
		(x.otherSession !== undefined && x.otherSession === y.otherSession)
	);
}

class AuthPeer {
	readonly #tunnel: ModuleTunnel;
	readonly #owner: AuthDaemonOwner;
	readonly #methods: ReadonlyMap<string, AuthDaemonRequestHandler>;
	readonly #remove: () => void;
	readonly #decoder = new AuthDaemonFrameDecoder();
	readonly #queue: QueuedRequest[] = [];
	readonly #active = new Map<number, QueuedRequest>();
	readonly #finished = Promise.withResolvers<void>();
	#bindingDeadline: NodeJS.Timeout | undefined;
	#draining: Promise<void> | undefined;
	#cancelDrain: (() => void) | undefined;
	#receivedBytes = 0;
	#receivedCount = 0;
	#lastId = 0;
	#lease: AuthDaemonLease | undefined;
	#offGeneration: (() => void) | undefined;
	#generationPending = false;
	#sendingGeneration = false;
	#readCount = 0;
	#bound = false;
	#closed = false;
	#settled = false;

	constructor(
		tunnel: ModuleTunnel,
		owner: AuthDaemonOwner,
		methods: ReadonlyMap<string, AuthDaemonRequestHandler>,
		remove: () => void,
	) {
		this.#tunnel = tunnel;
		this.#owner = owner;
		this.#methods = methods;
		this.#remove = remove;
	}

	get busy(): boolean {
		return (!this.#closed && this.#bound) || this.#active.size > 0 || this.#sendingGeneration;
	}

	get finished(): Promise<void> {
		return this.#finished.promise;
	}

	start(): void {
		this.#bindingDeadline = setTimeout(() => this.close(), AUTH_DAEMON_BIND_TIMEOUT_MS).unref();
		this.#tunnel.start(
			chunk => this.#receive(chunk),
			() => this.close(),
		);
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		clearTimeout(this.#bindingDeadline);
		this.#offGeneration?.();
		this.#offGeneration = undefined;
		this.#generationPending = false;
		this.#queue.length = 0;
		this.#receivedBytes = 0;
		this.#receivedCount = 0;
		this.#decoder.clear();
		this.#cancelDrain?.();
		this.#tunnel.close();
		if (!this.busy) this.#finish();
	}

	#finish(): void {
		if (this.#settled) return;
		this.#settled = true;
		try {
			this.#lease?.close();
		} catch {
			logger.warn("Daemon auth lease cleanup failed");
		} finally {
			this.#lease = undefined;
			this.#remove();
			this.#finished.resolve();
		}
	}

	#receive(chunk: Uint8Array): void {
		if (this.#closed) return;
		try {
			this.#decoder.push(chunk, (value, bytes) => {
				const packet = parseAuthDaemonPacket(value);
				if (
					!packet ||
					packet.id <= this.#lastId ||
					(packet.type === "bind") !== (this.#lastId === 0) ||
					this.#receivedCount >= AUTH_DAEMON_QUEUE_LENGTH ||
					this.#receivedBytes + bytes > AUTH_DAEMON_QUEUE_BYTES
				) {
					this.close();
					return false;
				}
				this.#lastId = packet.id;
				this.#queue.push({
					packet,
					bytes,
					mutation: packet.type === "request" && authDaemonSessionHandlers.has(packet.method),
					scope: requestScope(packet),
				});
				this.#receivedBytes += bytes;
				this.#receivedCount++;
				return true;
			});
			this.#pump();
		} catch {
			// Parse errors can contain the raw frame. Do not log or relay them.
			this.close();
		}
	}

	#pump(): void {
		if (this.#closed) {
			if (!this.busy) this.#finish();
			return;
		}
		if (!this.#bound) {
			const entry = this.#queue[0];
			if (entry?.packet.type === "bind") this.#start(entry, 0);
			return;
		}
		if (this.#generationPending && !this.#sendingGeneration) {
			this.#generationPending = false;
			this.#sendingGeneration = true;
			void this.#send({ event: "generation" })
				.catch(() => this.close())
				.finally(() => {
					this.#sendingGeneration = false;
					this.#pump();
				});
		}
		for (let index = 0; index < this.#queue.length;) {
			const entry = this.#queue[index]!;
			const laneFull = entry.mutation
				? this.#active.size - this.#readCount >= CONCURRENT_SCOPE_MUTATIONS
				: this.#readCount >= CONCURRENT_REQUESTS;
			if (laneFull || this.#blocked(entry, index)) {
				index++;
				continue;
			}
			this.#start(entry, index);
		}
	}

	#blocked(entry: QueuedRequest, index: number): boolean {
		for (const active of this.#active.values()) if (conflicts(entry, active)) return true;
		// Preserve FIFO for overlapping scopes, even when that scope's prior job is queued.
		for (let earlier = 0; earlier < index; earlier++) {
			if (conflicts(entry, this.#queue[earlier]!)) return true;
		}
		return false;
	}

	#start(entry: QueuedRequest, index: number): void {
		this.#queue.splice(index, 1);
		const { packet } = entry;
		this.#active.set(packet.id, entry);
		const counted = packet.type === "request" && !entry.mutation;
		if (counted) this.#readCount++;
		const work =
			packet.type === "bind"
				? this.#bind(packet.id, packet.binding)
				: this.#dispatch(packet.id, packet.method, packet.params);
		void work
			.catch(() => this.close())
			.finally(() => {
				this.#active.delete(packet.id);
				if (counted) this.#readCount--;
				this.#pump();
			});
	}

	async #bind(id: number, payload: unknown): Promise<void> {
		const binding = parseAuthDaemonBinding(payload);
		if (!binding) {
			await this.#send({ type: "bind-error", id, kind: "config" });
			this.close();
			return;
		}
		let lease: AuthDaemonLease;
		try {
			lease = await this.#owner.bind(binding);
			this.#lease = lease;
		} catch (error) {
			if (error instanceof AuthBrokerError) {
				const status = isAuthDaemonHttpStatus(error.status) ? error.status : undefined;
				await this.#send({ type: "bind-error", id, kind: "broker", ...(status !== undefined && { status }) });
			} else {
				await this.#send({
					type: "bind-error",
					id,
					kind: error instanceof ConfigurationError ? "config" : "storage",
				});
			}
			this.close();
			return;
		}
		clearTimeout(this.#bindingDeadline);
		if (this.#closed) return;
		this.#offGeneration = lease.run(() =>
			lease.storage.credentials.onGeneration(() => {
				if (this.#closed || this.#generationPending) return;
				this.#generationPending = true;
				queueMicrotask(() => this.#pump());
			}),
		);
		await this.#send({ type: "bound", id });
		this.#bound = !this.#closed;
	}

	async #dispatch(id: number, method: string, params: unknown): Promise<void> {
		const lease = this.#lease;
		if (!lease) {
			this.close();
			return;
		}
		const handler = this.#methods.get(method);
		if (!handler) {
			await this.#send({ type: "request-error", id, kind: "unknown-method" });
			return;
		}
		let value: unknown;
		try {
			value = await lease.run(() => handler(lease, params));
		} catch {
			await this.#send({ type: "request-error", id, kind: "failed" });
			return;
		}
		await this.#send({ type: "result", id, value: value === undefined ? null : value });
	}

	async #send(packet: AuthDaemonDownPacket): Promise<void> {
		while (!this.#closed && this.#draining) await this.#draining;
		if (this.#closed) return;
		let frame: Uint8Array;
		try {
			frame = encodeAuthDaemonFrame(packet);
		} catch {
			if (!("type" in packet) || packet.type !== "result") throw new Error("Invalid daemon auth reply");
			frame = encodeAuthDaemonFrame({ type: "request-error", id: packet.id, kind: "failed" });
		}
		if ("id" in packet) {
			// The peer can use its wire slot again as soon as this reply is sent.
			// Keep the job active until cleanup, but release its receive budget now.
			const entry = this.#active.get(packet.id);
			if (entry) {
				this.#receivedBytes -= entry.bytes;
				this.#receivedCount--;
			}
		}
		if (this.#tunnel.send(frame)) return;
		const { promise, resolve, reject } = Promise.withResolvers<void>();
		this.#draining = promise;
		this.#cancelDrain = resolve;
		try {
			void this.#tunnel.drained().then(resolve, reject);
			await promise;
		} finally {
			this.#draining = undefined;
			this.#cancelDrain = undefined;
		}
	}
}

class AuthUnit implements ModuleUnit {
	readonly label = "Auth store";
	readonly ready = Promise.resolve();
	readonly #exit = Promise.withResolvers<{ reason?: string }>();
	readonly exited = this.#exit.promise;
	readonly #owner = new AuthDaemonOwner();
	readonly #peers = new Set<AuthPeer>();
	readonly #methods: ReadonlyMap<string, AuthDaemonRequestHandler>;
	readonly #nativeTransport: boolean;
	#stopping: Promise<void> | undefined;

	constructor(methods: ReadonlyMap<string, AuthDaemonRequestHandler>, nativeTransport: boolean) {
		this.#methods = methods;
		this.#nativeTransport = nativeTransport;
	}

	pids(): number[] {
		return [];
	}

	busy(): boolean {
		for (const peer of this.#peers) if (peer.busy) return true;
		return false;
	}

	attach(tunnel: ModuleTunnel, channel: string | undefined): void {
		if (!this.#nativeTransport || this.#stopping || channel !== undefined) {
			tunnel.close();
			return;
		}
		const peer = new AuthPeer(tunnel, this.#owner, this.#methods, () => this.#peers.delete(peer));
		this.#peers.add(peer);
		peer.start();
	}

	stop(reason: string): Promise<void> {
		this.#stopping ??= this.#stop(reason);
		return this.#stopping;
	}

	async #stop(reason: string): Promise<void> {
		const closed: Promise<void>[] = [];
		for (const peer of this.#peers) {
			closed.push(peer.finished);
			peer.close();
		}
		try {
			await Promise.all(closed);
			await this.#owner.close();
		} catch {
			throw new Error("Daemon auth store cleanup failed");
		} finally {
			this.#exit.resolve({ reason });
		}
	}
}

/** The daemon exposes only the supplied domain methods, and only over native IPC. */
export function createAuthModule(methods: ReadonlyMap<string, AuthDaemonRequestHandler>): DaemonModule {
	let nativeTransport = false;
	let unit: AuthUnit | undefined;
	return {
		kind: AUTH_DAEMON_KIND,
		version: AUTH_DAEMON_VERSION,
		init() {
			// Same server-side selector as the listener; nothing from the client opts into this.
			nativeTransport = daemonTcpAddress() === undefined;
		},
		policy(params) {
			if (!nativeTransport) throw new Error("Daemon auth requires a local socket or named pipe");
			if (params !== undefined) throw new Error("Daemon auth does not accept open parameters");
			return { hold: "leases", idleMs: AUTH_IDLE_MS, onIdle: "stop", restart: "no", survive: "none", cap: 1 };
		},
		open(_context, request) {
			if (!nativeTransport) throw new Error("Daemon auth requires a local socket or named pipe");
			if (
				request.scope.kind !== "global" ||
				request.key !== AUTH_DAEMON_KEY ||
				request.params !== undefined ||
				request.proc
			) {
				throw new Error("Invalid daemon auth unit");
			}
			if (unit) throw new Error("Daemon auth store is already open");
			const opened = new AuthUnit(methods, nativeTransport);
			unit = opened;
			void opened.exited.then(() => {
				if (unit === opened) unit = undefined;
			});
			return opened;
		},
		async dispose() {
			await unit?.stop("daemon shutdown");
		},
	};
}
