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

/**
 * Longest any one field — a server name, an error, a config path — may be
 * in a rendered MCP status string, in code points.
 *
 * A width cap does not bound a string's size: a name made of zero-width
 * code points occupies no columns at all, and the unavailable-servers note
 * is read by the model, where the cost is characters rather than terminal
 * cells. A 100,045-character server name rendered a 200,511-character
 * note, which is larger than most of what it was explaining.
 *
 * 256 because every mainstream filesystem caps a path component at 255
 * bytes, and server names come from config files and extension directory
 * names: a name that could have been a file name renders whole. It is also
 * over five times the longest name these renderers are tested with (45),
 * so the note's last sentence — type `/mcp reconnect <server>` — still
 * carries a name a person can use. Beyond it the note grows only with the
 * number of configured servers.
 */
const MCP_STATUS_FIELD_CHARS = 256;

/** `text` cut to `maxChars` code points, with an explicit elision marker. */
function elideBeyondChars(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	// Code points, not UTF-16 units: a cut between a surrogate pair would
	// leave a lone surrogate in the model's context.
	const points = [...text];
	return points.length <= maxChars ? text : `${points.slice(0, maxChars).join("")}…`;
}

function sanitizeMcpStatusText(value: string, maxWidth?: number): string {
	const text = shortenEmbeddedPaths(
		replaceTabs(sanitizeText(value))
			.replace(/[\r\n]+/g, " ")
			.trim(),
	);
	const safe = text.length > 0 ? text : "(unnamed)";
	return elideBeyondChars(maxWidth === undefined ? safe : truncateToWidth(safe, maxWidth), MCP_STATUS_FIELD_CHARS);
}

/**
 * A server name for display.
 *
 * `whole` keeps the name at its full width. The status line is one
 * terminal line and nobody retypes a name from it, so there it stays
 * capped at {@link TRUNCATE_LENGTHS.SHORT}; the unavailable-servers note is
 * the other case, because its next sentence tells the model to run
 * `/mcp reconnect <server>`. A name cut at 40 columns makes that command
 * wrong, and two longer names that share a prefix render as the same
 * string, so the note cannot even say which server it means. Server names
 * come from config files and have no length limit; control characters,
 * tabs, newlines and home paths are removed above, and
 * {@link MCP_STATUS_FIELD_CHARS} still bounds what one name can cost.
 */
function sanitizeMcpServerName(serverName: string, whole = false): string {
	return sanitizeMcpStatusText(serverName, whole ? undefined : TRUNCATE_LENGTHS.SHORT);
}

function formatServerList(serverNames: readonly string[], whole = false): string {
	return serverNames.map(name => sanitizeMcpServerName(name, whole)).join(", ");
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

function formatFailedServer({ serverName, error, sourcePath }: McpConnectionFailure, whole = false): string {
	const source = sourcePath
		? ` [config: ${sanitizeMcpStatusText(shortenPath(sourcePath), TRUNCATE_LENGTHS.CONTENT)}]`
		: "";
	return `${sanitizeMcpServerName(serverName, whole)}${source}: ${sanitizeMcpStatusError(error)}`;
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
			parts.push(`Failed: ${failedServers.map(failure => formatFailedServer(failure)).join("; ")}.`);
		}
		parts.push(`Still connecting: ${formatServerList(pendingServers)}…`);
		return parts.join(" ");
	}
	if (failedServers.length > 0) {
		const failureText = failedServers.map(failure => formatFailedServer(failure)).join("; ");
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
 * `awaitingLogin` names the listed servers whose last attempt the server
 * refused with an auth challenge and that the caller is checking the
 * credential store for now; only they get the sentence saying omp
 * reconnects a server once a login it has not tried turns up.
 *
 * Server names are rendered whole here, unlike in the status line: the note
 * ends by telling the model to type `/mcp reconnect <server>`. Whole means
 * at full width, not unbounded — every field is still capped at
 * {@link MCP_STATUS_FIELD_CHARS} code points, so the note the model reads
 * grows with the number of servers that are down and with nothing else.
 */
export function formatMCPUnavailableServersNote(
	unmounted: readonly McpConnectionFailure[],
	servingCachedTools: readonly McpConnectionFailure[],
	awaitingLogin: readonly string[],
): string {
	return prompt.render(unavailableServersTemplate, {
		single: unmounted.length === 1,
		servers: unmounted.map(failure => formatFailedServer(failure, true)).join("; "),
		cachedSingle: servingCachedTools.length === 1,
		cachedServers: servingCachedTools.map(failure => formatFailedServer(failure, true)).join("; "),
		awaitingLogin: formatServerList(awaitingLogin, true),
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
