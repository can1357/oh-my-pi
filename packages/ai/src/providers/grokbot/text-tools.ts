import { isRecord, prompt } from "@oh-my-pi/pi-utils";
import type { Tool } from "../../types";
import { toolWireSchema } from "../../utils/schema/wire";
import type { GrokbotProtoRecord } from "./proto";
import systemPrompt from "./text-tools-system.md" with { type: "text" };
import historyPrompt from "./text-tools-history.md" with { type: "text" };

/** Render only tool declarations/history as text; leave native thinking and images intact. */
export function grokbotTextToolMessages(
	messages: readonly GrokbotProtoRecord[],
	tools: readonly Tool[],
): GrokbotProtoRecord[] {
	const output = messages.map(message => {
		const calls = Array.isArray(message.toolCalls) ? message.toolCalls.filter(isRecord) : [];
		const results =
			isRecord(message.toolContent) && Array.isArray(message.toolContent.parts)
				? message.toolContent.parts.filter(isRecord)
				: [];
		if (!calls.length && !results.length) return { ...message };
		const text = prompt
			.render(historyPrompt, {
				text: typeof message.text === "string" ? message.text : "",
				calls: calls.map(call => ({
					id: call.toolCallId,
					json: JSON.stringify({
						name: call.toolName,
						arguments:
							call.args ?? (typeof call.rawToolCallArgs === "string" ? { input: call.rawToolCallArgs } : {}),
					}),
				})),
				results: results.map(result => ({
					id: result.toolCallId,
					name: result.toolName,
					json: JSON.stringify(result.result ?? null),
				})),
			})
			.trim();
		const next: GrokbotProtoRecord = { ...message, role: results.length ? 1 : message.role, text };
		const images = results.flatMap(result =>
			Array.isArray(result.experimentalContent)
				? result.experimentalContent.filter(isRecord).filter(part => part.type === "image")
				: [],
		);
		if (images.length) {
			next.parts = { parts: [{ type: "text", text }, ...images] };
			delete next.text;
		}
		delete next.toolCalls;
		delete next.toolContent;
		return next;
	});
	const advertised = tools.map(tool => ({
		name: tool.name,
		description: tool.description,
		schema: JSON.stringify(toolWireSchema(tool)),
	}));
	if (output[0]?.role === 4 && typeof output[0].text === "string") {
		output[0] = {
			...output[0],
			text: prompt.render(systemPrompt, { existing: output[0].text, tools: advertised }).trim(),
		};
	} else {
		output.unshift({ role: 4, text: prompt.render(systemPrompt, { tools: advertised }).trim() });
	}
	return output;
}
