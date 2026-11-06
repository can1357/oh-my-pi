import { type } from "@oh-my-pi/omptype";
import { prompt, sanitizeText } from "@oh-my-pi/pi-utils";
import {
	replaceTabs,
	shortenEmbeddedPaths,
	shortenPath,
	TRUNCATE_LENGTHS,
	truncateToWidth,
} from "@oh-my-pi/pi-tui/render/render-utils";
import { getSegmenter } from "@oh-my-pi/pi-tui/utils";
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

/**
 * Longest the whole unavailable-servers note may be, in code points.
 *
 * {@link MCP_STATUS_FIELD_CHARS} bounds one field, which is not a bound on
 * the note: the note names every server that is down, so it grew without
 * limit in their number. Measured with names of zero-width code points:
 * 1 server rendered 2,499 UTF-16 units, 10 rendered 21,042, 100 rendered
 * 206,262, and 1,000 rendered 2,056,662 units (1,045,442 code points) in
 * about 489 ms — the thing explaining one missing tool, orders of
 * magnitude larger than the context it is explaining.
 *
 * 4096 because one listed server costs at most three capped fields plus
 * their punctuation (≈ 790 code points), so even an all-pathological list
 * still names five servers in full, while realistic entries (≈ 60 code
 * points) put around sixty of them in one note — more servers than any
 * configuration these renderers have been seen against. In tokens that is
 * roughly a thousand: the size of one large tool result, which is what
 * this note competes with for the context it is written into. Whatever
 * does not fit is replaced by a count of what was left out, so a
 * truncated list is never read as a complete one.
 */
const MCP_STATUS_NOTE_CHARS = 4_096;

/** Marks a field or a list that one of the bounds above cut short. */
const ELISION_MARKER = "…";
/** Between bare server names. */
const NAME_SEPARATOR = ", ";
/** Between `name [config: path]: error` entries. */
const ENTRY_SEPARATOR = "; ";

const GRAPHEMES = getSegmenter();

/** `text` measured in code points, without materialising them. */
function countChars(text: string): number {
	let chars = 0;
	for (const _ of text) chars++;
	return chars;
}

const ELISION_MARKER_CHARS = countChars(ELISION_MARKER);

/**
 * `text` within `maxChars` code points — the marker included, so the bound
 * is the bound — cut only at a grapheme boundary.
 *
 * Code points rather than UTF-16 units because a cut between a surrogate
 * pair leaves a lone surrogate in the model's context. Grapheme clusters
 * rather than code points because a cut inside one is the same defect one
 * level up: cutting at 256 took the accent off `é` (`e` + U+0301) at the
 * end of a name, and left `👩‍💻` as `👩` with a dangling zero-width joiner
 * in front of the marker. A cluster that does not fit is dropped whole.
 *
 * Two names that differ only past `maxChars` render alike. That is the
 * accepted cost of bounding what one name can spend of the model's
 * context, and `docs/mcp-runtime-lifecycle.md` says so.
 */
function elideBeyondChars(text: string, maxChars: number): string {
	// UTF-16 units are never fewer than code points, so this fast path is exact.
	if (text.length <= maxChars) return text;
	if (countChars(text) <= maxChars) return text;
	const budget = maxChars - ELISION_MARKER_CHARS;
	let kept = 0;
	let used = 0;
	for (const { segment, index } of GRAPHEMES.segment(text)) {
		const size = countChars(segment);
		if (used + size > budget) break;
		used += size;
		kept = index + segment.length;
	}
	return `${text.slice(0, kept)}${ELISION_MARKER}`;
}

/**
 * `items` rendered into at most `budget` code points, with a tail naming
 * how many were left out: `alpha, beta, and 998 more`.
 *
 * Rendering is lazy, so a note that lists five of a thousand down servers
 * sanitises five: the cost of the bound stays off the ordinary path, where
 * everything fits.
 *
 * The bound is exact. When not even the first entry fits whole it is
 * elided to what there is, rather than taken over budget or dropped: a
 * list that named nobody would leave the model a count and no server to
 * act on.
 */
function joinWithinBudget<T>(
	items: readonly T[],
	render: (item: T) => string,
	separator: string,
	budget: number,
): { text: string; chars: number } {
	if (items.length === 0) return { text: "", chars: 0 };
	// Reserved against the largest count this list could report, so the
	// tail itself is never what pushes the note past the bound.
	const reserved = separator.length + `and ${items.length} more`.length;
	const taken: string[] = [];
	let chars = 0;
	for (const item of items) {
		const rendered = render(item);
		const cost = countChars(rendered) + (taken.length > 0 ? separator.length : 0);
		const isLast = taken.length === items.length - 1;
		if (chars + cost + (isLast ? 0 : reserved) > budget) break;
		taken.push(rendered);
		chars += cost;
	}
	if (taken.length === 0) {
		const allowance = budget - (items.length > 1 ? reserved : 0);
		if (allowance > 0) {
			const only = elideBeyondChars(render(items[0]!), allowance);
			taken.push(only);
			chars += countChars(only);
		}
	}
	const omitted = items.length - taken.length;
	if (omitted === 0) return { text: taken.join(separator), chars };
	const tail = taken.length > 0 ? `${separator}and ${omitted} more` : `and ${omitted} more`;
	return { text: `${taken.join(separator)}${tail}`, chars: chars + tail.length };
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
 * tabs, newlines and home paths are removed above,
 * {@link MCP_STATUS_FIELD_CHARS} bounds what one name can cost, and
 * {@link MCP_STATUS_NOTE_CHARS} bounds what all of them together can.
 */
function sanitizeMcpServerName(serverName: string, whole = false): string {
	return sanitizeMcpStatusText(serverName, whole ? undefined : TRUNCATE_LENGTHS.SHORT);
}

/** Names for the one-line status, where each is capped at its width. */
function formatServerList(serverNames: readonly string[]): string {
	return serverNames.map(name => sanitizeMcpServerName(name)).join(NAME_SEPARATOR);
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
			parts.push(`Failed: ${failedServers.map(failure => formatFailedServer(failure)).join(ENTRY_SEPARATOR)}.`);
		}
		parts.push(`Still connecting: ${formatServerList(pendingServers)}…`);
		return parts.join(" ");
	}
	if (failedServers.length > 0) {
		const failureText = failedServers.map(failure => formatFailedServer(failure)).join(ENTRY_SEPARATOR);
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

/** The servers an unavailable-tool note has to account for. */
export interface McpUnavailableServers {
	/** Down, with no tools of theirs in the registry. */
	readonly unmounted: readonly McpConnectionFailure[];
	/** Down while the catalog cached from an earlier connect stays mounted. */
	readonly servingCachedTools: readonly McpConnectionFailure[];
	/** Listed servers whose stored login the caller is checking right now. */
	readonly awaitingLogin: readonly string[];
	/** Listed servers whose login check waits for reconnects to resume. */
	readonly loginCheckSuspended: readonly string[];
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
 * A server whose last attempt was refused with an auth challenge is in
 * exactly one of the last two lists, and they say different things because
 * different things are true. `awaitingLogin` is being checked against the
 * credential store as this note is written. `loginCheckSuspended` is not:
 * the crash-storm breaker is refusing its reconnects, so the check that
 * would act on a login found there cannot run yet. Promising both the same
 * check would describe, for the second, something that is being refused on
 * arrival.
 *
 * Server names are rendered whole here, unlike in the status line: the note
 * ends by telling the model to type `/mcp reconnect <server>`. Whole means
 * at full width, not unbounded — every field is capped at
 * {@link MCP_STATUS_FIELD_CHARS} code points and the note itself at
 * {@link MCP_STATUS_NOTE_CHARS}, past which a list stops and says how many
 * servers it did not name.
 */
export function formatMCPUnavailableServersNote(servers: McpUnavailableServers): string {
	const { unmounted, servingCachedTools, awaitingLogin, loginCheckSuspended } = servers;
	const counts = {
		single: unmounted.length === 1,
		cachedSingle: servingCachedTools.length === 1,
		suspendedSingle: loginCheckSuspended.length === 1,
	};
	// What the note costs before a single server is named, measured by
	// rendering it with a one-code-point stand-in wherever a list will go:
	// the sections that fire for the real lists are exactly these.
	let pending = [unmounted, servingCachedTools, awaitingLogin, loginCheckSuspended].filter(
		list => list.length > 0,
	).length;
	const skeleton = prompt.render(unavailableServersTemplate, {
		...counts,
		servers: unmounted.length > 0 ? "x" : "",
		cachedServers: servingCachedTools.length > 0 ? "x" : "",
		awaitingLogin: awaitingLogin.length > 0 ? "x" : "",
		suspendedLogin: loginCheckSuspended.length > 0 ? "x" : "",
	});
	let budget = Math.max(0, MCP_STATUS_NOTE_CHARS - (countChars(skeleton) - pending));
	// Each list takes an equal share of what is left and hands back what it
	// does not spend, so one pathological group cannot starve the others.
	const take = <T>(items: readonly T[], render: (item: T) => string, separator: string): string => {
		if (items.length === 0) return "";
		const { text, chars } = joinWithinBudget(items, render, separator, Math.floor(budget / pending));
		budget -= chars;
		pending -= 1;
		return text;
	};
	return prompt.render(unavailableServersTemplate, {
		...counts,
		servers: take(unmounted, failure => formatFailedServer(failure, true), ENTRY_SEPARATOR),
		cachedServers: take(servingCachedTools, failure => formatFailedServer(failure, true), ENTRY_SEPARATOR),
		awaitingLogin: take(awaitingLogin, name => sanitizeMcpServerName(name, true), NAME_SEPARATOR),
		suspendedLogin: take(loginCheckSuspended, name => sanitizeMcpServerName(name, true), NAME_SEPARATOR),
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
