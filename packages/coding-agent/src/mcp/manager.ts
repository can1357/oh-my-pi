/**
 * MCP Server Manager.
 *
 * Discovers, connects to, and manages MCP servers.
 * Handles tool loading and lifecycle.
 */
import * as path from "node:path";
import * as url from "node:url";
import { isDefinitiveOAuthFailure, type TSchema } from "@pk-nerdsaver-ai/pi-ai";
import { logger } from "@pk-nerdsaver-ai/pi-utils";
import type { SourceMeta } from "../capability/types";
import { resolveConfigValue } from "../config/resolve-config-value";
import type { CustomTool } from "../extensibility/custom-tools/types";
import type { AuthStorage } from "../session/auth-storage";
import {
	complete,
	completeWithProgress,
	connectToServer,
	disconnectServer,
	getPromptWithMRTR,
	invalidateMCPConnectionListCache,
	invalidateMCPConnectionResourceReadCache,
	listenToNotifications,
	listPrompts,
	listResources,
	listResourceTemplates,
	listTools,
	MCPProgressRegistry,
	readResourceWithMRTR,
	serverSupportsCompletions,
	serverSupportsPrompts,
	serverSupportsResources,
	subscribeToResources,
	unsubscribeFromResources,
} from "./client";
import { type LoadMCPConfigsResult, loadAllMCPConfigs, validateServerConfig } from "./config";
import {
	createMCPExtensionRuntime,
	EMPTY_MCP_EXTENSION_REGISTRY,
	type MCPExtensionRegistry,
	type MCPExtensionRuntime,
	validateMCPExtensionConfig,
} from "./extensions";
import {
	lookupMcpOAuthCredential,
	type MCPOAuthCredentialLookup,
	selectMcpOAuthRefreshMaterial,
} from "./oauth-credentials";
import { type MCPStoredOAuthCredential, refreshMCPOAuthToken } from "./oauth-flow";
import type { McpConnectionStatusEvent } from "./startup-events";
import type { MCPToolDetails } from "./tool-bridge";
import { DeferredMCPTool, MCPTool } from "./tool-bridge";
import type { MCPToolCache } from "./tool-cache";
import { HttpTransport } from "./transports/http";
import type {
	MCPCompletionArgument,
	MCPCompletionContext,
	MCPCompletionReference,
	MCPCompletionResult,
	MCPGetPromptResult,
	MCPHostInteraction,
	MCPListenHandle,
	MCPProgressHandler,
	MCPPrompt,
	MCPRequestOptions,
	MCPResource,
	MCPResourceReadResult,
	MCPResourceTemplate,
	MCPServerConfig,
	MCPServerConnection,
	MCPSubscriptionNotificationFilter,
	MCPToolDefinition,
} from "./types";
import {
	areMCPSubscriptionFiltersEqual,
	isMCPResourceUriOrSubresource,
	isMCPResultCacheFresh,
	isMCPSubscriptionNotificationAcknowledged,
	MCPNotificationMethods,
} from "./types";

type ToolLoadResult = {
	connection: MCPServerConnection;
	serverTools: MCPToolDefinition[];
};

type TrackedPromise<T> = {
	promise: Promise<T>;
	status: "pending" | "fulfilled" | "rejected";
	value?: T;
	reason?: unknown;
};

type ModernSubscriptionState = {
	connection: MCPServerConnection;
	handle: MCPListenHandle;
	epoch: number;
	revision: number;
};

const STARTUP_TIMEOUT_MS = 250;

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

const HTTP_SUBSCRIPTION_RECOVERY_BASE_DELAY_MS = 100;
const HTTP_SUBSCRIPTION_RECOVERY_MAX_ATTEMPTS = 5;

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
	/** Called when MCP server connection state changes. */
	onStatus?: (event: McpConnectionStatusEvent) => void;
}

/** Optional host-owned MRTR interaction policy and trusted extension registry. */
export interface MCPManagerOptions {
	hostInteraction?: MCPHostInteraction;
	/** Compiled-in trusted extension definitions. No registry means an empty allowlist. */
	extensionRegistry?: MCPExtensionRegistry;
}

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
	#onNotification?: (serverName: string, method: string, params: unknown) => void;
	#progressRegistry = new MCPProgressRegistry();
	#onToolsChanged?: (tools: CustomTool<TSchema, MCPToolDetails>[]) => void;
	#onResourcesChanged?: (serverName: string, uri: string) => void;
	#onPromptsChanged?: (serverName: string) => void;
	#notificationsEnabled = false;
	#notificationsEpoch = 0;
	#subscribedResources = new Map<string, Set<string>>();
	#knownResourceUris = new Map<string, Set<string>>();
	#pendingResourceRefresh = new Map<string, { connection: MCPServerConnection; promise: Promise<void> }>();
	#modernSubscriptions = new Map<string, ModernSubscriptionState>();
	#modernSubscriptionRevisions = new Map<string, number>();
	#modernSubscriptionRecoveryTimers = new Map<string, ReturnType<typeof setTimeout>>();
	#modernSubscriptionRecoveryAttempts = new Map<string, number>();
	#pendingReconnections = new Map<string, Promise<MCPServerConnection | null>>();
	/** Preserved configs for reconnection after connection loss. */
	#serverConfigs = new Map<string, MCPServerConfig>();
	/** Per-connection extension runtimes; never populated from server advertisements. */
	#extensionRuntimes = new Map<string, { connection: MCPServerConnection; runtime: MCPExtensionRuntime }>();
	/**
	 * Timestamps of recent `reconnectServer` invocations per server, used by the
	 * crash-storm circuit breaker (see {@link RECONNECT_BURST_LIMIT}).
	 */
	#reconnectHistory = new Map<string, number[]>();
	/** Monotonic epoch incremented on disconnectAll to invalidate stale reconnections. */
	#epoch = 0;

	constructor(
		private cwd: string,
		private toolCache: MCPToolCache | null = null,
		private readonly options: MCPManagerOptions = {},
	) {}

	/** Cache persistence is an optimization and must never fail a live MCP connection. */
	async #persistToolCache(
		name: string,
		config: MCPServerConfig,
		tools: MCPToolDefinition[],
		connection: MCPServerConnection,
	): Promise<void> {
		try {
			await this.toolCache?.set(name, config, tools, connection.resultHints?.tools);
		} catch (error) {
			logger.warn("MCP tool cache persistence failed", { path: `mcp:${name}`, error: String(error) });
		}
	}

	/**
	 * Set a callback to receive all server notifications.
	 */
	setOnNotification(handler: (serverName: string, method: string, params: unknown) => void): void {
		this.#onNotification = handler;
	}

	/**
	 * Set a callback to fire when any server's tools change.
	 */
	setOnToolsChanged(handler: (tools: CustomTool<TSchema, MCPToolDetails>[]) => void): void {
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

	#nextModernSubscriptionRevision(name: string): number {
		const revision = (this.#modernSubscriptionRevisions.get(name) ?? 0) + 1;
		this.#modernSubscriptionRevisions.set(name, revision);
		return revision;
	}

	#clearModernSubscriptionRecovery(name: string): void {
		const timer = this.#modernSubscriptionRecoveryTimers.get(name);
		if (timer) clearTimeout(timer);
		this.#modernSubscriptionRecoveryTimers.delete(name);
		this.#modernSubscriptionRecoveryAttempts.delete(name);
	}

	#scheduleModernHttpSubscriptionRecovery(name: string, state: ModernSubscriptionState): void {
		if (state.connection.config.type !== "http") return;
		if (
			!this.#notificationsEnabled ||
			this.#notificationsEpoch !== state.epoch ||
			this.#modernSubscriptionRevisions.get(name) !== state.revision ||
			this.#connections.get(name) !== state.connection ||
			this.#modernSubscriptionRecoveryTimers.has(name)
		) {
			return;
		}
		const attempt = (this.#modernSubscriptionRecoveryAttempts.get(name) ?? 0) + 1;
		if (attempt > HTTP_SUBSCRIPTION_RECOVERY_MAX_ATTEMPTS) {
			logger.debug("Modern HTTP MCP subscription recovery limit reached", { path: `mcp:${name}` });
			return;
		}
		this.#modernSubscriptionRecoveryAttempts.set(name, attempt);
		const delay = HTTP_SUBSCRIPTION_RECOVERY_BASE_DELAY_MS * 2 ** (attempt - 1);
		const timer = setTimeout(() => {
			this.#modernSubscriptionRecoveryTimers.delete(name);
			if (
				!this.#notificationsEnabled ||
				this.#notificationsEpoch !== state.epoch ||
				this.#modernSubscriptionRevisions.get(name) !== state.revision ||
				this.#connections.get(name) !== state.connection ||
				this.#modernSubscriptions.has(name)
			) {
				return;
			}
			void this.#reconcileModernSubscription(name, state.connection).catch(error => {
				logger.debug("Failed to recover modern HTTP MCP subscription", { path: `mcp:${name}`, error });
			});
		}, delay);
		timer.unref?.();
		this.#modernSubscriptionRecoveryTimers.set(name, timer);
	}

	#desiredModernSubscriptionFilter(connection: MCPServerConnection): MCPSubscriptionNotificationFilter {
		const capabilities = connection.protocol?.era === "modern" ? connection.protocol.capabilities : {};
		const resourceSubscriptions =
			capabilities.resources?.subscribe === true
				? [...(this.#knownResourceUris.get(connection.name) ?? [])].sort()
				: [];
		return {
			...(capabilities.tools?.listChanged === true ? { toolsListChanged: true } : {}),
			...(capabilities.prompts?.listChanged === true ? { promptsListChanged: true } : {}),
			...(capabilities.resources?.listChanged === true ? { resourcesListChanged: true } : {}),
			...(resourceSubscriptions.length > 0 ? { resourceSubscriptions } : {}),
		};
	}

	#cancelModernSubscription(name: string): void {
		this.#clearModernSubscriptionRecovery(name);
		this.#nextModernSubscriptionRevision(name);
		const active = this.#modernSubscriptions.get(name);
		this.#modernSubscriptions.delete(name);
		this.#subscribedResources.delete(name);
		if (active) {
			void active.handle.cancel().catch(error => {
				logger.debug("Failed to cancel modern MCP subscription", { path: `mcp:${name}`, error });
			});
		}
	}

	#isCurrentModernSubscription(name: string, state: ModernSubscriptionState): boolean {
		return (
			this.#notificationsEnabled &&
			this.#notificationsEpoch === state.epoch &&
			this.#modernSubscriptionRevisions.get(name) === state.revision &&
			this.#connections.get(name) === state.connection &&
			this.#modernSubscriptions.get(name)?.handle === state.handle
		);
	}

	#handleModernSubscriptionNotification(
		name: string,
		state: ModernSubscriptionState,
		method: string,
		params: unknown,
	): void {
		if (!this.#isCurrentModernSubscription(name, state)) return;
		const acknowledged = state.handle.acknowledgedNotifications;
		if (!acknowledged || !isMCPSubscriptionNotificationAcknowledged(acknowledged, method, params)) return;
		const capabilities = state.connection.protocol?.era === "modern" ? state.connection.protocol.capabilities : {};

		switch (method) {
			case MCPNotificationMethods.TOOLS_LIST_CHANGED:
				if (capabilities.tools?.listChanged !== true || acknowledged.toolsListChanged !== true) return;
				this.#triggerNotificationRefresh(name, "tools");
				break;
			case MCPNotificationMethods.RESOURCES_LIST_CHANGED:
				if (capabilities.resources?.listChanged !== true || acknowledged.resourcesListChanged !== true) return;
				this.#triggerNotificationRefresh(name, "resources");
				break;
			case MCPNotificationMethods.PROMPTS_LIST_CHANGED:
				if (capabilities.prompts?.listChanged !== true || acknowledged.promptsListChanged !== true) return;
				this.#triggerNotificationRefresh(name, "prompts");
				break;
			case MCPNotificationMethods.RESOURCES_UPDATED: {
				if (capabilities.resources?.subscribe !== true) return;
				const uri =
					typeof params === "object" && params !== null && !Array.isArray(params)
						? (params as Record<string, unknown>).uri
						: undefined;
				if (
					typeof uri !== "string" ||
					acknowledged.resourceSubscriptions?.some(acknowledgedUri =>
						isMCPResourceUriOrSubresource(acknowledgedUri, uri),
					) !== true
				)
					return;
				invalidateMCPConnectionResourceReadCache(state.connection, uri);
				this.#onResourcesChanged?.(name, uri);
				break;
			}
			default:
				return;
		}
		this.#onNotification?.(name, method, params);
	}

	async #reconcileModernSubscription(name: string, connection: MCPServerConnection): Promise<void> {
		if (connection.protocol?.era !== "modern") return;
		const epoch = this.#notificationsEpoch;
		if (!this.#notificationsEnabled || this.#connections.get(name) !== connection) return;

		const desired = this.#desiredModernSubscriptionFilter(connection);
		const existing = this.#modernSubscriptions.get(name);
		if (
			existing &&
			this.#isCurrentModernSubscription(name, existing) &&
			areMCPSubscriptionFiltersEqual(existing.handle.requestedNotifications, desired)
		) {
			return;
		}
		if (
			!this.#notificationsEnabled ||
			this.#notificationsEpoch !== epoch ||
			this.#connections.get(name) !== connection
		)
			return;

		const revision = this.#nextModernSubscriptionRevision(name);
		if (existing) {
			this.#modernSubscriptions.delete(name);
			this.#subscribedResources.delete(name);
			void existing.handle.cancel().catch(() => {});
		}
		let state: ModernSubscriptionState | undefined;
		const handle = await listenToNotifications(connection, desired, {
			onNotification: (method, params) => {
				if (state) this.#handleModernSubscriptionNotification(name, state, method, params);
			},
		});
		if (!handle) return;
		state = { connection, handle, epoch, revision };
		if (
			!this.#notificationsEnabled ||
			this.#notificationsEpoch !== epoch ||
			this.#modernSubscriptionRevisions.get(name) !== revision ||
			this.#connections.get(name) !== connection
		) {
			await handle.cancel().catch(() => {});
			return;
		}
		this.#modernSubscriptions.set(name, state);
		void handle.completion.then(
			() => {
				if (!this.#isCurrentModernSubscription(name, state)) return;
				this.#modernSubscriptions.delete(name);
				this.#subscribedResources.delete(name);
			},
			error => {
				if (!this.#isCurrentModernSubscription(name, state)) return;
				logger.debug("Modern MCP subscription ended unexpectedly", { path: `mcp:${name}`, error });
				this.#modernSubscriptions.delete(name);
				this.#subscribedResources.delete(name);
				this.#scheduleModernHttpSubscriptionRecovery(name, state);
			},
		);

		try {
			const acknowledged = await handle.acknowledged;
			if (!this.#isCurrentModernSubscription(name, state)) {
				await handle.cancel().catch(() => {});
				return;
			}
			this.#clearModernSubscriptionRecovery(name);
			this.#subscribedResources.set(name, new Set(acknowledged.resourceSubscriptions ?? []));
		} catch (error) {
			if (this.#isCurrentModernSubscription(name, state)) {
				logger.debug("Failed to establish modern MCP subscription", { path: `mcp:${name}`, error });
				this.#modernSubscriptions.delete(name);
				this.#subscribedResources.delete(name);
				this.#scheduleModernHttpSubscriptionRecovery(name, state);
			}
		}
	}

	#subscribeAndTrack(name: string, connection: MCPServerConnection, uris: string[], notificationEpoch: number): void {
		if (connection.protocol?.era !== "legacy") return;
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
				if (action === "ignore" || this.#connections.get(name) !== connection) {
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
			for (const [name, connection] of this.#connections) {
				if (connection.protocol?.era === "modern") {
					void this.#reconcileModernSubscription(name, connection).catch(error => {
						logger.debug("Failed to reconcile modern MCP subscription", { path: `mcp:${name}`, error });
					});
				} else if (
					connection.protocol?.era === "legacy" &&
					connection.capabilities.resources?.subscribe &&
					connection.resources
				) {
					const uris = connection.resources.map(resource => resource.uri);
					this.#subscribeAndTrack(name, connection, uris, notificationEpoch);
				}
			}
			return;
		}

		for (const name of new Set([
			...this.#modernSubscriptionRecoveryTimers.keys(),
			...this.#modernSubscriptionRecoveryAttempts.keys(),
		])) {
			this.#clearModernSubscriptionRecovery(name);
		}
		for (const name of [...this.#modernSubscriptions.keys()]) {
			this.#cancelModernSubscription(name);
		}
		for (const [name, connection] of this.#connections) {
			if (connection.protocol?.era !== "legacy") continue;
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
			});
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			options?.onStatus?.({ type: "failed", serverName: ".mcp.json", error: message });
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
	 */
	async connectServers(
		configs: Record<string, MCPServerConfig>,
		sources: Record<string, SourceMeta>,
		onStatus?: (event: McpConnectionStatusEvent) => void,
	): Promise<MCPLoadResult> {
		type ConnectionTask = {
			name: string;
			config: MCPServerConfig;
			tracked: TrackedPromise<ToolLoadResult>;
			toolsPromise: Promise<ToolLoadResult>;
		};

		const errors = new Map<string, string>();
		const connectedServers = new Set<string>();
		const allTools: CustomTool<TSchema, MCPToolDetails>[] = [];
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

			// Validate transport and trusted-extension configuration before starting any connection.
			const validationErrors = [
				...validateServerConfig(name, config),
				...validateMCPExtensionConfig(
					this.options.extensionRegistry ?? EMPTY_MCP_EXTENSION_REGISTRY,
					name,
					config.extensions,
				),
			];
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
			const extensionRuntime = createMCPExtensionRuntime(
				this.options.extensionRegistry ?? EMPTY_MCP_EXTENSION_REGISTRY,
				config.extensions,
			);

			// Resolve auth config before connecting, but do so per-server in parallel.
			const connectionPromise = (async () => {
				const resolvedConfig = await this.#resolveAuthConfig(config);
				let notificationConnection: MCPServerConnection | undefined;
				const connection = await connectToServer(name, resolvedConfig, {
					onNotification: (method, params) => {
						this.#handleServerNotification(name, method, params, notificationConnection);
					},
					onRequest: (method, params) => {
						return this.#handleServerRequest(method, params);
					},
					modernClientCapabilities: this.options.hostInteraction?.clientCapabilities,
					extensionRuntime,
				});
				notificationConnection = connection;
				return connection;
			})().then(
				connection => {
					// Store original config (without resolved tokens) to keep
					// cache keys stable and avoid leaking rotating credentials.
					connection.config = config;
					this.#serverConfigs.set(name, config);
					if (sources[name]) {
						connection._source = sources[name];
					}
					if (this.#pendingConnections.get(name) === connectionPromise) {
						this.#pendingConnections.delete(name);
						this.#connections.set(name, connection);
						this.#extensionRuntimes.set(name, { connection, runtime: extensionRuntime });
					}

					// Wire auth refresh for HTTP transports so 401s trigger token refresh.
					// Gate on a resolvable managed credential, not on the auth block:
					// definition-only configs (url-keyed fallback) get Bearer injection
					// too and need the same mid-session refresh hook.
					if (
						connection.transport instanceof HttpTransport &&
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
						if (this.#connections.get(name) !== connection) return;
						this.#cancelModernSubscription(name);
						logger.debug("MCP transport lost, triggering reconnect", { path: `mcp:${name}` });
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
				const serverTools = await listTools(connection);
				return { connection, serverTools };
			});
			this.#pendingToolLoads.set(name, toolsPromise);

			const tracked = trackPromise(toolsPromise);
			connectionTasks.push({ name, config, tracked, toolsPromise });

			void toolsPromise
				.then(async ({ connection, serverTools }) => {
					if (this.#pendingToolLoads.get(name) !== toolsPromise) return;
					this.#pendingToolLoads.delete(name);
					const reconnect = () => this.reconnectServer(name);
					const customTools = MCPTool.fromTools(connection, serverTools, reconnect, this.options.hostInteraction);
					this.#replaceServerTools(name, customTools);
					this.#onToolsChanged?.(this.#tools);
					await this.#persistToolCache(name, config, serverTools, connection);

					onStatus?.({ type: "connected", serverName: name });
					await this.#loadServerResourcesAndPrompts(name, connection);
				})
				.catch(error => {
					if (this.#pendingToolLoads.get(name) !== toolsPromise) return;
					this.#pendingToolLoads.delete(name);
					const message = error instanceof Error ? error.message : String(error);
					onStatus?.({ type: "failed", serverName: name, error: message });
					if (!allowBackgroundLogging || reportedErrors.has(name)) return;
					logger.error("MCP tool load failed", { path: `mcp:${name}`, error: message });
				});
		}

		// Notify about servers we're connecting to, including configs that fail fast.
		if (statusServerNames.length > 0 && onStatus) {
			onStatus({ type: "connecting", serverNames: statusServerNames });
			for (const { name, message } of validationFailures) {
				onStatus({ type: "failed", serverName: name, error: message });
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
					allTools.push(...MCPTool.fromTools(connection, serverTools, reconnect, this.options.hostInteraction));
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
						allTools.push(
							...DeferredMCPTool.fromTools(
								name,
								cached,
								() => this.waitForConnection(name),
								source,
								reconnect,
								this.options.hostInteraction,
							),
						);
					}
				}
			}
		}

		// Stable sort by name so the order is independent of connection completion.
		// See `sortMCPToolsByName` for the cache-stability rationale.
		sortMCPToolsByName(allTools);

		// Update cached tools
		this.#tools = allTools;
		allowBackgroundLogging = true;

		return {
			tools: allTools,
			errors,
			connectedServers: Array.from(connectedServers),
			exaApiKeys: [], // Will be populated by discoverAndConnect
		};
	}

	#replaceServerTools(name: string, tools: CustomTool<TSchema, MCPToolDetails>[]): void {
		this.#tools = this.#tools.filter(t => !t.name.startsWith(`mcp__${name}_`));
		this.#tools.push(...tools);
		// Stable sort by name so reconnect order does not perturb the array.
		// See `sortMCPToolsByName` for the cache-stability rationale.
		sortMCPToolsByName(this.#tools);
	}

	#triggerNotificationRefresh(serverName: string, kind: "tools" | "resources" | "prompts"): void {
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
		void refresh.catch(error => {
			logger.debug("Failed MCP notification refresh", { path: `mcp:${serverName}`, kind, error });
		});
	}
	#handleServerNotification(
		serverName: string,
		method: string,
		params: unknown,
		sourceConnection?: MCPServerConnection,
	): void {
		const connection = this.#connections.get(serverName);
		if (!connection || (sourceConnection && sourceConnection !== connection)) return;
		logger.debug("MCP notification received", { path: `mcp:${serverName}`, method });
		const extensionRuntime = this.#extensionRuntimes.get(serverName);
		if (extensionRuntime?.connection === connection) {
			extensionRuntime.runtime.onNotification(connection, method, params);
		}
		this.#progressRegistry.dispatch(method, params);

		if (connection.protocol?.era === "modern") {
			if (
				method !== MCPNotificationMethods.TOOLS_LIST_CHANGED &&
				method !== MCPNotificationMethods.RESOURCES_LIST_CHANGED &&
				method !== MCPNotificationMethods.RESOURCES_UPDATED &&
				method !== MCPNotificationMethods.PROMPTS_LIST_CHANGED &&
				method !== MCPNotificationMethods.SUBSCRIPTIONS_ACKNOWLEDGED
			) {
				this.#onNotification?.(serverName, method, params);
			}
			return;
		}

		switch (method) {
			case MCPNotificationMethods.TOOLS_LIST_CHANGED:
				if (connection.capabilities.tools?.listChanged === true) {
					this.#triggerNotificationRefresh(serverName, "tools");
				}
				break;
			case MCPNotificationMethods.RESOURCES_LIST_CHANGED:
				if (connection.capabilities.resources?.listChanged === true) {
					this.#triggerNotificationRefresh(serverName, "resources");
				}
				break;
			case MCPNotificationMethods.RESOURCES_UPDATED: {
				const uri = (params as { uri?: string })?.uri;
				const subscribed = this.#subscribedResources.get(serverName);
				if (connection.capabilities.resources?.subscribe === true && uri && subscribed?.has(uri)) {
					this.#onResourcesChanged?.(serverName, uri);
				}
				break;
			}
			case MCPNotificationMethods.PROMPTS_LIST_CHANGED:
				if (connection.capabilities.prompts?.listChanged === true) {
					this.#triggerNotificationRefresh(serverName, "prompts");
				}
				break;
			default:
				break;
		}

		this.#onNotification?.(serverName, method, params);
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
	 * Disconnect from a specific server.
	 */
	async disconnectServer(name: string): Promise<void> {
		this.#pendingConnections.delete(name);
		this.#pendingToolLoads.delete(name);
		this.#pendingReconnections.delete(name);
		this.#sources.delete(name);
		this.#serverConfigs.delete(name);
		this.#pendingResourceRefresh.delete(name);
		this.#extensionRuntimes.delete(name);
		this.#reconnectHistory.delete(name);
		this.#knownResourceUris.delete(name);

		const connection = this.#connections.get(name);

		if (connection?.protocol?.era === "modern") {
			this.#cancelModernSubscription(name);
		} else {
			const subscribedUris = this.#subscribedResources.get(name);
			if (subscribedUris && subscribedUris.size > 0 && connection) {
				void unsubscribeFromResources(connection, Array.from(subscribedUris)).catch(() => {});
			}
			this.#subscribedResources.delete(name);
		}

		if (connection) {
			// Detach onClose to prevent spurious reconnect from close()
			connection.transport.onClose = undefined;
			await disconnectServer(connection);
			this.#connections.delete(name);
		}

		// Remove tools from this server and notify consumers
		const hadTools = this.#tools.some(t => t.name.startsWith(`mcp__${name}_`));
		this.#tools = this.#tools.filter(t => !t.name.startsWith(`mcp__${name}_`));
		if (hadTools) this.#onToolsChanged?.(this.#tools);

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
		this.#notificationsEpoch++;
		for (const name of new Set([
			...this.#modernSubscriptionRecoveryTimers.keys(),
			...this.#modernSubscriptionRecoveryAttempts.keys(),
		])) {
			this.#clearModernSubscriptionRecovery(name);
		}
		for (const name of [...this.#modernSubscriptions.keys()]) {
			this.#cancelModernSubscription(name);
		}
		// Detach onClose before closing to prevent spurious reconnect attempts
		for (const conn of this.#connections.values()) {
			conn.transport.onClose = undefined;
		}
		const promises = Array.from(this.#connections.values()).map(conn => disconnectServer(conn));
		await Promise.allSettled(promises);

		this.#extensionRuntimes.clear();
		this.#pendingConnections.clear();
		this.#pendingToolLoads.clear();
		this.#pendingReconnections.clear();
		this.#pendingResourceRefresh.clear();
		this.#sources.clear();
		this.#serverConfigs.clear();
		this.#connections.clear();
		this.#tools = [];
		this.#subscribedResources.clear();
		this.#knownResourceUris.clear();
		this.#reconnectHistory.clear();
		this.#modernSubscriptions.clear();
		this.#modernSubscriptionRevisions.clear();
	}

	/**
	 * Reconnect to a server after a connection failure.
	 *
	 * Tears down the stale connection, re-resolves auth, establishes a new
	 * connection, reloads tools, and notifies consumers. Concurrent calls for
	 * the same server share one reconnection attempt. Returns the new
	 * connection, or `null` if reconnection failed or the per-server crash
	 * burst limit (see {@link RECONNECT_BURST_LIMIT}) is exceeded.
	 *
	 * @param options.manual - When `true`, resets the crash-burst window so a
	 *   user-driven retry (e.g. `/mcp reconnect`) is never blocked by an
	 *   earlier storm. Defaults to `false`; the transport `onClose` callback
	 *   and the per-tool-call retry path in `tool-bridge` MUST NOT set it.
	 */
	async reconnectServer(name: string, options?: { manual?: boolean }): Promise<MCPServerConnection | null> {
		if (options?.manual) {
			this.#reconnectHistory.delete(name);
		}

		const pending = this.#pendingReconnections.get(name);
		if (pending) return pending;

		if (this.#tripReconnectBreaker(name)) {
			return null;
		}

		const attempt = this.#doReconnect(name);
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
				this.#cancelModernSubscription(name);
				this.#knownResourceUris.delete(name);
				stale.transport.onClose = undefined;
				void stale.transport.close().catch(() => {});
				this.#connections.delete(name);
			}
			this.#pendingConnections.delete(name);
			this.#pendingToolLoads.delete(name);
			return true;
		}
		return false;
	}

	async #doReconnect(name: string): Promise<MCPServerConnection | null> {
		const oldConnection = this.#connections.get(name);
		const config = oldConnection?.config ?? this.#serverConfigs.get(name);
		const source = this.#sources.get(name) ?? oldConnection?._source;
		if (!config) return null;

		logger.debug("MCP reconnecting", { path: `mcp:${name}` });

		// Close the old transport without removing tools or notifying consumers.
		// Tools stay available (stale) while we establish the new connection.
		// Fire-and-forget: don't await the close — HttpTransport.close() sends a
		// DELETE with config.timeout (30s default), and blocking here delays the
		// reconnect loop by that amount on every server restart.
		const reconnectEpoch = this.#epoch;
		if (oldConnection) {
			this.#cancelModernSubscription(name);
			this.#knownResourceUris.delete(name);
			// Detach onClose to prevent re-entrant reconnect from the close itself
			oldConnection.transport.onClose = undefined;
			void oldConnection.transport.close().catch(() => {});
			this.#connections.delete(name);
			this.#extensionRuntimes.delete(name);
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
		const extensionRuntime = createMCPExtensionRuntime(
			this.options.extensionRegistry ?? EMPTY_MCP_EXTENSION_REGISTRY,
			config.extensions,
		);
		const resolvedConfig = await this.#resolveAuthConfig(config);
		let notificationConnection: MCPServerConnection | undefined;
		const connection = await connectToServer(name, resolvedConfig, {
			onNotification: (method, params) => {
				this.#handleServerNotification(name, method, params, notificationConnection);
			},
			onRequest: (method, params) => {
				return this.#handleServerRequest(method, params);
			},
			modernClientCapabilities: this.options.hostInteraction?.clientCapabilities,
			extensionRuntime,
		});
		notificationConnection = connection;
		connection.config = config;
		if (source) connection._source = source;

		// Bail out if the server was disconnected or the manager was reset
		// while we were connecting (e.g. /mcp reload called disconnectAll).
		if (!this.#serverConfigs.has(name) || this.#epoch !== reconnectEpoch) {
			await connection.transport.close().catch(() => {});
			throw new Error(`Server "${name}" was disconnected during reconnection`);
		}

		this.#connections.set(name, connection);
		this.#extensionRuntimes.set(name, { connection, runtime: extensionRuntime });

		// Wire auth refresh for HTTP transports, and reconnect for any transport.
		// Same gate as connectServers: any resolvable managed credential.
		if (connection.transport instanceof HttpTransport && lookupMcpOAuthCredential(this.#authStorage, config)) {
			connection.transport.onAuthError = async () => {
				const refreshed = await this.#resolveAuthConfig(config, { forceRefresh: true });
				if (refreshed.type === "http" || refreshed.type === "sse") {
					return refreshed.headers ?? null;
				}
				return null;
			};
		}
		connection.transport.onClose = () => {
			if (this.#connections.get(name) !== connection) return;
			this.#cancelModernSubscription(name);
			logger.debug("MCP transport lost, triggering reconnect", { path: `mcp:${name}` });
			void this.reconnectServer(name);
		};
		try {
			const serverTools = await listTools(connection);
			const reconnect = () => this.reconnectServer(name);
			const customTools = MCPTool.fromTools(connection, serverTools, reconnect, this.options.hostInteraction);
			await this.#persistToolCache(name, config, serverTools, connection);
			this.#replaceServerTools(name, customTools);
			this.#onToolsChanged?.(this.#tools);
			void this.#loadServerResourcesAndPrompts(name, connection);
			return connection;
		} catch (error) {
			// Clean up the connection to avoid zombie transports
			connection.transport.onClose = undefined;
			await connection.transport.close().catch(() => {});
			this.#connections.delete(name);
			throw error;
		}
	}

	/**
	 * Best-effort loading of resources, resource subscriptions, and prompts.
	 * Shared between initial connection and reconnection.
	 */
	async #loadServerResourcesAndPrompts(name: string, connection: MCPServerConnection): Promise<void> {
		let resources: MCPResource[] = [];
		if (serverSupportsResources(connection.capabilities)) {
			try {
				[resources] = await Promise.all([listResources(connection), listResourceTemplates(connection)]);
				if (this.#connections.get(name) !== connection) return;
				this.#knownResourceUris.set(name, new Set(resources.map(resource => resource.uri)));

				if (
					this.#notificationsEnabled &&
					connection.protocol?.era === "legacy" &&
					connection.capabilities.resources?.subscribe
				) {
					const uris = resources.map(resource => resource.uri);
					const notificationEpoch = this.#notificationsEpoch;
					this.#subscribeAndTrack(name, connection, uris, notificationEpoch);
				}
			} catch (error) {
				logger.debug("Failed to load MCP resources", { path: `mcp:${name}`, error });
			}
		}

		if (serverSupportsPrompts(connection.capabilities)) {
			try {
				await listPrompts(connection);
				if (this.#connections.get(name) !== connection) return;
				this.#onPromptsChanged?.(name);
			} catch (error) {
				logger.debug("Failed to load MCP prompts", { path: `mcp:${name}`, error });
			}
		}

		if (this.#connections.get(name) !== connection) return;
		if (this.#notificationsEnabled && connection.protocol?.era === "modern") {
			await this.#reconcileModernSubscription(name, connection);
		}
	}

	/**
	 * Refresh tools from a specific server.
	 */
	async refreshServerTools(name: string): Promise<void> {
		const connection = this.#connections.get(name);
		if (!connection) return;

		invalidateMCPConnectionListCache(connection, "tools");

		// Reload tools
		const serverTools = await listTools(connection);
		const reconnect = () => this.reconnectServer(name);
		const customTools = MCPTool.fromTools(connection, serverTools, reconnect, this.options.hostInteraction);
		await this.#persistToolCache(name, connection.config, serverTools, connection);

		// Replace tools from this server
		this.#replaceServerTools(name, customTools);
		this.#onToolsChanged?.(this.#tools);
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
			invalidateMCPConnectionListCache(connection, "resources");
			invalidateMCPConnectionListCache(connection, "resourceTemplates");

			// Reload
			const [resources] = await Promise.all([listResources(connection), listResourceTemplates(connection)]);
			if (this.#connections.get(name) !== connection) return;
			this.#knownResourceUris.set(name, new Set(resources.map(resource => resource.uri)));
			if (this.#notificationsEnabled && connection.protocol?.era === "modern") {
				await this.#reconcileModernSubscription(name, connection);
			} else if (
				this.#notificationsEnabled &&
				connection.protocol?.era === "legacy" &&
				connection.capabilities.resources?.subscribe
			) {
				const newUris = new Set(resources.map(resource => resource.uri));
				const oldUris = this.#subscribedResources.get(name);
				const notificationEpoch = this.#notificationsEpoch;

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
					if (action === "ignore" || this.#connections.get(name) !== connection) {
						return;
					}
					this.#subscribedResources.set(name, newUris);
				} catch (error) {
					logger.debug("Failed to re-subscribe to MCP resources", { path: `mcp:${name}`, error });
				}
			}
		};

		const promise = doRefresh().finally(() => {
			const pending = this.#pendingResourceRefresh.get(name);
			if (pending?.promise === promise) {
				this.#pendingResourceRefresh.delete(name);
			}
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

		invalidateMCPConnectionListCache(connection, "prompts");
		await listPrompts(connection);

		this.#onPromptsChanged?.(name);
	}

	/**
	 * Get resources and templates for a specific server.
	 */
	getServerResources(name: string): { resources: MCPResource[]; templates: MCPResourceTemplate[] } | undefined {
		const connection = this.#connections.get(name);
		if (!connection) return undefined;
		const resources = isMCPResultCacheFresh(connection.resultHints?.resources) ? (connection.resources ?? []) : [];
		const templates = isMCPResultCacheFresh(connection.resultHints?.resourceTemplates)
			? (connection.resourceTemplates ?? [])
			: [];
		return { resources, templates };
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
		return readResourceWithMRTR(connection, uri, this.options.hostInteraction, options);
	}

	/**
	 * Get prompts for a specific server.
	 */
	getServerPrompts(name: string): MCPPrompt[] | undefined {
		const connection = this.#connections.get(name);
		if (!connection) return undefined;
		return isMCPResultCacheFresh(connection.resultHints?.prompts) ? (connection.prompts ?? []) : [];
	}

	/**
	 * Complete a prompt or resource-template argument only when the connected
	 * server advertises this optional capability.
	 */
	async completeServerArgument(
		name: string,
		ref: MCPCompletionReference,
		argument: MCPCompletionArgument,
		context?: MCPCompletionContext,
		options?: MCPRequestOptions & { onProgress?: MCPProgressHandler },
	): Promise<MCPCompletionResult | undefined> {
		const connection = this.#connections.get(name);
		if (!connection || !serverSupportsCompletions(connection.capabilities)) return undefined;
		const { onProgress, ...requestOptions } = options ?? {};
		if (onProgress) {
			return completeWithProgress(
				connection,
				ref,
				argument,
				this.#progressRegistry,
				onProgress,
				context,
				requestOptions,
			);
		}
		return complete(connection, ref, argument, context, requestOptions);
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
		return getPromptWithMRTR(connection, promptName, args, this.options.hostInteraction, options);
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
				// Refresh material comes from ONE source: the credential's embedded
				// fields (written atomically with the tokens they minted — tokenUrl
				// always present) or, for legacy rows that predate embedding, the
				// config auth block. Never mix the two: a shared file's auth block
				// can belong to another profile, whose client the grant is NOT
				// bound to.
				const material = selectMcpOAuthRefreshMaterial(credential, auth);
				const tokenUrl = material?.tokenUrl;
				const clientId = material?.clientId;
				const clientSecret = material?.clientSecret;
				// `authorizationUrl` only lives on the embedded credential form;
				// legacy `MCPAuthConfig` rows never carried it. Required to filter
				// same-origin resource indicators on refresh when the authorize and
				// token endpoints sit on different origins (issue #3502 review
				// follow-up).
				const authorizationUrl = material && "authorizationUrl" in material ? material.authorizationUrl : undefined;
				const resourceIsFallback =
					!material?.resource && (config.type === "http" || config.type === "sse") && Boolean(config.url);
				const resource = material?.resource ?? (resourceIsFallback ? config.url : undefined);
				// Proactive refresh: 5-minute buffer before expiry
				// Force refresh: on 401/403 auth errors (revoked tokens, clock skew, missing expires)
				const REFRESH_BUFFER_MS = 5 * 60_000;
				const shouldRefresh =
					opts?.forceRefresh || (credential.expires && Date.now() >= credential.expires - REFRESH_BUFFER_MS);
				if (shouldRefresh && credential.refresh && tokenUrl) {
					try {
						const refreshed = await refreshMCPOAuthToken(
							tokenUrl,
							credential.refresh,
							clientId,
							clientSecret,
							resource,
							{ authorizationUrl, stripSameOriginResource: resourceIsFallback },
						);
						// Spread the old credential first so embedded refresh material survives rotation.
						const refreshedCredential: MCPStoredOAuthCredential = {
							...credential,
							...refreshed,
							tokenUrl,
							clientId,
							clientSecret,
							resource: resourceIsFallback ? undefined : resource,
							authorizationUrl,
						};
						await this.#authStorage.set(credentialId, refreshedCredential);
						credential = refreshedCredential;
					} catch (refreshError) {
						const errorMsg = refreshError instanceof Error ? refreshError.message : String(refreshError);
						if (isDefinitiveOAuthFailure(errorMsg)) {
							// `invalid_grant` / `invalid_token` / 401 from the token endpoint means
							// the server has retired this credential — keeping the stale access
							// token would just re-fail with 401 on every MCP request and leave a
							// poisoned row in agent.db that survives restarts. Drop it now so the
							// next connect attempt surfaces a clean "needs reauth" failure and
							// the user can recover with `/mcp reauth <server>` (or `/mcp unauth`
							// to forget the server entirely).
							logger.warn("MCP OAuth refresh failed definitively; cleared credential", {
								credentialId,
								error: errorMsg,
							});
							await this.#authStorage.remove(credentialId);
							credential = undefined;
						} else {
							logger.warn("MCP OAuth refresh failed, using existing token", {
								credentialId,
								error: refreshError,
							});
						}
					}
				}

				if (credential) {
					if (resolved.type === "http" || resolved.type === "sse") {
						resolved = {
							...resolved,
							headers: {
								...resolved.headers,
								Authorization: `Bearer ${credential.access}`,
							},
						};
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
			if (resolved.env) {
				const nextEnv: Record<string, string> = {};
				for (const [key, value] of Object.entries(resolved.env)) {
					const resolvedValue = await resolveConfigValue(value);
					if (resolvedValue) nextEnv[key] = resolvedValue;
				}
				resolved = { ...resolved, env: nextEnv };
			}
		} else {
			if (resolved.headers) {
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
