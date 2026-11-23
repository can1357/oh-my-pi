/**
 * Recovery for sloppy edit payloads the model emits as plain assistant text
 * instead of an `edit` tool call. The finalized message is rewritten in place
 * (via the agent's `transformAssistantMessage` hook) before it reaches the
 * context, the UI, or tool dispatch: the payload text is lifted out of the
 * text block and re-materialized as a synthetic `edit` tool call, so the
 * normal tool pipeline — validation, approval tiering, execution, rendering,
 * journaling, provider replay — runs it unchanged.
 */
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { mintToolCallId } from "@oh-my-pi/pi-ai/dialect";
import { extractInlineSloppyRegions } from "@oh-my-pi/pi-natives";

/**
 * Convert stray sloppy payloads in `message`'s text blocks into one synthetic
 * `edit` tool call. Mutates the message in place; returns the number of
 * payload regions recovered (0 = message untouched).
 *
 * Fires only on a clean `stop` turn with no tool calls: a `length`-truncated
 * payload must never execute half an edit, and a turn that already carries
 * tool calls handled its own edits (any quoted payload there is commentary).
 */
export function recoverInlineSloppyEdit(message: AssistantMessage): number {
	if (message.stopReason !== "stop") return 0;
	if (message.content.some(block => block.type === "toolCall")) return 0;
	const payloads: string[] = [];
	for (const block of message.content) {
		if (block.type !== "text") continue;
		const regions = extractInlineSloppyRegions(block.text);
		if (regions.length === 0) continue;
		let remaining = "";
		let cursor = 0;
		for (const region of regions) {
			remaining += block.text.slice(cursor, region.start);
			cursor = region.end;
			payloads.push(region.payload);
		}
		remaining += block.text.slice(cursor);
		block.text = remaining;
	}
	if (payloads.length === 0) return 0;
	message.content = message.content.filter(block => !(block.type === "text" && block.text.trim() === ""));
	const input = payloads.join("\n");
	message.content.push({
		type: "toolCall",
		id: mintToolCallId(),
		name: "edit",
		arguments: { input },
		rawBlock: input,
	});
	return payloads.length;
}
