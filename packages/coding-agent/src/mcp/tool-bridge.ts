/**
 * MCP to CustomTool bridge.
 *
 * Converts MCP tool definitions to CustomTool format for the agent.
 */
import type { AgentToolUpdateCallback } from "@pk-nerdsaver-ai/pi-agent-core";
import type { TSchema } from "@pk-nerdsaver-ai/pi-ai";
import { normalizeSchemaForMCP } from "@pk-nerdsaver-ai/pi-ai/utils/schema";
import { untilAborted } from "@pk-nerdsaver-ai/pi-utils";
import { INTENT_FIELD } from "@pk-nerdsaver-ai/pi-wire";
import type { SourceMeta } from "../capability/types";
import type {
	CustomTool,
	CustomToolContext,
	CustomToolResult,
	RenderResultOptions,
} from "../extensibility/custom-tools/types";
import type { Theme } from "../modes/theme/theme";
import type { OutputMeta } from "../tools/output-meta";
import { ToolAbortError, throwIfAborted } from "../tools/tool-errors";
import { callToolWithMRTR } from "./client";
import { validateMCPStructuredContent } from "./output-schema-validator";
import { formatMCPJsonValue, formatMCPStructuredContent, renderMCPCall, renderMCPResult } from "./render";
import type {
	MCPHostInteraction,
	MCPInputRequiredResult,
	MCPJsonValue,
	MCPServerConnection,
	MCPToolCallParams,
	MCPToolDefinition,
} from "./types";
import { MCPInputRequiredError } from "./types";

/** Reconnect callback: tears down stale connection, returns new one or null. */
export type MCPReconnect = () => Promise<MCPServerConnection | null>;

/**
 * Network-level and stale-session errors that warrant a reconnect + single retry.
 * Conservative: only catches errors where the server is likely alive but the
 * connection object is stale (dead SSE, expired session, refused after restart).
 */
const RETRIABLE_PATTERNS = [
	"econnrefused",
	"econnreset",
	"epipe",
	"enetunreach",
	"ehostunreach",
	"fetch failed",
	"transport not connected",
	"transport closed",
	"network error",
];

export function isRetriableConnectionError(error: unknown): boolean {
	if (!(error instanceof Error)) return false;
	const msg = error.message.toLowerCase();
	// Stale session (server restarted, old session ID is gone)
	if (/^http (404|502|503):/.test(msg)) return true;
	return RETRIABLE_PATTERNS.some(p => msg.includes(p));
}

type MCPToolArgs = NonNullable<MCPToolCallParams["arguments"]>;

function normalizeToolArgs(value: unknown): MCPToolArgs {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return {};
	}
	return value as MCPToolArgs;
}

function isUnusedOptionalPlaceholder(value: unknown): boolean {
	return (
		value === undefined ||
		value === "" ||
		(typeof value === "object" && value !== null && !Array.isArray(value) && Object.keys(value).length === 0)
	);
}

function omitUnusedOptionalArgs(args: MCPToolArgs, inputSchema: MCPToolDefinition["inputSchema"]): MCPToolArgs {
	const properties = inputSchema.properties;
	if (!properties) return args;

	let cleaned: MCPToolArgs | undefined;
	const required = new Set(inputSchema.required ?? []);
	for (const [key, value] of Object.entries(args)) {
		if (required.has(key) || !Object.hasOwn(properties, key) || !isUnusedOptionalPlaceholder(value)) {
			continue;
		}
		cleaned ??= { ...args };
		delete cleaned[key];
	}

	return cleaned ?? args;
}

/**
 * Drop the harness-internal intent field (`INTENT_FIELD`) before forwarding
 * args to an MCP server. The harness injects `i` into every tool's wire
 * schema; the direct model tool-call path strips it via `extractIntent`, but
 * the `eval` `tool.*` bridge and any other in-process caller forwards args
 * verbatim. Strict-schema servers (Linear, anything with
 * `additionalProperties:false` / Zod `.strict()`) reject every call that
 * carries `i`. The MCP boundary is the authoritative guard so callers don't
 * have to pre-strip.
 *
 * Leaves `i` in place when the server's own `inputSchema.properties` declares
 * it, so a server that legitimately uses `i` as a parameter is unaffected.
 */
function stripHarnessIntent(args: MCPToolArgs, inputSchema: MCPToolDefinition["inputSchema"]): MCPToolArgs {
	if (!Object.hasOwn(args, INTENT_FIELD)) return args;
	if (inputSchema.properties && Object.hasOwn(inputSchema.properties, INTENT_FIELD)) return args;
	const { [INTENT_FIELD]: _intent, ...rest } = args;
	return rest;
}

/**
 * Normalize raw tool params into the outbound `tools/call` arguments: strip
 * the harness intent field, then drop optional empty placeholders the server
 * declares but doesn't require.
 */
function prepareOutboundArgs(params: unknown, inputSchema: MCPToolDefinition["inputSchema"]): MCPToolArgs {
	return omitUnusedOptionalArgs(stripHarnessIntent(normalizeToolArgs(params), inputSchema), inputSchema);
}

/** Details included in MCP tool results for rendering */
export interface MCPToolDetails {
	/** Server name */
	serverName: string;
	/** Original MCP tool name */
	mcpToolName: string;
	/** Whether the call resulted in an error */
	isError?: boolean;
	/** Raw content blocks from the MCP response, including newer standard block types. */
	rawContent?: unknown[];
	/** Advertised output schema used to validate structured content. */
	outputSchema?: MCPToolDefinition["outputSchema"];
	/** Structured output returned by the MCP server. */
	structuredContent?: MCPJsonValue;
	/** Interim MRTR state retained only for the controlled unsupported-interaction error. */
	inputRequired?: Omit<MCPInputRequiredResult, "resultType" | "_meta">;
	/** Provider ID (e.g., "claude", "mcp-json") */
	provider?: string;
	/** Provider display name (e.g., "Claude Code", "MCP Config") */
	providerName?: string;
	/** Structured output metadata (set by the spill wrapper when output is truncated to an artifact). */
	meta?: OutputMeta;
}
/**
 * Format MCP content for LLM consumption.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMCPJsonValue(value: unknown, ancestors = new WeakSet<object>()): value is MCPJsonValue {
	if (value === null || typeof value === "string" || typeof value === "boolean") return true;
	if (typeof value === "number") return Number.isFinite(value);
	if (typeof value !== "object") return false;
	if (ancestors.has(value)) return false;
	ancestors.add(value);
	try {
		if (Array.isArray(value)) return value.every(item => isMCPJsonValue(item, ancestors));
		return Object.values(value).every(item => isMCPJsonValue(item, ancestors));
	} finally {
		ancestors.delete(value);
	}
}

function formatRetainedContentBlock(label: string, item: unknown): string {
	return isMCPJsonValue(item) ? `${label}:\n${formatMCPJsonValue(item)}` : `${label}: ${String(item)}`;
}

function convertMCPContent(content: readonly unknown[]): CustomToolResult<MCPToolDetails>["content"] {
	const converted: CustomToolResult<MCPToolDetails>["content"] = [];
	for (const item of content) {
		if (!isRecord(item) || typeof item.type !== "string") {
			converted.push({ type: "text", text: formatRetainedContentBlock("MCP content block", item) });
			continue;
		}
		switch (item.type) {
			case "text":
				if (typeof item.text === "string") {
					converted.push({ type: "text", text: item.text });
				} else {
					converted.push({ type: "text", text: formatRetainedContentBlock("Invalid MCP text block", item) });
				}
				break;
			case "image":
				if (typeof item.data === "string" && typeof item.mimeType === "string") {
					converted.push({ type: "image", data: item.data, mimeType: item.mimeType });
				} else {
					converted.push({ type: "text", text: formatRetainedContentBlock("Invalid MCP image block", item) });
				}
				break;
			case "audio":
				converted.push({ type: "text", text: formatRetainedContentBlock("Audio content", item) });
				break;
			case "resource":
				converted.push({ type: "text", text: formatRetainedContentBlock("Embedded resource", item) });
				break;
			case "resource_link":
				converted.push({ type: "text", text: formatRetainedContentBlock("Resource link", item) });
				break;
			default:
				converted.push({ type: "text", text: formatRetainedContentBlock("MCP content block", item) });
				break;
		}
	}
	return converted;
}

function buildModelContent(
	contentBlocks: readonly unknown[],
	structuredContent: MCPJsonValue | undefined,
): CustomToolResult<MCPToolDetails>["content"] {
	const content = convertMCPContent(contentBlocks);
	if (structuredContent !== undefined) {
		content.push({ type: "text", text: formatMCPStructuredContent(structuredContent) });
	}
	if (content.length === 0) {
		content.push({ type: "text", text: "" });
	}
	return content;
}

async function buildResult(
	resultValue: unknown,
	isModernConnection: boolean,
	serverName: string,
	mcpToolName: string,
	outputSchema?: MCPToolDefinition["outputSchema"],
	provider?: string,
	providerName?: string,
): Promise<CustomToolResult<MCPToolDetails>> {
	if (!isRecord(resultValue)) {
		return {
			content: [{ type: "text", text: "MCP protocol error: tools/call returned a non-object result." }],
			details: { serverName, mcpToolName, isError: true, outputSchema, provider, providerName },
			isError: true,
		};
	}

	if (resultValue.resultType === "input_required") {
		const inputRequired: MCPToolDetails["inputRequired"] = {
			requestState: typeof resultValue.requestState === "string" ? resultValue.requestState : undefined,
			inputRequests: isRecord(resultValue.inputRequests)
				? (resultValue.inputRequests as MCPInputRequiredResult["inputRequests"])
				: undefined,
		};
		return {
			content: [
				{
					type: "text",
					text:
						"MCP protocol error: this tool requires client interaction, but MCP input-required host interaction " +
						"is not implemented. Retry after the host can collect and return the requested input.",
				},
			],
			details: {
				serverName,
				mcpToolName,
				isError: true,
				outputSchema,
				inputRequired,
				provider,
				providerName,
			},
			isError: true,
		};
	}

	const resultType = resultValue.resultType;
	const invalidResultType = isModernConnection
		? resultType !== "complete"
		: resultType !== undefined && resultType !== "complete";
	if (invalidResultType) {
		const received =
			resultType === undefined ? "missing resultType" : `unknown resultType ${JSON.stringify(resultType)}`;
		return {
			content: [
				{
					type: "text",
					text: `MCP protocol error: tools/call returned ${received}; ${
						isModernConnection
							? 'modern responses must use resultType "complete" or "input_required"'
							: "the result is not complete"
					}.`,
				},
			],
			details: {
				serverName,
				mcpToolName,
				isError: true,
				rawContent: Array.isArray(resultValue.content) ? resultValue.content : undefined,
				outputSchema,
				provider,
				providerName,
			},
			isError: true,
		};
	}

	const contentBlocks = Array.isArray(resultValue.content) ? resultValue.content : [];
	const rawStructuredContent = resultValue.structuredContent;
	const structuredContent =
		rawStructuredContent === undefined || isMCPJsonValue(rawStructuredContent) ? rawStructuredContent : undefined;
	const details: MCPToolDetails = {
		serverName,
		mcpToolName,
		isError: resultValue.isError === true,
		rawContent: contentBlocks,
		outputSchema,
		structuredContent,
		provider,
		providerName,
	};
	const invalidStructuredContent =
		rawStructuredContent !== undefined && structuredContent === undefined
			? "structuredContent is not a valid JSON value"
			: undefined;
	const validationError =
		invalidStructuredContent ?? (await validateMCPStructuredContent(outputSchema, structuredContent));
	if (validationError) {
		return {
			content: [
				{ type: "text", text: `MCP protocol error: ${validationError}` },
				...buildModelContent(contentBlocks, structuredContent),
			],
			details: { ...details, isError: true },
			isError: true,
		};
	}

	const toolResult: CustomToolResult<MCPToolDetails> = {
		content: buildModelContent(contentBlocks, structuredContent),
		details,
	};
	if (resultValue.isError === true) {
		toolResult.isError = true;
	}
	return toolResult;
}

/** Build an error CustomToolResult from a caught exception. */
function buildErrorResult(
	error: unknown,
	serverName: string,
	mcpToolName: string,
	outputSchema?: MCPToolDefinition["outputSchema"],
	provider?: string,
	providerName?: string,
): CustomToolResult<MCPToolDetails> {
	const message = error instanceof Error ? error.message : String(error);
	return {
		content: [{ type: "text", text: `MCP error: ${message}` }],
		details: { serverName, mcpToolName, isError: true, outputSchema, provider, providerName },
		isError: true,
	};
}

/** Re-throw abort-related errors so they bypass error-result handling. */
function rethrowIfAborted(error: unknown, signal?: AbortSignal): void {
	if (error instanceof ToolAbortError) throw error;
	if (error instanceof Error && error.name === "AbortError") throw new ToolAbortError();
	if (signal?.aborted) throwIfAborted(signal);
}

async function reconnectWithAbort(reconnect: MCPReconnect, signal?: AbortSignal): Promise<MCPServerConnection | null> {
	try {
		return await untilAborted(signal, reconnect);
	} catch (error) {
		rethrowIfAborted(error, signal);
		return null;
	}
}

/**
 * Create a unique tool name for an MCP tool.
 *
 * Prefixes with server name to avoid conflicts. If the tool name already
 * starts with the server name (e.g., server "puppeteer" with tool
 * "puppeteer_screenshot"), strips the redundant prefix to produce
 * "mcp__puppeteer_screenshot" instead of "mcp__puppeteer_puppeteer_screenshot".
 */
function sanitizeMCPToolNamePart(value: string, fallback: string): string {
	const sanitized = value
		.toLowerCase()
		.replace(/[^a-z_]+/g, "_")
		.replace(/_+/g, "_")
		.replace(/^_+|_+$/g, "");

	return sanitized.length > 0 ? sanitized : fallback;
}

export function createMCPToolName(serverName: string, toolName: string): string {
	const sanitizedServerName = sanitizeMCPToolNamePart(serverName, "server");
	const sanitizedToolName = sanitizeMCPToolNamePart(toolName, "tool");

	// Strip redundant server name prefix from tool name if present
	const prefixWithUnderscore = `${sanitizedServerName}_`;

	let normalizedToolName = sanitizedToolName;
	if (sanitizedToolName.startsWith(prefixWithUnderscore)) {
		normalizedToolName = sanitizedToolName.slice(prefixWithUnderscore.length);
	}

	return `mcp__${sanitizedServerName}_${normalizedToolName}`;
}

/**
 * Parse an MCP tool name back to server and tool components.
 *
 * Note: This returns the normalized tool name (with server prefix stripped).
 * The original MCP tool name may have had the server name as a prefix.
 */
export function parseMCPToolName(name: string): { serverName: string; toolName: string } | null {
	if (!name.startsWith("mcp__")) return null;

	const rest = name.slice(5);
	const underscoreIdx = rest.indexOf("_");
	if (underscoreIdx === -1) return null;

	return {
		serverName: rest.slice(0, underscoreIdx),
		toolName: rest.slice(underscoreIdx + 1),
	};
}

export interface ComposedSignalResult {
	signal?: AbortSignal;
	cleanup: () => void;
}

/**
 * Compose a caller-supplied signal with a bridge lifecycle/disposal signal.
 * Returns the merged signal (or one of the signals if only one is active)
 * and a cleanup function to remove event listeners when execution finishes.
 */
export function composeSignals(callerSignal?: AbortSignal, disposalSignal?: AbortSignal): ComposedSignalResult {
	if (!callerSignal && !disposalSignal) {
		return { cleanup: () => {} };
	}
	if (!callerSignal) {
		return { signal: disposalSignal, cleanup: () => {} };
	}
	if (!disposalSignal) {
		return { signal: callerSignal, cleanup: () => {} };
	}
	if (callerSignal.aborted) {
		return { signal: callerSignal, cleanup: () => {} };
	}
	if (disposalSignal.aborted) {
		return { signal: disposalSignal, cleanup: () => {} };
	}

	const controller = new AbortController();

	const onCallerAbort = () => {
		try {
			controller.abort(callerSignal.reason);
		} catch {
			controller.abort();
		}
	};

	const onDisposalAbort = () => {
		try {
			controller.abort(disposalSignal.reason);
		} catch {
			controller.abort();
		}
	};

	callerSignal.addEventListener("abort", onCallerAbort, { once: true });
	disposalSignal.addEventListener("abort", onDisposalAbort, { once: true });

	const cleanup = () => {
		callerSignal.removeEventListener("abort", onCallerAbort);
		disposalSignal.removeEventListener("abort", onDisposalAbort);
	};

	return {
		signal: controller.signal,
		cleanup,
	};
}

/**
 * CustomTool wrapping an MCP tool with an active connection.
 */
export class MCPTool implements CustomTool<TSchema, MCPToolDetails> {
	readonly name: string;
	readonly label: string;
	readonly description: string;
	readonly parameters: TSchema;
	/** Advertised schema for structured tool output. */
	readonly outputSchema: MCPToolDefinition["outputSchema"];
	/** Original MCP tool name (before normalization) */
	readonly mcpToolName: string;
	/** Server name */
	readonly mcpServerName: string;
	readonly approval = "write" as const;
	/** Render completed MCP calls with the result header replacing the pending call header. */
	readonly mergeCallAndResult = true;

	/** Create MCPTool instances for all tools from an MCP server connection */
	readonly #disposalController = new AbortController();

	/** Create MCPTool instances for all tools from an MCP server connection */
	static fromTools(
		connection: MCPServerConnection,
		tools: MCPToolDefinition[],
		reconnect?: MCPReconnect,
		hostInteraction?: MCPHostInteraction,
		disposalSignal?: AbortSignal,
	): MCPTool[] {
		return tools.map(tool => new MCPTool(connection, tool, reconnect, hostInteraction, disposalSignal));
	}

	constructor(
		private connection: MCPServerConnection,
		private readonly tool: MCPToolDefinition,
		private readonly reconnect?: MCPReconnect,
		private readonly hostInteraction?: MCPHostInteraction,
		disposalSignal?: AbortSignal,
	) {
		this.name = createMCPToolName(connection.name, tool.name);
		this.label = `${connection.name}/${tool.name}`;
		this.description = tool.description ?? `MCP tool from ${connection.name}`;
		this.parameters = normalizeSchemaForMCP(tool.inputSchema) as TSchema;
		this.mcpToolName = tool.name;
		this.outputSchema = tool.outputSchema;
		this.mcpServerName = connection.name;

		if (disposalSignal) {
			if (disposalSignal.aborted) {
				this.#disposalController.abort(disposalSignal.reason);
			} else {
				disposalSignal.addEventListener(
					"abort",
					() => {
						this.#disposalController.abort(disposalSignal.reason);
					},
					{ once: true },
				);
			}
		}
	}

	/** Dispose this tool bridge instance, aborting any active executions or interactions. */
	dispose(): void {
		if (!this.#disposalController.signal.aborted) {
			this.#disposalController.abort(new ToolAbortError("MCP tool disposed"));
		}
	}

	get disposalSignal(): AbortSignal {
		return this.#disposalController.signal;
	}

	renderCall(args: unknown, _options: RenderResultOptions, theme: Theme) {
		return renderMCPCall(normalizeToolArgs(args), theme, this.label);
	}

	renderResult(result: CustomToolResult<MCPToolDetails>, options: RenderResultOptions, theme: Theme, args?: unknown) {
		return renderMCPResult(result, options, theme, normalizeToolArgs(args));
	}

	async execute(
		_toolCallId: string,
		params: unknown,
		_onUpdate: AgentToolUpdateCallback<MCPToolDetails> | undefined,
		_ctx: CustomToolContext,
		signal?: AbortSignal,
	): Promise<CustomToolResult<MCPToolDetails>> {
		const { signal: mergedSignal, cleanup } = composeSignals(signal, this.#disposalController.signal);
		try {
			throwIfAborted(mergedSignal);
			const args = prepareOutboundArgs(params, this.tool.inputSchema);
			const provider = this.connection._source?.provider;
			const providerName = this.connection._source?.providerName;

			try {
				const result = await callToolWithMRTR(this.connection, this.tool.name, args, this.hostInteraction, {
					signal: mergedSignal,
				});
				return await buildResult(
					result,
					this.connection.protocol?.era === "modern",
					this.connection.name,
					this.tool.name,
					this.outputSchema,
					provider,
					providerName,
				);
			} catch (error) {
				rethrowIfAborted(error, mergedSignal);
				if (this.reconnect && !(error instanceof MCPInputRequiredError) && isRetriableConnectionError(error)) {
					const newConn = await reconnectWithAbort(this.reconnect, mergedSignal);
					if (newConn) {
						// Rebind so subsequent calls on this instance use the fresh connection
						this.connection = newConn;
						const retryProvider = newConn._source?.provider ?? provider;
						const retryProviderName = newConn._source?.providerName ?? providerName;
						try {
							const result = await callToolWithMRTR(newConn, this.tool.name, args, this.hostInteraction, {
								signal: mergedSignal,
							});
							return await buildResult(
								result,
								newConn.protocol?.era === "modern",
								newConn.name,
								this.tool.name,
								this.outputSchema,
								retryProvider,
								retryProviderName,
							);
						} catch (retryError) {
							rethrowIfAborted(retryError, mergedSignal);
							return buildErrorResult(
								retryError,
								this.connection.name,
								this.tool.name,
								this.outputSchema,
								retryProvider,
								retryProviderName,
							);
						}
					}
				}
				return buildErrorResult(
					error,
					this.connection.name,
					this.tool.name,
					this.outputSchema,
					provider,
					providerName,
				);
			}
		} finally {
			cleanup();
		}
	}
}

/**
 * CustomTool wrapping an MCP tool with deferred connection resolution.
 */
export class DeferredMCPTool implements CustomTool<TSchema, MCPToolDetails> {
	readonly name: string;
	readonly label: string;
	readonly description: string;
	readonly parameters: TSchema;
	/** Advertised schema for structured tool output. */
	readonly outputSchema: MCPToolDefinition["outputSchema"];
	/** Original MCP tool name (before normalization) */
	readonly mcpToolName: string;
	/** Server name */
	readonly mcpServerName: string;
	readonly approval = "write" as const;
	/** Render completed MCP calls with the result header replacing the pending call header. */
	readonly mergeCallAndResult = true;

	readonly #getConnection: () => Promise<MCPServerConnection>;
	readonly #reconnect: MCPReconnect | undefined;
	readonly #hostInteraction: MCPHostInteraction | undefined;
	readonly #fallbackProvider: string | undefined;
	readonly #fallbackProviderName: string | undefined;

	/** Create DeferredMCPTool instances for all tools from an MCP server */
	readonly #disposalController = new AbortController();

	/** Create DeferredMCPTool instances for all tools from an MCP server */
	static fromTools(
		serverName: string,
		tools: MCPToolDefinition[],
		getConnection: () => Promise<MCPServerConnection>,
		source?: SourceMeta,
		reconnect?: MCPReconnect,
		hostInteraction?: MCPHostInteraction,
		disposalSignal?: AbortSignal,
	): DeferredMCPTool[] {
		return tools.map(
			tool =>
				new DeferredMCPTool(serverName, tool, getConnection, source, reconnect, hostInteraction, disposalSignal),
		);
	}

	constructor(
		readonly serverName: string,
		readonly tool: MCPToolDefinition,
		getConnection: () => Promise<MCPServerConnection>,
		source?: SourceMeta,
		reconnect?: MCPReconnect,
		hostInteraction?: MCPHostInteraction,
		disposalSignal?: AbortSignal,
	) {
		this.#getConnection = getConnection;
		this.#reconnect = reconnect;
		this.#hostInteraction = hostInteraction;
		this.name = createMCPToolName(serverName, tool.name);
		this.label = `${serverName}/${tool.name}`;
		this.description = tool.description ?? `MCP tool from ${serverName}`;
		this.parameters = normalizeSchemaForMCP(tool.inputSchema) as TSchema;
		this.outputSchema = tool.outputSchema;
		this.mcpToolName = tool.name;
		this.mcpServerName = serverName;
		this.#fallbackProvider = source?.provider;
		this.#fallbackProviderName = source?.providerName;

		if (disposalSignal) {
			if (disposalSignal.aborted) {
				this.#disposalController.abort(disposalSignal.reason);
			} else {
				disposalSignal.addEventListener(
					"abort",
					() => {
						this.#disposalController.abort(disposalSignal.reason);
					},
					{ once: true },
				);
			}
		}
	}

	/** Dispose this tool bridge instance, aborting any active executions or interactions. */
	dispose(): void {
		if (!this.#disposalController.signal.aborted) {
			this.#disposalController.abort(new ToolAbortError("MCP tool disposed"));
		}
	}

	get disposalSignal(): AbortSignal {
		return this.#disposalController.signal;
	}

	renderCall(args: unknown, _options: RenderResultOptions, theme: Theme) {
		return renderMCPCall(normalizeToolArgs(args), theme, this.label);
	}

	renderResult(result: CustomToolResult<MCPToolDetails>, options: RenderResultOptions, theme: Theme, args?: unknown) {
		return renderMCPResult(result, options, theme, normalizeToolArgs(args));
	}

	async execute(
		_toolCallId: string,
		params: unknown,
		_onUpdate: AgentToolUpdateCallback<MCPToolDetails> | undefined,
		_ctx: CustomToolContext,
		signal?: AbortSignal,
	): Promise<CustomToolResult<MCPToolDetails>> {
		const { signal: mergedSignal, cleanup } = composeSignals(signal, this.#disposalController.signal);
		try {
			throwIfAborted(mergedSignal);
			const args = prepareOutboundArgs(params, this.tool.inputSchema);
			const provider = this.#fallbackProvider;
			const providerName = this.#fallbackProviderName;

			try {
				const connection = await untilAborted(mergedSignal, () => this.#getConnection());
				throwIfAborted(mergedSignal);
				try {
					const result = await callToolWithMRTR(connection, this.tool.name, args, this.#hostInteraction, {
						signal: mergedSignal,
					});
					return await buildResult(
						result,
						connection.protocol?.era === "modern",
						this.serverName,
						this.tool.name,
						this.outputSchema,
						connection._source?.provider ?? provider,
						connection._source?.providerName ?? providerName,
					);
				} catch (callError) {
					rethrowIfAborted(callError, mergedSignal);
					if (
						this.#reconnect &&
						!(callError instanceof MCPInputRequiredError) &&
						isRetriableConnectionError(callError)
					) {
						const newConn = await reconnectWithAbort(this.#reconnect, mergedSignal);
						if (newConn) {
							const retryProvider = newConn._source?.provider ?? provider;
							const retryProviderName = newConn._source?.providerName ?? providerName;
							try {
								const result = await callToolWithMRTR(newConn, this.tool.name, args, this.#hostInteraction, {
									signal: mergedSignal,
								});
								return await buildResult(
									result,
									newConn.protocol?.era === "modern",
									this.serverName,
									this.tool.name,
									this.outputSchema,
									retryProvider,
									retryProviderName,
								);
							} catch (retryError) {
								rethrowIfAborted(retryError, mergedSignal);
								return buildErrorResult(
									retryError,
									this.serverName,
									this.tool.name,
									this.outputSchema,
									retryProvider,
									retryProviderName,
								);
							}
						}
					}
					return buildErrorResult(
						callError,
						this.serverName,
						this.tool.name,
						this.outputSchema,
						provider,
						providerName,
					);
				}
			} catch (connError) {
				// getConnection() failed — server never connected or connection lost.
				// This is always worth a reconnect attempt for deferred tools, since the
				// error ("MCP server not connected") isn't a network error from callTool.
				rethrowIfAborted(connError, mergedSignal);
				if (this.#reconnect) {
					const newConn = await reconnectWithAbort(this.#reconnect, mergedSignal);
					if (newConn) {
						try {
							const result = await callToolWithMRTR(newConn, this.tool.name, args, this.#hostInteraction, {
								signal: mergedSignal,
							});
							return await buildResult(
								result,
								newConn.protocol?.era === "modern",
								this.serverName,
								this.tool.name,
								this.outputSchema,
								newConn._source?.provider ?? provider,
								newConn._source?.providerName ?? providerName,
							);
						} catch (retryError) {
							rethrowIfAborted(retryError, mergedSignal);
							return buildErrorResult(
								retryError,
								this.serverName,
								this.tool.name,
								this.outputSchema,
								provider,
								providerName,
							);
						}
					}
				}
				return buildErrorResult(
					connError,
					this.serverName,
					this.tool.name,
					this.outputSchema,
					provider,
					providerName,
				);
			}
		} finally {
			cleanup();
		}
	}
}
