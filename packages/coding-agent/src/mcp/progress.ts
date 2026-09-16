/**
 * MCP progress tokens.
 *
 * A request that carries `params._meta.progressToken` invites the server to
 * report `notifications/progress` while it works. Those notifications are what
 * keep a long-running call from tripping the client's request deadline: a tool
 * that legitimately blocks for minutes (a host waiting on a person, a slow
 * build) stays alive as long as the server keeps saying it is still working,
 * bounded by `OMP_MCP_MAX_TIMEOUT_MS`.
 *
 * The request id doubles as its progress token, so a notification maps back to
 * exactly one pending request without a second registry.
 */
import { isRecord } from "@oh-my-pi/pi-utils";

export type MCPProgressToken = string | number;

/**
 * Attach `id` as this request's progress token, preserving any `_meta` the
 * caller already set.
 */
export function withProgressToken(
	params: Record<string, unknown> | undefined,
	id: MCPProgressToken,
): Record<string, unknown> {
	const meta = isRecord(params?._meta) ? params._meta : undefined;
	if (meta !== undefined && "progressToken" in meta) return params ?? {};
	return {
		...params,
		_meta: { ...meta, progressToken: id },
	};
}

/** Read the progress token off a `notifications/progress` payload. */
export function readProgressToken(params: unknown): MCPProgressToken | null {
	if (!isRecord(params)) return null;
	const token = params.progressToken;
	return typeof token === "string" || typeof token === "number" ? token : null;
}

/**
 * Look up the pending entry a progress notification belongs to. Servers are
 * free to echo a numeric token as a string (and vice versa), so accept the
 * other spelling rather than dropping the keepalive.
 */
export function findByProgressToken<T>(pending: Map<MCPProgressToken, T>, token: MCPProgressToken): T | undefined {
	const direct = pending.get(token);
	if (direct !== undefined) return direct;
	if (typeof token === "string") {
		const numeric = Number(token);
		return token.trim() === "" || Number.isNaN(numeric) ? undefined : pending.get(numeric);
	}
	return pending.get(String(token));
}
