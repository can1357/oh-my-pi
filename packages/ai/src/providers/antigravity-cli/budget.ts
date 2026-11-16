/**
 * Provider-local prompt budgets. agy rejects an oversized step with an opaque
 * server failure, so measure the blocks this host is about to send and fail
 * with the measured size before inference instead of losing part of the prompt.
 */
import type { ContentBlock } from "@oh-my-pi/pi-utils/acp";
import type { Model } from "../../types";

/** One step may carry at most 188,000 UTF-8 bytes of text; the server keeps only the first 192,000 and needs framing room. */
export const ACP_STEP_TEXT_BYTES = 188_000;
/** Local ceiling for decoded image bytes in one prompt. */
export const MAX_IMAGE_BYTES = 8_388_608;

/** Actionable error for a prompt the server would reject, or undefined when it fits. */
export function checkPromptBudget(blocks: readonly ContentBlock[], model: Pick<Model, "id">): string | undefined {
	let textBytes = 0;
	let imageBytes = 0;
	for (const block of blocks) {
		if (block.type === "text") textBytes += Buffer.byteLength(block.text, "utf8");
		else if (block.type === "image") imageBytes += Buffer.byteLength(block.data, "base64");
	}
	if (textBytes > ACP_STEP_TEXT_BYTES)
		return `Maximum context length exceeded: Antigravity CLI model ${model.id} would send ${textBytes} bytes of text in one step; the safe single-step budget is ${ACP_STEP_TEXT_BYTES} bytes. Compact the conversation and retry. No history or current request was sent or silently truncated.`;
	if (imageBytes > MAX_IMAGE_BYTES)
		return `Request payload too large (413): Antigravity CLI model ${model.id} would send ${imageBytes} bytes of images; the local ACP image budget is ${MAX_IMAGE_BYTES} bytes. Reduce attachments. No images were silently omitted or truncated.`;
	return undefined;
}
