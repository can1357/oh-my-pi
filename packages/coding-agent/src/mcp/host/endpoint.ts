/**
 * One MCP host unit: every session attached to one upstream server.
 *
 * The endpoint is an MCP 2026-07-28 server towards each attached link and a
 * client of one {@link McpPeer}. It answers cacheable requests from the shared
 * store, starts the upstream only when a request needs it, keeps request ids,
 * progress tokens and subscriptions of different links apart, and stops the
 * upstream again when nothing uses it. It never looks at the era except in
 * two places: a handshake-era server pushes notifications unasked, and its
 * process may hold session state.
 *
 * Idle stop: an upstream with no request in flight and no resource
 * subscription open is stopped after `idleMs` of quiet. A modern upstream is
 * stateless, so that always applies. A handshake-era upstream is stopped the
 * same way only while it has served nothing but cacheable methods (discover,
 * lists, `resources/read`) and the host's own subscription; once any other
 * request or a forwarded resource subscription reached it, it carries session
 * state and stays up until the unit stops. A restarted upstream starts clean.
 */
import { isRecord, logger, stableStringifyJson } from "@oh-my-pi/pi-utils";
import type { ChildSpawn, ManagedChild, ManagedChildState, ModuleTunnel, ModuleUnit } from "../../daemon/module";
import { type MCPTransportKind, MCPTransportError, normalizeMCPTransportError } from "../errors";
import {
	hasResourceSubscriptions,
	isCacheableMethod,
	MCP_PROTOCOL_VERSION,
	MCP_SUBSCRIPTION_ACKNOWLEDGED,
	MCPErrorCode,
	MCPMeta,
	type MCPSubscriptionFilter,
	requestMeta,
	resultTypeOf,
} from "../protocol";
import type { JsonRpcError } from "../types";
import {
	encodeHostError,
	encodeJsonLine,
	JsonLineDecoder,
	MCP_NO_STORE,
	MCP_RESTART_METHOD,
	MCP_ROOTS_METHOD,
	MCP_STALE_OK,
	MCP_STATUS_METHOD,
	type McpEra,
	type McpServerSpec,
	type McpUpstreamExit,
	type McpUpstreamStatus,
	mcpIdentity,
	mcpPublicIdentity,
	OmpMeta,
} from "./contract";
import type { McpPeer, McpPeerDeps, McpPeerState, McpPeerSubscription, McpRoot, McpUpstreams } from "./peer";
import { cacheParamsKey, isFresh, MCP_ERA_RECHECK_MS, type McpCacheEntry, type McpStore } from "./store";

type RequestId = string | number;

const LISTEN_METHOD = "subscriptions/listen";
const CANCELLED_METHOD = "notifications/cancelled";
const PROGRESS_METHOD = "notifications/progress";
const RESOURCE_UPDATED_METHOD = "notifications/resources/updated";
const DISCOVER_METHOD = "server/discover";
const TOOLS_LIST_METHOD = "tools/list";
const RESOURCE_READ_METHOD = "resources/read";
const INVALID_REQUEST = -32600;

/** Params key of a request without parameters: the first page of a list. */
const FIRST_PAGE = cacheParamsKey(undefined);

/** Failed starts and unexpected exits within {@link CRASH_WINDOW_MS} that open the crash guard. */
const CRASH_LIMIT = 5;
const CRASH_WINDOW_MS = 30_000;
/** How long an open crash guard refuses to start the upstream. */
const CRASH_REFUSAL_MS = 30_000;
/** Characters of the last failure quoted in the crash guard's error. */
const CRASH_DETAIL_CHARS = 600;
/** How long a request that lost its upstream waits for the process exit to report it. */
const EXIT_WAIT_MS = 1_000;
/** Deadline of a request the host makes for itself when the spec sets no timeout. */
const HOST_REQUEST_TIMEOUT_MS = 30_000;
/** Pause before the shared subscription is opened again after it ended, doubling up to the maximum. */
const RESUBSCRIBE_MIN_MS = 250;
const RESUBSCRIBE_MAX_MS = 10_000;

interface ListChange {
	flag: "toolsListChanged" | "promptsListChanged" | "resourcesListChanged";
	/** Server capability whose `listChanged` backs the flag. */
	capability: "tools" | "prompts" | "resources";
	notification: string;
	/** Cached methods the notification makes stale. */
	methods: readonly string[];
}

const LIST_CHANGES: readonly ListChange[] = [
	{
		flag: "toolsListChanged",
		capability: "tools",
		notification: "notifications/tools/list_changed",
		methods: [TOOLS_LIST_METHOD],
	},
	{
		flag: "promptsListChanged",
		capability: "prompts",
		notification: "notifications/prompts/list_changed",
		methods: ["prompts/list"],
	},
	{
		flag: "resourcesListChanged",
		capability: "resources",
		notification: "notifications/resources/list_changed",
		methods: ["resources/list", "resources/templates/list"],
	},
];

const LIST_METHODS: readonly string[] = LIST_CHANGES.flatMap(change => change.methods);

const ALL_LIST_CHANGES: MCPSubscriptionFilter = {
	toolsListChanged: true,
	promptsListChanged: true,
	resourcesListChanged: true,
};

/** Failures that mean the upstream itself went away under a request. */
const LOST_UPSTREAM: Record<string, true> = { eof: true, reset: true, closed: true };

/** Exit of the upstream a failed request was lost with, reported to the session beside the error. */
const kExit = Symbol("mcp.upstreamExit");

interface UpstreamFailure extends MCPTransportError {
	[kExit]?: McpUpstreamExit;
}

/** A link's open subscription. `upstream` is set when it is forwarded rather than virtual. */
interface Listen {
	/** What the link asked for; changes the host detects itself go to these. */
	requested: MCPSubscriptionFilter;
	/** The acknowledged subset; the upstream's own notifications go to these. */
	filter: MCPSubscriptionFilter;
	upstream?: McpPeerSubscription;
}

/** A started upstream and how it ended. */
interface PeerRecord {
	peer: McpPeer;
	/** The endpoint closed it on purpose; its exit is not a failure. */
	expected: boolean;
	/**
	 * Something other than a cacheable request reached this upstream, so a
	 * handshake-era process may hold state its session relies on.
	 */
	sessionBearing: boolean;
	exit?: McpUpstreamExit;
}

/** One upstream fetch shared by every link that asked for the same cacheable result. */
interface Flight {
	method: string;
	/** Params key of the request, see `cacheParamsKey`. */
	key: string;
	/** What it fetches was invalidated meanwhile: its result may predate the change and is not stored. */
	superseded: boolean;
	promise: Promise<Record<string, unknown>>;
	controller: AbortController;
	waiters: number;
	progress: Set<(progress: Record<string, unknown>) => void>;
}

/** Abort scope of one piece of upstream work the host does for itself; `done` must be called when it is over. */
interface HostWork {
	signal: AbortSignal;
	done(): void;
}

/** One attached session: its tunnel, in-flight requests, subscriptions and roots. */
class Link {
	readonly tunnel: ModuleTunnel;
	readonly decoder = new JsonLineDecoder();
	/** Requests being served, by the link's own id. Removing an entry suppresses its response. */
	readonly requests = new Map<RequestId, AbortController>();
	readonly listens = new Map<RequestId, Listen>();
	roots: McpRoot[] = [];
	closed = false;
	#queue: string[] = [];
	#blocked = false;

	constructor(tunnel: ModuleTunnel) {
		this.tunnel = tunnel;
	}

	/** Write `message`, queueing behind earlier ones while the tunnel is over its buffer limit. */
	send(message: unknown): void {
		if (this.closed) return;
		const line = encodeJsonLine(message);
		if (this.#blocked) {
			this.#queue.push(line);
			return;
		}
		try {
			if (this.tunnel.send(line)) return;
		} catch (error) {
			logger.debug("MCP link write failed", { error: String(error) });
			return;
		}
		this.#blocked = true;
		void this.#drain();
	}

	async #drain(): Promise<void> {
		try {
			while (!this.closed) {
				await this.tunnel.drained();
				let sent = 0;
				let open = true;
				while (open && sent < this.#queue.length) open = this.tunnel.send(this.#queue[sent++]);
				this.#queue.splice(0, sent);
				if (open) {
					this.#blocked = false;
					return;
				}
			}
		} catch (error) {
			logger.debug("MCP link drain failed", { error: String(error) });
		}
	}
}

function errorResponse(id: RequestId, error: JsonRpcError): unknown {
	return { jsonrpc: "2.0", id, error };
}

function notification(method: string, params: Record<string, unknown>): unknown {
	return { jsonrpc: "2.0", method, params };
}

/** A notification on the stream of the `subscriptions/listen` request `id`. */
function streamNotification(method: string, params: Record<string, unknown>, id: RequestId): unknown {
	const own = isRecord(params._meta) ? params._meta : undefined;
	return notification(method, { ...params, _meta: { ...own, [MCPMeta.subscriptionId]: id } });
}

/** Wait for `promise` until `signal` aborts; the promise itself is left running. */
async function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
	signal.throwIfAborted();
	const aborted = Promise.withResolvers<never>();
	const onAbort = () => aborted.reject(signal.reason);
	signal.addEventListener("abort", onAbort, { once: true });
	try {
		return await Promise.race([promise, aborted.promise]);
	} finally {
		signal.removeEventListener("abort", onAbort);
	}
}

function parseRoots(value: unknown): McpRoot[] {
	const roots: McpRoot[] = [];
	if (!Array.isArray(value)) return roots;
	for (const item of value) {
		if (!isRecord(item) || typeof item.uri !== "string") continue;
		roots.push(typeof item.name === "string" ? { uri: item.uri, name: item.name } : { uri: item.uri });
	}
	return roots;
}

function parseFilter(value: unknown): MCPSubscriptionFilter | undefined {
	if (!isRecord(value)) return undefined;
	const filter: MCPSubscriptionFilter = {};
	for (const change of LIST_CHANGES) {
		if (value[change.flag] === true) filter[change.flag] = true;
	}
	if (Array.isArray(value.resourceSubscriptions)) {
		const uris = value.resourceSubscriptions.filter(uri => typeof uri === "string");
		if (uris.length > 0) filter.resourceSubscriptions = uris;
	}
	return filter;
}

/** The list-change flags of `filter` that the capabilities in a `server/discover` result back. */
function supportedListChanges(
	filter: MCPSubscriptionFilter,
	discover: Record<string, unknown> | undefined,
): MCPSubscriptionFilter {
	const capabilities = discover && isRecord(discover.capabilities) ? discover.capabilities : undefined;
	const supported: MCPSubscriptionFilter = {};
	for (const change of LIST_CHANGES) {
		if (!filter[change.flag]) continue;
		if (capabilities) {
			const capability = capabilities[change.capability];
			if (!isRecord(capability) || capability.listChanged !== true) continue;
		}
		supported[change.flag] = true;
	}
	return supported;
}

/** Whether two results of one method say the same thing; `_meta` and `ttlMs` vary per response. */
function sameContent(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
	const { _meta: _aMeta, ttlMs: _aTtl, ...left } = a;
	const { _meta: _bMeta, ttlMs: _bTtl, ...right } = b;
	return stableStringifyJson(left) === stableStringifyJson(right);
}

/** `_meta` as it goes upstream: without the tunnel's private keys and the link's progress token. */
function upstreamMeta(meta: Record<string, unknown>): Record<string, unknown> {
	const result: Record<string, unknown> = {};
	for (const key in meta) {
		if (key === MCPMeta.progressToken || key.startsWith("omp/")) continue;
		result[key] = meta[key];
	}
	return result;
}

interface Probe {
	promise: Promise<McpEra>;
	controller: AbortController;
	/** Callers waiting for the verdict; a probe nobody waits for is aborted. */
	waiters: number;
}

/**
 * Answers which era a server speaks, for the daemon module and the in-process
 * host alike: from the store when the verdict is recent enough, else from one
 * probe shared by every concurrent caller.
 */
export class McpEraResolver {
	readonly #store: McpStore;
	readonly #upstreams: McpUpstreams;
	readonly #deps: McpPeerDeps;
	readonly #probes = new Map<string, Probe>();
	#disposed = false;

	constructor(store: McpStore, upstreams: McpUpstreams, spawn: (spec: ChildSpawn) => ManagedChild) {
		this.#store = store;
		this.#upstreams = upstreams;
		this.#deps = { spawn, roots: () => [] };
	}

	/**
	 * The era of the server `spec` describes. A handshake-era verdict older
	 * than `MCP_ERA_RECHECK_MS` is probed again, so an upgraded server starts
	 * being shared. Aborting `signal` abandons the wait, not a probe others
	 * share; the probe is aborted when its last caller has left, so a later
	 * call starts a fresh one instead of joining one that is about to fail.
	 *
	 * @throws MCPTransportError when the server cannot be started or reached.
	 * @throws Error after {@link dispose}.
	 */
	async resolve(spec: McpServerSpec, signal?: AbortSignal): Promise<McpEra> {
		signal?.throwIfAborted();
		if (this.#disposed) throw new Error("MCP era resolver is disposed");
		const record = this.#store.era(mcpPublicIdentity(spec));
		if (record && (record.era === "modern" || Date.now() - record.probedAt < MCP_ERA_RECHECK_MS)) {
			return record.era;
		}
		const key = mcpIdentity(spec);
		let probe = this.#probes.get(key);
		if (!probe) {
			const controller = new AbortController();
			const started: Probe = {
				controller,
				waiters: 0,
				promise: this.#probe(spec, controller.signal).finally(() => {
					if (this.#probes.get(key) === started) this.#probes.delete(key);
				}),
			};
			// A caller that aborted its wait leaves the probe's failure unobserved.
			started.promise.catch(() => {});
			this.#probes.set(key, started);
			probe = started;
		}
		probe.waiters++;
		try {
			return signal ? await untilAborted(probe.promise, signal) : await probe.promise;
		} finally {
			// A settled probe has left the map already; one still in it is in flight.
			if (--probe.waiters === 0 && this.#probes.get(key) === probe) {
				this.#probes.delete(key);
				probe.controller.abort(new Error("MCP era probe abandoned"));
			}
		}
	}

	/**
	 * Abort every probe in flight and resolve once they are gone, so no probe
	 * process survives and nothing is written to the store afterwards.
	 */
	async dispose(): Promise<void> {
		this.#disposed = true;
		const settled = Array.from(this.#probes.values(), probe => {
			probe.controller.abort(new Error("MCP host is shutting down"));
			return probe.promise;
		});
		this.#probes.clear();
		await Promise.allSettled(settled);
	}

	async #probe(spec: McpServerSpec, signal: AbortSignal): Promise<McpEra> {
		const { era, discover } = await this.#upstreams.probe(spec, this.#deps, signal);
		signal.throwIfAborted();
		this.#store.setEra(mcpPublicIdentity(spec), era);
		if (discover) {
			const identity = discover.cacheScope === "public" ? mcpPublicIdentity(spec) : mcpIdentity(spec);
			const result: Record<string, unknown> = { ...discover };
			this.#store.put(identity, DISCOVER_METHOD, FIRST_PAGE, result, discover.ttlMs ?? 0);
		}
		return era;
	}
}

/** Peer state to re-adopt after a daemon re-exec, with the daemon's way to re-attach to the child. */
export interface McpEndpointRestore {
	peer: McpPeerState;
	adopt(child: ManagedChildState): ManagedChild | undefined;
}

/** Construction parameters of {@link McpEndpoint}. */
export interface McpEndpointOptions {
	unitId: string;
	spec: McpServerSpec;
	era: McpEra;
	/** Configured server name, for the board label and diagnostics. */
	name: string;
	store: McpStore;
	upstreams: McpUpstreams;
	deps: {
		/** Starts the subprocess of a stdio upstream; see {@link McpPeerDeps.spawn}. */
		spawn(spec: ChildSpawn): ManagedChild;
	};
	/**
	 * Quiet time after which an upstream holding no session state is stopped
	 * (see the module comment); 0 or less never stops it.
	 */
	idleMs: number;
	/** Called with `unitId` whenever the unit's processes change. */
	changed(unitId: string): void;
	/** Continue the upstream of a unit snapshot instead of starting idle. */
	restore?: McpEndpointRestore;
}

/** What {@link McpEndpoint.snapshot} returns: enough to rebuild the unit after a daemon re-exec. */
export interface McpEndpointSnapshot {
	spec: McpServerSpec;
	era: McpEra;
	name: string;
	idleMs: number;
	/** Present only while a subprocess upstream is running. */
	peer?: McpPeerState;
}

/** Multiplexes every attached session onto one upstream server; see the module comment. */
export class McpEndpoint implements ModuleUnit {
	readonly label: string;
	readonly era: McpEra;
	readonly ready: Promise<void> = Promise.resolve();
	readonly exited: Promise<{ exitCode?: number; reason?: string }>;

	readonly #unitId: string;
	readonly #spec: McpServerSpec;
	readonly #name: string;
	readonly #store: McpStore;
	readonly #upstreams: McpUpstreams;
	readonly #deps: McpPeerDeps;
	readonly #idleMs: number;
	readonly #changed: (unitId: string) => void;
	readonly #identity: string;
	readonly #publicIdentity: string;
	readonly #transport: MCPTransportKind;
	readonly #exit = Promise.withResolvers<{ exitCode?: number; reason?: string }>();

	readonly #links = new Set<Link>();
	readonly #flights = new Map<string, Flight>();
	/** Upstream work the host does for itself (revalidation, reconcile, its own subscription), each with a deadline. */
	readonly #hostWork = new Set<AbortController>();
	/** Upstreams being shut down; `stop` waits for them so no process outlives the unit. */
	readonly #retiring = new Set<Promise<void>>();
	/** The link whose request most recently went upstream: the one a legacy server's `roots/list` is about. */
	#served: Link | undefined;
	/** Upstream `_meta` of the latest request, reused for the host's own catalog fetches. */
	#meta: Record<string, unknown> | undefined;

	#state: McpUpstreamStatus["state"] = "idle";
	#current: PeerRecord | undefined;
	#starting: Promise<PeerRecord> | undefined;
	#startAbort: AbortController | undefined;
	/** Requests waiting for the start in progress. */
	#startWaiters = 0;
	#lastExit: McpUpstreamExit | undefined;
	/** The host's own subscription on the current upstream. */
	#listChanges: McpPeerSubscription | undefined;
	/** Upstream requests in flight, whoever they are for; the upstream is not idle while there are any. */
	#inflight = 0;
	#forwarded = 0;
	#idleTimer: NodeJS.Timeout | undefined;
	#stopped = false;

	#crashes: number[] = [];
	#refuseUntil = 0;
	#refusedAfter = 0;
	#lastFailure = "";

	constructor(options: McpEndpointOptions) {
		this.#unitId = options.unitId;
		this.#spec = options.spec;
		this.era = options.era;
		this.#name = options.name;
		this.label = `mcp ${options.name}`;
		this.#store = options.store;
		this.#upstreams = options.upstreams;
		this.#idleMs = options.idleMs;
		this.#changed = options.changed;
		this.#identity = mcpIdentity(options.spec);
		this.#publicIdentity = mcpPublicIdentity(options.spec);
		this.#transport = options.spec.transport === "stdio" ? "stdio" : "http";
		this.exited = this.#exit.promise;
		this.#deps = {
			spawn: child => options.deps.spawn(child),
			roots: () => {
				if (this.#served) return this.#served.roots;
				for (const link of this.#links) return link.roots;
				return [];
			},
		};
		const restore = options.restore;
		if (restore) {
			const peer = this.#upstreams.restore(this.#spec, this.era, restore.peer, restore.adopt, this.#deps);
			if (peer) {
				// What it served before the re-exec is unknown, so it is taken to carry a session.
				this.#adopt(peer).sessionBearing = true;
				this.#armIdle();
			}
		}
	}

	pids(): number[] {
		const pid = this.#current?.peer.pid;
		return pid === undefined ? [] : [pid];
	}

	/**
	 * Whether a session is being served: a request of an attached link is in
	 * flight or a resource subscription is open. Work the host does for itself
	 * counts only while a link is attached, so an abandoned unit can be stopped.
	 */
	busy(): boolean {
		if (this.#forwarded > 0) return true;
		for (const link of this.#links) {
			if (link.requests.size > 0) return true;
		}
		return this.#links.size > 0 && (this.#starting !== undefined || this.#hostWork.size > 0);
	}

	attach(tunnel: ModuleTunnel): void {
		if (this.#stopped) {
			tunnel.close();
			return;
		}
		const link = new Link(tunnel);
		this.#links.add(link);
		tunnel.start(
			chunk => {
				for (const line of link.decoder.push(chunk)) this.#receive(link, line);
			},
			() => this.#detach(link),
		);
		this.#publish();
	}

	/** Close every tunnel and the upstream; resolves once no process of the unit is left. */
	async stop(reason: string): Promise<void> {
		if (this.#stopped) {
			await this.exited;
			return;
		}
		this.#stopped = true;
		for (const link of this.#links) {
			this.#detach(link);
			link.tunnel.close();
		}
		await this.#stopPeer(reason);
		// Interrupted starts are in here too, each until the upstream it may still produce is closed.
		while (this.#retiring.size > 0) await Promise.all(this.#retiring);
		this.#exit.resolve({ reason });
	}

	snapshot(): McpEndpointSnapshot {
		const snapshot: McpEndpointSnapshot = {
			spec: this.#spec,
			era: this.era,
			name: this.#name,
			idleMs: this.#idleMs,
		};
		const peer = this.#spec.transport === "stdio" ? this.#current?.peer.snapshot() : undefined;
		if (peer) snapshot.peer = peer;
		return snapshot;
	}

	// ── links ────────────────────────────────────────────────────────────────

	#detach(link: Link): void {
		if (link.closed) return;
		link.closed = true;
		this.#links.delete(link);
		if (this.#served === link) this.#served = undefined;
		const requests = [...link.requests.values()];
		link.requests.clear();
		for (const controller of requests) controller.abort(new Error("MCP link closed"));
		const listens = [...link.listens.values()];
		link.listens.clear();
		for (const listen of listens) listen.upstream?.close();
		this.#abandonUnusedStart();
		this.#publish();
	}

	#publish(): void {
		const status: McpUpstreamStatus = {
			era: this.era,
			state: this.#state,
			pid: this.#current?.peer.pid,
			links: this.#links.size,
			exit: this.#state === "failed" ? this.#lastExit : undefined,
		};
		const message = { jsonrpc: "2.0", method: MCP_STATUS_METHOD, params: status };
		for (const link of this.#links) link.send(message);
	}

	#setState(state: McpUpstreamStatus["state"]): void {
		this.#state = state;
		this.#publish();
		this.#changed(this.#unitId);
	}

	#receive(link: Link, line: string): void {
		let message: unknown;
		try {
			message = JSON.parse(line);
		} catch (error) {
			logger.debug("MCP link sent a malformed line", { server: this.#name, error: String(error) });
			return;
		}
		if (!isRecord(message) || typeof message.method !== "string") return;
		const { id, method } = message;
		const params = isRecord(message.params) ? message.params : undefined;
		if (typeof id === "string" || typeof id === "number") {
			void this.#serve(link, id, method, params);
			return;
		}
		switch (method) {
			case CANCELLED_METHOD:
				this.#cancel(link, params?.requestId);
				break;
			case MCP_RESTART_METHOD:
				void this.#restart();
				break;
			case MCP_ROOTS_METHOD:
				link.roots = parseRoots(params?.roots);
				break;
		}
	}

	#cancel(link: Link, id: unknown): void {
		if (typeof id !== "string" && typeof id !== "number") return;
		const controller = link.requests.get(id);
		if (controller) {
			link.requests.delete(id);
			controller.abort(new Error("MCP request cancelled"));
		}
		const listen = link.listens.get(id);
		if (listen) {
			link.listens.delete(id);
			listen.upstream?.close();
		}
	}

	// ── requests ─────────────────────────────────────────────────────────────

	async #serve(link: Link, id: RequestId, method: string, params: Record<string, unknown> | undefined): Promise<void> {
		const meta = params && isRecord(params._meta) ? params._meta : undefined;
		const version = meta?.[MCPMeta.protocolVersion];
		if (!params || !meta || typeof version !== "string" || !isRecord(meta[MCPMeta.clientCapabilities])) {
			link.send(
				errorResponse(id, {
					code: MCPErrorCode.InvalidParams,
					message: `Request _meta must carry ${MCPMeta.protocolVersion} and ${MCPMeta.clientCapabilities}`,
				}),
			);
			return;
		}
		if (version !== MCP_PROTOCOL_VERSION) {
			link.send(
				errorResponse(id, {
					code: MCPErrorCode.UnsupportedProtocolVersion,
					message: `Unsupported protocol version: ${version}`,
					data: { supported: [MCP_PROTOCOL_VERSION], requested: version },
				}),
			);
			return;
		}
		if (link.requests.has(id) || link.listens.has(id)) {
			link.send(errorResponse(id, { code: INVALID_REQUEST, message: `Request id ${id} is already in use` }));
			return;
		}
		const token = meta[MCPMeta.progressToken];
		const forwarded = { ...params, _meta: upstreamMeta(meta) };
		this.#meta = forwarded._meta;
		const controller = new AbortController();
		link.requests.set(id, controller);
		if (method === LISTEN_METHOD) {
			await this.#listen(link, id, forwarded, controller);
			return;
		}
		const onProgress =
			typeof token === "string" || typeof token === "number"
				? (progress: Record<string, unknown>) => {
						if (link.requests.get(id) !== controller) return;
						link.send(notification(PROGRESS_METHOD, { ...progress, progressToken: token }));
					}
				: undefined;
		let response: unknown;
		try {
			const result = await this.#answer(link, method, forwarded, meta[OmpMeta.cache], controller.signal, onProgress);
			response = { jsonrpc: "2.0", id, result };
		} catch (error) {
			response = errorResponse(id, this.#encode(error));
		}
		// A cancelled or disconnected request was removed from the table and gets no response.
		if (link.requests.get(id) !== controller) return;
		link.requests.delete(id);
		link.send(response);
	}

	async #answer(
		link: Link,
		method: string,
		params: Record<string, unknown>,
		hint: unknown,
		signal: AbortSignal,
		onProgress: ((progress: Record<string, unknown>) => void) | undefined,
	): Promise<Record<string, unknown>> {
		// The store is bypassed for results that are not cacheable, for MRTR retries, and on request.
		if (
			!isCacheableMethod(method) ||
			params.inputResponses !== undefined ||
			params.requestState !== undefined ||
			hint === MCP_NO_STORE
		) {
			this.#served = link;
			try {
				return await this.#call(method, params, { signal, onProgress });
			} catch (error) {
				this.#noteUnknownTool(method, error);
				throw error;
			}
		}
		const key = cacheParamsKey(params);
		const entry = this.#stored(method, key);
		if (entry && isFresh(entry)) return entry.result;
		if (entry && hint === MCP_STALE_OK) {
			const meta = isRecord(params._meta) ? params._meta : requestMeta();
			this.#revalidate(meta, [DISCOVER_METHOD, ...LIST_METHODS], Number.POSITIVE_INFINITY);
			if (key !== FIRST_PAGE || (method !== DISCOVER_METHOD && !LIST_METHODS.includes(method))) {
				this.#refetch(method, params, key);
			}
			const stored = isRecord(entry.result._meta) ? entry.result._meta : undefined;
			return { ...entry.result, _meta: { ...stored, [OmpMeta.stale]: true } };
		}
		this.#served = link;
		return await this.#join(this.#flight(method, params, key), signal, onProgress);
	}

	/** A `tools/call` rejected as invalid while a tools list is stored suggests the list is out of date. */
	#noteUnknownTool(method: string, error: unknown): void {
		if (method !== "tools/call" || !(error instanceof MCPTransportError)) return;
		if (error.rpc?.code !== MCPErrorCode.InvalidParams || !this.#stored(TOOLS_LIST_METHOD, FIRST_PAGE)) return;
		const change = LIST_CHANGES[0];
		this.#invalidate(change.methods);
		this.#fanOut(change, "host");
	}

	/**
	 * Send one request upstream, starting the upstream when needed.
	 *
	 * @throws MCPTransportError always, tagged with the exit of a lost upstream.
	 */
	async #call(
		method: string,
		params: Record<string, unknown>,
		options: { signal: AbortSignal; onProgress?: (progress: Record<string, unknown>) => void },
	): Promise<Record<string, unknown>> {
		this.#inflight++;
		this.#armIdle();
		let record: PeerRecord | undefined;
		try {
			record = await this.#awaitPeer(options.signal);
			options.signal.throwIfAborted();
			if (!isCacheableMethod(method)) record.sessionBearing = true;
			return await record.peer.request(method, params, options);
		} catch (error) {
			throw await this.#failure(error, record, "receive");
		} finally {
			this.#inflight--;
			this.#armIdle();
		}
	}

	async #failure(
		error: unknown,
		record: PeerRecord | undefined,
		stage: "connect" | "receive",
	): Promise<MCPTransportError> {
		const failure: UpstreamFailure = normalizeMCPTransportError(error, { transport: this.#transport, stage });
		if (this.era === "modern" && failure.rpc?.code === MCPErrorCode.UnsupportedProtocolVersion) {
			try {
				this.#store.clearEra(this.#publicIdentity, "modern");
			} catch (error) {
				logger.debug("MCP era invalidation failed", { server: this.#name, error: String(error) });
			}
		}
		if (failure.rpc || !record) return failure;
		if (!record.exit && Object.hasOwn(LOST_UPSTREAM, failure.failure) && record.peer.pid !== undefined) {
			// The pipe closes before the exit is reaped; `#closed` records it first when it arrives in time.
			await Promise.race([record.peer.closed, Bun.sleep(EXIT_WAIT_MS)]);
		}
		if (record.exit) failure[kExit] = record.exit;
		return failure;
	}

	#encode(error: unknown): JsonRpcError {
		const failure: UpstreamFailure = normalizeMCPTransportError(error, {
			transport: this.#transport,
			stage: "receive",
		});
		return encodeHostError(failure, failure[kExit]);
	}

	// ── host-owned work ──────────────────────────────────────────────────────

	/**
	 * Open the abort scope of one piece of work the host does for itself. It
	 * is aborted after the spec's timeout, when the upstream is retired and
	 * when the unit stops, so a server that never answers cannot hold the unit.
	 */
	#beginHostWork(): HostWork {
		const controller = new AbortController();
		const timeoutMs = this.#spec.timeoutMs > 0 ? this.#spec.timeoutMs : HOST_REQUEST_TIMEOUT_MS;
		const timer = setTimeout(() => {
			controller.abort(
				new MCPTransportError({
					transport: this.#transport,
					stage: "receive",
					failure: "timeout",
					message: `MCP server "${this.#name}" did not answer the host within ${timeoutMs} ms`,
					retryable: false,
				}),
			);
		}, timeoutMs);
		timer.unref();
		this.#hostWork.add(controller);
		return {
			signal: controller.signal,
			done: () => {
				clearTimeout(timer);
				this.#hostWork.delete(controller);
			},
		};
	}

	#abortHostWork(reason: string): void {
		for (const controller of this.#hostWork) controller.abort(new Error(`MCP host work abandoned: ${reason}`));
	}

	/** Fetch a cacheable result in the background so the store catches up with the server. */
	#refetch(method: string, params: Record<string, unknown>, key: string): void {
		const work = this.#beginHostWork();
		this.#join(this.#flight(method, params, key), work.signal)
			.catch(error => {
				logger.debug("MCP revalidation failed", { server: this.#name, method, error: String(error) });
			})
			.finally(work.done);
	}

	/**
	 * Refetch the first page of each of `methods` whose stored entry was
	 * received before `before`; `#remember` reports differences.
	 */
	#revalidate(meta: Record<string, unknown>, methods: readonly string[], before: number): void {
		for (const method of methods) {
			const entry = this.#stored(method, FIRST_PAGE);
			if (entry && entry.receivedAt < before) this.#refetch(method, { _meta: meta }, FIRST_PAGE);
		}
	}

	// ── shared fetches and the store ─────────────────────────────────────────

	/** The in-flight fetch of a cacheable result, started when there is none. Its result is stored on completion. */
	#flight(method: string, params: Record<string, unknown>, key: string): Flight {
		const id = `${method}\n${key}`;
		const existing = this.#flights.get(id);
		if (existing) return existing;
		const controller = new AbortController();
		const progress = new Set<(progress: Record<string, unknown>) => void>();
		const promise = this.#call(method, params, {
			signal: controller.signal,
			onProgress: update => {
				for (const sink of progress) sink(update);
			},
		})
			.then(result => {
				if (!flight.superseded) this.#remember(method, key, result);
				return result;
			})
			.finally(() => {
				if (this.#flights.get(id) === flight) this.#flights.delete(id);
			});
		// Waiters observe the outcome through `#join`; a flight abandoned by all of them rejects unobserved.
		promise.catch(() => {});
		const flight: Flight = { method, key, superseded: false, promise, controller, waiters: 0, progress };
		this.#flights.set(id, flight);
		return flight;
	}

	/**
	 * Wait for `flight` on behalf of one requester. When its last requester
	 * leaves, the flight is aborted and leaves the lookup, so a later request
	 * fetches anew instead of joining one that is about to fail.
	 */
	async #join(
		flight: Flight,
		signal: AbortSignal,
		onProgress?: (progress: Record<string, unknown>) => void,
	): Promise<Record<string, unknown>> {
		flight.waiters++;
		if (onProgress) flight.progress.add(onProgress);
		try {
			return await untilAborted(flight.promise, signal);
		} finally {
			if (onProgress) flight.progress.delete(onProgress);
			if (--flight.waiters === 0) {
				const id = `${flight.method}\n${flight.key}`;
				if (this.#flights.get(id) === flight) this.#flights.delete(id);
				flight.controller.abort(new Error("MCP request abandoned"));
			}
		}
	}

	#stored(method: string, key: string): McpCacheEntry | undefined {
		try {
			const own = this.#store.get(this.#identity, method, key);
			if (this.#publicIdentity === this.#identity) return own;
			const shared = this.#store.get(this.#publicIdentity, method, key);
			if (!own || !shared) return own ?? shared;
			return shared.receivedAt > own.receivedAt ? shared : own;
		} catch (error) {
			logger.debug("MCP store read failed", { server: this.#name, method, error: String(error) });
			return undefined;
		}
	}

	/**
	 * Forget what the store holds for `methods` under both identities. Fetches
	 * of them still in flight are superseded: they leave the lookup at once, so
	 * the next request fetches anew, and their results are not stored. `key`
	 * (a `cacheParamsKey`) limits both to the request with those parameters.
	 */
	#invalidate(methods: readonly string[], key?: string): void {
		for (const [id, flight] of this.#flights) {
			if (!methods.includes(flight.method) || (key !== undefined && flight.key !== key)) continue;
			flight.superseded = true;
			this.#flights.delete(id);
		}
		try {
			this.#store.invalidate(this.#identity, methods, key);
			if (this.#publicIdentity !== this.#identity) this.#store.invalidate(this.#publicIdentity, methods, key);
		} catch (error) {
			logger.debug("MCP store invalidation failed", { server: this.#name, error: String(error) });
		}
	}

	/**
	 * Store a complete cacheable result. A list page that differs from the
	 * stored one means the catalog changed: the method's other pages are
	 * dropped and list-change subscribers are told.
	 */
	#remember(method: string, key: string, result: Record<string, unknown>): void {
		try {
			if (resultTypeOf(result) !== "complete") return;
		} catch {
			return;
		}
		const change = LIST_CHANGES.find(item => item.methods.includes(method));
		const before = change ? this.#stored(method, key) : undefined;
		const differs = before !== undefined && !sameContent(before.result, result);
		if (differs) this.#invalidate([method]);
		const ttlMs = typeof result.ttlMs === "number" && result.ttlMs > 0 ? result.ttlMs : 0;
		const identity = result.cacheScope === "public" ? this.#publicIdentity : this.#identity;
		try {
			this.#store.put(identity, method, key, result, ttlMs);
		} catch (error) {
			logger.debug("MCP store write failed", { server: this.#name, method, error: String(error) });
		}
		if (differs && change) this.#fanOut(change, "host");
	}

	// ── upstream lifecycle ───────────────────────────────────────────────────

	/**
	 * The running upstream, starting it once for all concurrent callers. A
	 * caller whose `signal` aborts leaves the wait; a start nobody waits for
	 * any more, with no link attached, is abandoned.
	 */
	async #awaitPeer(signal: AbortSignal): Promise<PeerRecord> {
		signal.throwIfAborted();
		if (this.#current) return this.#current;
		if (!this.#starting) {
			const refusal = this.#refusal();
			if (refusal) throw refusal;
			const starting = this.#start().finally(() => {
				if (this.#starting === starting) this.#starting = undefined;
			});
			// `stop` waits for every start to settle; one whose waiters all left fails unobserved.
			this.#retire(
				starting.then(
					() => {},
					() => {},
				),
			);
			this.#starting = starting;
		}
		this.#startWaiters++;
		try {
			return await untilAborted(this.#starting, signal);
		} finally {
			this.#startWaiters--;
			this.#abandonUnusedStart();
		}
	}

	#abandonUnusedStart(): void {
		if (this.#startWaiters === 0 && this.#links.size === 0) this.#interruptStart("no session is waiting for it");
	}

	/**
	 * Abort the start in progress, if any, without counting it as a failure of
	 * the server. It is forgotten at once, so the next request starts afresh.
	 */
	#interruptStart(reason: string): void {
		const startAbort = this.#startAbort;
		if (!startAbort) return;
		this.#startAbort = undefined;
		this.#starting = undefined;
		startAbort.abort(
			new MCPTransportError({
				transport: this.#transport,
				stage: "connect",
				failure: "closed",
				message: `MCP server "${this.#name}" start interrupted: ${reason}`,
				retryable: false,
			}),
		);
	}

	#refusal(): MCPTransportError | undefined {
		let message: string;
		if (this.#stopped) {
			message = `MCP server "${this.#name}" is stopped`;
		} else {
			const remaining = this.#refuseUntil - Date.now();
			if (remaining <= 0) return undefined;
			const detail = this.#lastFailure.trim().slice(-CRASH_DETAIL_CHARS);
			message =
				`MCP server "${this.#name}" failed ${this.#refusedAfter} times within ${CRASH_WINDOW_MS / 1_000} s; ` +
				`not starting it again for ${Math.ceil(remaining / 1_000)} s${detail ? `. Last output: ${detail}` : ""}`;
		}
		return new MCPTransportError({
			transport: this.#transport,
			stage: "connect",
			failure: "closed",
			message,
			retryable: false,
		});
	}

	#noteCrash(detail: string): void {
		const now = Date.now();
		this.#crashes = this.#crashes.filter(at => now - at < CRASH_WINDOW_MS);
		this.#crashes.push(now);
		this.#lastFailure = detail;
		if (this.#crashes.length < CRASH_LIMIT) return;
		this.#refusedAfter = this.#crashes.length;
		this.#refuseUntil = now + CRASH_REFUSAL_MS;
		this.#crashes = [];
	}

	async #start(): Promise<PeerRecord> {
		const controller = new AbortController();
		this.#startAbort = controller;
		const { timeoutMs } = this.#spec;
		const timer =
			timeoutMs > 0
				? setTimeout(() => {
						controller.abort(
							new MCPTransportError({
								transport: this.#transport,
								stage: "connect",
								failure: "timeout",
								message: `MCP server "${this.#name}" did not start within ${timeoutMs} ms`,
								retryable: false,
							}),
						);
					}, timeoutMs)
				: undefined;
		this.#lastExit = undefined;
		this.#setState("starting");
		let started: Promise<McpPeer> | undefined;
		try {
			started = this.#upstreams.start(this.#spec, this.era, this.#deps, controller.signal);
			const peer = await untilAborted(started, controller.signal);
			controller.signal.throwIfAborted();
			return this.#adopt(peer);
		} catch (error) {
			// A start that outlives its abort must not leave a process nobody owns.
			if (controller.signal.aborted && started) {
				this.#retire(
					started.then(
						peer => peer.close("start abandoned"),
						() => {},
					),
				);
			}
			const failure = normalizeMCPTransportError(error, { transport: this.#transport, stage: "connect" });
			if (this.#startAbort === controller) {
				this.#noteCrash(failure.message);
				this.#setState("failed");
			} else if (!this.#startAbort) {
				// Interrupted by a restart, a stop or the last waiter leaving: not a failure of the server.
				// With another start under way already, the status is that one's to report.
				this.#setState("idle");
			}
			throw failure;
		} finally {
			clearTimeout(timer);
			if (this.#startAbort === controller) this.#startAbort = undefined;
		}
	}

	/** Keep `closing`, the shutdown of an upstream, where `stop` can wait for it. */
	#retire(closing: Promise<void>): void {
		const tracked = closing
			.catch(error => {
				logger.debug("MCP upstream close failed", { server: this.#name, error: String(error) });
			})
			.finally(() => this.#retiring.delete(tracked));
		this.#retiring.add(tracked);
	}

	#adopt(peer: McpPeer): PeerRecord {
		const record: PeerRecord = { peer, expected: false, sessionBearing: false };
		this.#current = record;
		this.#lastExit = undefined;
		void peer.closed.then(exit => this.#closed(record, exit));
		this.#setState("running");
		this.#armIdle();
		void this.#afterStart(record);
		return record;
	}

	#closed(record: PeerRecord, exit: McpUpstreamExit): void {
		record.exit = exit;
		if (this.#current !== record) return;
		this.#current = undefined;
		this.#listChanges = undefined;
		this.#abortHostWork("upstream exited");
		this.#armIdle();
		this.#lastExit = exit;
		this.#noteCrash(exit.stderr);
		this.#setState("failed");
	}

	/** Open the host's own subscription and bring stored lists up to date with a fresh upstream. */
	async #afterStart(record: PeerRecord): Promise<void> {
		const meta = this.#meta ?? requestMeta();
		// Lists fetched from this upstream since it started are already current.
		const startedAt = Date.now();
		let discover: Record<string, unknown> | undefined;
		const work = this.#beginHostWork();
		try {
			discover = await this.#join(this.#flight(DISCOVER_METHOD, { _meta: meta }, FIRST_PAGE), work.signal);
		} catch (error) {
			logger.debug("MCP discover after start failed", { server: this.#name, error: String(error) });
		} finally {
			work.done();
		}
		if (this.#current !== record) return;
		// A handshake-era server pushes notifications unasked, so its stream is always worth holding.
		const filter = discover ? supportedListChanges(ALL_LIST_CHANGES, discover) : {};
		const wanted = filter.toolsListChanged || filter.promptsListChanged || filter.resourcesListChanged;
		if (wanted || this.era === "legacy") void this.#watchUpstream(record, filter, meta);
		this.#revalidate(meta, LIST_METHODS, startedAt);
	}

	/**
	 * Hold the host's own subscription for as long as `record` is the current
	 * upstream, opening it again with a growing pause whenever it ends.
	 */
	async #watchUpstream(
		record: PeerRecord,
		filter: MCPSubscriptionFilter,
		meta: Record<string, unknown>,
	): Promise<void> {
		let pauseMs = RESUBSCRIBE_MIN_MS;
		while (this.#current === record) {
			let subscription: McpPeerSubscription | undefined;
			const work = this.#beginHostWork();
			try {
				subscription = await record.peer.listen(
					filter,
					meta,
					(method, params) => this.#upstreamNotified(method, params),
					work.signal,
				);
			} catch (error) {
				const failure = normalizeMCPTransportError(error, { transport: this.#transport, stage: "receive" });
				logger.debug("MCP host subscription failed", { server: this.#name, error: failure.message });
				// A server that refuses the subscription will refuse it again.
				if (failure.rpc) return;
			} finally {
				work.done();
			}
			if (subscription) {
				if (this.#current !== record) {
					subscription.close();
					return;
				}
				this.#listChanges = subscription;
				const openedAt = Date.now();
				await subscription.ended;
				if (this.#listChanges === subscription) this.#listChanges = undefined;
				if (Date.now() - openedAt >= RESUBSCRIBE_MAX_MS) pauseMs = RESUBSCRIBE_MIN_MS;
			}
			if (this.#current !== record) return;
			const pause = Promise.withResolvers<void>();
			const timer = setTimeout(pause.resolve, pauseMs);
			timer.unref();
			await Promise.race([pause.promise, record.peer.closed]);
			clearTimeout(timer);
			pauseMs = Math.min(pauseMs * 2, RESUBSCRIBE_MAX_MS);
		}
	}

	#armIdle(): void {
		clearTimeout(this.#idleTimer);
		this.#idleTimer = undefined;
		const current = this.#current;
		if (this.#idleMs <= 0 || !current || this.#inflight > 0 || this.#forwarded > 0) return;
		if (this.era === "legacy" && current.sessionBearing) return;
		// Every change of activity re-arms the timer, so it only fires after a full quiet period.
		this.#idleTimer = setTimeout(() => void this.#stopPeer("idle"), this.#idleMs);
		this.#idleTimer.unref();
	}

	/** Stop the upstream, or the start in progress, on purpose; the status becomes `idle`. */
	async #stopPeer(reason: string): Promise<void> {
		this.#interruptStart(reason);
		this.#abortHostWork(reason);
		const record = this.#current;
		this.#current = undefined;
		this.#listChanges?.close();
		this.#listChanges = undefined;
		this.#armIdle();
		this.#lastExit = undefined;
		if (this.#state === "running" || this.#state === "failed") this.#setState("idle");
		if (!record) return;
		record.expected = true;
		const closing = record.peer.close(reason);
		this.#retire(closing);
		await closing.catch(() => {});
	}

	async #restart(): Promise<void> {
		this.#crashes = [];
		this.#refuseUntil = 0;
		this.#invalidate([DISCOVER_METHOD, ...LIST_METHODS]);
		for (const change of LIST_CHANGES) this.#fanOut(change, "host");
		await this.#stopPeer("restart requested");
	}

	// ── subscriptions ────────────────────────────────────────────────────────

	/**
	 * A notification on the host's own subscription. List changes and resource
	 * updates invalidate what the store holds; anything else is a server's own
	 * notification and goes, as it is, to every virtual listen.
	 */
	#upstreamNotified(method: string, params: Record<string, unknown>): void {
		const change = LIST_CHANGES.find(item => item.notification === method);
		if (change) {
			this.#invalidate(change.methods);
			this.#fanOut(change, "upstream");
			return;
		}
		if (method === RESOURCE_UPDATED_METHOD) {
			this.#resourceUpdated(params.uri);
			return;
		}
		for (const link of this.#links) {
			for (const [id, listen] of link.listens) {
				if (!listen.upstream) link.send(streamNotification(method, params, id));
			}
		}
	}

	/** Forget stored reads now that `uri` changed, and keep a read of it still in flight out of the store. */
	#resourceUpdated(uri: unknown): void {
		if (typeof uri === "string") this.#invalidate([RESOURCE_READ_METHOD], cacheParamsKey({ uri }));
	}

	/**
	 * Tell every subscribed link a list changed. A forwarded listen hears the
	 * upstream's own notifications on its stream, so only changes the host
	 * detected itself are added to it. Those reach every link that asked for
	 * the type, acknowledged or not: a server without `listChanged` has no
	 * other way to refresh a stale list in its sessions.
	 */
	#fanOut(change: ListChange, origin: "upstream" | "host"): void {
		for (const link of this.#links) {
			for (const [id, listen] of link.listens) {
				if (
					origin === "upstream" ? listen.upstream || !listen.filter[change.flag] : !listen.requested[change.flag]
				) {
					continue;
				}
				link.send(streamNotification(change.notification, {}, id));
			}
		}
	}

	async #listen(
		link: Link,
		id: RequestId,
		params: Record<string, unknown>,
		controller: AbortController,
	): Promise<void> {
		const filter = parseFilter(params.notifications);
		if (!filter) {
			link.requests.delete(id);
			link.send(
				errorResponse(id, {
					code: MCPErrorCode.InvalidParams,
					message: "subscriptions/listen requires a notifications filter",
				}),
			);
			return;
		}
		if (!hasResourceSubscriptions(filter)) {
			link.requests.delete(id);
			const acknowledged = supportedListChanges(filter, this.#stored(DISCOVER_METHOD, FIRST_PAGE)?.result);
			link.listens.set(id, { requested: filter, filter: acknowledged });
			link.send(streamNotification(MCP_SUBSCRIPTION_ACKNOWLEDGED, { notifications: acknowledged }, id));
			return;
		}
		const meta = isRecord(params._meta) ? params._meta : requestMeta();
		// Pinned from the first moment: the upstream must not idle-stop under a subscription being opened.
		this.#forwarded++;
		this.#armIdle();
		let record: PeerRecord | undefined;
		let subscription: McpPeerSubscription;
		const early: { method: string; params: Record<string, unknown> }[] = [];
		let acknowledged = false;
		try {
			this.#served = link;
			record = await this.#awaitPeer(controller.signal);
			controller.signal.throwIfAborted();
			record.sessionBearing = true;
			subscription = await record.peer.listen(
				filter,
				meta,
				(method, body) => {
					// The store must not answer with what the server just declared outdated.
					const change = LIST_CHANGES.find(item => item.notification === method);
					if (change) this.#invalidate(change.methods);
					else if (method === RESOURCE_UPDATED_METHOD) this.#resourceUpdated(body.uri);
					if (acknowledged) link.send(streamNotification(method, body, id));
					else early.push({ method, params: body });
				},
				controller.signal,
			);
		} catch (error) {
			this.#forwarded--;
			this.#armIdle();
			const failure = await this.#failure(error, record, "receive");
			if (link.requests.get(id) !== controller) return;
			link.requests.delete(id);
			link.send(errorResponse(id, this.#encode(failure)));
			return;
		}
		const listen: Listen = { requested: filter, filter: subscription.acknowledged, upstream: subscription };
		void subscription.ended.then(() => {
			this.#forwarded--;
			this.#armIdle();
			if (link.listens.get(id) !== listen) return;
			link.listens.delete(id);
			link.send(notification(CANCELLED_METHOD, { requestId: id }));
		});
		if (link.requests.get(id) !== controller) {
			subscription.close();
			return;
		}
		link.requests.delete(id);
		link.listens.set(id, listen);
		link.send(streamNotification(MCP_SUBSCRIPTION_ACKNOWLEDGED, { notifications: subscription.acknowledged }, id));
		acknowledged = true;
		for (const item of early) link.send(streamNotification(item.method, item.params, id));
	}
}
