import {
	formatMCPProgress,
	MCP_TOOL_NAME_PREFIX,
	type MCPProgress,
	type MCPToolDetails,
} from "@oh-my-pi/pi-tui/tools/mcp";
/**
 * MCP to CustomTool bridge.
 *
 * Converts MCP tool definitions to CustomTool format for the agent.
 */
import type { AgentToolUpdateCallback, ToolLoadMode } from "@oh-my-pi/pi-agent-core";
import type { ImageContent, TextContent, TSchema } from "@oh-my-pi/pi-ai";
import { normalizeSchemaForMCP } from "@oh-my-pi/pi-ai/utils/schema";
import type { Theme } from "@oh-my-pi/pi-tui/theme";
import { describeMCPCall, describeMCPResult, renderMCPCall, renderMCPResult } from "@oh-my-pi/pi-tui/tools/mcp";
import type { MCPContent } from "@oh-my-pi/pi-tui/tools/mcp";
import { isRecord, logger, untilAborted } from "@oh-my-pi/pi-utils";
import { INTENT_FIELD } from "@oh-my-pi/pi-wire";
import {
	CAPABILITY_TOOL_CALL_TOOL_NAME,
	capabilityToolCallDisplay,
	capabilityToolDisplayName,
	isCapabilityTool,
	isCapabilityWaitTool,
	isInterruptibleCapabilityWaitCall,
} from "../discovery/capability-server";
import type {
	CustomTool,
	CustomToolContext,
	CustomToolResult,
	RenderResultOptions,
} from "../extensibility/custom-tools/types";
import { extractUriScheme } from "../internal-urls/parse";
import { InternalUrlRouter } from "../internal-urls/router";
import { formatApprovalArguments } from "../tools/approval";
import { throwIfAborted, ToolAbortError } from "../tools/tool-errors";
import { schemaDeclaresIntentField } from "../utils/tool-schema";
import { callTool } from "./client";
import { isDeferredMCPServer } from "./deferred-server";
import { formatMCPToolFailure, MCPTransportError } from "./errors";
import {
	describeCapabilityJobResult,
	isCapabilityJobTool,
	renderCapabilityJobResult,
} from "@oh-my-pi/pi-tui/tools/capability-jobs";
import type {
	MCPAuthChallenge,
	MCPRequestOptions,
	MCPServerConnection,
	MCPToolCallParams,
	MCPToolCallResult,
	MCPToolDefinition,
} from "./types";

/** Options of an {@link MCPReconnect}. */
export interface MCPReconnectOptions {
	/** Authorize first: the server answered the call with this challenge. */
	authChallenge?: MCPAuthChallenge;
	/**
	 * The server refused the call because the protocol session it holds for us
	 * is gone, and the host did not replace that session itself: a
	 * handshake-era upstream has to be started anew before the retry.
	 */
	staleSession?: boolean;
}

/** Reconnect callback: brings a failed connection back, optionally authorizing first. */
export type MCPReconnect = (options?: MCPReconnectOptions) => Promise<MCPServerConnection | null>;

/**
 * Told about every MCP tool call when it starts, by tool-call id; returns the
 * callback the call awaits before it returns its result. Lets the owning
 * manager settle the tool-list changes the call provoked into the caller's view.
 */
export type MCPToolCallObserver = (toolCallId: string) => () => Promise<void>;

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
const EXPIRED_SESSION = /(?:unknown|expired|invalid) session|session (?:not found|expired|is invalid)/i;

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
		if (error.failure === "http_status" && (error.code === 404 || error.code === 502 || error.code === 503))
			return true;
		// An expired HTTP session (`-32001 Unknown or expired session`) never ran the call: re-initialize and retry.
		return isStaleSessionError(error);
	}
	const msg = error.message.toLowerCase();
	// Stale session (server restarted, old session ID is gone)
	if (/^http (404|502|503):/.test(msg)) return true;
	return RETRIABLE_PATTERNS.some(p => msg.includes(p));
}

/**
 * Whether a server refused a call because the session it held is gone. The
 * host replaces a session it sees expire and reports that as retryable; what
 * arrives here otherwise still sits in the upstream and needs a restart.
 */
function isStaleSessionError(error: unknown): error is MCPTransportError {
	return (
		error instanceof MCPTransportError &&
		(error.failure === "http_status" || error.failure === "json_rpc") &&
		EXPIRED_SESSION.test(error.message)
	);
}

/**
 * Abbreviated display facts for a capability-gateway tool: the title drops the
 * `capability/` server prefix (and the `agentmux_capability_` repeat inside the
 * tool name), and a `tool_call` is titled with the tool its `address` names,
 * showing that tool's arguments. `undefined` for non-capability servers and for
 * the background-job tools, whose rows and fallback card keep today's display.
 */
function capabilityDisplay(
	serverName: string | undefined,
	toolName: string | undefined,
	args: Record<string, unknown>,
): { label: string; args: Record<string, unknown> } | undefined {
	if (!serverName || !toolName || !isCapabilityTool(serverName)) return undefined;
	if (isCapabilityJobTool(serverName, toolName)) return undefined;
	const dispatched = toolName === CAPABILITY_TOOL_CALL_TOOL_NAME ? capabilityToolCallDisplay(args) : undefined;
	return {
		label: dispatched?.label ?? capabilityToolDisplayName(toolName),
		args: dispatched?.args ?? args,
	};
}

/**
 * The abbreviated one-line view is for successful capability results only: an
 * error keeps the verbose card so its output stays visible.
 */
function capabilityResultDisplay(
	result: { isError?: boolean } | undefined,
	details: MCPToolDetails | undefined,
	args: Record<string, unknown>,
): { label: string; args: Record<string, unknown> } | undefined {
	const isError = result?.isError ?? details?.isError ?? false;
	return isError ? undefined : capabilityDisplay(details?.serverName, details?.mcpToolName, args);
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
 * schema; the direct model tool-call path strips it via `extractIntent` and
 * the `eval` `tool.*` bridge drops it in `callSessionTool`, but other
 * in-process callers (Task proxies, `ctx.invokeTool`) may still forward args
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

/** Replace string args that are file-backed internal URLs with the local path backing them. */
async function resolveOutboundUrlArgs(
	value: unknown,
	context: CustomToolContext,
	seen: WeakSet<object> = new WeakSet(),
): Promise<unknown> {
	if (typeof value === "string") {
		// Only arguments that are themselves URLs: the router's repair of a
		// cwd-prefixed `…/local://x` path must not rewrite free text that merely
		// mentions one.
		if (!extractUriScheme(value)) return value;
		const router = InternalUrlRouter.instance();
		const url = router.normalize(value);
		if (!router.canHandle(url)) return value;
		const scheme = extractUriScheme(url);
		if (!scheme || router.spec(scheme)?.backing !== "file") return value;
		const located = await router.locate(url, {
			cwd: context.sessionManager?.getCwd?.(),
			settings: context.settings,
			localProtocolOptions: context.localProtocolOptions,
		});
		return located ?? value;
	}
	if (typeof value !== "object" || value === null) return value;
	if (seen.has(value)) return value;
	seen.add(value);

	if (Array.isArray(value)) {
		let resolved: unknown[] | undefined;
		for (let index = 0; index < value.length; index++) {
			const item = value[index];
			const next = await resolveOutboundUrlArgs(item, context, seen);
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
		const next = await resolveOutboundUrlArgs(item, context, seen);
		if (next === item && !resolved) continue;
		resolved ??= { ...input };
		resolved[key] = next;
	}
	return resolved ?? value;
}

/**
 * Normalize raw tool params into the outbound `tools/call` arguments: strip
 * the harness intent field, drop optional empty placeholders the server
 * declares but doesn't require, then translate file-backed internal URLs to paths
 * external MCP servers can read.
 */
async function prepareOutboundArgs(
	params: unknown,
	inputSchema: MCPToolDefinition["inputSchema"],
	context: CustomToolContext,
): Promise<MCPToolArgs> {
	const args = omitUnusedOptionalArgs(stripHarnessIntent(normalizeToolArgs(params), inputSchema), inputSchema);
	return (await resolveOutboundUrlArgs(args, context)) as MCPToolArgs;
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
			case "resource_link":
				appendText(`[Resource: ${item.uri}]`);
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
 * Programmatic consumers use details.structuredContent instead of parsing this rendering.
 */
function formatStructuredContent(structured: unknown): string {
	let json: string;
	try {
		json = JSON.stringify(structured, null, 2);
	} catch {
		return "";
	}
	return `\`\`\`json\n${json}\n\`\`\``;
}

/**
 * True when a trimmed text block carries a value: a verbatim string echo, or a
 * JSON block parsing to a deep-equal value. `parsed` is `undefined` when the
 * block is not JSON (`JSON.parse` never yields `undefined` itself).
 */
function textCarries(trimmed: string, parsed: unknown, value: unknown): boolean {
	return (typeof value === "string" && trimmed === value) || (parsed !== undefined && Bun.deepEquals(parsed, value));
}

/**
 * True when text already carries the structured payload. Beyond a verbatim
 * echo, this covers the MCP SDK's `{ result: value }` wrapper for non-object
 * tool returns: the SDK auto-wraps list/string returns, so `structuredContent`
 * never verbatim-matches the `content` text blocks that carry the same value.
 *
 * A partial match does NOT count: if content covers only part of the wrapped
 * payload (extra items, extra keys), the rendering is kept so the model still
 * sees the full structured result.
 *
 * Out of scope: the Python SDK's `_convert_to_content` flattens nested lists via
 * `chain.from_iterable` (`[[1,2],[3]]` → 3 blocks vs 2), drops `None` items, and
 * whitespace-padded item strings fail the verbatim comparison — those shapes still render.
 */
function structuredContentAlreadyInText(structured: unknown, content: MCPContent[]): boolean {
	const wrapped =
		isRecord(structured) && Object.hasOwn(structured, "result") && Object.keys(structured).length === 1
			? structured.result
			: undefined;
	const wrappedItems = Array.isArray(wrapped) ? wrapped : undefined;
	const blocks: Array<{ trimmed: string; parsed: unknown }> = [];
	for (const item of content) {
		if (item.type !== "text") continue;
		const trimmed = item.text.trim();
		if (trimmed.length === 0) continue;
		let parsed: unknown;
		try {
			parsed = JSON.parse(trimmed);
		} catch {
			parsed = undefined;
		}
		if (textCarries(trimmed, parsed, structured)) return true;
		if (wrapped !== undefined && textCarries(trimmed, parsed, wrapped)) return true;
		blocks.push({ trimmed, parsed });
	}
	return (
		wrappedItems !== undefined &&
		blocks.length > 0 &&
		wrappedItems.length === blocks.length &&
		wrappedItems.every((value, i) => {
			const block = blocks[i];
			return block !== undefined && value !== undefined && textCarries(block.trimmed, block.parsed, value);
		})
	);
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
	// Any JSON value is allowed. Details carry the object form their consumers
	// expect; other values reach them through the rendered text, and `null`
	// says nothing worth rendering.
	const structured = result.structuredContent;
	if (isRecord(structured)) details.structuredContent = structured;
	if (structured !== undefined && structured !== null && !structuredContentAlreadyInText(structured, result.content)) {
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

/** Minimum spacing between one call's progress updates; a burst coalesces to its newest progress. */
export const PROGRESS_UPDATE_INTERVAL_MS = 50;

interface ProgressUpdater {
	onProgress: NonNullable<MCPRequestOptions["onProgress"]>;
	/** Stop updating once the call settles; a coalesced update still waiting is dropped. */
	close(): void;
}

/**
 * Turn a call's progress notifications into tool updates. The first progress
 * shows immediately; progress inside the following interval waits and only
 * the newest is shown when it ends. Heartbeats that repeat the displayed text
 * (the same phase message) emit nothing.
 */
function progressUpdater(
	onUpdate: AgentToolUpdateCallback<MCPToolDetails> | undefined,
	serverName: string,
	mcpToolName: string,
	provider?: string,
	providerName?: string,
): ProgressUpdater | undefined {
	if (!onUpdate) return undefined;
	let lastText: string | undefined;
	let waiting: MCPProgress | undefined;
	let cooldown: NodeJS.Timeout | undefined;
	let closed = false;
	const show = (progress: MCPProgress) => {
		const text = formatMCPProgress(progress);
		if (text === lastText) return;
		lastText = text;
		onUpdate({
			content: [{ type: "text", text }],
			details: { serverName, mcpToolName, provider, providerName, progress },
		});
		cooldown = setTimeout(() => {
			cooldown = undefined;
			const next = waiting;
			waiting = undefined;
			if (next) show(next);
		}, PROGRESS_UPDATE_INTERVAL_MS);
	};
	return {
		onProgress: progress => {
			if (closed) return;
			if (cooldown) waiting = progress;
			else show(progress);
		},
		close: () => {
			closed = true;
			clearTimeout(cooldown);
			cooldown = undefined;
			waiting = undefined;
		},
	};
}

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
	onProgress?: MCPRequestOptions["onProgress"],
): Promise<MCPToolCallAttempt> {
	const result = await callTool(connection, toolName, args, { signal, onProgress });
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
			result: await callTool(newConnection, toolName, args, { signal, onProgress }),
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
	options?: MCPReconnectOptions,
): Promise<MCPServerConnection | null> {
	try {
		return await untilAborted(signal, () => reconnect(options));
	} catch (error) {
		rethrowIfAborted(error, signal);
		return null;
	}
}

// Name minting lives in ./tool-name (a settings-free leaf): session/settings
// imports it for the loop-guard exempt key without closing an init cycle.
import { capMCPToolNameLength, createLegacyMCPToolName, createMCPToolName, sanitizeMCPToolNamePart } from "./tool-name";
export { createLegacyMCPToolName, createMCPToolName, mcpToolNameParts } from "./tool-name";

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
	const sanitizedSuffix = sanitizeMCPToolNamePart(suffix, "", true);
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
 * CustomTool wrapping an MCP tool with an active connection.
 */
export class MCPTool implements CustomTool<TSchema, MCPToolDetails> {
	readonly name: string;
	/**
	 * Name this tool had before digits were kept in minted names, if different.
	 * Approval resolution honors `deny`/`prompt` user policies written against
	 * this key so the rename cannot silently unblock a restricted MCP server.
	 */
	readonly legacyName?: string;
	readonly label: string;
	readonly description: string;
	readonly parameters: TSchema;
	/** Original MCP tool name (before normalization) */
	readonly mcpToolName: string;
	/** Server name */
	readonly mcpServerName: string;
	/** Server-declared read-only behavior for prewalk; approval stays conservative. */
	readonly mcpReadOnlyHint: boolean | undefined;
	/** Resolved deferred flag: explicit config wins, otherwise the server-name default. */
	readonly mcpDeferred: boolean;
	/**
	 * The capability wait stays top-level (`essential`) like the built-in wait it
	 * replaced: steering only reaches a direct call, never one routed through
	 * `write xd://`. Other MCP tools keep the discoverable default.
	 */
	readonly loadMode: ToolLoadMode | undefined;
	/**
	 * The capability wait is a pure block, so steering (or an interrupting peer
	 * IRC) cancels the in-flight request — the stdio transport turns the abort
	 * into `notifications/cancelled`. Every other MCP tool keeps today's
	 * semantics: queued steering never hard-kills side-effecting work.
	 */
	readonly interruptible = (args: unknown): boolean =>
		isCapabilityWaitTool(this.mcpServerName, this.mcpToolName) && isInterruptibleCapabilityWaitCall(args);
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
	readonly formatApprovalDetails = formatApprovalArguments;

	/** Create MCPTool instances for all tools from an MCP server connection */
	static fromTools(
		connection: MCPServerConnection,
		tools: MCPToolDefinition[],
		reconnect?: MCPReconnect,
		observeCall?: MCPToolCallObserver,
	): MCPTool[] {
		return tools.map(tool => new MCPTool(connection, tool, reconnect, observeCall));
	}

	constructor(
		private connection: MCPServerConnection,
		private readonly tool: MCPToolDefinition,
		private readonly reconnect?: MCPReconnect,
		private readonly observeCall?: MCPToolCallObserver,
	) {
		this.name = createMCPToolName(connection.name, tool.name);
		this.legacyName = createLegacyMCPToolName(connection.name, tool.name);
		this.label = `${connection.name}/${tool.name}`;
		this.description = tool.description ?? `MCP tool from ${connection.name}`;
		this.parameters = normalizeSchemaForMCP(tool.inputSchema) as TSchema;
		this.mcpToolName = tool.name;
		this.mcpServerName = connection.name;
		this.mcpReadOnlyHint = tool.annotations?.readOnlyHint;
		this.mcpDeferred = isDeferredMCPServer(connection.name, connection.config?.deferred);
		this.loadMode = isCapabilityWaitTool(connection.name, tool.name) ? "essential" : undefined;
	}

	renderCall(args: unknown, _options: RenderResultOptions, theme: Theme) {
		const normalizedArgs = normalizeToolArgs(args);
		const display = capabilityDisplay(this.mcpServerName, this.mcpToolName, normalizedArgs);
		return renderMCPCall(display?.args ?? normalizedArgs, theme, display?.label ?? this.label);
	}

	renderResult(result: CustomToolResult<MCPToolDetails>, options: RenderResultOptions, theme: Theme, args?: unknown) {
		const normalizedArgs = normalizeToolArgs(args);
		// ToolExecutionComponent detaches this method (`const renderResult = tool.renderResult`), so the
		// capability branch must read the names from the result details, never `this`.
		const details = result?.details;
		if (details && isCapabilityJobTool(details.serverName, details.mcpToolName)) {
			const capabilityRow = renderCapabilityJobResult(details.mcpToolName, result, normalizedArgs, options);
			if (capabilityRow) return capabilityRow;
		}
		const display = capabilityResultDisplay(result, details, normalizedArgs);
		if (display) return renderMCPCall(display.args, theme, display.label);
		return renderMCPResult(result, options, theme, normalizedArgs);
	}

	describeCall(args: unknown, options: RenderResultOptions) {
		const normalizedArgs = normalizeToolArgs(args);
		const display = capabilityDisplay(this.mcpServerName, this.mcpToolName, normalizedArgs);
		return describeMCPCall(display?.args ?? normalizedArgs, display?.label ?? this.label, options);
	}

	describeResult(result: CustomToolResult<MCPToolDetails>, options: RenderResultOptions, args?: unknown) {
		const normalizedArgs = normalizeToolArgs(args);
		const details = result?.details;
		if (details && isCapabilityJobTool(details.serverName, details.mcpToolName)) {
			const capabilityView = describeCapabilityJobResult(details.mcpToolName, result, normalizedArgs);
			if (capabilityView) return capabilityView;
		}
		const display = capabilityResultDisplay(result, details, normalizedArgs);
		if (display) return describeMCPCall(display.args, display.label, options);
		return describeMCPResult(result, options, normalizedArgs);
	}

	async execute(
		toolCallId: string,
		params: unknown,
		onUpdate: AgentToolUpdateCallback<MCPToolDetails> | undefined,
		ctx: CustomToolContext,
		signal?: AbortSignal,
	): Promise<CustomToolResult<MCPToolDetails>> {
		const settle = this.observeCall?.(toolCallId);
		try {
			return await this.#call(params, onUpdate, ctx, signal);
		} finally {
			await settle?.();
		}
	}

	async #call(
		params: unknown,
		onUpdate: AgentToolUpdateCallback<MCPToolDetails> | undefined,
		_ctx: CustomToolContext,
		signal?: AbortSignal,
	): Promise<CustomToolResult<MCPToolDetails>> {
		throwIfAborted(signal);
		const args = await prepareOutboundArgs(params, this.tool.inputSchema, _ctx);
		const provider = this.connection._source?.provider;
		const providerName = this.connection._source?.providerName;
		const progress = progressUpdater(onUpdate, this.connection.name, this.tool.name, provider, providerName);
		const onProgress = progress?.onProgress;

		try {
			const attempt = await callToolWithAuthRetry(
				this.connection,
				this.tool.name,
				args,
				this.reconnect,
				signal,
				onProgress,
			);
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
				const staleSession = isStaleSessionError(error) && !error.retryable;
				const newConn = await reconnectWithAbort(this.reconnect, signal, { staleSession });
				if (newConn) {
					// Rebind so subsequent calls on this instance use the fresh connection
					this.connection = newConn;
					const retryProvider = newConn._source?.provider ?? provider;
					const retryProviderName = newConn._source?.providerName ?? providerName;
					try {
						const result = await callTool(newConn, this.tool.name, args, { signal, onProgress });
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
		} finally {
			progress?.close();
		}
	}
}
