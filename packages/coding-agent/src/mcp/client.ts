/**
 * MCP Client.
 *
 * Handles connection initialization, tool listing, and tool calling.
 */
import * as path from "node:path";
import * as url from "node:url";
import { getProjectDir, logger, untilAborted, withTimeout } from "@pk-nerdsaver-ai/pi-utils";
import { throwIfAborted } from "../tools/tool-errors";
import type { MCPExtensionRuntime } from "./extensions";
import { describeMCPTimeout, isMCPTimeoutEnabled, resolveMCPTimeoutMs } from "./timeout";
import { createHttpTransport } from "./transports/http";
import { createStdioTransport, StdioTransport } from "./transports/stdio";
import type {
	MCPAuthenticationContextRevision,
	MCPCompleteParams,
	MCPCompletionArgument,
	MCPCompletionContext,
	MCPCompletionReference,
	MCPCompletionResult,
	MCPConnectionProtocol,
	MCPDiscoverResult,
	MCPGetPromptParams,
	MCPGetPromptResult,
	MCPHostInteraction,
	MCPHttpServerConfig,
	MCPInitializeParams,
	MCPInitializeResult,
	MCPInputRequests,
	MCPInputRequiredResult,
	MCPInputResponses,
	MCPListenHandle,
	MCPListenOptions,
	MCPModernClientCapabilities,
	MCPModernConnectionProtocol,
	MCPModernResultCacheHint,
	MCPMRTRMethod,
	MCPNormalizedServerCapabilities,
	MCPProgressHandler,
	MCPProgressToken,
	MCPPrompt,
	MCPRequestOptions,
	MCPResource,
	MCPResourceReadParams,
	MCPResourceReadResult,
	MCPResourceSubscribeParams,
	MCPResourceTemplate,
	MCPResultCacheHint,
	MCPServerConfig,
	MCPServerConnection,
	MCPSseServerConfig,
	MCPStdioServerConfig,
	MCPSubscriptionNotificationFilter,
	MCPToolCallParams,
	MCPToolCallResult,
	MCPToolDefinition,
	MCPToolHeaderMetadata,
	MCPTransport,
	MCPTransportProtocolConfiguration,
	TransportFactory,
} from "./types";
import {
	buildModernRequestParams,
	createMCPLegacyResultCacheHint,
	hasMCPSubscriptionNotifications,
	isMCPResultCacheFresh,
	MCP_CLIENT_INFO,
	MCP_LEGACY_PROTOCOL_VERSION,
	MCP_MODERN_PROTOCOL_VERSION,
	MCP_SUPPORTED_MODERN_PROTOCOL_VERSIONS,
	MCPInputRequestUnsupportedError,
	MCPInputRequiredMalformedError,
	MCPInputRequiredRetryError,
	MCPInputRequiredRoundsExceededError,
	MCPModernProtocolNegotiationError,
	MCPNotificationMethods,
	mergeMCPModernResultCacheHints,
	normalizeMCPServerCapabilities,
	normalizeModernMCPServerCapabilities,
	parseUnsupportedProtocolVersionError,
	validateMCPModernCacheableResult,
	validateMCPToolHeaderMetadata,
} from "./types";

/** Modern capabilities actually implemented by this client slice. */
const MODERN_CLIENT_CAPABILITIES: MCPModernClientCapabilities = {};

/** Owns request-scoped progress callback lifecycles for one MCP host. */
export class MCPProgressRegistry {
	#handlers = new Map<MCPProgressToken, MCPProgressHandler>();

	/** Register one handler under a fresh opaque token and return its idempotent cleanup. */
	register(handler: MCPProgressHandler): { token: MCPProgressToken; dispose(): void } {
		const token = crypto.randomUUID();
		this.#handlers.set(token, handler);
		let disposed = false;
		return {
			token,
			dispose: () => {
				if (disposed) return;
				disposed = true;
				this.#handlers.delete(token);
			},
		};
	}

	/** Deliver only a valid progress notification with a live request token. */
	dispatch(method: string, params: unknown): boolean {
		if (method !== MCPNotificationMethods.PROGRESS) return false;
		const value = asRecord(params);
		const token = value?.progressToken;
		const progress = value?.progress;
		const total = value?.total;
		const message = value?.message;
		if (
			(typeof token !== "string" && typeof token !== "number") ||
			typeof progress !== "number" ||
			!Number.isFinite(progress) ||
			(total !== undefined && (typeof total !== "number" || !Number.isFinite(total))) ||
			(message !== undefined && typeof message !== "string")
		) {
			return false;
		}
		const handler = this.#handlers.get(token);
		if (!handler) return false;
		try {
			handler({
				progressToken: token,
				progress,
				...(total === undefined ? {} : { total }),
				...(message === undefined ? {} : { message }),
			});
		} catch (error) {
			logger.warn("MCP progress handler failed", { error });
		}
		return true;
	}

	/** Visible for focused lifecycle tests and host diagnostics. */
	get size(): number {
		return this.#handlers.size;
	}
}

/**
 * Send one request with a unique progress token. The handler is unregistered on
 * every terminal path, so late or recycled notifications cannot update a new request.
 */
export async function requestFromConnectionWithProgress<T>(
	connection: MCPServerConnection,
	method: string,
	params: Record<string, unknown> | undefined,
	registry: MCPProgressRegistry,
	onProgress: MCPProgressHandler,
	options?: MCPRequestOptions,
): Promise<T> {
	const registration = registry.register(onProgress);
	const requestParams = {
		...params,
		_meta: {
			...asRecord(params?._meta),
			progressToken: registration.token,
		},
	};
	try {
		return await requestFromConnection<T>(connection, method, requestParams, {
			...options,
			metadata: { ...options?.metadata, progressToken: registration.token },
		});
	} finally {
		registration.dispose();
	}
}

/** Options for opening a connection. The factory hook supports custom transports and focused boundary tests. */
export interface MCPConnectOptions {
	signal?: AbortSignal;
	onNotification?: (method: string, params: unknown) => void;
	onRequest?: (method: string, params: unknown) => Promise<unknown>;
	transportFactory?: TransportFactory;
	/** Explicit host-supported capabilities to advertise for this modern connection. */
	modernClientCapabilities?: MCPModernClientCapabilities;
	/** Trusted extension runtime; it is the sole owner of extension advertisement. */
	extensionRuntime?: MCPExtensionRuntime;
}

/**
 * Default handler for legacy server-to-client requests.
 * Modern connections must not install it: 2026-07-28 interaction is MRTR.
 */
async function defaultRequestHandler(method: string, _params: unknown): Promise<unknown> {
	switch (method) {
		case "ping":
			return {};
		case "roots/list": {
			const cwd = getProjectDir();
			return {
				roots: [{ uri: url.pathToFileURL(cwd).href, name: path.basename(cwd) }],
			};
		}
		default:
			throw Object.assign(new Error(`Unsupported server request: ${method}`), { code: -32601 });
	}
}

/** Create a transport for the given server config. */
async function createTransport(config: MCPServerConfig, transportFactory?: TransportFactory): Promise<MCPTransport> {
	if (transportFactory) return transportFactory(config);

	const serverType = config.type ?? "stdio";
	switch (serverType) {
		case "stdio":
			return createStdioTransport(config as MCPStdioServerConfig);
		case "http":
		case "sse":
			return createHttpTransport(config as MCPHttpServerConfig | MCPSseServerConfig);
		default:
			throw new Error(`Unknown server type: ${serverType}`);
	}
}

/**
 * Retire a failed transport before another attempt can become authoritative.
 * Stdio teardown revokes subprocess ownership synchronously, while transports
 * without that concrete lifecycle retain their normal awaited close contract.
 */
async function retireFailedTransport(transport: MCPTransport): Promise<void> {
	if (transport instanceof StdioTransport) {
		transport.retire();
		return;
	}
	await transport.close();
}

/** Apply callbacks that are safe before the connection's protocol era is known. */
function prepareTransportForNegotiation(transport: MCPTransport, options?: MCPConnectOptions): void {
	transport.onNotification = options?.onNotification;
	// Never answer server-to-client requests while the era is unknown or
	// modern. The legacy handler is installed only after fallback.
	transport.onRequest = undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

/** Distinguishes a client-side discovery timeout from an error returned by the server. */
class MCPModernProbeTimeoutError extends Error {
	constructor() {
		super("Modern MCP server/discover probe timed out");
		this.name = "MCPModernProbeTimeoutError";
	}
}

async function awaitModernProbe<T>(request: Promise<T>, timeoutMs: number | undefined): Promise<T> {
	if (timeoutMs === undefined) return request;

	let timeoutId: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_resolve, reject) => {
		timeoutId = setTimeout(() => reject(new MCPModernProbeTimeoutError()), timeoutMs);
	});

	try {
		return await Promise.race([request, timeout]);
	} finally {
		if (timeoutId !== undefined) clearTimeout(timeoutId);
	}
}

function parseDiscoverResult(value: unknown): {
	discovery: MCPDiscoverResult;
	hint: MCPModernResultCacheHint;
} {
	let hint: MCPModernResultCacheHint;
	try {
		hint = validateMCPModernCacheableResult("server/discover", value);
	} catch (error) {
		throw new MCPModernProtocolNegotiationError(
			error instanceof Error ? error.message : "Modern server/discover response has invalid cache metadata",
		);
	}

	const result = asRecord(value);
	if (!result) {
		throw new MCPModernProtocolNegotiationError("Modern server/discover response must be an object");
	}
	const supportedVersions = result.supportedVersions;
	if (!Array.isArray(supportedVersions) || !supportedVersions.every(version => typeof version === "string")) {
		throw new MCPModernProtocolNegotiationError("Modern server/discover response is missing supportedVersions");
	}

	const capabilities = asRecord(result.capabilities);
	if (!capabilities) {
		throw new MCPModernProtocolNegotiationError("Modern server/discover response is missing capabilities");
	}

	const discovery: MCPDiscoverResult = {
		resultType: "complete",
		supportedVersions,
		capabilities: capabilities as MCPDiscoverResult["capabilities"],
		ttlMs: hint.ttlMs,
		cacheScope: hint.cacheScope,
	};
	const metadata = asRecord(result._meta);
	if (metadata) discovery._meta = metadata as MCPDiscoverResult["_meta"];
	if (typeof result.instructions === "string") discovery.instructions = result.instructions;
	return { discovery, hint };
}

function selectModernProtocolVersion(
	supportedVersions: readonly string[],
): typeof MCP_MODERN_PROTOCOL_VERSION | undefined {
	return MCP_SUPPORTED_MODERN_PROTOCOL_VERSIONS.find(version => supportedVersions.includes(version));
}

function modernTransportConfiguration(
	version: typeof MCP_MODERN_PROTOCOL_VERSION,
	phase: "probing" | "connected",
	clientCapabilities: MCPModernClientCapabilities = MODERN_CLIENT_CAPABILITIES,
): MCPTransportProtocolConfiguration {
	return {
		era: "modern",
		phase,
		version,
		clientInfo: MCP_CLIENT_INFO,
		clientCapabilities,
	};
}

async function configureTransportProtocol(
	transport: MCPTransport,
	configuration: MCPTransportProtocolConfiguration,
): Promise<void> {
	await transport.configureProtocol?.(configuration);
}

function areEquivalentProtocolValues(left: unknown, right: unknown): boolean {
	if (Object.is(left, right)) return true;
	if (Array.isArray(left) || Array.isArray(right)) {
		return (
			Array.isArray(left) &&
			Array.isArray(right) &&
			left.length === right.length &&
			left.every((value, index) => areEquivalentProtocolValues(value, right[index]))
		);
	}

	const leftRecord = asRecord(left);
	const rightRecord = asRecord(right);
	if (!leftRecord || !rightRecord) return false;
	const leftKeys = Object.keys(leftRecord);
	const rightKeys = Object.keys(rightRecord);
	return (
		leftKeys.length === rightKeys.length &&
		leftKeys.every(
			key => Object.hasOwn(rightRecord, key) && areEquivalentProtocolValues(leftRecord[key], rightRecord[key]),
		)
	);
}

/**
 * A configured HTTP transport must confirm that it has applied the final
 * modern protocol settings before callers can send modern requests through it.
 * Transports without the optional configuration hook remain compatible.
 */
function hasAcknowledgedModernHttpConfiguration(
	transport: MCPTransport,
	configuration: MCPTransportProtocolConfiguration,
): boolean {
	if (!transport.configureProtocol) return true;

	const applied = transport.getProtocolConfiguration?.();
	if (applied?.era !== "modern" || configuration.era !== "modern") return false;
	return (
		applied.phase === configuration.phase &&
		applied.version === configuration.version &&
		applied.clientInfo.name === configuration.clientInfo.name &&
		applied.clientInfo.version === configuration.clientInfo.version &&
		areEquivalentProtocolValues(applied.clientCapabilities, configuration.clientCapabilities)
	);
}

function discoveryServerInfo(discovery: MCPDiscoverResult, fallbackName: string): { name: string; version: string } {
	const serverInfo = asRecord(discovery._meta?.["io.modelcontextprotocol/serverInfo"]);
	if (typeof serverInfo?.name === "string" && typeof serverInfo.version === "string") {
		return { name: serverInfo.name, version: serverInfo.version };
	}
	// `serverInfo` is a SHOULD in discovery. Keep the existing mandatory
	// connection display field usable while making the protocol descriptor
	// preserve the absence as `undefined`.
	return { name: fallbackName, version: "unknown" };
}

function discoveredProtocolServerInfo(discovery: MCPDiscoverResult): { name: string; version: string } | undefined {
	const serverInfo = asRecord(discovery._meta?.["io.modelcontextprotocol/serverInfo"]);
	if (typeof serverInfo?.name === "string" && typeof serverInfo.version === "string") {
		return { name: serverInfo.name, version: serverInfo.version };
	}
	return undefined;
}

async function negotiateModernProtocol(
	transport: MCPTransport,
	signal: AbortSignal | undefined,
	probeTimeoutMs: number | undefined,
	clientCapabilities: MCPModernClientCapabilities,
): Promise<{
	discovery: MCPDiscoverResult;
	discoveryHint: MCPModernResultCacheHint;
	protocol: MCPModernConnectionProtocol;
}> {
	let version: typeof MCP_MODERN_PROTOCOL_VERSION = MCP_MODERN_PROTOCOL_VERSION;
	const attemptCounts = new Map<string, number>();

	for (;;) {
		attemptCounts.set(version, (attemptCounts.get(version) ?? 0) + 1);
		await configureTransportProtocol(transport, modernTransportConfiguration(version, "probing", clientCapabilities));
		try {
			const discoveryRequest = transport.request<unknown>(
				"server/discover",
				buildModernRequestParams(undefined, {
					version,
					clientCapabilities,
				}),
				{ signal },
			);
			const response = await awaitModernProbe(discoveryRequest, probeTimeoutMs);
			const { discovery, hint: discoveryHint } = parseDiscoverResult(response);
			if (!discovery.supportedVersions.includes(version)) {
				throw new MCPModernProtocolNegotiationError(
					`Modern server/discover response does not include the requested protocol version "${version}" in supportedVersions`,
				);
			}
			const serverInfo = discoveredProtocolServerInfo(discovery);
			const protocol: MCPModernConnectionProtocol = {
				era: "modern",
				version,
				supportedVersions: discovery.supportedVersions,
				clientCapabilities,
				capabilities: normalizeModernMCPServerCapabilities(discovery.capabilities),
				...(serverInfo ? { serverInfo } : {}),
			};
			await configureTransportProtocol(
				transport,
				modernTransportConfiguration(version, "connected", clientCapabilities),
			);
			return { discovery, discoveryHint, protocol };
		} catch (error) {
			const versionError = parseUnsupportedProtocolVersionError(error);
			if (!versionError) throw error;

			const mutualVersion = versionError.data ? selectModernProtocolVersion(versionError.data.supported) : undefined;
			if (!mutualVersion) {
				throw new MCPModernProtocolNegotiationError(
					"Modern MCP server does not advertise a mutually supported protocol version",
					versionError,
				);
			}

			// A conforming server will select a different mutual version. Permit
			// one retry of the same version as a bounded recovery for servers
			// whose first probe raced startup, but never downgrade to initialize.
			if ((attemptCounts.get(mutualVersion) ?? 0) >= 2) {
				throw new MCPModernProtocolNegotiationError(
					"Modern MCP server repeatedly rejected the negotiated protocol version",
					versionError,
				);
			}
			version = mutualVersion;
		}
	}
}

function isStdioConfig(config: MCPServerConfig): boolean {
	return (config.type ?? "stdio") === "stdio";
}

function isExplicitLegacySse(config: MCPServerConfig): boolean {
	return config.type === "sse";
}

function legacyFallbackDecision(
	config: MCPServerConfig,
	transport: MCPTransport,
	error: unknown,
): "legacy" | "modern-error" | "reject" {
	if (isStdioConfig(config)) return "legacy";
	const decision = transport.classifyModernProbeFailure?.(error);
	return decision?.kind ?? "reject";
}

async function startLegacySSEListener(transport: MCPTransport): Promise<void> {
	const listenerTransport = transport as MCPTransport & { startSSEListener?: () => Promise<void> };
	if (listenerTransport.startSSEListener) {
		await listenerTransport.startSSEListener();
	}
}

/** Initialize an initialization-based legacy connection. */
async function initializeConnection(
	transport: MCPTransport,
	options?: {
		signal?: AbortSignal;
		/** Called after initialize but before notifications/initialized. */
		onInitialized?: () => void | Promise<void>;
	},
): Promise<MCPInitializeResult> {
	const params: MCPInitializeParams = {
		protocolVersion: MCP_LEGACY_PROTOCOL_VERSION,
		capabilities: {
			roots: { listChanged: false },
		},
		clientInfo: MCP_CLIENT_INFO,
	};

	const result = await transport.request<MCPInitializeResult>(
		"initialize",
		params as unknown as Record<string, unknown>,
		{ signal: options?.signal },
	);

	if (options?.signal?.aborted) {
		throw options.signal.reason instanceof Error ? options.signal.reason : new Error("Aborted");
	}

	await options?.onInitialized?.();
	await transport.notify("notifications/initialized");
	return result;
}

/**
 * Connect with a modern `server/discover` probe first, then only enter the
 * legacy lifecycle after a transport-valid fallback outcome.
 */
export async function connectToServer(
	name: string,
	config: MCPServerConfig,
	options?: MCPConnectOptions,
): Promise<MCPServerConnection> {
	const callerCapabilities = options?.modernClientCapabilities ?? MODERN_CLIENT_CAPABILITIES;
	const { extensions: callerExtensions, ...baseClientCapabilities } = callerCapabilities;
	if (callerExtensions && Object.keys(callerExtensions).length > 0) {
		throw new Error(
			options?.extensionRuntime
				? "MCP modernClientCapabilities.extensions conflicts with the trusted extension runtime"
				: "MCP extension capabilities require a trusted extension runtime",
		);
	}
	const extensionCapabilities = options?.extensionRuntime?.clientExtensionCapabilities();
	const clientCapabilities = freezeInteractionValue(
		structuredClone({
			...baseClientCapabilities,
			...(extensionCapabilities ? { extensions: extensionCapabilities } : {}),
		}),
	);
	let transport: MCPTransport | undefined;
	let connectionAttemptOwned = true;
	const timeoutMs = resolveMCPTimeoutMs(config.timeout);
	const createOwnedTransport = async (): Promise<MCPTransport> => {
		const candidate = await createTransport(config, options?.transportFactory);
		if (!connectionAttemptOwned) {
			await retireFailedTransport(candidate);
			throw new Error(`Connection attempt to MCP server "${name}" was retired`);
		}
		transport = candidate;
		return candidate;
	};

	const connect = async (): Promise<MCPServerConnection> => {
		transport = await createOwnedTransport();
		prepareTransportForNegotiation(transport, options);

		const connectLegacy = async (): Promise<MCPServerConnection> => {
			const legacyProtocol: MCPTransportProtocolConfiguration = {
				era: "legacy",
				phase: "connected",
				version: MCP_LEGACY_PROTOCOL_VERSION,
			};
			await configureTransportProtocol(transport!, legacyProtocol);
			transport!.onRequest = options?.onRequest ?? defaultRequestHandler;
			const initResult = await initializeConnection(transport!, {
				signal: options?.signal,
				onInitialized: () => startLegacySSEListener(transport!),
			});
			const capabilities = normalizeMCPServerCapabilities(initResult.capabilities);
			const protocol: MCPConnectionProtocol = {
				era: "legacy",
				version: initResult.protocolVersion,
				capabilities,
			};
			const connection: MCPServerConnection = {
				name,
				config,
				transport: transport!,
				serverInfo: initResult.serverInfo,
				capabilities,
				protocol,
				extensions: options?.extensionRuntime?.negotiate(protocol),
				extensionRuntime: options?.extensionRuntime,
				instructions: initResult.instructions,
			};
			options?.extensionRuntime?.onNegotiated(connection);
			return connection;
		};

		const probeTimeoutMs =
			isStdioConfig(config) && isMCPTimeoutEnabled(timeoutMs) ? Math.max(1, Math.floor(timeoutMs / 2)) : undefined;
		try {
			if (isExplicitLegacySse(config)) return await connectLegacy();

			try {
				const { discovery, discoveryHint, protocol } = await negotiateModernProtocol(
					transport,
					options?.signal,
					probeTimeoutMs,
					clientCapabilities,
				);
				const connectedConfiguration = modernTransportConfiguration(
					protocol.version,
					"connected",
					clientCapabilities,
				);
				if (config.type === "http" && !hasAcknowledgedModernHttpConfiguration(transport, connectedConfiguration)) {
					throw new MCPModernProtocolNegotiationError(
						"Configured HTTP MCP transport did not acknowledge the connected modern protocol settings",
					);
				}
				const connection: MCPServerConnection = {
					name,
					config,
					transport,
					serverInfo: discoveryServerInfo(discovery, name),
					capabilities: protocol.capabilities,
					protocol,
					extensions: options?.extensionRuntime?.negotiate(protocol),
					extensionRuntime: options?.extensionRuntime,
					resultHints: { discovery: discoveryHint },
					instructions: discovery.instructions,
				};
				options?.extensionRuntime?.onNegotiated(connection);
				return connection;
			} catch (error) {
				if (options?.signal?.aborted || error instanceof MCPModernProtocolNegotiationError) throw error;
				const decision = legacyFallbackDecision(config, transport, error);
				if (decision === "legacy") {
					const requiresReplacement =
						error instanceof MCPModernProbeTimeoutError || (isStdioConfig(config) && !transport.connected);
					if (requiresReplacement) {
						const probeTransport = transport;
						transport = undefined;
						await retireFailedTransport(probeTransport);
						const replacementTransport = await createOwnedTransport();
						if (replacementTransport === probeTransport) {
							throw new MCPModernProtocolNegotiationError(
								"Legacy MCP initialization requires a replacement transport after the modern probe closed or timed out",
							);
						}
						prepareTransportForNegotiation(replacementTransport, options);
					}
					return await connectLegacy();
				}
				if (decision === "modern-error") {
					throw new MCPModernProtocolNegotiationError("Modern MCP probe failed with a recognized modern error");
				}
				throw error;
			}
		} catch (error) {
			const failedTransport = transport;
			transport = undefined;
			if (failedTransport) {
				await retireFailedTransport(failedTransport);
			}
			throw error;
		}
	};

	try {
		if (!isMCPTimeoutEnabled(timeoutMs)) return await connect();
		return await withTimeout(
			connect(),
			timeoutMs,
			`Connection to MCP server "${name}" timed out after ${describeMCPTimeout(timeoutMs)}`,
			options?.signal,
		);
	} catch (error) {
		// Revoke ownership before cleanup so a late factory result cannot install a
		// transport after the caller's total connection budget has expired.
		connectionAttemptOwned = false;
		const failedTransport = transport;
		transport = undefined;
		if (failedTransport) {
			void retireFailedTransport(failedTransport).catch(retirementError => {
				logger.debug("Failed to retire MCP transport after connection failure", {
					server: name,
					error: retirementError instanceof Error ? retirementError.message : String(retirementError),
				});
			});
		}
		throw error;
	}
}

/** Returns the descriptor persisted by `connectToServer`, if this was not an external legacy construction. */
export function getConnectionProtocol(connection: MCPServerConnection): MCPConnectionProtocol | undefined {
	return connection.protocol;
}

/** Converts a negotiated descriptor into the configuration a transport writer can inspect. */
export function getConnectionTransportProtocolConfiguration(
	connection: MCPServerConnection,
): MCPTransportProtocolConfiguration | undefined {
	const protocol = connection.protocol;
	if (!protocol) return undefined;
	if (protocol.era === "modern") {
		return modernTransportConfiguration(protocol.version, "connected", protocol.clientCapabilities);
	}
	return {
		era: "legacy",
		phase: "connected",
		version: protocol.version,
	};
}

/** Builds request params appropriate for the connection era without mutating caller params. */
export function buildConnectionRequestParams(
	connection: MCPServerConnection,
	params?: Record<string, unknown>,
	metadata?: MCPRequestOptions["metadata"],
): Record<string, unknown> {
	const protocol = connection.protocol;
	if (protocol?.era === "modern") {
		return buildModernRequestParams(params, protocol, metadata);
	}
	return params ?? {};
}

/** Sends an era-decorated request; high-level tools/resources/prompts use this path. */
export async function requestFromConnection<T>(
	connection: MCPServerConnection,
	method: string,
	params?: Record<string, unknown>,
	options?: MCPRequestOptions,
): Promise<T> {
	return connection.transport.request<T>(
		method,
		buildConnectionRequestParams(connection, params, options?.metadata),
		options,
	);
}

/** Maximum server-directed input-response cycles for one modern operation. */
export const MCP_MAX_INPUT_REQUIRED_ROUNDS = 4;
const MRTR_METHODS = new Set<MCPMRTRMethod>(["tools/call", "resources/read", "prompts/get"]);

function isInputRequiredResult(value: unknown): value is MCPInputRequiredResult {
	return asRecord(value)?.resultType === "input_required";
}

function freezeInteractionValue<T>(value: T): T {
	if (value && typeof value === "object") {
		for (const child of Object.values(value as Record<string, unknown>)) freezeInteractionValue(child);
		Object.freeze(value);
	}
	return value;
}

function parseInputRequests(method: MCPMRTRMethod, value: unknown): MCPInputRequests | undefined {
	if (value === undefined) return undefined;
	const requests = asRecord(value);
	if (!requests) throw new MCPInputRequiredMalformedError(method, "inputRequests must be an object");
	for (const [key, request] of Object.entries(requests)) {
		const inputRequest = asRecord(request);
		if (!inputRequest) {
			throw new MCPInputRequiredMalformedError(method, `inputRequests.${key} must be an object`);
		}
		if (
			inputRequest.method !== "elicitation/create" &&
			inputRequest.method !== "sampling/createMessage" &&
			inputRequest.method !== "roots/list"
		) {
			throw new MCPInputRequestUnsupportedError(method, `inputRequests.${key} has an unsupported method`);
		}
		const params = inputRequest.params;
		if (inputRequest.method === "roots/list" && params === undefined) continue;
		if (!asRecord(params)) {
			throw new MCPInputRequiredMalformedError(method, `inputRequests.${key} must include object params`);
		}
	}
	return requests as MCPInputRequests;
}

function assertSupportedInputRequests(
	method: MCPMRTRMethod,
	capabilities: MCPModernClientCapabilities,
	requests: MCPInputRequests,
): void {
	for (const [key, request] of Object.entries(requests)) {
		const params = request.params ?? {};
		if (request.method === "elicitation/create") {
			const mode = params.mode ?? "form";
			const formSupported =
				capabilities.elicitation !== undefined &&
				(capabilities.elicitation.form !== undefined || capabilities.elicitation.url === undefined);
			if (
				(mode === "form" && !formSupported) ||
				(mode === "url" && !capabilities.elicitation?.url) ||
				(mode !== "form" && mode !== "url")
			) {
				throw new MCPInputRequestUnsupportedError(
					method,
					`inputRequests.${key} requires unsupported elicitation mode`,
				);
			}
		} else if (request.method === "sampling/createMessage") {
			const includeContext = params.includeContext;
			if (
				includeContext !== undefined &&
				includeContext !== "none" &&
				includeContext !== "thisServer" &&
				includeContext !== "allServers"
			) {
				throw new MCPInputRequiredMalformedError(
					method,
					`inputRequests.${key} has an invalid includeContext value`,
				);
			}
			if (
				!capabilities.sampling ||
				(params.tools !== undefined && !capabilities.sampling.tools) ||
				((includeContext === "thisServer" || includeContext === "allServers") && !capabilities.sampling.context)
			) {
				throw new MCPInputRequestUnsupportedError(method, `inputRequests.${key} requires unsupported sampling`);
			}
		} else if (!capabilities.roots) {
			throw new MCPInputRequestUnsupportedError(method, `inputRequests.${key} requires roots`);
		}
	}
}

function assertInputResponses(method: MCPMRTRMethod, responses: MCPInputResponses, requests: MCPInputRequests): void {
	const responseMap = asRecord(responses);
	if (!responseMap) throw new MCPInputRequiredMalformedError(method, "input response map must be an object");
	const requestKeys = Object.keys(requests);
	const responseKeys = Object.keys(responseMap);
	if (requestKeys.length !== responseKeys.length || requestKeys.some(key => !Object.hasOwn(responseMap, key))) {
		throw new MCPInputRequiredMalformedError(method, "input response keys must exactly match input request keys");
	}
}

function assertCompleteMCPResult(
	method: MCPMRTRMethod,
	connection: MCPServerConnection,
	value: unknown,
	extensionRuntime?: MCPExtensionRuntime,
): void {
	const result = asRecord(value);
	if (!result) throw new MCPInputRequiredMalformedError(method, "result must be an object");
	const runtime = extensionRuntime ?? connection.extensionRuntime;
	const resultType = result.resultType;

	if (connectionUsesLegacyCompatibility(connection)) {
		if (resultType !== undefined && resultType !== "complete") {
			const validator = runtime?.acceptedResultTypeValidator(connection, method, resultType);
			if (validator) {
				const error = validator(result);
				if (error) {
					throw new MCPInputRequiredMalformedError(
						method,
						`invalid extension resultType "${resultType}": ${error}`,
					);
				}
				return;
			}
			throw new MCPInputRequiredMalformedError(method, 'legacy resultType must be absent or "complete"');
		}
		return;
	}

	if (resultType === "complete") return;

	const validator = runtime?.acceptedResultTypeValidator(connection, method, resultType);
	if (validator) {
		const error = validator(result);
		if (error) {
			throw new MCPInputRequiredMalformedError(method, `invalid extension resultType "${resultType}": ${error}`);
		}
		return;
	}

	throw new MCPInputRequiredMalformedError(method, 'modern resultType must be "complete" or "input_required"');
}

/**
 * Complete one of the three modern MRTR-enabled operations. It returns only a
 * terminal complete result; interim input_required envelopes never escape.
 */
export async function completeMCPRequest<TResult>(
	connection: MCPServerConnection,
	method: MCPMRTRMethod,
	originalParams: Record<string, unknown>,
	interaction: MCPHostInteraction | undefined,
	options?: MCPRequestOptions,
): Promise<TResult> {
	const base = { ...originalParams };
	if (!MRTR_METHODS.has(method)) {
		throw new MCPInputRequiredMalformedError(method as MCPMRTRMethod, "operation is not MRTR-enabled");
	}
	let retry: Record<string, unknown> = {};
	let round = 0;

	for (;;) {
		throwIfAborted(options?.signal);
		let value: unknown;
		try {
			value = await requestFromConnection<unknown>(connection, method, { ...base, ...retry }, options);
		} catch (error) {
			if (round > 0) throw new MCPInputRequiredRetryError(method, error);
			throw error;
		}

		if (!isInputRequiredResult(value)) {
			assertCompleteMCPResult(method, connection, value, options?.extensionRuntime);
			return value as TResult;
		}
		if (connection.protocol?.era !== "modern") {
			throw new MCPInputRequiredMalformedError(method, "input_required is only valid for modern connections");
		}
		const inputRequired = value;
		if (inputRequired.requestState !== undefined && typeof inputRequired.requestState !== "string") {
			throw new MCPInputRequiredMalformedError(method, "requestState must be a string");
		}
		if (round >= MCP_MAX_INPUT_REQUIRED_ROUNDS) {
			throw new MCPInputRequiredRoundsExceededError(method, MCP_MAX_INPUT_REQUIRED_ROUNDS);
		}
		const advertisedCapabilities = connection.protocol.clientCapabilities;
		const requests = parseInputRequests(method, inputRequired.inputRequests);
		if (!requests && inputRequired.requestState === undefined) {
			throw new MCPInputRequiredMalformedError(method, "inputRequests or requestState is required");
		}
		if (requests && Object.keys(requests).length === 0 && inputRequired.requestState === undefined) {
			throw new MCPInputRequiredMalformedError(method, "inputRequests must not be empty");
		}
		round += 1;

		if (!requests || Object.keys(requests).length === 0) {
			retry = { requestState: inputRequired.requestState! };
			continue;
		}
		if (!interaction) {
			throw new MCPInputRequestUnsupportedError(method, "no host interaction policy is installed");
		}
		assertSupportedInputRequests(method, advertisedCapabilities, requests);
		const policyParams = freezeInteractionValue(structuredClone(base));
		const policyInputRequired = freezeInteractionValue(structuredClone(inputRequired));
		let responses: MCPInputResponses;
		try {
			responses = await untilAborted(options?.signal, () =>
				interaction.collectInput({
					connection,
					method,
					originalParams: policyParams,
					round,
					inputRequired: policyInputRequired,
					signal: options?.signal,
				}),
			);
		} catch (error) {
			if (options?.signal?.aborted) throw error;
			throw new MCPInputRequiredRetryError(method, error);
		}
		throwIfAborted(options?.signal);
		assertInputResponses(method, responses, requests);
		retry = {
			inputResponses: responses,
			...(inputRequired.requestState === undefined ? {} : { requestState: inputRequired.requestState }),
		};
	}
}
/** Sends an era-decorated notification for future connection-level callers. */
export async function notifyFromConnection(
	connection: MCPServerConnection,
	method: string,
	params?: Record<string, unknown>,
	options?: MCPRequestOptions,
): Promise<void> {
	await connection.transport.notify(method, buildConnectionRequestParams(connection, params, options?.metadata));
}

/**
 * Intersect a requested modern listener filter with the exact notification
 * flags advertised by `server/discover`.
 */
export function getSupportedMCPSubscriptionFilter(
	connection: MCPServerConnection,
	requested: MCPSubscriptionNotificationFilter,
): MCPSubscriptionNotificationFilter {
	const protocol = connection.protocol;
	if (protocol?.era !== "modern") return {};

	const capabilities = protocol.capabilities;
	const supported: MCPSubscriptionNotificationFilter = {};
	if (requested.toolsListChanged === true && capabilities.tools?.listChanged === true) {
		supported.toolsListChanged = true;
	}
	if (requested.promptsListChanged === true && capabilities.prompts?.listChanged === true) {
		supported.promptsListChanged = true;
	}
	if (requested.resourcesListChanged === true && capabilities.resources?.listChanged === true) {
		supported.resourcesListChanged = true;
	}
	if (capabilities.resources?.subscribe === true && requested.resourceSubscriptions) {
		const resourceSubscriptions = [...new Set(requested.resourceSubscriptions)];
		if (resourceSubscriptions.length > 0) supported.resourceSubscriptions = resourceSubscriptions;
	}
	return supported;
}

/**
 * Open a modern listener only when the negotiated descriptor advertises at
 * least one requested notification type. Capability absence is a non-error.
 */
export async function listenToNotifications(
	connection: MCPServerConnection,
	requested: MCPSubscriptionNotificationFilter,
	options?: MCPListenOptions,
): Promise<MCPListenHandle | undefined> {
	const notifications = getSupportedMCPSubscriptionFilter(connection, requested);
	if (!hasMCPSubscriptionNotifications(notifications)) return undefined;
	return connection.transport.listen?.({ notifications }, options);
}

function isModernHttpConnection(connection: MCPServerConnection): boolean {
	return connection.protocol?.era === "modern" && connection.config.type === "http";
}

/**
 * Validates tool header annotations at the protocol boundary. Modern HTTP
 * excludes invalid annotated tools as required by the specification; stdio
 * retains them but receives only validated metadata because it may ignore the
 * annotation extension entirely.
 */
async function registerModernToolHeaderMetadata(
	connection: MCPServerConnection,
	tools: MCPToolDefinition[],
): Promise<MCPToolDefinition[]> {
	if (connection.protocol?.era !== "modern") return tools;

	const validTools: MCPToolDefinition[] = [];
	const metadata: MCPToolHeaderMetadata[] = [];
	for (const tool of tools) {
		const validation = validateMCPToolHeaderMetadata(tool);
		if (!validation.valid) {
			if (isModernHttpConnection(connection)) {
				logger.warn("Rejected MCP tool with invalid x-mcp-header annotation", {
					tool: tool.name,
					reason: validation.reason,
				});
				continue;
			}
			validTools.push(tool);
			continue;
		}
		validTools.push(tool);
		if (validation.metadata.parameters.length > 0) metadata.push(validation.metadata);
	}

	await connection.transport.registerToolHeaderMetadata?.(metadata);
	return validTools;
}

type MCPListCacheSlot = "tools" | "resources" | "resourceTemplates" | "prompts";

function connectionUsesLegacyCompatibility(connection: MCPServerConnection): boolean {
	return connection.protocol?.era !== "modern";
}

function usesDefaultConnectionCacheKey(
	connection: MCPServerConnection,
	options: MCPRequestOptions | undefined,
): boolean {
	// Legacy request decoration ignores MCPRequestOptions.metadata. For modern
	// requests, any custom metadata changes the request params/cache key; this
	// single-entry cache conservatively bypasses such calls.
	return connectionUsesLegacyCompatibility(connection) || Object.keys(options?.metadata ?? {}).length === 0;
}

/**
 * Reads the active transport authentication revision without exposing
 * credentials to connection state. Invalid or unavailable values disable
 * private-cache reuse when the transport opted into this hook.
 */
function getAuthenticationContextRevision(
	connection: MCPServerConnection,
): MCPAuthenticationContextRevision | undefined {
	try {
		const revision = connection.transport.getAuthenticationContextRevision?.();
		return typeof revision === "number" && Number.isSafeInteger(revision) && revision >= 0 ? revision : undefined;
	} catch {
		return undefined;
	}
}

function bindPrivateCacheHint(connection: MCPServerConnection, hint: MCPResultCacheHint): MCPResultCacheHint {
	if (
		hint.era !== "modern" ||
		hint.cacheScope !== "private" ||
		!connection.transport.getAuthenticationContextRevision
	) {
		return hint;
	}

	const authenticationContextRevision = getAuthenticationContextRevision(connection);
	return authenticationContextRevision === undefined ? hint : { ...hint, authenticationContextRevision };
}

function isConnectionResultCacheFresh(connection: MCPServerConnection, hint: MCPResultCacheHint | undefined): boolean {
	if (!hint || !isMCPResultCacheFresh(hint)) return false;
	if (
		hint.era !== "modern" ||
		hint.cacheScope !== "private" ||
		!connection.transport.getAuthenticationContextRevision
	) {
		return true;
	}
	const authenticationContextRevision = getAuthenticationContextRevision(connection);
	return (
		authenticationContextRevision !== undefined &&
		hint.authenticationContextRevision === authenticationContextRevision
	);
}

function setConnectionResultHint(
	connection: MCPServerConnection,
	slot: MCPListCacheSlot,
	hint: MCPResultCacheHint,
): MCPResultCacheHint {
	const boundHint = bindPrivateCacheHint(connection, hint);
	connection.resultHints ??= {};
	connection.resultHints[slot] = boundHint;
	return boundHint;
}

function getFreshListValue<T>(
	connection: MCPServerConnection,
	slot: MCPListCacheSlot,
	value: T[] | undefined,
): T[] | undefined {
	if (value === undefined) return undefined;
	if (isConnectionResultCacheFresh(connection, connection.resultHints?.[slot])) return value;
	return undefined;
}

/** Explicitly invalidate one projected list and its retained freshness policy. */
export function invalidateMCPConnectionListCache(connection: MCPServerConnection, slot: MCPListCacheSlot): void {
	switch (slot) {
		case "tools":
			connection.tools = undefined;
			break;
		case "resources":
			connection.resources = undefined;
			break;
		case "resourceTemplates":
			connection.resourceTemplates = undefined;
			break;
		case "prompts":
			connection.prompts = undefined;
			break;
	}
	if (connection.resultHints) connection.resultHints[slot] = undefined;
}

/** Invalidate one URI-keyed modern resources/read snapshot. */
export function invalidateMCPConnectionResourceReadCache(connection: MCPServerConnection, uri: string): void {
	connection.resourceReads?.delete(uri);
	connection.resultHints?.resourceReads?.delete(uri);
}

async function fetchCacheableList<T>(
	connection: MCPServerConnection,
	operation: "tools/list" | "resources/list" | "resources/templates/list" | "prompts/list",
	readItems: (result: Record<string, unknown>) => unknown,
	options?: MCPRequestOptions,
): Promise<{ items: T[]; hint: MCPResultCacheHint }> {
	const items: T[] = [];
	const legacyPages: Array<{ value: unknown; receivedAt: number; requestCursor?: string }> = [];
	let modernHint: MCPModernResultCacheHint | undefined;
	let cursor: string | undefined;
	const seenCursors = new Set<string>();

	do {
		const params: Record<string, unknown> = {};
		if (cursor !== undefined) params.cursor = cursor;

		const value = await requestFromConnection<unknown>(connection, operation, params, options);
		const receivedAt = Date.now();
		if (connectionUsesLegacyCompatibility(connection)) {
			legacyPages.push({
				value,
				receivedAt,
				...(cursor !== undefined ? { requestCursor: cursor } : {}),
			});
		} else {
			modernHint = mergeMCPModernResultCacheHints(
				modernHint,
				validateMCPModernCacheableResult(operation, value, receivedAt, cursor),
			);
		}

		const result = asRecord(value);
		if (!result) throw new Error(`Invalid MCP ${operation} result: expected an object`);
		if (
			connectionUsesLegacyCompatibility(connection) &&
			result.resultType !== undefined &&
			result.resultType !== "complete"
		) {
			throw new Error(`Invalid legacy MCP ${operation} result: unsupported resultType`);
		}
		const pageItems = readItems(result);
		if (!Array.isArray(pageItems)) {
			throw new Error(`Invalid MCP ${operation} result: expected a list payload`);
		}
		items.push(...(pageItems as T[]));

		const nextCursor = result.nextCursor;
		if (nextCursor !== undefined && typeof nextCursor !== "string") {
			throw new Error(`Invalid MCP ${operation} result: nextCursor must be a string`);
		}
		if (nextCursor !== undefined) {
			if (seenCursors.has(nextCursor)) {
				throw new Error(`Invalid MCP ${operation} result: repeated pagination cursor`);
			}
			seenCursors.add(nextCursor);
		}

		cursor = nextCursor;
	} while (cursor !== undefined);

	const hint = connectionUsesLegacyCompatibility(connection)
		? createMCPLegacyResultCacheHint(operation, legacyPages)
		: modernHint;
	if (!hint) throw new Error(`Invalid MCP ${operation} result: no response pages`);
	return { items, hint };
}

/**
 * List tools from a connected server.
 */
export async function listTools(
	connection: MCPServerConnection,
	options?: MCPRequestOptions,
): Promise<MCPToolDefinition[]> {
	if (!connection.capabilities.tools) return [];
	const cacheEligible = usesDefaultConnectionCacheKey(connection, options);

	if (cacheEligible) {
		const cached = getFreshListValue(connection, "tools", connection.tools);
		if (cached) return cached;
		connection.tools = undefined;
	}

	const { items, hint } = await fetchCacheableList<MCPToolDefinition>(
		connection,
		"tools/list",
		result => result.tools,
		options,
	);
	let storedHint: MCPResultCacheHint | undefined;
	if (cacheEligible) storedHint = setConnectionResultHint(connection, "tools", hint);

	// Modern HTTP keeps only valid x-mcp-header annotations and hands their
	// normalized extraction paths to the transport. Legacy behavior is unchanged.
	const registeredTools = await registerModernToolHeaderMetadata(connection, items);
	if (cacheEligible && isConnectionResultCacheFresh(connection, storedHint)) connection.tools = registeredTools;
	return registeredTools;
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
	const params: MCPToolCallParams = {
		name: toolName,
		arguments: args,
	};
	const result = await requestFromConnection<MCPToolCallResult>(
		connection,
		"tools/call",
		params as unknown as Record<string, unknown>,
		options,
	);
	if (connection.protocol?.era === "modern" && isInputRequiredResult(result)) {
		throw new MCPInputRequestUnsupportedError("tools/call", "direct callTool cannot complete input_required results");
	}
	return result;
}

/** Call a tool and complete any explicitly host-approved MRTR interaction rounds. */
export async function callToolWithMRTR(
	connection: MCPServerConnection,
	toolName: string,
	args: Record<string, unknown> = {},
	interaction?: MCPHostInteraction,
	options?: MCPRequestOptions,
): Promise<MCPToolCallResult> {
	return completeMCPRequest<MCPToolCallResult>(
		connection,
		"tools/call",
		{ name: toolName, arguments: args },
		interaction,
		options,
	);
}

/**
 * Disconnect from a server.
 */
export async function disconnectServer(connection: MCPServerConnection): Promise<void> {
	await connection.transport.close();
}

/**
 * Check if a server supports tools.
 */
export function serverSupportsTools(capabilities: MCPNormalizedServerCapabilities): boolean {
	return capabilities.tools !== undefined;
}

/** Check if a server explicitly advertises argument completion. */
export function serverSupportsCompletions(capabilities: MCPNormalizedServerCapabilities): boolean {
	return capabilities.completions !== undefined;
}

function validateMCPCompletionResult(connection: MCPServerConnection, value: unknown): MCPCompletionResult {
	const result = asRecord(value);
	const completion = asRecord(result?.completion);
	if (
		!result ||
		!completion ||
		!Array.isArray(completion.values) ||
		completion.values.some(value => typeof value !== "string")
	) {
		throw new Error("Invalid MCP completion/complete result: completion.values must be an array of strings");
	}
	const total = completion.total;
	if (total !== undefined && (typeof total !== "number" || !Number.isSafeInteger(total) || total < 0)) {
		throw new Error("Invalid MCP completion/complete result: completion.total must be a non-negative safe integer");
	}
	if (completion.hasMore !== undefined && typeof completion.hasMore !== "boolean") {
		throw new Error("Invalid MCP completion/complete result: completion.hasMore must be a boolean");
	}
	if (connectionUsesLegacyCompatibility(connection)) {
		if (result.resultType !== undefined && result.resultType !== "complete") {
			throw new Error("Invalid legacy MCP completion/complete result: unsupported resultType");
		}
	} else if (result.resultType !== "complete") {
		throw new Error('Invalid modern MCP completion/complete result: resultType must be "complete"');
	}
	return value as MCPCompletionResult;
}

/**
 * Complete one prompt or resource-template argument when the server advertises
 * the optional completions capability. Capability absence is not an error.
 */
export async function complete(
	connection: MCPServerConnection,
	ref: MCPCompletionReference,
	argument: MCPCompletionArgument,
	context?: MCPCompletionContext,
	options?: MCPRequestOptions,
): Promise<MCPCompletionResult | undefined> {
	if (!serverSupportsCompletions(connection.capabilities)) return undefined;
	const params: MCPCompleteParams = { ref, argument, ...(context === undefined ? {} : { context }) };
	const value = await requestFromConnection<unknown>(
		connection,
		"completion/complete",
		params as unknown as Record<string, unknown>,
		options,
	);
	return validateMCPCompletionResult(connection, value);
}

/** Complete one argument while routing request-scoped progress to the supplied handler. */
export async function completeWithProgress(
	connection: MCPServerConnection,
	ref: MCPCompletionReference,
	argument: MCPCompletionArgument,
	registry: MCPProgressRegistry,
	onProgress: MCPProgressHandler,
	context?: MCPCompletionContext,
	options?: MCPRequestOptions,
): Promise<MCPCompletionResult | undefined> {
	if (!serverSupportsCompletions(connection.capabilities)) return undefined;
	const params: MCPCompleteParams = { ref, argument, ...(context === undefined ? {} : { context }) };
	const value = await requestFromConnectionWithProgress<unknown>(
		connection,
		"completion/complete",
		params as unknown as Record<string, unknown>,
		registry,
		onProgress,
		options,
	);
	return validateMCPCompletionResult(connection, value);
}

/**
 * List resources from a connected server.
 */
export async function listResources(
	connection: MCPServerConnection,
	options?: MCPRequestOptions,
): Promise<MCPResource[]> {
	if (!connection.capabilities.resources) return [];
	const cacheEligible = usesDefaultConnectionCacheKey(connection, options);

	if (cacheEligible) {
		const cached = getFreshListValue(connection, "resources", connection.resources);
		if (cached) return cached;
		connection.resources = undefined;
	}

	const { items, hint } = await fetchCacheableList<MCPResource>(
		connection,
		"resources/list",
		result => result.resources,
		options,
	);
	const storedHint = cacheEligible ? setConnectionResultHint(connection, "resources", hint) : undefined;
	if (cacheEligible && isConnectionResultCacheFresh(connection, storedHint)) connection.resources = items;
	return items;
}

/** True when an error is a JSON-RPC "method not found" (-32601) response. */
function isMethodNotFoundError(error: unknown): boolean {
	const message = error instanceof Error ? error.message : String(error);
	return message.includes("-32601") || /method not found/i.test(message);
}

/**
 * List resource templates from a connected server.
 *
 * A server MAY advertise the `resources` capability without implementing the
 * optional `resources/templates/list` method (it is optional in the MCP spec).
 * Such servers reject the request with JSON-RPC -32601 ("Method not found").
 * Treat that as "no templates" and return `[]` rather than throwing — otherwise
 * a caller that loads resources and templates together (see `MCPManager`'s
 * `Promise.all([listResources, listResourceTemplates])`) would discard the
 * server's concrete resources too. Any other error still propagates.
 */
export async function listResourceTemplates(
	connection: MCPServerConnection,
	options?: MCPRequestOptions,
): Promise<MCPResourceTemplate[]> {
	if (!connection.capabilities.resources) return [];
	const cacheEligible = usesDefaultConnectionCacheKey(connection, options);

	if (cacheEligible) {
		const cached = getFreshListValue(connection, "resourceTemplates", connection.resourceTemplates);
		if (cached) return cached;
		connection.resourceTemplates = undefined;
	}

	try {
		const { items, hint } = await fetchCacheableList<MCPResourceTemplate>(
			connection,
			"resources/templates/list",
			result => result.resourceTemplates,
			options,
		);
		const storedHint = cacheEligible ? setConnectionResultHint(connection, "resourceTemplates", hint) : undefined;
		if (cacheEligible && isConnectionResultCacheFresh(connection, storedHint)) connection.resourceTemplates = items;
		return items;
	} catch (error) {
		// Preserve the established -32601 compatibility only for an explicitly
		// negotiated initialize-era connection. Modern/unknown connections return
		// [] for this access but do not retain an uncertain negative cache entry.
		if (isMethodNotFoundError(error)) {
			if (cacheEligible && connectionUsesLegacyCompatibility(connection)) {
				const hint = createMCPLegacyResultCacheHint("resources/templates/list", [
					{ value: {}, receivedAt: Date.now() },
				]);
				setConnectionResultHint(connection, "resourceTemplates", hint);
				connection.resourceTemplates = [];
			}
			return [];
		}
		throw error;
	}
}

/**
 * Read a resource from a connected server.
 */
export async function readResource(
	connection: MCPServerConnection,
	uri: string,
	options?: MCPRequestOptions,
): Promise<MCPResourceReadResult> {
	const cacheEligible = usesDefaultConnectionCacheKey(connection, options);
	if (cacheEligible) {
		const cached = connection.resourceReads?.get(uri);
		const cachedHint = connection.resultHints?.resourceReads?.get(uri);
		if (cached && isConnectionResultCacheFresh(connection, cachedHint)) return cached;
		connection.resourceReads?.delete(uri);
	}

	const params: MCPResourceReadParams = { uri };
	const value = await requestFromConnection<unknown>(
		connection,
		"resources/read",
		params as unknown as Record<string, unknown>,
		options,
	);
	const result = asRecord(value);
	if (!result || !Array.isArray(result.contents)) {
		throw new Error("Invalid MCP resources/read result: contents must be an array");
	}
	if (connectionUsesLegacyCompatibility(connection)) {
		if (result.resultType !== undefined && result.resultType !== "complete") {
			throw new Error("Invalid legacy MCP resources/read result: unsupported resultType");
		}
		// Legacy reads were never cached; retain that compatibility behavior.
		return value as MCPResourceReadResult;
	}

	const hint = validateMCPModernCacheableResult("resources/read", value);
	if (cacheEligible) {
		const storedHint = bindPrivateCacheHint(connection, hint);
		connection.resultHints ??= {};
		connection.resultHints.resourceReads ??= new Map();
		connection.resultHints.resourceReads.set(uri, storedHint);
		if (isConnectionResultCacheFresh(connection, storedHint)) {
			connection.resourceReads ??= new Map();
			connection.resourceReads.set(uri, value as MCPResourceReadResult);
		}
	}
	return value as MCPResourceReadResult;
}

/** Read a resource and complete any explicitly host-approved MRTR interaction rounds. */
export async function readResourceWithMRTR(
	connection: MCPServerConnection,
	uri: string,
	interaction?: MCPHostInteraction,
	options?: MCPRequestOptions,
): Promise<MCPResourceReadResult> {
	const cacheEligible = usesDefaultConnectionCacheKey(connection, options);
	if (cacheEligible) {
		const cached = connection.resourceReads?.get(uri);
		const cachedHint = connection.resultHints?.resourceReads?.get(uri);
		if (cached && isConnectionResultCacheFresh(connection, cachedHint)) return cached;
		connection.resourceReads?.delete(uri);
	}

	const value = await completeMCPRequest<MCPResourceReadResult>(
		connection,
		"resources/read",
		{ uri },
		interaction,
		options,
	);
	if (!Array.isArray(value.contents)) {
		throw new MCPInputRequiredMalformedError("resources/read", "complete result contents must be an array");
	}
	if (connectionUsesLegacyCompatibility(connection)) return value;

	const hint = validateMCPModernCacheableResult("resources/read", value);
	if (cacheEligible) {
		const storedHint = bindPrivateCacheHint(connection, hint);
		connection.resultHints ??= {};
		connection.resultHints.resourceReads ??= new Map();
		connection.resultHints.resourceReads.set(uri, storedHint);
		if (isConnectionResultCacheFresh(connection, storedHint)) {
			connection.resourceReads ??= new Map();
			connection.resourceReads.set(uri, value);
		}
	}
	return value;
}

/**
 * Subscribe to resource update notifications.
 */
export async function subscribeToResources(
	connection: MCPServerConnection,
	uris: string[],
	options?: MCPRequestOptions,
): Promise<void> {
	if (connection.protocol?.era !== "legacy" || uris.length === 0 || !connection.capabilities.resources?.subscribe)
		return;
	const results = await Promise.allSettled(
		uris.map(uri => {
			const params: MCPResourceSubscribeParams = { uri };
			return requestFromConnection(
				connection,
				"resources/subscribe",
				params as unknown as Record<string, unknown>,
				options,
			);
		}),
	);
	for (const result of results) {
		if (result.status === "rejected") {
			logger.warn("Failed to subscribe to MCP resource", { error: result.reason });
		}
	}
}

/**
 * Unsubscribe from resource update notifications.
 */
export async function unsubscribeFromResources(
	connection: MCPServerConnection,
	uris: string[],
	options?: MCPRequestOptions,
): Promise<void> {
	if (connection.protocol?.era !== "legacy" || uris.length === 0 || !connection.capabilities.resources?.subscribe)
		return;
	const results = await Promise.allSettled(
		uris.map(uri => {
			const params: MCPResourceSubscribeParams = { uri };
			return requestFromConnection(
				connection,
				"resources/unsubscribe",
				params as unknown as Record<string, unknown>,
				options,
			);
		}),
	);
	for (const result of results) {
		if (result.status === "rejected") {
			logger.warn("Failed to unsubscribe from MCP resource", { error: result.reason });
		}
	}
}

/**
 * Check if a server supports resource subscriptions.
 */
export function serverSupportsResourceSubscriptions(capabilities: MCPNormalizedServerCapabilities): boolean {
	return capabilities.resources?.subscribe === true;
}

/**
 * Check if a server supports resources.
 */
export function serverSupportsResources(capabilities: MCPNormalizedServerCapabilities): boolean {
	return capabilities.resources !== undefined;
}

/**
 * List prompts from a connected server.
 */
export async function listPrompts(connection: MCPServerConnection, options?: MCPRequestOptions): Promise<MCPPrompt[]> {
	if (!connection.capabilities.prompts) return [];
	const cacheEligible = usesDefaultConnectionCacheKey(connection, options);

	if (cacheEligible) {
		const cached = getFreshListValue(connection, "prompts", connection.prompts);
		if (cached) return cached;
		connection.prompts = undefined;
	}

	const { items, hint } = await fetchCacheableList<MCPPrompt>(
		connection,
		"prompts/list",
		result => result.prompts,
		options,
	);
	const storedHint = cacheEligible ? setConnectionResultHint(connection, "prompts", hint) : undefined;
	if (cacheEligible && isConnectionResultCacheFresh(connection, storedHint)) connection.prompts = items;
	return items;
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
	const params: MCPGetPromptParams = { name };
	if (args && Object.keys(args).length > 0) {
		params.arguments = args;
	}

	const value = await requestFromConnection<unknown>(
		connection,
		"prompts/get",
		params as unknown as Record<string, unknown>,
		options,
	);
	const result = asRecord(value);
	if (!result || !Array.isArray(result.messages)) {
		throw new Error("Invalid MCP prompts/get result: messages must be an array");
	}
	if (connectionUsesLegacyCompatibility(connection)) {
		if (result.resultType !== undefined && result.resultType !== "complete") {
			throw new Error("Invalid legacy MCP prompts/get result: unsupported resultType");
		}
	} else if (result.resultType !== "complete") {
		throw new Error('Invalid modern MCP prompts/get result: resultType must be "complete"');
	}
	// prompts/get is not one of the protocol's cacheable operations.
	return value as MCPGetPromptResult;
}

/** Get a prompt and complete any explicitly host-approved MRTR interaction rounds. */
export async function getPromptWithMRTR(
	connection: MCPServerConnection,
	name: string,
	args: Record<string, string> | undefined,
	interaction?: MCPHostInteraction,
	options?: MCPRequestOptions,
): Promise<MCPGetPromptResult> {
	const params: Record<string, unknown> = { name };
	if (args && Object.keys(args).length > 0) params.arguments = args;
	const value = await completeMCPRequest<MCPGetPromptResult>(connection, "prompts/get", params, interaction, options);
	if (!Array.isArray(value.messages)) {
		throw new MCPInputRequiredMalformedError("prompts/get", "complete result messages must be an array");
	}
	return value;
}

/**
 * Check if a server supports prompts.
 */
export function serverSupportsPrompts(capabilities: MCPNormalizedServerCapabilities): boolean {
	return capabilities.prompts !== undefined;
}
