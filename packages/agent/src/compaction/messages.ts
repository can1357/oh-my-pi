import type {
	AssistantMessage,
	ImageContent,
	Message,
	MessageAttribution,
	ProviderPayload,
	TextContent,
	ToolCall,
	ToolResultMessage,
} from "@oh-my-pi/pi-ai";
import { isOpenAIResponsesClientInputBoundary, normalizeResponsesToolCallId } from "@oh-my-pi/pi-ai/utils";
import { prompt } from "@oh-my-pi/pi-utils";
import type { AgentMessage } from "../types";
import branchSummaryContextPrompt from "./prompts/branch-summary-context.md" with { type: "text" };
import compactionSummaryContextPrompt from "./prompts/compaction-summary-context.md" with { type: "text" };
import handoffSummaryContextPrompt from "./prompts/handoff-summary-context.md" with { type: "text" };

const COMPACTION_SUMMARY_TEMPLATE = compactionSummaryContextPrompt;
const HANDOFF_SUMMARY_TEMPLATE = handoffSummaryContextPrompt;
const BRANCH_SUMMARY_TEMPLATE = branchSummaryContextPrompt;

export interface CustomMessage<T = unknown> {
	role: "custom";
	customType: string;
	content: string | (TextContent | ImageContent)[];
	display: boolean;
	details?: T;
	/** Who initiated this message for billing/attribution semantics. */
	attribution?: MessageAttribution;
	timestamp: number;
}

/** Legacy hook message type (pre-extensions). Kept for session migration. */
export interface HookMessage<T = unknown> {
	role: "hookMessage";
	customType: string;
	content: string | (TextContent | ImageContent)[];
	display: boolean;
	details?: T;
	/** Who initiated this message for billing/attribution semantics. */
	attribution?: MessageAttribution;
	timestamp: number;
}

export interface BranchSummaryMessage {
	role: "branchSummary";
	summary: string;
	fromId: string;
	timestamp: number;
}

export interface CompactionSummaryMessage {
	role: "compactionSummary";
	summary: string;
	shortSummary?: string;
	tokensBefore: number;
	/** Estimated context tokens after the rewrite (display metadata). */
	tokensAfter?: number;
	/** Harness compaction method that produced this summary (display metadata). */
	method?: string;
	providerPayload?: ProviderPayload;
	/** Runtime-only ordered archive blocks for snapcompact: old text region,
	 *  imaged middle, then new text region. When present, `summary` is already
	 *  the final lead-in text (no legacy wrapper applied). */
	blocks?: (TextContent | ImageContent)[];
	/** Snapcompact image blocks, kept for display counts / legacy consumers. */
	images?: ImageContent[];
	/** Post-pass dead-end warning attached to this compaction (progress guard). */
	warning?: string;
	timestamp: number;
}

export type CoreCompactionMessage = CustomMessage | HookMessage | BranchSummaryMessage | CompactionSummaryMessage;

declare module "../types" {
	interface CustomAgentMessages {
		custom: CustomMessage;
		hookMessage: HookMessage;
		branchSummary: BranchSummaryMessage;
		compactionSummary: CompactionSummaryMessage;
	}
}
export type ConvertToLlm = (messages: AgentMessage[]) => Message[];

function projectOpenAIResponsesHistoryPayload(
	providerPayload: ProviderPayload | undefined,
	omittedCallIds: ReadonlySet<string> | undefined,
	rewrittenTurn: boolean,
): ProviderPayload | undefined {
	if (
		providerPayload?.type !== "openaiResponsesHistory" ||
		omittedCallIds === undefined ||
		omittedCallIds.size === 0
	) {
		return providerPayload;
	}

	const dropAllReasoning = rewrittenTurn && providerPayload.dt === true;
	const reasoningToRemove = new Set<Record<string, unknown>>();
	if (!dropAllReasoning) {
		let responseReasoning: Array<Record<string, unknown>> = [];
		let responseHasOmittedCall = false;
		const finishResponse = (): void => {
			if (responseHasOmittedCall) {
				for (const reasoning of responseReasoning) reasoningToRemove.add(reasoning);
			}
			responseReasoning = [];
			responseHasOmittedCall = false;
		};
		for (const item of providerPayload.items) {
			if (isOpenAIResponsesClientInputBoundary(item)) {
				finishResponse();
				continue;
			}
			if (item.type === "reasoning") {
				responseReasoning.push(item);
				continue;
			}
			if (
				typeof item.type === "string" &&
				item.type.endsWith("_call") &&
				typeof item.call_id === "string" &&
				omittedCallIds.has(item.call_id)
			) {
				responseHasOmittedCall = true;
			}
		}
		finishResponse();
	}

	let changed = false;
	const items = providerPayload.items.filter(item => {
		const omit =
			(typeof item.call_id === "string" && omittedCallIds.has(item.call_id)) ||
			(item.type === "reasoning" && (dropAllReasoning || reasoningToRemove.has(item)));
		if (omit) changed = true;
		return !omit;
	});
	return changed ? { ...providerPayload, items } : providerPayload;
}

function projectMessageOpenAIResponsesHistory(
	message: Extract<AgentMessage, { role: "user" | "developer" | "compactionSummary" }>,
	omittedCallIds: ReadonlySet<string>,
): AgentMessage {
	const providerPayload = projectOpenAIResponsesHistoryPayload(message.providerPayload, omittedCallIds, false);
	return providerPayload === message.providerPayload ? message : { ...message, providerPayload };
}

function normalizeAssistantAfterToolRemovalWithNativeHistory(
	message: AssistantMessage,
	remove: (call: ToolCall) => boolean,
	keepEmpty: boolean,
	previouslyOmittedCallIds?: ReadonlySet<string>,
): AssistantMessage | undefined {
	let removedCalls: Set<ToolCall> | undefined;
	let omittedCallIds = previouslyOmittedCallIds;
	let locallyOmittedCallIds: Set<string> | undefined;
	for (const block of message.content) {
		if (block.type !== "toolCall" || !remove(block)) continue;
		removedCalls ??= new Set<ToolCall>();
		removedCalls.add(block);
		const callId = normalizeResponsesToolCallId(block.id).callId;
		if (omittedCallIds?.has(callId)) continue;
		locallyOmittedCallIds ??= new Set(omittedCallIds);
		locallyOmittedCallIds.add(callId);
		omittedCallIds = locallyOmittedCallIds;
	}

	const providerPayload = projectOpenAIResponsesHistoryPayload(
		message.providerPayload,
		omittedCallIds,
		removedCalls !== undefined,
	);
	if (!removedCalls) {
		return providerPayload === message.providerPayload ? message : { ...message, providerPayload };
	}
	const callsToRemove = removedCalls;
	const content = message.content
		.filter(block => !(block.type === "toolCall" && callsToRemove.has(block)) && block.type !== "redactedThinking")
		.map(block =>
			block.type === "thinking" && block.thinkingSignature ? { ...block, thinkingSignature: undefined } : block,
		);
	const hasSurvivingProviderPayload =
		providerPayload?.type === "openaiResponsesHistory"
			? providerPayload.items.length > 0
			: providerPayload !== undefined;
	if (content.length === 0 && !keepEmpty && !hasSurvivingProviderPayload) return undefined;
	return { ...message, content, providerPayload };
}

/**
 * Remove selected native tool calls from an assistant turn and normalize
 * provider-bound reasoning on the rewritten turn. Opaque reasoning is tied to
 * the original turn shape, so a changed turn drops encrypted reasoning and
 * clears signatures while preserving visible thinking.
 */
export function normalizeAssistantAfterToolRemoval(
	message: AssistantMessage,
	remove: (call: ToolCall) => boolean,
	keepEmpty = false,
): AssistantMessage | undefined {
	return normalizeAssistantAfterToolRemovalWithNativeHistory(message, remove, keepEmpty);
}

/**
 * Project persisted native tool-history omission markers into model context.
 * Unchanged messages retain identity; journal objects are never mutated.
 */
export function projectToolHistoryMessage(message: AgentMessage): AgentMessage | undefined {
	if (message.role === "toolResult" && message.contextOmitted === true) return undefined;
	if (message.role !== "assistant") return message;
	return normalizeAssistantAfterToolRemoval(message, call => call.contextOmitted === true);
}

/** Newest persisted tool-result rewrite timestamp in a message sequence. */
export function latestToolHistoryRewriteAt(messages: readonly AgentMessage[]): number | undefined {
	let latest: number | undefined;
	for (const message of messages) {
		if (message.role !== "toolResult" || message.prunedAt === undefined || !Number.isFinite(message.prunedAt)) {
			continue;
		}
		latest = latest === undefined ? message.prunedAt : Math.max(latest, message.prunedAt);
	}
	return latest;
}

/**
 * Carry a persisted rewrite timestamp on a copy of the first surviving user
 * message. The source message and journal remain untouched.
 */
export function withToolHistoryRewriteAnchor(
	messages: readonly AgentMessage[],
	latestRewriteAt: number | undefined,
): AgentMessage[] {
	const output = [...messages];
	if (latestRewriteAt === undefined) return output;
	const firstUserIndex = output.findIndex(message => message.role === "user");
	if (firstUserIndex < 0) return output;
	const firstUser = output[firstUserIndex];
	if (firstUser.role !== "user") return output;
	output[firstUserIndex] = {
		...firstUser,
		historyRewriteAt: Math.max(firstUser.historyRewriteAt ?? 0, latestRewriteAt),
	};
	return output;
}

/**
 * Project a message sequence while preserving one output slot per source
 * message. Omitted messages occupy `undefined` slots so callers can retain
 * journal-entry alignment without giving up sequence-aware native filtering.
 */
export function projectToolHistoryMessagesAligned(messages: readonly AgentMessage[]): Array<AgentMessage | undefined> {
	let omittedCallIds: Set<string> | undefined;
	for (const message of messages) {
		if (message.role === "toolResult" && message.contextOmitted === true) {
			omittedCallIds ??= new Set<string>();
			omittedCallIds.add(normalizeResponsesToolCallId(message.toolCallId).callId);
			continue;
		}
		if (message.role !== "assistant") continue;
		for (const block of message.content) {
			if (block.type === "toolCall" && block.contextOmitted === true) {
				omittedCallIds ??= new Set<string>();
				omittedCallIds.add(normalizeResponsesToolCallId(block.id).callId);
			}
		}
	}

	const projected: Array<AgentMessage | undefined> = [];
	for (const message of messages) {
		if (message.role === "toolResult" && message.contextOmitted === true) {
			projected.push(undefined);
			continue;
		}
		if (message.role === "assistant") {
			projected.push(
				normalizeAssistantAfterToolRemovalWithNativeHistory(
					message,
					call => call.contextOmitted === true,
					false,
					omittedCallIds,
				),
			);
			continue;
		}
		if (
			omittedCallIds !== undefined &&
			(message.role === "user" || message.role === "developer" || message.role === "compactionSummary")
		) {
			projected.push(projectMessageOpenAIResponsesHistory(message, omittedCallIds));
			continue;
		}
		projected.push(message);
	}
	return projected;
}

/**
 * Project a message sequence and carry the newest persisted rewrite timestamp
 * on a copy of its first surviving user message.
 */
export function projectToolHistoryMessages(messages: readonly AgentMessage[]): AgentMessage[] {
	const projected = projectToolHistoryMessagesAligned(messages);
	let outputIndex = 0;
	for (let inputIndex = 0; inputIndex < projected.length; inputIndex++) {
		const message = projected[inputIndex];
		if (message === undefined) continue;
		projected[outputIndex++] = message;
	}
	projected.length = outputIndex;
	return withToolHistoryRewriteAnchor(projected as AgentMessage[], latestToolHistoryRewriteAt(messages));
}

function getPrunedToolResultContent(message: ToolResultMessage): (TextContent | ImageContent)[] {
	if (message.prunedAt === undefined) {
		return message.content;
	}
	const textBlocks = message.content.filter((content): content is TextContent => content.type === "text");
	const text = textBlocks.map(block => block.text).join("") || "[Output truncated]";
	const firstTextIndex = message.content.findIndex(content => content.type === "text");
	if (firstTextIndex < 0) return [{ type: "text", text }, ...message.content];

	const content: (TextContent | ImageContent)[] = [];
	for (let index = 0; index < message.content.length; index++) {
		const block = message.content[index];
		if (block.type !== "text") content.push(block);
		else if (index === firstTextIndex) content.push({ type: "text", text });
	}
	return content;
}

export function renderBranchSummaryContext(summary: string): string {
	return prompt.render(BRANCH_SUMMARY_TEMPLATE, { summary });
}

export function renderCompactionSummaryContext(summary: string): string {
	return prompt.render(COMPACTION_SUMMARY_TEMPLATE, { summary });
}
/**
 * Wrap a handoff document for injection into the successor context. Unlike the
 * generic compaction wrapper, this names the mechanism and pins authorship —
 * the document was written by a prior instance in its own voice, so without
 * this framing the successor misreads first-person "Next Steps" as fresh user
 * instructions (or tries to write the handoff again).
 */
export function renderHandoffSummaryContext(summary: string): string {
	return prompt.render(HANDOFF_SUMMARY_TEMPLATE, { summary });
}

export function createBranchSummaryMessage(summary: string, fromId: string, timestamp: string): BranchSummaryMessage {
	return {
		role: "branchSummary",
		summary,
		fromId,
		timestamp: new Date(timestamp).getTime(),
	};
}

/** Optional metadata for {@link createCompactionSummaryMessage}. */
export interface CompactionSummaryMessageOptions {
	shortSummary?: string;
	providerPayload?: ProviderPayload;
	images?: ImageContent[];
	blocks?: (TextContent | ImageContent)[];
	warning?: string;
	/** Harness compaction method that produced this summary (e.g. "remote", "soft", "handoff"). */
	method?: string;
	/** Estimated context tokens after the rewrite, for display alongside `tokensBefore`. */
	tokensAfter?: number;
}

export function createCompactionSummaryMessage(
	summary: string,
	tokensBefore: number,
	timestamp: string,
	options: CompactionSummaryMessageOptions = {},
): CompactionSummaryMessage {
	const { shortSummary, providerPayload, images, blocks, warning, method, tokensAfter } = options;
	const imageBlocks =
		blocks?.filter((block): block is ImageContent => block.type === "image") ??
		(images && images.length > 0 ? images : undefined);
	return {
		role: "compactionSummary",
		summary,
		shortSummary,
		tokensBefore,
		tokensAfter,
		method,
		providerPayload,
		blocks: blocks && blocks.length > 0 ? blocks : undefined,
		images: imageBlocks && imageBlocks.length > 0 ? imageBlocks : undefined,
		warning,
		timestamp: new Date(timestamp).getTime(),
	};
}

export function createCustomMessage(
	customType: string,
	content: string | (TextContent | ImageContent)[],
	display: boolean,
	details: unknown | undefined,
	timestamp: string,
	attribution?: MessageAttribution,
): CustomMessage {
	return {
		role: "custom",
		customType,
		content,
		display,
		details,
		attribution,
		timestamp: new Date(timestamp).getTime(),
	};
}

function isCoreCompactionMessage(message: AgentMessage): message is AgentMessage & CoreCompactionMessage {
	return (
		message.role === "custom" ||
		message.role === "hookMessage" ||
		message.role === "branchSummary" ||
		message.role === "compactionSummary"
	);
}

/**
 * Transform a single core-domain agent message to its LLM form; `undefined`
 * drops it from the provider request.
 *
 * Single source of truth for the core roles (user/developer/assistant/
 * toolResult) and the compaction messages owned by this package. Embedders
 * with their own app messages (e.g. the coding agent) handle their custom
 * roles and delegate every core role here — duplicating these cases is how
 * snapcompact frames once silently fell off the provider request.
 */
export function convertMessageToLlm(message: AgentMessage): Message | undefined {
	const projected = projectToolHistoryMessage(message);
	if (projected === undefined) return undefined;
	message = projected;
	if (isCoreCompactionMessage(message)) {
		switch (message.role) {
			case "custom":
			case "hookMessage": {
				const content =
					typeof message.content === "string"
						? [{ type: "text" as const, text: message.content }]
						: message.content;
				return {
					role: "developer",
					content,
					attribution: message.attribution,
					timestamp: message.timestamp,
				};
			}
			case "branchSummary":
				return {
					role: "user",
					content: [
						{
							type: "text" as const,
							text: renderBranchSummaryContext(message.summary),
						},
					],
					attribution: "agent",
					historyRewriteAt: message.timestamp,
					timestamp: message.timestamp,
				};
			case "compactionSummary":
				return {
					role: "user",
					content:
						message.blocks !== undefined
							? [{ type: "text" as const, text: message.summary }, ...message.blocks]
							: [
									{
										type: "text" as const,
										text:
											message.method === "handoff"
												? renderHandoffSummaryContext(message.summary)
												: renderCompactionSummaryContext(message.summary),
									},
									...(message.images ?? []),
								],
					attribution: "agent",
					historyRewriteAt: message.timestamp,
					providerPayload: message.providerPayload,
					timestamp: message.timestamp,
				};
		}
	}

	switch (message.role) {
		case "user":
			return { ...message, attribution: message.attribution ?? "user" };
		case "developer":
			return { ...message, attribution: message.attribution ?? "agent" };
		case "assistant":
			return message;
		case "toolResult":
			return {
				...message,
				content: getPrunedToolResultContent(message as ToolResultMessage),
				attribution: message.attribution ?? "agent",
			};
		default:
			return undefined;
	}
}

/**
 * Default compaction-domain transformer.
 *
 * Embedders with their own app messages should pass a richer transformer through
 * `SummaryOptions.convertToLlm`; this default intentionally preserves only the
 * core LLM roles and the compaction messages owned by this package.
 */
export function defaultConvertToLlm(messages: AgentMessage[]): Message[] {
	return projectToolHistoryMessages(messages)
		.map(convertMessageToLlm)
		.filter(message => message !== undefined);
}
