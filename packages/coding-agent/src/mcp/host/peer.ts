/**
 * The seam inside the MCP host between the unit that serves sessions
 * (`endpoint.ts`) and whatever reaches the server (`peers.ts`).
 *
 * A {@link McpPeer} is one live upstream answering MCP 2026-07-28 requests,
 * whatever it natively speaks: a modern server is forwarded to as-is, a
 * handshake-era one sits behind an adapter that holds its `initialize`
 * session. Everything above the peer — multiplexing, caching, lifetime — is
 * era-blind.
 */
import type { ChildSpawn, ManagedChild, ManagedChildState } from "../../daemon/module";
import type { MCPDiscoverResult, MCPSubscriptionFilter } from "../protocol";
import type { McpEra, McpServerSpec, McpUpstreamExit } from "./contract";

/** A filesystem root a session exposes to servers. */
export interface McpRoot {
	uri: string;
	name?: string;
}

/** What a peer needs from its surroundings. */
export interface McpPeerDeps {
	/**
	 * Start the subprocess of a stdio upstream. In the daemon this is the
	 * module context's `spawn`, so the child's pipes cross a re-exec; in-process
	 * it is `spawnManagedChild`.
	 */
	spawn(spec: ChildSpawn): ManagedChild;
	/** Roots answered to a handshake-era upstream's `roots/list`, read at call time. */
	roots(): McpRoot[];
}

/** Options of {@link McpPeer.request}. */
export interface McpPeerRequestOptions {
	/** Aborting cancels the request upstream and rejects with the abort reason. */
	signal?: AbortSignal;
	/** Receives the `params` of each `notifications/progress` for this request, minus the token. */
	onProgress?: (progress: Record<string, unknown>) => void;
}

/** An open `subscriptions/listen` stream on a peer. */
export interface McpPeerSubscription {
	/** The subset of the requested filter the upstream honours. */
	readonly acknowledged: MCPSubscriptionFilter;
	/** Settles when the stream is over: closed here, torn down by the server, or the upstream went away. Never rejects. */
	readonly ended: Promise<void>;
	close(): void;
}

/** Serializable state that lets a subprocess peer cross a daemon re-exec; see {@link restorePeer}. */
export interface McpPeerState {
	child: ManagedChildState;
	/** Peer-private continuation state. */
	state: unknown;
}

/** One live upstream, spoken to in MCP 2026-07-28 terms. */
export interface McpPeer {
	readonly era: McpEra;
	/** Main process of a subprocess upstream. */
	readonly pid: number | undefined;
	/** Settles once the upstream is gone, however that happened. Never rejects. */
	readonly closed: Promise<McpUpstreamExit>;

	/**
	 * Send one request and resolve with its result object.
	 *
	 * `params` goes out as given: it carries the originating session's `_meta`
	 * and must hold neither a progress token (the peer assigns its own when
	 * `onProgress` is set) nor `omp/*` keys. The peer applies no deadline of its
	 * own; callers bound a request with `signal`.
	 *
	 * A handshake-era peer answers `server/discover` from its `initialize`
	 * result and completes every result with `resultType`, `ttlMs` and
	 * `cacheScope` as a modern server would.
	 *
	 * @throws MCPTransportError always. A server's JSON-RPC error has
	 * `failure: "json_rpc"` and the raw error in `rpc`.
	 */
	request(
		method: string,
		params: Record<string, unknown>,
		options?: McpPeerRequestOptions,
	): Promise<Record<string, unknown>>;

	/**
	 * Open a subscription and resolve once the upstream acknowledged it.
	 * `sink` receives each notification of the stream with the subscription id
	 * removed from its `_meta`. Aborting `signal` before the acknowledgement
	 * cancels the subscription upstream and rejects; afterwards it has no
	 * effect and {@link McpPeerSubscription.close} ends the stream.
	 *
	 * @throws MCPTransportError when the upstream rejects the subscription, goes away first, or `signal` aborts.
	 */
	listen(
		filter: MCPSubscriptionFilter,
		meta: Record<string, unknown>,
		sink: (method: string, params: Record<string, unknown>) => void,
		signal?: AbortSignal,
	): Promise<McpPeerSubscription>;

	/** Shut the upstream down: close its input, then terminate what remains. Resolves when it is gone. */
	close(reason: string): Promise<void>;

	/** State for {@link restorePeer}; undefined when this upstream cannot cross a re-exec. */
	snapshot(): McpPeerState | undefined;
}

/** What the era probe learned about a server. */
export interface McpProbeResult {
	era: McpEra;
	/**
	 * `server/discover` result to seed the store: the server's own, or one built
	 * from the `initialize` result of a handshake-era server.
	 */
	discover?: MCPDiscoverResult;
}

/** Entry points `peers.ts` and `probe.ts` implement; the unit and the module depend on these alone. */
export interface McpUpstreams {
	/**
	 * Decide a server's era on a throwaway upstream: a modern server answers
	 * `server/discover` (or rejects it with a modern-only error); anything else
	 * is a handshake-era server, confirmed by `initialize`. The upstream used
	 * for the probe is always closed again.
	 *
	 * @throws MCPTransportError when the server cannot be started or reached at all.
	 */
	probe(spec: McpServerSpec, deps: McpPeerDeps, signal?: AbortSignal): Promise<McpProbeResult>;

	/**
	 * Start the upstream and make it ready for requests; a handshake-era one has
	 * completed `initialize` when this resolves.
	 *
	 * @throws MCPTransportError on spawn, connect or handshake failure.
	 */
	start(spec: McpServerSpec, era: McpEra, deps: McpPeerDeps, signal?: AbortSignal): Promise<McpPeer>;

	/** Re-adopt a subprocess upstream after a daemon re-exec; undefined when its process is gone. */
	restore(
		spec: McpServerSpec,
		era: McpEra,
		state: McpPeerState,
		adopt: (child: ManagedChildState) => ManagedChild | undefined,
		deps: McpPeerDeps,
	): McpPeer | undefined;
}
