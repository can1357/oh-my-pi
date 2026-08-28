import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { ToolCall } from "@oh-my-pi/pi-ai";

const OPERATIONAL_TOOL_NAMES: Record<string, true> = { git: true, github: true, gh: true, graphite: true, gt: true };
const SHELL_TOOL_NAMES: Record<string, true> = { bash: true, shell: true, exec: true, terminal: true };
const COMMAND_BOUNDARY =
	/(?:^|[\n;&|()])\s*(?:(?:command|builtin|exec|nohup|sudo)\s+)*(?:env(?:\s+(?:-[^\s]+|[A-Za-z_][A-Za-z0-9_]*=[^\s]+))*\s+)?(?:git|gh|gt)(?=\s|$)/u;

function stringArgument(arguments_: Record<string, unknown>, key: string): string | undefined {
	const value = arguments_[key];
	return typeof value === "string" ? value : undefined;
}

function isOperationalToolCall(call: ToolCall): boolean {
	const name = call.name.toLowerCase();
	const nameSegments = name.split(/[^a-z0-9]+/u);
	if (nameSegments.some(segment => OPERATIONAL_TOOL_NAMES[segment])) return true;
	if (!nameSegments.some(segment => SHELL_TOOL_NAMES[segment])) return false;
	const command =
		stringArgument(call.arguments, "command") ??
		stringArgument(call.arguments, "cmd") ??
		stringArgument(call.arguments, "script");
	return command !== undefined && COMMAND_BOUNDARY.test(command);
}

/**
 * Removes any assistant message containing a repository-operation call and all
 * results paired with calls from that message. The primary transcript remains
 * unchanged; only the model-visible Advisor view is filtered.
 */
export function filterAdvisorInput(
	messages: readonly AgentMessage[],
	hiddenCallIds = new Set<string>(),
): AgentMessage[] {
	const filtered: AgentMessage[] = [];
	for (const message of messages) {
		if (
			message.role === "assistant" &&
			message.content.some(block => block.type === "toolCall" && isOperationalToolCall(block))
		) {
			for (const block of message.content) {
				if (block.type === "toolCall") hiddenCallIds.add(block.id);
			}
			continue;
		}
		if (message.role === "toolResult" && hiddenCallIds.has(message.toolCallId)) continue;
		filtered.push(message);
	}
	return filtered;
}
