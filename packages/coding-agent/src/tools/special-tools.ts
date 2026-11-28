import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { PROPOSE_COMMAND_NAME, REJECT_COMMAND_NAME, RESOLVE_COMMAND_NAME } from "./details/resolve";
import { REPORT_ISSUE_COMMAND_NAME } from "./report-issue-command";

/** Names of the special tools: run as commands while `bash` is enabled, presented top-level otherwise. */
export const SPECIAL_TOOL_NAMES: ReadonlySet<string> = new Set([
	RESOLVE_COMMAND_NAME,
	REJECT_COMMAND_NAME,
	PROPOSE_COMMAND_NAME,
	REPORT_ISSUE_COMMAND_NAME,
]);

/** Whether the special tool `name` has something to act on beside the top-level `tools`. */
export function specialToolApplies(
	name: string,
	context: { tools: readonly AgentTool[]; planModeEnabled: boolean },
): boolean {
	switch (name) {
		case RESOLVE_COMMAND_NAME:
		case REJECT_COMMAND_NAME:
			return context.tools.some(tool => tool.deferrable === true);
		case PROPOSE_COMMAND_NAME:
			return context.planModeEnabled;
		default:
			return true;
	}
}
