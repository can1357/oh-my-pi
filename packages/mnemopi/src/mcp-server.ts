import pkg from "../package.json" with { type: "json" };
import { getToolDefinitions, handleToolCall, type ToolArguments, type ToolDefinition } from "./mcp-tools";

export const MODERN_PROTOCOL_VERSION = "2026-07-28";
export const LEGACY_PROTOCOL_VERSION = "2024-11-05";
export const STATIC_DEFINITIONS_TTL_MS = 86_400_000;
export const SERVER_INFO = { name: "mnemopi", version: pkg.version } as const;

const PROTOCOL_VERSION_META_KEY = "io.modelcontextprotocol/protocolVersion";
const CLIENT_CAPABILITIES_META_KEY = "io.modelcontextprotocol/clientCapabilities";
const SERVER_INFO_META_KEY = "io.modelcontextprotocol/serverInfo";

export interface JsonRpcRequest {
	readonly jsonrpc: "2.0";
	readonly id?: string | number;
	readonly method: string;
	readonly params?: Readonly<Record<string, unknown>>;
}

interface ValidatedJsonRpcRequest {
	readonly jsonrpc: "2.0";
	readonly id?: string | number;
	readonly method: string;
	readonly params?: unknown;
}

export interface JsonRpcError {
	readonly code: number;
	readonly message: string;
	readonly data?: unknown;
}

export interface JsonRpcResultResponse {
	readonly jsonrpc: "2.0";
	readonly id: string | number | null;
	readonly result: unknown;
	readonly error?: never;
}

export interface JsonRpcErrorResponse {
	readonly jsonrpc: "2.0";
	readonly id: string | number | null;
	readonly result?: never;
	readonly error: JsonRpcError;
}

export type JsonRpcResponse = JsonRpcResultResponse | JsonRpcErrorResponse;

export interface ModernRequestMetadata {
	readonly "io.modelcontextprotocol/protocolVersion": string;
	readonly "io.modelcontextprotocol/clientCapabilities": Readonly<Record<string, unknown>>;
	readonly [key: string]: unknown;
}

export interface ModernResultMetadata {
	readonly "io.modelcontextprotocol/serverInfo": typeof SERVER_INFO;
	readonly [key: string]: unknown;
}

export interface ListToolsResponse {
	readonly tools: readonly ToolDefinition[];
}

export interface CallToolContent {
	readonly type: "text";
	readonly text: string;
}

export interface CallToolResponse {
	readonly content: readonly CallToolContent[];
	readonly isError?: boolean;
}

export interface ModernCompleteResult {
	readonly resultType: "complete";
	readonly _meta: ModernResultMetadata;
}

export interface ModernListToolsResponse extends ModernCompleteResult, ListToolsResponse {
	readonly ttlMs: number;
	readonly cacheScope: "public";
}

export type ModernCallToolResponse = ModernCompleteResult & CallToolResponse;

export interface ModernDiscoverResponse extends ModernCompleteResult {
	readonly supportedVersions: readonly string[];
	readonly capabilities: {
		readonly tools: {
			readonly listChanged: false;
		};
	};
	readonly ttlMs: number;
	readonly cacheScope: "public";
}

export interface WritableOutput {
	write(chunk: string): unknown;
}

function ok(id: string | number | null, result: unknown): JsonRpcResultResponse {
	return { jsonrpc: "2.0", id, result };
}

function err(id: string | number | null, code: number, message: string, data?: unknown): JsonRpcErrorResponse {
	return data === undefined
		? { jsonrpc: "2.0", id, error: { code, message } }
		: { jsonrpc: "2.0", id, error: { code, message, data } };
}

function hasRequestId(request: ValidatedJsonRpcRequest): request is ValidatedJsonRpcRequest & {
	readonly id: string | number;
} {
	return Object.hasOwn(request, "id");
}

function validateJsonRpcEnvelope(value: unknown): ValidatedJsonRpcRequest | null {
	if (!isRecord(value) || value.jsonrpc !== "2.0" || typeof value.method !== "string") return null;
	if (Object.hasOwn(value, "id")) {
		const id = value.id;
		if (typeof id !== "string" && !(typeof id === "number" && Number.isInteger(id))) return null;
	}
	return value as unknown as ValidatedJsonRpcRequest;
}

export function listToolsJson(): ListToolsResponse {
	return { tools: getToolDefinitions() };
}

export async function callToolJson(name: string, args: ToolArguments = {}): Promise<CallToolResponse> {
	try {
		const result = await handleToolCall(name, args);
		return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			content: [{ type: "text", text: JSON.stringify({ status: "error", message }, null, 2) }],
			isError: true,
		};
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isModernRequest(request: ValidatedJsonRpcRequest): boolean {
	if (!isRecord(request.params) || !isRecord(request.params._meta)) return false;
	return Object.hasOwn(request.params._meta, PROTOCOL_VERSION_META_KEY);
}
function validateModernMetadata(request: ValidatedJsonRpcRequest, id: string | number): JsonRpcErrorResponse | null {
	const metadata = isRecord(request.params) ? request.params._meta : undefined;
	if (!isRecord(metadata)) return err(id, -32602, "Modern requests require params._meta");

	const protocolVersion = metadata[PROTOCOL_VERSION_META_KEY];
	if (typeof protocolVersion !== "string") {
		return err(id, -32602, `Modern requests require _meta.${PROTOCOL_VERSION_META_KEY}`);
	}

	const clientCapabilities = metadata[CLIENT_CAPABILITIES_META_KEY];
	if (!isRecord(clientCapabilities)) {
		return err(id, -32602, `Modern requests require _meta.${CLIENT_CAPABILITIES_META_KEY}`);
	}

	if (protocolVersion !== MODERN_PROTOCOL_VERSION) {
		return err(id, -32022, "Unsupported protocol version", {
			supported: [MODERN_PROTOCOL_VERSION],
			requested: protocolVersion,
		});
	}
	return null;
}

function validateModernListParams(request: ValidatedJsonRpcRequest, id: string | number): JsonRpcErrorResponse | null {
	const params = isRecord(request.params) ? request.params : {};
	if (Object.hasOwn(params, "cursor") && typeof params.cursor !== "string") {
		return err(id, -32602, "tools/list params.cursor must be a string");
	}
	return null;
}

function serverIdentityMetadata(): ModernResultMetadata {
	return { [SERVER_INFO_META_KEY]: { ...SERVER_INFO } };
}

function modernDiscoverJson(): ModernDiscoverResponse {
	return {
		resultType: "complete",
		supportedVersions: [MODERN_PROTOCOL_VERSION],
		capabilities: { tools: { listChanged: false } },
		_meta: serverIdentityMetadata(),
		ttlMs: STATIC_DEFINITIONS_TTL_MS,
		cacheScope: "public",
	};
}

function compareToolNames(left: ToolDefinition, right: ToolDefinition): number {
	return left.name < right.name ? -1 : left.name > right.name ? 1 : 0;
}

function isAdvertisedTool(name: string): boolean {
	return getToolDefinitions().some(tool => tool.name === name);
}

function modernListToolsJson(): ModernListToolsResponse {
	return {
		resultType: "complete",
		tools: [...getToolDefinitions()].sort(compareToolNames),
		_meta: serverIdentityMetadata(),
		ttlMs: STATIC_DEFINITIONS_TTL_MS,
		cacheScope: "public",
	};
}

async function modernCallToolJson(name: string, args: ToolArguments): Promise<ModernCallToolResponse> {
	return {
		resultType: "complete",
		...(await callToolJson(name, args)),
		_meta: serverIdentityMetadata(),
	};
}

async function handleLegacyJsonRpc(request: ValidatedJsonRpcRequest, id: string | number): Promise<JsonRpcResponse> {
	const method = request.method ?? "";
	if (method === "initialize") {
		return ok(id, {
			protocolVersion: LEGACY_PROTOCOL_VERSION,
			serverInfo: { ...SERVER_INFO },
			capabilities: { tools: {} },
		});
	}
	if (method === "tools/list") return ok(id, listToolsJson());
	if (method === "tools/call") {
		const params = isRecord(request.params) ? request.params : {};
		const name = typeof params.name === "string" ? params.name : "";
		if (name.length === 0) return err(id, -32602, "tools/call requires params.name");
		if (Object.hasOwn(params, "arguments") && !isRecord(params.arguments)) {
			return err(id, -32602, "tools/call params.arguments must be an object");
		}
		const args = isRecord(params.arguments) ? params.arguments : {};
		return ok(id, await callToolJson(name, args));
	}
	return err(id, -32601, `Unknown method: ${method}`);
}

async function handleModernJsonRpc(request: ValidatedJsonRpcRequest, id: string | number): Promise<JsonRpcResponse> {
	const invalidMetadata = validateModernMetadata(request, id);
	if (invalidMetadata !== null) return invalidMetadata;

	const method = request.method ?? "";
	if (method === "server/discover") return ok(id, modernDiscoverJson());
	if (method === "tools/list") {
		const invalidParams = validateModernListParams(request, id);
		return invalidParams ?? ok(id, modernListToolsJson());
	}
	if (method === "tools/call") {
		const params = isRecord(request.params) ? request.params : {};
		const name = typeof params.name === "string" ? params.name : "";
		if (name.length === 0) return err(id, -32602, "tools/call requires params.name");
		if (!isAdvertisedTool(name)) return err(id, -32602, `Unknown tool: ${name}`);
		if (Object.hasOwn(params, "arguments") && !isRecord(params.arguments)) {
			return err(id, -32602, "tools/call params.arguments must be an object");
		}
		const args = isRecord(params.arguments) ? params.arguments : {};
		return ok(id, await modernCallToolJson(name, args));
	}
	return err(id, -32601, `Unknown method: ${method}`);
}

export async function handleJsonRpc(value: unknown): Promise<JsonRpcResponse | null> {
	const request = validateJsonRpcEnvelope(value);
	if (request === null) return err(null, -32600, "Invalid Request");
	if (!hasRequestId(request) || request.method.startsWith("notifications/")) return null;
	return isModernRequest(request)
		? handleModernJsonRpc(request, request.id)
		: handleLegacyJsonRpc(request, request.id);
}

export async function runStdio(
	input: ReadableStream<Uint8Array> = Bun.stdin.stream(),
	output: WritableOutput = Bun.stdout,
): Promise<void> {
	const reader = input.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	try {
		while (true) {
			const chunk = await reader.read();
			if (chunk.done) break;
			buffer += decoder.decode(chunk.value, { stream: true });
			let newline = buffer.indexOf("\n");
			while (newline >= 0) {
				const line = buffer.slice(0, newline).trim();
				buffer = buffer.slice(newline + 1);
				if (line.length > 0) {
					let parsed: unknown;
					try {
						parsed = JSON.parse(line);
					} catch {
						output.write(`${JSON.stringify(err(null, -32700, "Parse error"))}\n`);
						newline = buffer.indexOf("\n");
						continue;
					}
					const response = await handleJsonRpc(parsed as JsonRpcRequest);
					if (response !== null) output.write(`${JSON.stringify(response)}\n`);
				}
				newline = buffer.indexOf("\n");
			}
		}
	} finally {
		reader.releaseLock();
	}
}

export function runMcpServer(
	transport = "stdio",
	options: { port?: number; bank?: string; host?: string } = {},
): Promise<void> {
	if (options.bank !== undefined && options.bank.length > 0) process.env.MNEMOPI_MCP_BANK = options.bank;
	if (transport !== "stdio") throw new Error("Only stdio transport is implemented in the TypeScript port");
	return runStdio();
}

export function main(argv: readonly string[] = Bun.argv.slice(2)): Promise<void> {
	let transport = "stdio";
	let port: number | undefined;
	let bank: string | undefined;
	let host: string | undefined;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--transport") transport = argv[++i] ?? "stdio";
		else if (arg === "--port") {
			const parsed = Number(argv[++i] ?? "");
			if (Number.isFinite(parsed)) port = parsed;
		} else if (arg === "--bank") bank = argv[++i] ?? "";
		else if (arg === "--host") host = argv[++i] ?? "";
	}
	return runMcpServer(transport, { port, bank, host });
}

if (import.meta.main) await main();
