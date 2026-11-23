/**
 * The handshake a pre-2026 MCP server requires before anything else:
 * `initialize`, then `notifications/initialized`, then — on Streamable HTTP —
 * the optional GET stream for server-initiated messages. The session this
 * opens lives in the server's process (or behind its `Mcp-Session-Id`) for as
 * long as the transport stays open.
 */
import { isRecord } from "@oh-my-pi/pi-utils";
import { MCPTransportError } from "../errors";
import { MCP_CLIENT_INFO, MCP_LEGACY_PROTOCOL_VERSION } from "../protocol";
import type { MCPInitializeParams, MCPInitializeResult, MCPTransport } from "../types";
import { HttpUpstream } from "./http-upstream";

/** What the host declares in `initialize`: roots are the only server request it answers. */
export const MCP_LEGACY_INITIALIZE_PARAMS: MCPInitializeParams = {
	protocolVersion: MCP_LEGACY_PROTOCOL_VERSION,
	capabilities: { roots: { listChanged: false } },
	clientInfo: MCP_CLIENT_INFO,
};

/**
 * Open the `initialize` session on a connected `transport` and return the
 * server's answer.
 *
 * The transport's `onRequest` handler must already be installed: a server may
 * ask for `roots/list` as soon as it has seen `notifications/initialized`.
 * The GET stream is opened only after that notification, because servers may
 * reject session traffic that precedes it.
 *
 * @throws MCPTransportError when a step fails or the server's answer is not an `initialize` result; the abort reason when `signal` aborts. The transport is left open either way; the caller closes it.
 */
export async function openLegacySession(transport: MCPTransport, signal?: AbortSignal): Promise<MCPInitializeResult> {
	const session = parseInitializeResult(
		await transport.request<unknown>("initialize", { ...MCP_LEGACY_INITIALIZE_PARAMS }, { signal }),
	);
	signal?.throwIfAborted();

	// Streamable HTTP echoes the negotiated version on every later request.
	transport.setProtocolVersion?.(session.protocolVersion);
	await transport.notify("notifications/initialized");
	signal?.throwIfAborted();
	if (transport instanceof HttpUpstream) await transport.startSSEListener(signal);
	signal?.throwIfAborted();
	return session;
}

/**
 * Narrow a server's answer to `initialize`, or a snapshot of one. Missing
 * capabilities read as none and a missing server identity as `unknown`.
 *
 * @throws MCPTransportError when `result` is not an object naming a protocol version.
 */
export function parseInitializeResult(result: unknown): MCPInitializeResult {
	if (!isRecord(result) || typeof result.protocolVersion !== "string") {
		throw new MCPTransportError({
			transport: "unknown",
			stage: "protocol",
			failure: "malformed_response",
			message: "MCP server answered initialize without a protocol version",
			retryable: false,
		});
	}
	const serverInfo = isRecord(result.serverInfo) ? result.serverInfo : undefined;
	return {
		protocolVersion: result.protocolVersion,
		capabilities: isRecord(result.capabilities) ? result.capabilities : {},
		serverInfo: {
			...serverInfo,
			name: typeof serverInfo?.name === "string" ? serverInfo.name : "unknown",
			version: typeof serverInfo?.version === "string" ? serverInfo.version : "unknown",
		},
		instructions: typeof result.instructions === "string" ? result.instructions : undefined,
	};
}
