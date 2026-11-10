/**
 * Loopback HTTP proxy that enforces the sandbox's hostname allowlist.
 *
 * Contained processes reach the network only through this proxy (MXC confines
 * their egress to it). Each client connection carries exactly one request head:
 * `CONNECT host:port` opens a tunnel, an absolute-URI `http://` request is
 * rewritten to origin form and forwarded. Everything the client sends after that
 * head is piped to the same, already-checked upstream; it is not parsed again.
 * There is no TLS interception: the destination name is the one on the CONNECT line.
 */
import { logger } from "@oh-my-pi/pi-utils";
import type { Socket, SocketHandler, TCPSocketListener } from "bun";
import { hostMatches } from "./policy";

export interface EgressProxyOptions {
	allowedHosts(): readonly string[];
	/** Asked for a host not on the list; absent → refuse. Concurrent asks for one host share a single call. */
	decide?(host: string, port: number): Promise<boolean>;
	onBlocked?(host: string, port: number): void;
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

// ── Host matching ────────────────────────────────────────────────────────────

/**
 * Canonical form of a bare host (name, IPv4 or IPv6, brackets optional): lower-case,
 * IDNA/IPv4/IPv6 normalized by the WHATWG URL parser, trailing dot removed.
 * `undefined` when the value is not a valid bare host.
 */
function canonicalHost(raw: string): string | undefined {
	const value = raw.trim();
	if (value === "" || /[/?#@\\\s]/.test(value)) return undefined;
	const bracketed = value.startsWith("[") ? value : value.includes(":") ? `[${value}]` : value;
	let url: URL;
	try {
		url = new URL(`http://${bracketed}/`);
	} catch {
		return undefined;
	}
	if (url.port !== "") return undefined;
	let host = url.hostname;
	if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
	while (host.endsWith(".")) host = host.slice(0, -1);
	return host === "" ? undefined : host;
}

function normalizeHost(raw: string): string {
	const canonical = canonicalHost(raw);
	if (canonical !== undefined) return canonical;
	let host = raw.trim().toLowerCase();
	if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
	while (host.endsWith(".")) host = host.slice(0, -1);
	return host;
}

// ── Address classification ───────────────────────────────────────────────────

function parseIPv4(value: string): number[] | undefined {
	const parts = value.split(".");
	if (parts.length !== 4) return undefined;
	const octets: number[] = [];
	for (const part of parts) {
		if (!/^\d{1,3}$/.test(part)) return undefined;
		const octet = Number(part);
		if (octet > 255) return undefined;
		octets.push(octet);
	}
	return octets;
}

function parseIPv6(value: string): number[] | undefined {
	let text = value;
	const zone = text.indexOf("%");
	if (zone !== -1) text = text.slice(0, zone);
	if (!text.includes(":")) return undefined;
	// An embedded dotted IPv4 tail (`::ffff:1.2.3.4`) becomes two hex groups.
	const lastColon = text.lastIndexOf(":");
	const tail = text.slice(lastColon + 1);
	if (tail.includes(".")) {
		const v4 = parseIPv4(tail);
		if (!v4) return undefined;
		text = `${text.slice(0, lastColon + 1)}${((v4[0] << 8) | v4[1]).toString(16)}:${((v4[2] << 8) | v4[3]).toString(16)}`;
	}
	const parseGroups = (part: string): number[] | undefined => {
		if (part === "") return [];
		const groups: number[] = [];
		for (const group of part.split(":")) {
			if (!/^[0-9a-f]{1,4}$/i.test(group)) return undefined;
			groups.push(Number.parseInt(group, 16));
		}
		return groups;
	};
	const gap = text.indexOf("::");
	if (gap === -1) {
		const groups = parseGroups(text);
		return groups?.length === 8 ? groups : undefined;
	}
	if (text.indexOf("::", gap + 1) !== -1) return undefined;
	const head = parseGroups(text.slice(0, gap));
	const rest = parseGroups(text.slice(gap + 2));
	if (!head || !rest || head.length + rest.length >= 8) return undefined;
	return [...head, ...Array.from({ length: 8 - head.length - rest.length }, () => 0), ...rest];
}

function isPublicIPv4([a, b, c]: number[]): boolean {
	if (a === 0 || a === 10 || a === 127 || a >= 224) return false; // this-network, private, loopback, multicast/reserved
	if (a === 100 && b >= 64 && b <= 127) return false; // carrier-grade NAT
	if (a === 169 && b === 254) return false; // link-local
	if (a === 172 && b >= 16 && b <= 31) return false; // private
	if (a === 192 && b === 168) return false; // private
	if (a === 192 && b === 0 && c === 0) return false; // IETF protocol assignments
	if (a === 198 && (b === 18 || b === 19)) return false; // benchmarking
	return true;
}

function embeddedIPv4(high: number, low: number): number[] {
	return [high >> 8, high & 0xff, low >> 8, low & 0xff];
}

/** False for loopback, private, link-local, unspecified, multicast and reserved addresses. */
function isPublicAddress(address: string): boolean {
	const v4 = parseIPv4(address);
	if (v4) return isPublicIPv4(v4);
	const v6 = parseIPv6(address);
	if (!v6) return false;
	const [g0, g1, g2, g3, g4, g5, g6, g7] = v6;
	const zeroPrefix = g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0;
	// ::/96 (unspecified, loopback, IPv4-compatible) and ::ffff:0:0/96 (IPv4-mapped)
	if (zeroPrefix && (g5 === 0 || g5 === 0xffff)) return isPublicIPv4(embeddedIPv4(g6, g7));
	// NAT64 well-known prefix
	if (g0 === 0x64 && g1 === 0xff9b && g2 === 0 && g3 === 0 && g4 === 0 && g5 === 0) {
		return isPublicIPv4(embeddedIPv4(g6, g7));
	}
	if (g0 === 0x2002) return isPublicIPv4(embeddedIPv4(g1, g2)); // 6to4
	if ((g0 & 0xfe00) === 0xfc00) return false; // unique local
	if ((g0 & 0xffc0) === 0xfe80 || (g0 & 0xffc0) === 0xfec0) return false; // link-local, site-local
	if ((g0 & 0xff00) === 0xff00) return false; // multicast
	return true;
}

/** True for loopback (127/8, ::1), unspecified (0/8, ::) and link-local (169.254/16, fe80::/10), IPv4-mapped forms included. */
function isHostLocalAddress(address: string): boolean {
	let v4 = parseIPv4(address);
	if (!v4) {
		const v6 = parseIPv6(address);
		if (!v6) return true;
		const [g0, g1, g2, g3, g4, g5, g6, g7] = v6;
		if ((g0 & 0xffc0) === 0xfe80) return true;
		// ::/96 (covers :: and ::1) and ::ffff:0:0/96 carry an IPv4 address in the low 32 bits.
		if (g0 !== 0 || g1 !== 0 || g2 !== 0 || g3 !== 0 || g4 !== 0 || (g5 !== 0 && g5 !== 0xffff)) return false;
		v4 = embeddedIPv4(g6, g7);
	}
	const [a, b] = v4;
	return a === 0 || a === 127 || (a === 169 && b === 254);
}

// ── Request parsing ──────────────────────────────────────────────────────────

interface ConnectRequest {
	kind: "connect";
	host: string;
	port: number;
}
interface ForwardRequest {
	kind: "forward";
	host: string;
	port: number;
	/** Request head rewritten to origin form, terminator included. */
	head: Uint8Array;
}
type ParsedRequest = ConnectRequest | ForwardRequest | { kind: "invalid"; status: number; message: string };

const REQUEST_LINE = /^([!#$%&'*+.^_`|~0-9A-Za-z-]+) (\S+) (HTTP\/1\.[01])$/;

function parsePort(text: string): number | undefined {
	if (!/^\d{1,5}$/.test(text)) return undefined;
	const port = Number(text);
	return port >= 1 && port <= 65535 ? port : undefined;
}

function parseRequestHead(head: string): ParsedRequest {
	const lines = head.split("\r\n");
	const match = REQUEST_LINE.exec(lines[0]);
	if (!match) return { kind: "invalid", status: 400, message: "malformed request line" };
	const [, method, target, version] = match;

	if (method.toUpperCase() === "CONNECT") {
		const authority = /^(\[[^\]]+\]|[^:[\]]+):(\d+)$/.exec(target);
		const host = authority ? canonicalHost(authority[1]) : undefined;
		const port = authority ? parsePort(authority[2]) : undefined;
		if (host === undefined || port === undefined) {
			return { kind: "invalid", status: 400, message: "CONNECT target must be host:port" };
		}
		return { kind: "connect", host, port };
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
		if (line === "") continue;
		const colon = line.indexOf(":");
		if (colon <= 0) return { kind: "invalid", status: 400, message: "malformed header line" };
		if (DROPPED_FORWARD_HEADERS[line.slice(0, colon).trim().toLowerCase()] === true) continue;
		forwarded.push(line);
	}
	forwarded.push("Connection: close", "", "");
	return { kind: "forward", host, port, head: Buffer.from(forwarded.join("\r\n"), "latin1") };
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

	async evaluate(host: string, port: number): Promise<Verdict> {
		const patterns = this.#options.allowedHosts();
		// IP literals and host-local names must appear in the list verbatim, never via a wildcard or a prompt.
		const literal = patterns.some(pattern => !pattern.trim().startsWith("*.") && normalizeHost(pattern) === host);
		let approved = false;
		const ipLiteral = parseIPv4(host) !== undefined || parseIPv6(host) !== undefined;
		if (ipLiteral || host === "localhost" || host.endsWith(".localhost")) {
			if (!literal) return this.#block(host, port);
		} else if (!hostMatches(host, patterns)) {
			if (!(await this.#decide(host, port))) return this.#block(host, port);
			approved = true;
		}

		let addresses: string[];
		if (ipLiteral) {
			addresses = [host];
		} else {
			try {
				addresses = [...new Set((await Bun.dns.lookup(host)).map(record => record.address))];
			} catch (error) {
				logger.debug("sandbox egress proxy: DNS lookup failed", { host, error: String(error) });
				return { kind: "unreachable", message: `cannot resolve ${host}` };
			}
			if (addresses.length === 0) return { kind: "unreachable", message: `cannot resolve ${host}` };
		}
		// An exactly-listed name may resolve anywhere. A prompt-approved name may reach private ranges
		// (intranet services) but never loopback, unspecified or link-local addresses: the prompt cannot
		// show where the name points. A wildcard-matched name must resolve to public addresses only.
		const refused = literal
			? false
			: approved
				? addresses.some(isHostLocalAddress)
				: addresses.some(address => !isPublicAddress(address));
		if (refused) return this.#block(host, port);
		return { kind: "connect", addresses };
	}

	#decide(host: string, port: number): Promise<boolean> {
		const decide = this.#options.decide;
		if (!decide) return Promise.resolve(false);
		const pending = this.#pendingDecisions.get(host);
		if (pending) return pending;
		if (this.#pendingDecisions.size >= MAX_PENDING_DECISIONS) return Promise.resolve(false);
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

	#block(host: string, port: number): Verdict {
		try {
			this.#options.onBlocked?.(host, port);
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
	readonly #onDone: (connection: ProxyConnection) => void;
	#upstream: Socket<ProxyConnection> | undefined;
	#upstreamClosed = false;
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
		headTimeoutMs: number,
		onDone: (connection: ProxyConnection) => void,
	) {
		this.#client = client;
		this.#gate = gate;
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
		if (!this.#toClient.send(this.#client, chunk)) this.#upstream?.pause();
	}

	upstreamDrain(): void {
		if (this.#upstream && this.#toUpstream.flush(this.#upstream)) this.#client.resume();
	}

	upstreamEnd(): void {
		if (this.#upstream) this.#toUpstream.close(this.#upstream, "end");
		this.#finishClient();
	}

	upstreamClosed(): void {
		this.#upstreamClosed = true;
		this.#finishClient();
		this.#checkDone();
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
			await this.#routeTo(request);
		} catch (error) {
			logger.warn("sandbox egress proxy: routing failed", { host: request.host, error: String(error) });
			if (this.#phase === "routing") this.#refuse(502, "egress proxy error", false);
		}
	}

	async #routeTo(request: ConnectRequest | ForwardRequest): Promise<void> {
		const verdict = await this.#gate.evaluate(request.host, request.port);
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
	}

	#refuse(status: number, message: string, blocked: boolean): void {
		clearTimeout(this.#headTimer);
		const body = `${message}\n`;
		const lines = [`HTTP/1.1 ${status} ${STATUS_TEXT[status] ?? "Error"}`];
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

export class EgressProxy {
	readonly url: string;
	readonly port: number;
	readonly #listener: TCPSocketListener<ProxyConnection | undefined>;
	readonly #connections: Set<ProxyConnection>;
	#closing: Promise<void> | undefined;

	private constructor(listener: TCPSocketListener<ProxyConnection | undefined>, connections: Set<ProxyConnection>) {
		this.#listener = listener;
		this.#connections = connections;
		this.port = listener.port;
		this.url = `http://127.0.0.1:${listener.port}`;
	}

	static async start(options: EgressProxyOptions): Promise<EgressProxy> {
		const gate = new EgressGate(options);
		const headTimeoutMs = options.headTimeoutMs ?? DEFAULT_HEAD_TIMEOUT_MS;
		const connections = new Set<ProxyConnection>();
		const done = (connection: ProxyConnection): void => {
			connections.delete(connection);
		};
		const listener = Bun.listen<ProxyConnection | undefined>({
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
					const connection = new ProxyConnection(socket, gate, headTimeoutMs, done);
					connections.add(connection);
					socket.data = connection;
				},
			},
		});
		return new EgressProxy(listener, connections);
	}

	/** Stops accepting connections and ends every live tunnel. Idempotent. */
	close(): Promise<void> {
		this.#closing ??= this.#close();
		return this.#closing;
	}

	async #close(): Promise<void> {
		this.#listener.stop(true);
		const live = [...this.#connections];
		this.#connections.clear();
		for (const connection of live) connection.destroy();
	}
}
