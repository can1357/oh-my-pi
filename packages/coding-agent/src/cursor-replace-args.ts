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
