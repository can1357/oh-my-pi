import { isDeepStrictEqual } from "node:util";
import type { AssistantMessage, RedactedThinkingContent, ThinkingContent, ToolCall } from "../../types";

type Content = AssistantMessage["content"];
type ReasoningContent = ThinkingContent | RedactedThinkingContent;

function textBlocks(content: Content): Extract<Content[number], { type: "text" }>[] {
	return content.filter(block => block.type === "text");
}

function reasoningBlocks(content: Content): ReasoningContent[] {
	return content.filter(
		(block): block is ReasoningContent => block.type === "thinking" || block.type === "redactedThinking",
	);
}

function thinkingBlocks(content: readonly ReasoningContent[]): ThinkingContent[] {
	return content.filter((block): block is ThinkingContent => block.type === "thinking");
}

function toolBlocks(content: Content): ToolCall[] {
	return content.filter(block => block.type === "toolCall");
}

function signature(block: ThinkingContent): string | undefined {
	return block.thinkingSignature === undefined || block.thinkingSignature === "" ? undefined : block.thinkingSignature;
}

function appendSignature(blocks: ReasoningContent[], candidate: ThinkingContent): boolean {
	const value = signature(candidate);
	if (value === undefined) return false;
	if (thinkingBlocks(blocks).some(block => signature(block) === value)) return false;
	blocks.push({ type: "thinking", thinking: "", thinkingSignature: value });
	return true;
}

function appendRedacted(blocks: ReasoningContent[], candidate: RedactedThinkingContent): void {
	if (!blocks.some(block => block.type === "redactedThinking" && block.data === candidate.data)) {
		blocks.push({ ...candidate });
	}
}

function reconcileReasoning(
	streamed: readonly ReasoningContent[],
	final: readonly ReasoningContent[],
): ReasoningContent[] {
	const streamedThinking = thinkingBlocks(streamed);
	const finalThinking = thinkingBlocks(final);
	const finalHasText = finalThinking.some(({ thinking }) => thinking.trim() !== "");
	const blocks: ReasoningContent[] = finalHasText
		? final.map(block => ({ ...block }))
		: streamed.map(block => ({ ...block }));

	if (finalHasText) {
		for (const candidate of streamedThinking) {
			const candidateSignature = signature(candidate);
			let index =
				candidateSignature === undefined
					? -1
					: blocks.findIndex(block => block.type === "thinking" && signature(block) === candidateSignature);
			if (index < 0 && candidate.thinking.trim() !== "") {
				index = blocks.findIndex(block => block.type === "thinking" && block.thinking === candidate.thinking);
			}
			const target = blocks[index];
			if (target?.type === "thinking" && candidateSignature !== undefined && signature(target) === undefined) {
				blocks[index] = { ...target, thinkingSignature: candidateSignature };
			} else if (index < 0) {
				appendSignature(blocks, candidate);
			}
		}
		return blocks;
	}

	const unmatchedFinal: ThinkingContent[] = [];
	for (const candidate of finalThinking) {
		const candidateSignature = signature(candidate);
		const index =
			candidateSignature === undefined
				? -1
				: blocks.findIndex(block => block.type === "thinking" && signature(block) === candidateSignature);
		const target = blocks[index];
		if (target?.type === "thinking" && candidateSignature !== undefined) {
			blocks[index] = { ...target, thinkingSignature: candidateSignature };
		} else if (candidateSignature !== undefined) {
			unmatchedFinal.push(candidate);
		}
	}

	const attachable = blocks
		.map((block, index) => ({ block, index }))
		.filter(
			(entry): entry is { block: ThinkingContent; index: number } =>
				entry.block.type === "thinking" &&
				entry.block.thinking.trim() !== "" &&
				signature(entry.block) === undefined,
		);
	if (unmatchedFinal.length === 1 && attachable.length === 1) {
		const target = attachable[0];
		const metadata = unmatchedFinal[0];
		if (target !== undefined && metadata !== undefined) {
			blocks[target.index] = { ...target.block, thinkingSignature: signature(metadata) };
			unmatchedFinal.length = 0;
		}
	}
	for (const candidate of unmatchedFinal) appendSignature(blocks, candidate);
	for (const candidate of final) {
		if (candidate.type === "redactedThinking") appendRedacted(blocks, candidate);
	}
	return blocks;
}

function indexedTools(blocks: readonly ToolCall[], source: "streamed" | "final"): Map<string, ToolCall> {
	const indexed = new Map<string, ToolCall>();
	for (const block of blocks) {
		if (indexed.has(block.id)) throw new Error(`Cursor ${source} response duplicated tool '${block.id}'`);
		indexed.set(block.id, block);
	}
	return indexed;
}

function compareTools(streamed: readonly ToolCall[], final: readonly ToolCall[]): void {
	const streamedById = indexedTools(streamed, "streamed");
	const finalById = indexedTools(final, "final");
	if (streamedById.size !== finalById.size) {
		throw new Error("Cursor final response tool set disagrees with completed streamed tools");
	}
	for (const [id, streamedTool] of streamedById) {
		const finalTool = finalById.get(id);
		if (finalTool === undefined)
			throw new Error("Cursor final response tool set disagrees with completed streamed tools");
		if (streamedTool.name !== finalTool.name)
			throw new Error(`Cursor final response changed the name of tool '${id}'`);
		if (!isDeepStrictEqual(streamedTool.arguments, finalTool.arguments)) {
			throw new Error(`Cursor final response changed the arguments of tool '${id}'`);
		}
	}
}

/**
 * Reconcile streamed and final copies without positional reasoning matches.
 * Final text wins when present; streamed thinking survives empty, signature-only,
 * or redacted final reasoning; completed tools must match by id, name, and args.
 */
export function reconcileFinalContent(streamed: Content, final?: Content): Content {
	if (final === undefined) {
		indexedTools(toolBlocks(streamed), "streamed");
		return streamed;
	}
	const streamedText = textBlocks(streamed);
	const finalText = textBlocks(final);
	const streamedTools = toolBlocks(streamed);
	const finalTools = toolBlocks(final);
	if (streamedTools.length > 0) compareTools(streamedTools, finalTools);
	else indexedTools(finalTools, "final");

	const reasoning = reconcileReasoning(reasoningBlocks(streamed), reasoningBlocks(final));
	const finalHasNonReasoning = finalText.length > 0 || finalTools.length > 0;
	if (finalText.length === 0 && finalTools.length > 0 && streamedText.length > 0) {
		return [...reasoning, ...streamedText, ...finalTools];
	}
	return [
		...reasoning,
		...(finalHasNonReasoning
			? final.filter(block => block.type !== "thinking" && block.type !== "redactedThinking")
			: streamed.filter(block => block.type !== "thinking" && block.type !== "redactedThinking")),
	];
}
