/**
 * MCP client operations of a session.
 *
 * Every server is reached through the MCP host (`./link`), in MCP 2026-07-28
 * terms: discovery instead of a handshake, server asks as `input_required`
 * results, notifications on `subscriptions/listen` streams. Lists are served
 * from the host's shared store when it has them, so a known server answers
 * without its process running.
 */
import * as path from "node:path";
import * as url from "node:url";
import { getProjectDir, isRecord, logger, untilAborted, withTimeout } from "@oh-my-pi/pi-utils";
import { workerEnvFromParent } from "../subprocess/worker-client";
import { MCPTransportError } from "./errors";
import {
	MCP_NO_STORE,
	MCP_STALE_OK,
	type McpHostAccess,
	type McpServerSpec,
	type McpUpstreamStatus,
	OmpMeta,
} from "./host/contract";
import { HostLink, type HostLinkReattach } from "./link";
import {
	MCP_SUBSCRIPTION_ACKNOWLEDGED,
	type MCPDiscoverResult,
	MCPErrorCode,
	type MCPInputRequiredResult,
	MCPMeta,
	type MCPSubscriptionFilter,
	resultTypeOf,
	subscriptionIdOf,
} from "./protocol";
import { describeMCPTimeout, isMCPTimeoutEnabled, resolveMCPTimeoutMs } from "./timeout";
import type {
	MCPGetPromptResult,
	MCPImplementation,
	MCPPrompt,
	MCPPromptsListResult,
	MCPRequestOptions,
	MCPResource,
	MCPResourceReadResult,
	MCPResourcesListResult,
	MCPResourceTemplate,
	MCPResourceTemplatesListResult,
	MCPRoot,
	MCPServerCapabilities,
	MCPServerConfig,
	MCPServerConnection,
	MCPToolCallResult,
	MCPToolDefinition,
	MCPToolsListResult,
	MCPTransport,
} from "./types";

/** Default linger of an unleased modern unit: the `mcp.idleStopMinutes` default. */
export const MCP_DEFAULT_IDLE_MS = 300_000;

/** Round trips one logical call may take before the server is considered stuck asking for input. */
const MCP_MAX_ROUND_TRIPS = 8;

/** The single root omp exposes for a working directory. */
export function projectRoots(cwd: string): MCPRoot[] {
	return [{ uri: url.pathToFileURL(cwd).href, name: path.basename(cwd) }];
}

/**
 * Everything the host needs to reach the server of `config`, whose `env` and
 * `headers` must already be resolved. A relative or absent `cwd` resolves
 * against `cwd`, else the project directory.
 *
 * @throws on a server type omp does not know.
 */
export function buildServerSpec(config: MCPServerConfig, cwd?: string): McpServerSpec {
	const timeoutMs = resolveMCPTimeoutMs(config.timeout);
	const { requestIdFormat } = config;
	switch (config.type) {
		case undefined:
		case "stdio": {
			const env = config.env ?? {};
			return {
				transport: "stdio",
				command: config.command,
				args: config.args ?? [],
				cwd: path.resolve(cwd ?? getProjectDir(), config.cwd ?? ""),
				env,
				spawnEnv: workerEnvFromParent(env),
				requestIdFormat,
				timeoutMs,
			};
		}
		case "http":
		case "sse":
			return {
				transport: config.type,
				url: config.url,
				headers: config.headers ?? {},
				headerPolicy: config.headerPolicy,
				requestIdFormat,
				timeoutMs,
			};
		default:
			throw new Error(`Unknown server type: ${String((config as MCPServerConfig).type)}`);
	}
}

/** A connection whose transport is known to be the session's link to the MCP host. */
export interface HostedMCPConnection extends MCPServerConnection {
	transport: HostLink;
}

/** Options of {@link connectToServer}. */
export interface MCPConnectOptions {
	signal?: AbortSignal;
	/** Base of the server's working directory and of the default roots; the project directory when absent. */
	cwd?: string;
	/** Id of the owning MCP manager; a fresh one makes a one-off connection its own owner. */
	instance?: string;
	/** Linger of an unleased modern unit, in milliseconds. */
	idleMs?: number;
	/** Roots the server may ask for, read at each ask. */
	roots?: () => MCPRoot[];
	/** Where the units live; the process-wide host by default. */
	access?: McpHostAccess;
	/**
	 * Ask the server itself for discovery and every list, whatever the host's
	 * store holds, and store nothing: for connection tests and authentication
	 * probes, whose point is the live answer.
	 */
	live?: boolean;
	/** List-change and resource-update notifications of this connection's subscriptions. */
	onNotification?: (method: string, params: unknown) => void;
	/** The upstream's state as the host reports it, from the first attach on. */
	onStatus?: (status: McpUpstreamStatus) => void;
	/**
	 * The link took a new attachment. The list-change stream is already being
	 * re-opened; watched resources are kept only when the identity is the
	 * same. See {@link HostLink.onReattach} for what the returned promise bounds.
	 */
	onReattach?: (change: HostLinkReattach) => void | Promise<void>;
	/**
	 * Resolve the server's credentials again after a 401/403, from the era
	 * probe of the first attach on. Absent, such a failure is final: an
	 * anonymous probe stays anonymous.
	 */
	onAuthError?: () => Promise<Record<string, string> | null>;
}

/** One open `subscriptions/listen` stream. */
interface Listen {
	/** The stream is over, whoever ended it. */
	over: boolean;
	/** Ended here; its end needs no reaction. */
	dropped: boolean;
	close(): void;
}

const NO_RESOURCES = "[]";

/**
 * The `subscriptions/listen` streams of one connection: one for list changes,
 * opened at connect, and one holding the watched resource URIs, replaced
 * whenever that set changes because a live filter cannot be modified.
 */
class ConnectionListens {
	readonly #name: string;
	readonly #transport: MCPTransport;
	readonly #unacknowledged = new Map<string | number, PromiseWithResolvers<MCPSubscriptionFilter>>();
	readonly #uris = new Set<string>();
	#lists: Listen | undefined;
	#resources: Listen | undefined;
	/** Serialized URI set {@link #resources} was opened with; empty when it must be opened anew. */
	#resourcesKey = NO_RESOURCES;
	#syncing: Promise<void> | undefined;
	/** The watched set changed while {@link #syncing} was finishing. */
	#stale = false;
	#closed = false;

	constructor(name: string, transport: MCPTransport) {
		this.#name = name;
		this.#transport = transport;
	}

	/** Consume a subscription acknowledgement; false for every other notification. */
	acknowledge(method: string, params: unknown): boolean {
		if (method !== MCP_SUBSCRIPTION_ACKNOWLEDGED) return false;
		const id = subscriptionIdOf(params);
		const filter = isRecord(params) && isRecord(params.notifications) ? params.notifications : {};
		if (id !== undefined) this.#unacknowledged.get(id)?.resolve(filter);
		return true;
	}

	/**
	 * Open the list-change stream. All three types are asked for whatever the
	 * server advertises: the host also announces changes it finds itself when
	 * it revalidates a list it served stale.
	 */
	async openLists(): Promise<void> {
		this.#lists?.close();
		this.#lists = undefined;
		this.#lists = await this.#open({ toolsListChanged: true, promptsListChanged: true, resourcesListChanged: true });
	}

	/** Add to or remove from the watched resources and bring the stream in line. */
	watch(uris: string[], watched: boolean): Promise<void> {
		for (const uri of uris) {
			if (watched) this.#uris.add(uri);
			else this.#uris.delete(uri);
		}
		return this.#sync();
	}

	/**
	 * Open every stream again on a new attachment, where the old ones do not
	 * exist. With `forget` the watched resources are dropped instead of asked
	 * for again: they name resources of an identity the link no longer reaches.
	 */
	async reopen(forget: boolean): Promise<void> {
		this.#resources?.close();
		this.#resources = undefined;
		if (forget) this.#uris.clear();
		this.#resourcesKey = this.#uris.size === 0 ? NO_RESOURCES : "";
		await this.openLists();
		// A run begun on the old attachment failed with it and must not stand in for this one.
		await this.#syncing?.catch(() => {});
		await this.#sync();
	}

	close(): void {
		this.#closed = true;
		this.#lists?.close();
		this.#resources?.close();
	}

	/** Bring the resource stream in line with the watched set; concurrent callers share one run. */
	#sync(): Promise<void> {
		if (this.#syncing) {
			this.#stale = true;
			return this.#syncing;
		}
		// The slot is freed in a continuation of the published run, so a pass
		// that needs no await still leaves it free for the next change.
		const run = (async () => {
			do {
				this.#stale = false;
				await this.#replaceResources();
			} while (this.#stale && !this.#closed);
		})().finally(() => {
			if (this.#syncing === run) this.#syncing = undefined;
		});
		this.#syncing = run;
		return run;
	}

	async #replaceResources(): Promise<void> {
		while (!this.#closed) {
			const uris = Array.from(this.#uris).sort();
			const key = JSON.stringify(uris);
			if (key === this.#resourcesKey) return;
			// New stream first, so no update is missed between the two.
			const next = uris.length > 0 ? await this.#open({ resourceSubscriptions: uris }) : undefined;
			if (next?.over) throw new Error("subscription ended as soon as it was acknowledged");
			const previous = this.#resources;
			this.#resources = next;
			this.#resourcesKey = key;
			previous?.close();
		}
		this.#resources?.close();
	}

	/** @throws when the stream ends before the host acknowledges it. */
	async #open(filter: MCPSubscriptionFilter): Promise<Listen> {
		const controller = new AbortController();
		const acknowledged = Promise.withResolvers<MCPSubscriptionFilter>();
		const listen: Listen = {
			over: false,
			dropped: false,
			close: () => {
				listen.dropped = true;
				controller.abort();
			},
		};
		let id: string | number | undefined;
		const settle = (error: unknown): void => {
			listen.over = true;
			if (id !== undefined) this.#unacknowledged.delete(id);
			acknowledged.reject(error);
			this.#ended(listen);
		};
		this.#transport
			.request(
				"subscriptions/listen",
				{ notifications: filter },
				{
					signal: controller.signal,
					onRequestId: allocated => {
						id = allocated;
						this.#unacknowledged.set(allocated, acknowledged);
					},
				},
			)
			.then(() => settle(new Error("MCP subscription ended before it was acknowledged")), settle);
		const honoured = await acknowledged.promise;
		if (filter.resourceSubscriptions && !honoured.resourceSubscriptions) {
			logger.warn("MCP server does not honour resource subscriptions", { path: `mcp:${this.#name}` });
		}
		return listen;
	}

	#ended(listen: Listen): void {
		if (listen.dropped || this.#closed) return;
		if (listen === this.#lists) {
			this.#lists = undefined;
			return;
		}
		if (listen !== this.#resources) return;
		this.#resources = undefined;
		this.#resourcesKey = "";
		// The host ends a resource stream when the upstream goes away; a lost
		// tunnel instead comes back through `reopen`.
		if (!this.#transport.connected) return;
		this.#sync().catch(error => {
			logger.warn("Failed to re-open MCP resource subscriptions", { path: `mcp:${this.#name}`, error });
		});
	}
}

/**
 * `params` of a listen-stream notification as the server sent them: the tag
 * naming the stream is the tunnel's, and listeners compare payloads verbatim.
 */
function withoutSubscriptionTag(params: unknown): unknown {
	const tagged = isRecord(params) ? params._meta : undefined;
	if (!isRecord(params) || !isRecord(tagged) || !(MCPMeta.subscriptionId in tagged)) return params;
	const untagged: Record<string, unknown> = { ...params };
	const meta: Record<string, unknown> = {};
	delete untagged._meta;
	for (const key in tagged) {
		if (key === MCPMeta.subscriptionId) continue;
		meta[key] = tagged[key];
		untagged._meta = meta;
	}
	return untagged;
}

const kListens = Symbol("mcp.listens");

/** A connection carrying the streams {@link connectToServer} opened for it. */
interface ListeningConnection extends MCPServerConnection {
	[kListens]?: ConnectionListens;
}

/** Identifies an MCP server whose initial connection exceeded its configured timeout. */
export class MCPConnectionTimeoutError extends Error {
	readonly serverName: string;
	readonly timeoutMs: number;

	constructor(serverName: string, timeoutMs: number) {
		super(`Connection to MCP server "${serverName}" timed out after ${describeMCPTimeout(timeoutMs)}`);
		this.name = "MCPConnectionTimeoutError";
		this.serverName = serverName;
		this.timeoutMs = timeoutMs;
	}
}

/**
 * Params of a discovery or list request: the host's cache hint for this
 * connection, and the page asked for. An empty cursor is a cursor.
 */
function catalogParams(connection: MCPServerConnection, cursor?: string): Record<string, unknown> {
	const params: Record<string, unknown> = {
		_meta: { [OmpMeta.cache]: connection.live ? MCP_NO_STORE : MCP_STALE_OK },
	};
	if (cursor !== undefined) params.cursor = cursor;
	return params;
}

/**
 * The only result a discovery or list may be consumed from is a complete one.
 *
 * @throws MCPTransportError when the server answered `method` with any other result type, or with no object at all.
 */
function assertComplete(connection: MCPServerConnection, method: string, result: unknown): void {
	let problem: string | undefined;
	try {
		if (resultTypeOf(result) !== "complete") problem = "asked for input, which this method does not allow";
	} catch (error) {
		problem = error instanceof Error ? error.message : String(error);
	}
	if (problem === undefined) return;
	throw new MCPTransportError({
		transport: "unknown",
		stage: "protocol",
		failure: "malformed_response",
		message: `MCP server "${connection.name}" answered ${method} with an unusable result: ${problem}`,
		retryable: false,
	});
}

/**
 * Ask the server what it is and record the answer on `connection`, dropping
 * the catalogs memoized from before: capabilities, instructions and server
 * identity. Served from the host's store when it has the answer.
 *
 * @throws MCPTransportError when the server cannot be reached or answers with something other than a discover result.
 */
export async function discoverServer(
	connection: MCPServerConnection,
	options?: { signal?: AbortSignal },
): Promise<void> {
	const result = await connection.transport.request<MCPDiscoverResult>(
		"server/discover",
		catalogParams(connection),
		options,
	);
	assertComplete(connection, "server/discover", result);
	if (!isRecord(result.capabilities)) {
		throw new MCPTransportError({
			transport: "unknown",
			stage: "protocol",
			failure: "malformed_response",
			message: `MCP server "${connection.name}" answered server/discover without capabilities`,
			retryable: false,
		});
	}
	const info = result._meta?.[MCPMeta.serverInfo];
	const serverInfo: MCPImplementation =
		isRecord(info) && typeof info.name === "string" && typeof info.version === "string"
			? { name: info.name, version: info.version, title: typeof info.title === "string" ? info.title : undefined }
			: { name: connection.name, version: "unknown" };
	connection.serverInfo = serverInfo;
	connection.capabilities = result.capabilities;
	connection.instructions = typeof result.instructions === "string" ? result.instructions : undefined;
	connection.tools = undefined;
	connection.resources = undefined;
	connection.resourceTemplates = undefined;
	connection.prompts = undefined;
}

/**
 * Connect to an MCP server through the MCP host.
 * Bounded by the server's timeout (30 seconds by default) so a server that
 * cannot be probed does not block startup; set OMP_MCP_TIMEOUT_MS=0 to disable.
 *
 * @throws MCPConnectionTimeoutError past the bound; otherwise the host's or server's failure.
 */
export async function connectToServer(
	name: string,
	config: MCPServerConfig,
	options?: MCPConnectOptions,
): Promise<HostedMCPConnection> {
	// `withTimeout` rejects a pre-aborted signal without observing `connect()`; never start one.
	options?.signal?.throwIfAborted();
	const timeoutMs = resolveMCPTimeoutMs(config.timeout);
	const controller = new AbortController();
	const signal = options?.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
	const cwd = options?.cwd;
	const roots = options?.roots ?? (() => projectRoots(cwd ?? getProjectDir()));
	const link = new HostLink({
		name,
		spec: buildServerSpec(config, cwd),
		instance: options?.instance ?? Bun.randomUUIDv7(),
		roots,
		idleMs: options?.idleMs ?? MCP_DEFAULT_IDLE_MS,
		timeout: config.timeout,
		access: options?.access,
	});
	const listens = new ConnectionListens(name, link);
	const connection: HostedMCPConnection & ListeningConnection = {
		name,
		config,
		transport: link,
		serverInfo: { name, version: "unknown" },
		capabilities: {},
		roots,
		live: options?.live,
		[kListens]: listens,
	};
	link.onAuthError = options?.onAuthError;
	link.onStatus = options?.onStatus;
	link.onNotification = (method, params) => {
		if (!listens.acknowledge(method, params)) options?.onNotification?.(method, withoutSubscriptionTag(params));
	};
	link.onReattach = change => {
		listens.reopen(change.identityChanged).catch(error => {
			logger.warn("Failed to re-open MCP subscriptions", { path: `mcp:${name}`, error });
		});
		return options?.onReattach?.(change);
	};

	const connect = async (): Promise<HostedMCPConnection> => {
		await link.connect(signal);
		await discoverServer(connection, { signal });
		try {
			await listens.openLists();
		} catch (error) {
			// The server works without change notifications; its lists just stay as fetched.
			logger.warn("Failed to open MCP list-change subscription", { path: `mcp:${name}`, error });
		}
		return connection;
	};

	try {
		// Race the whole sequence against the signal: attaching does not observe it at every step.
		if (!isMCPTimeoutEnabled(timeoutMs)) {
			return await untilAborted(options?.signal, connect());
		}
		return await withTimeout(connect(), timeoutMs, new MCPConnectionTimeoutError(name, timeoutMs), options?.signal);
	} catch (error) {
		controller.abort(error);
		listens.close();
		void link.close();
		throw error;
	}
}

/** Disconnect from a server: end its subscriptions and give up the unit lease. */
export async function disconnectServer(connection: MCPServerConnection): Promise<void> {
	(connection as ListeningConnection)[kListens]?.close();
	await connection.transport.close();
}

/** Fetch every page of a list: from the host's store when it has them, from the server on a live connection. */
async function listAll<R extends { nextCursor?: string }, T>(
	connection: MCPServerConnection,
	method: string,
	items: (page: R) => T[],
	options: { signal?: AbortSignal } | undefined,
): Promise<T[]> {
	const all: T[] = [];
	let cursor: string | undefined;
	do {
		const page = await connection.transport.request<R>(method, catalogParams(connection, cursor), options);
		assertComplete(connection, method, page);
		all.push(...items(page));
		cursor = typeof page.nextCursor === "string" ? page.nextCursor : undefined;
	} while (cursor !== undefined);
	return all;
}

/**
 * Send a request a server may answer with `input_required`, supplying the
 * input and retrying until the result is complete. Roots are the only input
 * omp declares, so they are the only one it supplies.
 *
 * @throws when the server asks for anything else, sends an empty ask, or keeps asking past {@link MCP_MAX_ROUND_TRIPS} round trips.
 */
async function requestWithInput<T>(
	connection: MCPServerConnection,
	method: string,
	params: Record<string, unknown>,
	options: MCPRequestOptions | undefined,
): Promise<T> {
	let attempt = params;
	for (let round = 0; round < MCP_MAX_ROUND_TRIPS; round++) {
		const result = await connection.transport.request<T | MCPInputRequiredResult>(method, attempt, options);
		if (resultTypeOf(result) === "complete") return result as T;
		const { inputRequests, requestState } = result as MCPInputRequiredResult;
		if (inputRequests === undefined && requestState === undefined) {
			throw new Error(`MCP server "${connection.name}" asked for input on ${method} without saying which`);
		}
		// Each retry is the original request plus this round's answers; state is echoed only when given.
		attempt = { ...params };
		if (requestState !== undefined) attempt.requestState = requestState;
		if (inputRequests === undefined) continue;
		// No prototype: a server may name an ask `__proto__`, and its answer must be a field like any other.
		const inputResponses: Record<string, unknown> = Object.create(null);
		for (const key in inputRequests) {
			const ask: unknown = inputRequests[key];
			const asked = isRecord(ask) ? ask.method : undefined;
			if (asked !== "roots/list") {
				throw new Error(
					`MCP server "${connection.name}" asked for unsupported input "${String(asked)}" on ${method}`,
				);
			}
			inputResponses[key] = { roots: connection.roots?.() ?? projectRoots(getProjectDir()) };
		}
		attempt.inputResponses = inputResponses;
	}
	throw new Error(
		`MCP server "${connection.name}" still asked for input on ${method} after ${MCP_MAX_ROUND_TRIPS} round trips`,
	);
}

/**
 * List tools from a connected server.
 */
export async function listTools(
	connection: MCPServerConnection,
	options?: { signal?: AbortSignal },
): Promise<MCPToolDefinition[]> {
	if (!connection.capabilities.tools) return [];
	connection.tools ??= await listAll<MCPToolsListResult, MCPToolDefinition>(
		connection,
		"tools/list",
		page => page.tools,
		options,
	);
	return connection.tools;
}

/**
 * Call a tool on a connected server.
 */
export async function callTool(
	connection: MCPServerConnection,
	toolName: string,
	args: Record<string, unknown> = {},
	options?: MCPRequestOptions,
): Promise<MCPToolCallResult> {
	return requestWithInput<MCPToolCallResult>(connection, "tools/call", { name: toolName, arguments: args }, options);
}

/**
 * List resources from a connected server.
 */
export async function listResources(
	connection: MCPServerConnection,
	options?: { signal?: AbortSignal },
): Promise<MCPResource[]> {
	if (!connection.capabilities.resources) return [];
	connection.resources ??= await listAll<MCPResourcesListResult, MCPResource>(
		connection,
		"resources/list",
		page => page.resources,
		options,
	);
	return connection.resources;
}

/**
 * List resource templates from a connected server.
 *
 * A server MAY advertise the `resources` capability without implementing the
 * optional `resources/templates/list` method; it then answers JSON-RPC -32601.
 * That is "no templates", not a failure: a caller loading resources and
 * templates together would otherwise discard the concrete resources too.
 */
export async function listResourceTemplates(
	connection: MCPServerConnection,
	options?: { signal?: AbortSignal },
): Promise<MCPResourceTemplate[]> {
	if (!connection.capabilities.resources) return [];
	if (connection.resourceTemplates) return connection.resourceTemplates;
	try {
		connection.resourceTemplates = await listAll<MCPResourceTemplatesListResult, MCPResourceTemplate>(
			connection,
			"resources/templates/list",
			page => page.resourceTemplates,
			options,
		);
	} catch (error) {
		if (!(error instanceof MCPTransportError) || error.code !== MCPErrorCode.MethodNotFound) throw error;
		connection.resourceTemplates = [];
	}
	return connection.resourceTemplates;
}

/**
 * Read a resource from a connected server.
 */
export async function readResource(
	connection: MCPServerConnection,
	uri: string,
	options?: MCPRequestOptions,
): Promise<MCPResourceReadResult> {
	return requestWithInput<MCPResourceReadResult>(connection, "resources/read", { uri }, options);
}

async function watchResources(connection: MCPServerConnection, uris: string[], watched: boolean): Promise<void> {
	if (uris.length === 0 || !connection.capabilities.resources?.subscribe) return;
	const listens = (connection as ListeningConnection)[kListens];
	if (!listens) throw new Error(`MCP server "${connection.name}" is not connected through the MCP host`);
	try {
		await listens.watch(uris, watched);
	} catch (error) {
		logger.warn("Failed to update MCP resource subscriptions", { path: `mcp:${connection.name}`, error });
	}
}

/**
 * Receive update notifications for `uris`, in addition to those already
 * watched. A server that refuses is logged, not thrown.
 *
 * @throws when `connection` was not made by {@link connectToServer}.
 */
export async function subscribeToResources(connection: MCPServerConnection, uris: string[]): Promise<void> {
	await watchResources(connection, uris, true);
}

/**
 * Stop receiving update notifications for `uris`.
 *
 * @throws when `connection` was not made by {@link connectToServer}.
 */
export async function unsubscribeFromResources(connection: MCPServerConnection, uris: string[]): Promise<void> {
	await watchResources(connection, uris, false);
}

/**
 * Check if a server supports resource subscriptions.
 */
export function serverSupportsResourceSubscriptions(capabilities: MCPServerCapabilities): boolean {
	return capabilities.resources?.subscribe === true;
}

/**
 * Check if a server supports resources.
 */
export function serverSupportsResources(capabilities: MCPServerCapabilities): boolean {
	return capabilities.resources !== undefined;
}

/**
 * List prompts from a connected server.
 */
export async function listPrompts(
	connection: MCPServerConnection,
	options?: { signal?: AbortSignal },
): Promise<MCPPrompt[]> {
	if (!connection.capabilities.prompts) return [];
	connection.prompts ??= await listAll<MCPPromptsListResult, MCPPrompt>(
		connection,
		"prompts/list",
		page => page.prompts,
		options,
	);
	return connection.prompts;
}

/**
 * Get a specific prompt from a connected server.
 */
export async function getPrompt(
	connection: MCPServerConnection,
	name: string,
	args?: Record<string, string>,
	options?: MCPRequestOptions,
): Promise<MCPGetPromptResult> {
	const params: Record<string, unknown> = { name };
	if (args && Object.keys(args).length > 0) params.arguments = args;
	return requestWithInput<MCPGetPromptResult>(connection, "prompts/get", params, options);
}

/**
 * Check if a server supports prompts.
 */
export function serverSupportsPrompts(capabilities: MCPServerCapabilities): boolean {
	return capabilities.prompts !== undefined;
}
