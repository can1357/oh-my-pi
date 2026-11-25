/**
 * Loopback HTTP proxy that enforces the sandbox's hostname allowlist.
 *
 * Contained processes reach the network only through this proxy (MXC confines
 * their egress to it). Each client connection carries exactly one request head:
 * `CONNECT host:port` opens a tunnel, an absolute-URI `http://` request is
 * rewritten to origin form and forwarded. Everything the client sends after that
 * head is piped to the same, already-checked upstream; it is not parsed again.
 * There is no TLS interception: the destination name is the one on the CONNECT line.
 *
 * A refusal names its origin as far as the proxy can tell: the listener it arrived on (each
 * contained spawn gets its own, {@link EgressProxy.openListener}) and the `Proxy-Authorization:
 * Basic` credential the client sent. Neither is required; the credential is never logged, and it is
 * stripped from the request head the proxy parses. Bytes a client sends after that head (a pipelined
 * request on a plain-HTTP connection) are relayed unparsed, so a credential in them is forwarded.
 */
import { logger } from "@oh-my-pi/pi-utils";
import type { Socket, SocketHandler, TCPSocketListener } from "bun";
import { canonicalHost, hostAddressRefused, hostAdmission, hostLocalName, resolveHostAddresses } from "./policy";

/** Where a request came from. */
export interface EgressOrigin {
	/** Id of the listener ({@link EgressProxy.openListener}) the request arrived on; absent on the shared one. */
	listener?: string;
	/** Decoded `Proxy-Authorization: Basic` credentials (`user:password`) the request carried. */
	credential?: string;
}

export interface EgressProxyOptions {
	allowedHosts(): readonly string[];
	/**
	 * Asked for a host not on the list; absent → refuse. A `true` answers only the request that
	 * asked: concurrent requests for the host share a pending refusal, but ask again after an approval.
	 */
	decide?(host: string, port: number): Promise<boolean>;
	onBlocked?(host: string, port: number, origin: EgressOrigin): void;
	/** Milliseconds a client has to deliver a complete request head; established tunnels are never timed out. Default 30 000. */
	headTimeoutMs?: number;
}

/** Largest request head (request line + headers) the proxy buffers. */
const MAX_HEAD_BYTES = 64 * 1024;
/** Bytes a client may send past its request head before the upstream is connected. */
const MAX_EARLY_BYTES = 1024 * 1024;
const DEFAULT_HEAD_TIMEOUT_MS = 30_000;
/** Live client connections; further connections are closed on accept. */
const MAX_CONNECTIONS = 256;
/** Distinct hosts awaiting `decide` at once; further unknown hosts are blocked without asking. */
const MAX_PENDING_DECISIONS = 8;
const HEAD_TERMINATOR = "\r\n\r\n";
const CONNECT_ESTABLISHED = new TextEncoder().encode("HTTP/1.1 200 Connection Established\r\n\r\n");
const STATUS_TEXT: Record<number, string> = {
	400: "Bad Request",
	403: "Forbidden",
	431: "Request Header Fields Too Large",
	502: "Bad Gateway",
};
/** Hop-by-hop and proxy-only headers that are replaced when forwarding plain HTTP. */
const DROPPED_FORWARD_HEADERS: Record<string, true> = {
	host: true,
	connection: true,
	"proxy-connection": true,
	"proxy-authorization": true,
	"keep-alive": true,
};

// ── Request parsing ──────────────────────────────────────────────────────────

interface ConnectRequest {
	kind: "connect";
	host: string;
	port: number;
	credential?: string;
}
interface ForwardRequest {
	kind: "forward";
	host: string;
	port: number;
	credential?: string;
	/** Request head rewritten to origin form, terminator included. */
	head: Uint8Array;
}
type ParsedRequest = ConnectRequest | ForwardRequest | { kind: "invalid"; status: number; message: string };

/** A bare CR, a bare LF or a NUL anywhere in a head: parsers that tolerate them disagree on where lines end. */
const FORBIDDEN_HEAD_BYTES = /\r(?!\n)|(?<!\r)\n|\0/;
/** RFC 9110 §5.6.2 `token`. */
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

const REQUEST_LINE = /^([!#$%&'*+.^_`|~0-9A-Za-z-]+) (\S+) (HTTP\/1\.[01])$/;

function parsePort(text: string): number | undefined {
	if (!/^\d{1,5}$/.test(text)) return undefined;
	const port = Number(text);
	return port >= 1 && port <= 65535 ? port : undefined;
}

const BASIC_CREDENTIAL = /^basic\s+([A-Za-z0-9+/]+={0,2})\s*$/i;

/** The decoded credentials of a `Proxy-Authorization: Basic` header among `lines`; `undefined` for none or another scheme. */
function basicCredential(lines: readonly string[]): string | undefined {
	for (const line of lines) {
		const colon = line.indexOf(":");
		if (colon <= 0 || line.slice(0, colon).trim().toLowerCase() !== "proxy-authorization") continue;
		const match = BASIC_CREDENTIAL.exec(line.slice(colon + 1).trim());
		return match ? Buffer.from(match[1], "base64").toString("utf8") : undefined;
	}
	return undefined;
}

function parseRequestHead(head: string): ParsedRequest {
	if (FORBIDDEN_HEAD_BYTES.test(head)) {
		return { kind: "invalid", status: 400, message: "request head contains a bare CR, bare LF or NUL" };
	}
	const lines = head.split("\r\n");
	const match = REQUEST_LINE.exec(lines[0]);
	if (!match) return { kind: "invalid", status: 400, message: "malformed request line" };
	for (const line of lines.slice(1)) {
		const colon = line.indexOf(":");
		if (colon <= 0 || !HEADER_NAME.test(line.slice(0, colon))) {
			return { kind: "invalid", status: 400, message: "malformed header line" };
		}
	}
	const [, method, target, version] = match;
	const credential = basicCredential(lines.slice(1));

	if (method.toUpperCase() === "CONNECT") {
		const authority = /^(\[[^\]]+\]|[^:[\]]+):(\d+)$/.exec(target);
		const host = authority ? canonicalHost(authority[1]) : undefined;
		const port = authority ? parsePort(authority[2]) : undefined;
		if (host === undefined || port === undefined) {
			return { kind: "invalid", status: 400, message: "CONNECT target must be host:port" };
		}
		return { kind: "connect", host, port, credential };
	}

	if (!/^http:\/\//i.test(target)) {
		return { kind: "invalid", status: 400, message: "only CONNECT and absolute http:// requests are proxied" };
	}
	let url: URL;
	try {
		url = new URL(target);
	} catch {
		return { kind: "invalid", status: 400, message: "malformed request target" };
	}
	const host = canonicalHost(url.hostname);
	const port = url.port === "" ? 80 : parsePort(url.port);
	if (host === undefined || port === undefined)
		return { kind: "invalid", status: 400, message: "malformed request target" };

	const forwarded = [`${method} ${url.pathname}${url.search} ${version}`, `Host: ${url.host}`];
	for (const line of lines.slice(1)) {
		if (DROPPED_FORWARD_HEADERS[line.slice(0, line.indexOf(":")).toLowerCase()] === true) continue;
		forwarded.push(line);
	}
	forwarded.push("Connection: close", "", "");
	return { kind: "forward", host, port, credential, head: Buffer.from(forwarded.join("\r\n"), "latin1") };
}

// ── Policy ───────────────────────────────────────────────────────────────────

type Verdict =
	| { kind: "connect"; addresses: string[] }
	| { kind: "blocked" }
	| { kind: "unreachable"; message: string };

class EgressGate {
	readonly #options: EgressProxyOptions;
	readonly #pendingDecisions = new Map<string, Promise<boolean>>();

	constructor(options: EgressProxyOptions) {
		this.#options = options;
	}

	async evaluate(host: string, port: number, origin: EgressOrigin): Promise<Verdict> {
		// IP literals and host-local names must appear in the list verbatim, never via a wildcard or a prompt.
		const admission = hostAdmission(host, this.#options.allowedHosts());
		if (hostLocalName(host)) {
			if (admission !== "listed") return this.#block(host, port, origin);
		} else if (admission === "approved" && !(await this.#decide(host, port))) {
			return this.#block(host, port, origin);
		}

		let addresses: string[];
		try {
			addresses = await resolveHostAddresses(host);
		} catch (error) {
			logger.debug("sandbox egress proxy: DNS lookup failed", {
				host,
				error: String((error as Error).cause ?? error),
			});
			return { kind: "unreachable", message: `cannot resolve ${host}` };
		}
		if (hostAddressRefused(host, admission, addresses)) return this.#block(host, port, origin);
		return { kind: "connect", addresses };
	}

	/**
	 * Concurrent requests for one host wait for the pending answer. A refusal answers them all; an
	 * approval answers only the request that asked (it may be "this connection only"), so each waiter
	 * asks again, and a standing grant the approval recorded answers that without a prompt.
	 */
	async #decide(host: string, port: number): Promise<boolean> {
		const decide = this.#options.decide;
		if (!decide) return false;
		const pending = this.#pendingDecisions.get(host);
		if (pending) return (await pending) && this.#decide(host, port);
		if (this.#pendingDecisions.size >= MAX_PENDING_DECISIONS) return false;
		const ask = async (): Promise<boolean> => {
			try {
				return (await decide.call(this.#options, host, port)) === true;
			} catch (error) {
				logger.warn("sandbox egress proxy: host decision failed; refusing", { host, error: String(error) });
				return false;
			}
		};
		const decision = ask().finally(() => this.#pendingDecisions.delete(host));
		this.#pendingDecisions.set(host, decision);
		return decision;
	}

	#block(host: string, port: number, origin: EgressOrigin): Verdict {
		try {
			this.#options.onBlocked?.(host, port, origin);
		} catch (error) {
			logger.warn("sandbox egress proxy: onBlocked threw", { host, error: String(error) });
		}
		return { kind: "blocked" };
	}
}

// ── Connections ──────────────────────────────────────────────────────────────

type SocketSink = Pick<Socket<unknown>, "write" | "end" | "shutdown">;

/** Pending writes for one socket; `write` may accept fewer bytes than offered. */
class Outbox {
	#chunks: Uint8Array[] = [];
	#after: "shutdown" | "end" | undefined;

	get empty(): boolean {
		return this.#chunks.length === 0;
	}

	/** Writes `data`, queueing what the socket did not take. Returns false when the caller should pause its source. */
	send(socket: SocketSink, data: Uint8Array): boolean {
		if (this.#chunks.length === 0) {
			const written = Math.max(socket.write(data), 0);
			if (written === data.byteLength) return true;
			this.#chunks.push(data.slice(written));
		} else {
			this.#chunks.push(data.slice());
		}
		return false;
	}

	/** Called on `drain`. Returns true once everything queued has been written. */
	flush(socket: SocketSink): boolean {
		while (this.#chunks.length > 0) {
			const chunk = this.#chunks[0];
			const written = Math.max(socket.write(chunk), 0);
			if (written < chunk.byteLength) {
				this.#chunks[0] = chunk.subarray(written);
				return false;
			}
			this.#chunks.shift();
		}
		this.#finish(socket);
		return true;
	}

	/** Half-closes (`shutdown`) or ends the socket once the queue has drained. */
	close(socket: SocketSink, how: "shutdown" | "end"): void {
		if (this.#after !== "end") this.#after = how;
		if (this.#chunks.length === 0) this.#finish(socket);
	}

	#finish(socket: SocketSink): void {
		const after = this.#after;
		if (after === undefined) return;
		this.#after = undefined;
		if (after === "end") socket.end();
		else socket.shutdown(true);
	}
}

type Phase = "head" | "routing" | "open" | "closing" | "closed";

class ProxyConnection {
	readonly #client: Socket<ProxyConnection | undefined>;
	readonly #gate: EgressGate;
	readonly #listener: string | undefined;
	readonly #onDone: (connection: ProxyConnection) => void;
	#upstream: Socket<ProxyConnection> | undefined;
	#upstreamClosed = false;
	/** Whether any upstream bytes reached the client: a response head exists, so no 502 can follow. */
	#upstreamRelayed = false;
	#clientClosed = false;
	#clientEnded = false;
	#phase: Phase = "head";
	#head: Buffer | undefined;
	#request: ConnectRequest | ForwardRequest | undefined;
	#early: Uint8Array[] = [];
	#earlyBytes = 0;
	readonly #toClient = new Outbox();
	readonly #toUpstream = new Outbox();
	/** Cleared once the request head is complete: only clients that never finish their head are timed out. */
	readonly #headTimer: NodeJS.Timeout;

	constructor(
		client: Socket<ProxyConnection | undefined>,
		gate: EgressGate,
		listener: string | undefined,
		headTimeoutMs: number,
		onDone: (connection: ProxyConnection) => void,
	) {
		this.#client = client;
		this.#gate = gate;
		this.#listener = listener;
		this.#onDone = onDone;
		this.#headTimer = setTimeout(() => this.destroy(), headTimeoutMs);
	}

	clientData(chunk: Buffer): void {
		switch (this.#phase) {
			case "head":
				this.#readHead(chunk);
				return;
			case "routing":
				this.#earlyBytes += chunk.byteLength;
				if (this.#earlyBytes > MAX_EARLY_BYTES) {
					this.destroy();
					return;
				}
				this.#early.push(chunk.slice());
				return;
			case "open":
				if (this.#upstream && !this.#toUpstream.send(this.#upstream, chunk)) this.#client.pause();
				return;
			default:
				return;
		}
	}

	clientDrain(): void {
		if (this.#toClient.flush(this.#client)) this.#upstream?.resume();
	}

	clientEnd(): void {
		this.#clientEnded = true;
		// While routing, the half-close is forwarded once the upstream is attached.
		if (this.#phase === "routing") return;
		if (this.#phase === "open" && this.#upstream) this.#toUpstream.close(this.#upstream, "shutdown");
		else this.#finishClient();
	}

	clientClosed(): void {
		this.#clientClosed = true;
		this.#phase = "closed";
		clearTimeout(this.#headTimer);
		// Nobody is left to read the response: stop pulling it.
		this.#upstream?.terminate();
		this.#checkDone();
	}

	/** Upstream socket opened (called from the connect `open` handler, before any upstream data). */
	attachUpstream(upstream: Socket<ProxyConnection>): void {
		const request = this.#request;
		if (this.#phase !== "routing" || !request) {
			upstream.terminate();
			return;
		}
		this.#upstream = upstream;
		this.#phase = "open";
		if (request.kind === "connect") this.#toClient.send(this.#client, CONNECT_ESTABLISHED);
		else this.#toUpstream.send(upstream, request.head);
		for (const chunk of this.#early) this.#toUpstream.send(upstream, chunk);
		this.#early = [];
		this.#earlyBytes = 0;
		if (this.#toUpstream.empty) this.#client.resume();
		if (this.#clientEnded) this.#toUpstream.close(upstream, "shutdown");
	}

	upstreamData(chunk: Buffer): void {
		if (this.#clientClosed) return;
		this.#upstreamRelayed = true;
		if (!this.#toClient.send(this.#client, chunk)) this.#upstream?.pause();
	}

	upstreamDrain(): void {
		if (this.#upstream && this.#toUpstream.flush(this.#upstream)) this.#client.resume();
	}

	upstreamEnd(): void {
		if (this.#upstream) this.#toUpstream.close(this.#upstream, "end");
		this.#endClientAfterUpstream();
	}

	upstreamClosed(): void {
		this.#upstreamClosed = true;
		this.#endClientAfterUpstream();
		this.#checkDone();
	}

	/**
	 * The upstream is done (FIN or close). A plain request that got no response bytes from it is
	 * answered 502 instead of an empty reply. A CONNECT already answered 200, so its tunnel just ends.
	 */
	#endClientAfterUpstream(): void {
		const request = this.#request;
		if (this.#phase === "open" && request?.kind === "forward" && !this.#upstreamRelayed) {
			this.#refuse(502, `${request.host}:${request.port} closed the connection without a response`, false);
			return;
		}
		this.#finishClient();
	}

	/** Ends both sides immediately. */
	destroy(): void {
		this.#phase = "closed";
		clearTimeout(this.#headTimer);
		this.#upstream?.terminate();
		this.#client.terminate();
	}

	/**
	 * Ends the client once everything queued for it is written (Bun releases the socket on `end()`,
	 * even when the peer keeps its side open). Later client bytes are discarded.
	 */
	#finishClient(): void {
		if (this.#phase === "closing" || this.#phase === "closed") return;
		this.#phase = "closing";
		this.#early = [];
		this.#toClient.close(this.#client, "end");
	}

	#checkDone(): void {
		if (this.#clientClosed && (this.#upstream === undefined || this.#upstreamClosed)) this.#onDone(this);
	}

	#readHead(chunk: Buffer): void {
		const buffered = this.#head ? Buffer.concat([this.#head, chunk]) : Buffer.from(chunk);
		const searchFrom = this.#head ? Math.max(0, this.#head.byteLength - (HEAD_TERMINATOR.length - 1)) : 0;
		const end = buffered.indexOf(HEAD_TERMINATOR, searchFrom, "latin1");
		if (end === -1) {
			if (buffered.byteLength > MAX_HEAD_BYTES) {
				this.#refuse(431, "request head too large", false);
				return;
			}
			this.#head = buffered;
			return;
		}
		this.#head = undefined;
		clearTimeout(this.#headTimer);
		if (end > MAX_HEAD_BYTES) {
			this.#refuse(431, "request head too large", false);
			return;
		}
		const parsed = parseRequestHead(buffered.toString("latin1", 0, end));
		if (parsed.kind === "invalid") {
			this.#refuse(parsed.status, parsed.message, false);
			return;
		}
		const rest = buffered.subarray(end + HEAD_TERMINATOR.length);
		if (rest.byteLength > 0) {
			this.#early.push(rest);
			this.#earlyBytes = rest.byteLength;
		}
		this.#request = parsed;
		this.#phase = "routing";
		this.#client.pause();
		void this.#route(parsed);
	}

	async #route(request: ConnectRequest | ForwardRequest): Promise<void> {
		try {
			const origin: EgressOrigin = {};
			if (this.#listener !== undefined) origin.listener = this.#listener;
			if (request.credential !== undefined) origin.credential = request.credential;
			const verdict = await this.#gate.evaluate(request.host, request.port, origin);
			if (this.#phase !== "routing") return;
			if (verdict.kind === "blocked") {
				this.#refuse(403, `omp sandbox: egress to ${request.host}:${request.port} is not allowed`, true);
				return;
			}
			if (verdict.kind === "unreachable") {
				this.#refuse(502, verdict.message, false);
				return;
			}
			let lastError: unknown;
			for (const address of verdict.addresses) {
				try {
					await Bun.connect<ProxyConnection>({
						hostname: address,
						port: request.port,
						data: this,
						allowHalfOpen: true,
						socket: UPSTREAM_HANDLERS,
					});
					return;
				} catch (error) {
					lastError = error;
					if (this.#phase !== "routing") return;
				}
			}
			logger.debug("sandbox egress proxy: upstream connect failed", {
				host: request.host,
				port: request.port,
				error: String(lastError),
			});
			this.#refuse(502, `cannot connect to ${request.host}:${request.port}`, false);
		} catch (error) {
			logger.warn("sandbox egress proxy: routing failed", { host: request.host, error: String(error) });
			if (this.#phase === "routing") this.#refuse(502, "egress proxy error", false);
		}
	}

	#refuse(status: number, message: string, blocked: boolean): void {
		clearTimeout(this.#headTimer);
		const body = `${message}\n`;
		const lines = [`HTTP/1.1 ${status} ${STATUS_TEXT[status]}`];
		if (blocked) lines.push("X-Omp-Sandbox: blocked");
		lines.push(
			"Content-Type: text/plain; charset=utf-8",
			`Content-Length: ${Buffer.byteLength(body)}`,
			"Connection: close",
			"",
			body,
		);
		this.#toClient.send(this.#client, Buffer.from(lines.join("\r\n")));
		this.#finishClient();
	}
}

const CLIENT_HANDLERS: SocketHandler<ProxyConnection | undefined> = {
	data(socket, chunk) {
		socket.data?.clientData(chunk);
	},
	drain(socket) {
		socket.data?.clientDrain();
	},
	end(socket) {
		if (socket.data) socket.data.clientEnd();
		else socket.end();
	},
	close(socket) {
		socket.data?.clientClosed();
	},
	error(_socket, error) {
		logger.debug("sandbox egress proxy: client socket error", { error: String(error) });
	},
};

const UPSTREAM_HANDLERS: SocketHandler<ProxyConnection> = {
	open(socket) {
		socket.data.attachUpstream(socket);
	},
	data(socket, chunk) {
		socket.data.upstreamData(chunk);
	},
	drain(socket) {
		socket.data.upstreamDrain();
	},
	end(socket) {
		socket.data.upstreamEnd();
	},
	close(socket) {
		socket.data.upstreamClosed();
	},
	connectError() {
		// The awaiting `Bun.connect` call rejects and tries the next address.
	},
	error(_socket, error) {
		logger.debug("sandbox egress proxy: upstream socket error", { error: String(error) });
	},
};

// ── Proxy ────────────────────────────────────────────────────────────────────

/** An extra listening port of an {@link EgressProxy}: the same policy, its requests tagged with `id`. */
export interface EgressListener {
	readonly id: string;
	readonly url: string;
	readonly port: number;
	/**
	 * Stops tagging new connections with {@link id} (they count as the shared port's) but keeps the
	 * port bound until the proxy closes: a sandbox allows its processes that exact port for life, so
	 * a released port could go to another local service those processes would then reach. For the
	 * spawn's exit; leftover processes keep their network. Idempotent.
	 */
	retire(): void;
	/** Stops accepting connections; established ones go on until the proxy closes. Idempotent. */
	close(): void;
}

export class EgressProxy {
	readonly url: string;
	readonly port: number;
	readonly #listen: (tag: { id: string | undefined }) => TCPSocketListener<ProxyConnection | undefined>;
	readonly #listener: TCPSocketListener<ProxyConnection | undefined>;
	readonly #extra = new Set<TCPSocketListener<ProxyConnection | undefined>>();
	readonly #connections: Set<ProxyConnection>;
	#closed = false;

	private constructor(
		listen: (tag: { id: string | undefined }) => TCPSocketListener<ProxyConnection | undefined>,
		connections: Set<ProxyConnection>,
	) {
		this.#listen = listen;
		this.#listener = listen({ id: undefined });
		this.#connections = connections;
		this.port = this.#listener.port;
		this.url = `http://127.0.0.1:${this.#listener.port}`;
	}

	static async start(options: EgressProxyOptions): Promise<EgressProxy> {
		const gate = new EgressGate(options);
		const headTimeoutMs = options.headTimeoutMs ?? DEFAULT_HEAD_TIMEOUT_MS;
		const connections = new Set<ProxyConnection>();
		const done = (connection: ProxyConnection): void => {
			connections.delete(connection);
		};
		// `tag` is read per connection: a retired listener's new connections are untagged.
		const listen = (tag: { id: string | undefined }) =>
			Bun.listen<ProxyConnection | undefined>({
				hostname: "127.0.0.1",
				port: 0,
				allowHalfOpen: true,
				socket: {
					...CLIENT_HANDLERS,
					open(socket) {
						if (connections.size >= MAX_CONNECTIONS) {
							socket.terminate();
							return;
						}
						const connection = new ProxyConnection(socket, gate, tag.id, headTimeoutMs, done);
						connections.add(connection);
						socket.data = connection;
					},
				},
			});
		return new EgressProxy(listen, connections);
	}

	/**
	 * Opens another port onto this proxy whose refusals carry `id` as their origin's `listener`;
	 * its connections share the proxy's policy, pending decisions and connection cap.
	 */
	openListener(id: string): EgressListener {
		if (this.#closed) throw new Error("egress proxy is closed");
		const tag: { id: string | undefined } = { id };
		const listener = this.#listen(tag);
		this.#extra.add(listener);
		const extra = this.#extra;
		return {
			id,
			port: listener.port,
			url: `http://127.0.0.1:${listener.port}`,
			retire() {
				tag.id = undefined;
			},
			close() {
				if (!extra.delete(listener)) return;
				listener.stop(false);
			},
		};
	}

	/** Stops accepting connections on every port and ends every live tunnel. Idempotent. */
	async close(): Promise<void> {
		this.#closed = true;
		this.#listener.stop(true);
		for (const listener of this.#extra) listener.stop(true);
		this.#extra.clear();
		const live = [...this.#connections];
		this.#connections.clear();
		for (const connection of live) connection.destroy();
	}
}
