/**
 * MCP Server Manager.
 *
 * Discovers, connects to, and manages MCP servers.
 * Handles tool loading and lifecycle.
 */
import * as path from "node:path";
import * as url from "node:url";
import type { TSchema } from "@oh-my-pi/pi-ai";
import { logger } from "@oh-my-pi/pi-utils";
import type { EffectiveExtensionRoots, SourceMeta } from "../capability/types";
import { resolveConfigValue } from "../config/resolve-config-value";
import type { CustomTool } from "../extensibility/custom-tools/types";
import type { AuthStorage } from "../session/auth-storage";
import {
	connectToServer,
	disconnectServer,
	getPrompt,
	listPrompts,
	listResources,
	listResourceTemplates,
	listTools,
	readResource,
	serverSupportsPrompts,
	serverSupportsResources,
	subscribeToResources,
	unsubscribeFromResources,
} from "./client";
import { type LoadMCPConfigsResult, loadAllMCPConfigs, validateServerConfig } from "./config";
import {
	lookupMcpOAuthCredential,
	type MCPOAuthCredentialLookup,
	refreshStoredManagedMcpOAuthCredential,
} from "./oauth-credentials";
import type { MCPStoredOAuthCredential } from "./oauth-flow";
import type { McpConnectionStatusEvent } from "./startup-events";

export type McpCatalogChangeEvent = { serverName: string; kind: "resources" | "prompts" };

import type { MCPToolDetails } from "./tool-bridge";
import { DeferredMCPTool, MCPTool } from "./tool-bridge";
import type { MCPToolCache } from "./tool-cache";
import { setGeneratedHeader } from "./transports/header-policy";
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
	MCPTransport,
} from "./types";
import { MCPNotificationMethods } from "./types";

type ToolLoadResult = {
	connection: MCPServerConnection;
	serverTools: MCPToolDefinition[];
};

interface AuthRefreshableMCPTransport extends MCPTransport {
	onAuthError?: () => Promise<Record<string, string> | null>;
}

function isAuthRefreshableMCPTransport(transport: MCPTransport): transport is AuthRefreshableMCPTransport {
	return "onAuthError" in transport;
}
type TrackedPromise<T> = {
	promise: Promise<T>;
	status: "pending" | "fulfilled" | "rejected";
	value?: T;
	reason?: unknown;
};

const STARTUP_TIMEOUT_MS = 250;

function createMcpStartupFailure(serverName: string, error: string, source?: SourceMeta): McpConnectionStatusEvent {
	return source
		? { type: "failed", serverName, error, sourcePath: source.path }
		: { type: "failed", serverName, error };
}

/**
 * Per-server reconnect-storm circuit breaker.
 *
 * `transport.onClose` (wired in {@link MCPManager.connectServers} and
 * {@link MCPManager.#connectAndWireServer}) fires `reconnectServer` on every
 * clean process exit, so a stdio MCP server that completes the
 * `initialize` + `tools/list` handshake and then exits will pull the agent
 * into a fork loop with no rate limit. That pathology shipped in issue #1592
 * (a `php`-shebang MCP fork-bombing macOS, parented directly to the agent's
 * `bun` PID via shebang exec).
 *
 * We keep the sliding window short — older crashes age out so a single
 * transient failure stays cheap — but cap the burst tightly enough that the
 * agent never spawns more than `RECONNECT_BURST_LIMIT * #doReconnect retries`
 * (≤ 25) processes per stuck server per window. Manual `/mcp reconnect`
 * resets the window so users can recover after fixing the underlying
 * misconfiguration.
 */
const RECONNECT_BURST_WINDOW_MS = 30_000;
const RECONNECT_BURST_LIMIT = 5;

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

function delay(ms: number): Promise<void> {
	return Bun.sleep(ms);
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

/** Options for discovering and connecting to MCP servers */
export interface MCPDiscoverOptions {
	/** Whether to load project-level config (default: true) */
	enableProjectConfig?: boolean;
	/** Whether to filter out Exa MCP servers (default: true) */
	filterExa?: boolean;
	/** Whether to filter out browser MCP servers when builtin browser tool is enabled (default: false) */
	filterBrowser?: boolean;
	/** Session-local extension roots for post-startup rediscovery (explicit + mode + configured). */
	extensionRoots?: EffectiveExtensionRoots;
	/** Called when MCP server connection state changes. */
	onStatus?: (event: McpConnectionStatusEvent) => void;
}

/** Handles an MCP `WWW-Authenticate` challenge and returns refreshed config. */
export type MCPAuthHandler = (serverName: string, challenge: MCPAuthChallenge) => Promise<MCPServerConfig | undefined>;

/**
 * MCP Server Manager.
 *
 * Manages connections to MCP servers and provides tools to the agent.
 */
export class MCPManager {
	static #instance: MCPManager | undefined;

	/** Process-global instance shared by internal URL protocol handlers and tools. */
	static instance(): MCPManager | undefined {
		return MCPManager.#instance;
	}

	/** Install or clear the process-global instance. */
	static setInstance(value: MCPManager | undefined): void {
		MCPManager.#instance = value;
	}

	/** Reset the process-global instance. Test-only. */
	static resetForTests(): void {
		MCPManager.#instance = undefined;
	}

	#connections = new Map<string, MCPServerConnection>();
	#tools: CustomTool<TSchema, MCPToolDetails>[] = [];
	#pendingConnections = new Map<string, Promise<MCPServerConnection>>();
	#pendingToolLoads = new Map<string, Promise<ToolLoadResult>>();
	#sources = new Map<string, SourceMeta>();
	#authStorage: AuthStorage | null = null;
	#authHandler?: MCPAuthHandler;
	#notificationListeners = new Set<(serverName: string, method: string, params: unknown) => void>();
	#connectionStatusListeners = new Set<(event: McpConnectionStatusEvent) => void>();
	#catalogChangeListeners = new Set<(event: McpCatalogChangeEvent) => void>();
	/**
	 * Notifications received before any listener attached, to be drained on
	 * the first {@link addNotificationListener} call. Bounded by
	 * {@link NOTIFICATION_BUFFER_CAP}, drop-oldest on overflow.
	 */
	#pendingNotifications: Array<{ server: string; method: string; params: unknown }> = [];
	#onToolsChanged?: (tools: CustomTool<TSchema, MCPToolDetails>[]) => void | Promise<void>;
	#onResourcesChanged?: (serverName: string, uri: string) => void;
	#onPromptsChanged?: (serverName: string) => void;
	#notificationsEnabled = false;
	#notificationsEpoch = 0;
	#subscribedResources = new Map<string, Set<string>>();
	#pendingResourceRefresh = new Map<string, { connection: MCPServerConnection; promise: Promise<void> }>();
	#pendingReconnections = new Map<string, Promise<MCPServerConnection | null>>();
	/** Preserved configs for reconnection after connection loss. */
	#serverConfigs = new Map<string, MCPServerConfig>();
	/**
	 * Timestamps of recent reconnectServer invocations per server, used by the
	 * crash-storm circuit breaker (see {@link RECONNECT_BURST_LIMIT}).
	 */
	#reconnectHistory = new Map<string, number[]>();
	/** Monotonic epoch incremented on disconnectAll to invalidate stale reconnections. */
	#epoch = 0;

	constructor(
		private cwd: string,
		private toolCache: MCPToolCache | null = null,
	) {}

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
	 * disconnect, reconnect) invoke the handler synchronously — their downstream
	 * chains don't need to serialize on the rebind.
	 */
	setOnToolsChanged(handler: (tools: CustomTool<TSchema, MCPToolDetails>[]) => void | Promise<void>): void {
		this.#onToolsChanged = handler;
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
	async discoverAndConnect(options?: MCPDiscoverOptions): Promise<MCPLoadResult> {
		let loadedConfigs: LoadMCPConfigsResult;
		try {
			loadedConfigs = await loadAllMCPConfigs(this.cwd, {
				enableProjectConfig: options?.enableProjectConfig,
				filterExa: options?.filterExa,
				filterBrowser: options?.filterBrowser,
				extensionRoots: options?.extensionRoots,
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			options?.onStatus?.({ type: "failed", serverName: ".mcp.json", error: message });
			this.#emitConnectionStatus({ type: "failed", serverName: ".mcp.json", error: message });
			throw error;
		}
		const { configs, exaApiKeys, sources } = loadedConfigs;
		const result = await this.connectServers(configs, sources, options?.onStatus);
		result.exaApiKeys = exaApiKeys;
		return result;
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

			// Save config early so reconnection works even if the initial connect times out
			// and falls back to cached/deferred tools.
			this.#serverConfigs.set(name, config);
			const connectionEpoch = this.#epoch;

			// Resolve auth config before connecting, but do so per-server in parallel.
			const connectionPromise = (async () => {
				const resolvedConfig = await this.#resolveAuthConfig(config);
				return connectToServer(name, resolvedConfig, {
					onNotification: (method, params) => {
						this.#handleServerNotification(name, method, params);
					},
					onRequest: (method, params) => {
						return this.#handleServerRequest(method, params);
					},
				});
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

					// Wire auth refresh for HTTP-like transports so 401s trigger token refresh.
					// Gate on a resolvable managed credential, not on the auth block:
					// definition-only configs (url-keyed fallback) get Bearer injection
					// too and need the same mid-session refresh hook.
					if (
						isAuthRefreshableMCPTransport(connection.transport) &&
						lookupMcpOAuthCredential(this.#authStorage, config)
					) {
						connection.transport.onAuthError = async () => {
							const refreshed = await this.#resolveAuthConfig(config, { forceRefresh: true });
							if (refreshed.type === "http" || refreshed.type === "sse") {
								return refreshed.headers ?? null;
							}
							return null;
						};
					}

					// Re-establish connection if the transport closes (server restart,
					// network interruption).
					connection.transport.onClose = () => {
						logger.debug("MCP transport lost, triggering reconnect", { path: `mcp:${name}` });
						this.#emitConnectionStatus({ type: "connecting", serverNames: [name] });
						void this.reconnectServer(name);
					};

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
					// awaiting a slow HTTP close (session DELETE) here would keep
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
			connectionTasks.push({ name, config, tracked, toolsPromise });

			void toolsPromise
				.then(async ({ connection, serverTools }) => {
					if (this.#pendingToolLoads.get(name) !== toolsPromise) return;
					this.#pendingToolLoads.delete(name);
					const reconnect = (options?: { authChallenge?: MCPAuthChallenge }) =>
						this.reconnectServer(name, options);
					const customTools = MCPTool.fromTools(connection, serverTools, reconnect);
					this.#replaceServerTools(name, customTools);
					void this.#onToolsChanged?.(this.#tools);
					void this.toolCache?.set(name, config, serverTools);

					notify({ type: "connected", serverName: name });
					await this.#loadServerResourcesAndPrompts(name, connection);
				})
				.catch(error => {
					if (this.#pendingToolLoads.get(name) !== toolsPromise) return;
					this.#pendingToolLoads.delete(name);
					const message = error instanceof Error ? error.message : String(error);
					notify(createMcpStartupFailure(name, message, sources[name]));
					if (!allowBackgroundLogging || reportedErrors.has(name)) return;
					logger.error("MCP tool load failed", { path: `mcp:${name}`, error: message });
				});
		}

		// Notify about servers we're connecting to, including configs that fail fast.
		if (statusServerNames.length > 0) {
			notify({ type: "connecting", serverNames: statusServerNames });
			for (const { name, message } of validationFailures) {
				notify(createMcpStartupFailure(name, message, sources[name]));
			}
		}

		if (connectionTasks.length > 0) {
			await Promise.race([
				Promise.allSettled(connectionTasks.map(task => task.tracked.promise)),
				delay(STARTUP_TIMEOUT_MS),
			]);

			const cachedTools = new Map<string, MCPToolDefinition[]>();
			const pendingTasks = connectionTasks.filter(task => task.tracked.status === "pending");

			if (pendingTasks.length > 0 && this.toolCache) {
				await Promise.all(
					pendingTasks.map(async task => {
						const cached = await this.toolCache?.get(task.name, task.config);
						if (cached) {
							cachedTools.set(task.name, cached);
						}
					}),
				);
			}

			// Pending tasks without cached tools used to be awaited synchronously here,
			// which gated the entire UI on the slowest server's per-request timeout
			// (issue #2100: a single unresponsive MCP server blocked startup for the
			// full 30 s `OMP_MCP_TIMEOUT_MS`). Leave them in flight — the background
			// `void toolsPromise.then(...)` chain above registers their tools and
			// fires `#onToolsChanged` once the connect finishes, or logs the failure
			// after `allowBackgroundLogging` flips below.

			for (const task of connectionTasks) {
				const { name } = task;
				if (task.tracked.status === "fulfilled") {
					const value = task.tracked.value;
					if (!value) continue;
					const { connection, serverTools } = value;
					connectedServers.add(name);
					const reconnect = () => this.reconnectServer(name);
					this.#replaceServerTools(name, MCPTool.fromTools(connection, serverTools, reconnect));
				} else if (task.tracked.status === "rejected") {
					const message =
						task.tracked.reason instanceof Error ? task.tracked.reason.message : String(task.tracked.reason);
					errors.set(name, message);
					reportedErrors.add(name);
				} else {
					const cached = cachedTools.get(name);
					if (cached) {
						const source = this.#sources.get(name);
						const reconnect = () => this.reconnectServer(name);
						this.#replaceServerTools(
							name,
							DeferredMCPTool.fromTools(name, cached, () => this.waitForConnection(name), source, reconnect),
						);
					}
				}
			}
		}

		allowBackgroundLogging = true;

		return {
			tools: this.#tools,
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
				if (connectionKnown) refreshPromise = this.#triggerNotificationRefresh(serverName, "tools");
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

	/** Handle server-to-client JSON-RPC requests (e.g. ping, roots/list). */
	async #handleServerRequest(method: string, _params: unknown): Promise<unknown> {
		switch (method) {
			case "ping":
				return {};
			case "roots/list":
				return this.#getRoots();
			default:
				throw Object.assign(new Error(`Unsupported server request: ${method}`), { code: -32601 });
		}
	}

	#getRoots(): { roots: Array<{ uri: string; name: string }> } {
		return {
			roots: [
				{
					uri: url.pathToFileURL(this.cwd).href,
					name: path.basename(this.cwd),
				},
			],
		};
	}

	/**
	 * Get all loaded tools.
	 */
	getTools(): CustomTool<TSchema, MCPToolDetails>[] {
		return this.#tools;
	}

	/**
	 * Get a specific connection.
	 */
	getConnection(name: string): MCPServerConnection | undefined {
		return this.#connections.get(name);
	}

	/**
	 * Get current connection status for a server.
	 */
	getConnectionStatus(name: string): "connected" | "connecting" | "disconnected" {
		if (this.#connections.has(name)) return "connected";
		if (
			this.#pendingConnections.has(name) ||
			this.#pendingToolLoads.has(name) ||
			this.#pendingReconnections.has(name)
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
		throw new Error(`MCP server not connected: ${name}`);
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
		}
	}

	/**
	 * Detach a connection and await its transport close.
	 *
	 * Use only where blocking on the close is acceptable (owned disconnects,
	 * dispose). On reject-fast paths detach synchronously and close in the
	 * background so a slow `close()` (HTTP session DELETE) cannot delay the
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
		this.#pendingConnections.delete(name);
		this.#pendingToolLoads.delete(name);
		this.#pendingReconnections.delete(name);
		this.#sources.delete(name);
		this.#serverConfigs.delete(name);
		this.#pendingResourceRefresh.delete(name);
		this.#reconnectHistory.delete(name);

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
		if (hadTools) void this.#onToolsChanged?.(this.#tools);

		// Notify prompt consumers so stale commands are cleared
		if (connection?.prompts?.length) this.#onPromptsChanged?.(name);
	}

	/**
	 * Disconnect from all servers.
	 */
	async disconnectAll(): Promise<void> {
		// Invalidate any in-flight reconnection attempts that outlive this call.
		// They captured the old epoch; after increment they'll detect staleness.
		this.#epoch++;
		const promises = Array.from(this.#connections, ([name, connection]) => this.#discardConnection(name, connection));
		await Promise.allSettled(promises);

		this.#pendingConnections.clear();
		this.#pendingToolLoads.clear();
		this.#pendingReconnections.clear();
		this.#pendingResourceRefresh.clear();
		this.#sources.clear();
		this.#serverConfigs.clear();
		this.#tools = [];
		this.#subscribedResources.clear();
		this.#reconnectHistory.clear();
	}

	/**
	 * Reconnect to a server after a connection failure.
	 *
	 * Tears down the stale connection, re-resolves auth, establishes a new
	 * connection, reloads tools, and notifies consumers. Concurrent calls for
	 * the same server share one reconnection attempt. Returns the new
	 * connection, or `null` if reconnection failed or the per-server crash
	 * burst limit (see {@link RECONNECT_BURST_LIMIT}) is exceeded.
	 * @param options.manual - When `true`, resets the crash-burst window so a
	 *   user-driven retry (e.g. `/mcp reconnect`) is never blocked by an
	 *   earlier storm. Defaults to `false`; the transport `onClose` callback
	 *   and the per-tool-call retry path in `tool-bridge` MUST NOT set it.
	 */
	async reconnectServer(
		name: string,
		options?: { manual?: boolean; authChallenge?: MCPAuthChallenge },
	): Promise<MCPServerConnection | null> {
		if (options?.manual) {
			this.#reconnectHistory.delete(name);
		}

		const pending = this.#pendingReconnections.get(name);
		if (pending) return pending;

		if (this.#tripReconnectBreaker(name)) {
			return null;
		}

		const attempt = this.#doReconnect(name, options?.authChallenge);
		this.#pendingReconnections.set(name, attempt);
		return attempt.finally(() => this.#pendingReconnections.delete(name));
	}

	/**
	 * Record a reconnect attempt against the per-server crash window and report
	 * whether the circuit breaker is now open. Sliding window: entries older
	 * than {@link RECONNECT_BURST_WINDOW_MS} are pruned before the new
	 * timestamp is appended, so a single transient failure ages out cheaply
	 * but repeated rapid crashes accumulate until the limit is hit.
	 */
	#tripReconnectBreaker(name: string): boolean {
		const now = Date.now();
		const previous = this.#reconnectHistory.get(name) ?? [];
		const recent = previous.filter(ts => now - ts < RECONNECT_BURST_WINDOW_MS);
		recent.push(now);
		this.#reconnectHistory.set(name, recent);

		if (recent.length > RECONNECT_BURST_LIMIT) {
			logger.error("MCP server crashed too many times; suspending automatic reconnects", {
				path: `mcp:${name}`,
				crashes: recent.length,
				windowMs: RECONNECT_BURST_WINDOW_MS,
			});
			// Tear down the stale connection so `getConnectionStatus()` no
			// longer reports it as "connected" and `waitForConnection()` does
			// not hand a closed transport to callers. Tools stay registered
			// in `#tools` — the user can recover with `/mcp reconnect <name>`
			// once they've fixed the underlying misconfiguration. Mirrors the
			// teardown in `#doReconnect`: detach `onClose` first so the
			// transport's own `close()` cannot re-arm this path.
			const stale = this.#connections.get(name);
			if (stale) {
				void this.#discardConnection(name, stale).catch(() => {});
			}
			this.#pendingConnections.delete(name);
			this.#pendingToolLoads.delete(name);
			this.#emitConnectionStatus({
				type: "failed",
				serverName: name,
				error: "MCP server crashed too many times; automatic reconnects suspended",
			});
			return true;
		}
		return false;
	}

	async #doReconnect(name: string, authChallenge?: MCPAuthChallenge): Promise<MCPServerConnection | null> {
		const oldConnection = this.#connections.get(name);
		let config = oldConnection?.config ?? this.#serverConfigs.get(name);
		const source = this.#sources.get(name) ?? oldConnection?._source;
		if (!config) return null;

		if (authChallenge) {
			if (!this.#authHandler) {
				logger.error("MCP auth challenge cannot be handled; no auth handler is configured", {
					path: `mcp:${name}`,
				});
				return null;
			}
			try {
				const refreshedConfig = await this.#authHandler(name, authChallenge);
				if (!refreshedConfig) return null;
				config = refreshedConfig;
				this.#serverConfigs.set(name, config);
			} catch (error) {
				logger.error("MCP auth challenge handling failed", { path: `mcp:${name}`, error });
				return null;
			}
		}

		logger.debug("MCP reconnecting", { path: `mcp:${name}` });

		// Close the old transport without removing tools or notifying consumers.
		// Tools stay available (stale) while we establish the new connection.
		// Fire-and-forget: don't await the close — HttpTransport.close() sends a
		// DELETE with config.timeout (30s default), and blocking here delays the
		// reconnect loop by that amount on every server restart.
		const reconnectEpoch = this.#epoch;
		if (oldConnection) {
			void this.#discardConnection(name, oldConnection).catch(() => {});
		}
		this.#pendingConnections.delete(name);
		this.#pendingToolLoads.delete(name);

		// Retry with backoff — the server may still be starting up.
		const delays = [500, 1000, 2000, 4000];
		for (let attempt = 0; attempt <= delays.length; attempt++) {
			if (this.#epoch !== reconnectEpoch) {
				logger.debug("MCP reconnect aborted before attempt after configuration changed", {
					path: `mcp:${name}`,
					storedEpoch: reconnectEpoch,
					currentEpoch: this.#epoch,
				});
				return null;
			}
			try {
				const connection = await this.#connectAndWireServer(name, config, source, reconnectEpoch);
				logger.debug("MCP reconnected", { path: `mcp:${name}`, tools: connection.tools?.length ?? 0 });
				this.#emitConnectionStatus({ type: "connected", serverName: name });
				return connection;
			} catch (error) {
				if (this.#epoch !== reconnectEpoch) {
					logger.debug("MCP reconnect aborted after configuration changed", {
						path: `mcp:${name}`,
						storedEpoch: reconnectEpoch,
						currentEpoch: this.#epoch,
					});
					return null;
				}

				const msg = error instanceof Error ? error.message : String(error);
				if (attempt < delays.length) {
					logger.debug("MCP reconnect attempt failed, retrying", {
						path: `mcp:${name}`,
						attempt: attempt + 1,
						error: msg,
					});
					await Bun.sleep(delays[attempt]);
				} else {
					logger.error("MCP reconnect failed after retries", { path: `mcp:${name}`, error: msg });
					this.#emitConnectionStatus({ type: "failed", serverName: name, error: msg });
					// Don't remove stale tools — keep them in the registry so they
					// remain selected. Calls will fail with MCP errors, which
					// triggers the tool-level reconnect, or the user can run
					// /mcp reconnect <name> manually.
				}
			}
		}
		return null;
	}

	/** Establish a new connection to a server, wire handlers, load tools. */
	async #connectAndWireServer(
		name: string,
		config: MCPServerConfig,
		source: SourceMeta | undefined,
		reconnectEpoch: number,
	): Promise<MCPServerConnection> {
		const resolvedConfig = await this.#resolveAuthConfig(config);
		const connection = await connectToServer(name, resolvedConfig, {
			onNotification: (method, params) => {
				this.#handleServerNotification(name, method, params);
			},
			onRequest: (method, params) => {
				return this.#handleServerRequest(method, params);
			},
		});

		connection.config = config;
		if (source) connection._source = source;

		// Bail out if the server was disconnected or the manager was reset
		// while we were connecting (e.g. /mcp reload called disconnectAll).
		if (!this.#serverConfigs.has(name) || this.#epoch !== reconnectEpoch) {
			this.#detachConnection(name, connection);
			void disconnectServer(connection).catch(() => {});
			throw new Error(`Server "${name}" was disconnected during reconnection`);
		}

		this.#connections.set(name, connection);

		// Wire auth refresh for HTTP-like transports, and reconnect for any transport.
		// Same gate as connectServers: any resolvable managed credential.
		if (isAuthRefreshableMCPTransport(connection.transport) && lookupMcpOAuthCredential(this.#authStorage, config)) {
			connection.transport.onAuthError = async () => {
				const refreshed = await this.#resolveAuthConfig(config, { forceRefresh: true });
				if (refreshed.type === "http" || refreshed.type === "sse") {
					return refreshed.headers ?? null;
				}
				return null;
			};
		}
		connection.transport.onClose = () => {
			logger.debug("MCP transport lost, triggering reconnect", { path: `mcp:${name}` });
			this.#emitConnectionStatus({ type: "connecting", serverNames: [name] });
			void this.reconnectServer(name);
		};
		try {
			const serverTools = await listTools(connection);
			const reconnect = (options?: { authChallenge?: MCPAuthChallenge }) => this.reconnectServer(name, options);
			const customTools = MCPTool.fromTools(connection, serverTools, reconnect);
			void this.toolCache?.set(name, config, serverTools);
			this.#replaceServerTools(name, customTools);
			void this.#onToolsChanged?.(this.#tools);
			void this.#loadServerResourcesAndPrompts(name, connection);
			return connection;
		} catch (error) {
			// Detach synchronously and close in the background so a slow close
			// cannot delay the rejection (and the retry backoff that follows).
			this.#detachConnection(name, connection);
			void disconnectServer(connection).catch(() => {});
			throw error;
		}
	}

	/**
	 * Best-effort loading of resources, resource subscriptions, and prompts.
	 * Shared between initial connection and reconnection.
	 */
	async #loadServerResourcesAndPrompts(name: string, connection: MCPServerConnection): Promise<void> {
		if (serverSupportsResources(connection.capabilities)) {
			try {
				await this.refreshServerResources(name);
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
	 */
	async refreshServerTools(name: string): Promise<void> {
		const connection = this.#connections.get(name);
		if (!connection) return;

		// Clear cached tools
		connection.tools = undefined;

		// Reload tools
		const serverTools = await listTools(connection);
		const reconnect = () => this.reconnectServer(name);
		const customTools = MCPTool.fromTools(connection, serverTools, reconnect);
		void this.toolCache?.set(name, connection.config, serverTools);

		// Replace tools from this server
		this.#replaceServerTools(name, customTools);
		await this.#onToolsChanged?.(this.#tools);
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
	 * Coalesces with initial loading and notification-driven refreshes.
	 */
	async ensureServerResources(name: string): Promise<void> {
		const connection = this.#connections.get(name);
		if (!connection || !serverSupportsResources(connection.capabilities)) return;
		if (connection.resources !== undefined && connection.resourceTemplates !== undefined) return;
		await this.refreshServerResources(name);
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
	 * Get all server instructions (for system prompt injection).
	 */
	getServerInstructions(): Map<string, string> {
		const instructions = new Map<string, string>();
		for (const [name, connection] of this.#connections) {
			if (connection.instructions) {
				instructions.set(name, connection.instructions);
			}
		}
		return instructions;
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
	 * Resolve OAuth credentials and shell commands in config.
	 * `oauth: false` skips credential injection (reauth's unauthenticated probe);
	 * `forceRefresh` bypasses the expiry buffer (401/403 auth-error hook).
	 */
	async #resolveAuthConfig(
		config: MCPServerConfig,
		opts?: { forceRefresh?: boolean; oauth?: boolean },
	): Promise<MCPServerConfig> {
		let resolved: MCPServerConfig = { ...config };

		const auth = config.auth;
		const lookup: MCPOAuthCredentialLookup | undefined =
			opts?.oauth !== false ? lookupMcpOAuthCredential(this.#authStorage, config) : undefined;
		if (lookup && this.#authStorage) {
			const { credentialId } = lookup;
			try {
				let credential: MCPStoredOAuthCredential | undefined = lookup.credential;
				const refreshResult = await refreshStoredManagedMcpOAuthCredential(this.#authStorage, credentialId, {
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
				});
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
				logger.warn("Failed to resolve OAuth credential", { credentialId, error });
			}
		}

		if (resolved.type !== "http" && resolved.type !== "sse") {
			// Literal env values (Agent Plugins §§4.1/9.2) are opaque package data:
			// no env-name lookup, no `!command` execution, no dropping empty values.
			if (resolved.env && resolved.envPolicy !== "literal") {
				const nextEnv: Record<string, string> = {};
				for (const [key, value] of Object.entries(resolved.env)) {
					const resolvedValue = await resolveConfigValue(value);
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
					const resolvedValue = await resolveConfigValue(value);
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
