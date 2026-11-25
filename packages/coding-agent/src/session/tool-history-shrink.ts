/**
 * Send-time shrinking of oversized tool history.
 *
 * Huge tool-call arguments (e.g. a `task` call carrying hundreds of KB of
 * inline data) and huge tool results keep being replayed on every request
 * after the turn that produced them, until the provider rejects the prompt.
 * The user's session file must keep the full values, so this module only ever
 * builds provider-bound copies: input messages, content blocks and argument
 * objects are never mutated.
 *
 * Only completed calls (a matching tool result exists) are shrunk; a pending
 * call is never rewritten. Tool-call ids, names and the call/result pairing
 * are preserved.
 */
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { registerMessageCacheInvalidator } from "@oh-my-pi/pi-agent-core/compaction/message-cache";
import type { AssistantMessage, ToolCall, ToolResultMessage } from "@oh-my-pi/pi-ai";
import { normalizeResponsesToolCallId } from "@oh-my-pi/pi-ai/utils";
import { isUserTurnInitiator } from "@oh-my-pi/pi-tui/chat/messages";
import { truncateHeadBytes, truncateTailBytes } from "@oh-my-pi/pi-tui/tools/streaming-output";
import { stringifyJson } from "@oh-my-pi/pi-utils";

/** Argument strings above this many UTF-8 bytes are replaced by a marker. */
export const MAX_TOOL_ARGUMENT_STRING_BYTES = 16_384;
/** Tool result text above this many UTF-8 bytes keeps only its head and tail. */
export const MAX_TOOL_RESULT_TEXT_BYTES = 262_144;
/** UTF-8 bytes kept at each end of an oversized tool result text. */
export const TOOL_RESULT_EDGE_BYTES = 8_192;

const NO_CALL_IDS: ReadonlySet<string> = new Set();

function omittedMarker(bytes: number, original: string): string {
	const digest = new Bun.CryptoHasher("sha256").update(original).digest("hex").slice(0, 12);
	return `[omitted ${bytes} bytes, sha256=${digest}; full value kept in the session file]`;
}

/** Copy-on-write recursive shrink; returns the input reference when nothing changed. */
function shrinkValue(value: unknown): unknown {
	if (typeof value === "string") {
		// UTF-16 length x3 bounds the UTF-8 length; skip the byte count for short strings.
		if (value.length * 3 <= MAX_TOOL_ARGUMENT_STRING_BYTES) return value;
		const bytes = Buffer.byteLength(value, "utf8");
		return bytes > MAX_TOOL_ARGUMENT_STRING_BYTES ? omittedMarker(bytes, value) : value;
	}
	if (Array.isArray(value)) {
		let copy: unknown[] | undefined;
		for (let i = 0; i < value.length; i++) {
			const next = shrinkValue(value[i]);
			if (next !== value[i]) {
				copy ??= value.slice();
				copy[i] = next;
			}
		}
		return copy ?? value;
	}
	if (value !== null && typeof value === "object") {
		let copy: Record<string, unknown> | undefined;
		for (const [key, item] of Object.entries(value)) {
			const next = shrinkValue(item);
			if (next !== item) {
				copy ??= { ...(value as Record<string, unknown>) };
				copy[key] = next;
			}
		}
		return copy ?? value;
	}
	return value;
}

// Per-block memo: each call's arguments are walked and hashed at most once.
const shrunkCalls = new WeakMap<ToolCall, ToolCall>();

function shrinkToolCall(call: ToolCall): ToolCall {
	const cached = shrunkCalls.get(call);
	if (cached) return cached;
	const args = shrinkValue(call.arguments) as Record<string, unknown>;
	let shrunk = call;
	if (args !== call.arguments) {
		// The in-band raw block replays the original huge arguments verbatim; drop it so
		// the provider re-renders the call from the shrunk arguments. A Gemini
		// `thoughtSignature` is an encrypted attestation over the original call, so it
		// cannot ride along with rewritten arguments (see obfuscateAssistantContentForReplay).
		const { rawBlock: _rawBlock, thoughtSignature: _thoughtSignature, ...rest } = call;
		shrunk = { ...rest, arguments: args };
	}
	shrunkCalls.set(call, shrunk);
	return shrunk;
}

function shrinkResultText(text: string): string {
	if (text.length * 3 <= MAX_TOOL_RESULT_TEXT_BYTES) return text;
	// Byte count without materializing a second copy of a very large result; only the
	// two retained edges are windowed out of the string.
	const totalBytes = Buffer.byteLength(text, "utf8");
	if (totalBytes <= MAX_TOOL_RESULT_TEXT_BYTES) return text;
	const head = truncateHeadBytes(text, TOOL_RESULT_EDGE_BYTES);
	const tail = truncateTailBytes(text, TOOL_RESULT_EDGE_BYTES);
	return `${head.text}\n${omittedMarker(totalBytes - head.bytes - tail.bytes, text)}\n${tail.text}`;
}

interface MessageMemo {
	key: string;
	message: AgentMessage;
}
// Per-message memo keyed by the shrunk call ids, so a shrunk copy keeps one identity
// across requests and the converter's per-message cache keeps hitting.
const shrunkMessages = new WeakMap<AgentMessage, MessageMemo>();

// Owners that rewrite a message in place (prune/shake/strip) must not see a stale copy.
registerMessageCacheInvalidator(message => {
	shrunkMessages.delete(message);
	if (message.role !== "assistant") return;
	for (const block of message.content) if (block.type === "toolCall") shrunkCalls.delete(block);
});

/**
 * Shrinks one message for the provider. `completedCallIds` lists the tool calls
 * that already have a result; other calls of an assistant message stay intact.
 * Completed call arguments shrink wherever the message sits, because the result
 * already exists. Tool result text shrinks only when `shrinkResults` is set.
 * Returns the input message when nothing exceeds the limits.
 */
export function shrinkToolHistoryMessage(
	message: AgentMessage,
	completedCallIds: ReadonlySet<string>,
	shrinkResults: boolean,
): AgentMessage {
	if (message.role === "toolResult") {
		if (!shrinkResults) return message;
		const memo = shrunkMessages.get(message);
		if (memo) return memo.message;
		const result = message as ToolResultMessage;
		let content: ToolResultMessage["content"] | undefined;
		for (let i = 0; i < result.content.length; i++) {
			const block = result.content[i]!;
			if (block.type !== "text") continue;
			const text = shrinkResultText(block.text);
			if (text === block.text) continue;
			content ??= result.content.slice();
			content[i] = { ...block, text };
		}
		const shrunk = content ? ({ ...result, content } as AgentMessage) : message;
		shrunkMessages.set(message, { key: "", message: shrunk });
		return shrunk;
	}
	if (message.role !== "assistant" || completedCallIds.size === 0) return message;
	const assistant = message as AssistantMessage;
	let content: AssistantMessage["content"] | undefined;
	let key = "";
	for (let i = 0; i < assistant.content.length; i++) {
		const block = assistant.content[i]!;
		if (block.type !== "toolCall" || !completedCallIds.has(block.id)) continue;
		const shrunk = shrinkToolCall(block);
		if (shrunk === block) continue;
		content ??= assistant.content.slice();
		content[i] = shrunk;
		key += `${block.id}\0`;
	}
	if (!content) return message;
	const memo = shrunkMessages.get(message);
	if (memo?.key === key) return memo.message;
	// The user's native replay items take precedence over content on Responses-family
	// providers. Copy only matching shrunk calls; encrypted reasoning stays untouched.
	let providerPayload = assistant.providerPayload;
	if (providerPayload?.type === "openaiResponsesHistory") {
		const callsByWireId = new Map<string, ToolCall>();
		for (let i = 0; i < content.length; i++) {
			const block = content[i]!;
			if (block === assistant.content[i] || block.type !== "toolCall") continue;
			const { callId } = normalizeResponsesToolCallId(block.id, block.customWireName ? "ctc" : "fc");
			callsByWireId.set(callId, block);
		}
		let items: typeof providerPayload.items | undefined;
		for (let i = 0; i < providerPayload.items.length; i++) {
			const item: Record<string, unknown> = providerPayload.items[i]!;
			if (item.type !== "function_call" && item.type !== "custom_tool_call") continue;
			const call = typeof item.call_id === "string" ? callsByWireId.get(item.call_id) : undefined;
			if (!call) continue;
			const field = item.type === "function_call" ? "arguments" : "input";
			const args =
				item.type === "function_call"
					? (stringifyJson(call.arguments) ?? "null")
					: typeof call.arguments.input === "string"
						? call.arguments.input
						: "";
			if (item[field] === args) continue;
			items ??= providerPayload.items.slice();
			items[i] = { ...item, [field]: args };
		}
		if (items) providerPayload = { ...providerPayload, items };
	}
	const shrunk = {
		...assistant,
		content,
		...(providerPayload !== assistant.providerPayload ? { providerPayload } : {}),
	} as AgentMessage;
	shrunkMessages.set(message, { key, message: shrunk });
	return shrunk;
}

/**
 * Index of the latest turn the user started at or after `from` (agent-injected
 * prompts and notices do not count), or -1 when there is none.
 */
export function latestUserTurnIndex(messages: readonly AgentMessage[], from = 0): number {
	for (let i = messages.length - 1; i >= from; i--) {
		const message = messages[i]!;
		if (message.role === "user" && message.attribution !== "agent") return i;
		if (message.role === "custom" && isUserTurnInitiator(message)) return i;
	}
	return -1;
}

/**
 * Ids of the calls that already have a result, for the assistant message at
 * `index`. Results follow their call before the next assistant message; other
 * roles get the empty set.
 */
export function completedToolCallIds(messages: readonly AgentMessage[], index: number): ReadonlySet<string> {
	if (messages[index]?.role !== "assistant") return NO_CALL_IDS;
	const ids = new Set<string>();
	for (let i = index + 1; i < messages.length; i++) {
		const message = messages[i]!;
		if (message.role === "assistant") break;
		if (message.role === "toolResult") ids.add(message.toolCallId);
	}
	return ids;
}

/**
 * Returns a provider-bound copy of `messages` with oversized tool history shrunk.
 *
 * Completed calls' arguments are shrunk in every turn, including the current one.
 * Tool result text is eligible only before the latest real user turn, so the
 * current turn's results replay exactly. With `wholeContext` (one forced retry
 * after a post-compaction overflow) every result in the active context is eligible,
 * including the latest turn. Pending calls are never rewritten. Returns the input
 * array when nothing changed; never mutates its input.
 */
export function shrinkOversizedToolHistory(messages: AgentMessage[], wholeContext = false): AgentMessage[] {
	const resultEnd = wholeContext ? messages.length : latestUserTurnIndex(messages);
	let out: AgentMessage[] | undefined;
	for (let i = 0; i < messages.length; i++) {
		const message = messages[i]!;
		const next = shrinkToolHistoryMessage(message, completedToolCallIds(messages, i), i < resultEnd);
		if (next === message) continue;
		out ??= messages.slice();
		out[i] = next;
	}
	return out ?? messages;
}
