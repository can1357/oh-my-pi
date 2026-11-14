import { isRecord } from "@oh-my-pi/pi-utils";
import type { EventStreamMessage } from "../aws-eventstream";
import { kiroEventStreamError } from "./errors";
import type { KiroNormalizedEvent, KiroRefusalDetails, KiroUsageMetrics } from "./types";

// `metadataEvent.tokenUsage` is the runtime's `TokenUsage` shape
// (`uncachedInputTokens`, `outputTokens`, `totalTokens`, `cacheReadInputTokens`,
// `cacheWriteInputTokens`; Smithy model in aws/amazon-q-developer-cli).
// `uncachedInputTokens` excludes cache reads and writes, matching `input`.
const METRIC_ALIASES: Readonly<Record<keyof KiroUsageMetrics, readonly string[]>> = {
	inputTokens: ["inputTokens", "input_tokens", "promptTokens", "prompt_tokens", "uncachedInputTokens"],
	outputTokens: ["outputTokens", "output_tokens", "completionTokens", "completion_tokens"],
	cacheReadTokens: ["cacheReadTokens", "cache_read_tokens", "cacheReadInputTokens", "cachedTokens"],
	cacheWriteTokens: [
		"cacheCreationTokens",
		"cache_creation_tokens",
		"cacheWriteTokens",
		"cache_write_tokens",
		"cacheCreationInputTokens",
		"cacheWriteInputTokens",
	],
	reasoningTokens: ["reasoningTokens", "reasoning_tokens", "reasoningOutputTokens"],
};

// `meteringEvent` is the live billing frame (`{ unit, unitPlural, usage }`, where
// `usage` is fractional credits, not tokens). It carries no token counts; it is
// surfaced as `metering` so the stream knows the request was billed and never
// replays it. Token metrics come from `metadataEvent.tokenUsage` and the
// `metricsEvent`/`usage` envelopes below.
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

/** Shared across frames: every payload decode is a complete, non-streaming call. */
const PAYLOAD_DECODER = new TextDecoder("utf-8", { fatal: true });

function parsePayload(message: EventStreamMessage): Record<string, unknown> {
	const value: unknown = JSON.parse(PAYLOAD_DECODER.decode(message.payload));
	if (!isRecord(value)) throw new Error("payload is not an object");
	return value;
}

function decodePayload(message: EventStreamMessage): Record<string, unknown> {
	try {
		return parsePayload(message);
	} catch (error) {
		throw kiroEventStreamError(message.headers, {
			code: "MALFORMED_EVENT_PAYLOAD",
			message: error instanceof Error ? error.message : "invalid JSON",
		});
	}
}

/**
 * An `error` frame usually has an empty payload, with the failure in its
 * `:error-code` / `:error-message` headers. An empty or unparseable payload
 * therefore contributes nothing, and the headers alone decide the error.
 */
function failureFrameError(message: EventStreamMessage): Error {
	let payload: Record<string, unknown> | undefined;
	if (message.payload.length > 0) {
		try {
			payload = parsePayload(message);
		} catch {}
	}
	return kiroEventStreamError(message.headers, payload);
}

function normalizeRefusal(stopDetails: unknown): KiroRefusalDetails | undefined {
	if (!isRecord(stopDetails) || !isRecord(stopDetails.refusal)) return undefined;
	const { category, explanation } = stopDetails.refusal;
	return {
		...(typeof category === "string" ? { category } : {}),
		...(typeof explanation === "string" ? { explanation } : {}),
	};
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
	if (messageType === "exception" || messageType === "error") throw failureFrameError(message);
	if (!eventType || KNOWN_EVENT_TYPES[eventType] !== true) return { type: "ignored" };
	const payload = decodePayload(message);

	if (eventType === "initial-response" || eventType === "metadataEvent") {
		// The live runtime reports terminal `stopReason`, classifier details, and
		// token usage on `metadataEvent`, not on `assistantResponseEvent`.
		const refusal = normalizeRefusal(payload.stopDetails);
		const usage = normalizeMetrics(payload.tokenUsage);
		return {
			type: "metadata",
			requestId: typeof payload.requestId === "string" ? payload.requestId : undefined,
			stopReason: typeof payload.stopReason === "string" ? payload.stopReason : undefined,
			...(refusal ? { refusal } : {}),
			...(usage ? { usage } : {}),
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
	if (eventType === "meteringEvent") return { type: "metering" };
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
