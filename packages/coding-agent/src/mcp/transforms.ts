/**
 * Built-in MCP transforms: what omp does, unasked, to MCP servers it recognizes.
 *
 * {@link BUILTIN_MCP_TRANSFORMS} is the whole policy, one entry per recognized
 * server. The only kind so far is `drop`: a server whose job one of omp's own
 * tools already does is left unconnected. `loadAllMCPConfigs` decides drops from
 * a server's config, before it starts, and reports them so `/mcp list` and the
 * extensions dashboard can say why a configured server is not running.
 *
 * A transform never overrides the user. A server they enabled explicitly
 * (`/mcp enable`, `enabled: true` on its entry, the user `enabledServers` list)
 * is left alone, and `mcp.builtinTransforms: false` turns the table off.
 */
import * as path from "node:path";
import type { MCPServer } from "../capability/mcp";
import type { SourceMeta } from "../capability/types";
import type { Settings } from "../config/settings";
import { cfgEvalJs } from "../eval/settings";
import { cfgMcpBuiltinTransforms } from "./settings";

/** What a session offers natively; a transform reads it to tell whether a server is redundant there. */
export interface MCPTransformContext {
	/** The eval tool is active and runs JavaScript. */
	evalJs: boolean;
}

/** Leaves a recognized server unconnected while a built-in does its job. */
export interface MCPDropTransform {
	kind: "drop";
	/** Stable id, for logs. */
	id: string;
	/** Why the server is redundant; `/mcp list` shows it beside the server's name. */
	reason: string;
	/** Recognizes the server from its config. Never from its name alone: that is the user's to choose. */
	matches(server: MCPServer): boolean;
	/** Whether the built-in that replaces the server is available. */
	when(context: MCPTransformContext): boolean;
}

/** One entry of {@link BUILTIN_MCP_TRANSFORMS}; a union so other kinds can join `drop`. */
export type MCPBuiltinTransform = MCPDropTransform;

/** A server a built-in drop kept from connecting. */
export interface MCPDroppedServer {
	/** The {@link MCPDropTransform.reason} of the drop that applied. */
	reason: string;
	/** Where the dropped entry was configured. */
	source: SourceMeta;
}

/**
 * Codex Desktop's bundled Node REPL (`…/cua_node/…/bin/node_repl[.exe]`), which Codex
 * registers in `~/.codex/config.toml`. Outside Codex it is a second, separate
 * JavaScript kernel beside eval's.
 */
const CODEX_NODE_REPL: MCPDropTransform = {
	kind: "drop",
	id: "codex-node-repl",
	reason: "eval already runs JavaScript in a persistent kernel",
	matches: server => {
		if (!server.command || (server.transport ?? "stdio") !== "stdio") return false;
		// `win32` splits on both separators, so a Windows path is recognized on any host.
		return path.win32.parse(server.command).name.toLowerCase() === "node_repl";
	},
	when: context => context.evalJs,
};

/** Every built-in transform; the first entry that matches a server applies. */
export const BUILTIN_MCP_TRANSFORMS: readonly MCPBuiltinTransform[] = [CODEX_NODE_REPL];

/** The drop that applies to `server` in a session offering `context`, if any. */
export function builtinDropFor(server: MCPServer, context: MCPTransformContext): MCPDropTransform | undefined {
	return BUILTIN_MCP_TRANSFORMS.find(transform => transform.when(context) && transform.matches(server));
}

/**
 * The transform context of a session, for `loadAllMCPConfigs`' `builtinTransforms`
 * option; `undefined` (no transform applies) when `mcp.builtinTransforms` is off.
 */
export function resolveMCPTransformContext(
	settings: Settings,
	session: { evalActive: boolean },
): MCPTransformContext | undefined {
	if (!cfgMcpBuiltinTransforms.get(settings)) return undefined;
	return { evalJs: session.evalActive && cfgEvalJs.get(settings) };
}
