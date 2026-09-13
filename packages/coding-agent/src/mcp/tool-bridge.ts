/**
 * MCP to CustomTool bridge.
 *
 * Converts MCP tool definitions to CustomTool format for the agent.
 */
import type { AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import type { ImageContent, TextContent, TSchema } from "@oh-my-pi/pi-ai";
import { normalizeSchemaForMCP } from "@oh-my-pi/pi-ai/utils/schema";
import { logger, untilAborted } from "@oh-my-pi/pi-utils";
import { INTENT_FIELD } from "@oh-my-pi/pi-wire";
import type { SourceMeta } from "../capability/types";
import type {
	CustomTool,
	CustomToolContext,
	CustomToolResult,
	RenderResultOptions,
} from "../extensibility/custom-tools/types";
import { resolveLocalUrlToFile } from "../internal-urls/local-protocol";
import type { Theme } from "../modes/theme/theme";
import { sanitizeMCPToolNamePart } from "../tools/builtin-names";
import type { OutputMeta } from "../tools/output-meta";
import { normalizeLocalScheme } from "../tools/path-utils";
import { ToolAbortError, throwIfAborted } from "../tools/tool-errors";
import { schemaDeclaresIntentField } from "../utils/tool-schema";

export { sanitizeMCPToolNamePart };
import { callTool } from "./client";
import { formatMCPToolFailure, MCPTransportError } from "./errors";
import { renderMCPCall, renderMCPResult } from "./render";
import type {
	MCPAuthChallenge,
	MCPContent,
	MCPServerConnection,
	MCPToolCallParams,
	MCPToolCallResult,
	MCPToolDefinition,
} from "./types";

/** Reconnect callback: tears down a stale connection, optionally authorizing first. */
export type MCPReconnect = (options?: { authChallenge?: MCPAuthChallenge }) => Promise<MCPServerConnection | null>;

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
	if (error instanceof MCPTransportError) {
		if (
			error.failure === "connect" ||
			error.failure === "reset" ||
			error.failure === "eof" ||
			error.failure === "closed"
		) {
			return error.retryable;
		}
		return error.failure === "http_status" && (error.code === 404 || error.code === 502 || error.code === 503);
	}
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
 * Leaves `i` in place when the server's own input schema declares or
 * constrains it, so legitimate tool data is not discarded at forwarding.
 */
function stripHarnessIntent(args: MCPToolArgs, inputSchema: MCPToolDefinition["inputSchema"]): MCPToolArgs {
	if (!Object.hasOwn(args, INTENT_FIELD)) return args;
	if (schemaDeclaresIntentField(inputSchema)) return args;
	const { [INTENT_FIELD]: _intent, ...rest } = args;
	return rest;
}

async function resolveOutboundLocalUrlArgs(
	value: unknown,
	context: CustomToolContext,
	seen: WeakSet<object> = new WeakSet(),
): Promise<unknown> {
	if (typeof value === "string") {
		const normalized = normalizeLocalScheme(value);
		if (!normalized.startsWith("local://")) return value;
		const localFile = await resolveLocalUrlToFile(normalized, {
			cwd: context.sessionManager?.getCwd?.(),
			settings: context.settings,
			localProtocolOptions: context.localProtocolOptions,
		});
		return localFile?.path ?? value;
	}
	if (typeof value !== "object" || value === null) return value;
	if (seen.has(value)) return value;
	seen.add(value);

	if (Array.isArray(value)) {
		let resolved: unknown[] | undefined;
		for (let index = 0; index < value.length; index++) {
			const item = value[index];
			const next = await resolveOutboundLocalUrlArgs(item, context, seen);
			if (next === item && !resolved) continue;
			resolved ??= value.slice();
			resolved[index] = next;
		}
		return resolved ?? value;
	}

	const input = value as Record<string, unknown>;
	let resolved: Record<string, unknown> | undefined;
	for (const key in input) {
		const item = input[key];
		const next = await resolveOutboundLocalUrlArgs(item, context, seen);
		if (next === item && !resolved) continue;
		resolved ??= { ...input };
		resolved[key] = next;
	}
	return resolved ?? value;
}

/**
 * Normalize raw tool params into the outbound `tools/call` arguments: strip
 * the harness intent field, drop optional empty placeholders the server
 * declares but doesn't require, then translate session-local files to paths
 * external MCP servers can read.
 */
async function prepareOutboundArgs(
	params: unknown,
	inputSchema: MCPToolDefinition["inputSchema"],
	context: CustomToolContext,
): Promise<MCPToolArgs> {
	const args = omitUnusedOptionalArgs(stripHarnessIntent(normalizeToolArgs(params), inputSchema), inputSchema);
	return (await resolveOutboundLocalUrlArgs(args, context)) as MCPToolArgs;
}

/** Details included in MCP tool results for rendering */
export interface MCPToolDetails {
	/** Server name */
	serverName: string;
	/** Original MCP tool name */
	mcpToolName: string;
	/** Whether the call resulted in an error */
	isError?: boolean;
	/** Raw content from MCP response */
	rawContent?: MCPContent[];
	/** Structured metadata from the MCP response */
	mcpMeta?: Record<string, unknown>;
	/** Provider ID (e.g., "claude", "mcp-json") */
	provider?: string;
	/** Provider display name (e.g., "Claude Code", "MCP Config") */
	providerName?: string;
	/** Structured output metadata (set by the spill wrapper when output is truncated to an artifact). */
	meta?: OutputMeta;
}
/**
 * Convert MCP content to agent content while retaining image payloads.
 */
function formatMCPContent(content: MCPContent[]): Array<TextContent | ImageContent> {
	const blocks: Array<TextContent | ImageContent> = [];
	let text = "";
	const flushText = () => {
		if (!text) return;
		blocks.push({ type: "text", text });
		text = "";
	};
	const appendText = (value: string) => {
		text += text ? `\n\n${value}` : value;
	};

	for (const item of content) {
		switch (item.type) {
			case "text":
				appendText(item.text);
				break;
			case "image":
				flushText();
				blocks.push(item);
				break;
			case "resource":
				appendText(
					item.resource.text
						? `[Resource: ${item.resource.uri}]\n${item.resource.text}`
						: `[Resource: ${item.resource.uri}]`,
				);
				break;
		}
	}
	flushText();
	return blocks.length > 0 ? blocks : [{ type: "text", text: "" }];
}

/**
 * Serialize an MCP result's structured payload as a fenced JSON block so it
 * reaches the model through the standard content channel — and the eval
 * `tool.*` and subagent proxy bridges that read the same result. Subject to the
 * usual spill/byte-cap machinery like any other text block.
 */
function formatStructuredContent(structured: Record<string, unknown>): string {
	let json: string;
	try {
		json = JSON.stringify(structured, null, 2);
	} catch {
		return "";
	}
	return `\`\`\`json\n${json}\n\`\`\``;
}

/**
 * True when a text block already carries the structured payload verbatim. A
 * spec-compliant server duplicates `structuredContent` into a TextContent block
 * for back-compat; detecting that avoids emitting the JSON twice.
 */
function structuredContentAlreadyInText(structured: Record<string, unknown>, content: MCPContent[]): boolean {
	for (const item of content) {
		if (item.type !== "text") continue;
		const trimmed = item.text.trim();
		if (trimmed.length === 0) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(trimmed);
		} catch {
			continue;
		}
		if (Bun.deepEquals(parsed, structured)) return true;
	}
	return false;
}

/** Build a CustomToolResult from a callTool response. */
function buildResult(
	result: MCPToolCallResult,
	serverName: string,
	mcpToolName: string,
	provider?: string,
	providerName?: string,
): CustomToolResult<MCPToolDetails> {
	const content = formatMCPContent(result.content);
	const details: MCPToolDetails = {
		serverName,
		mcpToolName,
		isError: result.isError,
		rawContent: result.content,
		mcpMeta: result._meta,
		provider,
		providerName,
	};
	if (result.isError) {
		if (content[0]?.type === "text") {
			content[0] = { type: "text", text: `Error: ${content[0].text}` };
		} else {
			content.unshift({ type: "text", text: "Error:" });
		}
	}
	const structured = result.structuredContent;
	if (structured !== undefined && !structuredContentAlreadyInText(structured, result.content)) {
		const rendered = formatStructuredContent(structured);
		if (rendered.length > 0) {
			content.push({ type: "text", text: rendered });
		}
	}
	const toolResult: CustomToolResult<MCPToolDetails> = { content, details };
	if (result.isError) {
		toolResult.isError = true;
	}
	return toolResult;
}

/** Build an error CustomToolResult from a caught exception. */
function buildErrorResult(
	error: unknown,
	serverName: string,
	mcpToolName: string,
	provider?: string,
	providerName?: string,
): CustomToolResult<MCPToolDetails> {
	const message = formatMCPToolFailure(error, serverName, mcpToolName);
	return {
		content: [{ type: "text", text: message }],
		details: { serverName, mcpToolName, isError: true, provider, providerName },
		isError: true,
	};
}

type MCPToolCallAttempt = {
	connection: MCPServerConnection;
	result?: MCPToolCallResult;
	error?: unknown;
};

function getMcpAuthChallenge(result: MCPToolCallResult): MCPAuthChallenge | undefined {
	if (!result.isError) return undefined;
	const values = result._meta?.["mcp/www_authenticate"];
	if (!Array.isArray(values)) return undefined;
	const wwwAuthenticate = values.filter((value): value is string => typeof value === "string" && value.trim() !== "");
	return wwwAuthenticate.length > 0 ? { wwwAuthenticate } : undefined;
}

async function callToolWithAuthRetry(
	connection: MCPServerConnection,
	toolName: string,
	args: MCPToolArgs,
	reconnect: MCPReconnect | undefined,
	signal?: AbortSignal,
): Promise<MCPToolCallAttempt> {
	const result = await callTool(connection, toolName, args, { signal });
	const authChallenge = getMcpAuthChallenge(result);
	if (!authChallenge || !reconnect) return { connection, result };

	let newConnection: MCPServerConnection | null;
	try {
		newConnection = await reconnectWithAbort(reconnect, signal, { authChallenge });
	} catch (error) {
		rethrowIfAborted(error, signal);
		return { connection, error };
	}
	if (!newConnection) return { connection, result };

	try {
		return {
			connection: newConnection,
			result: await callTool(newConnection, toolName, args, { signal }),
		};
	} catch (error) {
		rethrowIfAborted(error, signal);
		return { connection: newConnection, error };
	}
}

/** Re-throw abort-related errors so they bypass error-result handling. */
function rethrowIfAborted(error: unknown, signal?: AbortSignal): void {
	if (error instanceof ToolAbortError) throw error;
	if (error instanceof Error && error.name === "AbortError") throw new ToolAbortError();
	if (signal?.aborted) throw new ToolAbortError();
}

async function reconnectWithAbort(
	reconnect: MCPReconnect,
	signal?: AbortSignal,
	options?: { authChallenge?: MCPAuthChallenge },
): Promise<MCPServerConnection | null> {
	try {
		return await untilAborted(signal, () => reconnect(options));
	} catch (error) {
		rethrowIfAborted(error, signal);
		return null;
	}
}

/** Registry prefix every minted MCP tool name carries. */
const MCP_TOOL_NAME_PREFIX = "mcp__";

/**
 * Longest tool name strict validators accept. OpenAI Responses/Completions and
 * Meta Responses enforce `^[a-zA-Z0-9_-]{1,64}$`; names over 64 chars are
 * rejected with HTTP 400 `name must be at most 64 characters` (#9130).
 */
const MAX_MCP_TOOL_NAME_LENGTH = 64;
/** Length of the deterministic hash suffix appended when a minted name overflows. */
const MCP_TOOL_NAME_HASH_LENGTH = 8;

/**
 * Cap a minted MCP tool name at {@link MAX_MCP_TOOL_NAME_LENGTH}. An overlong
 * name keeps a readable prefix and gains a deterministic base-36 hash suffix of
 * the full name, so distinct long names stay unique and the same name is stable
 * across turns — the model must call the exact registry key, and the hash is
 * seed-fixed so it never shifts between processes.
 */
function capMCPToolNameLength(name: string): string {
	if (name.length <= MAX_MCP_TOOL_NAME_LENGTH) return name;
	const hash = Bun.hash(name).toString(36).slice(0, MCP_TOOL_NAME_HASH_LENGTH);
	const keep = MAX_MCP_TOOL_NAME_LENGTH - hash.length - 1;
	return `${name.slice(0, keep)}_${hash}`;
}

/**
 * Create a unique tool name for an MCP tool.
 *
 * Prefixes with server name to avoid conflicts. If the tool name already
 * starts with the server name (e.g., server "puppeteer" with tool
 * "puppeteer_screenshot"), strips the redundant prefix to produce
 * "mcp__puppeteer_screenshot" instead of "mcp__puppeteer_puppeteer_screenshot".
 */
export function createMCPToolName(serverName: string, toolName: string): string {
	const sanitizedServerName = sanitizeMCPToolNamePart(serverName, "server");
	const sanitizedToolName = sanitizeMCPToolNamePart(toolName, "tool");

	// Strip redundant server name prefix from tool name if present
	const prefixWithUnderscore = `${sanitizedServerName}_`;

	let normalizedToolName = sanitizedToolName;
	if (sanitizedToolName.startsWith(prefixWithUnderscore)) {
		normalizedToolName = sanitizedToolName.slice(prefixWithUnderscore.length);
	}

	return capMCPToolNameLength(`${MCP_TOOL_NAME_PREFIX}${sanitizedServerName}_${normalizedToolName}`);
}

/**
 * Registry keys a model-emitted MCP tool name may have meant, in priority
 * order. Empty when the name is not `mcp__`-prefixed or is already canonical.
 *
 * {@link createMCPToolName} joins the sanitized server and tool with a SINGLE
 * underscore, but OMP presents itself as Claude Code, whose convention is
 * `mcp__<server>__<tool>` — so a primed model reliably emits the doubled
 * separator, often keeping the raw unsanitized server spelling as well
 * (`mcp__seedpatch-client__bank` for a server named `seedpatch-client`). Those
 * names are strictly unregistered, so dispatch dead-ends on a tool the session
 * really does expose.
 *
 * Candidates, because the doubled separator carries information the collapsed
 * form loses:
 *
 * 1. Split at a `__` and re-mint through the whole of `createMCPToolName`.
 *    Re-minting (rather than only sanitizing) is what reproduces
 *    redundant-server-prefix stripping — server `puppeteer` + tool
 *    `puppeteer_screenshot` registers as `mcp__puppeteer_screenshot`, not
 *    `mcp__puppeteer_puppeteer_screenshot` — and the 64-char
 *    {@link capMCPToolNameLength} hash. EVERY `__` is tried as the boundary:
 *    a *sanitized* server segment can never contain one, but the model
 *    routinely emits the RAW server name, which can (`foo__bar`), so the first
 *    occurrence is not necessarily the split. Earlier boundaries rank first
 *    since a server name without `__` is overwhelmingly the common case.
 * 2. Sanitize the whole suffix, for a single-separator name whose punctuation
 *    still differs from the minted key (`mcp__seedpatch-client_bank`). This
 *    candidate is capped too: without a boundary there is nothing to re-mint,
 *    but the registered key was still length-capped, so an overlong spelling
 *    would otherwise never match its hashed form. Unlike a split, it has no
 *    minted fallback shape to reproduce, so a suffix that sanitizes away yields
 *    nothing.
 *
 * This is normalization, not fuzzy matching: every candidate is derived from
 * the emitted name by the same rules that minted the registry, never selected
 * from siblings. `sanitizeMCPToolNamePart` is idempotent and registry keys are
 * already in its output form, so an already-registered name yields no
 * candidates at all and stays on the exact-match path. Callers try each
 * candidate as an exact lookup and keep failing when none is registered.
 */
export function canonicalMCPToolNameCandidates(name: string): string[] {
	if (!name.startsWith(MCP_TOOL_NAME_PREFIX)) return [];
	const suffix = name.slice(MCP_TOOL_NAME_PREFIX.length);
	if (suffix.length === 0) return [];
	const candidates: string[] = [];
	const add = (candidate: string): void => {
		if (candidate !== name && !candidates.includes(candidate)) candidates.push(candidate);
	};

	// A split needs both halves NONEMPTY — not to survive sanitization.
	// `createMCPToolName` substitutes its `server`/`tool` placeholder for a part
	// that sanitizes away, and it is the same function registration uses, so a
	// server named `123` (valid per `validateServerName`) really does register as
	// `mcp__server_bank`. Re-minting therefore reproduces that key instead of
	// inventing one, and requiring the halves to survive sanitization would drop
	// exactly the names that need recovering. Only a genuinely absent half
	// (`mcp____bank`, `mcp__srv__`) describes no split at all.
	for (let boundary = suffix.indexOf("__"); boundary >= 0; boundary = suffix.indexOf("__", boundary + 1)) {
		const serverName = suffix.slice(0, boundary);
		const toolName = suffix.slice(boundary + 2);
		if (serverName.length > 0 && toolName.length > 0) add(createMCPToolName(serverName, toolName));
	}
	// The whole-suffix candidate has no boundary, so there is no minted fallback
	// shape to reproduce: a suffix that sanitizes away is a dead end.
	const sanitizedSuffix = sanitizeMCPToolNamePart(suffix, "");
	if (sanitizedSuffix.length > 0) {
		add(capMCPToolNameLength(`${MCP_TOOL_NAME_PREFIX}${sanitizedSuffix}`));
	}
	return candidates;
}

/**
 * Resolve a Claude Code-spelled MCP call through an EXPLICIT lookup.
 *
 * The lookup is a required argument rather than something read from ambient
 * state, because the set a call must resolve against is the one offered to the
 * agent that emitted it. A resolver closing over one agent's tools and then
 * shared with another — the primary session's resolver also handed to the
 * isolated auto-learn capture agent, say — would let a capture response reach a
 * main-session tool it was never offered. Naming the source at every call site
 * makes that mistake unrepresentable.
 *
 * A caller whose tools span several presentation sets (mounted `xd://` devices
 * plus advertised top-level tools) MUST pass one lookup covering the union.
 * Checking each set with its own call and taking the first hit would let set
 * order silently break the uniqueness rule below.
 *
 * Resolution requires a UNIQUE match. Two different boundaries can both name a
 * registered tool — server `foo` + tool `bar__foo_bar_baz` and server
 * `foo__bar` + tool `foo_bar_baz` mint distinct keys yet share the spelling
 * `mcp__foo__bar__foo_bar_baz` — and nothing in the emitted name says which was
 * meant. Picking whichever boundary sorts first would execute an MCP operation
 * the model did not ask for, side effects included, so an ambiguous alias
 * resolves to nothing and the call stays a recoverable `not found`.
 *
 * Returns `undefined` unless exactly one {@link canonicalMCPToolNameCandidates}
 * entry resolves, so an already-registered name never reaches here and a
 * non-MCP name can never resolve at all.
 */
export function resolveMCPToolAlias<T extends { readonly name: string }>(
	name: string,
	lookup: (candidate: string) => T | undefined,
): T | undefined {
	const matches: T[] = [];
	for (const candidate of canonicalMCPToolNameCandidates(name)) {
		const match = lookup(candidate);
		if (match !== undefined && !matches.some(seen => seen.name === match.name)) matches.push(match);
	}
	return matches.length === 1 ? matches[0] : undefined;
}

export interface MCPToolOriginSource {
	readonly name: string;
	readonly mcpServerName?: unknown;
	readonly mcpToolName?: unknown;
}

/** Stable identity for a tool's original MCP route, before its public name was normalized. */
export function getMCPToolOriginKey(tool: MCPToolOriginSource): string | undefined {
	if (typeof tool.mcpServerName !== "string" || typeof tool.mcpToolName !== "string") return undefined;
	return `${tool.mcpServerName}\u0000${tool.mcpToolName}`;
}

/**
 * Keeps one MCP tool per minted name and logs collisions between distinct MCP
 * origins. The winner is chosen by a stable origin key (server name + original
 * tool name), NOT array order: MCPManager re-appends a reconnecting server's
 * tools, so insertion order is mutable across reconnects and first-wins would
 * silently flip ownership of the minted name. Non-MCP tools pass through
 * unchanged.
 */
export function deduplicateMCPToolsByName<T extends MCPToolOriginSource>(tools: readonly T[]): T[] {
	const deduplicated: T[] = [];
	const registered = new Map<string, { tool: T; originKey: string; index: number }>();

	for (const tool of tools) {
		const originKey = getMCPToolOriginKey(tool);
		if (originKey === undefined) {
			deduplicated.push(tool);
			continue;
		}
		const existing = registered.get(tool.name);
		if (!existing) {
			registered.set(tool.name, { tool, originKey, index: deduplicated.length });
			deduplicated.push(tool);
			continue;
		}

		if (existing.originKey === originKey) continue;

		// Deterministic winner regardless of encounter order across reconnects.
		const keepExisting = existing.originKey < originKey;
		const winner = keepExisting ? existing.tool : tool;
		const loser = keepExisting ? tool : existing.tool;
		if (!keepExisting) {
			deduplicated[existing.index] = tool;
			existing.tool = tool;
			existing.originKey = originKey;
		}
		logger.warn("MCP tool name collision; keeping stable winner", {
			name: tool.name,
			keptServer: winner.mcpServerName,
			keptTool: winner.mcpToolName,
			ignoredServer: loser.mcpServerName,
			ignoredTool: loser.mcpToolName,
		});
	}

	return deduplicated;
}

/**
 * Parse an MCP tool name back to server and tool components.
 *
 * Note: This returns the normalized tool name (with server prefix stripped).
 * The original MCP tool name may have had the server name as a prefix.
 */
export function parseMCPToolName(name: string): { serverName: string; toolName: string } | null {
	if (!name.startsWith(MCP_TOOL_NAME_PREFIX)) return null;

	const rest = name.slice(MCP_TOOL_NAME_PREFIX.length);
	const underscoreIdx = rest.indexOf("_");
	if (underscoreIdx === -1) return null;

	return {
		serverName: rest.slice(0, underscoreIdx),
		toolName: rest.slice(underscoreIdx + 1),
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
	/** Original MCP tool name (before normalization) */
	readonly mcpToolName: string;
	/** Server name */
	readonly mcpServerName: string;
	readonly approval = "write" as const;
	/** Render completed MCP calls with the result header replacing the pending call header. */
	readonly mergeCallAndResult = true;
	/**
	 * MCP-backed tools opt out of strict structured-output grammar. The server
	 * owns validation, and strict mode makes OpenAI-family models over-fill
	 * mutually exclusive optional fields (#4336/#4340). Serializers preserve an
	 * explicit `false`; an omitted flag would leave nothing to preserve.
	 */
	readonly strict = false as const;

	/** Create MCPTool instances for all tools from an MCP server connection */
	static fromTools(connection: MCPServerConnection, tools: MCPToolDefinition[], reconnect?: MCPReconnect): MCPTool[] {
		return tools.map(tool => new MCPTool(connection, tool, reconnect));
	}

	constructor(
		private connection: MCPServerConnection,
		private readonly tool: MCPToolDefinition,
		private readonly reconnect?: MCPReconnect,
	) {
		this.name = createMCPToolName(connection.name, tool.name);
		this.label = `${connection.name}/${tool.name}`;
		this.description = tool.description ?? `MCP tool from ${connection.name}`;
		this.parameters = normalizeSchemaForMCP(tool.inputSchema) as TSchema;
		this.mcpToolName = tool.name;
		this.mcpServerName = connection.name;
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
		throwIfAborted(signal);
		const args = await prepareOutboundArgs(params, this.tool.inputSchema, _ctx);
		const provider = this.connection._source?.provider;
		const providerName = this.connection._source?.providerName;

		try {
			const attempt = await callToolWithAuthRetry(this.connection, this.tool.name, args, this.reconnect, signal);
			if (attempt.error !== undefined) {
				return buildErrorResult(attempt.error, this.connection.name, this.tool.name, provider, providerName);
			}
			if (!attempt.result) {
				return buildErrorResult(
					new Error("MCP tool call returned no result"),
					this.connection.name,
					this.tool.name,
					provider,
					providerName,
				);
			}
			this.connection = attempt.connection;
			return buildResult(
				attempt.result,
				attempt.connection.name,
				this.tool.name,
				attempt.connection._source?.provider ?? provider,
				attempt.connection._source?.providerName ?? providerName,
			);
		} catch (error) {
			rethrowIfAborted(error, signal);
			if (this.reconnect && isRetriableConnectionError(error)) {
				const newConn = await reconnectWithAbort(this.reconnect, signal);
				if (newConn) {
					// Rebind so subsequent calls on this instance use the fresh connection
					this.connection = newConn;
					const retryProvider = newConn._source?.provider ?? provider;
					const retryProviderName = newConn._source?.providerName ?? providerName;
					try {
						const result = await callTool(newConn, this.tool.name, args, { signal });
						return buildResult(result, newConn.name, this.tool.name, retryProvider, retryProviderName);
					} catch (retryError) {
						rethrowIfAborted(retryError, signal);
						return buildErrorResult(
							retryError,
							this.connection.name,
							this.tool.name,
							retryProvider,
							retryProviderName,
						);
					}
				}
			}
			return buildErrorResult(error, this.connection.name, this.tool.name, provider, providerName);
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
	/** Original MCP tool name (before normalization) */
	readonly mcpToolName: string;
	/** Server name */
	readonly mcpServerName: string;
	readonly approval = "write" as const;
	/** Render completed MCP calls with the result header replacing the pending call header. */
	readonly mergeCallAndResult = true;
	/** See {@link MCPTool.strict}: MCP servers own validation, so stay non-strict. */
	readonly strict = false as const;

	readonly #fallbackProvider: string | undefined;
	readonly #fallbackProviderName: string | undefined;

	/** Create DeferredMCPTool instances for all tools from an MCP server */
	static fromTools(
		serverName: string,
		tools: MCPToolDefinition[],
		getConnection: () => Promise<MCPServerConnection>,
		source?: SourceMeta,
		reconnect?: MCPReconnect,
	): DeferredMCPTool[] {
		return tools.map(tool => new DeferredMCPTool(serverName, tool, getConnection, source, reconnect));
	}

	constructor(
		private readonly serverName: string,
		private readonly tool: MCPToolDefinition,
		private readonly getConnection: () => Promise<MCPServerConnection>,
		source?: SourceMeta,
		private readonly reconnect?: MCPReconnect,
	) {
		this.name = createMCPToolName(serverName, tool.name);
		this.label = `${serverName}/${tool.name}`;
		this.description = tool.description ?? `MCP tool from ${serverName}`;
		this.parameters = normalizeSchemaForMCP(tool.inputSchema) as TSchema;
		this.mcpToolName = tool.name;
		this.mcpServerName = serverName;
		this.#fallbackProvider = source?.provider;
		this.#fallbackProviderName = source?.providerName;
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
		throwIfAborted(signal);
		const args = await prepareOutboundArgs(params, this.tool.inputSchema, _ctx);
		const provider = this.#fallbackProvider;
		const providerName = this.#fallbackProviderName;

		try {
			const connection = await untilAborted(signal, () => this.getConnection());
			throwIfAborted(signal);
			try {
				const attempt = await callToolWithAuthRetry(connection, this.tool.name, args, this.reconnect, signal);
				if (attempt.error !== undefined) {
					return buildErrorResult(
						attempt.error,
						this.serverName,
						this.tool.name,
						attempt.connection._source?.provider ?? provider,
						attempt.connection._source?.providerName ?? providerName,
					);
				}
				if (!attempt.result) {
					return buildErrorResult(
						new Error("MCP tool call returned no result"),
						this.serverName,
						this.tool.name,
						provider,
						providerName,
					);
				}
				return buildResult(
					attempt.result,
					this.serverName,
					this.tool.name,
					attempt.connection._source?.provider ?? provider,
					attempt.connection._source?.providerName ?? providerName,
				);
			} catch (callError) {
				rethrowIfAborted(callError, signal);
				if (this.reconnect && isRetriableConnectionError(callError)) {
					const newConn = await reconnectWithAbort(this.reconnect, signal);
					if (newConn) {
						const retryProvider = newConn._source?.provider ?? provider;
						const retryProviderName = newConn._source?.providerName ?? providerName;
						try {
							const result = await callTool(newConn, this.tool.name, args, { signal });
							return buildResult(result, this.serverName, this.tool.name, retryProvider, retryProviderName);
						} catch (retryError) {
							rethrowIfAborted(retryError, signal);
							return buildErrorResult(
								retryError,
								this.serverName,
								this.tool.name,
								retryProvider,
								retryProviderName,
							);
						}
					}
				}
				return buildErrorResult(callError, this.serverName, this.tool.name, provider, providerName);
			}
		} catch (connError) {
			// getConnection() failed — server never connected or connection lost.
			// This is always worth a reconnect attempt for deferred tools, since the
			// error ("MCP server not connected") isn't a network error from callTool.
			rethrowIfAborted(connError, signal);
			if (this.reconnect) {
				const newConn = await reconnectWithAbort(this.reconnect, signal);
				if (newConn) {
					try {
						const result = await callTool(newConn, this.tool.name, args, { signal });
						return buildResult(
							result,
							this.serverName,
							this.tool.name,
							newConn._source?.provider ?? provider,
							newConn._source?.providerName ?? providerName,
						);
					} catch (retryError) {
						rethrowIfAborted(retryError, signal);
						return buildErrorResult(retryError, this.serverName, this.tool.name, provider, providerName);
					}
				}
			}
			return buildErrorResult(connError, this.serverName, this.tool.name, provider, providerName);
		}
	}
}
