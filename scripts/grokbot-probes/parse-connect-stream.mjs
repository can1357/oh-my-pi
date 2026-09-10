/**
 * Shared Connect+proto stream parsing for Grok Bot live probes.
 *
 * Production decoder rejects incomplete toolCallPart frames and truncated
 * streams without an end-stream trailer — probe gates must match that.
 */
import {
	CONNECT_END_STREAM_FLAG,
	decodeInferenceStreamResponse,
} from "../../packages/ai/src/providers/grokbot/proto.ts";

export function upsertToolCall(toolCalls, part) {
	const name = String(part?.toolName || "");
	if (!name) return;
	const id = String(part.toolCallId || part.tool_call_id || "");
	const indexHint = part.toolIndex ?? part.tool_index;
	const idxKey = typeof indexHint === "number" ? `idx:${indexHint}` : undefined;
	const key = id || idxKey || `anon:${toolCalls.length}`;
	const chunk = part.args == null ? "" : String(part.args);
	let existing = toolCalls.find(t => t.key === key);
	if (!existing && id) existing = toolCalls.find(t => t.id === id && t.name === name);
	if (!existing && idxKey) existing = toolCalls.find(t => t.idxKey === idxKey && t.name === name);
	if (existing) {
		if (chunk && chunk !== existing.args) {
			existing.args = chunk.startsWith(existing.args) ? chunk : `${existing.args || ""}${chunk}`;
		}
		if (part.isComplete || part.is_complete) existing.complete = true;
		if (id) existing.id = id;
		if (idxKey) existing.idxKey = idxKey;
		return;
	}
	toolCalls.push({
		key,
		id,
		idxKey,
		name,
		args: chunk,
		complete: Boolean(part.isComplete || part.is_complete),
	});
}

/** True when a finished Shell call carries a JSON-object args payload. */
export function hasCompletedValidShell(toolCalls) {
	return toolCalls.some(call => {
		if (call.name !== "Shell" || !call.complete) return false;
		const raw = (call.args || "").trim();
		if (!raw.startsWith("{") || !raw.endsWith("}")) return false;
		try {
			const parsed = JSON.parse(raw);
			return Boolean(parsed && typeof parsed === "object" && !Array.isArray(parsed));
		} catch {
			return false;
		}
	});
}

/**
 * Parse a Connect response body into text / tool / trailer fields.
 * `ok` requires a decoded end-stream envelope and exact byte consumption.
 */
export function parseConnectStreamFrames(buf) {
	let o = 0;
	let texts = "";
	let end;
	let responseModel = "";
	const toolCalls = [];
	while (o + 5 <= buf.length) {
		const flags = buf[o];
		const len = buf.readUInt32BE(o + 1);
		o += 5;
		const bytes = buf.subarray(o, o + len);
		o += len;
		if (flags & CONNECT_END_STREAM_FLAG) {
			try {
				end = JSON.parse(bytes.toString("utf8"));
			} catch {
				end = { parseError: true };
			}
			continue;
		}
		try {
			const msg = decodeInferenceStreamResponse(bytes);
			if (msg.textPart?.text) texts += msg.textPart.text;
			if (msg.responseInfo?.model) responseModel = String(msg.responseInfo.model);
			if (msg.toolCallPart) upsertToolCall(toolCalls, msg.toolCallPart);
		} catch {
			/* ignore partial */
		}
	}
	const dbg = end?.error?.details?.[0]?.debug;
	const toolNames = toolCalls.map(t => t.name);
	return {
		ok: end !== undefined && !end?.parseError && !end?.error && o === buf.length,
		texts,
		responseModel,
		toolNames,
		toolCalls,
		completedShell: hasCompletedValidShell(toolCalls),
		message: end?.error?.message,
		status: dbg?.details?.additionalInfo?.providerStatusCode,
		providerError: dbg?.error,
		detail: dbg?.details?.detail,
		end,
	};
}
