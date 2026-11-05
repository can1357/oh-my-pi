import { type } from "@oh-my-pi/omptype";
import { prompt, sanitizeText } from "@oh-my-pi/pi-utils";
import {
	replaceTabs,
	shortenEmbeddedPaths,
	shortenPath,
	TRUNCATE_LENGTHS,
	truncateToWidth,
} from "@oh-my-pi/pi-tui/render/render-utils";
import unavailableServersTemplate from "../prompts/tools/mcp-unavailable-servers.md" with { type: "text" };

export const MCP_CONNECTION_STATUS_EVENT_CHANNEL = "mcp:connection-status";

export type McpConnectionFailure = {
	serverName: string;
	error: string;
	sourcePath?: string;
};

export type McpConnectionStatusEvent =
	| { type: "connecting"; serverNames: string[] }
	| { type: "reconnecting"; serverName: string }
	| { type: "connected"; serverName: string }
	| ({ type: "failed" } & McpConnectionFailure);

export type McpConnectionStatusSnapshot = {
	pendingServers: readonly string[];
	connectedServers: readonly string[];
	failedServers: readonly McpConnectionFailure[];
};

function sanitizeMcpStatusText(value: string, maxWidth: number): string {
	const text = shortenEmbeddedPaths(
		replaceTabs(sanitizeText(value))
			.replace(/[\r\n]+/g, " ")
			.trim(),
	);
	return truncateToWidth(text.length > 0 ? text : "(unnamed)", maxWidth);
}

function sanitizeMcpServerName(serverName: string): string {
	return sanitizeMcpStatusText(serverName, TRUNCATE_LENGTHS.SHORT);
}

function formatServerList(serverNames: readonly string[]): string {
	return serverNames.map(sanitizeMcpServerName).join(", ");
}

function formatServerCount(count: number): string {
	return count === 1 ? "server" : "servers";
}
function sanitizeMcpStatusError(error: string): string {
	return sanitizeMcpStatusText(error, TRUNCATE_LENGTHS.CONTENT);
}

export function formatMCPConnectingMessage(serverNames: readonly string[]): string {
	return `Connecting to MCP servers: ${formatServerList(serverNames)}…`;
}

function formatFailedServer({ serverName, error, sourcePath }: McpConnectionFailure): string {
	const source = sourcePath
		? ` [config: ${sanitizeMcpStatusText(shortenPath(sourcePath), TRUNCATE_LENGTHS.CONTENT)}]`
		: "";
	return `${sanitizeMcpServerName(serverName)}${source}: ${sanitizeMcpStatusError(error)}`;
}

export function formatMCPConnectionStatusMessage(snapshot: McpConnectionStatusSnapshot): string {
	const { pendingServers, connectedServers, failedServers } = snapshot;
	if (pendingServers.length > 0) {
		if (connectedServers.length === 0 && failedServers.length === 0) {
			return formatMCPConnectingMessage(pendingServers);
		}
		const parts: string[] = [];
		if (connectedServers.length > 0) {
			parts.push(`Connected: ${formatServerList(connectedServers)}.`);
		}
		if (failedServers.length > 0) {
			parts.push(`Failed: ${failedServers.map(formatFailedServer).join("; ")}.`);
		}
		parts.push(`Still connecting: ${formatServerList(pendingServers)}…`);
		return parts.join(" ");
	}
	if (failedServers.length > 0) {
		const failureText = failedServers.map(formatFailedServer).join("; ");
		if (connectedServers.length === 0) {
			return `MCP ${formatServerCount(failedServers.length)} failed to connect: ${failureText}`;
		}
		return `MCP finished with failures. Connected: ${formatServerList(connectedServers)}. Failed: ${failureText}`;
	}
	if (connectedServers.length > 0) {
		return `Connected to MCP ${formatServerCount(connectedServers.length)}: ${formatServerList(connectedServers)}.`;
	}
	return "";
}

/**
 * What the model reads when it asks for an MCP tool that is not mounted while
 * some configured servers are not connected: which servers, the error that
 * ended each one's last connect, and how a person brings them back. Without
 * it a server that failed at startup (an OAuth server with no stored login
 * answers HTTP 401) leaves no trace in the session: its tools are simply
 * absent, and "No such tool" reads like a typo.
 *
 * Two groups, because one sentence cannot be true of both. A server in
 * `unmounted` has no tools in the registry, so "their tools are not mounted"
 * is what the model can see. A server in `servingCachedTools` is down while
 * the catalog cached from its last connect is still mounted — a `lazy`
 * server before its first use, or a server lost mid-session — so that
 * sentence would contradict the tool list; what is true of it, and what
 * explains the miss, is that the cache predates the failure and a tool the
 * server has added or renamed since is not in it.
 *
 * `awaitingLogin` names the listed servers that failed while no OAuth login
 * for them was stored and that the caller is checking for one now; only they
 * get the sentence saying omp reconnects a server once a login turns up.
 */
export function formatMCPUnavailableServersNote(
	unmounted: readonly McpConnectionFailure[],
	servingCachedTools: readonly McpConnectionFailure[],
	awaitingLogin: readonly string[],
): string {
	return prompt.render(unavailableServersTemplate, {
		single: unmounted.length === 1,
		servers: unmounted.map(formatFailedServer).join("; "),
		cachedSingle: servingCachedTools.length === 1,
		cachedServers: servingCachedTools.map(formatFailedServer).join("; "),
		awaitingLogin: formatServerList(awaitingLogin),
	});
}

const McpConnectionStatusEventShape = type({ type: "'connecting'", serverNames: "string[]" })
	.or({ type: "'reconnecting' | 'connected'", serverName: "string" })
	.or({ type: "'failed'", serverName: "string", error: "string", "sourcePath?": "string | undefined" });

/**
 * Runtime validator for the cross-module event payload. The event bus is
 * untyped at runtime, so the subscriber verifies the shape before formatting
 * rather than trusting a cast — a malformed emit is ignored instead of throwing.
 */
export function isMcpConnectionStatusEvent(data: unknown): data is McpConnectionStatusEvent {
	return McpConnectionStatusEventShape.allows(data);
}
