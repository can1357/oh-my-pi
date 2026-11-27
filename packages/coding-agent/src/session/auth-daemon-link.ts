import { daemonClient, DaemonRejectedError, openTunnel } from "../daemon/client";
import { DAEMON_TCP_ENV, type DaemonClient, type DaemonTunnel, GLOBAL_SCOPE } from "../daemon/protocol";
import {
	AUTH_DAEMON_BIND_TIMEOUT_MS,
	AUTH_DAEMON_KEY,
	AUTH_DAEMON_KIND,
	AUTH_DAEMON_METHOD_LENGTH,
	AUTH_DAEMON_QUEUE_BYTES,
	AUTH_DAEMON_QUEUE_LENGTH,
	AUTH_DAEMON_VERSION,
	type AuthDaemonBinding,
	AuthDaemonFrameDecoder,
	type AuthDaemonPacket,
	type AuthDaemonReply,
	encodeAuthDaemonFrame,
	parseAuthDaemonDownPacket,
} from "./auth-daemon-contract";

const REQUEST_TIMEOUT_MS = 5 * 60_000;
const MAX_QUEUED_REQUESTS = 4 * AUTH_DAEMON_QUEUE_LENGTH;
const MAX_QUEUED_BYTES = 2 * AUTH_DAEMON_QUEUE_BYTES;

const BIND_ERROR_MESSAGES = {
	config: "Daemon rejected the auth store configuration",
	storage: "Daemon could not open the auth store",
	broker: "Daemon could not open the configured auth broker",
	transport: "Daemon auth connection lost during binding",
};

export class AuthDaemonBindingError extends Error {
	constructor(
		readonly kind: keyof typeof BIND_ERROR_MESSAGES,
		readonly status?: number,
	) {
		super(BIND_ERROR_MESSAGES[kind] + (kind === "broker" && status !== undefined ? ` (HTTP ${status})` : ""));
		this.name = "AuthDaemonBindingError";
	}
}

export class AuthDaemonTransportError extends Error {
	constructor() {
		super("Daemon auth connection lost; pending operations were not retried");
		this.name = "AuthDaemonTransportError";
	}
}

export class AuthDaemonRequestTimeoutError extends Error {
	constructor(readonly mayHaveRun: boolean) {
		super(
			mayHaveRun
				? "Daemon auth operation timed out; it may have run and was not retried"
				: "Daemon auth operation timed out before being sent",
		);
		this.name = "AuthDaemonRequestTimeoutError";
	}
}

/** Bound auth channel. The server determines which domain operations exist; there is no automatic replay. */
export interface AuthDaemonLink {
	request(method: string, params?: unknown, signal?: AbortSignal): Promise<unknown>;
	/** Invalidates credential metadata; no credentials are carried by the event. */
	onGeneration(listener: () => void): () => void;
	/** Observes close, including when the link was already closed at registration. */
	onClose(listener: () => void): () => void;
	close(): void;
}

interface PendingRequest {
	timer: NodeJS.Timeout;
	removeAbort?: () => void;
	resolve(reply: AuthDaemonReply): void;
	reject(error: unknown): void;
}

interface QueuedWrite {
	id: number;
	binding: boolean;
	frame: Uint8Array;
}

interface SentRequest {
	binding: boolean;
	bytes: number;
}

function notifyListener(listener: () => void): void {
	try {
		listener();
	} catch {
		// A local subscriber cannot break this link or other subscribers.
	}
}

class AuthTunnelLink implements AuthDaemonLink {
	readonly #decoder = new AuthDaemonFrameDecoder();
	readonly #pending = new Map<number, PendingRequest>();
	readonly #sent = new Map<number, SentRequest>();
	readonly #generationListeners = new Set<() => void>();
	readonly #closeListeners = new Set<() => void>();
	readonly #writes: QueuedWrite[] = [];
	readonly #tunnel: DaemonTunnel;
	readonly #release: () => void;
	#writeBytes = 0;
	#sentBytes = 0;
	#draining = false;
	#bound = false;
	#closed = false;
	#id = 0;

	constructor(tunnel: DaemonTunnel, release: () => void) {
		this.#tunnel = tunnel;
		this.#release = release;
		tunnel.unref();
		tunnel.start(
			chunk => this.#receive(chunk),
			() => this.close(),
		);
	}

	async bind(binding: AuthDaemonBinding): Promise<void> {
		let reply: AuthDaemonReply;
		try {
			reply = await this.#call({ type: "bind", id: ++this.#id, binding });
		} catch (error) {
			const transport = error instanceof AuthDaemonTransportError || error instanceof AuthDaemonRequestTimeoutError;
			throw new AuthDaemonBindingError(transport ? "transport" : "config");
		}
		if (reply.type === "bound" && !this.#closed) return;
		if (reply.type === "bind-error") {
			throw new AuthDaemonBindingError(reply.kind, reply.kind === "broker" ? reply.status : undefined);
		}
		throw new AuthDaemonBindingError("transport");
	}

	async request(method: string, params?: unknown, signal?: AbortSignal): Promise<unknown> {
		if (method.length === 0 || method.length > AUTH_DAEMON_METHOD_LENGTH)
			throw new Error("Invalid daemon auth method");
		const reply = await this.#call({ type: "request", id: ++this.#id, method, params }, signal);
		if (reply.type === "result") return reply.value;
		if (reply.type === "request-error" && reply.kind === "unknown-method") {
			throw new Error("Unknown daemon auth method");
		}
		throw new Error("Daemon auth operation failed");
	}

	onGeneration(listener: () => void): () => void {
		if (!this.#closed) this.#generationListeners.add(listener);
		return () => {
			this.#generationListeners.delete(listener);
		};
	}

	onClose(listener: () => void): () => void {
		if (this.#closed) notifyListener(listener);
		else this.#closeListeners.add(listener);
		return () => {
			this.#closeListeners.delete(listener);
		};
	}

	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		const error = new AuthDaemonTransportError();
		for (const pending of this.#pending.values()) {
			clearTimeout(pending.timer);
			pending.removeAbort?.();
			pending.reject(error);
		}
		this.#pending.clear();
		this.#sent.clear();
		this.#sentBytes = 0;
		this.#generationListeners.clear();
		this.#writes.length = 0;
		this.#writeBytes = 0;
		this.#decoder.clear();
		this.#tunnel.unref();
		this.#tunnel.close();
		for (const listener of this.#closeListeners) notifyListener(listener);
		this.#closeListeners.clear();
		this.#release();
	}

	#call(packet: AuthDaemonPacket, signal?: AbortSignal): Promise<AuthDaemonReply> {
		signal?.throwIfAborted();
		if (this.#closed) throw new AuthDaemonTransportError();
		const frame = encodeAuthDaemonFrame(packet);
		signal?.throwIfAborted();
		if (this.#closed) throw new AuthDaemonTransportError();
		if (this.#writes.length >= MAX_QUEUED_REQUESTS || this.#writeBytes + frame.byteLength > MAX_QUEUED_BYTES) {
			throw new Error("Daemon auth send queue is full");
		}
		const { promise, resolve, reject } = Promise.withResolvers<AuthDaemonReply>();
		const { id } = packet;
		const binding = packet.type === "bind";
		const timer = setTimeout(
			() => this.#abandon(id, new AuthDaemonRequestTimeoutError(this.#sent.has(id))),
			binding ? AUTH_DAEMON_BIND_TIMEOUT_MS : REQUEST_TIMEOUT_MS,
		).unref();
		const pending: PendingRequest = { timer, resolve, reject };
		if (signal) {
			const abort = (): void => this.#abandon(id, signal.reason);
			signal.addEventListener("abort", abort, { once: true });
			pending.removeAbort = () => signal.removeEventListener("abort", abort);
		}
		if (this.#pending.size === 0) this.#tunnel.ref();
		this.#pending.set(id, pending);
		this.#writes.push({ id, binding, frame });
		this.#writeBytes += frame.byteLength;
		this.#flush();
		return promise;
	}

	#takePending(id: number): PendingRequest | undefined {
		const pending = this.#pending.get(id);
		if (!pending) return undefined;
		this.#pending.delete(id);
		clearTimeout(pending.timer);
		pending.removeAbort?.();
		if (this.#pending.size === 0) this.#tunnel.unref();
		return pending;
	}

	#abandon(id: number, reason: unknown): void {
		const pending = this.#takePending(id);
		if (!pending) return;
		// Sent calls still consume the bounded wire window until their actual replies.
		// Dropping their correlation would confuse late replies with protocol errors.
		if (!this.#sent.has(id)) {
			const index = this.#writes.findIndex(write => write.id === id);
			if (index !== -1) {
				this.#writeBytes -= this.#writes[index]!.frame.byteLength;
				this.#writes.splice(index, 1);
			}
		}
		pending.reject(reason);
		this.#flush();
	}

	#flush(): void {
		if (this.#closed || this.#draining) return;
		try {
			for (let write = this.#writes[0]; write; write = this.#writes[0]) {
				const { id, binding, frame } = write;
				const bytes = frame.byteLength;
				if (this.#sent.size >= AUTH_DAEMON_QUEUE_LENGTH || this.#sentBytes + bytes > AUTH_DAEMON_QUEUE_BYTES) {
					return;
				}
				this.#writes.shift();
				this.#writeBytes -= bytes;
				this.#sentBytes += bytes;
				this.#sent.set(id, { binding, bytes });
				if (this.#tunnel.send(frame)) continue;
				// send(false) accepted this frame; wait for capacity, never send it again.
				this.#draining = true;
				void this.#tunnel.drained().then(
					() => {
						this.#draining = false;
						this.#flush();
					},
					() => this.close(),
				);
				return;
			}
		} catch {
			this.close();
		}
	}

	#receive(chunk: Uint8Array): void {
		if (this.#closed) return;
		try {
			this.#decoder.push(chunk, value => {
				const reply = parseAuthDaemonDownPacket(value);
				if (reply && "event" in reply && this.#bound) {
					for (const listener of Array.from(this.#generationListeners)) notifyListener(listener);
					return !this.#closed;
				}
				if (!reply || "event" in reply) {
					this.close();
					return false;
				}
				const sent = this.#sent.get(reply.id);
				if (!sent || sent.binding !== (reply.type === "bound" || reply.type === "bind-error")) {
					this.close();
					return false;
				}
				if (reply.type === "bound") this.#bound = true;
				this.#sent.delete(reply.id);
				this.#sentBytes -= sent.bytes;
				this.#takePending(reply.id)?.resolve(reply);
				this.#flush();
				return !this.#closed;
			});
		} catch {
			this.close();
		}
	}
}

function tcpConfigured(): boolean {
	return Boolean(process.env[DAEMON_TCP_ENV]?.trim());
}

/** Undefined means native auth was unavailable before binding, not that the daemon rejected the configuration. */
export async function openAuthDaemonLink(binding: AuthDaemonBinding): Promise<AuthDaemonLink | undefined> {
	if (tcpConfigured()) return undefined;
	let daemon: DaemonClient;
	try {
		daemon = await daemonClient();
	} catch {
		return undefined;
	}
	if (tcpConfigured() || daemon.welcome.caps[AUTH_DAEMON_KIND] !== AUTH_DAEMON_VERSION) return undefined;
	const opened = await openTunnel(daemon, { kind: AUTH_DAEMON_KIND, key: AUTH_DAEMON_KEY, scope: GLOBAL_SCOPE }).catch(
		(error: unknown) => {
			if (error instanceof DaemonRejectedError) throw new AuthDaemonBindingError("transport");
			return undefined;
		},
	);
	if (!opened) return undefined;
	const { tunnel, lease } = opened;
	const release = (): void => {
		if (lease) void daemon.release(lease).catch(() => {});
	};
	if (tcpConfigured()) {
		tunnel.close();
		release();
		return undefined;
	}
	const link = new AuthTunnelLink(tunnel, release);
	try {
		await link.bind(binding);
		return link;
	} catch (error) {
		link.close();
		throw error;
	}
}
