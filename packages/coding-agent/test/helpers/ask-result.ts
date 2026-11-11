import { parseJsonPayload } from "@oh-my-pi/pi-coding-agent/commit/utils";

/** Text block of an ask tool result, if it has one. */
export function askResultText(result: { content: Array<{ type: string; text?: string }> }): string | undefined {
	const block = result.content[0];
	return block?.type === "text" ? block.text : undefined;
}

/**
 * JSON payload an ask tool result embeds for the model, parsed.
 *
 * The payload is `JSON.stringify(data, null, 2)` inside the prose of
 * `prompts/tools/ask-result.md`; no code parses that prose, so tests compare the
 * payload instead of pinning the template's wording.
 */
export function askResultPayload(result: { content: Array<{ type: string; text?: string }> }): unknown {
	const content = askResultText(result);
	if (content === undefined) throw new Error("ask result has no text content");
	return parseJsonPayload(content);
}
