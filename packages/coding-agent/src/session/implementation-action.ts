import { isRecord } from "@oh-my-pi/pi-utils";

/**
 * Minimal completed-tool-result shape needed to classify a workspace-mutating
 * implementation action. Both a turn-level `ToolResultMessage` and a nested
 * eval-bridge tool result satisfy it.
 */
export interface ImplementationActionResult {
	toolName: string;
	details: unknown;
}

/** Tool names whose successful completion mutates the workspace. */
const IMPLEMENTATION_ACTION_TOOLS: Record<string, true> = {
	edit: true,
	write: true,
};

/**
 * Whether a completed tool result is a workspace-mutating implementation action.
 * A direct `edit`/`write` call always counts; a `write` that dispatched an
 * `xd://` device (e.g. `lsp`, `ast_edit`, `debug`) counts only when the wrapped
 * tool resolved to a `write`/`exec` approval tier. Read-only device calls — LSP
 * navigation, `debug` inspection, `ast_edit` on internal URLs, help lookups —
 * leave the tier `read` (or absent) and are not implementation actions (issue #7312).
 */
export function isImplementationActionResult(result: ImplementationActionResult): boolean {
	if (!IMPLEMENTATION_ACTION_TOOLS[result.toolName]) return false;
	const details = result.details;
	// A direct filesystem edit/write carries no `xd://` dispatch metadata.
	if (!isRecord(details) || !("xdev" in details) || !details.xdev) return true;
	const xdev = details.xdev;
	// Device dispatch: switch only on a genuine mutation tier. An absent tier
	// (help lookup, unresolved approval) declines the switch.
	if (!isRecord(xdev) || !("tier" in xdev)) return false;
	return xdev.tier === "write" || xdev.tier === "exec";
}
