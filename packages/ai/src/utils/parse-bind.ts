/**
 * Shared `host:port` parser used by the auth-broker and auth-gateway boot
 * paths. Centralized so the two servers can't drift on what they accept (the
 * gateway used to silently allow empty hostnames; this fixes it).
 */

import * as AIError from "../error";

export interface ParsedBind {
	hostname: string;
	port: number;
}

function parsePort(raw: string, bind: string): number {
	if (!/^\d+$/.test(raw)) {
		throw new AIError.ConfigurationError(`Invalid bind '${bind}'; port must be an integer.`);
	}
	const port = Number.parseInt(raw, 10);
	if (!Number.isFinite(port) || port < 0 || port > 65535) {
		throw new AIError.ConfigurationError(`Invalid bind '${bind}'; port out of range.`);
	}
	return port;
}

/**
 * Parse a `host:port` (or bare `port`, which assumes loopback) string.
 *
 * Accepts:
 *   - `"4000"`            → `127.0.0.1:4000`
 *   - `"0.0.0.0:4000"`    → as written
 *   - `"[::1]:4000"`      → as written (brackets retained, Bun handles them)
 *
 * Rejects:
 *   - empty input
 *   - empty hostname (`":4000"`)
 *   - non-integer / out-of-range port
 */
export function parseBind(raw: string): ParsedBind {
	const trimmed = raw.trim();
	if (trimmed.length === 0) {
		throw new AIError.ConfigurationError("Invalid bind; expected 'host:port' or 'port'.");
	}
	if (/^\d+$/.test(trimmed)) {
		return { hostname: "127.0.0.1", port: parsePort(trimmed, raw) };
	}
	const lastColon = trimmed.lastIndexOf(":");
	if (lastColon < 0) {
		throw new AIError.ConfigurationError(`Invalid bind '${raw}'; expected 'host:port' or 'port'.`);
	}
	const hostPart = trimmed.slice(0, lastColon);
	const portPart = trimmed.slice(lastColon + 1);
	if (hostPart.length === 0) {
		throw new AIError.ConfigurationError(`Invalid bind '${raw}'; host must not be empty.`);
	}
	return { hostname: hostPart, port: parsePort(portPart, raw) };
}
