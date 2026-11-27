/**
 * Gemini Interactions API (`google-interactions`): stateless streamed turns on
 * the per-user quota endpoint, which bills the signed-in user's own quota.
 *
 * Every request resends the full ordered step history with `store: false`.
 * Gemini signs its reasoning in `thought` steps; those steps replay verbatim,
 * in the position Gemini produced them, ahead of the call or output they sign.
 */
import { calculateCost } from "@oh-my-pi/pi-catalog/models";
import type { Effort } from "@oh-my-pi/pi-catalog/effort";
import {
	extractRetryHint,
	fetchWithRetry,
	formatDuration,
	parseStreamingJson,
	readSseJson,
	USER_AGENT,
} from "@oh-my-pi/pi-utils";
import type { SseEventObserver } from "@oh-my-pi/pi-utils";
import * as AIError from "../error";
import type {
	AssistantMessage,
	Context,
	ImageContent,
	Model,
	StreamFunction,
	StreamOptions,
	TextContent,
	ThinkingContent,
	ToolCall,
} from "../types";
import { normalizeSystemPrompts, normalizeToolCallId } from "../utils";
import { clearStreamingPartialJson, kStreamingPartialJson } from "../utils/block-symbols";
import { transportExhaustedMessages, withReplaySafeStreamRetry } from "../utils/empty-completion-retry";
import { AssistantMessageEventStream } from "../utils/event-stream";
import type { RawHttpRequestDump } from "../utils/http-inspector";
import { armPreResponseTimeout, getStreamFirstEventTimeoutMs, getStreamIdleTimeoutMs } from "../utils/idle-iterator";
import { notifyProviderResponse } from "../utils/provider-response";
import { appendRetryAfterHint } from "../utils/retry-after";
import { waitForRetry } from "../utils/retry-wait";
import { normalizeSchemaForGoogle, toolWireSchema } from "../utils/schema";
import { parseToolCallArguments } from "../utils/tool-call-arguments";
import {
	type GoogleSharedStreamOptions,
	isValidThoughtSignature,
	mapGoogleUsage,
	nextToolCallId,
	pushBlockEndEvent,
	SKIP_THOUGHT_SIGNATURE,
	startTextOrThinkingBlock,
} from "./google-shared";
import { transformMessages } from "./transform-messages";
import { NON_VISION_IMAGE_PLACEHOLDER } from "./vision-guard";

/** Default base URL; the model row's `baseUrl` (which includes the API version) wins. */
export const GOOGLE_INTERACTIONS_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
/**
 * The per-user quota method. The standard `/interactions` method rejects
 * per-user quota tokens (403 ACCESS_TOKEN_SCOPE_INSUFFICIENT).
 */
export const GOOGLE_INTERACTIONS_PATH = "/interactions:createPerUserQuota";

export interface GoogleInteractionsOptions extends StreamOptions {
	/** Wire `generation_config.thinking_level`; omitted when undefined. */
	thinkingLevel?: Effort;
	/** Ask Gemini for no thought summaries (thinking still runs and stays signed). */
	hideThinkingSummary?: boolean;
	toolChoice?: GoogleSharedStreamOptions["toolChoice"];
}

// ---------------------------------------------------------------------------
// Wire shapes
// ---------------------------------------------------------------------------

type InteractionText = { type: "text"; text: string };
type InteractionImage = { type: "image"; mime_type: string; data: string };
type InteractionContent = InteractionText | InteractionImage;

export type InteractionStep =
	| { type: "user_input"; content: InteractionContent[] }
	| { type: "thought"; signature: string; summary?: InteractionText[] }
	| { type: "function_call"; id: string; name: string; arguments: Record<string, unknown>; signature?: string }
	| {
			type: "function_result";
			call_id: string;
			name: string;
			result: string | InteractionContent[];
			is_error: boolean;
	  }
	| { type: "model_output"; content: InteractionText[] };

type InteractionToolChoice = "auto" | "any" | "none" | { allowed_tools: { mode: "any"; tools: string[] } };

export interface InteractionsRequest {
	model: string;
	store: false;
	stream: true;
	system_instruction?: string;
	tools?: { type: "function"; name: string; description: string; parameters: unknown }[];
	generation_config: {
		thinking_level?: string;
		thinking_summaries?: "auto";
		max_output_tokens?: number;
		stop_sequences?: string[];
		tool_choice?: InteractionToolChoice;
	};
	input: InteractionStep[];
}

interface StreamedStep {
	type?: string;
	id?: string;
	name?: string;
	arguments?: unknown;
	signature?: string;
	summary?: { text?: string }[];
	content?: { text?: string }[];
}

interface StreamedDelta {
	type?: string;
	text?: string;
	content?: { text?: string };
	signature?: string;
	arguments?: string;
}

interface InteractionUsage {
	total_tokens?: number;
	total_input_tokens?: number;
	total_cached_tokens?: number;
	total_output_tokens?: number;
	total_thought_tokens?: number;
}

interface InteractionError {
	message?: string;
	code?: string | number;
	/** `google.rpc.ErrorInfo.reason` from a gateway error's `details` (e.g. `SERVICE_DISABLED`). */
	reason?: string;
}

interface InteractionEvent {
	event_type?: string;
	index?: number;
	step?: StreamedStep;
	delta?: StreamedDelta;
	interaction?: { status?: string; usage?: InteractionUsage };
	error?: InteractionError;
}

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------

function userContent(
	content: string | readonly (TextContent | ImageContent)[],
	supportsImages: boolean,
): InteractionContent[] {
	if (typeof content === "string") {
		const text = content.toWellFormed();
		return text.trim() ? [{ type: "text", text }] : [];
	}
	const parts: InteractionContent[] = [];
	let omittedImages = false;
	for (const item of content) {
		if (item.type === "text") {
			const text = item.text.toWellFormed();
			if (text.trim()) parts.push({ type: "text", text });
		} else if (supportsImages) {
			parts.push({ type: "image", mime_type: item.mimeType, data: item.data });
		} else {
			omittedImages = true;
		}
	}
	if (omittedImages) parts.push({ type: "text", text: NON_VISION_IMAGE_PLACEHOLDER });
	return parts;
}

function toolResultValue(
	content: readonly (TextContent | ImageContent)[],
	supportsImages: boolean,
): string | InteractionContent[] {
	const text = content
		.filter((item): item is TextContent => item.type === "text")
		.map(item => item.text)
		.join("\n")
		.toWellFormed();
	const images = content.filter((item): item is ImageContent => item.type === "image");
	if (images.length === 0) return text;
	if (!supportsImages) return text ? `${text}\n${NON_VISION_IMAGE_PLACEHOLDER}` : NON_VISION_IMAGE_PLACEHOLDER;
	const parts: InteractionContent[] = text ? [{ type: "text", text }] : [];
	for (const image of images) parts.push({ type: "image", mime_type: image.mimeType, data: image.data });
	return parts;
}

/**
 * The full ordered step history for one turn.
 *
 * `transformMessages` has already demoted other models' thinking to text and
 * dropped their signatures, so a signature that survives belongs to this
 * model. A function call with no signed thought ahead of it in its turn (a
 * foreign call, or one whose thought was lost) carries the validator-skip
 * sentinel: Gemini rejects an unsigned call outright.
 */
export function convertInteractionSteps(model: Model<"google-interactions">, context: Context): InteractionStep[] {
	const supportsImages = model.input.includes("image");
	const steps: InteractionStep[] = [];
	for (const msg of transformMessages(context.messages, model, id => normalizeToolCallId(id))) {
		if (msg.role === "user" || msg.role === "developer") {
			const content = userContent(msg.content, supportsImages);
			if (content.length > 0) steps.push({ type: "user_input", content });
			continue;
		}
		if (msg.role === "toolResult") {
			steps.push({
				type: "function_result",
				call_id: msg.toolCallId,
				name: msg.toolName,
				result: toolResultValue(msg.content, supportsImages),
				is_error: msg.isError,
			});
			continue;
		}
		let signed = false;
		for (const block of msg.content) {
			if (block.type === "thinking") {
				// An unsigned thought cannot replay: Gemini validates the signature, not the summary.
				const signature = block.thinkingSignature;
				if (!signature || !isValidThoughtSignature(signature)) continue;
				signed = true;
				const summary = block.thinking.toWellFormed();
				steps.push(
					summary.trim()
						? { type: "thought", signature, summary: [{ type: "text", text: summary }] }
						: { type: "thought", signature },
				);
			} else if (block.type === "text") {
				const text = block.text.toWellFormed();
				if (text.trim()) steps.push({ type: "model_output", content: [{ type: "text", text }] });
			} else if (block.type === "toolCall") {
				const own =
					block.thoughtSignature && isValidThoughtSignature(block.thoughtSignature)
						? block.thoughtSignature
						: undefined;
				const signature = own ?? (signed ? undefined : SKIP_THOUGHT_SIGNATURE);
				steps.push({
					type: "function_call",
					id: block.id,
					name: block.name,
					arguments: block.arguments ?? {},
					...(signature ? { signature } : {}),
				});
			}
		}
	}
	return steps;
}

function mapToolChoice(choice: GoogleInteractionsOptions["toolChoice"]): InteractionToolChoice | undefined {
	if (!choice || choice === "auto") return undefined;
	if (choice === "any" || choice === "none") return choice;
	return { allowed_tools: { mode: "any", tools: [...choice.allowedFunctionNames] } };
}

export function buildInteractionsRequest(
	model: Model<"google-interactions">,
	context: Context,
	options: GoogleInteractionsOptions = {},
): InteractionsRequest {
	const systemPrompts = normalizeSystemPrompts(context.systemPrompt);
	const tools = context.tools?.length
		? context.tools.map(tool => ({
				type: "function" as const,
				name: tool.name,
				description: tool.description || "",
				parameters: normalizeSchemaForGoogle(toolWireSchema(tool)),
			}))
		: undefined;
	const toolChoice = tools ? mapToolChoice(options.toolChoice) : undefined;
	return {
		model: model.id,
		store: false,
		stream: true,
		...(systemPrompts.length > 0 ? { system_instruction: systemPrompts.join("\n\n") } : {}),
		...(tools ? { tools } : {}),
		generation_config: {
			...(options.thinkingLevel ? { thinking_level: options.thinkingLevel } : {}),
			...(options.thinkingLevel && !options.hideThinkingSummary ? { thinking_summaries: "auto" as const } : {}),
			...(options.maxTokens !== undefined ? { max_output_tokens: options.maxTokens } : {}),
			...(options.stopSequences?.length ? { stop_sequences: [...options.stopSequences] } : {}),
			...(toolChoice ? { tool_choice: toolChoice } : {}),
		},
		input: convertInteractionSteps(model, context),
	};
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Google provisions an account's project on first use; for about a minute the
 * endpoint alternates successes with this 403. It clears by itself, so the
 * request is retried here instead of rotating away from a healthy account.
 */
const PERMISSION_PROPAGATION_PATTERN = /\bpropagation of the new permission may take a few minutes\b/i;
const PERMISSION_PROPAGATION_RETRY_DELAYS_MS = [2_000, 4_000, 8_000, 15_000, 30_000];
/** Transient statuses retried in the transport: 503/504 back off 2 s then 4 s. */
const TRANSIENT_RETRY_DELAYS_MS = [2_000, 4_000];
const TRANSIENT_MAX_ATTEMPTS = 3;
/** A daily-capped 429 that names a zero allowance, or offers only a tier upgrade, will never reset. */
const ZERO_DAILY_ALLOWANCE_PATTERN = /\blimit: 0 (?:tokens|requests) per day\b/i;
const UPGRADE_TIER_PATTERN = /\bupgrade your tier\b/i;
const RETRY_IN_PATTERN = /\bretry in\b/i;
const UNSUPPORTED_LOCATION_PATTERN = /\blocation is not supported\b|\bnot available in your current location\b/i;
/** The way past a daily cap or a missing allowance: the `google` provider's API key. */
const GEMINI_API_KEY_HINT = "use a Gemini API key (GEMINI_API_KEY)";
/** A token whose grant lacks a scope the endpoint needs: only signing in again heals it. */
const INSUFFICIENT_SCOPES_PATTERN = /\binsufficient authentication scopes\b/i;
/** Google switched off the OAuth client or the API for it: no account action helps. */
const CLIENT_NOT_AUTHORIZED_PATTERN = /\bOAuth client is not authorized\b/i;

function isScopeInsufficient(status: number, error: InteractionError | undefined, detail: string): boolean {
	return (
		status === 403 &&
		(error?.reason === "ACCESS_TOKEN_SCOPE_INSUFFICIENT" || INSUFFICIENT_SCOPES_PATTERN.test(detail))
	);
}

/** `{"error":{message,code}}` from a JSON body or from the SSE `event: error` frame Google sends on a rejected stream. */
export function parseInteractionsErrorBody(bodyText: string): InteractionError | undefined {
	const candidates = [bodyText];
	for (const line of bodyText.split(/\r?\n/)) {
		if (line.startsWith("data:")) candidates.push(line.slice(5).trim());
	}
	for (const candidate of candidates) {
		const trimmed = candidate.trim();
		if (!trimmed.startsWith("{")) continue;
		try {
			const parsed: unknown = JSON.parse(trimmed);
			if (parsed && typeof parsed === "object" && "error" in parsed) {
				const error = parsed.error;
				if (error && typeof error === "object") {
					const message = "message" in error && typeof error.message === "string" ? error.message : undefined;
					const code =
						"code" in error && (typeof error.code === "string" || typeof error.code === "number")
							? error.code
							: undefined;
					// Pre-handler gateway errors are google.rpc.Status: ErrorInfo sits in `details`.
					let reason: string | undefined;
					if ("details" in error && Array.isArray(error.details)) {
						for (const item of error.details) {
							if (item && typeof item === "object" && "reason" in item && typeof item.reason === "string") {
								reason = item.reason;
								break;
							}
						}
					}
					return { message, code, reason };
				}
			}
		} catch {}
	}
	return undefined;
}

/**
 * User-facing message for a rejected request. Daily caps, missing allowances
 * and unsupported regions get omp's own copy: Google's text links a Gemini API
 * key tier upgrade, which does not apply to per-user quota. The text stays
 * classifiable: a daily cap reads as "reached today's … limit", a model without
 * an allowance as a per-user quota model refusal.
 */
function describeHttpError(
	status: number,
	error: InteractionError | undefined,
	bodyText: string,
	headers: Headers,
	modelId: string,
): string {
	const detail = error?.message?.trim() || bodyText.trim() || "Unknown error";
	const code = error?.code !== undefined && error.code !== status ? ` ${error.code}` : "";
	if (status === 429 && AIError.isDailyQuotaCapText(detail)) {
		if (
			ZERO_DAILY_ALLOWANCE_PATTERN.test(detail) ||
			(UPGRADE_TIER_PATTERN.test(detail) && !RETRY_IN_PATTERN.test(detail) && !headers.has("retry-after"))
		) {
			return `Model ${modelId} is not supported for per-user quota requests: your account has no daily allowance for it. Switch to another Gemini model or ${GEMINI_API_KEY_HINT}.`;
		}
		const resetMs = extractRetryHint(headers, detail);
		const reset = resetMs !== undefined && resetMs > 0 ? `; it resets in ${formatDuration(resetMs)}` : "";
		return appendRetryAfterHint(
			`You've reached today's per-user quota limit for ${modelId}${reset}. Switch to another Gemini model, ${GEMINI_API_KEY_HINT}, or wait for the daily reset.`,
			headers,
		);
	}
	// Copy stays classifiable: AIError.isClientAccessDisabledMessage keeps it out of refresh and rotation.
	if (status === 403 && (error?.reason === "SERVICE_DISABLED" || CLIENT_NOT_AUTHORIZED_PATTERN.test(detail))) {
		return `Google has turned off Gemini access for this sign-in right now; signing in again will not help. Try again later or ${GEMINI_API_KEY_HINT}.`;
	}
	// Copy stays classifiable: AIError.isInvalidatedOAuthTokenError disables the credential like a dead grant.
	if (isScopeInsufficient(status, error, detail)) {
		return "Your Google sign-in is missing a permission omp needs; sign in again.";
	}
	if (status === 400 && UNSUPPORTED_LOCATION_PATTERN.test(detail)) {
		return `Gemini API access is not available in your region (${detail})`;
	}
	return appendRetryAfterHint(`Gemini API error (${status}${code}): ${detail}`, headers);
}

function streamError(error: InteractionError | undefined, provider: string): Error {
	const message = error?.message?.trim() || "unknown error";
	const code = error?.code !== undefined ? ` (${error.code})` : "";
	const status = typeof error?.code === "number" && error.code >= 400 ? error.code : undefined;
	const text = `Gemini stream error${code}: ${message}`;
	return status !== undefined
		? new AIError.GoogleApiError(text, status)
		: new AIError.ProviderResponseError(text, { provider, kind: "output" });
}

// ---------------------------------------------------------------------------
// Streaming
// ---------------------------------------------------------------------------

type ToolCallBlock = ToolCall & { [kStreamingPartialJson]?: string };

type OpenStep =
	| { kind: "thought"; contentIndex: number; block: ThinkingContent }
	| { kind: "text"; contentIndex: number; block: TextContent }
	| { kind: "call"; contentIndex: number; block: ToolCallBlock };

function createOutput(model: Model<"google-interactions">): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function mapStatus(status: string | undefined, output: AssistantMessage): AssistantMessage["stopReason"] {
	switch (status) {
		case "requires_action":
			return "toolUse";
		case "incomplete":
			return "length";
		case "completed":
			return output.content.some(block => block.type === "toolCall") ? "toolUse" : "stop";
		default:
			return "error";
	}
}

/** Folds Interactions stream events into the assistant message, step by step. */
class InteractionStepFolder {
	readonly #output: AssistantMessage;
	readonly #stream: AssistantMessageEventStream;
	readonly #onProgress: () => void;
	readonly #open = new Map<number, OpenStep>();
	#completedStatus: string | undefined;

	constructor(output: AssistantMessage, stream: AssistantMessageEventStream, onProgress: () => void) {
		this.#output = output;
		this.#stream = stream;
		this.#onProgress = onProgress;
	}

	/** The final `interaction.status`, once `interaction.completed` arrived. */
	get completedStatus(): string | undefined {
		return this.#completedStatus;
	}

	handle(event: InteractionEvent, model: Model<"google-interactions">): void {
		switch (event.event_type) {
			case "step.start":
				if (event.index !== undefined && event.step) this.#start(event.index, event.step);
				return;
			case "step.delta":
				if (event.index !== undefined && event.delta) this.#delta(event.index, event.delta);
				return;
			case "step.stop":
				if (event.index !== undefined) this.#stop(event.index);
				return;
			case "interaction.completed": {
				this.closeAll();
				const interaction = event.interaction;
				this.#completedStatus = interaction?.status ?? "unknown";
				const usage = interaction?.usage;
				if (usage) {
					this.#output.usage = mapGoogleUsage({
						promptTokenCount: usage.total_input_tokens,
						cachedContentTokenCount: usage.total_cached_tokens,
						candidatesTokenCount: usage.total_output_tokens,
						thoughtsTokenCount: usage.total_thought_tokens,
						totalTokenCount: usage.total_tokens,
					});
					calculateCost(model, this.#output.usage, this.#output.timestamp);
				}
				return;
			}
			case "error":
				throw streamError(event.error, model.provider);
			default:
				// interaction.created / interaction.status_update carry nothing to render.
				return;
		}
	}

	/** Ends every step still open (a stream may end steps only implicitly). */
	closeAll(): void {
		for (const index of [...this.#open.keys()].sort((a, b) => a - b)) this.#stop(index);
	}

	#start(index: number, step: StreamedStep): void {
		if (this.#open.has(index)) return;
		const open = this.#openStep(index, step.type, step);
		if (!open) return;
		if (open.kind === "thought") {
			if (step.signature) open.block.thinkingSignature = step.signature;
			for (const part of step.summary ?? []) if (part.text) this.#appendThinking(open, part.text);
		} else if (open.kind === "text") {
			for (const part of step.content ?? []) if (part.text) this.#appendText(open, part.text);
		} else if (step.signature) {
			open.block.thoughtSignature = step.signature;
		}
	}

	#openStep(index: number, type: string | undefined, step?: StreamedStep): OpenStep | undefined {
		if (type === "thought") {
			const block = startTextOrThinkingBlock(true, this.#output, this.#stream);
			const open: OpenStep = { kind: "thought", contentIndex: this.#output.content.length - 1, block };
			this.#open.set(index, open);
			return open;
		}
		if (type === "model_output") {
			const block = startTextOrThinkingBlock(false, this.#output, this.#stream);
			const open: OpenStep = { kind: "text", contentIndex: this.#output.content.length - 1, block };
			this.#open.set(index, open);
			return open;
		}
		if (type === "function_call") {
			const name = step?.name ?? "";
			const providedId = step?.id;
			const duplicate =
				!providedId || this.#output.content.some(block => block.type === "toolCall" && block.id === providedId);
			const initialArguments =
				step?.arguments && typeof step.arguments === "object" && Object.keys(step.arguments).length > 0
					? JSON.stringify(step.arguments)
					: "";
			const block: ToolCallBlock = {
				type: "toolCall",
				id: duplicate || !providedId ? nextToolCallId(name || "tool") : providedId,
				name,
				arguments: parseStreamingJson<Record<string, unknown>>(initialArguments),
				[kStreamingPartialJson]: initialArguments,
			};
			this.#output.content.push(block);
			const contentIndex = this.#output.content.length - 1;
			this.#stream.push({ type: "toolcall_start", contentIndex, partial: this.#output });
			const open: OpenStep = { kind: "call", contentIndex, block };
			this.#open.set(index, open);
			if (initialArguments) {
				this.#onProgress();
				this.#stream.push({ type: "toolcall_delta", contentIndex, delta: initialArguments, partial: this.#output });
			}
			return open;
		}
		// Server-side tool steps are never requested; nothing to render.
		return undefined;
	}

	#delta(index: number, delta: StreamedDelta): void {
		let open = this.#open.get(index);
		if (!open) {
			// A delta before its `step.start`: infer the step from the delta kind.
			const type =
				delta.type === "text"
					? "model_output"
					: delta.type === "arguments_delta"
						? "function_call"
						: delta.type === "thought_summary" || delta.type === "thought_signature"
							? "thought"
							: undefined;
			open = this.#openStep(index, type);
			if (!open) return;
		}
		switch (delta.type) {
			case "thought_summary":
				if (open.kind === "thought" && delta.content?.text) this.#appendThinking(open, delta.content.text);
				return;
			case "thought_signature":
				if (!delta.signature) return;
				if (open.kind === "thought") open.block.thinkingSignature = delta.signature;
				else if (open.kind === "call") open.block.thoughtSignature = delta.signature;
				return;
			case "text":
				if (open.kind === "text" && delta.text) this.#appendText(open, delta.text);
				return;
			case "arguments_delta":
				if (open.kind === "call" && delta.arguments) {
					const partial = (open.block[kStreamingPartialJson] ?? "") + delta.arguments;
					open.block[kStreamingPartialJson] = partial;
					open.block.arguments = parseStreamingJson<Record<string, unknown>>(partial);
					this.#onProgress();
					this.#stream.push({
						type: "toolcall_delta",
						contentIndex: open.contentIndex,
						delta: delta.arguments,
						partial: this.#output,
					});
				}
				return;
			default:
				return;
		}
	}

	#appendThinking(open: Extract<OpenStep, { kind: "thought" }>, text: string): void {
		this.#onProgress();
		open.block.thinking += text;
		this.#stream.push({
			type: "thinking_delta",
			contentIndex: open.contentIndex,
			delta: text,
			partial: this.#output,
		});
	}

	#appendText(open: Extract<OpenStep, { kind: "text" }>, text: string): void {
		this.#onProgress();
		open.block.text += text;
		this.#stream.push({ type: "text_delta", contentIndex: open.contentIndex, delta: text, partial: this.#output });
	}

	#stop(index: number): void {
		const open = this.#open.get(index);
		if (!open) return;
		this.#open.delete(index);
		if (open.kind === "call") {
			const toolCall = open.block;
			toolCall.arguments = parseToolCallArguments(toolCall[kStreamingPartialJson]);
			clearStreamingPartialJson(toolCall);
			this.#stream.push({ type: "toolcall_end", contentIndex: open.contentIndex, toolCall, partial: this.#output });
			return;
		}
		pushBlockEndEvent(open.block, open.contentIndex, this.#output, this.#stream);
	}
}

const streamGoogleInteractionsOnce = (
	model: Model<"google-interactions">,
	context: Context,
	options: GoogleInteractionsOptions = {},
): AssistantMessageEventStream => {
	const stream = new AssistantMessageEventStream();
	void (async () => {
		const startTime = performance.now();
		let firstTokenTime: number | undefined;
		const output = createOutput(model);
		let rawRequestDump: RawHttpRequestDump | undefined;
		let transportOwnedStatus = false;
		let transportRetriedStatus = false;
		try {
			const apiKey = options.apiKey;
			if (!apiKey) throw new AIError.MissingApiKeyError(model.provider);
			const base = (model.baseUrl?.trim() || GOOGLE_INTERACTIONS_BASE_URL).replace(/\/+$/, "");
			const url = `${base}${GOOGLE_INTERACTIONS_PATH}`;
			const request = buildInteractionsRequest(model, context, options);
			const body: unknown = (await options.onPayload?.(request, model)) ?? request;
			rawRequestDump = { provider: model.provider, api: model.api, model: model.id, method: "POST", url, body };
			const bodyJson = JSON.stringify(body);
			const headers: Record<string, string> = {
				...model.headers,
				...options.headers,
				// The User-Agent stays this exact `omp/<semver>`; no header override may replace it.
				"User-Agent": USER_AGENT,
				Authorization: `Bearer ${apiKey}`,
				"Content-Type": "application/json",
				Accept: "text/event-stream",
			};
			// Bun's native fetch ceiling is off (`timeout: false`); this pre-response
			// timer covers direct callers that bypass the shared stream watchdog.
			const firstEventTimeoutMs =
				options.streamFirstEventTimeoutMs ??
				getStreamFirstEventTimeoutMs(options.streamIdleTimeoutMs ?? getStreamIdleTimeoutMs());

			let response: Response;
			for (let propagationRetry = 0; ; propagationRetry++) {
				let clearWatchdog: (() => void) | undefined;
				try {
					response = await fetchWithRetry(url, {
						method: "POST",
						headers,
						body: bodyJson,
						signal: options.signal,
						prepareInit: () => {
							clearWatchdog?.();
							const watchdog = armPreResponseTimeout(options.signal, firstEventTimeoutMs);
							clearWatchdog = watchdog.clear;
							return { signal: watchdog.signal };
						},
						maxAttempts: TRANSIENT_MAX_ATTEMPTS,
						defaultDelayMs: TRANSIENT_RETRY_DELAYS_MS,
						maxDelayMs: options.maxRetryDelayMs,
						// A daily cap or zero allowance is final until the reset: never replay it.
						shouldRetryResponse: (_response, bodyText) => !AIError.isUsageLimit(bodyText),
						fetch: options.fetch,
						timeout: false,
					});
				} finally {
					clearWatchdog?.();
				}
				if (response.ok) break;
				const bodyText = await response.text().catch(() => "");
				const error = parseInteractionsErrorBody(bodyText);
				const delayMs = PERMISSION_PROPAGATION_RETRY_DELAYS_MS[propagationRetry];
				if (
					response.status === 403 &&
					delayMs !== undefined &&
					PERMISSION_PROPAGATION_PATTERN.test(error?.message ?? bodyText)
				) {
					await waitForRetry(options.providerRetryWait, delayMs, options.signal);
					continue;
				}
				transportOwnedStatus = AIError.isTransientStatus(response.status);
				transportRetriedStatus = response.status === 503 || response.status === 504;
				throw new AIError.GoogleApiError(
					describeHttpError(response.status, error, bodyText, response.headers, model.id),
					response.status,
					{ headers: response.headers, code: typeof error?.code === "string" ? error.code : undefined },
				);
			}
			await notifyProviderResponse(options, response, model, response.headers.get("x-goog-request-id"));
			if (!response.body) {
				throw new AIError.ProviderResponseError("Gemini API returned an empty response body", {
					provider: model.provider,
					kind: "empty-body",
				});
			}
			stream.push({ type: "start", partial: output });

			const onSseEvent = options.onSseEvent;
			const sseObserver: SseEventObserver | undefined = onSseEvent
				? event => onSseEvent({ event: event.event, data: event.data, raw: [...event.raw] }, model)
				: undefined;
			const folder = new InteractionStepFolder(output, stream, () => {
				firstTokenTime ??= performance.now();
			});
			for await (const event of readSseJson<InteractionEvent>(response.body, options.signal, sseObserver)) {
				folder.handle(event, model);
			}
			folder.closeAll();
			if (options.signal?.aborted) throw new AIError.AbortError();
			const status = folder.completedStatus;
			if (status === undefined) {
				throw new AIError.ProviderResponseError(
					"Gemini stream ended before terminal completion event (interaction.completed)",
					{ provider: model.provider, kind: "incomplete-stream" },
				);
			}
			output.stopReason = mapStatus(status, output);
			if (output.stopReason === "error") {
				throw new AIError.ProviderResponseError(`Gemini interaction ended with status ${status}`, {
					provider: model.provider,
					kind: "output",
				});
			}
			output.duration = performance.now() - startTime;
			if (firstTokenTime) output.ttft = firstTokenTime - startTime;
			const reason =
				output.stopReason === "length" ? "length" : output.stopReason === "toolUse" ? "toolUse" : "stop";
			stream.push({ type: "done", reason, message: output });
			stream.end();
		} catch (error) {
			for (const block of output.content) {
				if (block.type === "toolCall") clearStreamingPartialJson(block);
			}
			const result = await AIError.finalize(error, {
				api: model.api,
				provider: model.provider,
				model: model.id,
				signal: options.signal,
				rawRequestDump,
			});
			output.stopReason = result.stopReason;
			output.errorStatus = result.status;
			output.errorId = result.id;
			output.errorMessage = result.message;
			output.duration = performance.now() - startTime;
			if (firstTokenTime) output.ttft = firstTokenTime - startTime;
			// The transport already spent its retries on this status; a replay would multiply them.
			if (transportOwnedStatus) transportExhaustedMessages.add(output);
			// A 503/504 already cost TRANSIENT_MAX_ATTEMPTS charged requests: no layer above may replay the turn.
			if (transportRetriedStatus) output.errorId = AIError.addFlag(output.errorId, AIError.Flag.RetriesExhausted);
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();
	return stream;
};

/**
 * Stream one Gemini Interactions turn. Empty completions and transient
 * failures before any output are replayed once more; nothing that already
 * streamed is ever duplicated.
 */
export const streamGoogleInteractions: StreamFunction<"google-interactions"> = (model, context, options) =>
	withReplaySafeStreamRetry(model, context, options, streamGoogleInteractionsOnce, {
		retryEmptyCompletion: true,
		retryProviderErrors: true,
		maxProviderErrorRetries: 1,
	});
