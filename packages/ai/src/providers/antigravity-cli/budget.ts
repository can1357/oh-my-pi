/**
 * Provider-local prompt budgets. agy rejects an oversized step with an opaque
 * server failure, so measure the blocks this host is about to send — including
 * a tool result, which agy feeds back as model input — and fail with the
 * measured size before inference instead of losing part of the prompt.
 */
import type { ContentBlock } from "@oh-my-pi/pi-utils/acp";
import type { Model, ToolResultMessage } from "../../types";

/** One step may carry at most 188,000 UTF-8 bytes of text; the server keeps only the first 192,000 and needs framing room. */
export const ACP_STEP_TEXT_BYTES = 188_000;
/** Local ceiling for decoded image bytes in one prompt. */
export const MAX_IMAGE_BYTES = 8_388_608;

/** The ACP text and image blocks a tool result becomes when agy feeds it back as model input. */
export type ToolResultBlock = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

/** A tool result released to agy becomes model input, so it obeys the same per-step limits as a prompt. */
export function toolResultBlocks(result: Pick<ToolResultMessage, "content">): ToolResultBlock[] {
	return result.content.map(part =>
		part.type === "text"
			? { type: "text", text: part.text }
			: { type: "image", data: part.data, mimeType: part.mimeType },
	);
}

/** Actionable error for a prompt the server would reject, or undefined when it fits. */
export function checkPromptBudget(
	blocks: readonly (ContentBlock | ToolResultBlock)[],
	model: Pick<Model, "id">,
): string | undefined {
	const { textBytes, imageBytes } = measureBlocks(blocks);
	if (textBytes > ACP_STEP_TEXT_BYTES)
		return `Maximum context length exceeded: Antigravity CLI model ${model.id} would send ${textBytes} bytes of text in one step; the safe single-step budget is ${ACP_STEP_TEXT_BYTES} bytes. Compact the conversation and retry. No history or current request was sent or silently truncated.`;
	if (imageBytes > MAX_IMAGE_BYTES)
		return `Request payload too large (413): Antigravity CLI model ${model.id} would send ${imageBytes} bytes of images; the local ACP image budget is ${MAX_IMAGE_BYTES} bytes. Reduce attachments. No images were silently omitted or truncated.`;
	return undefined;
}

/** Actionable error for a tool result agy would receive as an oversized prompt, or undefined when it fits. */
export function checkToolResultBudget(
	result: Pick<ToolResultMessage, "toolName" | "content">,
	model: Pick<Model, "id">,
): string | undefined {
	const { textBytes, imageBytes } = measureBlocks(toolResultBlocks(result));
	if (textBytes > ACP_STEP_TEXT_BYTES)
		return `Maximum context length exceeded: the ${result.toolName} tool result would send ${textBytes} bytes of text to Antigravity CLI model ${model.id}; the safe single-step budget is ${ACP_STEP_TEXT_BYTES} bytes. The result was not sent; narrow the tool output and retry.`;
	if (imageBytes > MAX_IMAGE_BYTES)
		return `Request payload too large (413): the ${result.toolName} tool result would send ${imageBytes} bytes of images to Antigravity CLI model ${model.id}; the local ACP image budget is ${MAX_IMAGE_BYTES} bytes. The result was not sent; reduce the attachments and retry.`;
	return undefined;
}

function measureBlocks(blocks: readonly (ContentBlock | ToolResultBlock)[]): {
	textBytes: number;
	imageBytes: number;
} {
	let textBytes = 0;
	let imageBytes = 0;
	for (const block of blocks) {
		if (block.type === "text") textBytes += Buffer.byteLength(block.text, "utf8");
		else if (block.type === "image") imageBytes += Buffer.byteLength(block.data, "base64");
	}
	return { textBytes, imageBytes };
}
