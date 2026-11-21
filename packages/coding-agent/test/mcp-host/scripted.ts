/**
 * Scripted stand-ins for the MCP host's surroundings: an `McpUpstreams` whose
 * peers the test drives (pid, results, notifications, exit) and a session-side
 * link that speaks raw tunnel JSON-RPC.
 */
import type { ModuleTunnel } from "@oh-my-pi/pi-coding-agent/daemon/module";
import { createMCPJsonRpcError, MCPTransportError } from "@oh-my-pi/pi-coding-agent/mcp/errors";
import {
	encodeJsonLine,
	JsonLineDecoder,
	MCP_STATUS_METHOD,
	type McpEra,
	type McpServerSpec,
	type McpStdioSpec,
	type McpTunnel,
	type McpUpstreamExit,
} from "@oh-my-pi/pi-coding-agent/mcp/host/contract";
import { McpEndpoint } from "@oh-my-pi/pi-coding-agent/mcp/host/endpoint";
import type {
	McpPeer,
	McpPeerDeps,
	McpPeerRequestOptions,
	McpPeerSubscription,
	McpProbeResult,
	McpUpstreams,
} from "@oh-my-pi/pi-coding-agent/mcp/host/peer";
import type { McpStore } from "@oh-my-pi/pi-coding-agent/mcp/host/store";
import { MCP_PROTOCOL_VERSION, type MCPSubscriptionFilter, requestMeta } from "@oh-my-pi/pi-coding-agent/mcp/protocol";

export type Message = Record<string, unknown>;
export type Handler = (
	method: string,
	params: Record<string, unknown>,
	options: McpPeerRequestOptions,
) => Promise<Record<string, unknown>> | Record<string, unknown>;

/** Returns a result to answer the request itself, undefined to fall through to the built-in catalog. */
export type ScriptedHandler = (
	method: string,
	params: Record<string, unknown>,
	options: McpPeerRequestOptions,
) => Promise<Record<string, unknown> | undefined> | Record<string, unknown> | undefined;

const WAIT_MS = 2_000;

/** Microtask turns tried before polling on the clock: enough for anything the in-memory tunnels carry. */
const MICROTASK_TURNS = 500;

/**
 * Resolve once `condition` holds; fail the test when it never does. Work that
 * needs no timer settles within the microtask turns, so this also works under
 * fake timers.
 */
export async function until(condition: () => boolean, label: string): Promise<void> {
	for (let turn = 0; turn < MICROTASK_TURNS && !condition(); turn++) await Promise.resolve();
	const deadline = Date.now() + WAIT_MS;
	while (!condition()) {
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
		await Bun.sleep(2);
	}
}

/** Let everything that needs no timer run. */
export async function settle(): Promise<void> {
	for (let turn = 0; turn < MICROTASK_TURNS; turn++) await Promise.resolve();
}

export function stdioSpec(command: string, timeoutMs = 0): McpStdioSpec {
	return { transport: "stdio", command, args: [], cwd: "/", env: {}, spawnEnv: {}, timeoutMs };
}

/** Wait for `gate`, leaving with the abort reason (after `onAbort`) when `signal` aborts first. */
async function gated(
	gate: Promise<void> | undefined,
	signal: AbortSignal | undefined,
	onAbort: () => void,
): Promise<void> {
	if (!signal) {
		await gate;
		return;
	}
	const aborted = Promise.withResolvers<never>();
	const listener = () => {
		onAbort();
		aborted.reject(signal.reason);
	};
	if (signal.aborted) listener();
	else signal.addEventListener("abort", listener, { once: true });
	try {
		await Promise.race([gate ?? Promise.resolve(), aborted.promise]);
	} finally {
		signal.removeEventListener("abort", listener);
	}
}

function upstreamClosed(): MCPTransportError {
	return new MCPTransportError({
		transport: "stdio",
		stage: "receive",
		failure: "closed",
		message: "upstream closed",
		retryable: false,
	});
}

export class FakeListen implements McpPeerSubscription {
	readonly acknowledged: MCPSubscriptionFilter;
	readonly ended: Promise<void>;
	readonly meta: Record<string, unknown>;
	readonly sink: (method: string, params: Record<string, unknown>) => void;
	open = true;
	readonly #end = Promise.withResolvers<void>();

	constructor(
		filter: MCPSubscriptionFilter,
		meta: Record<string, unknown>,
		sink: (method: string, params: Record<string, unknown>) => void,
	) {
		this.acknowledged = filter;
		this.meta = meta;
		this.sink = sink;
		this.ended = this.#end.promise;
	}

	close(): void {
		this.open = false;
		this.#end.resolve();
	}
}

export class FakePeer implements McpPeer {
	readonly era: McpEra;
	readonly pid: number;
	readonly closed: Promise<McpUpstreamExit>;
	readonly calls: { method: string; params: Record<string, unknown> }[] = [];
	/** Methods whose request the endpoint aborted. */
	readonly aborted: string[] = [];
	readonly listens: FakeListen[] = [];
	readonly closeReasons: string[] = [];
	/** Holds back the acknowledgement of every resource subscription until it resolves. */
	listenGate: Promise<void> | undefined;
	/** `listen` calls waiting at {@link listenGate}. */
	pendingListens = 0;
	/** `listen` calls the endpoint aborted before their acknowledgement. */
	abortedListens = 0;
	/** Holds back the process's exit after `close` until it resolves. */
	closeGate: Promise<void> | undefined;
	gone = false;
	readonly #handler: Handler;
	readonly #exit = Promise.withResolvers<McpUpstreamExit>();
	readonly #pending = new Set<(error: Error) => void>();

	constructor(era: McpEra, pid: number, handler: Handler) {
		this.era = era;
		this.pid = pid;
		this.#handler = handler;
		this.closed = this.#exit.promise;
	}

	count(method: string): number {
		return this.calls.filter(call => call.method === method).length;
	}

	async request(
		method: string,
		params: Record<string, unknown>,
		options: McpPeerRequestOptions = {},
	): Promise<Record<string, unknown>> {
		if (this.gone) throw upstreamClosed();
		this.calls.push({ method, params });
		const lost = Promise.withResolvers<never>();
		lost.promise.catch(() => {});
		this.#pending.add(lost.reject);
		const signal = options.signal;
		const onAbort = () => {
			this.aborted.push(method);
			lost.reject(signal?.reason);
		};
		signal?.addEventListener("abort", onAbort, { once: true });
		try {
			return await Promise.race([
				Promise.resolve().then(() => this.#handler(method, params, options)),
				lost.promise,
			]);
		} finally {
			this.#pending.delete(lost.reject);
			signal?.removeEventListener("abort", onAbort);
		}
	}

	async listen(
		filter: MCPSubscriptionFilter,
		meta: Record<string, unknown>,
		sink: (method: string, params: Record<string, unknown>) => void,
		signal?: AbortSignal,
	): Promise<McpPeerSubscription> {
		if (this.gone) throw upstreamClosed();
		this.pendingListens++;
		try {
			await gated(filter.resourceSubscriptions ? this.listenGate : undefined, signal, () => this.abortedListens++);
		} finally {
			this.pendingListens--;
		}
		if (this.gone) throw upstreamClosed();
		const listen = new FakeListen(filter, meta, sink);
		this.listens.push(listen);
		return listen;
	}

	/** The process went away on its own. */
	exit(exit: McpUpstreamExit): void {
		if (this.gone) return;
		this.gone = true;
		for (const reject of this.#pending) reject(upstreamClosed());
		for (const listen of this.listens) listen.close();
		this.#exit.resolve(exit);
	}

	async close(reason: string): Promise<void> {
		this.closeReasons.push(reason);
		await this.closeGate;
		this.exit({ signal: 15, stderr: "" });
	}

	snapshot(): undefined {
		return undefined;
	}
}

/** A server whose catalog, timing and failures the test sets. */
export class ScriptedUpstreams implements McpUpstreams {
	readonly peers: FakePeer[] = [];
	tools: string[] = ["alpha"];
	ttlMs = 60_000;
	capabilities: Record<string, unknown> = { tools: { listChanged: true }, resources: { subscribe: true } };
	/** Overrides the built-in catalog for the methods it returns a result for. */
	handler: ScriptedHandler | undefined;
	startError: MCPTransportError | undefined;
	startGate: Promise<void> | undefined;
	/** A start that only notices its abort once {@link startGate} opens, like a spawn that cannot be interrupted. */
	startIgnoresAbort = false;
	startAttempts = 0;
	/** Starts the endpoint aborted while they waited at {@link startGate}. */
	startAborts = 0;
	probes = 0;
	probeGate: Promise<void> | undefined;
	/** A probe that only notices its abort once {@link probeGate} opens. */
	probeIgnoresAbort = false;
	/** Probes aborted while they waited at {@link probeGate}. */
	probeAborts = 0;
	/** Given to every peer started from here on. */
	listenGate: Promise<void> | undefined;
	closeGate: Promise<void> | undefined;
	probeResult: McpProbeResult = { era: "modern" };
	/** What the endpoint handed the latest start. */
	deps: McpPeerDeps | undefined;
	#nextPid = 4_000;

	get last(): FakePeer {
		const peer = this.peers.at(-1);
		if (!peer) throw new Error("no upstream was started");
		return peer;
	}

	count(method: string): number {
		let total = 0;
		for (const peer of this.peers) total += peer.count(method);
		return total;
	}

	discoverResult(): Record<string, unknown> {
		return {
			resultType: "complete",
			supportedVersions: [MCP_PROTOCOL_VERSION],
			capabilities: this.capabilities,
			ttlMs: this.ttlMs,
			cacheScope: "private",
		};
	}

	async probe(_spec: McpServerSpec, _deps: McpPeerDeps, signal?: AbortSignal): Promise<McpProbeResult> {
		this.probes++;
		await gated(this.probeGate, this.probeIgnoresAbort ? undefined : signal, () => this.probeAborts++);
		return this.probeResult;
	}

	async start(_spec: McpServerSpec, era: McpEra, deps: McpPeerDeps, signal?: AbortSignal): Promise<McpPeer> {
		this.startAttempts++;
		this.deps = deps;
		await gated(this.startGate, this.startIgnoresAbort ? undefined : signal, () => this.startAborts++);
		if (this.startError) throw this.startError;
		const peer = new FakePeer(era, this.#nextPid++, (method, params, options) =>
			this.#answer(method, params, options),
		);
		peer.listenGate = this.listenGate;
		peer.closeGate = this.closeGate;
		this.peers.push(peer);
		return peer;
	}

	restore(): undefined {
		return undefined;
	}

	async #answer(
		method: string,
		params: Record<string, unknown>,
		options: McpPeerRequestOptions,
	): Promise<Record<string, unknown>> {
		const scripted = await this.handler?.(method, params, options);
		if (scripted) return scripted;
		switch (method) {
			case "server/discover":
				return this.discoverResult();
			case "tools/list":
				return {
					resultType: "complete",
					tools: this.tools.map(name => ({ name, inputSchema: { type: "object" } })),
					ttlMs: this.ttlMs,
					cacheScope: "private",
				};
			case "tools/call":
				if (!this.tools.includes(String(params.name))) {
					throw createMCPJsonRpcError("stdio", { code: -32602, message: `Unknown tool: ${String(params.name)}` });
				}
				return { resultType: "complete", content: [{ type: "text", text: JSON.stringify(params.arguments) }] };
			default:
				throw createMCPJsonRpcError("stdio", { code: -32601, message: `Method not found: ${method}` });
		}
	}
}

/** The session end of a tunnel: sends raw requests, collects everything the host writes. */
export class TestLink {
	readonly messages: Message[] = [];
	closed = false;
	readonly #decoder = new JsonLineDecoder();
	readonly #write: (line: string) => void;
	readonly #close: () => void;

	constructor(write: (line: string) => void, close: () => void) {
		this.#write = write;
		this.#close = close;
	}

	receive(chunk: Uint8Array): void {
		for (const line of this.#decoder.push(chunk)) this.messages.push(JSON.parse(line));
	}

	raw(message: unknown): void {
		this.#write(encodeJsonLine(message));
	}

	request(id: string | number, method: string, params: Record<string, unknown> = {}, meta: Message = {}): void {
		this.raw({ jsonrpc: "2.0", id, method, params: { ...params, _meta: { ...requestMeta(), ...meta } } });
	}

	notify(method: string, params: Record<string, unknown> = {}): void {
		this.raw({ jsonrpc: "2.0", method, params });
	}

	/** The first message matching `predicate`, waiting for it to arrive. */
	async next(predicate: (message: Message) => boolean, label: string): Promise<Message> {
		let found: Message | undefined;
		await until(() => {
			found = this.messages.find(predicate);
			return found !== undefined;
		}, label);
		if (!found) throw new Error(`no message: ${label}`);
		return found;
	}

	response(id: string | number): Promise<Message> {
		return this.next(message => message.id === id && message.method === undefined, `response ${id}`);
	}

	async call(id: string | number, method: string, params?: Record<string, unknown>, meta?: Message): Promise<Message> {
		this.request(id, method, params, meta);
		return await this.response(id);
	}

	named(method: string): Message[] {
		return this.messages.filter(message => message.method === method);
	}

	/** Wait for an `omp/status` whose params contain `expected`. */
	async status(expected: Record<string, unknown>): Promise<Message> {
		return await this.next(
			message => {
				if (message.method !== MCP_STATUS_METHOD) return false;
				const params = message.params;
				if (typeof params !== "object" || params === null) return false;
				const seen: Record<string, unknown> = { ...params };
				for (const key in expected) {
					if (seen[key] !== expected[key]) return false;
				}
				return true;
			},
			`status ${JSON.stringify(expected)}`,
		);
	}

	/** Forget what arrived so far, so later waits match only new messages. */
	clear(): void {
		this.messages.length = 0;
	}

	disconnect(): void {
		this.#close();
	}
}

const encoder = new TextEncoder();

/** Attach a new link to `endpoint` over an in-memory tunnel that delivers asynchronously. */
export function attachLink(endpoint: McpEndpoint): TestLink {
	let toUnit: ((chunk: Uint8Array) => void) | undefined;
	let unitClosed: (() => void) | undefined;
	const link = new TestLink(
		line => queueMicrotask(() => toUnit?.(encoder.encode(line))),
		() => queueMicrotask(() => unitClosed?.()),
	);
	const tunnel: ModuleTunnel = {
		client: { connectionId: "test", pid: process.pid, build: "test" },
		send(data) {
			const chunk = typeof data === "string" ? encoder.encode(data) : data;
			queueMicrotask(() => link.receive(chunk));
			return true;
		},
		drained: () => Promise.resolve(),
		start(onData, onClose) {
			toUnit = onData;
			unitClosed = onClose;
		},
		close() {
			queueMicrotask(() => {
				link.closed = true;
			});
		},
	};
	endpoint.attach(tunnel);
	return link;
}

/** Read and write an attachment's tunnel as a {@link TestLink}. */
export function linkOver(tunnel: McpTunnel): TestLink {
	const link = new TestLink(
		line => tunnel.send(line),
		() => tunnel.close(),
	);
	tunnel.start(
		chunk => link.receive(chunk),
		() => {
			link.closed = true;
		},
	);
	return link;
}

/** An endpoint over scripted upstreams; `stop()` it when the test ends. */
export function scriptedEndpoint(options: {
	store: McpStore;
	upstreams: McpUpstreams;
	spec?: McpServerSpec;
	era?: McpEra;
	idleMs?: number;
	changed?: (unitId: string) => void;
}): McpEndpoint {
	return new McpEndpoint({
		unitId: "unit-1",
		spec: options.spec ?? stdioSpec("scripted"),
		era: options.era ?? "modern",
		name: "scripted",
		store: options.store,
		upstreams: options.upstreams,
		deps: {
			spawn: () => {
				throw new Error("scripted upstreams never spawn");
			},
		},
		idleMs: options.idleMs ?? 60_000,
		changed: options.changed ?? (() => {}),
	});
}
