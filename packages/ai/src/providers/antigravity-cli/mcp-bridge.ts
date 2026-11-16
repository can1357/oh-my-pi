/**
 * Loopback NDJSON MCP server for agy's official --ide-mcp-port bridge.
 * Tools are listed once per process as mcp_ide-tools_<name>. MCP progress does
 * not extend agy's 180s timeout; the host cancels and drains parked turns first.
 */
import { isRecord } from "@oh-my-pi/pi-utils";
import type { Socket, TCPSocketListener } from "bun";
import { validateJsonSchemaValue } from "../../utils/schema/json-schema-validator";

/** One fixed tool advertised over MCP tools/list. */
export interface McpToolDefinition {
	name: string;
	description: string;
	inputSchema: Record<string, unknown>;
}

/** MCP result content; image bytes are preserved. */
export type McpContent = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

/** A completed or explicitly rejected MCP call. */
export interface McpToolOutput {
	content: McpContent[];
	isError?: boolean;
}

/** Park a validated call until the host supplies its actual result or cancels it. */
export type McpCallHandler = (
	name: string,
	args: Record<string, unknown>,
	conversationId: string | undefined,
) => Promise<McpToolOutput>;

interface Connection {
	buffer: string;
	decoder: TextDecoder;
	closed: boolean;
	ended: PromiseWithResolvers<void>;
	requests: Set<string | number>;
}

const PROTOCOL_VERSION = "2025-06-18";
const MAX_FRAME_BYTES = 32 * 1024 * 1024;

/** Fixed-tool TCP server scoped to one agy process; close also terminates connected sockets. */
export class McpBridge {
	readonly port: number;
	readonly #server: TCPSocketListener<Connection>;
	readonly #sockets = new Set<Socket<Connection>>();
	#closed = false;

	/** Start listening immediately on an ephemeral IPv4 loopback port. */
	constructor(tools: readonly McpToolDefinition[], onCall: McpCallHandler, onDisconnect?: () => void) {
		const byName = new Map(tools.map(tool => [tool.name, tool]));
		if (byName.size !== tools.length) throw new Error("Duplicate Antigravity CLI tool name");
		this.#server = Bun.listen<Connection>({
			hostname: "127.0.0.1",
			port: 0,
			socket: {
				open: socket => {
					socket.data = {
						buffer: "",
						decoder: new TextDecoder(),
						closed: false,
						ended: Promise.withResolvers<void>(),
						requests: new Set(),
					};
					if (this.#closed || this.#sockets.size > 0) {
						socket.terminate();
						return;
					}
					this.#sockets.add(socket);
				},
				data: (socket, chunk) => {
					if (socket.data.closed) return;
					socket.data.buffer += socket.data.decoder.decode(chunk, { stream: true });
					if (socket.data.buffer.length > MAX_FRAME_BYTES) {
						socket.terminate();
						return;
					}
					for (
						let newline = socket.data.buffer.indexOf("\n");
						newline >= 0;
						newline = socket.data.buffer.indexOf("\n")
					) {
						const line = socket.data.buffer.slice(0, newline).trim();
						socket.data.buffer = socket.data.buffer.slice(newline + 1);
						if (line) handleLine(socket, line, tools, byName, onCall);
					}
				},
				close: socket => {
					socket.data.closed = true;
					socket.data.ended.resolve();
					const owned = this.#sockets.delete(socket);
					if (owned && !this.#closed) onDisconnect?.();
				},
				error: socket => {
					socket.terminate();
				},
			},
		});
		this.port = this.#server.port;
	}

	/** Idempotently stop listening, release waiting replies and terminate all connections. */
	close(): void {
		if (this.#closed) return;
		this.#closed = true;
		for (const socket of this.#sockets) {
			socket.data.closed = true;
			socket.data.ended.resolve();
			socket.terminate();
		}
		this.#sockets.clear();
		this.#server.stop(true);
	}
}

function handleLine(
	socket: Socket<Connection>,
	line: string,
	tools: readonly McpToolDefinition[],
	byName: ReadonlyMap<string, McpToolDefinition>,
	onCall: McpCallHandler,
): void {
	let request: unknown;
	try {
		request = JSON.parse(line);
	} catch {
		return;
	}
	if (!isRecord(request) || request.jsonrpc !== "2.0") return;
	const id = request.id;
	if (typeof id !== "string" && !(typeof id === "number" && Number.isSafeInteger(id))) return;
	const reply = (body: { result: unknown } | { error: { code: number; message: string } }) => {
		if (socket.data.closed) return;
		try {
			socket.write(`${JSON.stringify({ jsonrpc: "2.0", id, ...body })}\n`);
		} catch {
			socket.terminate();
		}
	};
	const params = isRecord(request.params) ? request.params : {};
	switch (request.method) {
		case "initialize":
			reply({
				result: {
					protocolVersion: typeof params.protocolVersion === "string" ? params.protocolVersion : PROTOCOL_VERSION,
					capabilities: { tools: {} },
					serverInfo: { name: "tools", version: "1.0.0" },
				},
			});
			return;
		case "ping":
			reply({ result: {} });
			return;
		case "tools/list":
			reply({ result: { tools } });
			return;
		case "tools/call": {
			const tool = typeof params.name === "string" ? byName.get(params.name) : undefined;
			if (!tool) {
				reply({ error: { code: -32602, message: "Unknown tool" } });
				return;
			}
			const args = params.arguments === undefined ? {} : params.arguments;
			if (!isRecord(args) || !validateJsonSchemaValue(tool.inputSchema, args).success) {
				reply({ error: { code: -32602, message: "Invalid tool arguments" } });
				return;
			}
			if (socket.data.requests.has(id)) {
				reply({ error: { code: -32600, message: "Duplicate request id" } });
				return;
			}
			const meta = isRecord(params._meta) ? params._meta : {};
			const conversationId = meta["antigravity.google/conversation_id"];
			if (conversationId !== undefined && typeof conversationId !== "string") {
				reply({ error: { code: -32602, message: "Invalid conversation id" } });
				return;
			}
			socket.data.requests.add(id);
			void Promise.race([
				Promise.resolve().then(() => onCall(tool.name, args, conversationId)),
				socket.data.ended.promise.then(() => undefined),
			])
				.then(
					output => {
						if (output) reply({ result: output });
					},
					() => reply({ result: { content: [{ type: "text", text: "Tool transport failed" }], isError: true } }),
				)
				.finally(() => socket.data.requests.delete(id));
			return;
		}
		default:
			reply({ error: { code: -32601, message: "Method not found" } });
	}
}
