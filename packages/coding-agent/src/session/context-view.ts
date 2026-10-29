import type { AgentMessage, Tokenizer } from "@oh-my-pi/pi-agent-core";
import type { AnthropicServerToolContent, AssistantMessage, ImageContent, TextContent } from "@oh-my-pi/pi-ai";
import { isSurvivingAssistant } from "@oh-my-pi/pi-ai/providers/transform-messages";
import {
	CONTEXT_CATEGORIES,
	type ContextCategoryId,
	type ContextThinkingGroup,
	type ContextViewCategory,
	type ContextViewData,
	type ContextViewEntry,
} from "@oh-my-pi/pi-tui/chrome/context-view-model";
import { type ContextBreakdown, toolSchemaFragments } from "@oh-my-pi/pi-tui/status-line/context-usage";
import { stringifyJson } from "@oh-my-pi/pi-utils";
import type { AgentSession } from "./agent-session";
import { computeSessionContextBreakdown } from "./context-usage-runtime";
import { type ContextViewMessage, convertMessagesForContextView } from "./messages";

const ENCRYPTED_THINKING = "[Encrypted thinking]";

/** Provider ciphertext is shown as its size, never its bytes. */
function opaqueSize(name: string, value: string): string {
	return `${name} · ${value.length.toLocaleString("en-US")} chars`;
}

/** One text or image block as readable text, without retaining binary data. */
function summarizeBlockForView(block: TextContent | ImageContent): string {
	if (block.type === "text") return block.text;
	return `[image · ${block.mimeType} · ~${Math.floor((block.data.length * 3) / 4)} bytes]`;
}

function summarizeContentForView(content: string | readonly (TextContent | ImageContent)[]): string {
	return typeof content === "string" ? content : content.map(summarizeBlockForView).join("\n");
}

interface AssistantBlockEstimate {
	blockTokenEstimates: number[];
	thinkingBlockCount: number;
	reasoningReplayTokens: number;
	isInterruptedThinkingPlaceholder: boolean;
}

function estimateAssistantBlocks(
	message: AssistantMessage,
	tokenizer: Tokenizer,
	isLatestSurviving: boolean,
): AssistantBlockEstimate {
	// Count reasoning replay once; text and calls do not inherit the provider's whole-turn usage.
	let thinkingBlockCount = 0;
	const blockTokenEstimates = message.content.map(block => {
		if (block.type === "text") return tokenizer.countTokens(block.text);
		if (block.type === "toolCall") {
			try {
				// Same serializer as Tokenizer.countMessage, so the reasoning residual stays exact.
				return tokenizer.countTokens([block.name, stringifyJson(block.arguments) ?? "null"]);
			} catch {
				return tokenizer.countTokens(block.name);
			}
		}
		if (block.type === "thinking" || block.type === "redactedThinking") {
			thinkingBlockCount++;
			return 0;
		}
		const isolated: AgentMessage = { ...message, providerPayload: undefined, content: [block] };
		return tokenizer.countMessages([isolated]);
	});
	const messageTokens = isLatestSurviving ? tokenizer.countLatestTurn(message) : tokenizer.countMessage(message);
	const reasoningReplayTokens = Math.max(
		0,
		messageTokens - blockTokenEstimates.reduce((sum, tokens) => sum + tokens, 0),
	);
	const isInterruptedThinkingPlaceholder =
		message.stopReason === "aborted" &&
		reasoningReplayTokens === 0 &&
		message.usage.output === 0 &&
		message.usage.reasoningTokens === undefined &&
		!message.providerPayload &&
		message.content.every(block => block.type === "thinking" && !block.thinking.trim());
	return { blockTokenEstimates, thinkingBlockCount, reasoningReplayTokens, isInterruptedThinkingPlaceholder };
}

interface SnapshotBuildState {
	categoriesById: Map<ContextCategoryId, ContextViewCategory>;
	toolOutputGroupsByName: Map<string, ContextViewCategory>;
	serverToolNamesByCallId: Map<string, string>;
}

function appendEntry(state: SnapshotBuildState, categoryId: ContextCategoryId, entry: ContextViewEntry): void {
	const category = state.categoriesById.get(categoryId)!;
	category.entries.push(entry);
	category.tokens += entry.tokens;
}

function appendToolOutput(state: SnapshotBuildState, toolName: string, entry: ContextViewEntry): void {
	let group = state.toolOutputGroupsByName.get(toolName);
	if (!group) {
		group = {
			id: "tool-output",
			key: `tool-output/tool-${state.toolOutputGroupsByName.size}`,
			label: toolName,
			tokens: 0,
			entries: [],
		};
		state.toolOutputGroupsByName.set(toolName, group);
	}
	group.entries.push(entry);
	group.tokens += entry.tokens;
	appendEntry(state, "tool-output", entry);
}

function appendSystemPromptEntries(session: AgentSession, state: SnapshotBuildState, skillListingTokens: number): void {
	for (const [index, block] of session.systemPrompt.entries()) {
		appendEntry(state, "system-prompt", {
			id: `system-prompt/${index}`,
			label: `System Block ${index + 1}`,
			text: block,
			tokens: session.agent.tokenizer.countTokens(block),
		});
	}
	const skillsCategory = state.categoriesById.get("skills")!;
	skillsCategory.tokens = skillListingTokens;
	const systemPromptCategory = state.categoriesById.get("system-prompt")!;
	// Skills estimates the prompt's skill listing, not full skill files or additional context.
	// Subtract it only from the category weight; entries retain complete blocks and unscaled estimates.
	systemPromptCategory.tokens = Math.max(0, systemPromptCategory.tokens - skillListingTokens);
}

function appendToolDefinitionEntries(session: AgentSession, state: SnapshotBuildState): void {
	const toolSourcesByName = new Map(session.getAllToolInfos().map(info => [info.name, info.sourceInfo]));
	for (const [index, tool] of session.agent.state.tools.entries()) {
		const categoryId = session.hasBuiltInTool(tool.name) ? "built-in-tools" : "custom-tools";
		// Count the compact wire text; show the same fragments with an indented schema.
		const { fragments, display, schemaError } = toolSchemaFragments(tool, {
			displayIndent: 2,
			pruneDescriptions: session.agent.prunesToolDescriptions(session.model),
		});
		const tokens = session.model?.toolSchemasInContext === false ? 0 : session.agent.tokenizer.countTokens(fragments);
		const shown = display ?? fragments;
		if (schemaError !== undefined) shown.push(`Schema unavailable: ${schemaError}`);
		const source = toolSourcesByName.get(tool.name);
		appendEntry(state, categoryId, {
			id: `${categoryId}/${index}`,
			label: tool.name,
			text: shown.join("\n\n"),
			info: source?.source ?? "unknown",
			path: source?.path,
			tokens,
		});
	}
}

function messageOriginInfo(
	sourceMessage: AgentMessage,
	convertedRole: ContextViewMessage["message"]["role"],
): string | undefined {
	if (sourceMessage.role === convertedRole && !("customType" in sourceMessage)) return undefined;
	const customType = "customType" in sourceMessage ? ` · ${sourceMessage.customType}` : "";
	const roleConversion = sourceMessage.role !== convertedRole ? ` → ${convertedRole}` : "";
	return `${sourceMessage.role}${customType}${roleConversion}`;
}

/** Provider-signed or encrypted server-tool fields, replayed verbatim but never readable. */
const OPAQUE_SERVER_TOOL_FIELDS: Record<string, true> = {
	signature: true,
	encrypted_content: true,
	encrypted_index: true,
};

function appendServerToolEntry(
	state: SnapshotBuildState,
	block: AnthropicServerToolContent["block"],
	entryIdSuffix: string,
	sourceMessage: AgentMessage,
	info: string | undefined,
	tokens: number,
): void {
	const isCall = block.type === "server_tool_use";
	const callId = isCall ? block.id : block.tool_use_id;
	const toolName = isCall
		? block.name
		: (state.serverToolNamesByCallId.get(callId) ??
			(block.type === "web_search_tool_result" ? "web_search" : "tool_search"));
	if (isCall) state.serverToolNamesByCallId.set(callId, toolName);
	const categoryId = isCall ? "tool-calls" : "tool-output";
	let text: string;
	try {
		// Ciphertext is unreadable; show its size while the entry estimate still counts it.
		text =
			JSON.stringify(
				block,
				(key, value) =>
					typeof value === "string" && Object.hasOwn(OPAQUE_SERVER_TOOL_FIELDS, key)
						? `[${opaqueSize(key, value)}]`
						: value,
				2,
			) ?? "";
	} catch {
		text = "[Content unavailable]";
	}
	const entry: ContextViewEntry = {
		id: `${categoryId}/${entryIdSuffix}`,
		label: toolName,
		info,
		text,
		timestamp: sourceMessage.timestamp,
		callId,
		tokens,
	};
	if (isCall) appendEntry(state, categoryId, entry);
	else appendToolOutput(state, toolName, entry);
}

function appendAssistantMessageEntries(
	session: AgentSession,
	state: SnapshotBuildState,
	message: AssistantMessage,
	{ sourceIndex, convertedIndex }: ContextViewMessage,
	isLatestSurviving: boolean,
): void {
	const sourceMessage = session.agent.state.messages[sourceIndex]!;
	const entryIdPrefix = `${sourceIndex}/${convertedIndex}`;
	const info = messageOriginInfo(sourceMessage, message.role);
	const { blockTokenEstimates, thinkingBlockCount, reasoningReplayTokens, isInterruptedThinkingPlaceholder } =
		estimateAssistantBlocks(message, session.agent.tokenizer, isLatestSurviving);
	const thinkingGroup: ContextThinkingGroup | undefined =
		thinkingBlockCount > 1
			? {
					id: `assistant-thinking/${entryIdPrefix}`,
					label: `Message ${sourceIndex + 1}`,
					tokens: reasoningReplayTokens,
					interrupted: isInterruptedThinkingPlaceholder,
				}
			: undefined;
	// Multiple thinking blocks share one message-level weight; their entries contribute zero.
	if (thinkingGroup) state.categoriesById.get("assistant-thinking")!.tokens += reasoningReplayTokens;
	// Payload-only reasoning still carries a message-level estimate, without exposing its bytes.
	if (reasoningReplayTokens > 0 && thinkingBlockCount === 0) {
		appendEntry(state, "assistant-thinking", {
			id: `assistant-thinking/${entryIdPrefix}/payload`,
			label: `Thinking 1/1 · message ${sourceIndex + 1}`,
			info,
			text: ENCRYPTED_THINKING,
			timestamp: sourceMessage.timestamp,
			tokens: reasoningReplayTokens,
		});
	}
	let thinkingIndex = 0;
	for (const [blockIndex, block] of message.content.entries()) {
		if (block.type === "anthropicServerTool") {
			appendServerToolEntry(
				state,
				block.block,
				`${entryIdPrefix}/${blockIndex}`,
				sourceMessage,
				info,
				blockTokenEstimates[blockIndex]!,
			);
			continue;
		}
		const categoryId =
			block.type === "toolCall"
				? "tool-calls"
				: block.type === "thinking" || block.type === "redactedThinking"
					? "assistant-thinking"
					: "assistant-messages";
		let text: string;
		let opaqueInfo: string | undefined;
		if (block.type === "toolCall") {
			try {
				text = stringifyJson(block.arguments, 2) ?? "null";
			} catch {
				text = "[Arguments unavailable]";
			}
		} else if (block.type === "fallback") {
			text = `[provider fallback: ${block.from.model} to ${block.to.model}]`;
		} else if (block.type === "thinking") {
			text = block.thinking || ENCRYPTED_THINKING;
			if (block.thinkingSignature) opaqueInfo = opaqueSize("signature", block.thinkingSignature);
		} else if (block.type === "redactedThinking") {
			text = ENCRYPTED_THINKING;
			opaqueInfo = opaqueSize("data", block.data);
		} else text = summarizeBlockForView(block);
		appendEntry(state, categoryId, {
			id: `${categoryId}/${entryIdPrefix}/${blockIndex}`,
			label:
				block.type === "toolCall"
					? block.name
					: categoryId === "assistant-thinking"
						? `Thinking ${++thinkingIndex}/${thinkingBlockCount} · message ${sourceIndex + 1}`
						: `${block.type} · message ${sourceIndex + 1}`,
			info: [info, opaqueInfo].filter(Boolean).join(" · ") || undefined,
			text,
			timestamp: sourceMessage.timestamp,
			callId: block.type === "toolCall" ? block.id : undefined,
			tokens:
				categoryId === "assistant-thinking" && !thinkingGroup
					? reasoningReplayTokens
					: blockTokenEstimates[blockIndex]!,
			...(categoryId === "assistant-thinking"
				? {
						thinkingGroup,
						interrupted: isInterruptedThinkingPlaceholder,
					}
				: {}),
		});
	}
}

function appendMessageEntries(session: AgentSession, state: SnapshotBuildState): void {
	const tokenizer = session.agent.tokenizer;
	const sourceMessages = session.agent.state.messages;
	const convertedMessages = convertMessagesForContextView(sourceMessages);
	const latestSurvivingAssistantIndex = convertedMessages.findLastIndex(
		({ message }) => message.role === "assistant" && isSurvivingAssistant(message, session.model ?? undefined),
	);
	for (const convertedMessage of convertedMessages) {
		const { message, sourceIndex, convertedIndex } = convertedMessage;
		if (message.role === "assistant") {
			appendAssistantMessageEntries(
				session,
				state,
				message,
				convertedMessage,
				convertedIndex === latestSurvivingAssistantIndex,
			);
			continue;
		}
		const sourceMessage = sourceMessages[sourceIndex]!;
		const executionToolName =
			sourceMessage.role === "bashExecution"
				? "bash"
				: sourceMessage.role === "pythonExecution"
					? "python"
					: undefined;
		const entryIdPrefix = `${sourceIndex}/${convertedIndex}`;
		const info = messageOriginInfo(sourceMessage, message.role);
		if (message.role === "toolResult" || executionToolName) {
			const toolName = message.role === "toolResult" ? message.toolName : executionToolName!;
			const callId = message.role === "toolResult" ? message.toolCallId : undefined;
			appendToolOutput(state, toolName, {
				id: `tool-output/${entryIdPrefix}`,
				label: toolName,
				info,
				text: summarizeContentForView(message.content),
				timestamp: sourceMessage.timestamp,
				callId,
				tokens: tokenizer.countMessages([message]),
			});
		} else {
			appendEntry(state, "user-messages", {
				id: `user-messages/${entryIdPrefix}`,
				label: `${message.role} · message ${sourceIndex + 1}`,
				info,
				text: summarizeContentForView(message.content),
				timestamp: sourceMessage.timestamp,
				tokens: tokenizer.countMessages([message]),
			});
		}
	}
}

function finalizeToolOutputGroups(state: SnapshotBuildState): void {
	const toolOutputCategory = state.categoriesById.get("tool-output")!;
	const chronological = (a: ContextViewEntry, b: ContextViewEntry): number => (a.timestamp ?? 0) - (b.timestamp ?? 0);
	toolOutputCategory.entries.sort(chronological);
	toolOutputCategory.children = [...state.toolOutputGroupsByName.values()].sort((a, b) => b.tokens - a.tokens);
	for (const group of toolOutputCategory.children) group.entries.sort(chronological);
}

/** Sample once on open without session hooks, provider transforms, or file I/O. */
export function buildSessionContextView(
	session: AgentSession,
	breakdown: ContextBreakdown = computeSessionContextBreakdown(session, { snapcompactSavings: true }),
): ContextViewData {
	const categories: ContextViewCategory[] = CONTEXT_CATEGORIES.map(({ id, label }) => ({
		id,
		label,
		tokens: 0,
		entries: [],
	}));
	const state: SnapshotBuildState = {
		categoriesById: new Map(categories.map(category => [category.id, category])),
		toolOutputGroupsByName: new Map(),
		serverToolNamesByCallId: new Map(),
	};

	appendSystemPromptEntries(session, state, breakdown.categories.find(category => category.id === "skills")!.tokens);
	appendToolDefinitionEntries(session, state);
	appendMessageEntries(session, state);
	finalizeToolOutputGroups(state);

	return { breakdown, categories };
}
