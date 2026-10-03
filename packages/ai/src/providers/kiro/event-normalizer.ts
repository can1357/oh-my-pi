import { isRecord } from "@oh-my-pi/pi-utils";
import type { EventStreamMessage } from "../aws-eventstream";
import { kiroEventStreamError } from "./errors";
import type { KiroNormalizedEvent, KiroUsageMetrics } from "./types";

const METRIC_ALIASES: Readonly<Record<keyof KiroUsageMetrics, readonly string[]>> = {
	inputTokens: ["inputTokens", "input_tokens", "promptTokens", "prompt_tokens"],
	outputTokens: ["outputTokens", "output_tokens", "completionTokens", "completion_tokens"],
	cacheReadTokens: ["cacheReadTokens", "cache_read_tokens", "cacheReadInputTokens", "cachedTokens"],
	cacheWriteTokens: [
		"cacheCreationTokens",
		"cache_creation_tokens",
		"cacheWriteTokens",
		"cache_write_tokens",
		"cacheCreationInputTokens",
	],
	reasoningTokens: ["reasoningTokens", "reasoning_tokens", "reasoningOutputTokens"],
};

// `meteringEvent` is the live billing frame (`{ unit, unitPlural, usage }`, where
// `usage` is fractional credits, not tokens). It carries no token counts, so it is
// recognized here only to keep it out of the unknown-event path; token metrics still
// come from the `metricsEvent`/`usage` envelopes below.
const METRIC_EVENT_TYPES: Readonly<Record<string, true>> = {
	metricsEvent: true,
	usageEvent: true,
	usage: true,
	metrics: true,
	meteringEvent: true,
};
const KNOWN_EVENT_TYPES: Readonly<Record<string, true>> = {
	"initial-response": true,
	metadataEvent: true,
	reasoningContentEvent: true,
	assistantResponseEvent: true,
	toolUseEvent: true,
	contextUsageEvent: true,
	...METRIC_EVENT_TYPES,
};

function decodePayload(message: EventStreamMessage): Record<string, unknown> {
	try {
		const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(message.payload));
		if (!isRecord(value)) throw new Error("payload is not an object");
		return value;
	} catch (error) {
		throw kiroEventStreamError(message.headers, {
			code: "MALFORMED_EVENT_PAYLOAD",
			message: error instanceof Error ? error.message : "invalid JSON",
		});
	}
}

function normalizeMetrics(value: unknown): KiroUsageMetrics | undefined {
	if (!isRecord(value)) return undefined;
	const source = value;
	const usage: KiroUsageMetrics = {};
	for (const [field, aliases] of Object.entries(METRIC_ALIASES) as Array<
		[keyof KiroUsageMetrics, readonly string[]]
	>) {
		for (const alias of aliases) {
			const candidate = source[alias];
			if (typeof candidate === "number" && Number.isFinite(candidate) && candidate >= 0) {
				usage[field] = candidate;
				break;
			}
		}
	}
	return Object.keys(usage).length > 0 ? usage : undefined;
}

/** Normalize a CRC-decoded frame; never searches raw binary bytes for JSON patterns. */
export function normalizeKiroFrame(message: EventStreamMessage): KiroNormalizedEvent {
	const messageType = message.headers[":message-type"];
	const eventType = message.headers[":event-type"];
	if (messageType !== "event" && messageType !== "exception" && messageType !== "error") {
		return { type: "ignored" };
	}
	if (messageType === "event" && (!eventType || KNOWN_EVENT_TYPES[eventType] !== true)) return { type: "ignored" };
	const payload = decodePayload(message);
	if (messageType === "exception" || messageType === "error") throw kiroEventStreamError(message.headers, payload);

	if (eventType === "initial-response" || eventType === "metadataEvent") {
		// The live runtime reports terminal `stopReason` on `metadataEvent`, not on
		// `assistantResponseEvent`; both spellings are accepted.
		return {
			type: "metadata",
			requestId: typeof payload.requestId === "string" ? payload.requestId : undefined,
			stopReason: typeof payload.stopReason === "string" ? payload.stopReason : undefined,
		};
	}
	if (eventType === "reasoningContentEvent") {
		return {
			type: "reasoning",
			text: typeof payload.text === "string" ? payload.text : undefined,
			signature: typeof payload.signature === "string" ? payload.signature : undefined,
		};
	}
	if (eventType === "assistantResponseEvent") {
		if (typeof payload.content !== "string") {
			throw kiroEventStreamError(message.headers, { code: "MALFORMED_ASSISTANT_EVENT" });
		}
		return {
			type: "content",
			content: payload.content,
			stopReason: typeof payload.stopReason === "string" ? payload.stopReason : undefined,
		};
	}
	if (eventType === "toolUseEvent") {
		if (typeof payload.toolUseId !== "string" || payload.toolUseId.length === 0) {
			throw kiroEventStreamError(message.headers, { code: "MALFORMED_TOOL_EVENT" });
		}
		if (payload.input !== undefined && typeof payload.input !== "string" && !isRecord(payload.input)) {
			throw kiroEventStreamError(message.headers, { code: "MALFORMED_TOOL_INPUT" });
		}
		const input =
			typeof payload.input === "string" ? payload.input : isRecord(payload.input) ? payload.input : undefined;
		return {
			type: "tool",
			toolUseId: payload.toolUseId,
			name: typeof payload.name === "string" ? payload.name : undefined,
			input,
			stop: payload.stop === true,
		};
	}
	if (eventType === "contextUsageEvent") {
		if (
			typeof payload.contextUsagePercentage !== "number" ||
			!Number.isFinite(payload.contextUsagePercentage) ||
			payload.contextUsagePercentage < 0 ||
			payload.contextUsagePercentage > 100
		) {
			throw kiroEventStreamError(message.headers, { code: "MALFORMED_CONTEXT_USAGE_EVENT" });
		}
		return { type: "contextUsage", percentage: payload.contextUsagePercentage };
	}
	const merged: KiroUsageMetrics = {};
	for (const key of ["usage", "metricsEvent", "metrics", "usageEvent"] as const) {
		const usage = normalizeMetrics(payload[key]);
		if (usage) mergeKiroUsage(merged, usage);
	}
	if (eventType && METRIC_EVENT_TYPES[eventType] === true) {
		const usage = normalizeMetrics(payload);
		if (usage) mergeKiroUsage(merged, usage);
	}
	if (Object.keys(merged).length > 0) return { type: "usage", usage: merged };
	return { type: "ignored" };
}

export function mergeKiroUsage(target: KiroUsageMetrics, update: KiroUsageMetrics): void {
	for (const field of Object.keys(METRIC_ALIASES) as Array<keyof KiroUsageMetrics>) {
		if (update[field] !== undefined) target[field] = update[field];
	}
}
