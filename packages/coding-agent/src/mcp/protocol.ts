/**
 * MCP 2026-07-28 wire model: the one protocol revision a session speaks.
 *
 * Every omp session talks this stateless revision to the MCP host
 * (`mcp/host/`), which serves it for modern and handshake-era servers alike.
 * Nothing here is connection state: each request carries its own revision,
 * capabilities and identity in `_meta`, every result names its `resultType`,
 * and server-to-client asks arrive as `input_required` results instead of
 * JSON-RPC requests.
 */
import { isRecord } from "@oh-my-pi/pi-utils";
import type { MCPClientCapabilities, MCPImplementation, MCPServerCapabilities } from "./types";

/** Protocol revision sent on every request. */
export const MCP_PROTOCOL_VERSION = "2026-07-28";

/**
 * Newest handshake-era revision. Only the host's legacy adapter negotiates it,
 * with servers that still require `initialize`.
 */
export const MCP_LEGACY_PROTOCOL_VERSION = "2025-11-25";

/** Reserved `_meta` keys of the 2026-07-28 revision. */
export const MCPMeta = {
	protocolVersion: "io.modelcontextprotocol/protocolVersion",
	clientCapabilities: "io.modelcontextprotocol/clientCapabilities",
	clientInfo: "io.modelcontextprotocol/clientInfo",
	serverInfo: "io.modelcontextprotocol/serverInfo",
	subscriptionId: "io.modelcontextprotocol/subscriptionId",
	progressToken: "progressToken",
} as const;

/** JSON-RPC error codes the client branches on. */
export const MCPErrorCode = {
	MethodNotFound: -32601,
	InvalidParams: -32602,
	HeaderMismatch: -32020,
	MissingRequiredClientCapability: -32021,
	UnsupportedProtocolVersion: -32022,
} as const;

/**
 * Whether `code` is specific to MCP 2026-07-28. The era probe also checks
 * the advertised revisions on an unsupported-version error.
 */
export function isModernErrorCode(code: unknown): boolean {
	return (
		code === MCPErrorCode.HeaderMismatch ||
		code === MCPErrorCode.MissingRequiredClientCapability ||
		code === MCPErrorCode.UnsupportedProtocolVersion
	);
}

/** Identity omp reports in `_meta` on every request. */
export const MCP_CLIENT_INFO: MCPImplementation = { name: "omp-coding-agent", version: "1.0.0" };

/**
 * Capabilities omp declares on a request by default. Roots are the only server
 * ask it answers, so `roots/list` is the only input request a server may return.
 */
export const MCP_CLIENT_CAPABILITIES: MCPClientCapabilities = { roots: {} };

/**
 * Capabilities of a request whose caller can put a question to the user: a
 * server may also return form-mode `elicitation/create` asks.
 */
export const MCP_ELICITING_CLIENT_CAPABILITIES: MCPClientCapabilities = {
	...MCP_CLIENT_CAPABILITIES,
	elicitation: { form: {} },
};

const CACHEABLE_METHODS: Record<string, true> = {
	"server/discover": true,
	"tools/list": true,
	"prompts/list": true,
	"resources/list": true,
	"resources/templates/list": true,
	"resources/read": true,
};

const MRTR_METHODS: Record<string, true> = { "tools/call": true, "prompts/get": true, "resources/read": true };

/** Whether complete results of `method` carry `ttlMs` and `cacheScope`. */
export function isCacheableMethod(method: string): boolean {
	return Object.hasOwn(CACHEABLE_METHODS, method);
}

/** Whether a server may answer `method` with `input_required`. */
export function isMrtrMethod(method: string): boolean {
	return Object.hasOwn(MRTR_METHODS, method);
}

/** Fields every result carries. An absent `resultType` means `"complete"`. */
export interface MCPResult {
	resultType?: string;
	_meta?: Record<string, unknown>;
}

/** Caching hints on results of cacheable methods; see {@link isCacheableMethod}. */
export interface MCPCacheableResult extends MCPResult {
	/** Freshness window in milliseconds; absent or negative means immediately stale. */
	ttlMs?: number;
	/** `private` results are reusable only within the authorization context that fetched them. */
	cacheScope?: "public" | "private";
}

/** Result of `server/discover`: what `initialize` used to return, minus the session. */
export interface MCPDiscoverResult extends MCPCacheableResult {
	supportedVersions: string[];
	capabilities: MCPServerCapabilities;
	instructions?: string;
}

/** One server ask inside an `input_required` result. */
export interface MCPInputRequest {
	method: string;
	params?: Record<string, unknown>;
}

/** Interim result of a Multi Round-Trip Request: the server needs input before it can finish. */
export interface MCPInputRequiredResult extends MCPResult {
	resultType: "input_required";
	/** Asks keyed by server-assigned id; every key must be answered in the retry's `inputResponses`. */
	inputRequests?: Record<string, MCPInputRequest>;
	/** Opaque; echoed verbatim on the retry when present, never sent otherwise. */
	requestState?: string;
}

/** A string field of an elicitation form; `enum`/`oneOf` make it a single choice. */
export interface MCPElicitStringSchema {
	type: "string";
	title?: string;
	description?: string;
	minLength?: number;
	maxLength?: number;
	format?: "email" | "uri" | "date" | "date-time";
	default?: string;
	/** Untitled single choice. */
	enum?: string[];
	/** Titled single choice. */
	oneOf?: { const: string; title?: string }[];
}

/** A numeric field of an elicitation form. */
export interface MCPElicitNumberSchema {
	type: "number" | "integer";
	title?: string;
	description?: string;
	minimum?: number;
	maximum?: number;
	default?: number;
}

/** A yes/no field of an elicitation form. */
export interface MCPElicitBooleanSchema {
	type: "boolean";
	title?: string;
	description?: string;
	default?: boolean;
}

/** A multiple-choice field of an elicitation form: untitled (`items.enum`) or titled (`items.anyOf`). */
export interface MCPElicitArraySchema {
	type: "array";
	title?: string;
	description?: string;
	minItems?: number;
	maxItems?: number;
	items: { type?: "string"; enum?: string[]; anyOf?: { const: string; title?: string }[] };
	default?: string[];
}

/** One field of an elicitation form: the flat primitive schemas form mode allows. */
export type MCPElicitFieldSchema =
	| MCPElicitStringSchema
	| MCPElicitNumberSchema
	| MCPElicitBooleanSchema
	| MCPElicitArraySchema;

/** Params of a form-mode `elicitation/create` ask. */
export interface MCPElicitRequest {
	/** What the server asks and why, shown to the user. */
	message: string;
	requestedSchema: {
		type: "object";
		properties: Record<string, MCPElicitFieldSchema>;
		required?: string[];
	};
}

/** A value of an accepted elicitation's `content`. */
export type MCPElicitValue = string | number | boolean | string[];

/**
 * The user's answer to an elicitation: `accept` with the form's content,
 * `decline` when they refused, `cancel` when they dismissed it without choosing.
 */
export type MCPElicitResult =
	| { action: "accept"; content: Record<string, MCPElicitValue> }
	| { action: "decline" | "cancel" };

/** Opt-in notification filter of `subscriptions/listen`. */
export interface MCPSubscriptionFilter {
	toolsListChanged?: boolean;
	promptsListChanged?: boolean;
	resourcesListChanged?: boolean;
	resourceSubscriptions?: string[];
}

/** First notification of every subscription; `params.notifications` is the subset the server honours. */
export const MCP_SUBSCRIPTION_ACKNOWLEDGED = "notifications/subscriptions/acknowledged";

/** `_meta` every request must carry: revision, capabilities, identity. */
export function requestMeta(capabilities: MCPClientCapabilities = MCP_CLIENT_CAPABILITIES): Record<string, unknown> {
	return {
		[MCPMeta.protocolVersion]: MCP_PROTOCOL_VERSION,
		[MCPMeta.clientCapabilities]: capabilities,
		[MCPMeta.clientInfo]: MCP_CLIENT_INFO,
	};
}

/**
 * `params` with the required request metadata merged over any caller `_meta`
 * (a progress token, private host hints), declaring `capabilities`. Never mutates `params`.
 */
export function withRequestMeta(
	params: Record<string, unknown> | undefined,
	capabilities?: MCPClientCapabilities,
): Record<string, unknown> {
	const callerMeta = isRecord(params?._meta) ? params._meta : undefined;
	return { ...params, _meta: { ...callerMeta, ...requestMeta(capabilities) } };
}

/**
 * Classify a result by its `resultType`.
 *
 * @throws when the result is not an object or names a type this client does not implement.
 */
export function resultTypeOf(result: unknown): "complete" | "input_required" {
	if (!isRecord(result)) throw new Error("MCP result is not an object");
	const type = result.resultType;
	if (type === undefined || type === "complete") return "complete";
	if (type === "input_required") return "input_required";
	throw new Error(`Unsupported MCP result type: ${String(type)}`);
}

/** The subscription a listen-stream notification belongs to: the id of its `subscriptions/listen` request. */
export function subscriptionIdOf(params: unknown): string | number | undefined {
	const meta = isRecord(params) && isRecord(params._meta) ? params._meta : undefined;
	const id = meta?.[MCPMeta.subscriptionId];
	return typeof id === "string" || typeof id === "number" ? id : undefined;
}

/** Whether `filter` asks for anything beyond the three list-change streams. */
export function hasResourceSubscriptions(filter: MCPSubscriptionFilter): boolean {
	return (filter.resourceSubscriptions?.length ?? 0) > 0;
}
