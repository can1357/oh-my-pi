/** Maps omp's per-step transcript onto one stateful agy turn. */
import { createHash } from "node:crypto";
import { prompt, stableStringifyJson } from "@oh-my-pi/pi-utils";
import type { ContentBlock } from "@oh-my-pi/pi-utils/acp";
import type {
	AntigravityCliCheckpoint,
	DeveloperMessage,
	ImageContent,
	Message,
	TextContent,
	ToolResultMessage,
	UserMessage,
} from "../../types";
import lateToolResultTemplate from "./late-tool-result.md" with { type: "text" };
import toolResultImagesTemplate from "./tool-result-images.md" with { type: "text" };
import transcriptTemplate from "./transcript.md" with { type: "text" };

const CHECKPOINT_START = prompt.render(transcriptTemplate, { checkpoint: true });
const CHECKPOINT_END = "</conversation-checkpoint>";
const HISTORY_OMISSION = prompt.render(transcriptTemplate, { omittedHistory: true });
const IMAGE_OMISSION = prompt.render(transcriptTemplate, { omittedImages: true });

/** The exact leading transcript represented by the live conversation. */
export interface Ledger {
	count: number;
	digest: string;
	pendingToolCallId?: string;
}

/** New user-side input for agy. */
export type InputMessage = UserMessage | DeveloperMessage;

export type TurnPlan =
	| { kind: "resume"; toolResult?: ToolResultMessage; input: InputMessage[] }
	| {
			kind: "restore";
			conversationId: string;
			digest: string;
			checkpoint: AntigravityCliCheckpoint;
			replay: Message[];
	  }
	| { kind: "fresh"; replay: Message[] };

/** Reuse only an exact visible prefix; otherwise fork a recorded turn end or reseed. */
export function planTurn(messages: readonly Message[], ledger: Ledger | undefined): TurnPlan {
	if (
		ledger &&
		messages.length > ledger.count &&
		transcriptDigest(messages.slice(0, ledger.count)) === ledger.digest
	) {
		const tail = messages.slice(ledger.count);
		const first = tail[0];
		const toolResult =
			ledger.pendingToolCallId !== undefined &&
			first?.role === "toolResult" &&
			first.toolCallId === ledger.pendingToolCallId
				? first
				: undefined;
		const input = toolResult ? tail.slice(1) : tail;
		if ((ledger.pendingToolCallId === undefined || toolResult) && input.every(isInputMessage)) {
			return { kind: "resume", toolResult, input };
		}
	}
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (message?.role !== "assistant") continue;
		const payload = message.providerPayload;
		if (payload?.type !== "antigravityCli" || !payload.checkpoint) continue;
		if (transcriptDigest(messages.slice(0, index + 1)) !== payload.digest) continue;
		return {
			kind: "restore",
			conversationId: payload.conversationId,
			digest: payload.digest,
			checkpoint: payload.checkpoint,
			replay: messages.slice(index + 1),
		};
	}
	return { kind: "fresh", replay: [...messages] };
}

/** Fingerprint model-visible ordered content, excluding timestamps, usage and presentation metadata. */
export function transcriptDigest(messages: readonly Message[]): string {
	const hash = createHash("sha256");
	for (const message of messages) {
		hash.update(stableStringifyJson(messageContent(message)));
		hash.update("\n");
	}
	return hash.digest("hex");
}

/** Budget only the image blocks in the outgoing steer or delayed result, newest first. */
export function projectPromptImages(blocks: ContentBlock[], imageBudget: number): ContentBlock[] {
	let images = 0;
	for (const block of blocks) if (block.type === "image") images++;
	const omitted = images - imageBudget;
	let drops = omitted;
	if (drops <= 0) return blocks;
	let write = 0;
	for (const block of blocks) {
		if (block.type === "image" && drops > 0) {
			if (drops === omitted) blocks[write++] = { type: "text", text: IMAGE_OMISSION };
			drops--;
		} else {
			blocks[write++] = block;
		}
	}
	blocks.length = write;
	return blocks;
}

/** Keep the newest replay content that fits, then emit it in chronological order. */
export function replayPrompt(
	replay: readonly Message[],
	textBudget: number,
	imageBudget: number,
): { blocks: ContentBlock[]; omittedHistory: boolean; omittedImages: boolean } {
	let split = replay.length;
	while (split > 0 && isInputMessage(replay[split - 1]!)) split--;
	const blocks: ContentBlock[] = [];
	let hasCheckpoint = false;
	let omittedHistory = false;
	let omittedImages = false;
	const checkpointBytes = textBytes(CHECKPOINT_START) + textBytes(CHECKPOINT_END);
	let remaining = textBudget - textBytes(HISTORY_OMISSION) - textBytes(IMAGE_OMISSION);
	if (replay.length > 0 && remaining < 0)
		throw new Error("Antigravity CLI system prompt leaves no room for conversation replay");
	const appendText = (text: string, allowClip: boolean): boolean => {
		const bytes = textBytes(text);
		if (bytes <= remaining) {
			blocks.push({ type: "text", text });
			remaining -= bytes;
			return true;
		}
		if (allowClip) {
			const tail = utf8Tail(text, remaining - 2);
			if (tail) blocks.push({ type: "text", text: tail });
		}
		return false;
	};
	for (let index = replay.length - 1; index >= 0; index--) {
		const message = replay[index]!;
		const wrapped = index < split;
		const tag = message.role === "toolResult" ? "tool_result" : message.role;
		const attrs =
			wrapped && message.role === "toolResult"
				? ` id=${JSON.stringify(message.toolCallId)} name=${JSON.stringify(message.toolName)} error=${message.isError}`
				: "";
		const start = wrapped ? `<${tag}${attrs}>` : "";
		const end = wrapped ? `</${tag}>` : "";
		const wrapperBytes = wrapped ? textBytes(start) + textBytes(end) + (hasCheckpoint ? 0 : checkpointBytes) : 0;
		if (wrapperBytes > remaining) {
			omittedHistory = true;
			break;
		}
		remaining -= wrapperBytes;
		if (wrapped) {
			if (!hasCheckpoint) {
				hasCheckpoint = true;
				blocks.push({ type: "text", text: CHECKPOINT_END });
			}
			blocks.push({ type: "text", text: end });
		}
		const content = message.content;
		if (typeof content === "string") {
			omittedHistory = !appendText(content, true);
		} else {
			for (let partIndex = content.length - 1; partIndex >= 0; partIndex--) {
				const part = content[partIndex]!;
				if (part.type === "image") {
					if (imageBudget <= 0) {
						omittedImages = true;
						continue;
					}
					// Leave space for agy's text-side image reference, not its base64 media.
					if (remaining < 64) {
						omittedHistory = true;
						break;
					}
					remaining -= 64;
					imageBudget--;
					blocks.push({ type: "image", data: part.data, mimeType: part.mimeType });
					continue;
				}
				let text: string;
				switch (part.type) {
					case "text":
						text = part.text;
						break;
					case "thinking":
						text = `<thinking>${part.thinking}</thinking>`;
						break;
					case "toolCall":
						text = `<tool_call id=${JSON.stringify(part.id)} name=${JSON.stringify(part.name)}>${stableStringifyJson(part.arguments)}</tool_call>`;
						break;
					default:
						continue;
				}
				// Keep plain-text suffixes without emitting half a tool_call or thinking tag.
				if (!appendText(text, part.type === "text")) {
					omittedHistory = true;
					break;
				}
			}
		}
		if (wrapped) blocks.push({ type: "text", text: start });
		if (omittedHistory) break;
	}
	if (omittedImages) blocks.push({ type: "text", text: IMAGE_OMISSION });
	if (omittedHistory) blocks.push({ type: "text", text: HISTORY_OMISSION });
	if (hasCheckpoint) blocks.push({ type: "text", text: CHECKPOINT_START });
	return { blocks: blocks.reverse(), omittedHistory, omittedImages };
}

/** Charge room for the separator agy adds between text blocks. */
function textBytes(text: string): number {
	return Buffer.byteLength(text) + 2;
}

/** Newest UTF-8 text within budget, without encoding discarded text or splitting a surrogate pair. */
function utf8Tail(text: string, bytes: number): string {
	let index = text.length;
	while (bytes > 0 && index > 0) {
		const unit = text.charCodeAt(index - 1);
		const previous = text.charCodeAt(index - 2);
		const pair = unit >= 0xdc00 && unit <= 0xdfff && previous >= 0xd800 && previous <= 0xdbff;
		const width = pair ? 4 : unit < 0x80 ? 1 : unit < 0x800 ? 2 : 3;
		if (width > bytes) break;
		bytes -= width;
		index -= pair ? 2 : 1;
	}
	return text.slice(index);
}

/** Supply the actual delayed result only after agy's old prompt has confirmed cancellation. */
export function lateToolResultPrompt(result: ToolResultMessage): ContentBlock[] {
	return [
		{
			type: "text",
			text: prompt.render(lateToolResultTemplate, {
				toolName: result.toolName,
				toolCallId: result.toolCallId,
				isError: result.isError,
			}),
		},
		...contentBlocks(result.content),
		{ type: "text", text: "</tool_result>" },
	];
}

/** Deliver MCP tool-result images as ACP prompt blocks because agy offloads MCP media to unexposed files. */
export function toolResultImagesPrompt(result: ToolResultMessage): ContentBlock[] {
	const images = result.content.filter((part): part is ImageContent => part.type === "image");
	if (images.length === 0) return [];
	return [
		{
			type: "text",
			text: prompt.render(toolResultImagesTemplate, {
				toolCallId: result.toolCallId,
				toolName: result.toolName,
				isError: result.isError,
			}),
		},
		...contentBlocks(images),
		{ type: "text", text: "</tool_result>" },
	];
}

/** ACP input preserves text/image ordering and the complete image bytes. */
export function inputBlocks(message: InputMessage): ContentBlock[] {
	return contentBlocks(message.content);
}

/** Whether a transcript message can be sent directly as ACP user input. */
export function isInputMessage(message: Message): message is InputMessage {
	return message.role === "user" || message.role === "developer";
}

function contentBlocks(content: string | readonly (TextContent | ImageContent)[]): ContentBlock[] {
	if (typeof content === "string") return [{ type: "text", text: content }];
	return content.map(part =>
		part.type === "text"
			? { type: "text", text: part.text }
			: { type: "image", data: part.data, mimeType: part.mimeType },
	);
}

function messageContent(message: Message): unknown {
	const content =
		typeof message.content === "string"
			? [{ type: "text", text: message.content }]
			: message.content.flatMap((part): unknown[] => {
					switch (part.type) {
						case "text":
							return [{ type: part.type, text: part.text }];
						case "image":
							return [{ type: part.type, data: part.data, mimeType: part.mimeType }];
						case "thinking":
							return [{ type: part.type, thinking: part.thinking }];
						case "toolCall":
							return [{ type: part.type, id: part.id, name: part.name, arguments: part.arguments }];
						// Opaque blocks from other providers are not sent to agy.
						default:
							return [];
					}
				});
	return message.role === "toolResult"
		? {
				role: message.role,
				toolCallId: message.toolCallId,
				toolName: message.toolName,
				isError: message.isError,
				content,
			}
		: { role: message.role, content };
}
