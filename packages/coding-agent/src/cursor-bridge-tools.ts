/**
 * Per-call tools the Cursor exec bridge needs but the model-facing registry
 * cannot supply.
 *
 * Both bridge callsites — the primary session and the advisor roster — build
 * the same instances, and both must apply the session's approval wrapper. A
 * raw tool here silently escapes the gate every registry call goes through, so
 * the construction lives in one place rather than being repeated per callsite.
 */

import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { EditTool } from "./edit";
import type { ExtensionRunner } from "./extensibility/extensions";
import { ExtensionToolWrapper } from "./extensibility/extensions";
import type { GrepToolOptions, Tool, ToolSession } from "./tools";
import { GrepTool } from "./tools";

/**
 * Build the bridge's `createGrepTool` factory for one tool session.
 *
 * A `pi_grep` frame carries its own context width and total match cap. Neither
 * is expressible in the model-facing `grep` schema — context comes from
 * `grep.contextBefore`/`grep.contextAfter`, fixed when the shared instance is
 * constructed — so honoring them needs a fresh tool per call.
 *
 * The result is wrapped exactly like a registry tool: the approval gate runs on
 * every call site, and a per-call instance is no exception.
 */
export function createBridgeGrepFactory(
	session: ToolSession,
	extensionRunner: ExtensionRunner,
): (options: GrepToolOptions) => AgentTool {
	return options => {
		const grepTool: Tool = new GrepTool(session, options);
		return new ExtensionToolWrapper(grepTool, extensionRunner);
	};
}

/**
 * Build the `replace`-mode `edit` the bridge answers `pi_edit` with.
 *
 * `PiEditExecArgs` carries `old_string`/`new_string` replacements, which is exactly
 * `replace`'s schema and nothing else's. The session's own instance follows the
 * configured `edit.mode` — `hashline` by default, whose schema is a single
 * `input` string — so a frame handed that instance fails validation instead of
 * editing the file.
 *
 * Callers MUST gate this on the session having actually granted `edit`: the
 * tool is constructed rather than looked up, so building one unconditionally
 * hands a restricted agent a mutating tool it was denied (issue #5680).
 */
export function createBridgeEditTool(session: ToolSession, extensionRunner: ExtensionRunner): AgentTool {
	const editTool: Tool = new EditTool(session, "replace");
	return new ExtensionToolWrapper(editTool, extensionRunner);
}

/**
 * The tool map the exec bridge should run, given the map a caller granted.
 *
 * `pi_edit` needs a `replace`-mode instance, but only when `edit` was granted:
 * the tool is constructed rather than looked up, so substituting
 * unconditionally would hand a restricted roster a mutating tool it was denied
 * (issue #5680). The granted map is never mutated: an unsubstituted result is a
 * copy, so a caller without an `edit` grant cannot accidentally gain one.
 *
 * The advisor roster passes its granted map here. The primary session
 * advertises hashline `edit` as MCP and still serves the replace-mode
 * instance through the bridge's `getEditReplaceTool` accessor — not the
 * `getTool` fallback, which doubles as the agent loop's resolver for
 * unadvertised calls and must stay device-only.
 */
export function bridgeToolMap(
	granted: ReadonlyMap<string, AgentTool>,
	createEditTool: (() => AgentTool | undefined) | undefined,
): Map<string, AgentTool> {
	const bridged = new Map(granted);
	if (!granted.has("edit") || !createEditTool) return bridged;
	const bridgeEdit = createEditTool();
	if (bridgeEdit) bridged.set("edit", bridgeEdit);
	return bridged;
}

/**
 * Server-injected Cursor CLI edit names that are not in the OMP registry.
 *
 * Native Ultra edits arrive as `editToolCall`. If that frame is absent, the
 * model still follows the injected instructions and calls these as MCP — which
 * used to 404 and fall through to bash/python string replace.
 */
const CURSOR_STRREPLACE_MCP_NAMES = new Set([
	"StrReplace",
	"str_replace",
	"strReplace",
	"SearchReplace",
	"search_replace",
	"Edit",
]);

function stringArg(args: Record<string, unknown>, key: string): string | undefined {
	const value = args[key];
	return typeof value === "string" ? value : undefined;
}

export function isCursorStrReplaceMcpName(name: string): boolean {
	return CURSOR_STRREPLACE_MCP_NAMES.has(name);
}

/**
 * Project a Cursor CLI / Pi-style replacement payload onto `replace` kwargs.
 *
 * Unknown shapes are returned unchanged so the replace schema still rejects
 * them instead of inventing an empty edit.
 */
export function normalizeCursorReplaceArgs(args: Record<string, unknown>): Record<string, unknown> {
	const path = stringArg(args, "path");
	const old_string =
		stringArg(args, "old_string") ??
		stringArg(args, "old_str") ??
		stringArg(args, "old_text") ??
		stringArg(args, "oldString") ??
		stringArg(args, "oldText");
	const new_string =
		stringArg(args, "new_string") ??
		stringArg(args, "new_str") ??
		stringArg(args, "new_text") ??
		stringArg(args, "newString") ??
		stringArg(args, "newText");
	const replaceAll = args.replace_all ?? args.replaceAll;
	if (path === undefined || old_string === undefined || new_string === undefined) return args;
	return {
		path,
		old_string,
		new_string,
		...(typeof replaceAll === "boolean" ? { replace_all: replaceAll } : {}),
	};
}

/**
 * Whether this MCP invocation should run the replace-mode bridge `edit`.
 *
 * Server-injected names always do. An `edit` call that already carries a
 * hashline `input` stays on the advertised instance. An `edit` call that
 * carries `old_string`/`new_string` (or a Pi/CLI synonym) is the mixed
 * fallback: our tool name plus the server's schema.
 */
export function cursorMcpPrefersReplaceEdit(name: string, args: Record<string, unknown>): boolean {
	if (isCursorStrReplaceMcpName(name)) return true;
	if (name !== "edit") return false;
	if (typeof args.input === "string" || typeof args._input === "string") return false;
	const old_string =
		stringArg(args, "old_string") ??
		stringArg(args, "old_str") ??
		stringArg(args, "old_text") ??
		stringArg(args, "oldString") ??
		stringArg(args, "oldText");
	const new_string =
		stringArg(args, "new_string") ??
		stringArg(args, "new_str") ??
		stringArg(args, "new_text") ??
		stringArg(args, "newString") ??
		stringArg(args, "newText");
	return old_string !== undefined && new_string !== undefined;
}
