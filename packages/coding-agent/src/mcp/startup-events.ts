import { t as __ompTranslate } from "@oh-my-pi/pi-utils/i18n";
import { isRecord, sanitizeText } from "@oh-my-pi/pi-utils";
import {
	replaceTabs,
	shortenEmbeddedPaths,
	shortenPath,
	TRUNCATE_LENGTHS,
	truncateToWidth,
} from "@oh-my-pi/pi-tui/render/render-utils";

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
	return truncateToWidth(text.length > 0 ? text : __ompTranslate("(unnamed)"), maxWidth);
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
	return __ompTranslate("Connecting to MCP servers: {0}…", `${formatServerList(serverNames)}`);
}

function formatFailedServer({ serverName, error, sourcePath }: McpConnectionFailure): string {
	const source = sourcePath
		? __ompTranslate(" [config: {0}]", `${sanitizeMcpStatusText(shortenPath(sourcePath), TRUNCATE_LENGTHS.CONTENT)}`)
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
			parts.push(__ompTranslate("Connected: {0}.", `${formatServerList(connectedServers)}`));
		}
		if (failedServers.length > 0) {
			parts.push(__ompTranslate("Failed: {0}.", `${failedServers.map(formatFailedServer).join("; ")}`));
		}
		parts.push(__ompTranslate("Still connecting: {0}…", `${formatServerList(pendingServers)}`));
		return parts.join(" ");
	}
	if (failedServers.length > 0) {
		const failureText = failedServers.map(formatFailedServer).join("; ");
		if (connectedServers.length === 0) {
			return __ompTranslate(
				"MCP {0} failed to connect: {1}",
				`${formatServerCount(failedServers.length)}`,
				`${failureText}`,
			);
		}
		return __ompTranslate(
			"MCP finished with failures. Connected: {0}. Failed: {1}",
			`${formatServerList(connectedServers)}`,
			`${failureText}`,
		);
	}
	if (connectedServers.length > 0) {
		return __ompTranslate(
			"Connected to MCP {0}: {1}.",
			`${formatServerCount(connectedServers.length)}`,
			`${formatServerList(connectedServers)}`,
		);
	}
	return "";
}

function isStringArray(data: unknown): data is string[] {
	return Array.isArray(data) && data.every(item => typeof item === "string");
}

/**
 * Runtime validator for the cross-module event payload. The event bus is
 * untyped at runtime, so the subscriber verifies the shape before formatting
 * rather than trusting a cast — a malformed emit is ignored instead of throwing.
 */
export function isMcpConnectionStatusEvent(data: unknown): data is McpConnectionStatusEvent {
	if (!isRecord(data) || typeof data.type !== "string") return false;
	switch (data.type) {
		case "connecting":
			return isStringArray(data.serverNames);
		case "reconnecting":
			return typeof data.serverName === "string";
		case "connected":
			return typeof data.serverName === "string";
		case "failed":
			return (
				typeof data.serverName === "string" &&
				typeof data.error === "string" &&
				(data.sourcePath === undefined || typeof data.sourcePath === "string")
			);
		default:
			return false;
	}
}
