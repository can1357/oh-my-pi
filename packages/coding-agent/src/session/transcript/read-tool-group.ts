import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { InternalUrlRouter } from "../../internal-urls/router";
import { splitUrlScheme } from "../../internal-urls/url-scheme";
import { canonicalizeMessage } from "./thinking-display";

/**
 * Extract the read call's target path. `path` is the canonical arg; `file_path`
 * is the legacy alias still tolerated by the read tool schema.
 */
function readArgsTarget(args: unknown): string | undefined {
	if (!args || typeof args !== "object" || Array.isArray(args)) return undefined;
	const record = args as Record<string, unknown>;
	return typeof record.path === "string"
		? record.path
		: typeof record.file_path === "string"
			? record.file_path
			: undefined;
}

export function readArgsHaveTarget(args: unknown): boolean {
	return readArgsTarget(args) !== undefined;
}

/**
 * Whether a read joins the compact read group rather than a full tool card. Filesystem and
 * external targets always do; registered internal-URL schemes draw full so their resolved content
 * shows, unless their spec declares `compactTranscript` (device listings, docs).
 */
export function readArgsCollapseIntoGroup(args: unknown): boolean {
	const target = readArgsTarget(args);
	if (target === undefined) return false;
	const url = splitUrlScheme(target);
	const spec = url && InternalUrlRouter.instance().spec(url.scheme);
	return !spec || spec.compactTranscript === true;
}

/**
 * The grouped read calls that can own a turn's usage row. Mixed-tool turns and visible content
 * after a read keep the standalone row so request metrics keep their transcript order.
 */
export function groupedReadUsageCallIds(message: AssistantMessage): string[] | undefined {
	const toolCallIds: string[] = [];
	let sawToolCall = false;
	for (const content of message.content) {
		if (content.type === "toolCall") {
			if (content.name !== "read" || !readArgsCollapseIntoGroup(content.arguments)) return undefined;
			sawToolCall = true;
			toolCallIds.push(content.id);
			continue;
		}
		if (
			sawToolCall &&
			(content.type === "image" ||
				(content.type === "text" && canonicalizeMessage(content.text)) ||
				(content.type === "thinking" && canonicalizeMessage(content.thinking)))
		) {
			return undefined;
		}
	}
	return toolCallIds.length > 0 ? toolCallIds : undefined;
}
