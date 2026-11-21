/**
 * Tool doc topics: the per-tool reference pages a tool description links, read
 * through `help://<tool>/<topic>`.
 */
import type { ToolSession } from "./index";

/** URL prefix of tool doc topics. */
export const HELP_URL_PREFIX = "help://";

/**
 * Whether the session can open `help://<tool>/<topic>` doc topics: `read` is their only
 * transport. A tool whose description links a topic inlines it instead when this is false.
 */
export function docTopicsReadable(session: Pick<ToolSession, "isToolActive">): boolean {
	return session.isToolActive?.("read") !== false;
}

/** Parses `help://`, `help://<tool>` and `help://<tool>/<topic>`; null for anything else. */
export function parseHelpUrl(input: string): { tool: string | null; topic: string | null } | null {
	const trimmed = input.trim();
	if (!trimmed.toLowerCase().startsWith(HELP_URL_PREFIX)) return null;
	const match = /^(?:([^/?#\s]+)(?:\/([^/?#\s]+))?\/?)?$/.exec(trimmed.slice(HELP_URL_PREFIX.length));
	if (!match) return null;
	return { tool: match[1] ?? null, topic: match[2] ?? null };
}
