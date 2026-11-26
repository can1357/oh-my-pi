/**
 * The upstreams behind the {@link McpPeer} seam: a modern peer that forwards
 * MCP 2026-07-28 as-is, a legacy peer that holds a handshake-era server's
 * `initialize` session and presents it in modern terms, the probe that tells
 * the two apart, and re-adoption of subprocess peers after a daemon re-exec.
 */
import { isRecord, logger } from "@oh-my-pi/pi-utils";
import type { ManagedChild, ManagedChildState } from "../../daemon/module";
import { type MCPTransportKind, MCPTransportError, normalizeMCPTransportError } from "../errors";
import {
	isModernErrorCode,
	MCP_LEGACY_PROTOCOL_VERSION,
	MCP_PROTOCOL_VERSION,
	MCP_SUBSCRIPTION_ACKNOWLEDGED,
	type MCPDiscoverResult,
	MCPErrorCode,
	MCPMeta,
	type MCPSubscriptionFilter,
	requestMeta,
	subscriptionIdOf,
} from "../protocol";
import { type MCPInitializeResult, MCPNotificationMethods, type MCPRequestOptions } from "../types";
import type { McpEra, McpServerSpec, McpUpstreamExit } from "./contract";
import { encodeMcpHeaderValue, HttpUpstream } from "./http-upstream";
import { openLegacySession, parseInitializeResult } from "./legacy-session";
import type {
	McpPeer,
	McpPeerDeps,
	McpPeerRequestOptions,
	McpPeerState,
	McpPeerSubscription,
	McpProbeResult,
	McpUpstreams,
} from "./peer";
import { SseUpstream } from "./sse-upstream";
import { StdioUpstream, type StdioUpstreamState } from "./stdio-upstream";
import { MCP_LEGACY_TTL_MS } from "./store";

type Upstream = StdioUpstream | HttpUpstream | SseUpstream;

/** Bound of the era probe when the spec disables its own. */
const PROBE_TIMEOUT_MS = 30_000;
/**
 * How long a server that answered `initialize` may still answer the
 * `server/discover` written after it. A server of both eras answers both; the
 * modern answer wins. A handshake-era server that refuses the method or
 * ignores it is classified from the `initialize` session instead.
 */
const PROBE_DISCOVER_GRACE_MS = 250;

const LIST_METHODS: Record<string, true> = {
	"tools/list": true,
	"prompts/list": true,
	"resources/list": true,
	"resources/templates/list": true,
};

const RESERVED_META_PREFIX = "io.modelcontextprotocol/";

/** Bound of the modern HTTP peer's own `tools/list` fetch when the spec disables its own. */
const TOOLS_LOAD_TIMEOUT_MS = 30_000;

/** Server notifications a legacy peer keeps for the first subscription while none is open. */
const LEGACY_NOTIFICATION_BACKLOG = 100;

/** A server notification as the peers pass it on. */
interface ServerNotification {
	method: string;
	params: Record<string, unknown>;
}

function upstreamFor(spec: McpServerSpec, era: McpEra): Upstream {
	if (spec.transport === "stdio") return new StdioUpstream(spec);
	if (spec.transport === "http") return new HttpUpstream(spec, era);
	if (era === "modern") {
		throw new MCPTransportError({
			transport: "http",
			stage: "connect",
			failure: "unknown",
			message: "The HTTP+SSE transport predates MCP 2026-07-28; configure the server as http",
			retryable: false,
		});
	}
	return new SseUpstream(spec);
}

function connectUpstream(upstream: Upstream, deps: McpPeerDeps, signal: AbortSignal | undefined): Promise<void> {
	if (upstream instanceof StdioUpstream) return upstream.connect(deps.spawn, signal);
	if (upstream instanceof SseUpstream) return upstream.connect(signal);
	return upstream.connect();
}

/** `error` as an {@link MCPTransportError}, with a subprocess's stderr tail appended: it usually names the cause. */
function startError(error: unknown, upstream: Upstream): MCPTransportError {
	const normalized = normalizeMCPTransportError(error, {
		transport: upstream instanceof StdioUpstream ? "stdio" : "http",
		stage: "connect",
	});
	const stderr = upstream instanceof StdioUpstream ? upstream.stderrTail().trim() : "";
	if (stderr.length === 0) return normalized;
	return new MCPTransportError({
		transport: normalized.transport,
		stage: normalized.stage,
		failure: normalized.failure,
		message: `${normalized.message}\n${stderr}`,
		retryable: normalized.retryable,
		code: normalized.code,
		data: normalized.data,
		traceId: normalized.traceId,
		rpc: normalized.rpc,
		cause: normalized,
	});
}

/** The `server/discover` answer a handshake-era server would give, built from its `initialize` result. */
function legacyDiscover(session: MCPInitializeResult): MCPDiscoverResult {
	return {
		resultType: "complete",
		supportedVersions: [MCP_PROTOCOL_VERSION],
		capabilities: session.capabilities,
		instructions: session.instructions,
		ttlMs: MCP_LEGACY_TTL_MS,
		cacheScope: "private",
		_meta: { [MCPMeta.serverInfo]: session.serverInfo },
	};
}

function discoverResultOf(value: unknown): MCPDiscoverResult | undefined {
	if (!isRecord(value) || !Array.isArray(value.supportedVersions) || !isRecord(value.capabilities)) return undefined;
	const supportedVersions = value.supportedVersions.filter(
		(version): version is string => typeof version === "string",
	);
	// A server that does not speak this revision is handshake-era, whatever else its discover answer says.
	if (!supportedVersions.includes(MCP_PROTOCOL_VERSION)) return undefined;
	return { ...value, supportedVersions, capabilities: value.capabilities };
}

/** The server requests a handshake-era upstream may send: liveness and the session's roots. */
function legacyRequestHandler(deps: McpPeerDeps): (method: string) => Promise<unknown> {
	return async method => {
		if (method === "ping") return {};
		if (method === "roots/list") return { roots: deps.roots() };
		throw Object.assign(new Error(`Unsupported server request: ${method}`), { code: MCPErrorCode.MethodNotFound });
	};
}

function subscriptionFilterOf(value: unknown): MCPSubscriptionFilter {
	const filter: MCPSubscriptionFilter = {};
	if (!isRecord(value)) return filter;
	if (value.toolsListChanged === true) filter.toolsListChanged = true;
	if (value.promptsListChanged === true) filter.promptsListChanged = true;
	if (value.resourcesListChanged === true) filter.resourcesListChanged = true;
	if (Array.isArray(value.resourceSubscriptions)) {
		filter.resourceSubscriptions = value.resourceSubscriptions.filter(
			(uri): uri is string => typeof uri === "string",
		);
	}
	return filter;
}

/**
 * One upstream as both peers use it: requests that always fail with an
 * {@link MCPTransportError}, progress delivered only until the request is
 * answered, and a `closed` promise that carries the exit.
 */
class PeerWire {
	readonly upstream: Upstream;
	readonly kind: MCPTransportKind;
	readonly closed: Promise<McpUpstreamExit>;
	/** Every server notification except progress. */
	onNotification: (method: string, params: Record<string, unknown>) => void = () => {};

	constructor(upstream: Upstream) {
		this.upstream = upstream;
		if (upstream instanceof StdioUpstream) {
			this.kind = "stdio";
			this.closed = upstream.exited;
		} else {
			this.kind = "http";
			const gone = Promise.withResolvers<McpUpstreamExit>();
			this.closed = gone.promise;
			// A handshake-era stream that ends on its own took the session with it.
			upstream.onClose = () => {
				gone.resolve({ stderr: "" });
				void upstream.close().catch(() => {});
			};
		}
		upstream.onNotification = (method, params) => {
			// Progress belongs to one request: the upstream hands it to that request's callback.
			if (method === MCPNotificationMethods.PROGRESS) return;
			try {
				this.onNotification(method, isRecord(params) ? params : {});
			} catch (error) {
				logger.debug("MCP notification handler failed", { method, error });
			}
		};
	}

	get pid(): number | undefined {
		return this.upstream instanceof StdioUpstream ? this.upstream.pid : undefined;
	}

	/** @throws MCPTransportError always; an abort is normalized too. */
	async call(
		method: string,
		params: Record<string, unknown>,
		options?: McpPeerRequestOptions & Pick<MCPRequestOptions, "onRequestId">,
	): Promise<Record<string, unknown>> {
		const onProgress = options?.onProgress;
		try {
			const result = await this.upstream.request<unknown>(method, params, {
				signal: options?.signal,
				onRequestId: options?.onRequestId,
				// The upstream tags the request and stops routing the moment it is answered,
				// so progress a server sends after its result never reaches the caller.
				onProgress: onProgress && (progress => onProgress({ ...progress })),
			});
			if (!isRecord(result)) {
				throw new MCPTransportError({
					transport: this.kind,
					stage: "decode",
					failure: "malformed_response",
					message: `MCP server answered ${method} with a result that is not an object`,
					retryable: false,
				});
			}
			return result;
		} catch (error) {
			throw normalizeMCPTransportError(error, { transport: this.kind, stage: "receive" });
		}
	}

	/** Best-effort notification: an upstream that is gone has no use for it. */
	notify(method: string, params: Record<string, unknown>): void {
		void this.upstream.notify(method, params).catch(() => {});
	}

	/** The rejection for a caller whose `signal` aborted. */
	aborted(signal: AbortSignal | undefined): MCPTransportError {
		return normalizeMCPTransportError(signal?.reason ?? new Error("Aborted"), {
			transport: this.kind,
			stage: "receive",
		});
	}

	lost(): MCPTransportError {
		return new MCPTransportError({
			transport: this.kind,
			stage: "receive",
			failure: "closed",
			message: "MCP upstream went away",
			retryable: false,
		});
	}

	/** The subprocess state both peers' snapshots start from. */
	snapshot(): { child: ManagedChildState; state: StdioUpstreamState } | undefined {
		return this.upstream instanceof StdioUpstream ? this.upstream.snapshot() : undefined;
	}
}

// ── x-mcp-header ───────────────────────────────────────────────────────────

/** A tool argument a Streamable HTTP client must mirror into an `Mcp-Param-*` header. */
interface ParamHeader {
	/** The `x-mcp-header` value. */
	name: string;
	/** `properties` keys from the arguments object down to the value. */
	path: string[];
}

const HTTP_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const HEADER_PARAM_TYPES: Record<string, true> = { integer: true, string: true, boolean: true };
const PARAM_HEADER_KEY = "x-mcp-header";

/** Collect the annotations reachable through `properties` chains; false when one of them is invalid. */
function collectParamHeaders(
	schema: Record<string, unknown>,
	path: string[],
	found: ParamHeader[],
	names: Set<string>,
): boolean {
	const properties = schema.properties;
	if (!isRecord(properties)) return true;
	for (const key in properties) {
		const property = properties[key];
		if (!isRecord(property)) continue;
		const propertyPath = [...path, key];
		if (Object.hasOwn(property, PARAM_HEADER_KEY)) {
			const name = property[PARAM_HEADER_KEY];
			if (typeof name !== "string" || !HTTP_TOKEN.test(name)) return false;
			if (typeof property.type !== "string" || !Object.hasOwn(HEADER_PARAM_TYPES, property.type)) return false;
			const lower = name.toLowerCase();
			if (names.has(lower)) return false;
			names.add(lower);
			found.push({ name, path: propertyPath });
		}
		if (!collectParamHeaders(property, propertyPath, found, names)) return false;
	}
	return true;
}

/**
 * JSON Schema keywords whose value is one subschema or a list of them. `then`
 * belongs here too but is tested by name: a table with that key is a thenable.
 */
const SUBSCHEMA_KEYWORDS: Record<string, true> = {
	items: true,
	prefixItems: true,
	additionalItems: true,
	unevaluatedItems: true,
	contains: true,
	additionalProperties: true,
	unevaluatedProperties: true,
	propertyNames: true,
	allOf: true,
	anyOf: true,
	oneOf: true,
	not: true,
	if: true,
	else: true,
	contentSchema: true,
};

/** JSON Schema keywords whose value maps names to subschemas; the names are not keywords. */
const SUBSCHEMA_MAP_KEYWORDS: Record<string, true> = {
	properties: true,
	patternProperties: true,
	dependentSchemas: true,
	dependencies: true,
	$defs: true,
	definitions: true,
};

/**
 * Every annotation at a schema position, including the positions where none
 * is allowed (`items`, combinators, `$defs`). Instance-valued keywords
 * (`default`, `const`, `examples`, `enum`) hold data, not schemas: an
 * `x-mcp-header` key inside them is not an annotation.
 */
function countParamHeaders(schema: unknown): number {
	if (!isRecord(schema)) return 0;
	let count = Object.hasOwn(schema, PARAM_HEADER_KEY) ? 1 : 0;
	for (const key in schema) {
		const value = schema[key];
		if (Object.hasOwn(SUBSCHEMA_MAP_KEYWORDS, key)) {
			if (isRecord(value)) for (const name in value) count += countParamHeaders(value[name]);
		} else if (key === "then" || Object.hasOwn(SUBSCHEMA_KEYWORDS, key)) {
			if (Array.isArray(value)) for (const entry of value) count += countParamHeaders(entry);
			else count += countParamHeaders(value);
		}
	}
	return count;
}

/**
 * The `Mcp-Param-*` headers a tool's `inputSchema` asks for; undefined when
 * an `x-mcp-header` annotation breaks the specification's constraints (empty
 * or non-token name, duplicate name, non-primitive type, or a position not
 * reachable through `properties` alone), which disqualifies the tool.
 */
function paramHeadersOf(inputSchema: unknown): ParamHeader[] | undefined {
	if (!isRecord(inputSchema)) return [];
	const found: ParamHeader[] = [];
	if (!collectParamHeaders(inputSchema, [], found, new Set())) return undefined;
	return countParamHeaders(inputSchema) === found.length ? found : undefined;
}

// ── modern peer ────────────────────────────────────────────────────────────

/** The modern HTTP peer's own `tools/list` fetch, shared by the calls waiting on it. */
interface ToolsLoad {
	done: Promise<void>;
	/** Calls still waiting; the fetch is aborted when the last one leaves. */
	waiters: number;
	controller: AbortController;
}

interface ModernListen {
	sink(method: string, params: Record<string, unknown>): void;
	acknowledge(filter: MCPSubscriptionFilter): void;
	close(): void;
}

/** A 2026-07-28 server: requests pass through; on Streamable HTTP the peer adds the `Mcp-Param-*` mirror. */
class ModernPeer implements McpPeer {
	readonly era = "modern";
	readonly closed: Promise<McpUpstreamExit>;
	readonly #wire: PeerWire;
	/** Open `subscriptions/listen` streams by request id, which tags their notifications. */
	readonly #listens = new Map<string | number, ModernListen>();
	/**
	 * Streamable HTTP only: header annotations by tool name, learned from the
	 * `tools/list` pages that passed through. A tool whose annotations are
	 * invalid maps to none and is dropped from the list.
	 */
	readonly #paramHeaders = new Map<string, ParamHeader[]>();
	readonly #toolsLoadTimeoutMs: number;
	#toolsLoad: ToolsLoad | undefined;

	constructor(wire: PeerWire, timeoutMs: number) {
		this.#wire = wire;
		this.#toolsLoadTimeoutMs = timeoutMs > 0 ? timeoutMs : TOOLS_LOAD_TIMEOUT_MS;
		this.closed = wire.closed;
		wire.onNotification = (method, params) => this.#onNotification(method, params);
		void wire.closed.then(() => {
			for (const listen of this.#listens.values()) listen.close();
		});
		if (wire.upstream instanceof HttpUpstream) {
			wire.upstream.requestHeaders = (method, params) => this.#mcpParamHeaders(method, params);
		}
	}

	get pid(): number | undefined {
		return this.#wire.pid;
	}

	#onNotification(method: string, params: Record<string, unknown>): void {
		if (method === "notifications/cancelled") {
			// A server tears a subscription down by cancelling its listen request.
			const id = params.requestId;
			if (typeof id === "string" || typeof id === "number") this.#listens.get(id)?.close();
			return;
		}
		const id = subscriptionIdOf(params);
		const listen = id === undefined ? undefined : this.#listens.get(id);
		if (!listen) return;
		if (method === MCP_SUBSCRIPTION_ACKNOWLEDGED) {
			listen.acknowledge(subscriptionFilterOf(params.notifications));
			return;
		}
		const meta = isRecord(params._meta) ? { ...params._meta } : {};
		delete meta[MCPMeta.subscriptionId];
		listen.sink(method, { ...params, _meta: meta });
	}

	async request(
		method: string,
		params: Record<string, unknown>,
		options?: McpPeerRequestOptions,
	): Promise<Record<string, unknown>> {
		if (!(this.#wire.upstream instanceof HttpUpstream)) return this.#wire.call(method, params, options);
		if (method === "tools/list") {
			return this.#admitTools(await this.#wire.call(method, params, options), params.cursor === undefined);
		}
		if (method !== "tools/call") return this.#wire.call(method, params, options);

		const meta = isRecord(params._meta) ? params._meta : {};
		// The list may have been served from the host's store without ever passing through here.
		if (typeof params.name === "string" && !this.#paramHeaders.has(params.name)) {
			await this.#loadTools(meta, options?.signal);
		}
		try {
			return await this.#wire.call(method, params, options);
		} catch (error) {
			if (!(error instanceof MCPTransportError) || error.rpc?.code !== MCPErrorCode.HeaderMismatch) throw error;
			// The tool's schema changed under us: relearn its headers and retry once.
			await this.#loadTools(meta, options?.signal);
			return this.#wire.call(method, params, options);
		}
	}

	/** Record the header annotations of a `tools/list` page and drop the tools whose annotations are invalid. */
	#admitTools(result: Record<string, unknown>, firstPage: boolean): Record<string, unknown> {
		if (firstPage) this.#paramHeaders.clear();
		if (!Array.isArray(result.tools)) return result;
		const admitted: unknown[] = [];
		for (const tool of result.tools) {
			if (!isRecord(tool) || typeof tool.name !== "string") {
				admitted.push(tool);
				continue;
			}
			const headers = paramHeadersOf(tool.inputSchema);
			this.#paramHeaders.set(tool.name, headers ?? []);
			if (headers) admitted.push(tool);
			else logger.warn("Dropped an MCP tool with an invalid x-mcp-header annotation", { tool: tool.name });
		}
		return admitted.length === result.tools.length ? result : { ...result, tools: admitted };
	}

	/**
	 * Wait for the header annotations of every tool: one `tools/list` fetch
	 * (all pages, with the first caller's `_meta`) shared by the calls that
	 * need it. A caller whose `signal` aborts leaves at once; the fetch itself
	 * is aborted when no caller is left, and bounded by the spec's timeout.
	 *
	 * @throws MCPTransportError when the fetch fails or times out, or `signal` aborts.
	 */
	async #loadTools(meta: Record<string, unknown>, signal: AbortSignal | undefined): Promise<void> {
		if (signal?.aborted) throw this.#wire.aborted(signal);
		let load = this.#toolsLoad;
		if (!load) {
			const controller = new AbortController();
			const bounded = AbortSignal.any([controller.signal, AbortSignal.timeout(this.#toolsLoadTimeoutMs)]);
			const started: ToolsLoad = { done: this.#fetchTools(meta, bounded), waiters: 0, controller };
			// Each waiter observes the outcome; a fetch they all left must not surface as unhandled.
			void started.done
				.catch(() => {})
				.then(() => {
					if (this.#toolsLoad === started) this.#toolsLoad = undefined;
				});
			this.#toolsLoad = started;
			load = started;
		}
		load.waiters++;
		const left = Promise.withResolvers<never>();
		const onAbort = (): void => left.reject(this.#wire.aborted(signal));
		signal?.addEventListener("abort", onAbort, { once: true });
		try {
			await Promise.race([load.done, left.promise]);
		} finally {
			signal?.removeEventListener("abort", onAbort);
			if (--load.waiters === 0) {
				if (this.#toolsLoad === load) this.#toolsLoad = undefined;
				load.controller.abort();
			}
		}
	}

	async #fetchTools(meta: Record<string, unknown>, signal: AbortSignal): Promise<void> {
		let cursor: string | undefined;
		do {
			const result = await this.#wire.call(
				"tools/list",
				cursor === undefined ? { _meta: meta } : { cursor, _meta: meta },
				{ signal },
			);
			this.#admitTools(result, cursor === undefined);
			cursor = typeof result.nextCursor === "string" ? result.nextCursor : undefined;
		} while (cursor !== undefined);
	}

	#mcpParamHeaders(method: string, params: Record<string, unknown>): Record<string, string> | undefined {
		if (method !== "tools/call" || typeof params.name !== "string") return undefined;
		const annotations = this.#paramHeaders.get(params.name);
		if (!annotations || annotations.length === 0) return undefined;
		const headers: Record<string, string> = {};
		for (const annotation of annotations) {
			let value: unknown = params.arguments;
			for (const key of annotation.path) value = isRecord(value) ? value[key] : undefined;
			// Absent and null arguments have no header.
			if (
				typeof value === "string" ||
				typeof value === "boolean" ||
				(typeof value === "number" && Number.isInteger(value))
			) {
				headers[`Mcp-Param-${annotation.name}`] = encodeMcpHeaderValue(value);
			}
		}
		return headers;
	}

	async listen(
		filter: MCPSubscriptionFilter,
		meta: Record<string, unknown>,
		sink: (method: string, params: Record<string, unknown>) => void,
		signal?: AbortSignal,
	): Promise<McpPeerSubscription> {
		if (signal?.aborted) throw this.#wire.aborted(signal);
		const controller = new AbortController();
		const acknowledged = Promise.withResolvers<MCPSubscriptionFilter>();
		const ended = Promise.withResolvers<void>();
		let id: string | number | undefined;
		const end = (error: MCPTransportError): void => {
			if (id !== undefined) this.#listens.delete(id);
			acknowledged.reject(error);
			ended.resolve();
		};
		const cancel = (error: MCPTransportError): void => {
			// Aborting is the cancellation: `notifications/cancelled` on stdio, the closed stream on HTTP.
			controller.abort();
			end(error);
		};
		const close = (): void => cancel(this.#wire.lost());
		void this.#wire
			.call(
				"subscriptions/listen",
				{ notifications: filter, _meta: meta },
				{
					signal: controller.signal,
					onRequestId: allocated => {
						id = allocated;
						this.#listens.set(allocated, { sink, acknowledge: acknowledged.resolve, close });
					},
				},
			)
			.then(
				// A response to the listen request is the server's graceful end of the stream.
				() => end(this.#wire.lost()),
				error => end(normalizeMCPTransportError(error, { transport: this.#wire.kind, stage: "receive" })),
			);
		// The caller's signal covers the wait for the acknowledgement only; afterwards `close` ends the stream.
		const onAbort = (): void => cancel(this.#wire.aborted(signal));
		signal?.addEventListener("abort", onAbort, { once: true });
		try {
			return { acknowledged: await acknowledged.promise, ended: ended.promise, close };
		} finally {
			signal?.removeEventListener("abort", onAbort);
		}
	}

	async close(reason: string): Promise<void> {
		logger.debug("Closing MCP upstream", { reason, pid: this.pid });
		await this.#wire.upstream.close();
	}

	snapshot(): McpPeerState | undefined {
		const base = this.#wire.snapshot();
		// The sessions behind the open listens do not survive a re-exec; `restore` cancels them upstream.
		return base && { child: base.child, state: { transport: base.state, listens: [...this.#listens.keys()] } };
	}
}

// ── legacy peer ────────────────────────────────────────────────────────────

interface LegacyListen {
	acknowledged: MCPSubscriptionFilter;
	uris: Set<string>;
	sink(method: string, params: Record<string, unknown>): void;
	end(): void;
}

/** One `resources/subscribe` towards the server, shared by every subscription that lists the URI. */
interface UriHold {
	/** Subscriptions, open or still opening, that list the URI. */
	holders: number;
	state: "pending" | "subscribed" | "failed";
	/** Settles with the server's answer to the subscribe. */
	ready: Promise<void>;
}

const LEGACY_FILTERED_NOTIFICATIONS: Record<string, true> = {
	[MCPNotificationMethods.TOOLS_LIST_CHANGED]: true,
	[MCPNotificationMethods.PROMPTS_LIST_CHANGED]: true,
	[MCPNotificationMethods.RESOURCES_LIST_CHANGED]: true,
	[MCPNotificationMethods.RESOURCES_UPDATED]: true,
};

/** A handshake-era server behind its `initialize` session, answering in MCP 2026-07-28 terms. */
class LegacyPeer implements McpPeer {
	readonly era = "legacy";
	readonly closed: Promise<McpUpstreamExit>;
	readonly #wire: PeerWire;
	readonly #session: MCPInitializeResult;
	readonly #listens = new Set<LegacyListen>();
	/** The `resources/subscribe` behind each URI some subscription lists. */
	readonly #subscribed = new Map<string, UriHold>();
	/**
	 * Server-defined notifications that arrived while no subscription was
	 * open; the first one to open receives them. Oldest dropped beyond
	 * {@link LEGACY_NOTIFICATION_BACKLOG}.
	 */
	readonly #backlog: ServerNotification[] = [];

	/**
	 * `wire`'s upstream already answers server requests
	 * ({@link legacyRequestHandler}) and holds `session`. `earlier` are the
	 * notifications the server sent before this peer existed: during the
	 * handshake, or before a re-exec.
	 */
	constructor(wire: PeerWire, session: MCPInitializeResult, earlier: ServerNotification[]) {
		this.#wire = wire;
		this.#session = session;
		this.closed = wire.closed;
		for (const notification of earlier) this.#onNotification(notification.method, notification.params);
		wire.onNotification = (method, params) => this.#onNotification(method, params);
		void wire.closed.then(() => {
			this.#subscribed.clear();
			for (const listen of this.#listens) listen.end();
		});
	}

	get pid(): number | undefined {
		return this.#wire.pid;
	}

	#onNotification(method: string, params: Record<string, unknown>): void {
		// A handshake-era server cancels only requests of its own; there is nothing of ours to end.
		if (method === "notifications/cancelled") return;
		if (!Object.hasOwn(LEGACY_FILTERED_NOTIFICATIONS, method)) {
			// Server-defined: no filter flag selects it, so every subscription gets it as sent.
			if (this.#listens.size === 0) {
				this.#backlog.push({ method, params });
				if (this.#backlog.length > LEGACY_NOTIFICATION_BACKLOG) this.#backlog.shift();
				return;
			}
			for (const listen of this.#listens) this.#deliver(listen, method, params);
			return;
		}
		for (const listen of this.#listens) {
			const wanted =
				method === MCPNotificationMethods.TOOLS_LIST_CHANGED
					? listen.acknowledged.toolsListChanged
					: method === MCPNotificationMethods.PROMPTS_LIST_CHANGED
						? listen.acknowledged.promptsListChanged
						: method === MCPNotificationMethods.RESOURCES_LIST_CHANGED
							? listen.acknowledged.resourcesListChanged
							: typeof params.uri === "string" && listen.uris.has(params.uri);
			if (wanted) this.#deliver(listen, method, params);
		}
	}

	/** One subscription's failing sink must not cost the others their notification. */
	#deliver(listen: LegacyListen, method: string, params: Record<string, unknown>): void {
		try {
			listen.sink(method, params);
		} catch (error) {
			logger.debug("MCP subscription sink failed", { method, error });
		}
	}

	async request(
		method: string,
		params: Record<string, unknown>,
		options?: McpPeerRequestOptions,
	): Promise<Record<string, unknown>> {
		if (method === "server/discover") return { ...legacyDiscover(this.#session) };

		// A handshake-era server knows neither MRTR fields nor per-request metadata.
		const { _meta, ...legacyParams } = params;
		delete legacyParams.inputResponses;
		delete legacyParams.requestState;
		if (isRecord(_meta)) {
			const meta: Record<string, unknown> = {};
			let kept = false;
			for (const key in _meta) {
				if (key.startsWith(RESERVED_META_PREFIX)) continue;
				meta[key] = _meta[key];
				kept = true;
			}
			if (kept) legacyParams._meta = meta;
		}

		let result: Record<string, unknown>;
		try {
			result = await this.#wire.call(method, legacyParams, options);
		} catch (error) {
			const unsupported = error instanceof MCPTransportError && error.rpc?.code === MCPErrorCode.MethodNotFound;
			// Servers without resource templates commonly do not implement the method at all.
			if (method !== "resources/templates/list" || !unsupported) throw error;
			result = { resourceTemplates: [] };
		}
		if (Object.hasOwn(LIST_METHODS, method)) {
			return { ...result, resultType: "complete", ttlMs: MCP_LEGACY_TTL_MS, cacheScope: "private" };
		}
		if (method === "resources/read") return { ...result, resultType: "complete", ttlMs: 0, cacheScope: "private" };
		return { ...result, resultType: "complete" };
	}

	async listen(
		filter: MCPSubscriptionFilter,
		_meta: Record<string, unknown>,
		sink: (method: string, params: Record<string, unknown>) => void,
		signal?: AbortSignal,
	): Promise<McpPeerSubscription> {
		if (signal?.aborted) throw this.#wire.aborted(signal);
		const capabilities = this.#session.capabilities;
		const acknowledged: MCPSubscriptionFilter = {};
		if (filter.toolsListChanged && capabilities.tools?.listChanged) acknowledged.toolsListChanged = true;
		if (filter.promptsListChanged && capabilities.prompts?.listChanged) acknowledged.promptsListChanged = true;
		if (filter.resourcesListChanged && capabilities.resources?.listChanged) acknowledged.resourcesListChanged = true;
		const uris = new Set(capabilities.resources?.subscribe ? filter.resourceSubscriptions : undefined);
		if (uris.size > 0) acknowledged.resourceSubscriptions = [...uris];

		// Acknowledged only once the server accepted every URI; until then `signal` can still call it off.
		const holds: [string, UriHold][] = [];
		for (const uri of uris) holds.push([uri, this.#hold(uri)]);
		const left = Promise.withResolvers<never>();
		const onAbort = (): void => left.reject(this.#wire.aborted(signal));
		signal?.addEventListener("abort", onAbort, { once: true });
		try {
			await Promise.race([Promise.all(holds.map(([, hold]) => hold.ready)), left.promise]);
		} catch (error) {
			for (const [uri, hold] of holds) this.#release(uri, hold);
			throw error;
		} finally {
			signal?.removeEventListener("abort", onAbort);
		}

		const ended = Promise.withResolvers<void>();
		const listen: LegacyListen = { acknowledged, uris, sink, end: ended.resolve };
		this.#listens.add(listen);
		for (const notification of this.#backlog.splice(0)) {
			this.#deliver(listen, notification.method, notification.params);
		}
		return {
			acknowledged,
			ended: ended.promise,
			close: () => {
				if (!this.#listens.delete(listen)) return;
				for (const [uri, hold] of holds) this.#release(uri, hold);
				ended.resolve();
			},
		};
	}

	/**
	 * Take a hold on `uri`, sending `resources/subscribe` when nobody holds it
	 * yet. Everyone who takes the URI while that request is pending shares its
	 * outcome; a refused subscribe is forgotten, so the next hold asks again.
	 */
	#hold(uri: string): UriHold {
		let hold = this.#subscribed.get(uri);
		if (!hold) {
			const ready = Promise.withResolvers<void>();
			// Whoever holds the URI awaits this; a subscribe nobody waits for any more must not surface as unhandled.
			void ready.promise.catch(() => {});
			const requested: UriHold = { holders: 0, state: "pending", ready: ready.promise };
			void this.#wire.call("resources/subscribe", { uri }).then(
				() => {
					requested.state = "subscribed";
					// Everyone who wanted it left while the server was answering.
					if (requested.holders === 0) this.#unsubscribe(uri, requested);
					ready.resolve();
				},
				error => {
					requested.state = "failed";
					if (this.#subscribed.get(uri) === requested) this.#subscribed.delete(uri);
					ready.reject(error);
				},
			);
			this.#subscribed.set(uri, requested);
			hold = requested;
		}
		hold.holders++;
		return hold;
	}

	/** Drop one hold; the last one on an accepted subscribe unsubscribes upstream. */
	#release(uri: string, hold: UriHold): void {
		if (--hold.holders === 0 && hold.state === "subscribed") this.#unsubscribe(uri, hold);
	}

	#unsubscribe(uri: string, hold: UriHold): void {
		if (this.#subscribed.get(uri) === hold) this.#subscribed.delete(uri);
		if (this.#wire.upstream.connected) void this.#wire.call("resources/unsubscribe", { uri }).catch(() => {});
	}

	async close(reason: string): Promise<void> {
		logger.debug("Closing MCP upstream", { reason, pid: this.pid });
		await this.#wire.upstream.close();
	}

	snapshot(): McpPeerState | undefined {
		const base = this.#wire.snapshot();
		// The session lives in the child, so `restore` continues it; the subscriptions' owners do not survive.
		return (
			base && {
				child: base.child,
				state: {
					transport: base.state,
					session: this.#session,
					subscribed: [...this.#subscribed.keys()],
					backlog: this.#backlog,
				},
			}
		);
	}
}

// ── probe ──────────────────────────────────────────────────────────────────

type Outcome<T = unknown> = { value: T } | { error: unknown };

function outcomeOf<T>(request: Promise<T>): Promise<Outcome<T>> {
	return request.then(
		value => ({ value }),
		error => ({ error }),
	);
}

const LEGACY_PROTOCOL_VERSIONS = new Set([MCP_LEGACY_PROTOCOL_VERSION, "2025-06-18", "2025-03-26", "2024-11-05"]);

/**
 * The era a failed `server/discover` names by itself: `modern` for an error
 * only a 2026-07-28 server emits, `legacy` when the server rejects this
 * revision while listing a handshake-era one it does speak. Undefined when the
 * failure says nothing either way.
 */
function eraOfDiscoverError(error: unknown): McpEra | undefined {
	if (!(error instanceof MCPTransportError) || error.rpc === undefined) return undefined;
	if (error.rpc.code !== MCPErrorCode.UnsupportedProtocolVersion) {
		return isModernErrorCode(error.rpc.code) ? "modern" : undefined;
	}
	// Only an explicit compatible revision warrants trying the legacy handshake.
	const supported = isRecord(error.rpc.data) ? error.rpc.data.supported : undefined;
	const handshake =
		Array.isArray(supported) &&
		supported.every(version => typeof version === "string") &&
		supported.some(version => LEGACY_PROTOCOL_VERSIONS.has(version));
	return handshake ? "legacy" : "modern";
}

/**
 * Probe a subprocess with `initialize` first: the handshake era requires it as
 * the very first request — strict servers such as rmcp exit on anything else —
 * and `server/discover`, asked only once the handshake is done, names the
 * modern ones.
 */
async function probeStdio(upstream: StdioUpstream, deps: McpPeerDeps, signal: AbortSignal): Promise<McpProbeResult> {
	upstream.onRequest = legacyRequestHandler(deps);
	await upstream.connect(deps.spawn, signal);
	const initialized = await outcomeOf(openLegacySession(upstream, signal));
	if ("error" in initialized) {
		// The server refused the legacy handshake: it may be of the 2026-07-28
		// era alone, so ask its own question before giving up.
		const discovered = await outcomeOf(upstream.request("server/discover", { _meta: requestMeta() }, { signal }));
		if ("error" in discovered) {
			if (eraOfDiscoverError(discovered.error) === "modern") return { era: "modern" };
		} else {
			const result = discoverResultOf(discovered.value);
			if (result) return { era: "modern", discover: result };
		}
		throw initialized.error;
	}
	const discovered = await Promise.race([
		outcomeOf(upstream.request("server/discover", { _meta: requestMeta() }, { signal })),
		Bun.sleep(PROBE_DISCOVER_GRACE_MS).then(() => undefined),
	]);
	if (discovered && !("error" in discovered)) {
		const result = discoverResultOf(discovered.value);
		if (result) return { era: "modern", discover: result };
	}
	return { era: "legacy", discover: legacyDiscover(initialized.value) };
}

/** The HTTP status behind a failed modern POST, whether or not its body was a JSON-RPC error. */
function httpStatusOf(error: MCPTransportError): number | undefined {
	const status = error.failure === "http_status" ? error : error.cause;
	return status instanceof MCPTransportError && status.failure === "http_status" && typeof status.code === "number"
		? status.code
		: undefined;
}

/**
 * Statuses a handshake-era endpoint gives a POST it cannot read as one of its
 * own requests; 415 is rmcp 0.2, which fails to deserialize an unknown
 * method. Auth challenges (401/403) are never among them.
 */
const LEGACY_HTTP_STATUS: Record<number, true> = { 400: true, 404: true, 405: true, 415: true };

async function probeHttp(spec: McpServerSpec, deps: McpPeerDeps, signal: AbortSignal): Promise<McpProbeResult> {
	const modern = upstreamFor(spec, "modern");
	try {
		await connectUpstream(modern, deps, signal);
		const result = discoverResultOf(await modern.request("server/discover", { _meta: requestMeta() }, { signal }));
		if (result) return { era: "modern", discover: result };
	} catch (error) {
		const era = eraOfDiscoverError(error);
		if (era === "modern") return { era };
		// Anything but a server's own answer or one of the statuses a
		// handshake-era endpoint gives an unknown POST is the caller's to see:
		// an auth challenge, an outage.
		if (!(error instanceof MCPTransportError)) throw error;
		// A server that lists a handshake-era revision asked for the handshake, whatever status carried that.
		if (era !== "legacy") {
			const status = httpStatusOf(error);
			const refused =
				status === undefined ? error.failure === "json_rpc" : Object.hasOwn(LEGACY_HTTP_STATUS, status);
			if (!refused) throw error;
		}
	} finally {
		await modern.close();
	}
	return probeHandshake(spec, deps, signal);
}

/** Confirm a handshake-era remote server with `initialize` on a throwaway session. */
async function probeHandshake(spec: McpServerSpec, deps: McpPeerDeps, signal: AbortSignal): Promise<McpProbeResult> {
	const legacy = upstreamFor(spec, "legacy");
	legacy.onRequest = legacyRequestHandler(deps);
	try {
		await connectUpstream(legacy, deps, signal);
		return { era: "legacy", discover: legacyDiscover(await openLegacySession(legacy, signal)) };
	} finally {
		await legacy.close();
	}
}

// ── entry points ───────────────────────────────────────────────────────────

/** How the MCP host reaches servers; see {@link McpUpstreams}. */
export const mcpUpstreams: McpUpstreams = {
	async probe(spec, deps, signal) {
		const timeoutMs = spec.timeoutMs > 0 ? spec.timeoutMs : PROBE_TIMEOUT_MS;
		const bound = AbortSignal.timeout(timeoutMs);
		const probeSignal = signal ? AbortSignal.any([signal, bound]) : bound;
		const stdio = spec.transport === "stdio" ? new StdioUpstream(spec) : undefined;
		try {
			if (stdio) return await probeStdio(stdio, deps, probeSignal);
			if (spec.transport === "sse") return await probeHandshake(spec, deps, probeSignal);
			return await probeHttp(spec, deps, probeSignal);
		} catch (error) {
			const kind: MCPTransportKind = stdio ? "stdio" : "http";
			if (bound.aborted && !signal?.aborted) {
				const stderr = stdio?.stderrTail().trim();
				throw new MCPTransportError({
					transport: kind,
					stage: "connect",
					failure: "timeout",
					message: `MCP server did not answer within ${timeoutMs}ms${stderr ? `\n${stderr}` : ""}`,
					retryable: false,
					cause: error,
				});
			}
			if (stdio) throw startError(error, stdio);
			throw normalizeMCPTransportError(error, { transport: kind, stage: "connect" });
		} finally {
			await stdio?.close();
		}
	},

	async start(spec, era, deps, signal) {
		const upstream = upstreamFor(spec, era);
		const wire = new PeerWire(upstream);
		try {
			if (era === "modern") {
				const peer = new ModernPeer(wire, spec.timeoutMs);
				await connectUpstream(upstream, deps, signal);
				return peer;
			}
			upstream.onRequest = legacyRequestHandler(deps);
			// A server may notify as soon as it is initialized, before the peer exists to route it.
			const earlier: ServerNotification[] = [];
			wire.onNotification = (method, params) => {
				earlier.push({ method, params });
			};
			await connectUpstream(upstream, deps, signal);
			return new LegacyPeer(wire, await openLegacySession(upstream, signal), earlier);
		} catch (error) {
			// Covers an abort mid-handshake too: the child must not outlive a start nobody waits for.
			await upstream.close().catch(() => {});
			throw startError(error, upstream);
		}
	},

	restore(spec, era, state, adopt, deps) {
		if (spec.transport !== "stdio") return undefined;
		const child: ManagedChild | undefined = adopt(state.child);
		if (!child) return undefined;
		const saved = isRecord(state.state) ? state.state : {};
		const transport = saved.transport;
		const position: StdioUpstreamState | undefined =
			isRecord(transport) && typeof transport.remainder === "string" && typeof transport.lastId === "number"
				? { remainder: transport.remainder, lastId: transport.lastId }
				: undefined;
		let session: MCPInitializeResult | undefined;
		if (era === "legacy") {
			try {
				session = parseInitializeResult(saved.session);
			} catch (error) {
				logger.debug("MCP peer snapshot holds no initialize session", { pid: child.pid, error });
			}
		}
		if (!position || (era === "legacy" && !session)) {
			// Without its stream position or session the child cannot be spoken to again.
			logger.warn("Discarding an MCP upstream with an unusable snapshot", { pid: child.pid });
			child.kill("SIGKILL");
			return undefined;
		}

		const upstream = new StdioUpstream(spec);
		const wire = new PeerWire(upstream);
		if (!session) {
			const peer = new ModernPeer(wire, spec.timeoutMs);
			upstream.adopt(child, position);
			// The sessions that owned these streams are gone; the unit opens its own again.
			for (const id of Array.isArray(saved.listens) ? saved.listens : []) {
				if (typeof id === "string" || typeof id === "number") {
					wire.notify("notifications/cancelled", { requestId: id, reason: "Subscriber went away" });
				}
			}
			return peer;
		}
		upstream.onRequest = legacyRequestHandler(deps);
		const earlier: ServerNotification[] = [];
		for (const entry of Array.isArray(saved.backlog) ? saved.backlog : []) {
			if (isRecord(entry) && typeof entry.method === "string" && isRecord(entry.params)) {
				earlier.push({ method: entry.method, params: entry.params });
			}
		}
		const peer = new LegacyPeer(wire, session, earlier);
		upstream.adopt(child, position);
		for (const uri of Array.isArray(saved.subscribed) ? saved.subscribed : []) {
			if (typeof uri === "string") void wire.call("resources/unsubscribe", { uri }).catch(() => {});
		}
		return peer;
	},
};
