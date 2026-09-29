import type { ImageContent, TextContent, ToolResultMessage } from "@oh-my-pi/pi-wire";
import { isRecord } from "../tool-render/util";

/** Execution frames carry a result envelope, not just renderer details. Preserve its output and structured fields. */
export function normalizeToolResult(
	toolCallId: string,
	toolName: string,
	value: unknown,
	isError?: boolean,
): ToolResultMessage {
	const record = isRecord(value) ? value : undefined;
	const rawContent = record?.content ?? value;
	const content: (TextContent | ImageContent)[] = [];
	if (typeof rawContent === "string") {
		content.push({ type: "text", text: rawContent });
	} else if (Array.isArray(rawContent)) {
		for (const block of rawContent) {
			if (!isRecord(block)) continue;
			if (block.type === "text" && typeof block.text === "string") {
				content.push({ type: "text", text: block.text });
			} else if (block.type === "image" && typeof block.data === "string" && typeof block.mimeType === "string") {
				content.push({ type: "image", data: block.data, mimeType: block.mimeType });
			}
		}
	}
	return {
		role: "toolResult",
		toolCallId,
		toolName,
		content,
		details: record && ("content" in record || "details" in record) ? record.details : record,
		isError: isError ?? (typeof record?.isError === "boolean" ? record.isError : false),
		timestamp: Date.now(),
	};
}
