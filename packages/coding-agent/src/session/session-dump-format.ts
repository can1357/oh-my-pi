/**
 * Plain-text / markdown session formatting for `/dump` and `/advisor dump raw`.
 *
 * Renders a prelude (system prompt, model/thinking config, tool inventory)
 * followed by the message history as per-message markdown headings: `## User`,
 * `## Assistant` (with `<thinking>` blocks and `### Tool Call: <name>` + YAML
 * args), `### Tool Result: <name>`, and the execution/summary sections.
 * `/dump all` renders each persisted subagent as its own `# Subagent: <path>` document.
 */
import type { AgentMessage, ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Model, ToolExample, TSchema } from "@oh-my-pi/pi-ai";
import { renderDelimitedThinking, renderToolInventory } from "@oh-my-pi/pi-ai/dialect";
import { INTENT_FIELD } from "@oh-my-pi/pi-wire";
import { YAML } from "bun";
import { canonicalizeMessage } from "@oh-my-pi/pi-tui/chat/thinking-display";
import {
	type BashExecutionMessage,
	type BranchSummaryMessage,
	bashExecutionToText,
	type CompactionSummaryMessage,
	type CustomMessage,
	type FileMentionMessage,
	type HookMessage,
	type PythonExecutionMessage,
	pythonExecutionToText,
} from "./messages";
import { ANONYMIZED_REVIEW_NOTE } from "./session-anonymizer";

/** Minimal tool shape for dump output (matches AgentTool fields used by formatSessionDumpText). */
export interface SessionDumpToolInfo {
	name: string;
	description: string;
	parameters: unknown;
	examples?: readonly ToolExample[];
}

/** A persisted subagent transcript rendered as its own `/dump all` document. */
export interface SessionDumpSubagent {
	/** Slash-joined agent path relative to the main session, e.g. "Explore/Helper". */
	key: string;
	messages: readonly AgentMessage[];
	/** Persisted default-role model string ("provider/id"). */
	model?: string;
	thinkingLevel?: string;
	/** The subagent was explicitly killed before finishing. */
	aborted?: boolean;
}

export interface FormatSessionDumpTextOptions {
	messages: readonly AgentMessage[];
	systemPrompt?: readonly string[] | null;
	model?: Model | null;
	thinkingLevel?: ThinkingLevel | string | null;
	tools?: readonly SessionDumpToolInfo[];
	inlineToolDescriptors?: boolean;
}

interface InventoryTool {
	name: string;
	description: string;
	parameters: TSchema;
	examples?: readonly ToolExample[];
}

function toInventoryTools(tools: readonly SessionDumpToolInfo[]): InventoryTool[] {
	return tools.map(tool => ({
		name: tool.name,
		description: tool.description,
		parameters: tool.parameters as TSchema,
		examples: tool.examples,
	}));
}

/** System prompt + model/thinking config + tool inventory — shared by both transcript styles. */
function renderDumpHeader(options: FormatSessionDumpTextOptions, inventoryTools: readonly InventoryTool[]): string[] {
	const lines: string[] = [];

	const systemPrompt = options.systemPrompt?.filter(prompt => prompt.length > 0) ?? [];
	if (systemPrompt.length > 0) {
		lines.push("## System Prompt\n");
		for (let index = 0; index < systemPrompt.length; index++) {
			if (systemPrompt.length > 1) {
				lines.push(`### System Prompt ${index + 1}\n`);
			}
			lines.push(systemPrompt[index]);
			lines.push("\n");
		}
	}

	const model = options.model;
	lines.push("## Configuration\n");
	lines.push(`Model: ${model ? `${model.provider}/${model.id}` : "(not selected)"}`);
	lines.push(`Thinking Level: ${options.thinkingLevel ?? ""}`);
	lines.push("\n");

	const hasSystemPromptToolInventory = options.inlineToolDescriptors === true;
	if (inventoryTools.length > 0 && !hasSystemPromptToolInventory) {
		lines.push("## Available Tools\n");
		lines.push(renderToolInventory(inventoryTools));
		lines.push("\n");
	}

	return lines;
}

const CUSTOM_TYPE_ACRONYMS: Readonly<Record<string, string>> = {
	acp: "ACP",
	irc: "IRC",
	lsp: "LSP",
	mcp: "MCP",
	rpc: "RPC",
	ttsr: "TTSR",
	tui: "TUI",
	xdev: "XDev",
};

function systemNoticeTitle(customType: string): string {
	const words = customType.split(/[^A-Za-z0-9]+/).filter(Boolean);
	if (words.at(-1)?.toLowerCase() === "notice") words.pop();
	const label = words
		.map(word => CUSTOM_TYPE_ACRONYMS[word.toLowerCase()] ?? `${word[0]?.toUpperCase() ?? ""}${word.slice(1)}`)
		.join(" ");
	return label ? `System Notice: ${label}` : "System Notice";
}

function customMessageText(message: CustomMessage | HookMessage): string {
	if (typeof message.content === "string") return message.content;
	return message.content.map(content => (content.type === "text" ? content.text : "[Image]")).join("\n");
}

function appendCustomMessage(lines: string[], message: CustomMessage | HookMessage): void {
	const content = customMessageText(message);
	if (!/^<system-notice(?:\s|>)/.test(content.trimStart())) {
		lines.push(`## ${message.customType}\n`);
		lines.push(content);
		lines.push("\n");
		return;
	}

	const longestBacktickRun = content.match(/`+/g)?.reduce((longest, run) => Math.max(longest, run.length), 0) ?? 0;
	const fence = "`".repeat(Math.max(3, longestBacktickRun + 1));
	lines.push(`## ${systemNoticeTitle(message.customType)}\n`);
	lines.push(`${fence}xml`);
	lines.push(content);
	lines.push(fence);
	lines.push("\n");
}

/** Append the legacy per-message markdown-heading transcript (the pre-16.x `/dump` body). */
function appendMarkdownTranscript(lines: string[], messages: readonly AgentMessage[]): void {
	for (const msg of messages) {
		if (msg.role === "user" || msg.role === "developer") {
			lines.push(msg.role === "developer" ? "## Developer\n" : "## User\n");
			if (typeof msg.content === "string") {
				lines.push(msg.content);
			} else {
				for (const c of msg.content) {
					if (c.type === "text") lines.push(c.text);
					else if (c.type === "image") lines.push("[Image]");
				}
			}
			lines.push("\n");
		} else if (msg.role === "assistant") {
			const assistantMsg = msg as AssistantMessage;
			lines.push("## Assistant\n");
			for (const c of assistantMsg.content) {
				if (c.type === "text") {
					lines.push(c.text);
				} else if (c.type === "thinking") {
					const thinking = canonicalizeMessage(c.thinking);
					if (thinking.length === 0) continue;
					// Unwrap any literal `<thinking>` envelope already present in the
					// block (e.g. Opus 4.5 — issue #2700) so the dump never nests tags.
					lines.push(`${renderDelimitedThinking("<thinking>", "</thinking>", thinking)}\n`);
				} else if (c.type === "toolCall") {
					lines.push(`### Tool Call: ${c.name}`);
					const rawArgs = c.arguments as Record<string, unknown> | undefined;
					if (rawArgs && typeof rawArgs === "object") {
						const intent = rawArgs[INTENT_FIELD];
						if (typeof intent === "string" && intent.trim().length > 0) {
							for (const line of intent.split("\n")) lines.push(`// ${line}`);
						}
						const args: Record<string, unknown> = {};
						let hasArgs = false;
						for (const key in rawArgs) {
							if (key === INTENT_FIELD) continue;
							args[key] = rawArgs[key];
							hasArgs = true;
						}
						if (hasArgs) {
							lines.push("```yaml");
							lines.push(YAML.stringify(args, null, 2).trimEnd());
							lines.push("```\n");
						}
					}
				}
			}
			lines.push("");
		} else if (msg.role === "toolResult") {
			lines.push(`### Tool Result: ${msg.toolName}`);
			if (msg.isError) lines.push("(error)");
			for (const c of msg.content) {
				if (c.type === "text") {
					lines.push("```");
					lines.push(c.text);
					lines.push("```");
				} else if (c.type === "image") {
					lines.push("[Image output]");
				}
			}
			lines.push("");
		} else if (msg.role === "bashExecution") {
			const bashMsg = msg as BashExecutionMessage;
			if (!bashMsg.excludeFromContext) {
				lines.push("## Bash Execution\n");
				lines.push(bashExecutionToText(bashMsg));
				lines.push("\n");
			}
		} else if (msg.role === "pythonExecution") {
			const pythonMsg = msg as PythonExecutionMessage;
			if (!pythonMsg.excludeFromContext) {
				lines.push("## Python Execution\n");
				lines.push(pythonExecutionToText(pythonMsg));
				lines.push("\n");
			}
		} else if (msg.role === "custom" || msg.role === "hookMessage") {
			appendCustomMessage(lines, msg as CustomMessage | HookMessage);
		} else if (msg.role === "branchSummary") {
			const branchMsg = msg as BranchSummaryMessage;
			lines.push("## Branch Summary\n");
			lines.push(`(from branch: ${branchMsg.fromId})\n`);
			lines.push(branchMsg.summary);
			lines.push("\n");
		} else if (msg.role === "compactionSummary") {
			const compactMsg = msg as CompactionSummaryMessage;
			lines.push("## Compaction Summary\n");
			lines.push(`(${compactMsg.tokensBefore} tokens before compaction)\n`);
			lines.push(compactMsg.summary);
			lines.push("\n");
		} else if (msg.role === "fileMention") {
			const fileMsg = msg as FileMentionMessage;
			lines.push("## File Mention\n");
			for (const file of fileMsg.files) {
				lines.push(`<file path="${file.path}">`);
				if (file.content) lines.push(file.content);
				if (file.image) lines.push("[Image attached]");
				lines.push("</file>\n");
			}
			lines.push("\n");
		}
	}
}

/**
 * Format messages and session metadata as markdown/plain text (same as
 * AgentSession.formatSessionAsText / /dump).
 */
export function formatSessionDumpText(options: FormatSessionDumpTextOptions): string {
	const inventoryTools = toInventoryTools(options.tools ?? []);
	const lines = renderDumpHeader(options, inventoryTools);
	appendMarkdownTranscript(lines, options.messages);
	return lines.join("\n").trim();
}

/**
 * Format one persisted subagent transcript. Subagent system prompts and tool
 * inventories are not persisted, so the header carries only model, thinking
 * level, and whether the agent was killed.
 */
export function formatSubagentDumpText(subagent: SessionDumpSubagent): string {
	const lines = [`# Subagent: ${subagent.key}\n`, `Model: ${subagent.model ?? "(unknown)"}`];
	if (subagent.thinkingLevel) lines.push(`Thinking Level: ${subagent.thinkingLevel}`);
	if (subagent.aborted) lines.push("Status: aborted");
	lines.push("\n");
	appendMarkdownTranscript(lines, subagent.messages);
	return lines.join("\n").trim();
}

/** Result of writing a `/dump all` or `/dump anon` zip (see `AgentSession.dumpSessionArchiveToTmpDir`). */
export interface SessionDumpArchive {
	path: string;
	/** Archive member names in write order. */
	files: string[];
	subagentCount: number;
	/** Why subagent discovery failed; the main dump is archived regardless. */
	subagentError?: string;
	/** Members are anonymized session JSONL (`/dump anon`), not raw transcripts. */
	anonymized?: boolean;
	/** `[member, count]` for transcripts whose malformed JSONL records were skipped. */
	malformed?: ReadonlyArray<readonly [string, number]>;
	/** Subagent transcripts skipped because no session header could be read. */
	unreadable?: readonly string[];
}

/** Lines describing a `/dump all` archive: path, members, and any subagent discovery failure. */
export function formatDumpArchiveReport(archive: SessionDumpArchive): string[] {
	const fileCount = archive.files.length;
	const subCount = archive.subagentCount;
	const lines = [
		`Session dump archive: ${archive.path}`,
		`Contains ${fileCount} file${fileCount === 1 ? "" : "s"} (${subCount} subagent transcript${subCount === 1 ? "" : "s"}):`,
		...archive.files.map(file => `  ${file}`),
	];
	if (archive.subagentError) lines.push(`Subagent transcripts unavailable: ${archive.subagentError}`);
	for (const [member, skipped] of archive.malformed ?? []) {
		lines.push(`Skipped ${skipped} malformed record${skipped === 1 ? "" : "s"} in ${member}`);
	}
	for (const member of archive.unreadable ?? []) lines.push(`Not exported (no readable session header): ${member}`);
	lines.push(
		archive.anonymized
			? ANONYMIZED_REVIEW_NOTE
			: "This archive persists on disk and may contain raw context/secrets — treat accordingly.",
	);
	return lines;
}
