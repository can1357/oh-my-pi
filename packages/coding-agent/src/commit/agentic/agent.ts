import type { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import { Markdown } from "@oh-my-pi/pi-tui";
import { prompt } from "@oh-my-pi/pi-utils";
import chalk from "@oh-my-pi/pi-utils/chalk";
import { INTENT_FIELD } from "@oh-my-pi/pi-wire";
import typesDescriptionPrompt from "../../commit/prompts/types-description.md" with { type: "text" };
import type { ModelRegistry } from "../../config/model-registry";
import type { Settings } from "../../config/settings";
import { getMarkdownTheme } from "../../modes/theme/theme";
import { createAgentSession } from "../../sdk";
import type { AgentSessionEvent } from "../../session/agent-session";
import type { AuthStorage } from "../../session/auth-storage";
import agentUserPrompt from "./prompts/session-user.md" with { type: "text" };
import agentSystemPrompt from "./prompts/system.md" with { type: "text" };
import type { CommitAgentState } from "./state";
import { createCommitTools } from "./tools";

export interface CommitAgentInput {
	cwd: string;
	model: Model<Api>;
	thinkingLevel?: ThinkingLevel;
	settings: Settings;
	modelRegistry: ModelRegistry;
	authStorage: AuthStorage;
	userContext?: string;
	contextFiles?: Array<{ path: string; content: string }>;
	changelogTargets: string[];
	requireChangelog: boolean;
	diffText?: string;
	existingChangelogEntries?: ExistingChangelogEntries[];
	onComplete?: (state: CommitAgentState) => Promise<void> | void;
}

export interface ExistingChangelogEntries {
	path: string;
	sections: Array<{ name: string; items: string[] }>;
}

export async function runCommitAgentSession(input: CommitAgentInput): Promise<CommitAgentState> {
	const typesDescription = prompt.render(typesDescriptionPrompt);
	const systemPrompt = prompt.render(agentSystemPrompt, {
		types_description: typesDescription,
	});
	const state: CommitAgentState = { diffText: input.diffText };
	const spawns = "sonic";
	const tools = createCommitTools({
		cwd: input.cwd,
		authStorage: input.authStorage,
		modelRegistry: input.modelRegistry,
		settings: input.settings,
		spawns,
		state,
		changelogTargets: input.changelogTargets,
		enableAnalyzeFiles: true,
	});

	const { session } = await createAgentSession({
		cwd: input.cwd,
		authStorage: input.authStorage,
		modelRegistry: input.modelRegistry,
		settings: input.settings,
		model: input.model,
		thinkingLevel: input.thinkingLevel,
		systemPrompt: [systemPrompt],
		customTools: tools,
		enableLsp: false,
		enableMCP: false,
		hasUI: false,
		spawns,
		toolNames: ["__none__"],
		contextFiles: input.contextFiles,
		disableExtensionDiscovery: true,
		skills: [],
		promptTemplates: [],
		slashCommands: [],
	});
	let toolCalls = 0;
	let messageCount = 0;
	let isThinking = false;
	let thinkingLineActive = false;
	const toolArgsById = new Map<string, { name: string; args?: Record<string, unknown> }>();
	const writeThinkingLine = (text: string) => {
		if (!process.stdout.isTTY) return;
		const line = chalk.dim(`… ${text}`);
		process.stdout.write(`\r\x1b[2K${line}`);
		thinkingLineActive = true;
	};
	const clearThinkingLine = () => {
		if (!thinkingLineActive) return;
		if (!process.stdout.isTTY) return;
		process.stdout.write("\r\x1b[2K");
		thinkingLineActive = false;
	};
	const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
		switch (event.type) {
			case "message_start":
				if (event.message.role === "assistant") {
					isThinking = true;
					thinkingLineActive = false;
				}
				break;
			case "message_update": {
				if (event.message?.role !== "assistant") break;
				const preview = extractMessagePreview(event.message?.content ?? []);
				if (!preview) break;
				writeThinkingLine(preview);
				break;
			}
			case "tool_execution_start":
				toolCalls += 1;
				toolArgsById.set(event.toolCallId, { name: event.toolName, args: event.args });
				break;
			case "message_end": {
				const role = event.message?.role;
				if (role === "assistant") {
					messageCount += 1;
					isThinking = false;
					clearThinkingLine();
					const assistantMessage = event.message as { stopReason?: string; errorMessage?: string };
					if (assistantMessage.stopReason === "error" && assistantMessage.errorMessage) {
						process.stdout.write(`● Error: ${assistantMessage.errorMessage}\n`);
					}
					const messageText = extractMessageText(event.message?.content ?? []);
					if (messageText) {
						writeAssistantMessage(messageText);
					}
				}
				break;
			}
			case "tool_execution_end": {
				const stored = toolArgsById.get(event.toolCallId) ?? { name: event.toolName };
				toolArgsById.delete(event.toolCallId);
				clearThinkingLine();
				const toolLabel = formatToolLabel(stored.name);
				const symbol = event.isError ? "" : "";
				process.stdout.write(`${symbol} ${toolLabel}\n`);
				const argsLines = formatToolArgs(stored.args);
				if (argsLines.length > 0) {
					process.stdout.write(`${formatToolArgsBlock(argsLines)}\n`);
				}
				break;
			}
			case "agent_end":
				if (isThinking) {
					isThinking = false;
				}
				process.stdout.write(`● agent finished (${messageCount} messages, ${toolCalls} tools)\n`);
				break;
			default:
				break;
		}
	});

	try {
		const agentUserMessage = prompt.render(agentUserPrompt, {
			user_context: input.userContext,
			changelog_targets: input.changelogTargets.length > 0 ? input.changelogTargets.join("\n") : undefined,
			existing_changelog_entries: input.existingChangelogEntries,
		});
		const MAX_RETRIES = 3;
		let retryCount = 0;
		const needsChangelog = input.requireChangelog && input.changelogTargets.length > 0;

		await session.prompt(agentUserMessage, {
			attribution: "agent",
			expandPromptTemplates: false,
		});
		while (retryCount < MAX_RETRIES && !isProposalComplete(state, needsChangelog)) {
			retryCount += 1;
			const reminder = buildReminderMessage(state, needsChangelog, retryCount, MAX_RETRIES);
			await session.prompt(reminder, {
				attribution: "agent",
				expandPromptTemplates: false,
				synthetic: true,
			});
		}

		if (input.onComplete) {
			await input.onComplete(state);
		}
		return state;
	} finally {
		unsubscribe();
		await session.dispose();
	}
}

function extractMessagePreview(content: Array<{ type: string; text?: string }>): string | null {
	const textBlocks = content
		.filter(block => block.type === "text" && typeof block.text === "string")
		.map(block => block.text?.trim())
		.filter((value): value is string => Boolean(value));
	if (textBlocks.length === 0) return null;
	const combined = textBlocks.join(" ").replace(/\s+/g, " ").trim();
	return truncateToolArg(combined);
}

function extractMessageText(content: Array<{ type: string; text?: string }>): string | null {
	const textBlocks = content
		.filter(block => block.type === "text" && typeof block.text === "string")
		.map(block => block.text ?? "")
		.filter(value => value.trim().length > 0);
	if (textBlocks.length === 0) return null;
	return textBlocks.join("\n").trim();
}

function writeAssistantMessage(message: string): void {
	const lines = renderMarkdownLines(message);
	if (lines.length === 0) return;
	let firstContentIndex = lines.findIndex(line => line.trim().length > 0);
	if (firstContentIndex === -1) {
		firstContentIndex = 0;
	}
	for (const [index, line] of lines.entries()) {
		const prefix = index === firstContentIndex ? "● " : "  ";
		process.stdout.write(`${`${prefix}${line}`.trimEnd()}\n`);
	}
}

function renderMarkdownLines(message: string): readonly string[] {
	const width = Math.max(40, process.stdout.columns ?? 100);
	const markdown = new Markdown(message, 0, 0, getMarkdownTheme());
	return markdown.render(width);
}

function formatToolLabel(toolName: string): string {
	const displayName = toolName
		.split(/[_-]/)
		.map(segment => segment.charAt(0).toUpperCase() + segment.slice(1))
		.join("");
	return displayName;
}

function formatToolArgs(args?: Record<string, unknown>): string[] {
	if (!args || Object.keys(args).length === 0) return [];
	const lines: string[] = [];
	const visit = (value: unknown, keyPath: string) => {
		if (value === null || value === undefined) return;
		if (Array.isArray(value)) {
			if (value.length === 0) return;
			const rendered = value.map(item => renderPrimitive(item)).filter(Boolean);
			if (rendered.length > 0) {
				lines.push(`${keyPath}: ${rendered.join(", ")}`);
			}
			return;
		}
		if (typeof value === "object") {
			const entries = Object.entries(value as Record<string, unknown>);
			if (entries.length === 0) return;
			for (const [childKey, childValue] of entries) {
				visit(childValue, `${keyPath}.${childKey}`);
			}
			return;
		}
		const rendered = renderPrimitive(value);
		if (rendered) {
			lines.push(`${keyPath}: ${rendered}`);
		}
	};
	for (const [key, value] of Object.entries(args)) {
		if (key === INTENT_FIELD) continue;
		visit(value, key);
	}
	return lines;
}

function renderPrimitive(value: unknown): string | null {
	if (value === null || value === undefined) return null;
	if (typeof value === "string") {
		const trimmed = value.trim();
		return trimmed.length > 0 ? trimmed : null;
	}
	if (typeof value === "number" || typeof value === "boolean") {
		return String(value);
	}
	return null;
}

function formatToolArgsBlock(lines: string[]): string {
	return lines
		.map((line, index) => {
			if (index === 0) return `  ⎿ ${line}`;
			const branch = index === lines.length - 1 ? "└" : "├";
			return `    ${branch} ${line}`;
		})
		.join("\n");
}

function isProposalComplete(state: CommitAgentState, requireChangelog: boolean): boolean {
	const hasCommit = Boolean(state.proposal ?? state.splitProposal);
	const hasChangelog = !requireChangelog || Boolean(state.changelogProposal);
	return hasCommit && hasChangelog;
}

function buildReminderMessage(
	state: CommitAgentState,
	requireChangelog: boolean,
	retryCount: number,
	maxRetries: number,
): string {
	const missing: string[] = [];
	if (!state.proposal && !state.splitProposal) {
		missing.push("commit proposal (propose_commit or split_commit)");
	}
	if (requireChangelog && !state.changelogProposal) {
		missing.push("changelog entries (propose_changelog)");
	}
	return `<system-reminder>
CRITICAL: You must call the required tools before finishing.

Missing: ${missing.join(", ") || "none"}.
Reminder ${retryCount} of ${maxRetries}.

Call the missing tool(s) now.
</system-reminder>`;
}

function truncateToolArg(value: string): string {
	if (value.length <= 40) return value;
	return `${value.slice(0, 39)}…`;
}
