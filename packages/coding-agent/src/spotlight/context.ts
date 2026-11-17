import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { Message } from "@oh-my-pi/pi-ai";
import { isRecord } from "@oh-my-pi/pi-utils";
import { INTENT_FIELD } from "@oh-my-pi/pi-wire";
import { type CallContext, CONTEXT_FIELD_CHARS } from "./types";

/** Earlier bash commands a {@link CallContext} carries. */
const CONTEXT_COMMANDS = 3;

/**
 * What the agent is doing at the tool call `toolCallId`, read from the session's live messages: the first user
 * message (the task), the text of the call's assistant turn before the call, and the last bash commands before it.
 * Fields are cut to {@link CONTEXT_FIELD_CHARS}; `said` keeps its end, the others their start.
 */
export function buildCallContext(
	messages: readonly AgentMessage[],
	toolCallId: string,
	source: string,
	intent: string | undefined,
): CallContext {
	let task = "";
	for (const message of messages) {
		if (message.role !== "user" || message.synthetic) continue;
		const content = message.content;
		task = (
			typeof content === "string"
				? content
				: content.map(block => (block.type === "text" ? block.text : "")).join("\n")
		).trim();
		if (task) break;
	}

	// The call's own assistant message is the newest one while it runs; without it every message is earlier.
	let callIndex = messages.length;
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message.role === "assistant" && message.content.some(b => b.type === "toolCall" && b.id === toolCallId)) {
			callIndex = index;
			break;
		}
	}

	let said = "";
	const commands: string[] = [];
	for (let index = Math.min(callIndex, messages.length - 1); index >= 0; index--) {
		const message = messages[index];
		if (message.role !== "assistant") continue;
		const turnCommands: string[] = [];
		const turnText: string[] = [];
		for (const block of message.content) {
			if (block.type === "toolCall") {
				if (block.id === toolCallId) break;
				if (block.name === "bash" && typeof block.arguments.command === "string") {
					turnCommands.push(block.arguments.command);
				}
			} else if (block.type === "text") {
				turnText.push(block.text);
			}
		}
		if (index === callIndex) said = turnText.join("").trim();
		for (let i = turnCommands.length - 1; i >= 0 && commands.length < CONTEXT_COMMANDS; i--) {
			commands.push(cut(turnCommands[i]));
		}
		if (commands.length >= CONTEXT_COMMANDS) break;
	}
	commands.reverse();

	return {
		task: cut(task),
		said: said.length > CONTEXT_FIELD_CHARS ? said.slice(said.length - CONTEXT_FIELD_CHARS) : said,
		intent: cut(intent?.trim() ?? ""),
		commands,
		source: cut(source),
	};
}

/**
 * A call as Spotlight's `source` and the shaping state's command: the tool's name and its arguments as JSON
 * (`grep {"pattern":"TODO","path":"src"}`), the intent left out (the state carries it); the bare name without any.
 */
export function callSummary(tool: string, args: unknown): string {
	if (!isRecord(args)) return tool;
	const rest: Record<string, unknown> = {};
	let hasArgs = false;
	for (const key in args) {
		if (key === INTENT_FIELD) continue;
		rest[key] = args[key];
		hasArgs = true;
	}
	if (!hasArgs) return tool;
	try {
		return `${tool} ${JSON.stringify(rest)}`;
	} catch {
		return tool;
	}
}

/**
 * The command a call counts as having shown the agent, as shaping notes it: `bash`'s command, `eval`'s code, any other
 * tool's {@link callSummary}; none for `read`, whose path says nothing its result repeats.
 */
export function callCommand(tool: string, args: unknown): string | undefined {
	if (tool === "read") return undefined;
	if (tool === "bash" && isRecord(args) && typeof args.command === "string") return args.command;
	if (tool === "eval" && isRecord(args) && typeof args.code === "string") return args.code;
	return callSummary(tool, args);
}

/**
 * The text one message of the model's context puts in front of it, as the shaping state counts lines seen: what the
 * user and the tools said, the assistant's text and the commands of its calls ({@link callCommand}).
 */
export function messageTexts(message: Message): string[] {
	const content = message.content;
	if (typeof content === "string") return [content];
	const out: string[] = [];
	for (const block of content) {
		if (block.type === "text") out.push(block.text);
		else if (block.type === "toolCall") {
			const command = callCommand(block.name, block.arguments);
			if (command) out.push(command);
		}
	}
	return out;
}

function cut(text: string): string {
	return text.length > CONTEXT_FIELD_CHARS ? text.slice(0, CONTEXT_FIELD_CHARS) : text;
}
