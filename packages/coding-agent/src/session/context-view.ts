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
	type ContextViewSourceMarker,
} from "@oh-my-pi/pi-tui/chrome/context-view-model";
import { type ContextBreakdown, toolSchemaFragments } from "@oh-my-pi/pi-tui/status-line/context-usage";
import { stringifyJson } from "@oh-my-pi/pi-utils";
import type { SystemPromptSource, SystemPromptSources } from "../system-prompt";
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

/** A located source fragment inside one effective system block. */
interface SourceClaim {
	readonly start: number;
	readonly end: number;
	readonly source: SystemPromptSource;
	/** Repeated sources only reserve their locations; they are never attributed. */
	readonly ambiguous: boolean;
}

function countBlocks(blocks: readonly string[]): Map<string, number> {
	const counts = new Map<string, number>();
	for (const block of blocks) counts.set(block, (counts.get(block) ?? 0) + 1);
	return counts;
}

/**
 * Claims each source fragment in the effective prompt. A source is claimed only when it occurs once
 * in the built prompt, in a block that is unchanged at its original index and unique in the
 * effective prompt, and overlaps no other source. A repeated fragment reserves every occurrence.
 * `complete` is false when a source the effective prompt may still hold stays unattributed.
 */
function claimPromptSources(
	effective: readonly string[],
	metadata: SystemPromptSources,
): { claims: Map<number, SourceClaim[]>; complete: boolean } {
	let complete = true;
	const effectiveCounts = countBlocks(effective);
	const candidates = new Map<number, SourceClaim[]>();
	for (const source of metadata.sources) {
		const { fragment } = source;
		const located: { index: number; start: number }[] = [];
		for (const [index, block] of metadata.blocks.entries())
			for (let start = block.indexOf(fragment); start >= 0; start = block.indexOf(fragment, start + 1))
				located.push({ index, start });
		const ambiguous = located.length > 1;
		let unattributed = located.length === 0 || ambiguous;
		for (const { index, start } of located) {
			const block = metadata.blocks[index]!;
			// Never remap moved or changed blocks, even when the fragment text still appears.
			if (effective[index] !== block || effectiveCounts.get(block) !== 1) {
				unattributed = true;
				continue;
			}
			const ranges = candidates.get(index) ?? [];
			ranges.push({ start, end: start + fragment.length, source, ambiguous });
			candidates.set(index, ranges);
		}
		// Absent from the built prompt: the template omitted it, or whole-prompt formatting (an unclosed
		// fence) changed it. Otherwise only a fragment the effective prompt still holds is left behind.
		if (unattributed && (located.length === 0 || effective.some(text => text.includes(fragment)))) complete = false;
	}
	const claims = new Map<number, SourceClaim[]>();
	for (const [index, ranges] of candidates) {
		// Validate the whole block before claiming: every participant in an overlap stays unattributed.
		const accepted = ranges.filter(range => {
			const overlaps = ranges.some(other => other !== range && range.start < other.end && range.end > other.start);
			if (overlaps) complete = false;
			return !range.ambiguous && !overlaps;
		});
		claims.set(
			index,
			accepted.sort((a, b) => a.start - b.start),
		);
	}
	return { claims, complete };
}

/**
 * System blocks with claimed instruction-file and skill fragments moved to their own categories.
 * Each fragment leaves a colored marker in its block; markers are display-only and carry no tokens.
 * Returns false when some source could not be attributed and remains in System Prompt.
 */
function appendSystemPromptEntries(session: AgentSession, state: SnapshotBuildState): boolean {
	const tokenizer = session.agent.tokenizer;
	const effective = session.systemPrompt;
	const metadata = session.systemPromptSources;
	const { claims, complete } = metadata
		? claimPromptSources(effective, metadata)
		: { claims: new Map<number, SourceClaim[]>(), complete: true };
	for (const [index, block] of effective.entries()) {
		const blockClaims = claims.get(index) ?? [];
		const remaining: string[] = [];
		const display: string[] = [];
		const sourceMarkers: ContextViewSourceMarker[] = [];
		let displayLength = 0;
		let cursor = 0;
		for (const { start, end, source } of blockClaims) {
			const before = block.slice(cursor, start);
			const category = state.categoriesById.get(source.kind)!;
			const marker = `[Shown in ${category.label}: ${source.label}]`;
			remaining.push(before);
			display.push(before, marker);
			displayLength += before.length;
			sourceMarkers.push({ start: displayLength, end: displayLength + marker.length, category: source.kind });
			displayLength += marker.length;
			cursor = end;
			appendEntry(state, source.kind, {
				id: `${source.kind}/${source.id}`,
				label: source.label,
				path: source.path,
				text: source.fragment,
				tokens: tokenizer.countTokens(source.fragment),
			});
		}
		const tail = block.slice(cursor);
		remaining.push(tail);
		display.push(tail);
		const remainingText = remaining.join("");
		appendEntry(state, "system-prompt", {
			id: `system-prompt/${index}`,
			label: `System Block ${index + 1}`,
			text: display.join(""),
			tokens: tokenizer.countTokens(remainingText),
			sourceMarkers: sourceMarkers.length > 0 ? sourceMarkers : undefined,
		});
	}
	return complete;
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

	const notices: string[] = [];
	if (!appendSystemPromptEntries(session, state))
		notices.push("Some prompt sources could not be attributed; their content remains in System Prompt.");
	appendToolDefinitionEntries(session, state);
	appendMessageEntries(session, state);
	finalizeToolOutputGroups(state);

	return { breakdown, categories, notices };
}
