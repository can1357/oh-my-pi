/**
 * Amazon Bedrock Converse Stream provider.
 *
 * Talks directly to `bedrock-runtime.{region}.amazonaws.com` over HTTPS with
 * SigV4 signing and decodes the `application/vnd.amazon.eventstream` response.
 * No `@aws-sdk/*`, no `@smithy/*`, no `proxy-agent`. Proxies are honored via
 * Bun's native `HTTPS_PROXY` support.
 */

import type { Effort } from "@oh-my-pi/pi-catalog/effort";
import { mapEffortToAnthropicAdaptiveEffort, requireSupportedEffort } from "@oh-my-pi/pi-catalog/model-thinking";
import { calculateCost } from "@oh-my-pi/pi-catalog/models";
import { $flag, fetchWithRetry, parseStreamingJson, parseStreamingJsonThrottled } from "@oh-my-pi/pi-utils";
import { renderDemotedThinking } from "../dialect/demotion";
import * as AIError from "../error";
import { resolveAwsBearerToken } from "../registry/aws";
import type {
	Api,
	AssistantMessage,
	CacheRetention,
	Context,
	Model,
	StopReason,
	StreamFunction,
	StreamOptions,
	TextContent,
	ThinkingBudgets,
	ThinkingContent,
	Tool,
	ToolCall,
	ToolResultMessage,
} from "../types";
import { normalizeSystemPrompts, normalizeToolCallId, resolveCacheRetention } from "../utils";
import { resolveAwsAmbientRegion } from "../utils/aws-profile";
import {
	clearStreamingPartialJson,
	kStreamingBlockIndex,
	kStreamingLastParseLen,
	kStreamingPartialJson,
} from "../utils/block-symbols";
import { AssistantMessageEventStream } from "../utils/event-stream";
import type { RawHttpRequestDump } from "../utils/http-inspector";
import { armPreResponseTimeout, getStreamFirstEventTimeoutMs } from "../utils/idle-iterator";
import { toolWireSchema } from "../utils/schema/wire";
import { invalidateAwsCredentialCache, resolveAwsCredentials } from "./aws-credentials";
import { decodeEventStream } from "./aws-eventstream";
import { signRequest } from "./aws-sigv4";
import { transformMessages } from "./transform-messages";

/**
 * Headers SigV4 generates for itself. A caller cannot be allowed to supply these:
 * `signRequest` would sign the caller's value but return its own, so the signature
 * would not match what goes on the wire.
 */
const SIGNER_OWNED_HEADERS = new Set(["host", "x-amz-date", "x-amz-content-sha256", "x-amz-security-token"]);

/** Headers the Bedrock request sets itself; a caller copy in any casing duplicates them. */
// `content-length` included: the fetch layer recomputes it from the serialized
// body, so a caller value would be signed but not sent, and AWS rejects the
// mismatch.
const BEDROCK_RESERVED_HEADERS = new Set(["content-type", "accept", "authorization", "content-length"]);

export type BedrockThinkingDisplay = "summarized" | "omitted";

/** Bedrock guardrail trace verbosity, mirrors the Converse `guardrailConfig.trace` values. */
export type BedrockGuardrailTrace = "enabled" | "disabled" | "enabled_full";

export interface BedrockOptions extends StreamOptions {
	region?: string;
	profile?: string;
	/** Amazon Bedrock API key sent as `Authorization: Bearer`, ahead of SigV4 credential resolution. */
	bearerToken?: string;
	/**
	 * Amazon Bedrock Guardrail id or ARN. When set, the Converse request carries a
	 * `guardrailConfig` so accounts that gate `bedrock:InvokeModel*` on the
	 * `bedrock:GuardrailIdentifier` condition key stop returning an explicit deny.
	 */
	guardrailIdentifier?: string;
	/** Guardrail version to apply. Defaults to `"DRAFT"` when a guardrail is set. */
	guardrailVersion?: string;
	/** Guardrail trace verbosity. Left unset (Bedrock default) unless provided. */
	guardrailTrace?: BedrockGuardrailTrace;
	toolChoice?: "auto" | "any" | "none" | { type: "tool"; name: string };
	/* See https://docs.aws.amazon.com/bedrock/latest/userguide/inference-reasoning.html for supported models. */
	reasoning?: Effort;
	/* Custom token budgets per thinking level. Overrides default budgets. */
	thinkingBudgets?: ThinkingBudgets;
	/* Only supported by Claude 4.x models, see https://docs.aws.amazon.com/bedrock/latest/userguide/claude-messages-extended-thinking.html#claude-messages-extended-thinking-tool-use-interleaved */
	interleavedThinking?: boolean;
	/**
	 * Controls how Claude returns thinking content in Bedrock responses.
	 * - `"summarized"`: thinking blocks include human-readable summaries (default here).
	 * - `"omitted"`: thinking content is suppressed; the encrypted signature still
	 *   travels back for multi-turn continuity.
	 *
	 * Starting with Claude Opus 4.7 and Claude Fable/Mythos 5 the Anthropic API
	 * default is `"omitted"`, which leaves callers waiting on a silent stream during
	 * long reasoning runs (issue #1373). We default to `"summarized"` so adaptive-
	 * thinking models that accept the field keep producing visible thinking deltas.
	 * Older adaptive-thinking models (Opus 4.6, Sonnet 4.6+) reject the field, so
	 * we omit it for them.
	 */
	thinkingDisplay?: BedrockThinkingDisplay;
}

function resolveBearerToken(options: BedrockOptions): string | undefined {
	return resolveAwsBearerToken(options.apiKey, options.bearerToken);
}

function inferRegionFromBedrockArn(modelId: string): string | undefined {
	const parts = modelId.split(":", 6);
	if (parts[0] !== "arn" || parts[2] !== "bedrock") return undefined;
	const region = parts[3];
	return region || undefined;
}

/**
 * Default AWS region for each Bedrock cross-region inference-profile geo prefix.
 * A geo-prefixed profile (e.g. `eu.anthropic.claude-…`) is only servable from
 * regions in its own geo, so routing one to `us-east-1` yields HTTP 400 "The
 * provided model identifier is invalid." `global.` profiles are anchored in the
 * us regions and intentionally absent here (they resolve fine via `us-east-1`).
 */
const INFERENCE_PROFILE_GEO_DEFAULT_REGION: Record<string, string> = {
	us: "us-east-1",
	"us-gov": "us-gov-west-1",
	eu: "eu-west-1",
	apac: "ap-southeast-1",
	au: "ap-southeast-2",
	jp: "ap-northeast-1",
};

/** Geo prefix of a cross-region inference-profile id, e.g. `eu.anthropic.…` → `eu`. */
function inferenceProfileGeo(modelId: string): string | undefined {
	const dot = modelId.indexOf(".");
	if (dot <= 0) return undefined;
	const prefix = modelId.slice(0, dot);
	return prefix in INFERENCE_PROFILE_GEO_DEFAULT_REGION ? prefix : undefined;
}

/**
 * Whether a concrete AWS region can serve a given inference-profile geo. The
 * `ap-` regions overlap across `apac`/`au`/`jp` profiles, so the Australia and
 * Japan geos pin their specific source regions rather than matching all `ap-*`.
 */
function regionServesGeo(region: string, geo: string): boolean {
	switch (geo) {
		case "us-gov":
			return region.startsWith("us-gov-");
		case "us":
			return region.startsWith("us-") && !region.startsWith("us-gov-");
		case "eu":
			return region.startsWith("eu-");
		case "apac":
			return region.startsWith("ap-");
		case "au":
			return region === "ap-southeast-2" || region === "ap-southeast-4";
		case "jp":
			return region === "ap-northeast-1" || region === "ap-northeast-3";
		default:
			return false;
	}
}

/**
 * Resolve the Bedrock runtime region for a request. An explicit per-request
 * region and an ARN-embedded model region win outright. Otherwise, for a
 * geo-prefixed cross-region inference profile (`us.`/`eu.`/`apac.`/`au.`/`jp.`/
 * `us-gov.`), an ambient region (`AWS_REGION` / `AWS_DEFAULT_REGION`) is
 * honored only when it can serve the profile's geo. If the ambient region is
 * absent or mismatched, a same-geo guardrail ARN region is used when available;
 * otherwise the geo default is used. `global.` profiles have no geo entry, so
 * the ambient region (or, when absent, a guardrail ARN's region or
 * `us-east-1`) is used unchanged.
 */
function resolveBedrockRegion(modelId: string, options: BedrockOptions): string {
	const explicit = options.region || inferRegionFromBedrockArn(modelId);
	if (explicit) return explicit;
	const ambient = resolveAwsAmbientRegion(options.profile);
	const guardrailRegion = inferRegionFromBedrockArn(options.guardrailIdentifier ?? "");
	const geo = inferenceProfileGeo(modelId);
	if (geo) {
		if (ambient && regionServesGeo(ambient, geo)) return ambient;
		if (guardrailRegion && regionServesGeo(guardrailRegion, geo)) return guardrailRegion;
		return INFERENCE_PROFILE_GEO_DEFAULT_REGION[geo];
	}
	return ambient || guardrailRegion || "us-east-1";
}

type Block = (TextContent | ThinkingContent | ToolCall) & {
	[kStreamingBlockIndex]?: number;
	[kStreamingPartialJson]?: string;
	[kStreamingLastParseLen]?: number;
};

// ---------- Bedrock wire-format types ----------
// Mirrors only what we actually consume from `ConverseStreamRequest` /
// `ConverseStreamOutput`. Keeps us decoupled from `@aws-sdk/client-bedrock-runtime`.

interface CachePoint {
	cachePoint: { type: "default"; ttl?: "5m" | "1h" };
}

interface BedrockPromptCachePolicy {
	remainingCheckpoints: number;
	ttl?: "1h";
}
interface TextBlockWire {
	text: string;
}
interface ImageBlockWire {
	image: { format: "jpeg" | "png" | "gif" | "webp"; source: { bytes: string } };
}
interface ToolUseBlockWire {
	toolUse: { toolUseId: string; name: string; input: unknown };
}
interface ToolResultBlockWire {
	toolResult: {
		toolUseId: string;
		content: Array<TextBlockWire | ImageBlockWire>;
		status: "success" | "error";
	};
}
interface ReasoningBlockWire {
	reasoningContent: { reasoningText: { text: string; signature?: string } };
}

type UserContent = TextBlockWire | ImageBlockWire | ToolResultBlockWire | CachePoint;
type AssistantContent = TextBlockWire | ToolUseBlockWire | ReasoningBlockWire;
type SystemContent = TextBlockWire | CachePoint;

interface WireMessage {
	role: "user" | "assistant";
	content: Array<UserContent | AssistantContent>;
}

interface WireToolSpec {
	toolSpec: { name: string; description: string; inputSchema: { json: unknown } };
}
interface WireToolChoice {
	auto?: Record<string, never>;
	any?: Record<string, never>;
	tool?: { name: string };
}
interface WireToolConfig {
	tools: WireToolSpec[];
	toolChoice?: WireToolChoice;
}

/**
 * Bedrock validates that requests carrying any `toolUse`/`toolResult` history
 * include a `toolConfig`. For no-tool ephemeral turns (`/btw`, IRC auto-replies)
 * we have nothing real to send, so we inject this placeholder. Its presence is
 * tracked by a per-request flag — never the wire name — so callers who happen
 * to register a real tool literally called `__no_tools__` are not affected.
 */
const NO_TOOLS_SENTINEL_NAME = "__no_tools__";

const NO_TOOLS_SENTINEL: WireToolSpec = {
	toolSpec: {
		name: NO_TOOLS_SENTINEL_NAME,
		description: "Placeholder required by Bedrock validation. Do not call; answer with text.",
		inputSchema: { json: { type: "object", properties: {} } },
	},
};

interface BedrockToolPlan {
	toolConfig: WireToolConfig | undefined;
	sentinelInjected: boolean;
}

interface WireGuardrailConfig {
	guardrailIdentifier: string;
	guardrailVersion: string;
	trace?: BedrockGuardrailTrace;
}

interface ConverseStreamRequest {
	messages: WireMessage[];
	system?: SystemContent[];
	inferenceConfig?: { maxTokens?: number; temperature?: number; topP?: number };
	toolConfig?: WireToolConfig;
	guardrailConfig?: WireGuardrailConfig;
	additionalModelRequestFields?: Record<string, unknown>;
}

// Streaming events (snake_case matches the JSON envelope key, but Bedrock uses camelCase).
interface MessageStartEvent {
	role: "user" | "assistant";
}
interface ContentBlockStartEvent {
	contentBlockIndex: number;
	start?: { toolUse?: { toolUseId?: string; name?: string } };
}
interface ContentBlockDeltaEvent {
	contentBlockIndex: number;
	delta?: {
		text?: string;
		toolUse?: { input?: string };
		reasoningContent?: { text?: string; signature?: string };
	};
}
interface ContentBlockStopEvent {
	contentBlockIndex: number;
}
interface MessageStopEvent {
	stopReason?: string;
}
interface MetadataEvent {
	usage?: {
		inputTokens?: number;
		outputTokens?: number;
		cacheReadInputTokens?: number;
		cacheWriteInputTokens?: number;
		totalTokens?: number;
	};
}

export const streamBedrock: StreamFunction<"bedrock-converse-stream"> = (
	model: Model<"bedrock-converse-stream">,
	context: Context,
	options: BedrockOptions,
): AssistantMessageEventStream => {
	const stream = new AssistantMessageEventStream();

	(async () => {
		const startTime = performance.now();
		let firstTokenTime: number | undefined;

		const output: AssistantMessage = {
			role: "assistant",
			content: [],
			api: "bedrock-converse-stream" as Api,
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

		const blocks = output.content as Block[];
		let rawRequestDump: RawHttpRequestDump | undefined;
		const region = resolveBedrockRegion(model.id, options);

		try {
			const cacheRetention = resolveCacheRetention(options.cacheRetention);
			const promptCachePolicy = resolvePromptCachePolicy(model, cacheRetention);
			const convertedMessages = convertMessages(context, model, promptCachePolicy);
			const toolPlan = planToolConfig(context.tools, options.toolChoice, convertedMessages);
			const toolConfig = toolPlan.toolConfig;
			const sentinelInjected = toolPlan.sentinelInjected;
			let additionalModelRequestFields = buildAdditionalModelRequestFields(model, options);

			// Bedrock rejects thinking + forced tool_choice ("any" or specific tool).
			// When tool_choice forces tool use, disable thinking to avoid API errors.
			if (toolConfig?.toolChoice && additionalModelRequestFields) {
				const tc = toolConfig.toolChoice;
				if (tc.any || tc.tool) additionalModelRequestFields = undefined;
			}

			let commandInput: ConverseStreamRequest = {
				messages: convertedMessages,
				system: buildSystemPrompt(context.systemPrompt, promptCachePolicy),
				inferenceConfig: {
					maxTokens: options.maxTokens,
					temperature: options.temperature,
					topP: options.topP,
				},
				toolConfig,
				guardrailConfig: buildGuardrailConfig(options),
				additionalModelRequestFields,
			};
			const replacementInput = await options?.onPayload?.(commandInput, model);
			if (replacementInput !== undefined) commandInput = replacementInput as ConverseStreamRequest;

			const host = `bedrock-runtime.${region}.amazonaws.com`;
			const url = `https://${host}/model/${encodeURIComponent(model.id)}/converse-stream`;
			const urlPath = `/model/${encodeURIComponent(model.id)}/converse-stream`;
			rawRequestDump = {
				provider: model.provider,
				api: output.api,
				model: model.id,
				method: "POST",
				url,
				body: commandInput,
			};

			const bodyText = JSON.stringify(commandInput);
			const body = new TextEncoder().encode(bodyText);
			// Caller headers are merged BEFORE signing, so SigV4 covers them and they
			// reach the wire. Bedrock built its header map from scratch and ignored
			// `options.headers` entirely, so tracing/attribution headers set by a
			// caller (or by a `before_provider_headers` extension) were silently
			// dropped here while working on every other provider. Content-type and
			// accept stay last: the eventstream framing is not the caller's to change.
			//
			// The signer's OWN headers are dropped first, and that is load-bearing:
			// `signRequest` lets a caller value overwrite `host`/`x-amz-*` in the map
			// it signs, but always RETURNS the generated ones, which `requestHeaders`
			// below then puts on the wire. A caller supplying any of them would sign
			// one set of values and send another, and Bedrock would reject every
			// request with a signature mismatch.
			// Lower-cased, and names the request sets itself are dropped. Keeping a
			// caller `Content-Type` beside the fixed `content-type` leaves TWO object
			// keys: SigV4 signs one value while fetch canonicalizes both into a single
			// comma-joined wire header, so AWS validates different bytes than were
			// signed and rejects the request.
			const callerHeaders: Record<string, string> = {};
			for (const [name, value] of Object.entries(options?.headers ?? {})) {
				const field = name.toLowerCase();
				if (SIGNER_OWNED_HEADERS.has(field) || BEDROCK_RESERVED_HEADERS.has(field)) continue;
				callerHeaders[field] = value;
			}
			const baseHeaders: Record<string, string> = {
				...callerHeaders,
				"content-type": "application/json",
				accept: "application/vnd.amazon.eventstream",
			};

			const bearerToken = resolveBearerToken(options);
			let requestHeaders: Record<string, string>;
			if (bearerToken) {
				requestHeaders = { ...baseHeaders, Authorization: `Bearer ${bearerToken}` };
			} else {
				let credentials: { accessKeyId: string; secretAccessKey: string; sessionToken?: string };
				if ($flag("AWS_BEDROCK_SKIP_AUTH")) {
					credentials = { accessKeyId: "dummy-access-key", secretAccessKey: "dummy-secret-key" };
				} else {
					credentials = await resolveAwsCredentials({
						profile: options.profile,
						region,
						signal: options.signal,
						fetch: options.fetch,
					});
				}
				const signed = await signRequest({
					method: "POST",
					host,
					path: urlPath,
					body,
					region,
					service: "bedrock",
					credentials,
					headers: baseHeaders,
				});
				requestHeaders = { ...baseHeaders, ...signed };
			}

			// Bun's native fetch ceiling is disabled below (`timeout: false`) so
			// configurable watchdogs govern slow-prefill streams (issue #2422).
			// Direct callers that bypass `register-builtins` (which installs the
			// iterator-level first-event watchdog) still need a pre-response
			// timer, otherwise a Bedrock/proxy that accepts the POST and never
			// sends headers would hang forever.
			const firstEventTimeoutMs = options.streamFirstEventTimeoutMs ?? getStreamFirstEventTimeoutMs();
			// Clear the pre-response timer the instant headers arrive (below): an
			// absolute `AbortSignal.timeout` would keep aborting the actively
			// streaming body, not just a stalled time-to-first-byte (issue #2422).
			const watchdog = armPreResponseTimeout(options.signal, firstEventTimeoutMs);
			let response: Response;
			try {
				response = await fetchWithRetry(url, {
					method: "POST",
					headers: requestHeaders,
					body,
					signal: watchdog.signal,
					fetch: options.fetch,
					timeout: false,
				});
			} finally {
				watchdog.clear();
			}

			if (!response.ok) {
				if (!bearerToken && (response.status === 401 || response.status === 403)) {
					// Stale cached credentials (e.g. rotated session keys in ~/.aws/credentials) —
					// drop the cache entry so the next attempt re-resolves from scratch.
					invalidateAwsCredentialCache({ profile: options.profile, region });
				}
				const errBody = await response.text().catch(() => "");
				throw new AIError.BedrockApiError(
					`Bedrock HTTP ${response.status}: ${errBody.slice(0, 1000)}`,
					response.status,
					{
						headers: response.headers,
					},
				);
			}
			if (!response.body) throw new AIError.BedrockApiError("Bedrock response has no body", response.status);

			// Track first event for the abort/diagnostic path (currently informational).
			for await (const message of decodeEventStream(response.body)) {
				const messageType = message.headers[":message-type"];
				const eventType = message.headers[":event-type"];

				if (messageType === "exception") {
					const exceptionType = message.headers[":exception-type"] || "Exception";
					const payload = safeParsePayload(message.payload) as { message?: string } | undefined;
					const errorMessage = payload?.message || new TextDecoder().decode(message.payload);
					const text = `${exceptionType}: ${errorMessage}`;
					throw new AIError.BedrockApiError(text, 400, { code: exceptionType });
				}
				if (messageType === "error") {
					const code = message.headers[":error-code"] || "UnknownError";
					const errorMessage = message.headers[":error-message"] || new TextDecoder().decode(message.payload);
					throw new AIError.BedrockApiError(`${code}: ${errorMessage}`, 400, { code });
				}
				if (messageType !== "event") continue;

				const payload = safeParsePayload(message.payload);
				if (!payload) continue;

				switch (eventType) {
					case "messageStart": {
						// no-op: first event marker is implicit by stream entry.
						const ev = payload as MessageStartEvent;
						if (ev.role !== "assistant") {
							throw new AIError.BedrockApiError(
								"Unexpected assistant message start but got user message start instead",
								0,
							);
						}
						stream.push({ type: "start", partial: output });
						break;
					}
					case "contentBlockStart": {
						if (!firstTokenTime) firstTokenTime = performance.now();
						handleContentBlockStart(payload as ContentBlockStartEvent, blocks, output, stream, sentinelInjected);
						break;
					}
					case "contentBlockDelta": {
						if (!firstTokenTime) firstTokenTime = performance.now();
						handleContentBlockDelta(payload as ContentBlockDeltaEvent, blocks, output, stream);
						break;
					}
					case "contentBlockStop": {
						handleContentBlockStop(payload as ContentBlockStopEvent, blocks, output, stream);
						break;
					}
					case "messageStop": {
						const ev = payload as MessageStopEvent;
						// A sentinel-only request must never surface a tool-use stop:
						// no real tool exists for the agent to dispatch.
						output.stopReason =
							sentinelInjected && ev.stopReason === "tool_use" ? "stop" : mapStopReason(ev.stopReason);
						if (output.stopReason === "error") {
							// A guardrail block ends the turn with `guardrail_intervened` and often no
							// content — surface it explicitly so it never reads as an empty completion.
							output.errorMessage =
								ev.stopReason === "guardrail_intervened"
									? `Response blocked by Amazon Bedrock guardrail (stop reason: ${ev.stopReason}).`
									: ev.stopReason === "content_filtered"
										? `Response filtered by Amazon Bedrock content filters (stop reason: ${ev.stopReason}).`
										: `Generation failed with stop reason: ${ev.stopReason ?? "unknown"}`;
						}
						break;
					}
					case "metadata": {
						handleMetadata(payload as MetadataEvent, model, output);
						break;
					}
					default:
						// Unknown event types (Bedrock may add new ones) — ignore.
						break;
				}
			}

			if (options.signal?.aborted) throw new AIError.AbortError();

			if (output.stopReason === "error" || output.stopReason === "aborted") {
				throw new AIError.BedrockApiError(output.errorMessage ?? "An unknown error occurred", 0);
			}

			output.duration = performance.now() - startTime;
			if (firstTokenTime) output.ttft = firstTokenTime - startTime;
			stream.push({ type: "done", reason: output.stopReason, message: output });
			stream.end();
		} catch (error) {
			for (const block of output.content) {
				if (block.type === "toolCall") clearStreamingPartialJson(block);
			}
			let baseMessage: string;
			try {
				baseMessage = error instanceof Error ? error.message : (JSON.stringify(error) ?? String(error));
			} catch {
				baseMessage = String(error);
			}
			// Enrich error with thinking block diagnostics for signature-related failures
			let diagnostics = "";
			if (baseMessage.includes("signature") || baseMessage.includes("thinking")) {
				const thinkingBlocks = context.messages
					.filter((m): m is AssistantMessage => m.role === "assistant")
					.flatMap((m, mi) =>
						m.content
							.filter(b => b.type === "thinking")
							.map((b, bi) => ({
								msg: mi,
								block: bi,
								stop: m.stopReason,
								sigLen: b.thinkingSignature?.length ?? -1,
								thinkLen: b.thinking.length,
							})),
					);
				if (thinkingBlocks.length > 0) {
					diagnostics = `\n[thinking-diag] ${JSON.stringify(thinkingBlocks)}`;
				}
			}
			const result = await AIError.finalize(error, { api: model.api, signal: options.signal, rawRequestDump });
			output.stopReason = result.stopReason;
			output.errorStatus = result.status;
			output.errorId = result.id;
			output.errorMessage = result.message + diagnostics;
			output.duration = performance.now() - startTime;
			if (firstTokenTime) output.ttft = firstTokenTime - startTime;
			stream.push({ type: "error", reason: output.stopReason, error: output });
			stream.end();
		}
	})();

	return stream;
};

function safeParsePayload(payload: Uint8Array): unknown {
	if (payload.length === 0) return {};
	try {
		return JSON.parse(new TextDecoder().decode(payload));
	} catch {
		return undefined;
	}
}

function handleContentBlockStart(
	event: ContentBlockStartEvent,
	blocks: Block[],
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
	sentinelInjected: boolean,
): void {
	const index = event.contentBlockIndex;
	const start = event.start;

	// Drop the sentinel call only when we injected it ourselves. A caller that
	// registers a real tool named `__no_tools__` would otherwise lose its
	// legitimate tool-use events on normal turns.
	if (sentinelInjected && start?.toolUse?.name === NO_TOOLS_SENTINEL_NAME) return;

	if (start?.toolUse) {
		const block: Block = {
			type: "toolCall",
			id: normalizeToolCallId(start.toolUse.toolUseId || ""),
			name: start.toolUse.name || "",
			arguments: {},
			[kStreamingPartialJson]: "",
			[kStreamingBlockIndex]: index,
		};
		output.content.push(block);
		stream.push({ type: "toolcall_start", contentIndex: blocks.length - 1, partial: output });
	}
}

function handleContentBlockDelta(
	event: ContentBlockDeltaEvent,
	blocks: Block[],
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
): void {
	const contentBlockIndex = event.contentBlockIndex;
	const delta = event.delta;
	let index = blocks.findIndex(b => b[kStreamingBlockIndex] === contentBlockIndex);
	let block = blocks[index];

	if (delta?.text !== undefined) {
		// If no text block exists yet, create one — `handleContentBlockStart` is not sent for text blocks
		if (!block) {
			const newBlock: Block = { type: "text", text: "", [kStreamingBlockIndex]: contentBlockIndex };
			output.content.push(newBlock);
			index = blocks.length - 1;
			block = blocks[index];
			stream.push({ type: "text_start", contentIndex: index, partial: output });
		}
		if (block.type === "text") {
			block.text += delta.text;
			stream.push({ type: "text_delta", contentIndex: index, delta: delta.text, partial: output });
		}
	} else if (delta?.toolUse && block?.type === "toolCall") {
		block[kStreamingPartialJson] = (block[kStreamingPartialJson] || "") + (delta.toolUse.input || "");
		const throttled = parseStreamingJsonThrottled(block[kStreamingPartialJson], block[kStreamingLastParseLen] ?? 0);
		if (throttled) {
			block.arguments = throttled.value;
			block[kStreamingLastParseLen] = throttled.parsedLen;
		}
		stream.push({ type: "toolcall_delta", contentIndex: index, delta: delta.toolUse.input || "", partial: output });
	} else if (delta?.reasoningContent) {
		let thinkingBlock = block;
		let thinkingIndex = index;

		if (!thinkingBlock) {
			const newBlock: Block = {
				type: "thinking",
				thinking: "",
				thinkingSignature: "",
				[kStreamingBlockIndex]: contentBlockIndex,
			};
			output.content.push(newBlock);
			thinkingIndex = blocks.length - 1;
			thinkingBlock = blocks[thinkingIndex];
			stream.push({ type: "thinking_start", contentIndex: thinkingIndex, partial: output });
		}

		if (thinkingBlock?.type === "thinking") {
			if (delta.reasoningContent.text) {
				thinkingBlock.thinking += delta.reasoningContent.text;
				stream.push({
					type: "thinking_delta",
					contentIndex: thinkingIndex,
					delta: delta.reasoningContent.text,
					partial: output,
				});
			}
			if (delta.reasoningContent.signature) {
				thinkingBlock.thinkingSignature =
					(thinkingBlock.thinkingSignature || "") + delta.reasoningContent.signature;
			}
		}
	}
}

function handleMetadata(event: MetadataEvent, model: Model<"bedrock-converse-stream">, output: AssistantMessage): void {
	if (event.usage) {
		output.usage.input = event.usage.inputTokens || 0;
		output.usage.output = event.usage.outputTokens || 0;
		output.usage.cacheRead = event.usage.cacheReadInputTokens || 0;
		output.usage.cacheWrite = event.usage.cacheWriteInputTokens || 0;
		output.usage.totalTokens = event.usage.totalTokens || output.usage.input + output.usage.output;
		calculateCost(model, output.usage);
	}
}

function handleContentBlockStop(
	event: ContentBlockStopEvent,
	blocks: Block[],
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
): void {
	const index = blocks.findIndex(b => b[kStreamingBlockIndex] === event.contentBlockIndex);
	const block = blocks[index];
	if (!block) return;

	switch (block.type) {
		case "text":
			stream.push({ type: "text_end", contentIndex: index, content: block.text, partial: output });
			break;
		case "thinking":
			stream.push({ type: "thinking_end", contentIndex: index, content: block.thinking, partial: output });
			break;
		case "toolCall":
			block.arguments = parseStreamingJson(block[kStreamingPartialJson]);
			clearStreamingPartialJson(block);
			stream.push({ type: "toolcall_end", contentIndex: index, toolCall: block, partial: output });
			break;
	}
}

/**
 * Resolve Bedrock's explicit-cache request policy from the catalog's
 * materialized provider contract. Bedrock enforces each model's minimum
 * prefix-token requirement, so this boundary intentionally does not locally
 * count tokens. The emitter prioritizes the final user boundary, then the
 * system boundary, without exceeding the configured checkpoint maximum.
 *
 * `AWS_BEDROCK_FORCE_CACHE` remains an escape hatch for opaque application
 * inference profiles, defaulting those otherwise-unknown models to the
 * existing two-checkpoint layout without inventing 1h retention.
 */
function resolvePromptCachePolicy(
	model: Model<"bedrock-converse-stream">,
	cacheRetention: CacheRetention,
): BedrockPromptCachePolicy {
	if (cacheRetention === "none" || model.compat.promptCacheMode === "automatic") {
		return { remainingCheckpoints: 0 };
	}

	const forced = $flag("AWS_BEDROCK_FORCE_CACHE");
	const explicit = model.compat.promptCacheMode === "explicit";
	if (!explicit && !forced) {
		return { remainingCheckpoints: 0 };
	}

	const configuredMaximum = explicit ? model.compat.promptCacheMaximumCheckpoints : 2;
	if (configuredMaximum <= 0) {
		return { remainingCheckpoints: 0 };
	}

	return {
		remainingCheckpoints: Math.min(configuredMaximum, 2),
		...(cacheRetention === "long" && model.compat.supportsLongPromptCacheRetention ? { ttl: "1h" } : {}),
	};
}

function takeCachePoint(policy: BedrockPromptCachePolicy): CachePoint | undefined {
	if (policy.remainingCheckpoints <= 0) return undefined;
	policy.remainingCheckpoints--;
	return { cachePoint: { type: "default", ...(policy.ttl ? { ttl: policy.ttl } : {}) } };
}

function buildSystemPrompt(
	systemPrompt: readonly string[] | string | undefined,
	promptCachePolicy: BedrockPromptCachePolicy,
): SystemContent[] | undefined {
	const prompts = normalizeSystemPrompts(systemPrompt);
	if (prompts.length === 0) return undefined;

	const blocks: SystemContent[] = prompts.map(prompt => ({ text: prompt }));

	const cachePoint = takeCachePoint(promptCachePolicy);
	if (cachePoint) blocks.push(cachePoint);

	return blocks;
}

function convertMessages(
	context: Context,
	model: Model<"bedrock-converse-stream">,
	promptCachePolicy: BedrockPromptCachePolicy,
): WireMessage[] {
	const result: WireMessage[] = [];
	const transformedMessages = transformMessages(context.messages, model, normalizeToolCallId);

	for (let i = 0; i < transformedMessages.length; i++) {
		const m = transformedMessages[i];

		switch (m.role) {
			case "developer":
			case "user":
				if (typeof m.content === "string") {
					// Skip empty user messages
					if (!m.content || m.content.trim() === "") continue;
					result.push({ role: "user", content: [{ text: m.content.toWellFormed() }] });
				} else {
					const contentBlocks: UserContent[] = [];
					for (const c of m.content) {
						switch (c.type) {
							case "text": {
								const text = c.text.toWellFormed();
								if (text.trim().length === 0) continue;
								contentBlocks.push({ text });
								break;
							}
							case "image":
								contentBlocks.push({ image: createImageBlock(c.mimeType, c.data) });
								break;
							default:
								throw new AIError.ValidationError("Unknown user content type");
						}
					}
					// Skip message if all blocks filtered out
					if (contentBlocks.length === 0) continue;
					result.push({ role: "user", content: contentBlocks });
				}
				break;
			case "assistant": {
				// Skip assistant messages with empty content (e.g., from aborted requests)
				// Bedrock rejects messages with empty content arrays
				if (m.content.length === 0) continue;
				const contentBlocks: AssistantContent[] = [];
				for (const c of m.content) {
					switch (c.type) {
						case "text":
							// Skip empty text blocks
							if (c.text.trim().length === 0) continue;
							contentBlocks.push({ text: c.text.toWellFormed() });
							break;
						case "toolCall":
							contentBlocks.push({
								toolUse: {
									toolUseId: normalizeToolCallId(c.id),
									name: c.name,
									input: c.arguments,
								},
							});
							break;
						case "thinking":
							// Skip empty thinking blocks
							if (c.thinking.trim().length === 0) continue;
							// A captured signature is authoritative even when the model id is an opaque ARN:
							// only a model that itself streamed a signature (Claude) can have one, so replay
							// it as signed reasoningContent regardless of how the id is spelled.
							if (c.thinkingSignature) {
								contentBlocks.push({
									reasoningContent: {
										reasoningText: { text: c.thinking.toWellFormed(), signature: c.thinkingSignature },
									},
								});
							} else {
								// No signature was captured. Do NOT fall back to unsigned reasoningContent here:
								// a model streaming reasoningContent does not imply it accepts reasoningContent
								// echoed back in a request. Amazon Nova streams unsigned reasoning just fine but
								// rejects it on replay with HTTP 400 "User messages cannot contain reasoning
								// content. Please remove the reasoning content and try again.", which wedges the
								// agent loop on every turn after the first. Demote to plain text instead — the
								// content survives, just no longer typed as a reasoning block. This matches how
								// every other provider (Anthropic, Google, OpenAI-completions) handles thinking
								// blocks it can't safely replay.
								contentBlocks.push({ text: renderDemotedThinking(model.id, c.thinking) });
							}
							break;
						default:
							throw new AIError.ValidationError("Unknown assistant content type");
					}
				}
				// Skip if all content blocks were filtered out
				if (contentBlocks.length === 0) continue;
				result.push({ role: "assistant", content: contentBlocks });
				break;
			}
			case "toolResult": {
				// Collect all consecutive toolResult messages into a single user message —
				// Bedrock requires all tool results to be in one message.
				const toolResults: ToolResultBlockWire[] = [];
				toolResults.push({
					toolResult: {
						toolUseId: normalizeToolCallId(m.toolCallId),
						content: m.content.map(c =>
							c.type === "image"
								? { image: createImageBlock(c.mimeType, c.data) }
								: { text: c.text.toWellFormed() },
						),
						status: m.isError ? "error" : "success",
					},
				});

				let j = i + 1;
				while (j < transformedMessages.length && transformedMessages[j].role === "toolResult") {
					const nextMsg = transformedMessages[j] as ToolResultMessage;
					toolResults.push({
						toolResult: {
							toolUseId: normalizeToolCallId(nextMsg.toolCallId),
							content: nextMsg.content.map(c =>
								c.type === "image"
									? { image: createImageBlock(c.mimeType, c.data) }
									: { text: c.text.toWellFormed() },
							),
							status: nextMsg.isError ? "error" : "success",
						},
					});
					j++;
				}
				i = j - 1;

				result.push({ role: "user", content: toolResults });
				break;
			}
			default:
				throw new AIError.ValidationError("Unknown message role");
		}
	}

	// Prioritize the final user checkpoint; buildSystemPrompt consumes any
	// remaining configured capacity afterward.
	if (result.length > 0) {
		const lastMessage = result[result.length - 1];
		if (lastMessage.role === "user" && lastMessage.content) {
			const cachePoint = takeCachePoint(promptCachePolicy);
			if (cachePoint) (lastMessage.content as UserContent[]).push(cachePoint);
		}
	}

	return result;
}

function messagesHaveToolBlocks(messages: WireMessage[]): boolean {
	for (const message of messages) {
		for (const block of message.content) {
			if ("toolUse" in block || "toolResult" in block) return true;
		}
	}
	return false;
}

function convertToolSpec(tool: Tool): WireToolSpec {
	return {
		toolSpec: {
			name: tool.name,
			description: tool.description || "",
			inputSchema: { json: toolWireSchema(tool) },
		},
	};
}

function planToolConfig(
	tools: Tool[] | undefined,
	toolChoice: BedrockOptions["toolChoice"],
	messages: WireMessage[],
): BedrockToolPlan {
	const activeTools = tools ?? [];
	const hasTools = activeTools.length > 0;
	const historyHasToolBlocks = messagesHaveToolBlocks(messages);

	if (toolChoice === "none") {
		if (!historyHasToolBlocks) return { toolConfig: undefined, sentinelInjected: false };
		if (!hasTools) {
			return {
				toolConfig: { tools: [NO_TOOLS_SENTINEL], toolChoice: { auto: {} } },
				sentinelInjected: true,
			};
		}
		return { toolConfig: { tools: activeTools.map(convertToolSpec) }, sentinelInjected: false };
	}

	if (!hasTools) return { toolConfig: undefined, sentinelInjected: false };

	const bedrockTools = activeTools.map(convertToolSpec);
	let bedrockToolChoice: WireToolChoice | undefined;
	switch (toolChoice) {
		case "auto":
			bedrockToolChoice = { auto: {} };
			break;
		case "any":
			bedrockToolChoice = { any: {} };
			break;
		default:
			if (toolChoice?.type === "tool") {
				bedrockToolChoice = { tool: { name: toolChoice.name } };
			}
	}

	return { toolConfig: { tools: bedrockTools, toolChoice: bedrockToolChoice }, sentinelInjected: false };
}

function mapStopReason(reason: string | undefined): StopReason {
	switch (reason) {
		case "end_turn":
		case "stop_sequence":
			return "stop";
		case "max_tokens":
		case "model_context_window_exceeded":
			return "length";
		case "tool_use":
			return "toolUse";
		default:
			return "error";
	}
}

/**
 * Build the Converse `guardrailConfig` block when a guardrail identifier is set.
 * The version defaults to `"DRAFT"` (Bedrock's editable working draft) and the
 * trace is passed through untouched — leaving it undefined keeps Bedrock's own
 * default rather than forcing a value.
 */
function buildGuardrailConfig(options: BedrockOptions): WireGuardrailConfig | undefined {
	if (!options.guardrailIdentifier) return undefined;
	return {
		guardrailIdentifier: options.guardrailIdentifier,
		guardrailVersion: options.guardrailVersion ?? "DRAFT",
		...(options.guardrailTrace === undefined ? {} : { trace: options.guardrailTrace }),
	};
}

function buildAdditionalModelRequestFields(
	model: Model<"bedrock-converse-stream">,
	options: BedrockOptions,
): Record<string, unknown> | undefined {
	const reasoning = options.reasoning;
	if (!reasoning || !model.reasoning) return undefined;

	const mode = model.thinking?.mode;
	if (mode === "anthropic-adaptive") {
		const effort = mapEffortToAnthropicAdaptiveEffort(model, reasoning);
		// Starting with Claude Opus 4.7 and Claude Fable/Mythos 5, Anthropic switched
		// the adaptive-thinking default to "omitted", which silently suppresses
		// streamed reasoning and can read as a stalled stream during long reasoning
		// runs (issue #1373). Opt back into "summarized" by default on models that
		// accept the field.
		const adaptive: { type: "adaptive"; display?: BedrockThinkingDisplay } = { type: "adaptive" };
		if (model.thinking?.supportsDisplay) {
			adaptive.display = options.thinkingDisplay ?? "summarized";
		}
		return {
			thinking: adaptive,
			output_config: { effort },
		};
	}

	if (mode === "effort") {
		// OpenAI-schema models on Bedrock (the GPT-5.x SKUs) reject the
		// Anthropic budget block with `unknown_parameter: 'thinking'` and take
		// `reasoning.effort` instead — same effort vocabulary the catalog
		// already bakes (low/medium/high/xhigh/max).
		const level = requireSupportedEffort(model, reasoning);
		return { reasoning: { effort: model.thinking?.effortMap?.[level] ?? level } };
	}

	const level = requireSupportedEffort(model, reasoning);
	const defaultBudgets: Record<Effort, number> = {
		minimal: 1024,
		low: 2048,
		medium: 8192,
		high: 16384,
		xhigh: 32768,
		max: 32768,
	};
	const budget = options.thinkingBudgets?.[level] ?? defaultBudgets[level];

	const result: Record<string, unknown> = {
		thinking: {
			type: "enabled",
			budget_tokens: budget,
			display: options.thinkingDisplay ?? "summarized",
		},
	};

	if (options.interleavedThinking) {
		result.anthropic_beta = ["interleaved-thinking-2025-05-14"];
	}

	return result;
}

/**
 * Bedrock's wire format expects the image as `{ source: { bytes: <base64-string> }, format }`.
 * The caller already passes base64-encoded data, so no decode/re-encode round-trip is needed.
 */
function createImageBlock(mimeType: string, data: string): ImageBlockWire["image"] {
	let format: "jpeg" | "png" | "gif" | "webp";
	switch (mimeType) {
		case "image/jpeg":
		case "image/jpg":
			format = "jpeg";
			break;
		case "image/png":
			format = "png";
			break;
		case "image/gif":
			format = "gif";
			break;
		case "image/webp":
			format = "webp";
			break;
		default:
			throw new AIError.ValidationError(`Unknown image type: ${mimeType}`);
	}
	return { source: { bytes: data }, format };
}
