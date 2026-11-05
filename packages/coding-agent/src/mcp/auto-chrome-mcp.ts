/**
 * Auto-discovery of the local chrome-mcp bridge.
 *
 * The `mcp-chrome-bridge` native host exposes the user's real Chrome over MCP
 * at `http://127.0.0.1:12306/mcp` once its extension is loaded. The bridge is
 * optional infrastructure: a session probes it once at discovery time and
 * registers it as the `chrome` MCP server when it answers. Probing is strictly
 * local — only loopback URLs are accepted — and every failure (closed port,
 * timeout, malformed reply) means "bridge not running": no error reaches the
 * caller, no prompt notice is added.
 */
import { isRecord, logger, readSseJson } from "@oh-my-pi/pi-utils";
import type { SourceMeta } from "../capability/types";
import { MCP_PROTOCOL_VERSION, type MCPImplementation, type MCPToolDefinition, type MCPServerConfig } from "./types";

/** Name the discovered bridge is registered under. */
export const CHROME_MCP_SERVER_NAME = "chrome";

/** Default bridge endpoint served by `mcp-chrome-bridge`'s native host. */
export const CHROME_MCP_URL = "http://127.0.0.1:12306/mcp";

/** Deadline for the whole initialize + tools/list probe. */
export const CHROME_MCP_PROBE_TIMEOUT_MS = 2_000;

export interface ChromeMcpProbeOptions {
	/** Override the endpoint; must be loopback or the probe refuses to run. */
	url?: string;
	/** Whole-probe deadline in milliseconds. */
	timeoutMs?: number;
	signal?: AbortSignal;
}

/** A live bridge: the identity it reported and the tools it serves. */
export interface ChromeMcpBridge {
	serverInfo: MCPImplementation;
	tools: MCPToolDefinition[];
}

/** A live bridge plus the server config and source metadata for registration. */
export interface ChromeMcpDiscovery extends ChromeMcpBridge {
	name: string;
	config: MCPServerConfig;
	source: SourceMeta;
}

interface ProbeReply {
	result?: unknown;
	error?: { code: number; message: string };
}

function isLoopbackHost(hostname: string): boolean {
	const host = hostname.toLowerCase();
	return host === "127.0.0.1" || host === "localhost" || host === "[::1]";
}

async function postJsonRpc(
	url: URL,
	payload: Record<string, unknown>,
	signal: AbortSignal,
	sessionId?: string,
): Promise<{ reply: ProbeReply; sessionId: string | null }> {
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
		Accept: "application/json, text/event-stream",
		// The bridge's origin allowlist rejects requests without a same-origin header.
		Origin: url.origin,
	};
	if (sessionId !== undefined) headers["Mcp-Session-Id"] = sessionId;
	const response = await fetch(url, {
		method: "POST",
		headers,
		body: JSON.stringify(payload),
		signal,
		redirect: "error",
	});
	if (!response.ok) throw new Error(`HTTP ${response.status}`);
	const contentType = response.headers.get("content-type") ?? "";
	let reply: ProbeReply;
	if (contentType.includes("text/event-stream") && response.body) {
		reply = {};
		let found = false;
		for await (const event of readSseJson<Record<string, unknown>>(response.body, signal)) {
			if (Array.isArray(event)) continue;
			if ("result" in event || "error" in event) {
				reply = event as ProbeReply;
				found = true;
				break;
			}
		}
		if (!found) throw new Error("No JSON-RPC reply in the SSE stream");
	} else {
		reply = (await response.json()) as ProbeReply;
	}
	return { reply, sessionId: response.headers.get("mcp-session-id") };
}

function parseServerInfo(result: Record<string, unknown>): MCPImplementation {
	const info = result.serverInfo;
	if (isRecord(info) && typeof info.name === "string" && typeof info.version === "string") {
		return { name: info.name, version: info.version };
	}
	return { name: CHROME_MCP_SERVER_NAME, version: "unknown" };
}

function parseTools(result: Record<string, unknown>): MCPToolDefinition[] | null {
	if (!Array.isArray(result.tools)) return null;
	return result.tools.filter((tool): tool is MCPToolDefinition => isRecord(tool) && typeof tool.name === "string");
}

/**
 * Probe the bridge with the 2025 `initialize` handshake and one `tools/list`.
 * Returns `null` for any non-loopback endpoint, closed port, timeout, HTTP or
 * JSON-RPC error, and malformed result — never throws.
 */
export async function probeChromeMcp(options: ChromeMcpProbeOptions = {}): Promise<ChromeMcpBridge | null> {
	const target = options.url ?? CHROME_MCP_URL;
	let url: URL;
	try {
		url = new URL(target);
	} catch {
		return null;
	}
	if (url.protocol !== "http:" || !isLoopbackHost(url.hostname)) {
		logger.debug("Ignoring chrome-mcp probe for a non-loopback endpoint", { url: target });
		return null;
	}
	const timeoutMs = options.timeoutMs ?? CHROME_MCP_PROBE_TIMEOUT_MS;
	const deadline = AbortSignal.timeout(timeoutMs);
	const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
	try {
		const init = await postJsonRpc(
			url,
			{
				jsonrpc: "2.0",
				id: 1,
				method: "initialize",
				params: {
					protocolVersion: MCP_PROTOCOL_VERSION,
					capabilities: {},
					clientInfo: { name: "omp-coding-agent", version: "1.0.0" },
				},
			},
			signal,
		);
		if (!isRecord(init.reply.result) || init.reply.error !== undefined) return null;

		const listed = await postJsonRpc(
			url,
			{ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
			signal,
			init.sessionId ?? undefined,
		);
		if (!isRecord(listed.reply.result) || listed.reply.error !== undefined) return null;
		const tools = parseTools(listed.reply.result);
		if (tools === null) return null;

		return { serverInfo: parseServerInfo(init.reply.result), tools };
	} catch (error) {
		logger.debug("chrome-mcp bridge probe failed", {
			url: target,
			error: error instanceof Error ? error.message : String(error),
		});
		return null;
	}
}

/**
 * Probe the bridge and wrap a live one into the `chrome` MCP server entry.
 * `null` means "no bridge": callers register nothing and stay quiet.
 */
export async function discoverChromeMcp(options: ChromeMcpProbeOptions = {}): Promise<ChromeMcpDiscovery | null> {
	const bridge = await probeChromeMcp(options);
	if (!bridge) return null;
	const url = options.url ?? CHROME_MCP_URL;
	return {
		name: CHROME_MCP_SERVER_NAME,
		config: {
			type: "streamable-http",
			url,
			// The bridge only serves requests carrying its own origin.
			headers: { Origin: new URL(url).origin },
		},
		source: {
			provider: "chrome-mcp",
			providerName: "Chrome MCP Bridge",
			path: url,
			level: "native",
		},
		...bridge,
	};
}
