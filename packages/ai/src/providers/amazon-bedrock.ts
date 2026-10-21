/**
 * Amazon Bedrock chat transport.
 *
 * Ordinary requests use Converse Stream; server compaction uses the
 * Anthropic Messages format over Bedrock's InvokeModelWithResponseStream API.
 * Both call `bedrock-runtime.{region}.amazonaws.com` directly over HTTPS with
 * shared credential resolution and SigV4 signing. The normal path decodes
 * `application/vnd.amazon.eventstream`; no AWS SDK, Smithy, or proxy-agent
 * dependency is required. Bun's native `HTTPS_PROXY` support is honored.
 *
 * A `models.yml` `baseUrl` is the request origin verbatim (VPC endpoint, gateway, …);
 * only AWS's own regional host is re-pointed at the resolved region. SigV4 unaffected.
 */

import type { Effort } from "@oh-my-pi/pi-catalog/effort";
import { mapEffortToAnthropicAdaptiveEffort, requireSupportedEffort } from "@oh-my-pi/pi-catalog/model-thinking";
import { calculateCost } from "@oh-my-pi/pi-catalog/models";
import { $flag, fetchWithRetry, logger, parseStreamingJsonThrottled, USER_AGENT } from "@oh-my-pi/pi-utils";
import { renderDemotedThinking } from "../dialect/demotion";
import * as AIError from "../error";
import { parseToolCallArguments } from "../utils/tool-call-arguments";
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
import { isRecord, normalizeSystemPrompts, normalizeToolCallId, resolveCacheRetention } from "../utils";
import { resolveAwsAmbientRegion } from "../utils/aws-profile";
import {
	clearStreamingPartialJson,
	kStreamingBlockIndex,
	kStreamingLastParseLen,
	kStreamingPartialJson,
} from "../utils/block-symbols";
import { AssistantMessageEventStream } from "../utils/event-stream";
import type { RawHttpRequestDump } from "../utils/http-inspector";
import { armPreResponseTimeout, getStreamFirstEventTimeoutMs, getStreamIdleTimeoutMs } from "../utils/idle-iterator";
import { toolWireSchema } from "../utils/schema/wire";
import { invalidateAwsCredentialCache, resolveAwsCredentials } from "./aws-credentials";
import { decodeEventStream } from "./aws-eventstream";
import { signRequest } from "./aws-sigv4";
import { isThinkingPrefixBindingError, logDroppedThinking, streamBedrockAnthropicCompaction } from "./anthropic";
import type { AnthropicMessagesClientLike, AnthropicRequestOptions } from "./anthropic-client";
import { supportsBedrockConverseCompaction } from "./anthropic-compaction";
import { isAnthropicNarrationSignature } from "./anthropic-signature";
import type { MessageCreateParams, MessageCreateParamsStreaming, RawMessageStreamEvent } from "./anthropic-wire";
import { parseAnthropicInputTransformations, THINKING_BINDING_CONTROLS_BETA } from "./anthropic-wire";
import { fitBedrockAnthropicPayload } from "./bedrock-anthropic";
import { isBedrockRequestMetadataValue } from "./bedrock-request-metadata";
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
const BEDROCK_INTERLEAVED_THINKING_BETA = "interleaved-thinking-2025-05-14";

/**
 * HTTP status for an in-stream failure, keyed by lowercased exception shape
 * name. Exception and error frames ride inside an HTTP 200 event stream,
 * so the shape name in `:exception-type` / `:error-code` is the
 * only evidence of what actually failed upstream. Values come from the
 * bedrock-runtime service model (the same source the AWS SDKs deserialize
 * against): without them every in-stream failure would be stamped 400, which
 * the retry classifier reads as a deterministic client rejection and refuses
 * to replay — making a transient `internalServerException` (500) terminal.
 * Shapes absent from the map keep 400 so an unrecognized rejection is never
 * retried by accident.
 */
const BEDROCK_STREAM_EXCEPTION_STATUS: Record<string, number> = {
	accessdeniedexception: 403,
	conflictexception: 400,
	internalserverexception: 500,
	modelerrorexception: 424,
	modelnotreadyexception: 429,
	modelstreamerrorexception: 424,
	modeltimeoutexception: 408,
	resourcenotfoundexception: 404,
	servicequotaexceededexception: 400,
	serviceunavailableexception: 503,
	throttlingexception: 429,
	validationexception: 400,
};

/**
 * Resolve the service-model status for an in-stream exception/error code.
 * Frame headers carry the bare shape name in either camelCase
 * (`internalServerException`) or PascalCase (`InternalServerException`); both
 * normalize to the same map key. Unknown shapes default to 400.
 */
export function bedrockStreamExceptionStatus(code: string): number {
	return BEDROCK_STREAM_EXCEPTION_STATUS[code.trim().toLowerCase()] ?? 400;
}

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
	/**
	 * Per-request Bedrock invocation-log tags. Merged over `model.requestMetadata`
	 * (per-call entries win on key collision). AWS caps the result at 16 entries;
	 * keys 1-256 chars, values 0-256 chars, both limited to
	 * `[a-zA-Z0-9\s:_@$#=/+,-.]`. Entries outside those limits are dropped.
	 */
	requestMetadata?: Record<string, string>;
}

function resolveBearerToken(options: BedrockOptions): string | undefined {
	return resolveAwsBearerToken(options.apiKey, options.bearerToken);
}

/**
 * Request origin. `baseUrl` is the origin verbatim, path prefix (and query, for
 * gateways that authenticate via a query parameter) included, so a gateway
 * mounted under a path works. AWS's own host is re-pointed: the catalog can't
 * know the region.
 */
function resolveBedrockBaseUrl(model: Model<"bedrock-converse-stream">, region: string): URL {
	const base = new URL(model.baseUrl || `https://bedrock-runtime.${region}.amazonaws.com`);
	if (AWS_REGIONAL_BEDROCK_HOST.test(base.host)) base.host = `bedrock-runtime.${region}.amazonaws.com`;
	return base;
}

/** Bedrock Runtime operation, named by its URL suffix under `/model/<id>/`. */
type BedrockRequestEndpoint = "converse-stream" | "invoke-with-response-stream";

function resolveBedrockRequestUrl(
	model: Model<"bedrock-converse-stream">,
	base: URL,
	endpoint: BedrockRequestEndpoint,
): { urlPath: string; url: string } {
	const urlPath = `${base.pathname.replace(/\/+$/, "")}/model/${encodeURIComponent(model.id)}/${endpoint}`;
	return { urlPath, url: `${base.origin}${urlPath}${base.search}` };
}

/**
 * Sign and send one Bedrock Runtime request. A non-OK InvokeModel response's
 * body is read under the same pre-response deadline, so a stalled error body
 * cannot hang the caller.
 */
async function sendBedrockRequest(
	model: Model<"bedrock-converse-stream">,
	options: BedrockOptions,
	region: string,
	base: URL,
	input: unknown,
	endpoint: BedrockRequestEndpoint,
	signal: AbortSignal | undefined = options.signal,
): Promise<{ response: Response; responseBody?: string }> {
	const host = base.host;
	const { urlPath, url } = resolveBedrockRequestUrl(model, base, endpoint);
	const query = base.search.slice(1) || undefined;
	// Caller headers are merged BEFORE signing, so SigV4 covers them and they
	// reach the wire; tracing/attribution headers (including those set by a
	// `before_provider_headers` extension) work here as on every other provider.
	// `model.headers` first, `options.headers` second: `StreamOptions.headers` is
	// documented as merged ON TOP of model-defined headers.
	//
	// The signer's OWN headers are dropped first, and that is load-bearing:
	// `signRequest` lets a caller value overwrite `host`/`x-amz-*` in the map it
	// signs, but always RETURNS the generated ones, which `requestHeaders` below
	// puts on the wire. A caller supplying any of them would sign one set of
	// values and send another, and Bedrock would reject every request.
	// Names the request sets itself are dropped too: keeping a caller
	// `Content-Type` beside the fixed `content-type` leaves TWO object keys, which
	// SigV4 signs as one value while fetch joins both into a single comma-joined
	// wire header, so AWS validates different bytes than were signed.
	const callerHeaders: Record<string, string> = {};
	for (const source of [model.headers, options.headers]) {
		for (const [name, value] of Object.entries(source ?? {})) {
			const field = name.toLowerCase();
			if (SIGNER_OWNED_HEADERS.has(field) || BEDROCK_RESERVED_HEADERS.has(field)) continue;
			callerHeaders[field] = value;
		}
	}
	// SigV4 never signs `user-agent` (UNSIGNABLE in aws-sigv4.ts), so this default
	// cannot break the signature. Without it Bun's fetch sends `Bun/<version>`,
	// and that is what CloudTrail records for every request.
	callerHeaders["user-agent"] ??= USER_AGENT;
	// Content-type and accept stay last: the eventstream framing is not the caller's to change.
	const headers: Record<string, string> = {
		...callerHeaders,
		"content-type": "application/json",
		accept: "application/vnd.amazon.eventstream",
	};
	if (endpoint === "invoke-with-response-stream") {
		headers["x-amzn-bedrock-accept"] = "application/json";
		if (options.guardrailIdentifier) {
			headers["x-amzn-bedrock-guardrailidentifier"] = options.guardrailIdentifier;
			headers["x-amzn-bedrock-guardrailversion"] = options.guardrailVersion ?? "DRAFT";
			if (options.guardrailTrace) headers["x-amzn-bedrock-guardrailtrace"] = options.guardrailTrace.toUpperCase();
		}
		const requestMetadata = sanitizeRequestMetadata(
			model.requestMetadata || options.requestMetadata
				? { ...model.requestMetadata, ...options.requestMetadata }
				: undefined,
		);
		if (requestMetadata) headers["x-amzn-bedrock-request-metadata"] = JSON.stringify(requestMetadata);
	}
	const body = new TextEncoder().encode(JSON.stringify(input));
	const bearerToken = resolveBearerToken(options);
	let requestHeaders: Record<string, string>;
	if (bearerToken) {
		requestHeaders = { ...headers, Authorization: `Bearer ${bearerToken}` };
	} else {
		let credentials: { accessKeyId: string; secretAccessKey: string; sessionToken?: string };
		if ($flag("AWS_BEDROCK_SKIP_AUTH")) {
			credentials = { accessKeyId: "dummy-access-key", secretAccessKey: "dummy-secret-key" };
		} else {
			credentials = await resolveAwsCredentials({
				profile: options.profile,
				region,
				signal,
				fetch: options.fetch,
			});
		}
		const signed = await signRequest({
			method: "POST",
			host,
			path: urlPath,
			query,
			body,
			region,
			service: "bedrock",
			credentials,
			headers,
		});
		requestHeaders = { ...headers, ...signed };
	}
	// Bun's native fetch ceiling is disabled (`timeout: false`) so configurable
	// watchdogs govern slow-prefill streams (issue #2422). Direct callers that
	// bypass `register-builtins` (which installs the iterator-level first-event
	// watchdog) still need this pre-response timer, otherwise an endpoint that
	// accepts the POST and never sends headers would hang forever. Converse keeps
	// the global default; a compaction request summarizes a whole history before
	// streaming, so it waits as long as the model's idle window allows.
	const firstEventTimeoutMs =
		options.streamFirstEventTimeoutMs ??
		(endpoint === "converse-stream"
			? getStreamFirstEventTimeoutMs()
			: getStreamFirstEventTimeoutMs(
					options.streamIdleTimeoutMs ?? getStreamIdleTimeoutMs(model.compat.streamIdleTimeoutMs),
				));
	const watchdog = armPreResponseTimeout(signal, firstEventTimeoutMs);
	let response: Response;
	let responseBody: string | undefined;
	try {
		response = await fetchWithRetry(url, {
			method: "POST",
			headers: requestHeaders,
			body,
			signal: watchdog.signal,
			fetch: options.fetch,
			timeout: false,
		});
		if (!response.ok && endpoint === "invoke-with-response-stream")
			responseBody = await response.text().catch(() => "");
	} finally {
		// Cleared once headers (or a finite error body) arrive: an absolute
		// deadline would keep aborting an actively streaming body. Stream
		// liveness belongs to the event iterator's idle watchdog.
		watchdog.clear();
	}
	return { response, responseBody };
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

/**
 * AWS's own regional host, which every bundled catalog entry carries as a required
 * placeholder `baseUrl` — no routing info, so its region segment is re-derived.
 * FIPS, VPC-endpoint and gateway hosts don't match and are used as configured.
 */
const AWS_REGIONAL_BEDROCK_HOST = /^bedrock-runtime\.[a-z0-9-]+\.amazonaws\.com$/;

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
	toolSpec: { name: string; description?: string; inputSchema: { json: unknown } };
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
	requestMetadata?: Record<string, string>;
	additionalModelResponseFieldPaths?: string[];
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
	additionalModelResponseFields?: unknown;
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

const REQUEST_METADATA_MAX_ENTRIES = 16;

/**
 * Bedrock rejects the whole invocation on a malformed `requestMetadata` entry.
 * Attribution tags must never cost a turn, so invalid and excess entries are
 * dropped with a warning instead of failing the request. Returns `undefined`
 * for an empty result so the field is omitted from the body entirely.
 */
function sanitizeRequestMetadata(raw: unknown): Record<string, string> | undefined {
	if (!isRecord(raw)) return undefined;
	const out: Record<string, string> = {};
	const dropped: string[] = [];
	let kept = 0;
	for (const [key, value] of Object.entries(raw)) {
		if (
			typeof value !== "string" ||
			key.length < 1 ||
			!isBedrockRequestMetadataValue(key) ||
			!isBedrockRequestMetadataValue(value) ||
			kept >= REQUEST_METADATA_MAX_ENTRIES
		) {
			dropped.push(key);
			continue;
		}
		out[key] = value;
		kept++;
	}
	if (dropped.length > 0) logger.warn("Bedrock requestMetadata entries dropped", { keys: dropped });
	return kept > 0 ? out : undefined;
}

/** Shared across events: every payload decode is a complete, non-streaming call. */
const PAYLOAD_DECODER = new TextDecoder();
type BedrockAnthropicStreamEvent = RawMessageStreamEvent | { type: "ping" };

const ANTHROPIC_STREAM_EVENT_TYPES: Record<string, true> = {
	message_start: true,
	content_block_start: true,
	content_block_delta: true,
	content_block_stop: true,
	message_delta: true,
	message_stop: true,
};

function isAnthropicStreamEvent(value: unknown): value is RawMessageStreamEvent {
	return isRecord(value) && typeof value.type === "string" && Object.hasOwn(ANTHROPIC_STREAM_EVENT_TYPES, value.type);
}

/**
 * Anthropic Messages stream events carried in InvokeModelWithResponseStream
 * `chunk` frames (base64 event JSON). Exception frames throw with the status
 * their AWS shape maps to; a stream that ends before `message_stop` is truncated.
 */
async function* decodeBedrockAnthropicEvents(
	body: ReadableStream<Uint8Array>,
): AsyncGenerator<BedrockAnthropicStreamEvent> {
	for await (const frame of decodeEventStream(body)) {
		const messageType = frame.headers[":message-type"];
		if (messageType === "exception") {
			const code = frame.headers[":exception-type"] || "Exception";
			const payload = safeParsePayload(frame.payload);
			const message =
				isRecord(payload) && typeof payload.message === "string"
					? payload.message
					: PAYLOAD_DECODER.decode(frame.payload);
			throw new AIError.BedrockApiError(`${code}: ${message}`, bedrockStreamExceptionStatus(code), { code });
		}
		if (messageType === "error") {
			const code = frame.headers[":error-code"] || "UnknownError";
			const message = frame.headers[":error-message"] || PAYLOAD_DECODER.decode(frame.payload);
			throw new AIError.BedrockApiError(`${code}: ${message}`, bedrockStreamExceptionStatus(code), { code });
		}
		const eventType = frame.headers[":event-type"];
		if (messageType !== "event") continue;
		if (eventType === "ping") {
			yield { type: "ping" };
			continue;
		}
		if (eventType !== "chunk") continue;
		const chunk = safeParsePayload(frame.payload);
		if (!isRecord(chunk) || typeof chunk.bytes !== "string") {
			throw new AIError.AnthropicStreamEnvelopeError(
				"Bedrock stream chunk did not contain encoded Anthropic event bytes",
			);
		}
		let event: unknown;
		try {
			event = JSON.parse(PAYLOAD_DECODER.decode(Buffer.from(chunk.bytes, "base64")));
		} catch (error) {
			throw new AIError.AnthropicStreamEnvelopeError(
				`Bedrock stream chunk contained invalid Anthropic event JSON: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
		if (isRecord(event) && event.type === "ping") {
			yield { type: "ping" };
			continue;
		}
		if (!isRecord(event) || typeof event.type !== "string") {
			throw new AIError.AnthropicStreamEnvelopeError(
				"Bedrock stream chunk contained an invalid Anthropic event envelope",
			);
		}
		if (!isAnthropicStreamEvent(event)) continue;
		yield event;
		if (event.type === "message_stop") return;
	}
	throw new AIError.AnthropicStreamEnvelopeError("Bedrock InvokeModelWithResponseStream ended before message_stop");
}

async function prepareBedrockAnthropicCompactionRequest(
	model: Model<"bedrock-converse-stream">,
	options: BedrockOptions,
	base: URL,
	params: MessageCreateParamsStreaming,
	betas: readonly string[],
): Promise<{ payload: unknown; rawRequestDump: RawHttpRequestDump }> {
	const { anthropic_beta: bodyBetas, ...requestFields } = params;
	const body: Record<string, unknown> = { ...requestFields };
	delete body.model;
	delete body.stream;
	let payload: unknown = {
		...body,
		anthropic_version: "bedrock-2023-05-31",
		anthropic_beta: Array.from(
			new Set([
				...betas,
				...(params.thinking !== undefined &&
				"block_binding" in params.thinking &&
				params.thinking.block_binding !== undefined
					? [THINKING_BINDING_CONTROLS_BETA]
					: []),
				...(options.reasoning !== undefined &&
				options.interleavedThinking &&
				model.thinking?.mode !== "anthropic-adaptive" &&
				model.thinking?.mode !== "effort"
					? [BEDROCK_INTERLEAVED_THINKING_BETA]
					: []),
				...(bodyBetas ?? []),
			]),
		),
	};
	const replacement = await options.onPayload?.(payload, model);
	if (replacement !== undefined) payload = replacement;
	fitBedrockAnthropicPayload(payload);
	const { url } = resolveBedrockRequestUrl(model, base, "invoke-with-response-stream");
	return {
		payload,
		rawRequestDump: {
			provider: model.provider,
			api: model.api,
			model: model.id,
			method: "POST",
			url,
			body: payload,
		},
	};
}

function createBedrockAnthropicCompactionClient(
	model: Model<"bedrock-converse-stream">,
	options: BedrockOptions,
	region: string,
	base: URL,
	getPayload: () => unknown,
): AnthropicMessagesClientLike {
	return {
		messages: {
			create(_params: MessageCreateParams, requestOptions?: AnthropicRequestOptions) {
				return {
					withResponse: async () => {
						const input = getPayload();
						if (input === undefined) {
							throw new AIError.AnthropicStreamEnvelopeError("Bedrock compaction request body was not prepared");
						}
						const sent = await sendBedrockRequest(
							model,
							options,
							region,
							base,
							input,
							"invoke-with-response-stream",
							requestOptions?.signal ?? options.signal,
						);
						if (!sent.response.ok) {
							if (
								!resolveBearerToken(options) &&
								(sent.response.status === 401 || sent.response.status === 403)
							) {
								invalidateAwsCredentialCache({ profile: options.profile, region });
							}
							throw new AIError.BedrockApiError(
								`Bedrock HTTP ${sent.response.status}: ${(sent.responseBody ?? "").slice(0, 1000)}`,
								sent.response.status,
								{ headers: sent.response.headers },
							);
						}
						if (!sent.response.body) {
							throw new AIError.BedrockApiError("Bedrock response has no body", sent.response.status);
						}
						return {
							data: decodeBedrockAnthropicEvents(sent.response.body),
							response: sent.response,
							request_id:
								sent.response.headers.get("x-amzn-requestid") ?? sent.response.headers.get("x-amzn-request-id"),
						};
					},
				};
			},
		},
	};
}

export const streamBedrock: StreamFunction<"bedrock-converse-stream"> = (
	model: Model<"bedrock-converse-stream">,
	context: Context,
	options: BedrockOptions,
): AssistantMessageEventStream => {
	if (options.anthropicCompaction !== undefined && supportsBedrockConverseCompaction(model)) {
		let requestLocation: { region: string; base: URL } | undefined;
		const getRequestLocation = (): { region: string; base: URL } => {
			if (!requestLocation) {
				const region = resolveBedrockRegion(model.id, options);
				requestLocation = { region, base: resolveBedrockBaseUrl(model, region) };
			}
			return requestLocation;
		};
		return streamBedrockAnthropicCompaction(
			model,
			context,
			options,
			(params, betas) => {
				const { base } = getRequestLocation();
				return prepareBedrockAnthropicCompactionRequest(model, options, base, params, betas);
			},
			getPayload => {
				const { region, base } = getRequestLocation();
				return createBedrockAnthropicCompactionClient(model, options, region, base, getPayload);
			},
			anthropicOptions => {
				const reasoning = options.reasoning;
				const reasoningLevel = reasoning === undefined ? undefined : requireSupportedEffort(model, reasoning);
				const effort = reasoning === undefined ? undefined : mapEffortToAnthropicAdaptiveEffort(model, reasoning);
				const thinkingBudgetTokens =
					reasoningLevel !== undefined &&
					model.thinking?.mode !== "anthropic-adaptive" &&
					model.thinking?.mode !== "effort"
						? (options.thinkingBudgets?.[reasoningLevel] ?? DEFAULT_BEDROCK_THINKING_BUDGETS[reasoningLevel])
						: undefined;
				return {
					...anthropicOptions,
					thinkingEnabled: reasoning !== undefined,
					...(effort !== undefined ? { effort } : {}),
					...(thinkingBudgetTokens !== undefined ? { thinkingBudgetTokens } : {}),
				};
			},
			options.reasoning === undefined ? buildAdditionalModelRequestFields(model, options) : undefined,
		);
	}
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
		const contentIndexByBlockIndex = new Map<number, number>();
		let rawRequestDump: RawHttpRequestDump | undefined;
		const region = resolveBedrockRegion(model.id, options);

		try {
			const base = resolveBedrockBaseUrl(model, region);
			const bearerToken = resolveBearerToken(options);

			const cacheRetention = resolveCacheRetention(options.cacheRetention);
			const promptCachePolicy = resolvePromptCachePolicy(model, cacheRetention);
			const convertedMessages = convertMessages(context, model, promptCachePolicy);
			const toolPlan = planToolConfig(context.tools, options.toolChoice, convertedMessages);
			let toolConfig = toolPlan.toolConfig;
			const sentinelInjected = toolPlan.sentinelInjected;
			let additionalModelRequestFields = buildAdditionalModelRequestFields(model, options);
			const thinkingDisabled =
				isRecord(additionalModelRequestFields?.thinking) &&
				additionalModelRequestFields.thinking.type === "disabled";
			const prefixMismatchBehavior =
				!thinkingDisabled && model.thinking?.prefixBinding && model.compat.supportsThinkingBindingControls
					? (options.anthropicPrefixMismatchBehavior ?? "drop_block")
					: undefined;

			// Some models (Opus/Sonnet 5.5) reject forced tool use outright; keep the
			// tools offered under `auto` and leave thinking intact.
			const forcedChoice = toolConfig?.toolChoice?.any || toolConfig?.toolChoice?.tool;
			if (toolConfig && forcedChoice && !model.compat.supportsForcedToolChoice) {
				toolConfig = { ...toolConfig, toolChoice: { auto: {} } };
			} else if (toolConfig && forcedChoice && !thinkingDisabled) {
				// Bedrock rejects thinking + forced tool_choice. Prefix-bound lines (Fable)
				// think adaptively even when no thinking field is sent, so downgrade their
				// forced choice regardless of the binding controls; elsewhere drop thinking.
				if (model.thinking?.prefixBinding) toolConfig = { ...toolConfig, toolChoice: { auto: {} } };
				else additionalModelRequestFields = undefined;
			}
			if (prefixMismatchBehavior) {
				additionalModelRequestFields = applyBedrockThinkingBinding(
					additionalModelRequestFields,
					prefixMismatchBehavior,
				);
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
				requestMetadata:
					model.requestMetadata || options.requestMetadata
						? { ...model.requestMetadata, ...options.requestMetadata }
						: undefined,
				...(prefixMismatchBehavior ? { additionalModelResponseFieldPaths: ["/input_transformations"] } : {}),
			};
			const replacementInput = await options?.onPayload?.(commandInput, model);
			if (replacementInput !== undefined) commandInput = replacementInput as ConverseStreamRequest;
			// After the hook so extension-injected tags are validated too, and before the
			// raw dump so the inspector shows exactly what was sent.
			commandInput = { ...commandInput, requestMetadata: sanitizeRequestMetadata(commandInput.requestMetadata) };

			let prefixBindingRetryAttempted = false;
			let response: Response;
			while (true) {
				rawRequestDump = {
					provider: model.provider,
					api: output.api,
					model: model.id,
					method: "POST",
					url: resolveBedrockRequestUrl(model, base, "converse-stream").url,
					body: commandInput,
				};
				({ response } = await sendBedrockRequest(model, options, region, base, commandInput, "converse-stream"));
				if (response.ok) break;
				if (!bearerToken && (response.status === 401 || response.status === 403)) {
					// Stale cached credentials (e.g. rotated session keys in ~/.aws/credentials) —
					// drop the cache entry so the next attempt re-resolves from scratch.
					invalidateAwsCredentialCache({ profile: options.profile, region });
				}
				const errBody = await response.text().catch(() => "");
				const errorMessage = `Bedrock HTTP ${response.status}: ${errBody.slice(0, 1000)}`;
				if (
					!prefixBindingRetryAttempted &&
					options.anthropicPrefixMismatchBehavior !== "error" &&
					isThinkingPrefixBindingError(errorMessage)
				) {
					prefixBindingRetryAttempted = true;
					logger.warn("bedrock: thinking prefix changed, stripping bound thinking and retrying", {
						provider: model.provider,
						model: model.id,
						baseUrl: base.origin,
					});
					commandInput = {
						...commandInput,
						messages: dropBedrockReasoningContent(commandInput.messages),
					};
					continue;
				}
				throw new AIError.BedrockApiError(errorMessage, response.status, {
					headers: response.headers,
				});
			}
			if (!response.body) throw new AIError.BedrockApiError("Bedrock response has no body", response.status);

			// Track first event for the abort/diagnostic path (currently informational).
			for await (const message of decodeEventStream(response.body)) {
				const messageType = message.headers[":message-type"];
				const eventType = message.headers[":event-type"];

				if (messageType === "exception") {
					const exceptionType = message.headers[":exception-type"] || "Exception";
					const payload = safeParsePayload(message.payload) as { message?: string } | undefined;
					const errorMessage = payload?.message || PAYLOAD_DECODER.decode(message.payload);
					const text = `${exceptionType}: ${errorMessage}`;
					throw new AIError.BedrockApiError(text, bedrockStreamExceptionStatus(exceptionType), {
						code: exceptionType,
					});
				}
				if (messageType === "error") {
					const code = message.headers[":error-code"] || "UnknownError";
					const errorMessage = message.headers[":error-message"] || PAYLOAD_DECODER.decode(message.payload);
					throw new AIError.BedrockApiError(`${code}: ${errorMessage}`, bedrockStreamExceptionStatus(code), {
						code,
					});
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
						handleContentBlockStart(
							payload as ContentBlockStartEvent,
							blocks,
							contentIndexByBlockIndex,
							output,
							stream,
							sentinelInjected,
						);
						break;
					}
					case "contentBlockDelta": {
						if (!firstTokenTime) firstTokenTime = performance.now();
						handleContentBlockDelta(
							payload as ContentBlockDeltaEvent,
							blocks,
							contentIndexByBlockIndex,
							output,
							stream,
						);
						break;
					}
					case "contentBlockStop": {
						handleContentBlockStop(
							payload as ContentBlockStopEvent,
							blocks,
							contentIndexByBlockIndex,
							output,
							stream,
						);
						break;
					}
					case "messageStop": {
						const ev = payload as MessageStopEvent;
						const responseFields = isRecord(ev.additionalModelResponseFields)
							? ev.additionalModelResponseFields
							: undefined;
						const transformations = parseAnthropicInputTransformations(responseFields?.input_transformations);
						if (transformations.length > 0) {
							output.inputTransformations = transformations;
							logDroppedThinking(
								"bedrock",
								model.id,
								transformations
									.filter(transformation => transformation.reason === "prefix_binding_mismatch")
									.map(transformation => transformation.path),
							);
						}
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

			for (const [contentBlockIndex, index] of contentIndexByBlockIndex) {
				const block = blocks[index];
				if (block?.type === "toolCall" && block[kStreamingPartialJson] !== undefined) {
					handleContentBlockStop({ contentBlockIndex }, blocks, contentIndexByBlockIndex, output, stream);
				}
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
		return JSON.parse(PAYLOAD_DECODER.decode(payload));
	} catch {
		return undefined;
	}
}

/**
 * Append a streamed block and index it by Bedrock's `contentBlockIndex`, so
 * per-delta routing is an O(1) lookup instead of a scan over every block
 * (quadratic over a long turn). The first block registered for an index wins,
 * as the first-match scan did. Returns the block's content index.
 */
function pushStreamBlock(
	blocks: Block[],
	contentIndexByBlockIndex: Map<number, number>,
	block: Block,
	contentBlockIndex: number,
): number {
	const contentIndex = blocks.length;
	blocks.push(block);
	if (!contentIndexByBlockIndex.has(contentBlockIndex)) contentIndexByBlockIndex.set(contentBlockIndex, contentIndex);
	return contentIndex;
}

function handleContentBlockStart(
	event: ContentBlockStartEvent,
	blocks: Block[],
	contentIndexByBlockIndex: Map<number, number>,
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
		const contentIndex = pushStreamBlock(blocks, contentIndexByBlockIndex, block, index);
		stream.push({ type: "toolcall_start", contentIndex, partial: output });
	}
}

function handleContentBlockDelta(
	event: ContentBlockDeltaEvent,
	blocks: Block[],
	contentIndexByBlockIndex: Map<number, number>,
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
): void {
	const contentBlockIndex = event.contentBlockIndex;
	const delta = event.delta;
	let index = contentIndexByBlockIndex.get(contentBlockIndex) ?? -1;
	let block = blocks[index];

	if (delta?.text !== undefined) {
		// If no text block exists yet, create one — `handleContentBlockStart` is not sent for text blocks
		if (!block) {
			const newBlock: Block = { type: "text", text: "", [kStreamingBlockIndex]: contentBlockIndex };
			index = pushStreamBlock(blocks, contentIndexByBlockIndex, newBlock, contentBlockIndex);
			block = newBlock;
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
			thinkingIndex = pushStreamBlock(blocks, contentIndexByBlockIndex, newBlock, contentBlockIndex);
			thinkingBlock = newBlock;
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
		calculateCost(model, output.usage, output.timestamp);
	}
}

function handleContentBlockStop(
	event: ContentBlockStopEvent,
	blocks: Block[],
	contentIndexByBlockIndex: Map<number, number>,
	output: AssistantMessage,
	stream: AssistantMessageEventStream,
): void {
	const index = contentIndexByBlockIndex.get(event.contentBlockIndex) ?? -1;
	const block = blocks[index];
	if (!block) return;

	switch (block.type) {
		case "text":
			stream.push({ type: "text_end", contentIndex: index, content: block.text, partial: output });
			break;
		case "thinking":
			// Claude on Bedrock carries Anthropic's signature format, narration kind included.
			if (block.thinkingSignature && isAnthropicNarrationSignature(block.thinkingSignature)) block.narration = true;
			stream.push({ type: "thinking_end", contentIndex: index, content: block.thinking, partial: output });
			break;
		case "toolCall":
			block.arguments = parseToolCallArguments(block[kStreamingPartialJson]);
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
		// This emitter has only two placement sites (final user and system); the
		// provider's wire-level maximum remains authoritative in catalog compat.
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

function buildToolResultBlock(
	message: ToolResultMessage,
	model: Model<"bedrock-converse-stream">,
	hoistedImages: ImageBlockWire[],
): ToolResultBlockWire {
	const content: Array<TextBlockWire | ImageBlockWire> = [];
	// Bedrock's Anthropic Claude models reject an error toolResult that carries a
	// non-text block ("all content must be type `text` if `is_error` is true"),
	// so images inside an error result must always be hoisted out regardless of
	// the model's requiresToolResultImageHoisting flag (no `class "anthropic"`
	// rule sets it). Mirrors anthropic.ts buildToolResultBlock. Re-serializing a
	// previously-persisted poisoned result on a later turn repairs it in place.
	const hoistImages = message.isError || model.requiresToolResultImageHoisting;
	for (const block of message.content) {
		if (block.type === "image") {
			const image: ImageBlockWire = { image: createImageBlock(block.mimeType, block.data) };
			if (hoistImages) {
				content.push({ text: "(see attached image)" });
				hoistedImages.push(image);
			} else {
				content.push(image);
			}
		} else {
			content.push({ text: block.text.toWellFormed() });
		}
	}
	return {
		toolResult: {
			toolUseId: normalizeToolCallId(message.toolCallId),
			content,
			status: message.isError ? "error" : "success",
		},
	};
}

function convertMessages(
	context: Context,
	model: Model<"bedrock-converse-stream">,
	promptCachePolicy: BedrockPromptCachePolicy,
): WireMessage[] {
	const result: WireMessage[] = [];
	const transformedMessages = transformMessages(context.messages, model, id => normalizeToolCallId(id));

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
							// Hidden thinking has empty display text but a load-bearing signature.
							if (c.thinking.trim().length === 0 && !c.thinkingSignature) continue;
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
				const contentBlocks: UserContent[] = [];
				const hoistedImages: ImageBlockWire[] = [];
				contentBlocks.push(buildToolResultBlock(m, model, hoistedImages));

				let j = i + 1;
				while (j < transformedMessages.length && transformedMessages[j].role === "toolResult") {
					const nextMsg = transformedMessages[j] as ToolResultMessage;
					contentBlocks.push(buildToolResultBlock(nextMsg, model, hoistedImages));
					j++;
				}
				i = j - 1;

				contentBlocks.push(...hoistedImages);
				result.push({ role: "user", content: contentBlocks });
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

function dropBedrockReasoningContent(messages: WireMessage[]): WireMessage[] {
	const filtered: WireMessage[] = [];
	for (const message of messages) {
		if (message.role !== "assistant") {
			filtered.push(message);
			continue;
		}
		const content = message.content.filter(block => !("reasoningContent" in block));
		if (content.length > 0) filtered.push({ ...message, content });
	}
	return filtered;
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
			// Descriptions may be pruned into the system prompt. Bedrock permits
			// omission, but rejects an explicitly empty description (minLength: 1).
			description: tool.description || undefined,
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

function applyBedrockThinkingBinding(
	fields: Record<string, unknown> | undefined,
	behavior: "drop_block" | "error",
): Record<string, unknown> {
	const result = { ...fields };
	const thinking: Record<string, unknown> = isRecord(result.thinking) ? { ...result.thinking } : { type: "adaptive" };
	thinking.block_binding = { prefix_mismatch_behavior: behavior };
	result.thinking = thinking;
	const betas = Array.isArray(result.anthropic_beta)
		? result.anthropic_beta.filter((beta): beta is string => typeof beta === "string")
		: [];
	if (!betas.includes(THINKING_BINDING_CONTROLS_BETA)) {
		betas.push(THINKING_BINDING_CONTROLS_BETA);
	}
	result.anthropic_beta = betas;
	return result;
}

const DEFAULT_BEDROCK_THINKING_BUDGETS: Record<Effort, number> = {
	minimal: 1024,
	low: 2048,
	medium: 8192,
	high: 16384,
	xhigh: 32768,
	max: 32768,
};

function buildAdditionalModelRequestFields(
	model: Model<"bedrock-converse-stream">,
	options: BedrockOptions,
): Record<string, unknown> | undefined {
	const reasoning = options.reasoning;
	if (!model.reasoning) return undefined;
	if (!reasoning) {
		if (model.compat.disabledThinking === "disabled") {
			return { thinking: { type: "disabled" }, output_config: { effort: "low" } };
		}
		return undefined;
	}

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
	const budget = options.thinkingBudgets?.[level] ?? DEFAULT_BEDROCK_THINKING_BUDGETS[level];

	const result: Record<string, unknown> = {
		thinking: {
			type: "enabled",
			budget_tokens: budget,
			display: options.thinkingDisplay ?? "summarized",
		},
	};

	if (options.interleavedThinking) {
		result.anthropic_beta = [BEDROCK_INTERLEAVED_THINKING_BETA];
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
