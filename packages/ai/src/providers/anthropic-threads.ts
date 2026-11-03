/**
 * Anthropic message threads (`message-threads-2026-08-12`).
 *
 * A thread keeps the conversation server-side for 5 minutes after its last
 * request. The first request sends the full conversation with
 * `thread: {type: "create"}`; each later request sends only the messages after
 * the previous response plus `thread: {type: "continue", previous_message_id}`,
 * and leaves `system` and `tools` to the thread. The client stays the source of
 * truth: every turn is still built in full, and the delta is cut from it only
 * when the stored turn is a strict prefix of the new request. Anything else —
 * edited history, changed fixed fields, an expired or unknown thread — falls
 * back to a full create request.
 *
 * https://platform.claude.com/docs/en/build-with-claude/message-threads
 */
import { $flag } from "@oh-my-pi/pi-utils";
import * as AIError from "../error";
import type { AssistantMessage, Model, StreamOptions } from "../types";
import { isAnthropicOperatedUrl } from "./anthropic-state";
import type { ContentBlockParam, MessageCreateParamsStreaming, MessageParam } from "./anthropic-wire";

/** A thread expires this long after its last request. */
const THREAD_TTL_MS = 5 * 60 * 1000;

/**
 * `thread_not_found` on a continue that names a live thread means the API
 * cannot store this conversation. After this many in a row the session stops
 * threading and sends full requests without `thread`.
 */
const UNEXPLAINED_NOT_FOUND_LIMIT = 2;

/** Fields a continue request may change; every other field must equal the create request's. */
const FREE_FIELDS: Record<string, true> = {
	messages: true,
	max_tokens: true,
	stop_sequences: true,
	stream: true,
	metadata: true,
	service_tier: true,
};

/** Raw stop reasons whose response the API stores and a continue request may follow. */
const CONTINUABLE_STOP_REASONS: Record<string, true> = {
	end_turn: true,
	tool_use: true,
	stop_sequence: true,
};

/** The last stored turn of a thread. */
interface AnthropicThreadBaseline {
	responseId: string;
	storedAt: number;
	/** Wire messages of the request that produced `responseId`, `cache_control` stripped, content as blocks. */
	messages: MessageParam[];
	/** Every request field outside {@link FREE_FIELDS}: `system`, `tools` and the fixed fields. */
	fields: Record<string, unknown>;
	/** Sorted `anthropic-beta` values the request advertised; the set is a fixed field. */
	betas: string;
	/** `tool_use` ids of the stored response, in order. */
	toolUseIds: string[];
}

/** One routing session's thread on one endpoint and model. */
export interface AnthropicMessageThread {
	baseline?: AnthropicThreadBaseline;
	unexplainedNotFound: number;
	/** Set once the API cannot thread this session; later turns send full requests without `thread`. */
	disabled: boolean;
}

export function createAnthropicMessageThread(): AnthropicMessageThread {
	return { unexplainedNotFound: 0, disabled: false };
}

/**
 * Whether turns to `model` at `baseUrl` use message threads. Precedence: the
 * call's `statefulResponses`, then `PI_ANTHROPIC_MESSAGE_THREADS`, then on for
 * the first-party provider on a deployment Anthropic serves.
 */
export function anthropicMessageThreadsEnabled(
	model: Model<"anthropic-messages">,
	baseUrl: string,
	options: StreamOptions | undefined,
): boolean {
	if (options?.statefulResponses === false) return false;
	if (options?.statefulResponses === true) return true;
	return $flag(
		"PI_ANTHROPIC_MESSAGE_THREADS",
		model.compat.firstPartyProvider === true && isAnthropicOperatedUrl(baseUrl),
	);
}

/**
 * Whether a finished request can ride a thread. Threads reject on-demand
 * compaction (a `compaction` field or a replayed compaction block) and every
 * context edit except `clear_thinking` with `keep: "all"`; a fallback-credit
 * redemption must resend its refused body unchanged.
 */
export function isThreadableAnthropicRequest(params: MessageCreateParamsStreaming): boolean {
	if (params.thread !== undefined || params.compaction !== undefined || params.fallback_credit_token !== undefined) {
		return false;
	}
	if (params.context_management?.edits.some(edit => edit.type !== "clear_thinking_20251015")) return false;
	return !params.messages.some(
		message => typeof message.content !== "string" && message.content.some(block => block.type === "compaction"),
	);
}

export interface AnthropicThreadRequest {
	body: MessageCreateParamsStreaming;
	/** The body continues the stored thread rather than creating one. */
	continued: boolean;
}

/**
 * Shape the wire body for a full request `params`: continue the stored thread
 * when its turn is a strict prefix of `params` (same fixed fields and betas,
 * same earlier messages, then the stored response as an assistant turn),
 * otherwise create a new thread from the full conversation.
 */
export function buildAnthropicThreadRequest(
	params: MessageCreateParamsStreaming,
	thread: AnthropicMessageThread,
	betas: readonly string[],
	forceCreate: boolean,
): AnthropicThreadRequest {
	const baseline = thread.baseline;
	const delta = !forceCreate && baseline ? continuationMessages(params, baseline, betaKey(betas)) : undefined;
	if (!baseline || !delta) return { body: { ...params, thread: { type: "create" } }, continued: false };
	const body: MessageCreateParamsStreaming = {
		...params,
		messages: delta,
		thread: { type: "continue", previous_message_id: baseline.responseId },
	};
	delete body.system;
	delete body.tools;
	return { body, continued: true };
}

function continuationMessages(
	params: MessageCreateParamsStreaming,
	baseline: AnthropicThreadBaseline,
	betas: string,
): MessageParam[] | undefined {
	if (baseline.betas !== betas || !Bun.deepEquals(threadFields(params), baseline.fields)) return undefined;
	const stored = baseline.messages;
	const current = params.messages;
	// A continue needs at least one new message after the echoed response.
	if (current.length <= stored.length + 1) return undefined;
	for (let index = 0; index < stored.length; index++) {
		const message = current[index]!;
		if (!equalsIgnoringCacheControl(stored[index], { ...message, content: contentBlocks(message) })) return undefined;
	}
	const echoed = current[stored.length]!;
	if (echoed.role !== "assistant") return undefined;
	const echoedToolUseIds = contentBlocks(echoed).flatMap(block => (block.type === "tool_use" ? [block.id] : []));
	if (!Bun.deepEquals(echoedToolUseIds, baseline.toolUseIds)) return undefined;
	return current.slice(stored.length + 1);
}

/**
 * Remember a finished turn as the thread's next continuation point, or forget
 * the thread when the API did not store a continuable turn: a refusal or
 * pause, a cut-off response, or one a fallback model wrote.
 */
export function recordAnthropicThreadTurn(
	thread: AnthropicMessageThread,
	request: AnthropicThreadRequest,
	params: MessageCreateParamsStreaming,
	betas: readonly string[],
	output: AssistantMessage,
	content: AssistantMessage["content"],
	requestedModelId: string,
	rawStopReason: string | undefined,
): void {
	const responseId = output.responseId;
	if (
		!responseId ||
		rawStopReason === undefined ||
		CONTINUABLE_STOP_REASONS[rawStopReason] !== true ||
		output.model !== requestedModelId ||
		content.some(block => block.type === "fallback")
	) {
		thread.baseline = undefined;
		return;
	}
	if (request.continued) thread.unexplainedNotFound = 0;
	thread.baseline = {
		responseId,
		storedAt: Date.now(),
		messages: params.messages.map(
			message => withoutCacheControl({ ...message, content: contentBlocks(message) }) as MessageParam,
		),
		fields: structuredClone(threadFields(params)),
		betas: betaKey(betas),
		toolUseIds: content.flatMap(block => (block.type === "toolCall" ? [block.id] : [])),
	};
}

/** Forget the stored turn; the next threaded request creates a new thread. */
export function resetAnthropicThread(thread: AnthropicMessageThread): void {
	thread.baseline = undefined;
}

/**
 * Decide how to retry a threaded request the API rejected before the model
 * ran. `replay`: send the full conversation in a new create request (the thread
 * expired, was already continued, or a fixed field changed). `unthreaded`: the
 * API cannot thread this session, so send the full conversation without
 * `thread` from now on. `undefined`: not a thread rejection.
 */
export function rejectAnthropicThreadRequest(
	thread: AnthropicMessageThread,
	request: AnthropicThreadRequest,
	error: unknown,
): "replay" | "unthreaded" | undefined {
	const status = AIError.status(error);
	if (status !== 400 && status !== 404) return undefined;
	const code = error instanceof AIError.ProviderHttpError ? error.code : undefined;
	const storedAt = thread.baseline?.storedAt;
	thread.baseline = undefined;
	if (code === "thread_unsupported_request") {
		thread.disabled = true;
		return "unthreaded";
	}
	if (request.continued) {
		if (code === "thread_not_found" && storedAt !== undefined && Date.now() - storedAt < THREAD_TTL_MS) {
			thread.unexplainedNotFound++;
			if (thread.unexplainedNotFound >= UNEXPLAINED_NOT_FOUND_LIMIT) {
				thread.disabled = true;
				return "unthreaded";
			}
		}
		return "replay";
	}
	// A create rejected over the `thread` field itself: the host has no threads.
	if (code?.startsWith("thread_") || (error instanceof Error && /\bthread\b/i.test(error.message))) {
		thread.disabled = true;
		return "unthreaded";
	}
	return undefined;
}

function betaKey(betas: readonly string[]): string {
	return [...betas].sort().join(",");
}

function threadFields(params: MessageCreateParamsStreaming): Record<string, unknown> {
	const fields: Record<string, unknown> = {};
	for (const key in params) {
		if (FREE_FIELDS[key] === true) continue;
		const value = params[key as keyof MessageCreateParamsStreaming];
		if (value !== undefined) fields[key] = value;
	}
	return fields;
}

/** Content as blocks: prompt caching rewrites a string message into one text block to mark it. */
function contentBlocks(message: MessageParam): ContentBlockParam[] {
	return typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content;
}

/**
 * Deep copy without `cache_control` or `undefined` members. Breakpoints move
 * every turn, and a continue request cannot move one it already sent.
 */
function withoutCacheControl(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(withoutCacheControl);
	if (typeof value !== "object" || value === null) return value;
	const copy: Record<string, unknown> = {};
	for (const key in value) {
		const member = (value as Record<string, unknown>)[key];
		if (key === "cache_control" || member === undefined) continue;
		copy[key] = withoutCacheControl(member);
	}
	return copy;
}

function equalsIgnoringCacheControl(left: unknown, right: unknown): boolean {
	if (left === right) return true;
	if (typeof left !== "object" || typeof right !== "object" || left === null || right === null) return false;
	if (Array.isArray(left) || Array.isArray(right)) {
		if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
		for (let index = 0; index < left.length; index++) {
			if (!equalsIgnoringCacheControl(left[index], right[index])) return false;
		}
		return true;
	}
	const leftRecord = left as Record<string, unknown>;
	const rightRecord = right as Record<string, unknown>;
	let unmatched = 0;
	for (const key in leftRecord) {
		if (key === "cache_control" || leftRecord[key] === undefined) continue;
		if (!equalsIgnoringCacheControl(leftRecord[key], rightRecord[key])) return false;
		unmatched++;
	}
	for (const key in rightRecord) {
		if (key !== "cache_control" && rightRecord[key] !== undefined) unmatched--;
	}
	return unmatched === 0;
}
