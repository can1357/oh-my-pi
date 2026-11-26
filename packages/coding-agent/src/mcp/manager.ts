/**
 * MCP Server Manager.
 *
 * Discovers, connects to, and manages MCP servers.
 * Handles tool loading and lifecycle.
 */
import type { TSchema } from "@oh-my-pi/pi-ai";
import { logger, untilAborted } from "@oh-my-pi/pi-utils";
import type { EffectiveExtensionRoots, SourceMeta } from "../capability/types";
import { invalidateCommandConfig, isCommandConfigValue, resolveConfigValue } from "../config/resolve-config-value";
import type { CustomTool } from "../extensibility/custom-tools/types";
import type { AuthStorage } from "../session/auth-storage";
import {
	buildServerSpec,
	connectToServer,
	disconnectServer,
	discoverServer,
	getPrompt,
	type HostedMCPConnection,
	listPrompts,
	listResources,
	listResourceTemplates,
	listTools,
	MCP_DEFAULT_IDLE_MS,
	MCPConnectionTimeoutError,
	projectRoots,
	readResource,
	serverSupportsPrompts,
	serverSupportsResources,
	subscribeToResources,
	unsubscribeFromResources,
} from "./client";
import {
	isBrowserMCPServer,
	type LoadMCPConfigsOptions,
	type LoadMCPConfigsResult,
	loadAllMCPConfigs,
	validateServerConfig,
} from "./config";
import { type McpHostAccess, type McpUpstreamStatus, mcpIdentity } from "./host/contract";
import type { HostLinkReattach } from "./link";
import { setGeneratedHeader } from "./host/header-policy";
import {
	lookupMcpOAuthCredential,
	type MCPOAuthCredentialLookup,
	refreshStoredManagedMcpOAuthCredential,
} from "./oauth-credentials";
import type { MCPStoredOAuthCredential } from "./oauth-flow";
import type { McpConnectionStatusEvent } from "./startup-events";
import { resolveMCPStartupTimeoutMs } from "./timeout";

import type { MCPToolDetails } from "../tools/details/mcp";
import { type MCPReconnect, type MCPReconnectOptions, MCPTool, type MCPToolCallObserver } from "./tool-bridge";
import type { MCPDroppedServer, MCPTransformContext } from "./transforms";
import type {
	MCPAuthChallenge,
	MCPGetPromptResult,
	MCPPrompt,
	MCPRequestOptions,
	MCPResource,
	MCPResourceReadResult,
	MCPResourceTemplate,
	MCPServerConfig,
	MCPServerConnection,
	MCPToolDefinition,
} from "./types";
import { MCPNotificationMethods } from "./types";

export type McpCatalogChangeEvent = { serverName: string; kind: "resources" | "prompts" };
export type MCPConfigLoader = (cwd: string, options?: LoadMCPConfigsOptions) => Promise<LoadMCPConfigsResult>;

type ToolLoadResult = {
	connection: HostedMCPConnection;
	serverTools: MCPToolDefinition[];
};

/**
 * The `!command` values {@link MCPManager} executes when it resolves `config`:
 * remote `headers` or stdio `env`, minus the entries a literal policy keeps verbatim.
 */
function commandValues(config: MCPServerConfig): string[] {
	const values: string[] = [];
	if (config.type === "http" || config.type === "sse") {
		if (!config.headers || config.headerPolicy === "origin-locked") return values;
		for (const key in config.headers) {
			const value = config.headers[key];
			if (isCommandConfigValue(value)) values.push(value);
		}
		return values;
	}
	if (!config.env || config.envPolicy === "literal") return values;
	const literalKeys = new Set(config.envLiteralKeys);
	for (const key in config.env) {
		const value = config.env[key];
		if (!literalKeys.has(key) && isCommandConfigValue(value)) values.push(value);
	}
	return values;
}

/**
 * Drop the process-cached results of `config`'s `!command` values so the next
 * resolution runs them again — a command that mints a short-lived token
 * (e.g. an OAuth2 `client_credentials` grant) must not resend an expired one.
 */
function invalidateCommandValues(config: MCPServerConfig): void {
	for (const value of commandValues(config)) invalidateCommandConfig(value);
}

/** Abort of one server's connect, tied to the manager's own. */
interface ServerScope {
	controller: AbortController;
	signal: AbortSignal;
}

type TrackedPromise<T> = {
	promise: Promise<T>;
	status: "pending" | "fulfilled" | "rejected";
	value?: T;
	reason?: unknown;
};

/**
 * One session's view over a shared {@link MCPManager}, keyed by the session's
 * id; see {@link MCPManagerApi.getTools}. Opened with
 * {@link MCPManagerApi.openToolScope}; the owning session's view needs none.
 */
export type MCPToolScope = string;

/** Scope of the session that owns the manager. */
const OWNER_TOOL_SCOPE: MCPToolScope = "owner";

function createMcpStartupFailure(serverName: string, error: string, source?: SourceMeta): McpConnectionStatusEvent {
	return source
		? { type: "failed", serverName, error, sourcePath: source.path }
		: { type: "failed", serverName, error };
}

/**
 * Bounded buffer for notifications received before any listener attaches.
 * Mirrors {@link IrcBus}'s `MAILBOX_CAP` — drop-oldest on overflow. Drained
 * into the first {@link MCPManager.addNotificationListener} subscriber, then
 * cleared; subsequent frames deliver directly to attached listeners.
 */
const NOTIFICATION_BUFFER_CAP = 100;

function trackPromise<T>(promise: Promise<T>): TrackedPromise<T> {
	const tracked: TrackedPromise<T> = { promise, status: "pending" };
	promise.then(
		value => {
			tracked.status = "fulfilled";
			tracked.value = value;
		},
		reason => {
			tracked.status = "rejected";
			tracked.reason = reason;
		},
	);
	return tracked;
}

/**
 * Stable, total ordering on MCP tools by name.
 *
 * Anthropic prompt caching keys on byte-identical tool definitions: any reorder
 * of the tools array invalidates the tools cache breakpoint and forces a full
 * prefix rebuild on the next request. MCP servers connect/reconnect at arbitrary
 * times, so the natural "insertion order" of `#tools` is non-deterministic.
 * Sorting after every mutation makes the array bytes independent of connection
 * sequence.
 */
export function sortMCPToolsByName<T extends { name: string }>(tools: T[]): T[] {
	tools.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
	return tools;
}

export function resolveSubscriptionPostAction(
	notificationsEnabled: boolean,
	currentEpoch: number,
	subscriptionEpoch: number,
): "rollback" | "ignore" | "apply" {
	if (!notificationsEnabled) return "rollback";
	if (currentEpoch !== subscriptionEpoch) return "ignore";
	return "apply";
}
/** Result of loading MCP tools */
export interface MCPLoadResult {
	/** Loaded tools as CustomTool instances */
	tools: CustomTool<TSchema, MCPToolDetails>[];
	/** Connection errors by server name */
	errors: Map<string, string>;
	/** Connected server names */
	connectedServers: string[];
	/** Extracted Exa API keys from filtered MCP servers */
	exaApiKeys: string[];
}

/** Readiness of configured MCP servers after the initial tool handshake. */
export interface MCPStartupStatus {
	/** Servers whose tools have been registered and whose startup callbacks completed. */
	connected: string[];
	/** Servers still loading tools or reconnecting at the deadline. */
	pending: string[];
	/** Servers whose connection or tool handshake failed. */
	failed: Array<{ name: string; error: string }>;
}

/** Options for discovering and connecting to MCP servers */
export interface MCPDiscoverOptions {
	/** Whether to load project-level config (default: true) */
	enableProjectConfig?: boolean;
	/** Whether to filter out Exa MCP servers (default: true) */
	filterExa?: boolean;
	/** Whether to filter out browser MCP servers when the built-in browser capability is enabled (default: false) */
	filterBrowser?: boolean;
	/** Session-local extension roots for post-startup rediscovery (explicit + mode + configured). */
	extensionRoots?: EffectiveExtensionRoots;
	/** What the session offers natively, for built-in transforms; omitted: none applies. */
	builtinTransforms?: MCPTransformContext;
	/** Called when MCP server connection state changes. */
	onStatus?: (event: McpConnectionStatusEvent) => void;
	/** Non-blocking discovery window in milliseconds; environment override wins. */
	startupTimeoutMs?: number;
}

/** Handles an MCP `WWW-Authenticate` challenge and returns refreshed config. */
export type MCPAuthHandler = (serverName: string, challenge: MCPAuthChallenge) => Promise<MCPServerConfig | undefined>;

/** Whether a handshake rejection is the teardown abort of `signal`, not a failure that preceded it. */
function isAbortedHandshake(signal: AbortSignal, error: unknown): boolean {
	return signal.aborted && error instanceof Error && error.name === "AbortError";
}

/**
 * Surface of an {@link MCPManager} that sessions reusing a manager (subagents, `mcp://` and
 * `skill://` handlers) use. Subagent worker threads receive a remote implementation whose calls
 * run on the main thread's manager, so connections and server processes stay single-owner.
 */
export interface MCPManagerApi {
	/**
	 * Tools `scope` sees (omitted: the owning session). A tool a server adds
	 * while a call to it runs reaches a session only once that session's own
	 * call to the server completes, so one session loading tools never rewrites
	 * another's tool list, prompt, or provider cache prefix. Tools present at
	 * connect, and tools a server adds while no call to it runs, every session sees.
	 */
	getTools(scope?: MCPToolScope): CustomTool<TSchema, MCPToolDetails>[];
	/**
	 * Open the view of the session `scope` names. A view opened for the first
	 * time starts from `seed`'s (default: the owner's), so a child sees what its
	 * spawner saw; reopening a view (a revived session) keeps what it was granted,
	 * so the revived session renders the tools its earlier requests were cached against.
	 */
	openToolScope(scope: MCPToolScope, seed?: MCPToolScope): void;
	/**
	 * Attribute one tool call, by tool-call id, to `scope` until the returned
	 * callback runs. Calls not attributed belong to the owning session.
	 */
	trackToolCall(scope: MCPToolScope, toolCallId: string): () => void;
	/** Subscribe to tool-set changes; returns an unsubscribe fn. */
	addToolsChangedListener(listener: () => void): () => void;
	/** Subscribe to every server notification frame; returns an unsubscribe fn. */
	addNotificationListener(listener: (serverName: string, method: string, params: unknown) => void): () => void;
	/** Names of currently connected servers. */
	getConnectedServers(): string[];
	/** Cached resources/templates of one server. */
	getServerResources(name: string): { resources: MCPResource[]; templates: MCPResourceTemplate[] } | undefined;
	/** Wait until one server's resource catalog is loaded. */
	ensureServerResources(name: string): Promise<void>;
	/** Wait for in-flight connection attempts. */
	waitForPendingConnections(): Promise<void>;
	/** Read one resource from a server. */
	readServerResource(
		name: string,
		uri: string,
		options?: MCPRequestOptions,
	): Promise<MCPResourceReadResult | undefined>;
	/** Server-provided instructions by server name. */
	getServerInstructions(): Map<string, string>;
	/** Apply the browser-MCP filter after the built-in browser capability toggled. */
	reconcileBrowserFilter(enabled: boolean): Promise<void>;
}

/** Process-global MCP manager accessors a subagent worker installs in place of its own (empty) slot. */
export interface MCPManagerGlobal {
	instance(): MCPManagerApi | undefined;
	load(): Promise<MCPManagerApi | undefined>;
	available(): boolean;
}

/**
 * MCP Server Manager.
 *
 * Manages connections to MCP servers and provides tools to the agent.
 */
export class MCPManager implements MCPManagerApi {
	static #instance: MCPManager | undefined;
	static #deferred: (() => Promise<MCPManager>) | undefined;
	static #deferredLoad: Promise<MCPManager> | undefined;
	static #global: MCPManagerGlobal | undefined;

	/**
	 * Route {@link instance}/{@link load}/{@link available} to another thread's manager.
	 * Subagent worker bootstrap only: a worker never owns MCP connections.
	 */
	static installGlobal(global: MCPManagerGlobal): void {
		MCPManager.#global = global;
	}

	/** Process-global instance shared by internal URL protocol handlers and tools. */
	static instance(): MCPManagerApi | undefined {
		if (MCPManager.#global) return MCPManager.#global.instance();
		return MCPManager.#instance;
	}

	/** Install or clear the process-global instance. */
	static setInstance(value: MCPManager | undefined): void {
		MCPManager.#instance = value;
	}

	/**
	 * Install or clear a loader that creates the process-global instance on first {@link load}, so a
	 * one-shot host (`omp read`) starts MCP servers only when a request actually reaches them.
	 */
	static setDeferredInstance(load: (() => Promise<MCPManager>) | undefined): void {
		MCPManager.#deferred = load;
		MCPManager.#deferredLoad = undefined;
	}

	/** Whether {@link load} can yield an instance: one is installed or a deferred loader is set. */
	static available(): boolean {
		if (MCPManager.#global) return MCPManager.#global.available();
		return MCPManager.#instance !== undefined || MCPManager.#deferred !== undefined;
	}

	/** The process-global instance, running the deferred loader once if none is installed yet. */
	static async load(): Promise<MCPManagerApi | undefined> {
		if (MCPManager.#global) return MCPManager.#global.load();
		if (MCPManager.#instance) return MCPManager.#instance;
		if (!MCPManager.#deferred) return undefined;
		if (!MCPManager.#deferredLoad) {
			const pending = MCPManager.#deferred().then(manager => {
				// A loader cleared or replaced mid-load must not install its manager.
				if (MCPManager.#deferredLoad === pending) MCPManager.#instance = manager;
				return manager;
			});
			MCPManager.#deferredLoad = pending;
		}
		return MCPManager.#deferredLoad;
	}

	/** Reset the process-global instance and any deferred loader. Test-only. */
	static resetForTests(): void {
		MCPManager.#instance = undefined;
		MCPManager.setDeferredInstance(undefined);
	}

	/** Owner id of this manager's handshake-era units: one server process per manager, kept across re-attaches. */
	readonly #owner = Bun.randomUUIDv7();
	#connections = new Map<string, HostedMCPConnection>();
	/** Newest upstream status the host reported per server, from the first attach on. */
	#runtimes = new Map<string, McpUpstreamStatus>();
	/**
	 * Servers whose discovery and tool list succeeded on their current
	 * attachment. A server can be attached without being usable (its reload
	 * failed) and can keep stale tools without being attached; neither is ready.
	 */
	#ready = new Set<string>();
	/**
	 * Per server, the scope of its newest connect: aborting it ends that
	 * connect and whatever reload runs for the server, and callbacks of a link
	 * are honoured only while its scope is the registered one.
	 */
	#serverScopes = new Map<string, ServerScope>();
	/** Reloads started because a link re-attached on its own, by server. */
	#pendingReloads = new Map<string, Promise<void>>();
	#tools: CustomTool<TSchema, MCPToolDetails>[] = [];
	#pendingConnections = new Map<string, Promise<HostedMCPConnection>>();
	#pendingToolLoads = new Map<string, Promise<ToolLoadResult>>();
	#startupUpdates = new Map<string, Promise<void>>();
	#startupServers = new Set<string>();
	#startupFailures = new Map<string, string>();
	/** Newest connect/reconnect failure per server, cleared when it connects; explains "not connected". */
	#lastConnectErrors = new Map<string, string>();
	#sources = new Map<string, SourceMeta>();
	/** Servers the newest config load left unconnected because a built-in transform dropped them. */
	#builtinDrops = new Map<string, MCPDroppedServer>();
	#authStorage: AuthStorage | null = null;
	#authHandler?: MCPAuthHandler;
	#notificationListeners = new Set<(serverName: string, method: string, params: unknown) => void>();
	#connectionStatusListeners = new Set<(event: McpConnectionStatusEvent) => void>();
	#catalogChangeListeners = new Set<(event: McpCatalogChangeEvent) => void>();
	#toolsChangedListeners = new Set<() => void>();
	/**
	 * Notifications received before any listener attached, to be drained on
	 * the first {@link addNotificationListener} call. Bounded by
	 * {@link NOTIFICATION_BUFFER_CAP}, drop-oldest on overflow.
	 */
	#pendingNotifications: Array<{ server: string; method: string; params: unknown }> = [];
	#onToolsChanged?: (tools: CustomTool<TSchema, MCPToolDetails>[]) => void | Promise<void>;
	/** In-flight owner-handler run; changes arriving while it runs coalesce into one trailing call. */
	#ownerToolsRun?: Promise<void>;
	#ownerToolsDirty = false;
	/** Per-server single-flight `tools/list` refresh with a trailing re-run flag. */
	#toolRefreshes = new Map<string, { dirty: boolean; promise: Promise<void> }>();
	#onResourcesChanged?: (serverName: string, uri: string) => void;
	#onPromptsChanged?: (serverName: string) => void;
	#notificationsEnabled = false;
	#notificationsEpoch = 0;
	#subscribedResources = new Map<string, Set<string>>();
	#pendingResourceRefresh = new Map<string, { connection: MCPServerConnection; promise: Promise<void> }>();
	#pendingReconnections = new Map<string, Promise<MCPServerConnection | null>>();
	/** Preserved configs for reconnection after connection loss. */
	#serverConfigs = new Map<string, MCPServerConfig>();
	#discoverOptions: MCPDiscoverOptions | undefined;
	#browserFilterMutationTail: Promise<void> = Promise.resolve();
	/** Settles when the latest {@link MCPManager.discoverAndConnect} call does; reconciles wait on it. */
	#discoveryInFlight: Promise<unknown> = Promise.resolve();
	/** Monotonic epoch incremented on disconnectAll to invalidate stale reconnections. */
	#epoch = 0;
	/** Aborts the handshakes of the current epoch; replaced on disconnectAll. */
	#connectAbort = new AbortController();
	/** Views opened so far; never forgotten, so a revived session reopens its own. */
	#toolScopes = new Set<MCPToolScope>();
	/** Scope of each attributed tool call still running, by tool-call id. */
	#toolCallScopes = new Map<string, MCPToolScope>();
	/** Tool calls running per server. */
	#inFlightToolCalls = new Map<string, number>();
	/** Servers whose pending `tools/list` refresh answers a `list_changed` received during a call. */
	#callProvokedToolRefreshes = new Set<string>();
	/**
	 * Per server, tool name → scopes that see it, for tools a server added while
	 * a call to it ran. Tools absent here are visible to every scope.
	 */
	#scopedTools = new Map<string, Map<string, Set<MCPToolScope>>>();
	/** Bumped whenever any session's view of the tools may have changed; starts above a worker's empty cache (0). */
	#toolViewsRevision = 1;

	constructor(
		private cwd: string,
		private loadConfigs: MCPConfigLoader = loadAllMCPConfigs,
		/** Linger of an unleased modern server unit, in milliseconds (`mcp.idleStopMinutes`). */
		private idleMs: number = MCP_DEFAULT_IDLE_MS,
		/** Where this manager's servers are hosted; the process-wide host when absent. Tests script their own. */
		private hostAccess?: McpHostAccess,
	) {}

	/**
	 * Re-point project config discovery and the advertised roots at `cwd` after
	 * the owning session moved. Every link gets the new roots at once; a stdio
	 * server keeps the working directory it was started in until it is reconnected.
	 */
	setCwd(cwd: string): void {
		this.cwd = cwd;
		for (const connection of this.#connections.values()) connection.transport.setRoots();
	}

	/**
	 * Register a listener for MCP connection lifecycle events
	 * (`connecting` / `connected` / `failed`).
	 *
	 * Returns an unsubscribe function. Listener failures are isolated — a
	 * listener that throws does not prevent other listeners from firing.
	 */
	addConnectionStatusListener(listener: (event: McpConnectionStatusEvent) => void): () => void {
		this.#connectionStatusListeners.add(listener);
		return () => {
			this.#connectionStatusListeners.delete(listener);
		};
	}

	#emitConnectionStatus(event: McpConnectionStatusEvent): void {
		if (event.type === "failed") this.#lastConnectErrors.set(event.serverName, event.error);
		else if (event.type === "connected") this.#lastConnectErrors.delete(event.serverName);
		if (event.type === "failed" && this.#startupServers.has(event.serverName)) {
			this.#startupFailures.set(event.serverName, event.error);
		} else if (event.type === "connected") {
			this.#startupFailures.delete(event.serverName);
		}
		for (const listener of this.#connectionStatusListeners) {
			try {
				listener(event);
			} catch (error) {
				logger.debug("MCP connection status listener threw", { error });
			}
		}
	}

	/**
	 * Register a listener for MCP catalog refreshes (`resources` / `prompts`).
	 *
	 * Connection lifecycle stays on {@link addConnectionStatusListener}. This
	 * fires after a successful catalog refresh so `/extensions` can repaint
	 * without treating catalog load as another `connected` event.
	 *
	 * Returns an unsubscribe function. Listener failures are isolated.
	 */
	addCatalogChangeListener(listener: (event: McpCatalogChangeEvent) => void): () => void {
		this.#catalogChangeListeners.add(listener);
		return () => {
			this.#catalogChangeListeners.delete(listener);
		};
	}

	#emitCatalogChange(event: McpCatalogChangeEvent): void {
		for (const listener of this.#catalogChangeListeners) {
			try {
				listener(event);
			} catch (error) {
				logger.debug("MCP catalog change listener threw", { error });
			}
		}
	}

	/**
	 * Register a listener fired whenever the manager's tool set changes: a
	 * server's tools are (re)placed, a server is disconnected, or every server
	 * is dropped (`/mcp reload`). Read the new set from {@link getTools}.
	 *
	 * Unlike the single-slot {@link setOnToolsChanged} (owned by the session
	 * that created this manager), any number of sessions sharing the manager
	 * can subscribe — subagents use it to keep their MCP tools current.
	 *
	 * Returns an unsubscribe function. Listener failures are isolated.
	 */
	addToolsChangedListener(listener: () => void): () => void {
		this.#toolsChangedListeners.add(listener);
		return () => {
			this.#toolsChangedListeners.delete(listener);
		};
	}

	/**
	 * Changes whenever any session's view of the tools may have changed: a server's
	 * tools were replaced or removed, or a session was granted tools. Lets a
	 * worker skip re-fetching views that cannot have changed.
	 */
	get toolViewsRevision(): number {
		return this.#toolViewsRevision;
	}

	#emitToolsChanged(): void {
		this.#toolViewsRevision++;
		for (const listener of this.#toolsChangedListeners) {
			try {
				listener();
			} catch (error) {
				logger.debug("MCP tools changed listener threw", { error });
			}
		}
	}

	/**
	 * Register a listener for server-initiated MCP notifications.
	 *
	 * The listener is called for every JSON-RPC notification received from any
	 * connected server, AFTER the manager's own handling of known methods
	 * (`notifications/tools/list_changed`, `notifications/resources/list_changed`,
	 * `notifications/resources/updated`, `notifications/prompts/list_changed`).
	 * For list-change methods the internal refresh promise is awaited before
	 * fanout, so listeners observe up-to-date manager and tool state. Unknown
	 * or server-custom methods are also delivered, letting consumers bridge
	 * server-initiated events into session-level behavior (e.g. an extension
	 * injecting a steer via `pi.sendMessage`).
	 *
	 * Notifications received before any listener attached are buffered
	 * (bounded FIFO, cap {@link NOTIFICATION_BUFFER_CAP}, drop-oldest) and
	 * drained into the first subscriber — matches {@link setOnPromptsChanged}'s
	 * replay-on-attach and {@link IrcBus}'s mailbox semantics.
	 *
	 * Returns an unsubscribe function; call it to remove the listener.
	 *
	 * Multiple listeners are allowed; each is invoked with independent error
	 * isolation — a listener that throws does not prevent other listeners from
	 * firing.
	 */
	addNotificationListener(listener: (serverName: string, method: string, params: unknown) => void): () => void {
		const wasEmpty = this.#notificationListeners.size === 0;
		this.#notificationListeners.add(listener);

		// Drain startup-buffered notifications into the first attaching listener.
		if (wasEmpty && this.#pendingNotifications.length > 0) {
			const pending = this.#pendingNotifications.splice(0);
			for (const frame of pending) {
				try {
					listener(frame.server, frame.method, frame.params);
				} catch (error) {
					logger.debug("MCP notification listener threw during buffered drain", {
						path: `mcp:${frame.server}`,
						method: frame.method,
						error,
					});
				}
			}
		}

		return () => {
			this.#notificationListeners.delete(listener);
		};
	}

	/**
	 * Set a callback to fire when any server's tools change.
	 *
	 * May return a Promise; if so, {@link refreshServerTools} awaits it so that
	 * downstream consumers (e.g. `mcp_notification` listeners for
	 * `notifications/tools/list_changed`) observe not just the manager's
	 * refreshed tool set but also any session-level rebind driven by the
	 * handler (`session.refreshMCPTools`). Other callsites (initial connect,
	 * disconnect, reconnect) do not await it — their downstream chains don't
	 * need to serialize on the rebind.
	 *
	 * Calls are coalesced latest-wins: while the handler is running, further
	 * tool-set changes collapse into a single trailing call that receives the
	 * current tool list.
	 */
	setOnToolsChanged(handler: (tools: CustomTool<TSchema, MCPToolDetails>[]) => void | Promise<void>): void {
		this.#onToolsChanged = handler;
	}

	/**
	 * Invoke the owner {@link setOnToolsChanged} handler, coalescing bursts.
	 * The returned promise settles once the handler has observed a tool set at
	 * least as new as the one current at call time; it rejects only when the
	 * last (newest) handler call failed.
	 */
	#notifyOwnerToolsChanged(): Promise<void> {
		if (!this.#onToolsChanged) return Promise.resolve();
		if (this.#ownerToolsRun) {
			this.#ownerToolsDirty = true;
			return this.#ownerToolsRun;
		}
		let settled = false;
		const run = (async () => {
			try {
				// A failed call must not swallow a call queued while it ran.
				let failure: unknown;
				let failed = false;
				do {
					this.#ownerToolsDirty = false;
					try {
						await this.#onToolsChanged?.(this.getTools());
						failed = false;
					} catch (error) {
						failure = error;
						failed = true;
					}
				} while (this.#ownerToolsDirty);
				if (failed) throw failure;
			} finally {
				settled = true;
				this.#ownerToolsRun = undefined;
			}
		})();
		// The first handler call starts synchronously above; a synchronous throw
		// settles the run before this line, so only publish it while pending.
		if (!settled) this.#ownerToolsRun = run;
		return run;
	}

	/**
	 * Set a callback to fire when any server's resources change.
	 */
	setOnResourcesChanged(handler: (serverName: string, uri: string) => void): void {
		this.#onResourcesChanged = handler;
	}

	/**
	 * Set a callback to fire when any server's prompts change.
	 */
	setOnPromptsChanged(handler: (serverName: string) => void): void {
		this.#onPromptsChanged = handler;
		// Fire immediately for servers that already have prompts loaded
		for (const [name, connection] of this.#connections) {
			if (connection.prompts?.length) {
				handler(name);
			}
		}
	}

	#subscribeAndTrack(name: string, connection: MCPServerConnection, uris: string[], notificationEpoch: number): void {
		void subscribeToResources(connection, uris)
			.then(() => {
				const action = resolveSubscriptionPostAction(
					this.#notificationsEnabled,
					this.#notificationsEpoch,
					notificationEpoch,
				);
				if (action === "rollback") {
					void unsubscribeFromResources(connection, uris).catch(error => {
						logger.debug("Failed to rollback stale MCP resource subscription", {
							path: `mcp:${name}`,
							error,
						});
					});
					return;
				}
				if (action === "ignore") {
					return;
				}
				this.#subscribedResources.set(name, new Set(uris));
			})
			.catch(error => {
				logger.debug("Failed to subscribe to MCP resources", { path: `mcp:${name}`, error });
			});
	}

	setNotificationsEnabled(enabled: boolean): void {
		const wasEnabled = this.#notificationsEnabled;
		this.#notificationsEnabled = enabled;
		if (enabled === wasEnabled) return;

		this.#notificationsEpoch += 1;
		const notificationEpoch = this.#notificationsEpoch;

		if (enabled) {
			// Subscribe to all connected servers that support it
			for (const [name, connection] of this.#connections) {
				if (connection.capabilities.resources?.subscribe && connection.resources) {
					const uris = connection.resources.map(r => r.uri);
					this.#subscribeAndTrack(name, connection, uris, notificationEpoch);
				}
			}
			return;
		}

		// Unsubscribe from all servers
		for (const [name, connection] of this.#connections) {
			const uris = this.#subscribedResources.get(name);
			if (uris && uris.size > 0) {
				void unsubscribeFromResources(connection, Array.from(uris)).catch(error => {
					logger.debug("Failed to unsubscribe MCP resources", { path: `mcp:${name}`, error });
				});
			}
		}
		this.#subscribedResources.clear();
	}

	/**
	 * Set the auth storage for resolving OAuth credentials.
	 */
	setAuthStorage(authStorage: AuthStorage): void {
		this.#authStorage = authStorage;
	}

	/** Set the callback used to complete OAuth after a tool-level auth challenge. */
	setAuthHandler(handler: MCPAuthHandler | undefined): void {
		this.#authHandler = handler;
	}

	/**
	 * Discover and connect to all MCP servers from .mcp.json files.
	 * Returns tools and any connection errors.
	 */
	discoverAndConnect(options?: MCPDiscoverOptions): Promise<MCPLoadResult> {
		const discovery = this.#discoverAndConnect(options);
		this.#discoveryInFlight = discovery.catch(() => undefined);
		return discovery;
	}

	async #discoverAndConnect(options?: MCPDiscoverOptions): Promise<MCPLoadResult> {
		this.#discoverOptions = options ? { ...options } : undefined;
		let loadedConfigs: LoadMCPConfigsResult;
		try {
			loadedConfigs = await this.#discoverConfigs({
				enableProjectConfig: options?.enableProjectConfig,
				filterExa: options?.filterExa,
				filterBrowser: options?.filterBrowser,
				extensionRoots: options?.extensionRoots,
				builtinTransforms: options?.builtinTransforms,
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			this.#startupServers.add(".mcp.json");
			options?.onStatus?.({ type: "failed", serverName: ".mcp.json", error: message });
			this.#emitConnectionStatus({ type: "failed", serverName: ".mcp.json", error: message });
			throw error;
		}
		const { configs, exaApiKeys, sources } = loadedConfigs;
		const result = await this.connectServers(configs, sources, options?.onStatus, options?.startupTimeoutMs);
		result.exaApiKeys = exaApiKeys;
		return result;
	}

	/** Load configs and remember which servers built-in transforms dropped. */
	async #discoverConfigs(options: LoadMCPConfigsOptions): Promise<LoadMCPConfigsResult> {
		const loaded = await this.loadConfigs(this.cwd, options);
		this.#builtinDrops.clear();
		const dropped = loaded.dropped ?? {};
		for (const name in dropped) {
			const drop = dropped[name];
			if (drop) this.#builtinDrops.set(name, drop);
		}
		return loaded;
	}

	/**
	 * Reconcile browser-automation MCP servers with the built-in browser prelude.
	 * Calls are serialized so rapid setting toggles cannot reconnect a server
	 * after a newer enable has filtered it again.
	 */
	reconcileBrowserFilter(enabled: boolean): Promise<void> {
		const reconcile = this.#browserFilterMutationTail.then(() => this.#applyBrowserFilter(enabled));
		this.#browserFilterMutationTail = reconcile.catch(() => undefined);
		return reconcile;
	}

	/**
	 * Apply a live `mcp.enableProjectConfig` change: disconnect project-level
	 * servers when disabled (restoring any user-level server they shadowed), or
	 * connect them when enabled. Serialized with the browser-filter reconcile; a
	 * no-op before the first discovery, which reads the flag itself.
	 */
	reconcileProjectConfig(enabled: boolean): Promise<void> {
		const reconcile = this.#browserFilterMutationTail.then(() => this.#applyProjectConfig(enabled));
		this.#browserFilterMutationTail = reconcile.catch(() => undefined);
		return reconcile;
	}

	async #applyProjectConfig(enabled: boolean): Promise<void> {
		await this.#discoveryInFlight;
		const options = this.#discoverOptions;
		if (!options || (options.enableProjectConfig ?? true) === enabled) return;
		this.#discoverOptions = { ...options, enableProjectConfig: enabled };
		const loaded = await this.#discoverConfigs({
			enableProjectConfig: enabled,
			filterExa: options.filterExa,
			filterBrowser: options.filterBrowser,
			extensionRoots: options.extensionRoots,
			builtinTransforms: options.builtinTransforms,
		});
		// Every server whose resolution depends on the flag: project-level ones
		// known now, plus project-level ones the enabled load resolves.
		const affected = new Set<string>();
		for (const name of this.getAllServerNames()) {
			if (this.getSource(name)?.level === "project") affected.add(name);
		}
		for (const name in loaded.sources) {
			if (loaded.sources[name]?.level === "project") affected.add(name);
		}
		if (affected.size === 0) return;
		await Promise.all([...affected].map(name => this.disconnectServer(name)));
		const configs: Record<string, MCPServerConfig> = {};
		const sources: Record<string, SourceMeta> = {};
		let reconnect = false;
		for (const name of affected) {
			const config = loaded.configs[name];
			if (!config) continue;
			configs[name] = config;
			reconnect = true;
			const source = loaded.sources[name];
			if (source) sources[name] = source;
		}
		if (!reconnect) return;
		await this.connectServers(configs, sources, options.onStatus, options.startupTimeoutMs);
	}

	async #applyBrowserFilter(enabled: boolean): Promise<void> {
		const options = this.#discoverOptions;
		const loaded = await this.#discoverConfigs({
			enableProjectConfig: options?.enableProjectConfig,
			filterExa: options?.filterExa,
			filterBrowser: false,
			extensionRoots: options?.extensionRoots,
			builtinTransforms: options?.builtinTransforms,
		});
		const browserConfigs: Record<string, MCPServerConfig> = {};
		const browserSources: Record<string, SourceMeta> = {};
		for (const name in loaded.configs) {
			const config = loaded.configs[name];
			if (!config || !isBrowserMCPServer(name, config)) continue;
			browserConfigs[name] = config;
			const source = loaded.sources[name];
			if (source) browserSources[name] = source;
		}

		if (!enabled) {
			await this.connectServers(browserConfigs, browserSources, options?.onStatus, options?.startupTimeoutMs);
			this.#discoverOptions = { ...options, filterBrowser: false };
			return;
		}

		const names = new Set<string>();
		for (const name in browserConfigs) names.add(name);
		for (const [name, config] of this.#serverConfigs) {
			if (isBrowserMCPServer(name, config)) names.add(name);
		}
		await Promise.all([...names].map(name => this.disconnectServer(name)));
		this.#discoverOptions = { ...options, filterBrowser: true };
	}

	/**
	 * Connect to specific MCP servers.
	 * Connections are made in parallel for faster startup.
	 *
	 * Incremental: tools for already-owned connections stay in {@link getTools}.
	 * Each newly resolved server is merged via {@link MCPManager.#replaceServerTools}.
	 * Interactive enable (`/mcp enable`, `/extensions`) can pass a single
	 * `{ [name]: config }` without wiping the rest of the registry.
	 */
	async connectServers(
		configs: Record<string, MCPServerConfig>,
		sources: Record<string, SourceMeta>,
		onStatus?: (event: McpConnectionStatusEvent) => void,
		startupTimeoutMs?: number,
	): Promise<MCPLoadResult> {
		const notify = (event: McpConnectionStatusEvent) => {
			onStatus?.(event);
			this.#emitConnectionStatus(event);
		};
		type ConnectionTask = {
			name: string;
			config: MCPServerConfig;
			tracked: TrackedPromise<ToolLoadResult>;
			toolsPromise: Promise<ToolLoadResult>;
			connectSignal: AbortSignal;
		};

		const errors = new Map<string, string>();
		const connectedServers = new Set<string>();
		const reportedErrors = new Set<string>();
		let allowBackgroundLogging = false;
		const statusServerNames: string[] = [];
		const validationFailures: Array<{ name: string; message: string }> = [];

		// Prepare connection tasks
		const connectionTasks: ConnectionTask[] = [];

		for (const [name, config] of Object.entries(configs)) {
			this.#startupServers.add(name);
			// Connecting a server by name (`/mcp enable`) ends its built-in drop.
			this.#builtinDrops.delete(name);
			if (sources[name]) {
				this.#sources.set(name, sources[name]);
				const existing = this.#connections.get(name);
				if (existing) {
					existing._source = sources[name];
				}
			}

			// Skip if already connected
			if (this.#connections.has(name)) {
				connectedServers.add(name);
				continue;
			}

			if (
				this.#pendingConnections.has(name) ||
				this.#pendingToolLoads.has(name) ||
				this.#pendingReconnections.has(name)
			) {
				continue;
			}

			statusServerNames.push(name);

			// Validate config
			const validationErrors = validateServerConfig(name, config);
			if (validationErrors.length > 0) {
				const message = validationErrors.join("; ");
				errors.set(name, message);
				validationFailures.push({ name, message });
				reportedErrors.add(name);
				continue;
			}

			// Save config early so reconnection works even if the initial connect times out.
			this.#serverConfigs.set(name, config);
			const connectionEpoch = this.#epoch;
			const scope = this.#beginConnect(name);
			const connectSignal = scope.signal;

			// Resolve auth config before connecting, but do so per-server in parallel.
			const connectionPromise = (async () => {
				const resolvedConfig = await this.#resolveAuthConfig(config, { signal: connectSignal });
				return this.#connect(name, config, resolvedConfig, scope);
			})().then(
				async connection => {
					// Store original config (without resolved tokens) to keep
					// cache keys stable and avoid leaking rotating credentials.
					connection.config = config;
					if (sources[name]) {
						connection._source = sources[name];
					}

					if (this.#epoch !== connectionEpoch || this.#pendingConnections.get(name) !== connectionPromise) {
						this.#detachConnection(name, connection);
						void disconnectServer(connection).catch(() => {});
						throw new Error(`Server "${name}" was disconnected during initial connection`);
					}

					this.#pendingConnections.delete(name);
					this.#connections.set(name, connection);
					this.#serverConfigs.set(name, config);

					this.#wireLink(name, connection);

					return connection;
				},
				error => {
					if (this.#pendingConnections.get(name) === connectionPromise) {
						this.#pendingConnections.delete(name);
					}
					throw error;
				},
			);
			this.#pendingConnections.set(name, connectionPromise);

			const toolsPromise = connectionPromise.then(async connection => {
				try {
					const serverTools = await listTools(connection);
					return { connection, serverTools };
				} catch (error) {
					// Detach and delete synchronously, then close in the background:
					// awaiting the close here would keep
					// toolsPromise pending past the startup race, so connectServers
					// would return with no error while #pendingToolLoads stayed set
					// and future connects for this server were skipped.
					this.#detachConnection(name, connection);
					void disconnectServer(connection).catch(() => {});
					throw error;
				}
			});
			this.#pendingToolLoads.set(name, toolsPromise);

			const tracked = trackPromise(toolsPromise);
			connectionTasks.push({ name, config, tracked, toolsPromise, connectSignal });

			const startupUpdate = toolsPromise
				.then(async ({ connection, serverTools }) => {
					if (this.#pendingToolLoads.get(name) !== toolsPromise) return;
					this.#pendingToolLoads.delete(name);
					this.#publishServerTools(name, connection, serverTools);
					await this.#notifyOwnerToolsChanged();

					notify({ type: "connected", serverName: name });
					void this.#loadServerResourcesAndPrompts(name, connection);
				})
				.catch(error => {
					// disconnectAll or disconnectServer aborted this connect: torn down, not failed.
					if (isAbortedHandshake(connectSignal, error) || this.#pendingToolLoads.get(name) !== toolsPromise)
						return;
					this.#pendingToolLoads.delete(name);
					const message = error instanceof Error ? error.message : String(error);
					notify(createMcpStartupFailure(name, message, sources[name]));
					if (allowBackgroundLogging && !reportedErrors.has(name)) {
						logger.error("MCP tool load failed", { path: `mcp:${name}`, error: message });
					}
					if (error instanceof MCPConnectionTimeoutError) {
						notify({ type: "reconnecting", serverName: name });
						const stopForwarding = onStatus
							? this.addConnectionStatusListener(event => {
									if ((event.type === "connected" || event.type === "failed") && event.serverName === name) {
										onStatus(event);
									}
								})
							: undefined;
						const retry = this.reconnectServer(name);
						if (stopForwarding) void retry.then(stopForwarding, stopForwarding);
						else void retry;
					}
				})
				.finally(() => {
					if (this.#startupUpdates.get(name) === startupUpdate) this.#startupUpdates.delete(name);
				});
			this.#startupUpdates.set(name, startupUpdate);
		}

		// Notify about servers we're connecting to, including configs that fail fast.
		if (statusServerNames.length > 0) {
			notify({ type: "connecting", serverNames: statusServerNames });
			for (const { name, message } of validationFailures) {
				notify(createMcpStartupFailure(name, message, sources[name]));
			}
		}

		if (connectionTasks.length > 0) {
			const initialLoads = Promise.allSettled(connectionTasks.map(task => task.tracked.promise));
			const windowMs = resolveMCPStartupTimeoutMs(startupTimeoutMs);
			if (windowMs === 0) await initialLoads;
			else await Promise.race([initialLoads, Bun.sleep(windowMs)]);

			// Tasks still pending are left in flight: awaiting them would gate the
			// UI on the slowest server (issue #2100). The `startupUpdate` chain
			// above registers their tools and fires `#onToolsChanged` once the
			// connect finishes, or logs the failure after `allowBackgroundLogging`
			// flips below. A server the host already knows answers from its store
			// well inside the window; an unknown one has nothing to publish yet.
			for (const task of connectionTasks) {
				const { name } = task;
				if (task.tracked.status === "fulfilled") {
					const value = task.tracked.value;
					if (!value) continue;
					const { connection, serverTools } = value;
					connectedServers.add(name);
					// The startup update publishes them too; a disconnect in between already dropped the server.
					if (this.#connections.get(name) === connection) this.#publishServerTools(name, connection, serverTools);
				} else if (task.tracked.status === "rejected") {
					// disconnectAll aborted this handshake inside the startup window: torn down, not failed.
					if (isAbortedHandshake(task.connectSignal, task.tracked.reason)) continue;
					const message =
						task.tracked.reason instanceof Error ? task.tracked.reason.message : String(task.tracked.reason);
					errors.set(name, message);
					reportedErrors.add(name);
				}
			}
		}

		allowBackgroundLogging = true;

		return {
			tools: this.getTools(),
			errors,
			connectedServers: Array.from(connectedServers),
			exaApiKeys: [], // Will be populated by discoverAndConnect
		};
	}

	/**
	 * Ownership is matched via `mcpServerName`, never a `mcp__${name}_` name
	 * prefix: tool names are lossy-sanitized, so one server's sanitized name
	 * can prefix another's (`atlassian` vs `atlassian:atlassian`) and a name
	 * with sanitized characters never prefix-matches its own tools at all.
	 */
	#replaceServerTools(name: string, tools: CustomTool<TSchema, MCPToolDetails>[]): void {
		this.#tools = this.#tools.filter(t => t.mcpServerName !== name);
		this.#tools.push(...tools);
		// Stable sort by name so reconnect order does not perturb the array.
		// See `sortMCPToolsByName` for the cache-stability rationale.
		sortMCPToolsByName(this.#tools);
		const scoped = this.#scopedTools.get(name);
		if (scoped) {
			const present = new Set(tools.map(tool => tool.mcpToolName));
			for (const toolName of scoped.keys()) {
				if (!present.has(toolName)) scoped.delete(toolName);
			}
			if (scoped.size === 0) this.#scopedTools.delete(name);
		}
		this.#emitToolsChanged();
	}

	/**
	 * Observer for `name`'s tools. A call completes only after the tool refresh
	 * it provoked lands, then its session sees every tool the server now serves.
	 */
	#observeToolCall(name: string): MCPToolCallObserver {
		return toolCallId => {
			const scope = this.#toolCallScopes.get(toolCallId) ?? OWNER_TOOL_SCOPE;
			this.#inFlightToolCalls.set(name, (this.#inFlightToolCalls.get(name) ?? 0) + 1);
			return async () => {
				const remaining = (this.#inFlightToolCalls.get(name) ?? 1) - 1;
				if (remaining > 0) this.#inFlightToolCalls.set(name, remaining);
				else this.#inFlightToolCalls.delete(name);
				// A `list_changed` sent during the call already started this refresh.
				await this.#toolRefreshes.get(name)?.promise.catch(() => {});
				this.#grantServerTools(name, scope);
			};
		};
	}

	/** Let `scope` see every tool `name` serves; notify it when that changed its view. */
	#grantServerTools(name: string, scope: MCPToolScope): void {
		const scoped = this.#scopedTools.get(name);
		if (!scoped) return;
		let granted = false;
		for (const scopes of scoped.values()) {
			if (scopes.has(scope)) continue;
			scopes.add(scope);
			granted = true;
		}
		if (!granted) return;
		this.#toolViewsRevision++;
		if (scope === OWNER_TOOL_SCOPE) {
			this.#notifyOwnerToolsChanged().catch(error => logger.debug("MCP tools-changed handler failed", { error }));
		} else {
			this.#emitToolsChanged();
		}
	}

	openToolScope(scope: MCPToolScope, seed: MCPToolScope = OWNER_TOOL_SCOPE): void {
		if (this.#toolScopes.has(scope)) return;
		this.#toolScopes.add(scope);
		for (const scoped of this.#scopedTools.values()) {
			for (const scopes of scoped.values()) {
				if (scopes.has(seed)) scopes.add(scope);
			}
		}
	}

	trackToolCall(scope: MCPToolScope, toolCallId: string): () => void {
		this.#toolCallScopes.set(toolCallId, scope);
		return () => {
			if (this.#toolCallScopes.get(toolCallId) === scope) this.#toolCallScopes.delete(toolCallId);
		};
	}

	/** Tools in `tools` that `name` does not serve yet start visible to no scope. */
	#scopeAddedTools(name: string, tools: readonly CustomTool<TSchema, MCPToolDetails>[]): void {
		const previous = new Set(this.#tools.filter(tool => tool.mcpServerName === name).map(tool => tool.mcpToolName));
		const scoped = this.#scopedTools.get(name) ?? new Map<string, Set<MCPToolScope>>();
		for (const tool of tools) {
			if (tool.mcpToolName !== undefined && !previous.has(tool.mcpToolName)) scoped.set(tool.mcpToolName, new Set());
		}
		if (scoped.size > 0) this.#scopedTools.set(name, scoped);
	}

	#triggerNotificationRefresh(serverName: string, kind: "tools" | "resources" | "prompts"): Promise<void> {
		const refresh = (() => {
			switch (kind) {
				case "tools":
					return this.refreshServerTools(serverName);
				case "resources":
					return this.refreshServerResources(serverName);
				case "prompts":
					return this.refreshServerPrompts(serverName);
			}
		})();
		return refresh.catch(error => {
			logger.debug("Failed MCP notification refresh", { path: `mcp:${serverName}`, kind, error });
		});
	}
	async #handleServerNotification(serverName: string, method: string, params: unknown): Promise<void> {
		logger.debug("MCP notification received", { path: `mcp:${serverName}`, method });

		// Only trigger refresh if the connection is already stored — during the
		// initial connect handshake, notifications may arrive before
		// `#connections.set()` completes, and `refreshServer*` would no-op
		// anyway. Skipping the await in that case preserves arrival order
		// across concurrently-dispatched notifications (an awaited refresh,
		// even a no-op, yields a microtask that lets later frames overtake).
		const connectionKnown = this.#connections.has(serverName);
		let refreshPromise: Promise<void> | undefined;
		switch (method) {
			case MCPNotificationMethods.TOOLS_LIST_CHANGED:
				if (connectionKnown) {
					// A change announced during a call belongs to the sessions whose calls see it through.
					if (this.#inFlightToolCalls.has(serverName)) this.#callProvokedToolRefreshes.add(serverName);
					refreshPromise = this.#triggerNotificationRefresh(serverName, "tools");
				}
				break;
			case MCPNotificationMethods.RESOURCES_LIST_CHANGED:
				if (connectionKnown) refreshPromise = this.#triggerNotificationRefresh(serverName, "resources");
				break;
			case MCPNotificationMethods.RESOURCES_UPDATED: {
				const uri =
					params && typeof params === "object" && "uri" in params && typeof params.uri === "string"
						? params.uri
						: undefined;
				const subscribed = this.#subscribedResources.get(serverName);
				if (uri && subscribed?.has(uri)) {
					this.#onResourcesChanged?.(serverName, uri);
				}
				break;
			}
			case MCPNotificationMethods.PROMPTS_LIST_CHANGED:
				if (connectionKnown) refreshPromise = this.#triggerNotificationRefresh(serverName, "prompts");
				break;
			default:
				break;
		}

		// Await internal refresh so listeners see the manager's post-refresh
		// state (satisfies the documented "AFTER the manager's own handling"
		// contract on `addNotificationListener` — otherwise an extension acting
		// on `tools/list_changed` could hit stale `getTools()`).
		if (refreshPromise) {
			await refreshPromise;
		}

		// Buffer for late-attaching subscribers when no listener exists yet.
		if (this.#notificationListeners.size === 0) {
			this.#pendingNotifications.push({ server: serverName, method, params });
			if (this.#pendingNotifications.length > NOTIFICATION_BUFFER_CAP) {
				this.#pendingNotifications.shift();
			}
			return;
		}

		for (const listener of this.#notificationListeners) {
			try {
				listener(serverName, method, params);
			} catch (error) {
				logger.debug("MCP notification listener threw", {
					path: `mcp:${serverName}`,
					method,
					error,
				});
			}
		}
	}

	getTools(scope: MCPToolScope = OWNER_TOOL_SCOPE): CustomTool<TSchema, MCPToolDetails>[] {
		if (this.#scopedTools.size === 0) return this.#tools;
		return this.#tools.filter(tool => {
			const scopes = this.#scopedTools.get(tool.mcpServerName ?? "")?.get(tool.mcpToolName ?? "");
			return scopes === undefined || scopes.has(scope);
		});
	}

	/**
	 * Settles once the servers connecting now have published their tools (the owner's tool-change
	 * callback awaited) or failed, each bounded by its connect timeout. Unlike {@link waitForStartup},
	 * it waits neither on reconnects and reloads (a timed-out connect's retry, `/mcp reload`,
	 * `tools/list_changed`) nor on connects started later.
	 */
	async waitForPendingConnects(): Promise<void> {
		await Promise.allSettled([...this.#startupUpdates.values()]);
	}

	/**
	 * Wait for configured servers' initial tools (including timeout-triggered reconnects).
	 * Zero disables the barrier deadline; an unresponsive server can then wait indefinitely.
	 * Tool-change callbacks are drained before returning; callers should still refresh their
	 * session with the final tool snapshot before sending a prompt.
	 */
	async waitForStartup(timeoutMs: number): Promise<MCPStartupStatus> {
		const deadline = timeoutMs > 0 ? Date.now() + timeoutMs : Infinity;
		for (;;) {
			const pending = [
				...this.#startupUpdates.values(),
				...this.#pendingReconnections.values(),
				...this.#pendingReloads.values(),
			];
			if (pending.length === 0 || Date.now() >= deadline) break;

			const { promise, resolve } = Promise.withResolvers<void>();
			const remaining = deadline - Date.now();
			const timer = remaining === Infinity ? undefined : setTimeout(resolve, Math.min(remaining, 2_147_483_647));
			try {
				await Promise.race([Promise.allSettled(pending), promise]);
			} finally {
				clearTimeout(timer);
			}
		}

		const status: MCPStartupStatus = { connected: [], pending: [], failed: [] };
		for (const name of this.#startupServers) {
			if (
				this.#startupUpdates.has(name) ||
				this.#pendingToolLoads.has(name) ||
				this.#pendingConnections.has(name) ||
				this.#pendingReconnections.has(name) ||
				this.#pendingReloads.has(name)
			) {
				status.pending.push(name);
			} else if (this.#ready.has(name) && this.#connections.get(name)?.transport.connected) {
				status.connected.push(name);
			} else {
				status.failed.push({
					name,
					error: this.#startupFailures.get(name) ?? "Connection closed before tools became available",
				});
			}
		}
		return status;
	}

	/**
	 * Get a specific connection.
	 */
	getConnection(name: string): MCPServerConnection | undefined {
		return this.#connections.get(name);
	}

	/**
	 * Connection status of a server: `connected` only while its link is
	 * attached to the host and its tools were loaded on that attachment,
	 * `connecting` while a connect, a reconnect, the link's own re-attach or
	 * the reload after it is in flight. A server whose link is detached or
	 * whose reload failed is `disconnected` even though its tools stay registered.
	 */
	getConnectionStatus(name: string): "connected" | "connecting" | "disconnected" {
		const link = this.#connections.get(name)?.transport;
		if (link?.connected && this.#ready.has(name)) return "connected";
		if (
			link?.reattaching ||
			this.#pendingConnections.has(name) ||
			this.#pendingToolLoads.has(name) ||
			this.#pendingReconnections.has(name) ||
			this.#pendingReloads.has(name)
		)
			return "connecting";
		return "disconnected";
	}

	/**
	 * Get the source metadata for a server.
	 */
	getSource(name: string): SourceMeta | undefined {
		return this.#sources.get(name) ?? this.#connections.get(name)?._source;
	}

	/**
	 * Servers the newest config load left unconnected because a built-in
	 * transform dropped them, by name. `/mcp list` and the extensions dashboard
	 * report them; connecting one by name removes it.
	 */
	getBuiltinDrops(): ReadonlyMap<string, MCPDroppedServer> {
		return this.#builtinDrops;
	}

	/**
	 * Get the preserved (pre-auth) config for a known server — whether currently
	 * connected or merely discovered (a connect was attempted but may have failed,
	 * e.g. an OAuth server that has not been authorized yet). Mirrors the
	 * reconnect lookup at {@link reconnectServer} so callers like `/mcp reauth`
	 * can recover a discovered server's config without re-reading config files.
	 */
	getServerConfig(name: string): MCPServerConfig | undefined {
		return this.#connections.get(name)?.config ?? this.#serverConfigs.get(name);
	}

	/**
	 * Replace a stored server definition in place — used when its credentials
	 * were refreshed outside the manager (e.g. `/mcp reauth` wrote a fresh
	 * url-keyed credential row and the next auth resolution must pick it up).
	 *
	 * Updates both the stored definition and any live connection's `config`
	 * ({@link reconnectServer} prefers the live connection's copy over the
	 * stored map).
	 *
	 * Returns the in-flight reconnection for the server, if one was pending:
	 * it captured the old definition and aborts on its next identity check.
	 * Callers that intend to reconnect must await it first, or
	 * {@link reconnectServer} merely joins the dying attempt instead of
	 * starting a fresh one against the new definition.
	 */
	updateServerConfig(name: string, config: MCPServerConfig): Promise<MCPServerConnection | null> | undefined {
		this.#serverConfigs.set(name, config);
		const connection = this.#connections.get(name);
		if (connection) connection.config = config;
		return this.#pendingReconnections.get(name);
	}

	/**
	 * Wait for a connection to complete (or fail).
	 */
	async waitForConnection(name: string): Promise<MCPServerConnection> {
		const connection = this.#connections.get(name);
		if (connection) return connection;
		const pending = this.#pendingConnections.get(name);
		if (pending) return pending;
		// If a reconnection is in flight, wait for it to complete
		const reconnecting = this.#pendingReconnections.get(name);
		if (reconnecting) {
			const result = await reconnecting;
			if (result) return result;
		}
		throw new Error(this.#describeNotConnected(name));
	}

	/** Why `name` has no connection and what happens next, for the failing call. */
	#describeNotConnected(name: string): string {
		const parts = [`MCP server not connected: ${name}`];
		const lastError = this.#lastConnectErrors.get(name);
		if (lastError) parts.push(`last connect error: ${lastError}`);
		if (!this.#serverConfigs.has(name)) parts.push("the server is not configured in this session");
		return parts.join("; ");
	}

	/**
	 * Wait for every in-flight connect, tool load, and reconnect to settle.
	 *
	 * One-shot callers (e.g. `omp read <mcp-resource>`) discover servers and read
	 * immediately; a server whose handshake outlasts the {@link connectServers}
	 * startup race is still tracked in {@link #pendingConnections} /
	 * {@link #pendingToolLoads} and therefore invisible to
	 * {@link getConnectedServers}. Awaiting the pending work lets those callers
	 * observe the final attached/failed state instead of racing mid-handshake.
	 * Rejections are swallowed — the caller re-reads state afterwards.
	 */
	async waitForPendingConnections(): Promise<void> {
		// A settling tool load can arm a reconnect (startup-timeout retry), so
		// drain in passes until no work remains. Bounded so a reconnect storm
		// cannot spin this forever.
		for (let pass = 0; pass < 8; pass++) {
			const pending: Promise<unknown>[] = [
				...this.#pendingConnections.values(),
				...this.#pendingToolLoads.values(),
				...this.#pendingReconnections.values(),
			];
			if (pending.length === 0) return;
			await Promise.allSettled(pending);
		}
	}

	/**
	 * Resolve auth and shell-command substitutions in config before connecting.
	 * Pass `oauth: false` to skip OAuth credential injection (used by reauth's
	 * unauthenticated probe, which must observe the server's bare 401).
	 */
	async prepareConfig(config: MCPServerConfig, options?: { oauth?: boolean }): Promise<MCPServerConfig> {
		return this.#resolveAuthConfig(config, options);
	}

	/**
	 * Get all connected server names.
	 */
	getConnectedServers(): string[] {
		return Array.from(this.#connections.keys());
	}

	/**
	 * Get all known server names (connected, connecting, or discovered).
	 */
	getAllServerNames(): string[] {
		return Array.from(
			new Set([...this.#sources.keys(), ...this.#connections.keys(), ...this.#pendingConnections.keys()]),
		);
	}

	/**
	 * Drop a connection from the active map and detach its lifecycle hooks.
	 *
	 * Synchronous and identity-guarded: only removes the entry when it is still
	 * the connection registered under `name`, so a stale cleanup never evicts a
	 * newer connection for the same server. Detaching `onClose` first prevents
	 * the transport's own `close()` from re-arming reconnect.
	 */
	#detachConnection(name: string, connection: MCPServerConnection): void {
		connection.transport.onClose = undefined;
		if (this.#connections.get(name) === connection) {
			this.#connections.delete(name);
			this.#ready.delete(name);
		}
	}

	/**
	 * Detach a connection and await its transport close.
	 *
	 * Use only where blocking on the close is acceptable (owned disconnects,
	 * dispose). On reject-fast paths detach synchronously and close in the
	 * background so a slow `close()` cannot delay the
	 * rejection — see the `tools/list` failure handler in `connectServers`.
	 */
	async #discardConnection(name: string, connection: MCPServerConnection): Promise<void> {
		this.#detachConnection(name, connection);
		await disconnectServer(connection);
	}

	/**
	 * Disconnect from a specific server.
	 */
	async disconnectServer(name: string): Promise<void> {
		this.#startupServers.delete(name);
		this.#startupFailures.delete(name);
		this.#startupUpdates.delete(name);
		this.#pendingConnections.delete(name);
		this.#pendingToolLoads.delete(name);
		this.#pendingReconnections.delete(name);
		this.#sources.delete(name);
		this.#serverConfigs.delete(name);
		this.#pendingResourceRefresh.delete(name);
		this.#pendingReloads.delete(name);
		this.#ready.delete(name);
		// A connect still in flight holds a unit lease; nothing else would ever give it back.
		this.#serverScopes.get(name)?.controller.abort();
		this.#serverScopes.delete(name);
		this.#runtimes.delete(name);
		this.#callProvokedToolRefreshes.delete(name);
		this.#scopedTools.delete(name);

		const connection = this.#connections.get(name);

		const subscribedUris = this.#subscribedResources.get(name);
		if (subscribedUris && subscribedUris.size > 0 && connection) {
			void unsubscribeFromResources(connection, Array.from(subscribedUris)).catch(() => {});
		}
		this.#subscribedResources.delete(name);

		if (connection) {
			await this.#discardConnection(name, connection);
		}

		// Remove tools from this server and notify consumers
		const hadTools = this.#tools.some(t => t.mcpServerName === name);
		this.#tools = this.#tools.filter(t => t.mcpServerName !== name);
		if (hadTools) {
			this.#emitToolsChanged();
			this.#notifyOwnerToolsChanged().catch(error => logger.debug("MCP tools-changed handler failed", { error }));
		}

		// Notify prompt consumers so stale commands are cleared
		if (connection?.prompts?.length) this.#onPromptsChanged?.(name);
	}

	/**
	 * Disconnect from all servers.
	 */
	async disconnectAll(): Promise<void> {
		// Invalidate any in-flight reconnection attempts that outlive this call.
		// They captured the old epoch; after increment they'll detect staleness.
		// Abort the connects still in flight too: a stalled one would otherwise
		// keep its unit lease until its own timeout, or forever.
		this.#epoch++;
		this.#connectAbort.abort();
		this.#connectAbort = new AbortController();
		const promises = Array.from(this.#connections, ([name, connection]) => this.#discardConnection(name, connection));
		await Promise.allSettled(promises);

		this.#pendingConnections.clear();
		this.#pendingToolLoads.clear();
		this.#startupUpdates.clear();
		this.#startupServers.clear();
		this.#startupFailures.clear();
		this.#pendingReconnections.clear();
		this.#pendingResourceRefresh.clear();
		this.#sources.clear();
		this.#builtinDrops.clear();
		// The next connect (`/mcp reload` rediscovery) runs every `!command` again.
		for (const config of this.#serverConfigs.values()) invalidateCommandValues(config);
		this.#serverConfigs.clear();
		this.#callProvokedToolRefreshes.clear();
		this.#scopedTools.clear();
		const hadTools = this.#tools.length > 0;
		this.#tools = [];
		if (hadTools) this.#emitToolsChanged();
		this.#subscribedResources.clear();
		this.#runtimes.clear();
		this.#ready.clear();
		this.#serverScopes.clear();
		this.#pendingReloads.clear();
	}

	/**
	 * Reconnect to a server after a failure, or on request.
	 *
	 * A server that never connected is connected from scratch. A connected one
	 * keeps its link: auth is re-resolved, and when that names another server
	 * identity (a refreshed token, a moved working directory) or the link lost
	 * its attachment, the link attaches to the unit of the new one. Then the
	 * server is discovered again and its catalogs reloaded. Concurrent calls
	 * for the same server share one attempt. Returns the connection, or `null`
	 * when the reconnect failed or the server was disconnected meanwhile.
	 * @param options.manual - When `true` (`/mcp reconnect`), the host also
	 *   stops the upstream and forgets its crash history, so the next request
	 *   starts a fresh one; when the host itself is elsewhere by now
	 *   (`mcp.shared` was toggled) the link moves there instead. The link-loss
	 *   and tool-call retry paths MUST NOT set it: a modern upstream is shared
	 *   with other sessions.
	 * @param options.staleSession - The server lost the protocol session it
	 *   held for this manager. A handshake-era upstream, which no other manager
	 *   uses, is restarted so the retry starts a new session.
	 */
	async reconnectServer(
		name: string,
		options?: MCPReconnectOptions & { manual?: boolean },
	): Promise<MCPServerConnection | null> {
		const pending = this.#pendingReconnections.get(name);
		if (pending) return pending;
		const attempt = this.#doReconnect(name, options ?? {});
		this.#pendingReconnections.set(name, attempt);
		try {
			return await attempt;
		} finally {
			if (this.#pendingReconnections.get(name) === attempt) this.#pendingReconnections.delete(name);
		}
	}

	async #doReconnect(
		name: string,
		options: MCPReconnectOptions & { manual?: boolean },
	): Promise<MCPServerConnection | null> {
		const connection = this.#connections.get(name);
		let config = connection?.config ?? this.#serverConfigs.get(name);
		const source = this.#sources.get(name) ?? connection?._source;
		if (!config) return null;

		if (options.authChallenge) {
			if (!this.#authHandler) {
				logger.error("MCP auth challenge cannot be handled; no auth handler is configured", {
					path: `mcp:${name}`,
				});
				return null;
			}
			try {
				const refreshedConfig = await this.#authHandler(name, options.authChallenge);
				if (!refreshedConfig) return null;
				config = refreshedConfig;
				this.#serverConfigs.set(name, config);
				if (connection) connection.config = config;
			} catch (error) {
				logger.error("MCP auth challenge handling failed", { path: `mcp:${name}`, error });
				return null;
			}
		}

		logger.debug("MCP reconnecting", { path: `mcp:${name}` });
		// A reconnect follows a lost or rejected connection; a cached `!command`
		// token may be what the server rejected, so mint fresh values once.
		invalidateCommandValues(config);

		const reconnectEpoch = this.#epoch;
		this.#pendingConnections.delete(name);
		this.#pendingToolLoads.delete(name);
		try {
			let live: MCPServerConnection;
			if (connection) {
				await this.#relinkServer(name, connection, config, options);
				live = connection;
			} else {
				live = await this.#connectAndWireServer(name, config, source, reconnectEpoch);
			}
			logger.debug("MCP reconnected", { path: `mcp:${name}`, tools: live.tools?.length ?? 0 });
			this.#emitConnectionStatus({ type: "connected", serverName: name });
			return live;
		} catch (error) {
			if (this.#epoch !== reconnectEpoch || this.#serverConfigs.get(name) !== config) {
				logger.debug("MCP reconnect aborted after configuration changed", {
					path: `mcp:${name}`,
					storedEpoch: reconnectEpoch,
					currentEpoch: this.#epoch,
				});
				return null;
			}
			// Stale tools stay registered so they remain selected: a later call
			// retries the reconnect, or the user runs /mcp reconnect <name>.
			const msg = error instanceof Error ? error.message : String(error);
			logger.error("MCP reconnect failed", { path: `mcp:${name}`, error: msg });
			this.#emitConnectionStatus({ type: "failed", serverName: name, error: msg });
			return null;
		}
	}

	/** Bring a connected server's link back in line with its config and the current host, then reload what the server offers. */
	async #relinkServer(
		name: string,
		connection: HostedMCPConnection,
		config: MCPServerConfig,
		options: MCPReconnectOptions & { manual?: boolean },
	): Promise<void> {
		this.#ready.delete(name);
		const signal = this.#serverScopes.get(name)?.signal ?? this.#connectAbort.signal;
		const link = connection.transport;
		// The config may have gained or lost refreshable credentials since the link was wired (`/mcp reauth`).
		link.onAuthError = this.#authRefreshHook(config);
		const resolvedConfig = await this.#resolveAuthConfig(config, { signal });
		const spec = buildServerSpec(resolvedConfig, this.cwd);
		const elsewhere =
			!link.connected ||
			mcpIdentity(spec) !== mcpIdentity(link.spec) ||
			(options.manual === true && (await link.hostMoved()));
		if (elsewhere) {
			await link.retarget(spec, signal);
		} else if (options.manual || (options.staleSession && link.status?.era === "legacy")) {
			await link.restart();
		}
		await this.#reloadServer(name, connection, signal);
	}

	/**
	 * Discover the server again and replace everything memoized from it: tools
	 * now, resources and prompts in the background. The server is not ready
	 * while this runs, and stays so when it fails.
	 */
	async #reloadServer(name: string, connection: HostedMCPConnection, signal?: AbortSignal): Promise<void> {
		this.#ready.delete(name);
		await discoverServer(connection, { signal });
		const serverTools = await listTools(connection, { signal });
		if (this.#connections.get(name) !== connection) return;
		this.#publishServerTools(name, connection, serverTools);
		this.#notifyOwnerToolsChanged().catch(error => logger.debug("MCP tools-changed handler failed", { error }));
		// A listing begun before the reload describes what the server offered then.
		this.#pendingResourceRefresh.delete(name);
		void this.#loadServerResourcesAndPrompts(name, connection);
	}

	/** Register `serverTools` as what `name` offers on its current attachment; the server is ready from here. */
	#publishServerTools(name: string, connection: MCPServerConnection, serverTools: MCPToolDefinition[]): void {
		const reconnect: MCPReconnect = options => this.reconnectServer(name, options);
		this.#replaceServerTools(
			name,
			MCPTool.fromTools(connection, serverTools, reconnect, this.#observeToolCall(name)),
		);
		this.#ready.add(name);
	}

	/**
	 * Start a connect of `name`, ending the one it may still have: the scope's
	 * signal aborts with the server's own disconnect or the manager's.
	 */
	#beginConnect(name: string): ServerScope {
		this.#serverScopes.get(name)?.controller.abort();
		const controller = new AbortController();
		const scope = { controller, signal: AbortSignal.any([this.#connectAbort.signal, controller.signal]) };
		this.#serverScopes.set(name, scope);
		return scope;
	}

	/** Connect `name` through the host as this manager: its instance, its roots, its notification handling. */
	#connect(
		name: string,
		config: MCPServerConfig,
		resolvedConfig: MCPServerConfig,
		scope: ServerScope,
	): Promise<HostedMCPConnection> {
		return connectToServer(name, resolvedConfig, {
			signal: scope.signal,
			cwd: this.cwd,
			instance: this.#owner,
			idleMs: this.idleMs,
			access: this.hostAccess,
			roots: () => projectRoots(this.cwd),
			onNotification: (method, params) => {
				this.#handleServerNotification(name, method, params);
			},
			// A connect given up on may still attach and report; only the registered one speaks for the server.
			onStatus: status => {
				if (this.#serverScopes.get(name) === scope) this.#runtimes.set(name, status);
			},
			onReattach: change => this.#linkReattached(name, change),
			// From the first attach on: the era probe is where a stale token is refused first.
			onAuthError: this.#authRefreshHook(config),
		});
	}

	/**
	 * The link took a new attachment (the host was replaced, a credential
	 * refresh or a reconnect retargeted it): what the server offers may differ,
	 * so reload it, unless a reconnect in flight does. The returned promise
	 * settles with that reload, which is what the link counts as the recovery.
	 */
	#linkReattached(name: string, change: HostLinkReattach): Promise<void> | undefined {
		const connection = this.#connections.get(name);
		if (!connection) return undefined;
		// Subscriptions named resources of the old identity; the reload derives the new ones from its catalog.
		if (change.identityChanged) this.#subscribedResources.delete(name);
		const reconnecting = this.#pendingReconnections.get(name);
		if (reconnecting) {
			return reconnecting.then(
				() => undefined,
				() => undefined,
			);
		}
		logger.debug("MCP host link re-attached", { path: `mcp:${name}` });
		const signal = this.#serverScopes.get(name)?.signal ?? this.#connectAbort.signal;
		const reload: Promise<void> = this.#reloadServer(name, connection, signal)
			.then(
				() => {
					if (this.#ready.has(name)) this.#emitConnectionStatus({ type: "connected", serverName: name });
				},
				error => {
					if (signal.aborted || this.#connections.get(name) !== connection) return;
					const message = error instanceof Error ? error.message : String(error);
					logger.debug("Failed to reload MCP server after re-attach", { path: `mcp:${name}`, error: message });
					this.#emitConnectionStatus({ type: "failed", serverName: name, error: message });
				},
			)
			.finally(() => {
				if (this.#pendingReloads.get(name) === reload) this.#pendingReloads.delete(name);
			});
		this.#pendingReloads.set(name, reload);
		return reload;
	}

	/** Wire a stored connection's link: one reconnect when the link cannot re-attach by itself. */
	#wireLink(name: string, connection: HostedMCPConnection): void {
		connection.transport.onClose = () => {
			this.#ready.delete(name);
			if (this.#pendingReconnections.has(name)) return;
			logger.debug("MCP host link lost, triggering reconnect", { path: `mcp:${name}` });
			this.#emitConnectionStatus({ type: "reconnecting", serverName: name });
			void this.reconnectServer(name);
		};
	}

	/** Establish a new connection to a server, wire handlers, load tools. */
	async #connectAndWireServer(
		name: string,
		config: MCPServerConfig,
		source: SourceMeta | undefined,
		reconnectEpoch: number,
	): Promise<MCPServerConnection> {
		// Opened before resolving credentials: a disconnect during that wait must abort this connect too.
		const scope = this.#beginConnect(name);
		const resolvedConfig = await this.#resolveAuthConfig(config, { signal: scope.signal });
		const connection = await this.#connect(name, config, resolvedConfig, scope);

		connection.config = config;
		if (source) connection._source = source;

		// Bail out if the server was disconnected or the manager was reset
		// while we were connecting (e.g. /mcp reload called disconnectAll).
		if (this.#serverConfigs.get(name) !== config || this.#epoch !== reconnectEpoch) {
			this.#detachConnection(name, connection);
			void disconnectServer(connection).catch(() => {});
			throw new Error(`Server "${name}" was disconnected during reconnection`);
		}

		this.#connections.set(name, connection);
		this.#wireLink(name, connection);
		try {
			const serverTools = await listTools(connection, { signal: scope.signal });
			this.#publishServerTools(name, connection, serverTools);
			this.#notifyOwnerToolsChanged().catch(error => logger.debug("MCP tools-changed handler failed", { error }));
			void this.#loadServerResourcesAndPrompts(name, connection);
			return connection;
		} catch (error) {
			// Detach synchronously and close in the background so a slow close
			// cannot delay the rejection.
			this.#detachConnection(name, connection);
			void disconnectServer(connection).catch(() => {});
			throw error;
		}
	}

	/**
	 * Best-effort loading of resources, resource subscriptions, and prompts.
	 * Shared between initial connection and reconnection. A resource read that reached this fresh
	 * connection first may already have loaded its catalog; that load is current, so join it instead
	 * of blanking the catalog for a second listing.
	 */
	async #loadServerResourcesAndPrompts(name: string, connection: MCPServerConnection): Promise<void> {
		if (serverSupportsResources(connection.capabilities)) {
			try {
				await this.ensureServerResources(name);
			} catch (error) {
				logger.debug("Failed to load MCP resources", { path: `mcp:${name}`, error });
			}
		}

		if (serverSupportsPrompts(connection.capabilities)) {
			try {
				await this.refreshServerPrompts(name);
			} catch (error) {
				logger.debug("Failed to load MCP prompts", { path: `mcp:${name}`, error });
			}
		}
	}

	/**
	 * Refresh tools from a specific server.
	 *
	 * Single-flight per server: a refresh requested while one is running marks
	 * it dirty and shares its promise, so a `tools/list_changed` burst costs at
	 * most one in-flight plus one trailing `tools/list`.
	 */
	refreshServerTools(name: string): Promise<void> {
		const existing = this.#toolRefreshes.get(name);
		if (existing) {
			existing.dirty = true;
			return existing.promise;
		}
		if (!this.#connections.has(name)) return Promise.resolve();
		const entry = { dirty: false, promise: Promise.resolve() };
		entry.promise = (async () => {
			try {
				// A failed pass must not swallow a refresh queued while it ran.
				let failure: unknown;
				let failed = false;
				do {
					entry.dirty = false;
					try {
						await this.#refreshServerToolsOnce(name);
						failed = false;
					} catch (error) {
						failure = error;
						failed = true;
					}
				} while (entry.dirty);
				if (failed) throw failure;
			} finally {
				if (this.#toolRefreshes.get(name) === entry) this.#toolRefreshes.delete(name);
			}
		})();
		this.#toolRefreshes.set(name, entry);
		return entry.promise;
	}

	async #refreshServerToolsOnce(name: string): Promise<void> {
		const connection = this.#connections.get(name);
		if (!connection) return;

		// Clear cached tools
		connection.tools = undefined;

		// Claimed before the request: only a list requested after a call's notice
		// can hold the tools that call made the server add. A pass already in
		// flight leaves the flag to the re-run the notice queued.
		const callProvoked = this.#callProvokedToolRefreshes.delete(name);
		let serverTools: MCPToolDefinition[];
		try {
			serverTools = await listTools(connection);
		} catch (error) {
			if (callProvoked) this.#callProvokedToolRefreshes.add(name);
			throw error;
		}
		const reconnect: MCPReconnect = options => this.reconnectServer(name, options);
		const customTools = MCPTool.fromTools(connection, serverTools, reconnect, this.#observeToolCall(name));
		if (callProvoked) this.#scopeAddedTools(name, customTools);

		// Replace tools from this server
		this.#replaceServerTools(name, customTools);
		await this.#notifyOwnerToolsChanged();
	}

	/**
	 * Refresh tools from all servers.
	 */
	async refreshAllTools(): Promise<void> {
		const promises = Array.from(this.#connections.keys()).map(name => this.refreshServerTools(name));
		await Promise.allSettled(promises);
	}

	/**
	 * Refresh resources from a specific server.
	 */
	async refreshServerResources(name: string): Promise<void> {
		const connection = this.#connections.get(name);
		if (!connection || !serverSupportsResources(connection.capabilities)) return;

		const existing = this.#pendingResourceRefresh.get(name);
		if (existing && existing.connection === connection) return existing.promise;

		const doRefresh = async (): Promise<void> => {
			// Clear cached resources
			connection.resources = undefined;
			connection.resourceTemplates = undefined;

			// Reload. Template listing failures must not discard a successful
			// resources/list — let both settle, then continue without templates.
			const [resourcesResult, templatesResult] = await Promise.allSettled([
				listResources(connection),
				listResourceTemplates(connection),
			]);
			if (templatesResult.status === "rejected") {
				logger.debug("Failed to list MCP resource templates", {
					path: `mcp:${name}`,
					error: templatesResult.reason,
				});
			}
			if (resourcesResult.status === "rejected") throw resourcesResult.reason;
			const resources = resourcesResult.value;
			if (this.#notificationsEnabled && connection.capabilities.resources?.subscribe) {
				const newUris = new Set(resources.map(r => r.uri));
				const oldUris = this.#subscribedResources.get(name);
				const notificationEpoch = this.#notificationsEpoch;

				// Unsubscribe URIs that were removed
				if (oldUris) {
					const removed = [...oldUris].filter(uri => !newUris.has(uri));
					if (removed.length > 0) {
						try {
							await unsubscribeFromResources(connection, removed);
						} catch (error) {
							logger.debug("Failed to unsubscribe stale MCP resources", { path: `mcp:${name}`, error });
						}
					}
				}

				// Subscribe to the current set and update tracking atomically
				try {
					const allUris = [...newUris];
					await subscribeToResources(connection, allUris);
					const action = resolveSubscriptionPostAction(
						this.#notificationsEnabled,
						this.#notificationsEpoch,
						notificationEpoch,
					);
					if (action === "rollback") {
						await unsubscribeFromResources(connection, allUris).catch(error => {
							logger.debug("Failed to rollback stale MCP resource subscription", { path: `mcp:${name}`, error });
						});
						return;
					}
					if (action === "ignore") {
						return;
					}
					this.#subscribedResources.set(name, newUris);
				} catch (error) {
					logger.debug("Failed to re-subscribe to MCP resources", { path: `mcp:${name}`, error });
				}
			}
		};

		const promise = doRefresh()
			.then(() => {
				this.#emitCatalogChange({ serverName: name, kind: "resources" });
			})
			.finally(() => {
				const pending = this.#pendingResourceRefresh.get(name);
				if (pending?.promise === promise) {
					this.#pendingResourceRefresh.delete(name);
				}
			});
		this.#pendingResourceRefresh.set(name, { connection, promise });
		return promise;
	}

	/**
	 * Wait until a connected server's resource catalog has been loaded.
	 * Coalesces with initial loading and notification-driven refreshes: a refresh still in flight
	 * (its `resources/list` may have landed while templates are pending) is joined. A settled
	 * catalog whose `resources/list` succeeded keeps its concrete resources when the template
	 * listing failed transiently; only the templates are listed again, never the whole catalog,
	 * and that retry is the connection's pending refresh so concurrent callers share it.
	 */
	async ensureServerResources(name: string): Promise<void> {
		const connection = this.#connections.get(name);
		if (!connection || !serverSupportsResources(connection.capabilities)) return;
		const pending = this.#pendingResourceRefresh.get(name);
		if (pending?.connection === connection) return pending.promise;
		if (connection.resources === undefined) return this.refreshServerResources(name);
		if (connection.resourceTemplates !== undefined) return;
		const promise = listResourceTemplates(connection)
			.then(
				() => undefined,
				error => {
					logger.debug("Failed to list MCP resource templates", { path: `mcp:${name}`, error });
				},
			)
			.finally(() => {
				if (this.#pendingResourceRefresh.get(name)?.promise === promise) this.#pendingResourceRefresh.delete(name);
			});
		this.#pendingResourceRefresh.set(name, { connection, promise });
		return promise;
	}

	/**
	 * Refresh prompts from a specific server.
	 */
	async refreshServerPrompts(name: string): Promise<void> {
		const connection = this.#connections.get(name);
		if (!connection || !serverSupportsPrompts(connection.capabilities)) return;

		connection.prompts = undefined;
		await listPrompts(connection);

		this.#onPromptsChanged?.(name);
		this.#emitCatalogChange({ serverName: name, kind: "prompts" });
	}

	/**
	 * Get resources and templates for a specific server.
	 */
	getServerResources(name: string): { resources: MCPResource[]; templates: MCPResourceTemplate[] } | undefined {
		const connection = this.#connections.get(name);
		if (!connection) return undefined;
		return {
			resources: connection.resources ?? [],
			templates: connection.resourceTemplates ?? [],
		};
	}

	/**
	 * Read a specific resource from a server.
	 */
	async readServerResource(
		name: string,
		uri: string,
		options?: MCPRequestOptions,
	): Promise<MCPResourceReadResult | undefined> {
		const connection = this.#connections.get(name);
		if (!connection) return undefined;
		return readResource(connection, uri, options);
	}

	/**
	 * Get prompts for a specific server.
	 */
	getServerPrompts(name: string): MCPPrompt[] | undefined {
		const connection = this.#connections.get(name);
		if (!connection) return undefined;
		return connection.prompts ?? [];
	}

	/**
	 * Get a specific prompt from a server.
	 */
	async executePrompt(
		name: string,
		promptName: string,
		args?: Record<string, string>,
		options?: MCPRequestOptions,
	): Promise<MCPGetPromptResult | undefined> {
		const connection = this.#connections.get(name);
		if (!connection) return undefined;
		return getPrompt(connection, promptName, args, options);
	}

	/**
	 * Get server instructions allowed by config (for prompt injection and rebuild signatures),
	 * keyed by server name in sorted order. `#connections` follows connection order, which
	 * shifts with late connects and reconnects; sorting keeps the rendered
	 * "## MCP Server Instructions" section byte-stable so the provider prompt cache survives.
	 */
	getServerInstructions(): Map<string, string> {
		const instructions: [string, string][] = [];
		for (const [name, connection] of this.#connections) {
			if (connection.config.instructions !== false && connection.instructions) {
				instructions.push([name, connection.instructions]);
			}
		}
		instructions.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
		return new Map(instructions);
	}

	/**
	 * Get notification state for display.
	 */
	getNotificationState(): { enabled: boolean; subscriptions: Map<string, ReadonlySet<string>> } {
		return {
			enabled: this.#notificationsEnabled,
			subscriptions: this.#subscribedResources as Map<string, ReadonlySet<string>>,
		};
	}

	/**
	 * The upstream of `name` as the host last reported it: state, pid, how many
	 * sessions share it, how it last exited. Undefined before the first attach.
	 */
	getServerRuntime(name: string): McpUpstreamStatus | undefined {
		return this.#runtimes.get(name);
	}

	/**
	 * How a link of `config`'s server recovers from an HTTP/SSE 401/403: a
	 * managed OAuth credential is force-refreshed and `!command` headers run
	 * again, and the link retries on the server those headers name. Undefined
	 * for servers with neither, which keep the plain auth error.
	 */
	#authRefreshHook(config: MCPServerConfig): (() => Promise<Record<string, string> | null>) | undefined {
		if (config.type !== "http" && config.type !== "sse") return undefined;
		if (commandValues(config).length === 0 && !lookupMcpOAuthCredential(this.#authStorage, config)) return undefined;
		return async () => {
			invalidateCommandValues(config);
			const refreshed = await this.#resolveAuthConfig(config, { forceRefresh: true });
			return refreshed.type === "http" || refreshed.type === "sse" ? (refreshed.headers ?? null) : null;
		};
	}

	/**
	 * Resolve OAuth credentials and shell commands in config.
	 * `oauth: false` skips credential injection (reauth's unauthenticated probe);
	 * `forceRefresh` bypasses the expiry buffer (401/403 auth-error hook).
	 */
	async #resolveAuthConfig(
		config: MCPServerConfig,
		opts?: { forceRefresh?: boolean; oauth?: boolean; signal?: AbortSignal },
	): Promise<MCPServerConfig> {
		const signal = opts?.signal;
		let resolved: MCPServerConfig = { ...config };

		const auth = config.auth;
		const lookup: MCPOAuthCredentialLookup | undefined =
			opts?.oauth !== false ? lookupMcpOAuthCredential(this.#authStorage, config) : undefined;
		const authStorage = this.#authStorage;
		if (lookup && authStorage) {
			const { credentialId } = lookup;
			try {
				let credential: MCPStoredOAuthCredential | undefined = lookup.credential;
				// Stop waiting on abort; a refresh already running finishes so a rotated token is stored, not lost.
				const refreshResult = await untilAborted(signal, () =>
					refreshStoredManagedMcpOAuthCredential(authStorage, credentialId, {
						serverUrl: config.type === "http" || config.type === "sse" ? config.url : undefined,
						auth,
						forceRefresh: opts?.forceRefresh,
						keepCredentialOnRefreshFailure: true,
						onRefreshFailure: refreshError => {
							logger.warn("MCP OAuth refresh failed, using existing token", {
								credentialId,
								error: refreshError,
							});
						},
					}),
				);
				if (refreshResult.removed) {
					logger.warn("MCP OAuth refresh failed definitively; cleared credential", { credentialId });
				}
				credential = refreshResult.credential;

				if (credential) {
					if (resolved.type === "http" || resolved.type === "sse") {
						// Client-generated authorization wins over any configured header
						// with the same case-insensitive name (Agent Plugins §7.2.1).
						const headers = { ...resolved.headers };
						setGeneratedHeader(headers, "Authorization", `Bearer ${credential.access}`);
						resolved = { ...resolved, headers };
					} else {
						resolved = {
							...resolved,
							env: {
								...resolved.env,
								OAUTH_ACCESS_TOKEN: credential.access,
							},
						};
					}
				}
			} catch (error) {
				if (signal?.aborted) throw error;
				logger.warn("Failed to resolve OAuth credential", { credentialId, error });
			}
		}

		if (resolved.type !== "http" && resolved.type !== "sse") {
			// Literal env values (Agent Plugins §§4.1/9.2) are opaque package data:
			// no env-name lookup, no `!command` execution, no dropping empty values.
			if (resolved.env && resolved.envPolicy !== "literal") {
				// Null prototype: a `__proto__` env key must become an own
				// property, not mutate the prototype chain.
				const nextEnv: Record<string, string> = Object.create(null);
				const literalKeys = new Set(resolved.envLiteralKeys);
				for (const [key, value] of Object.entries(resolved.env)) {
					// Provider-expanded keys are final package data: keep them
					// verbatim (including empties) so they are never reinterpreted
					// as a bare env name or !command.
					if (literalKeys.has(key)) {
						nextEnv[key] = value;
						continue;
					}
					// A `!command` keeps running (shared, capped at 10 s); only this connect stops waiting.
					const resolvedValue = await untilAborted(signal, () => resolveConfigValue(value));
					if (resolvedValue) nextEnv[key] = resolvedValue;
				}
				resolved = { ...resolved, env: nextEnv };
			}
		} else {
			// Origin-locked servers (Agent Plugins §9.2) carry literal header
			// values: no placeholder or environment-variable expansion.
			if (resolved.headers && resolved.headerPolicy !== "origin-locked") {
				const nextHeaders: Record<string, string> = {};
				for (const [key, value] of Object.entries(resolved.headers)) {
					const resolvedValue = await untilAborted(signal, () => resolveConfigValue(value));
					if (resolvedValue) nextHeaders[key] = resolvedValue;
				}
				resolved = { ...resolved, headers: nextHeaders };
			}
		}

		return resolved;
	}
}

/**
 * Create an MCP manager and discover servers.
 * Convenience function for quick setup.
 */
export async function createMCPManager(
	cwd: string,
	options?: MCPDiscoverOptions,
): Promise<{
	manager: MCPManager;
	result: MCPLoadResult;
}> {
	const manager = new MCPManager(cwd);
	const result = await manager.discoverAndConnect(options);
	return { manager, result };
}
