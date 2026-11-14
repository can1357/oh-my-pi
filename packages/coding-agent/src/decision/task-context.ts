/**
 * Bounded earlier messages for a referential follow-up ("do that", "go ahead"), so a judge can tell
 * what the request points at. A request that stands on its own gets no context.
 */
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";

export const TASK_CONTEXT_LIMITS = {
	messages: 4,
	messageChars: 1500,
	scannedMessages: 64,
	requestChars: 512,
} as const;

export interface TaskContextMessage {
	source: "earlier-user" | "unverified-assistant";
	text: string;
	truncated: boolean;
}

export interface TaskContext {
	messages: TaskContextMessage[];
}

const FOLLOW_UP =
	/^(?:(?:ok(?:ay)?|yes|sure|please)[,!.?\s]+)*(?:(?:can you\s+)?(?:do|fix|implement|apply|test|review|check|deploy|run|finish|work on)\s+(?:it|that|this|them|these|those|all of (?:that|this|it|them|those))\b|(?:go ahead|continue|proceed|carry on)\b|yes(?:\s+please)?[.!?\s]*$)/iu;

/** Whether `request` only refers to earlier work instead of stating a task of its own. */
export function isFollowUpRequest(request: string): boolean {
	return request.length <= TASK_CONTEXT_LIMITS.requestChars && FOLLOW_UP.test(request.trim());
}

function messageText(message: AgentMessage): string {
	if (message.role !== "user" && message.role !== "assistant") return "";
	const content = message.content;
	if (typeof content === "string") return content;
	return content.flatMap(part => (part.type === "text" ? [part.text] : [])).join("\n");
}

function clip(text: string): string {
	const limit = TASK_CONTEXT_LIMITS.messageChars;
	if (text.length <= limit) return text;
	const half = Math.floor((limit - 20) / 2);
	return `${text.slice(0, half)}\n[...omitted...]\n${text.slice(-half)}`;
}

/**
 * Earlier messages that resolve a follow-up `request`, oldest first: user requests back to the
 * last one that states a task, plus the latest completed assistant reply. `undefined` unless
 * `request` is a follow-up with an earlier user request to resolve against.
 */
export function buildTaskContext(request: string, history: readonly AgentMessage[]): TaskContext | undefined {
	if (!isFollowUpRequest(request)) return undefined;
	const start = Math.max(0, history.length - TASK_CONTEXT_LIMITS.scannedMessages);
	const selected: TaskContextMessage[] = [];
	let assistantAdded = false;
	let hasUser = false;
	for (let index = history.length - 1; index >= start && selected.length < TASK_CONTEXT_LIMITS.messages; index--) {
		const message = history[index]!;
		if (message.role === "user" && (message.synthetic || message.attribution === "agent")) continue;
		if (message.role === "assistant" && (assistantAdded || message.stopReason !== "stop")) continue;
		const text = Bun.stripANSI(messageText(message)).trim();
		if (!text) continue;
		selected.push({
			source: message.role === "user" ? "earlier-user" : "unverified-assistant",
			text: clip(text),
			truncated: text.length > TASK_CONTEXT_LIMITS.messageChars,
		});
		if (message.role === "assistant") {
			assistantAdded = true;
			continue;
		}
		hasUser = true;
		if (!isFollowUpRequest(text)) break;
	}
	return hasUser ? { messages: selected.reverse() } : undefined;
}
