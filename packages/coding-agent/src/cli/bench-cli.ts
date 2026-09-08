import type { ResolvedThinkingLevel } from "@oh-my-pi/pi-agent-core";
import type {
	Api,
	ApiKeyResolver,
	AssistantMessage,
	AssistantMessageEvent,
	Context,
	Effort,
	Model,
	ProviderSessionState,
	ServiceTier,
	ServiceTierByFamily,
} from "@oh-my-pi/pi-ai";
import { resolveModelServiceTier, streamSimple } from "@oh-my-pi/pi-ai";
import { replaceTabs, truncateToWidth } from "@oh-my-pi/pi-tui";
import { formatDuration, formatNumber, prompt } from "@oh-my-pi/pi-utils";
import chalk from "@oh-my-pi/pi-utils/chalk";
import { formatModelSelectorValue, formatModelString } from "../config/model-resolver";
import { buildServiceTierByFamily, serviceTierForAllFamilies, serviceTierSettingToTier } from "../config/service-tier";
import cachePrefixTemplate from "../prompts/bench/cache-prefix.md" with { type: "text" };
import cachePrefixChunk from "../prompts/bench/cache-prefix-chunk.md" with { type: "text" };
import cacheSuffixTemplate from "../prompts/bench/cache-suffix.md" with { type: "text" };
import chatTemplate from "../prompts/bench/chat.md" with { type: "text" };
import generationTemplate from "../prompts/bench/generation.md" with { type: "text" };
import prefillInstruction from "../prompts/bench/prefill-instruction.md" with { type: "text" };
import { shouldDisableReasoning, toReasoningEffort } from "../thinking";
import {
	type BenchRuntime,
	type BenchTarget,
	createDefaultBenchRuntime,
	resolveBenchTargets,
	type StreamSimpleFn,
} from "./bench-runtime";
import { createLiveBoard, type LiveBoardOutput } from "./live-board";

const DEFAULT_PAR = 4;
const DEFAULT_CACHE_MAX_TOKENS = 64;
const DEFAULT_CACHE_PREFIX_BYTES = 8_192;
const DEFAULT_CACHE_PAIRS = 1;
const DEFAULT_CACHE_CONCURRENCY = 1;
const DEFAULT_PREFILL_BYTES = 32_768;
const ERROR_WIDTH = 110;
const UTF8_ENCODER = new TextEncoder();
const UTF8_DECODER = new TextDecoder();
const CACHE_PREFIX_CHUNK = cachePrefixChunk;
const CACHE_PREFIX_PLACEHOLDER = "__OMP_CACHE_BENCH_RAW_PREFIX__";
const CACHE_PREFIX_CHUNK_BYTES = UTF8_ENCODER.encode(CACHE_PREFIX_CHUNK).byteLength;
const RESPONSE_CACHE_STATUS_HEADERS = ["cf-aig-cache-status"] as const;

/**
 * One built-in workload a bench run exercises:
 * - `chat`: balanced prompt/output — the everyday latency + throughput picture.
 * - `prefill`: large cache-busted input, tiny output — isolates input-token
 *   processing (TTFT and prefill tok/s).
 * - `generation`: tiny prompt, long forced output — isolates sustained decode
 *   throughput.
 */
export type BenchChallengeKind = "chat" | "prefill" | "generation";

/** `mix` (the default) rotates through every challenge kind; a kind name isolates one. */
export type BenchProfile = "mix" | BenchChallengeKind;

const CHALLENGE_KINDS = ["chat", "prefill", "generation"] as const;

/** Default max output tokens per challenge kind (`--max-tokens` overrides all). */
const CHALLENGE_MAX_TOKENS: Record<BenchChallengeKind, number> = { chat: 512, prefill: 64, generation: 2048 };

/** Default requests per model; mix needs a multiple of the kind count. */
const PROFILE_DEFAULT_RUNS: Record<BenchProfile, number> = { mix: 9, chat: 10, prefill: 5, generation: 5 };

/** Chat-challenge topics; one is drawn at random per run so runs never repeat a request. */
const CHAT_TOPICS = [
	"how a web browser turns an HTML payload into pixels on screen",
	"how a garbage collector reclaims memory in a managed runtime",
	"how TCP congestion control adapts to packet loss",
	"how a B-tree index accelerates database lookups",
	"how DNS resolves a hostname to an IP address",
	"how an operating system scheduler shares a CPU between processes",
	"how public-key cryptography secures a TLS handshake",
	"how a compiler lowers source code to optimized machine code",
	"how a CPU cache hierarchy hides memory latency",
	"how a distributed consensus protocol keeps replicas consistent",
] as const;

/** Generation-challenge topics; long, low-ambiguity narrations that sustain decoding. */
const GENERATION_TOPICS = [
	"the history of computing",
	"the history of aviation",
	"the history of astronomy",
	"the history of railways",
	"the history of medicine",
	"the history of telecommunications",
	"the history of cartography",
	"the history of shipbuilding",
] as const;

export interface BenchCommandArgs {
	models: string[];
	flags: {
		runs?: number;
		maxTokens?: number;
		prompt?: string;
		/** Service-tier setting value (`none` omits); overrides the configured `serviceTier` setting. */
		serviceTier?: string;
		json?: boolean;
		par?: number;
		/** Benchmark workload: `mix` (default) rotates challenge kinds; a kind name isolates one. */
		profile?: string;
		/** Synthetic input size for prefill challenges (default: 32768 bytes). */
		prefillBytes?: number;
		cache?: boolean;
		cachePrefixFile?: string;
		cachePrefixBytes?: number;
		cachePairs?: number;
		cacheConcurrency?: number;
	};
}

export interface BenchRunSuccess {
	ok: true;
	/** Challenge kind this run exercised; absent in `--cache` mode. */
	challenge?: BenchChallengeKind;
	/** Request start → first streamed token: queue + prefill window. */
	ttftMs: number;
	/** First streamed token → done: decode window (0 when the response arrived buffered). */
	generationMs: number;
	durationMs: number;
	/** Total prompt tokens: `usage.input` plus cache reads/writes (providers report cached prompt tokens outside `input`). */
	inputTokens: number;
	outputTokens: number;
	/** Output tokens/sec over the total request duration. */
	tokensPerSecond: number;
	/**
	 * Output tokens/sec over the decode window. Inflated on providers that hide
	 * reasoning until completion (tiny decode window); 0 for fully buffered
	 * responses. Compare `tokensPerSecond` for a buffering-proof number.
	 */
	generationTps: number;
	/** Prompt tokens/sec over the TTFT window (queue-inclusive prefill rate). */
	prefillTps: number;
	/** Priced cost of the request; 0 when pricing is unavailable. */
	cost: number;
}

export interface BenchRunFailure {
	ok: false;
	/** Challenge kind this run exercised; absent in `--cache` mode. */
	challenge?: BenchChallengeKind;
	error: string;
}

export type BenchRunResult = BenchRunSuccess | BenchRunFailure;

export type CacheObservation =
	| "prompt_cache_read_observed"
	| "prompt_cache_write_observed"
	| "response_cache_hit_observed"
	| "no_provider_proof";

export interface BenchCacheUsage {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	totalTokens: number;
	cost: number;
}

export interface BenchCacheRunReport {
	phase: "cold" | "warm";
	result: BenchRunResult;
	usage?: BenchCacheUsage;
	requestIdObserved: boolean;
	observations: CacheObservation[];
}

export interface BenchCachePairReport {
	cold: BenchCacheRunReport;
	warm: BenchCacheRunReport;
	/** The nominal cold request showed cache reuse, so it is not a true cold baseline. */
	coldAlreadyWarm: boolean;
	/** Structural-only comparisons: prompt text and cache keys are never emitted. */
	stablePrefix: true;
	suffixChanged: true;
	promptCacheKeyStable: true;
	statefulResponsesDisabled: true;
	freshProviderSessionState: true;
	/** "unavailable" when a transport does not expose the provider payload locally. */
	payloadStructureStable: boolean | "unavailable";
}

/** Distribution summary over successful runs. */
export interface MetricStats {
	mean: number;
	min: number;
	/** Median (nearest-rank). */
	p50: number;
	/** 95th percentile (nearest-rank). */
	p95: number;
	max: number;
}

/** Aggregates over successful runs. */
export interface BenchStats {
	ttftMs: MetricStats;
	durationMs: MetricStats;
	tokensPerSecond: MetricStats;
	generationTps: MetricStats;
	prefillTps: MetricStats;
	/** Mean input tokens per successful run. */
	inputTokens: number;
	/** Mean output tokens per successful run. */
	outputTokens: number;
	/** Mean priced cost per successful run; 0 when pricing is unavailable. */
	cost: number;
}

export interface BenchModelReport {
	/** Selector as the user typed it (e.g. "opus" or "gemini-3.5:low"). */
	selector: string;
	/** Resolved `provider/id`. */
	model: string;
	/** Explicit thinking level from a `:level` selector suffix; undefined = provider default. */
	thinking?: ResolvedThinkingLevel;
	results: BenchRunResult[];
	/** Aggregates over successful runs; null when every run failed. */
	stats: BenchStats | null;
	/** Aggregates per challenge kind; empty in `--cache` mode. */
	byChallenge: Partial<Record<BenchChallengeKind, BenchStats>>;
	cachePairs?: BenchCachePairReport[];
}

export interface BenchSummary {
	runs: number;
	/** Explicit `--max-tokens` override (cache mode: resolved value); absent when per-challenge defaults apply. */
	maxTokens?: number;
	/** Benchmark workload; absent in `--cache` mode. */
	profile?: BenchProfile;
	models: BenchModelReport[];
	failures: number;
	/** Requested per-family service tiers, resolved per model before reaching the wire. */
	serviceTierByFamily?: ServiceTierByFamily;
	cache?: {
		pairs: number;
		concurrency: number;
	};
}

export interface BenchDependencies {
	createRuntime?: () => Promise<BenchRuntime>;
	randomSessionId?: () => string;
	writeStdout?: (text: string) => void;
	writeStderr?: (text: string) => void;
	setExitCode?: (code: number) => void;
	streamSimple?: StreamSimpleFn;
	now?: () => number;
	/** Uniform [0,1) source for challenge randomization; default `Math.random`. */
	random?: () => number;
	readTextFile?: (path: string, maxBytes: number) => Promise<string>;
	stdoutIsTTY?: boolean;
}

function getErrorMessage(error: unknown): string {
	if (error instanceof Error && error.message) return error.message;
	return String(error);
}

function normalizePositiveInteger(name: string, value: number | undefined, fallback: number): number {
	if (value === undefined) return fallback;
	if (!Number.isInteger(value) || value <= 0) {
		throw new Error(`Expected --${name} to be a positive integer, got ${value}`);
	}
	return value;
}

function closeProviderSessionStates(providerSessionState: Map<string, ProviderSessionState>): void {
	for (const state of providerSessionState.values()) {
		state.close();
	}
	providerSessionState.clear();
}

function isFirstTokenEvent(event: AssistantMessageEvent): boolean {
	switch (event.type) {
		case "text_delta":
		case "thinking_delta":
		case "toolcall_delta":
			return event.delta.length > 0;
		case "text_end":
		case "thinking_end":
			return event.content.length > 0;
		case "image_end":
			return true;
		default:
			return false;
	}
}

/** Final message carries visible output — non-empty text/thinking, an image, or a tool call. */
function hasVisibleFinalContent(message: AssistantMessage): boolean {
	return message.content.some(block => {
		switch (block.type) {
			case "text":
				return block.text.length > 0;
			case "thinking":
				return block.thinking.length > 0;
			case "image":
			case "redactedThinking":
			case "toolCall":
				return true;
			default:
				return false;
		}
	});
}

interface CacheRequestCapture {
	payloadStructure?: string;
	requestIdObserved: boolean;
	responseCacheHit: boolean;
	usage?: BenchCacheUsage;
}

function payloadStructure(payload: unknown): string {
	if (payload === null) return "null";
	if (Array.isArray(payload)) return `[${payload.map(payloadStructure).join(",")}]`;
	if (typeof payload === "object") {
		const record = payload as Record<string, unknown>;
		return `{${Object.keys(record)
			.sort()
			.map(key => `${key}:${payloadStructure(record[key])}`)
			.join(",")}}`;
	}
	return typeof payload;
}

function asNonNegativeNumber(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}
/** Nearest-rank distribution summary; `values` MUST be non-empty. */
function metricStats(values: number[]): MetricStats {
	const sorted = [...values].sort((a, b) => a - b);
	const at = (q: number): number =>
		sorted[Math.max(0, Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1))]!;
	return {
		mean: sorted.reduce((sum, value) => sum + value, 0) / sorted.length,
		min: sorted[0]!,
		p50: at(0.5),
		p95: at(0.95),
		max: sorted[sorted.length - 1]!,
	};
}

function mean(values: number[]): number {
	return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function captureUsage(message: AssistantMessage): BenchCacheUsage {
	const usage = message.usage;
	return {
		inputTokens: asNonNegativeNumber(usage.input),
		outputTokens: asNonNegativeNumber(usage.output),
		cacheReadTokens: asNonNegativeNumber(usage.cacheRead),
		cacheWriteTokens: asNonNegativeNumber(usage.cacheWrite),
		totalTokens: asNonNegativeNumber(usage.totalTokens),
		cost: asNonNegativeNumber(usage.cost?.total),
	};
}

function cacheObservations(capture: CacheRequestCapture): CacheObservation[] {
	const observations: CacheObservation[] = [];
	if ((capture.usage?.cacheReadTokens ?? 0) > 0) observations.push("prompt_cache_read_observed");
	if ((capture.usage?.cacheWriteTokens ?? 0) > 0) observations.push("prompt_cache_write_observed");
	if (capture.responseCacheHit) observations.push("response_cache_hit_observed");
	return observations.length > 0 ? observations : ["no_provider_proof"];
}

function cacheRunReport(
	phase: BenchCacheRunReport["phase"],
	result: BenchRunResult,
	capture: CacheRequestCapture,
): BenchCacheRunReport {
	return {
		phase,
		result,
		usage: capture.usage,
		requestIdObserved: capture.requestIdObserved,
		observations: cacheObservations(capture),
	};
}

function truncateUtf8ByteLength(bytes: Uint8Array, maxBytes: number): number {
	const end = Math.min(bytes.byteLength, maxBytes);
	if (end === 0) return 0;

	let sequenceStart = end - 1;
	while (sequenceStart > 0 && (bytes[sequenceStart]! & 0b1100_0000) === 0b1000_0000) sequenceStart--;

	const leadingByte = bytes[sequenceStart]!;
	const sequenceLength =
		leadingByte <= 0b0111_1111
			? 1
			: leadingByte >= 0b1100_0010 && leadingByte <= 0b1101_1111
				? 2
				: leadingByte >= 0b1110_0000 && leadingByte <= 0b1110_1111
					? 3
					: leadingByte >= 0b1111_0000 && leadingByte <= 0b1111_0100
						? 4
						: 1;
	return sequenceLength > end - sequenceStart ? sequenceStart : end;
}

async function readBoundedUtf8File(path: string, maxBytes: number): Promise<string> {
	const file = Bun.file(path);
	const bytes = new Uint8Array(await file.slice(0, maxBytes).arrayBuffer());
	const end = truncateUtf8ByteLength(bytes, maxBytes);
	return UTF8_DECODER.decode(bytes.subarray(0, end));
}

function truncateUtf8(text: string, maxBytes: number): string {
	const bytes = UTF8_ENCODER.encode(text);
	const end = truncateUtf8ByteLength(bytes, maxBytes);
	return end === bytes.byteLength ? text : UTF8_DECODER.decode(bytes.subarray(0, end));
}

function generatedCachePrefix(bytes: number): string {
	return truncateUtf8(CACHE_PREFIX_CHUNK.repeat(Math.ceil(bytes / CACHE_PREFIX_CHUNK_BYTES)), bytes);
}

function renderCacheBenchmarkPrefix(prefix: string, namespace: string): string {
	const rendered = prompt.render(cachePrefixTemplate, {
		prefix: CACHE_PREFIX_PLACEHOLDER,
		namespace,
	});
	if (!rendered.includes(CACHE_PREFIX_PLACEHOLDER)) {
		throw new Error("Cache benchmark prefix template is missing its raw prefix placeholder");
	}
	// Render the static wrapper first, then inject caller bytes so prompt
	// normalization cannot trim spaces or collapse blank lines in prefix files.
	// Function replacer: a prefix containing `$&`/`$'`/`` $` `` must not be
	// expanded as a string-replacement pattern.
	return rendered.replace(CACHE_PREFIX_PLACEHOLDER, () => prefix);
}

async function resolveCachePrefix(
	flags: BenchCommandArgs["flags"],
	readTextFile: (path: string, maxBytes: number) => Promise<string>,
): Promise<string> {
	const bytes = normalizePositiveInteger("cache-prefix-bytes", flags.cachePrefixBytes, DEFAULT_CACHE_PREFIX_BYTES);
	const prefix = flags.cachePrefixFile
		? await readTextFile(flags.cachePrefixFile, bytes)
		: generatedCachePrefix(bytes);
	return truncateUtf8(prefix, bytes);
}

function cacheBenchmarkMessages(stablePrefix: string, suffix: string): Context["messages"] {
	const timestamp = Date.now();
	return [
		{ role: "user", content: stablePrefix, timestamp, attribution: "user" },
		{ role: "user", content: suffix, timestamp, attribution: "user" },
	];
}
/** One concrete bench request: kind, output budget, and randomized messages. */
interface BenchChallenge {
	kind: BenchChallengeKind;
	maxTokens: number;
	messages: Context["messages"];
}

interface BenchChallengeOptions {
	/** Replaces the built-in prompt (chat/generation only). */
	promptOverride?: string;
	/** Synthetic input size for prefill challenges. */
	prefillBytes: number;
	/** Per-run unique token; leads the prefill body so provider prefix caches can never reuse an earlier run's prefill. */
	nonce: string;
	/** Uniform [0,1) source for topic selection. */
	random: () => number;
	/** Explicit `--max-tokens`; overrides the kind default. */
	maxTokensOverride?: number;
}

/** Build a randomized challenge so repeated runs never send a byte-identical request. */
function buildBenchChallenge(kind: BenchChallengeKind, opts: BenchChallengeOptions): BenchChallenge {
	const maxTokens = opts.maxTokensOverride ?? CHALLENGE_MAX_TOKENS[kind];
	const pick = (topics: readonly string[]): string => topics[Math.floor(opts.random() * topics.length)] ?? topics[0]!;
	const user = (content: string): Context["messages"] => [
		{ role: "user", content, timestamp: Date.now(), attribution: "user" },
	];
	switch (kind) {
		case "chat":
			return {
				kind,
				maxTokens,
				messages: user(opts.promptOverride ?? prompt.render(chatTemplate, { topic: pick(CHAT_TOPICS) }).trim()),
			};
		case "generation":
			return {
				kind,
				maxTokens,
				messages: user(
					opts.promptOverride ?? prompt.render(generationTemplate, { topic: pick(GENERATION_TOPICS) }).trim(),
				),
			};
		case "prefill":
			return {
				kind,
				maxTokens,
				messages: user(
					`Benchmark run ${opts.nonce}.\n\n${generatedCachePrefix(opts.prefillBytes)}\n\n${opts.promptOverride ?? prefillInstruction.trim()}`,
				),
			};
	}
}

async function runWithConcurrency<T>(
	count: number,
	concurrency: number,
	run: (index: number) => Promise<T>,
): Promise<T[]> {
	// oxlint-disable-next-line unicorn/no-new-array -- length preallocation
	const results = new Array<T>(count);
	let next = 0;
	const worker = async (): Promise<void> => {
		while (next < count) {
			const index = next++;
			results[index] = await run(index);
		}
	};
	await Promise.all(Array.from({ length: Math.min(count, concurrency) }, worker));
	return results;
}

function formatCost(cost: number): string {
	if (cost < 0.01) return `$${cost.toFixed(4)}`;
	if (cost < 1) return `$${cost.toFixed(3)}`;
	return `$${cost.toFixed(2)}`;
}

function formatCachePairLine(pair: BenchCachePairReport, index: number, total: number): string {
	const formatPhase = (run: BenchCacheRunReport, alreadyWarm = false) => {
		if (!run.result.ok) {
			return `${run.phase} failed: ${truncateToWidth(replaceTabs(run.result.error), ERROR_WIDTH)}`;
		}
		const usage = run.usage;
		return `${run.phase}${alreadyWarm ? " (already warm)" : ""} ${run.observations.join(", ")} ${chalk.dim("input")} ${usage?.inputTokens ?? 0} ${chalk.dim("cache-read")} ${usage?.cacheReadTokens ?? 0} ${chalk.dim("cache-write")} ${usage?.cacheWriteTokens ?? 0} ${chalk.dim("output")} ${usage?.outputTokens ?? run.result.outputTokens} ${chalk.dim("total")} ${usage?.totalTokens ?? 0} ${chalk.dim("cost")} ${formatCost(usage?.cost ?? 0)} ${chalk.dim("TTFT")} ${formatMs(run.result.ttftMs)} ${chalk.dim("duration")} ${formatMs(run.result.durationMs)} ${chalk.dim("throughput")} ${run.result.tokensPerSecond.toFixed(1)}/s`;
	};
	return `  ${chalk.dim(`pair ${index + 1}/${total}`)} ${formatPhase(pair.cold, pair.coldAlreadyWarm)}; ${formatPhase(pair.warm)}`;
}

interface BenchRequestOptions {
	apiKey: ApiKeyResolver;
	sessionId: string;
	/** Native OMP messages; cache mode splits the stable prefix from the suffix. */
	messages: Context["messages"];
	maxTokens: number;
	/** Explicit effort from a `:level` selector suffix; absent = provider default. */
	reasoning?: Effort;
	/** Only set for an explicit `:off` suffix — some endpoints reject disablement. */
	disableReasoning?: boolean;
	/** Requested service tier passed to `streamSimple`; absent omits the option. The provider layer applies scope/support gating before it reaches the wire. */
	serviceTier?: ServiceTier;
	promptCacheKey?: string;
	statefulResponses?: false;
	cacheCapture?: CacheRequestCapture;
}

async function runBenchRequest(
	model: Model<Api>,
	options: BenchRequestOptions,
	streamFn: StreamSimpleFn,
	now: () => number,
): Promise<BenchRunResult> {
	const startedAt = now();
	let firstTokenAt: number | undefined;
	const providerSessionState = new Map<string, ProviderSessionState>();
	try {
		const context: Context = {
			// Codex's Responses endpoint 400s with "Instructions are required" when no
			// system prompt is present — same guard as eval's completion bridge.
			systemPrompt: ["You are a helpful assistant."],
			messages: options.messages,
		};
		const stream = streamFn(model, context, {
			apiKey: options.apiKey,
			sessionId: options.sessionId,
			maxTokens:
				model.maxTokens !== null && Number.isFinite(model.maxTokens) && model.maxTokens > 0
					? Math.min(options.maxTokens, model.maxTokens)
					: options.maxTokens,
			reasoning: options.reasoning,
			promptCacheKey: options.promptCacheKey,
			statefulResponses: options.statefulResponses,
			onPayload: options.cacheCapture
				? payload => {
						options.cacheCapture!.payloadStructure = payloadStructure(payload);
						return undefined;
					}
				: undefined,
			onResponse: options.cacheCapture
				? response => {
						options.cacheCapture!.requestIdObserved = Boolean(response.requestId);
						options.cacheCapture!.responseCacheHit = RESPONSE_CACHE_STATUS_HEADERS.some(
							header => response.headers[header]?.trim().toLowerCase() === "hit",
						);
					}
				: undefined,
			disableReasoning: options.disableReasoning,
			serviceTier: options.serviceTier,
			providerSessionState,
			preferWebsockets: true,
			// pi-ai opts every OpenRouter request into response caching (1h TTL).
			// Bench sends a byte-identical request each run, so within the TTL
			// OpenRouter replays the cached generation with zeroed usage — the run
			// shows "tokens 0, TPS 0.0" at line speed. Opt back out so every run
			// measures a fresh generation.
			headers: model.provider === "openrouter" ? { "X-OpenRouter-Cache": "false" } : undefined,
		});
		let message: AssistantMessage | undefined;
		for await (const event of stream) {
			if (firstTokenAt === undefined && isFirstTokenEvent(event)) {
				firstTokenAt = now();
			}
			if (event.type === "error") {
				return { ok: false, error: event.error.errorMessage ?? "request failed" };
			}
			if (event.type === "done") {
				message = event.message;
			}
		}
		message ??= await stream.result();
		if (message.stopReason === "error" || message.errorMessage) {
			return { ok: false, error: message.errorMessage ?? "request failed" };
		}
		const rawDuration = message.duration ?? now() - startedAt;
		const durationMs = Number.isFinite(rawDuration) && rawDuration > 0 ? rawDuration : 0;
		const rawTtft = message.ttft ?? (firstTokenAt === undefined ? durationMs : firstTokenAt - startedAt);
		const ttftMs = Number.isFinite(rawTtft) && rawTtft > 0 ? rawTtft : 0;
		const outputTokens = Number.isFinite(message.usage.output) && message.usage.output > 0 ? message.usage.output : 0;
		// A run that streamed no content (no delta/end event set firstTokenAt),
		// carries no visible final content, and measured no output tokens
		// benchmarked nothing — a genuinely empty stream (e.g. a gateway that 200s
		// with an empty body). Surface it as a failure instead of a misleading
		// 0-token "✓". Streaming and buffered providers that produce content keep
		// passing even when usage is omitted.
		if (firstTokenAt === undefined && outputTokens === 0 && !hasVisibleFinalContent(message)) {
			return {
				ok: false,
				error: `provider returned no output (0 tokens, empty stream; stop reason: ${message.stopReason ?? "unknown"})`,
			};
		}
		if (options.cacheCapture) options.cacheCapture.usage = captureUsage(message);
		// Providers report cache-written/read prompt tokens outside `usage.input`
		// (e.g. Anthropic auto-caching moves nearly the whole prompt into
		// cacheWrite), so total prompt size must sum all three.
		const inputTokens =
			asNonNegativeNumber(message.usage.input) +
			asNonNegativeNumber(message.usage.cacheRead) +
			asNonNegativeNumber(message.usage.cacheWrite);
		const generationMs = Math.max(0, durationMs - ttftMs);
		return {
			ok: true,
			ttftMs,
			generationMs,
			durationMs,
			inputTokens,
			outputTokens,
			// TPS over the TOTAL request duration, deliberately not the post-TTFT
			// decode window: reasoning models can spend seconds generating hidden
			// thinking tokens (counted in usage.output) before the first visible
			// byte, so "duration - TTFT" inflates TPS several-fold on providers
			// that buffer or hide reasoning (e.g. google vs google-vertex).
			tokensPerSecond: durationMs > 0 ? (outputTokens * 1000) / durationMs : 0,
			generationTps: generationMs > 0 ? (outputTokens * 1000) / generationMs : 0,
			prefillTps: ttftMs > 0 ? (inputTokens * 1000) / ttftMs : 0,
			cost: asNonNegativeNumber(message.usage.cost?.total),
		};
	} catch (error) {
		return { ok: false, error: getErrorMessage(error) };
	} finally {
		closeProviderSessionStates(providerSessionState);
	}
}

function buildModelReport(
	selector: string,
	model: Model<Api>,
	thinking: ResolvedThinkingLevel | undefined,
	results: BenchRunResult[],
): BenchModelReport {
	const successes = results.filter((result): result is BenchRunSuccess => result.ok);
	const byChallenge: BenchModelReport["byChallenge"] = {};
	for (const kind of CHALLENGE_KINDS) {
		const kindRuns = successes.filter(r => r.challenge === kind);
		if (kindRuns.length > 0) byChallenge[kind] = computeBenchStats(kindRuns);
	}
	return {
		selector,
		model: formatModelString(model),
		thinking,
		results,
		stats: successes.length === 0 ? null : computeBenchStats(successes),
		byChallenge,
	};
}
function computeBenchStats(successes: BenchRunSuccess[]): BenchStats {
	return {
		ttftMs: metricStats(successes.map(r => r.ttftMs)),
		durationMs: metricStats(successes.map(r => r.durationMs)),
		tokensPerSecond: metricStats(successes.map(r => r.tokensPerSecond)),
		generationTps: metricStats(successes.map(r => r.generationTps)),
		prefillTps: metricStats(successes.map(r => r.prefillTps)),
		inputTokens: mean(successes.map(r => r.inputTokens)),
		outputTokens: mean(successes.map(r => r.outputTokens)),
		cost: mean(successes.map(r => r.cost)),
	};
}

function formatBenchModelLabel(report: BenchModelReport): string {
	return formatModelSelectorValue(report.model, report.thinking);
}

function formatMs(ms: number): string {
	return formatDuration(Math.max(0, Math.round(ms)));
}

function formatRunLine(result: BenchRunResult, index: number, total: number): string {
	const prefix = chalk.dim(`run ${index + 1}/${total}`);
	const kind = result.challenge ? `${chalk.cyan(result.challenge.padEnd(10))} ` : "";
	if (result.ok) {
		const gen = result.generationTps > 0 ? `${result.generationTps.toFixed(1)}/s` : "-";
		return `  ${chalk.green("✓")} ${prefix} ${kind}${chalk.dim("TTFT")} ${formatMs(result.ttftMs)} ${chalk.dim("tok/s")} ${result.tokensPerSecond.toFixed(1)} ${chalk.dim("gen")} ${gen} ${chalk.dim("in")} ${formatNumber(result.inputTokens)} ${chalk.dim("out")} ${formatNumber(result.outputTokens)} ${chalk.dim("total")} ${formatMs(result.durationMs)}`;
	}
	return `  ${chalk.red("✗")} ${prefix} ${kind}${chalk.red(truncateToWidth(replaceTabs(result.error).replace(/\r?\n/g, " "), ERROR_WIDTH))}`;
}
/** Mutable per-model progress backing the live status line. */
interface BenchLiveProgress {
	label: string;
	unit: "runs" | "pairs";
	total: number;
	completed: number;
	failed: number;
	inFlight: number;
	okCount: number;
	ttftSumMs: number;
	tpsSum: number;
}

function renderBenchProgress(progress: BenchLiveProgress | undefined, spinner: string): string[] {
	if (!progress || progress.completed >= progress.total) return [];
	const parts = [`${progress.completed}/${progress.total} ${progress.unit}`];
	if (progress.inFlight > 0) parts.push(`${progress.inFlight} in flight`);
	if (progress.failed > 0) parts.push(chalk.red(`${progress.failed} failed`));
	if (progress.okCount > 0) {
		parts.push(`TTFT ~${formatMs(progress.ttftSumMs / progress.okCount)}`);
		parts.push(`~${(progress.tpsSum / progress.okCount).toFixed(1)} tok/s`);
	}
	return [
		`  ${chalk.yellow(spinner)} ${chalk.bold(progress.label)}${chalk.dim(" · ")}${parts.join(chalk.dim(" · "))}`,
	];
}

interface BenchTableColumn {
	header: string;
	value(report: BenchModelReport): string;
}

function benchTableColumns(models: BenchModelReport[]): BenchTableColumn[] {
	const has = (kind: BenchChallengeKind): boolean => models.some(report => report.byChallenge[kind] !== undefined);
	// Chat runs carry the representative latency; fall back to overall stats
	// for single-kind profiles and cache mode.
	const ttft = (report: BenchModelReport): MetricStats | undefined =>
		(report.byChallenge.chat ?? report.stats ?? undefined)?.ttftMs;
	const columns: BenchTableColumn[] = [
		{ header: "model", value: formatBenchModelLabel },
		{ header: "TTFT p50", value: r => (ttft(r) ? formatMs(ttft(r)!.p50) : "-") },
		{ header: "p95", value: r => (ttft(r) ? formatMs(ttft(r)!.p95) : "-") },
	];
	if (has("chat")) {
		columns.push({
			header: "tok/s",
			value: r => (r.byChallenge.chat ? r.byChallenge.chat.tokensPerSecond.p50.toFixed(1) : "-"),
		});
	}
	if (has("generation")) {
		columns.push({
			header: "decode",
			value: r => (r.byChallenge.generation ? r.byChallenge.generation.tokensPerSecond.p50.toFixed(1) : "-"),
		});
	}
	if (has("prefill")) {
		columns.push({
			header: "prefill",
			value: r => (r.byChallenge.prefill ? r.byChallenge.prefill.prefillTps.p50.toFixed(0) : "-"),
		});
	}
	columns.push({ header: "cost/run", value: r => (r.stats && r.stats.cost > 0 ? formatCost(r.stats.cost) : "-") });
	return columns;
}

/**
 * Ranked comparison table over model reports: one headline column per
 * challenge kind present (`tok/s` chat, `decode` generation, `prefill`
 * ingest rate); the winner's model cell is highlighted. Medians (not means)
 * so one queue hiccup cannot reorder rows.
 */
export function formatBenchTable(summary: BenchSummary): string {
	const rank = (report: BenchModelReport): number =>
		report.byChallenge.chat?.tokensPerSecond.p50 ??
		report.byChallenge.generation?.tokensPerSecond.p50 ??
		report.byChallenge.prefill?.prefillTps.p50 ??
		report.stats?.tokensPerSecond.p50 ??
		Number.NEGATIVE_INFINITY;
	const ranked = [...summary.models].sort((a, b) => rank(b) - rank(a));
	const columns = benchTableColumns(summary.models);
	const rows = ranked.map(report => ({
		cells: columns.map(column => column.value(report)),
		failed: report.results.filter(result => !result.ok).length,
		hasStats: report.stats !== null,
	}));
	const widths = columns.map((column, index) =>
		Math.max(column.header.length, ...rows.map(row => row.cells[index]!.length)),
	);
	const lines = [
		chalk.dim(
			columns
				.map((column, i) => column.header.padEnd(widths[i]!))
				.join("  ")
				.trimEnd(),
		),
	];
	let winnerMarked = false;
	for (const row of rows) {
		const cells = row.cells.map((cell, i) => cell.padEnd(widths[i]!));
		if (!winnerMarked && row.hasStats) {
			cells[0] = chalk.green(cells[0]!);
			winnerMarked = true;
		}
		const failedSuffix = row.failed > 0 ? `  ${chalk.red(`(${row.failed} failed)`)}` : "";
		lines.push(cells.join("  ").trimEnd() + failedSuffix);
	}
	return `${lines.join("\n")}\n`;
}

function assertCacheModeSupported(targets: BenchTarget[]): void {
	if (targets.some(({ model }) => model.api === "openai-codex-responses")) {
		throw new Error(
			"--cache is not supported for openai-codex-responses because Codex WebSocket chaining cannot produce independent prompt-cache pairs",
		);
	}
}

export async function runBenchCommand(command: BenchCommandArgs, deps: BenchDependencies = {}): Promise<BenchSummary> {
	const cacheMode = command.flags.cache === true;
	const cacheFlagsUsed =
		command.flags.cachePrefixFile !== undefined ||
		command.flags.cachePrefixBytes !== undefined ||
		command.flags.cachePairs !== undefined ||
		command.flags.cacheConcurrency !== undefined;
	if (!cacheMode && cacheFlagsUsed) throw new Error("Cache flags require --cache");
	if (cacheMode && command.flags.runs !== undefined)
		throw new Error("Use --cache-pairs instead of --runs with --cache");
	if (cacheMode && command.flags.prompt !== undefined) throw new Error("--cache builds its own stable-prefix prompts");
	if (cacheMode && command.flags.profile !== undefined) throw new Error("--profile cannot be combined with --cache");
	if (cacheMode && (command.flags.par ?? 1) > 1) {
		throw new Error("--par cannot parallelize cold/warm pairs; use --cache-concurrency instead");
	}
	const profileFlag = command.flags.profile;
	if (
		profileFlag !== undefined &&
		profileFlag !== "mix" &&
		profileFlag !== "chat" &&
		profileFlag !== "prefill" &&
		profileFlag !== "generation"
	) {
		throw new Error(`Unknown --profile "${profileFlag}" (expected mix, chat, prefill, or generation)`);
	}
	const profile: BenchProfile = profileFlag ?? "mix";
	if (!cacheMode && command.flags.prompt !== undefined && profile !== "chat" && profile !== "generation") {
		throw new Error("--prompt requires --profile chat or generation");
	}
	if (command.flags.prefillBytes !== undefined && (cacheMode || (profile !== "mix" && profile !== "prefill"))) {
		throw new Error("--prefill-bytes requires prefill challenges (--profile mix or prefill)");
	}

	const cachePairs = cacheMode
		? normalizePositiveInteger("cache-pairs", command.flags.cachePairs, DEFAULT_CACHE_PAIRS)
		: undefined;
	const cacheConcurrency = cacheMode
		? normalizePositiveInteger("cache-concurrency", command.flags.cacheConcurrency, DEFAULT_CACHE_CONCURRENCY)
		: undefined;
	const runs = cacheMode
		? cachePairs! * 2
		: normalizePositiveInteger("runs", command.flags.runs, PROFILE_DEFAULT_RUNS[profile]);
	const maxTokensOverride =
		command.flags.maxTokens !== undefined
			? normalizePositiveInteger("max-tokens", command.flags.maxTokens, 1)
			: undefined;
	const cacheMaxTokens = cacheMode ? (maxTokensOverride ?? DEFAULT_CACHE_MAX_TOKENS) : undefined;
	const par =
		command.flags.par !== undefined ? normalizePositiveInteger("par", command.flags.par, DEFAULT_PAR) : DEFAULT_PAR;
	const promptOverride = command.flags.prompt?.trim() || undefined;
	const prefillBytes = normalizePositiveInteger("prefill-bytes", command.flags.prefillBytes, DEFAULT_PREFILL_BYTES);
	const kinds: readonly BenchChallengeKind[] = profile === "mix" ? CHALLENGE_KINDS : [profile];
	const random = deps.random ?? Math.random;
	const json = command.flags.json === true;
	const randomSessionId = deps.randomSessionId ?? (() => Bun.randomUUIDv7());
	const readTextFile = deps.readTextFile ?? readBoundedUtf8File;
	const cachePrefix = cacheMode ? await resolveCachePrefix(command.flags, readTextFile) : undefined;
	const writeStdout = deps.writeStdout ?? ((text: string) => process.stdout.write(text));
	const writeStderr = deps.writeStderr ?? ((text: string) => process.stderr.write(text));
	const setExitCode =
		deps.setExitCode ??
		((code: number) => {
			process.exitCode = code;
		});
	const streamFn = deps.streamSimple ?? streamSimple;
	const now = deps.now ?? (() => performance.now());
	const interactive = deps.stdoutIsTTY ?? process.stdout.isTTY === true;
	if (command.models.length === 0) {
		throw new Error("Pass at least one model selector, e.g. `omp bench opus gpt-5.2`");
	}
	let progress: BenchLiveProgress | undefined;
	const board = json
		? undefined
		: createLiveBoard(spinner => renderBenchProgress(progress, spinner), {
				isTTY: interactive,
				get columns() {
					return process.stdout.columns;
				},
				get rows() {
					return process.stdout.rows;
				},
				write(text: string): boolean {
					writeStdout(text);
					return true;
				},
			} satisfies LiveBoardOutput);
	const print = (text: string): void => {
		if (board) board.log(text);
		else writeStdout(`${text}\n`);
	};

	const runtime = await (deps.createRuntime ?? createDefaultBenchRuntime)();
	try {
		const targets = resolveBenchTargets(command.models, runtime.modelRegistry, runtime.settings, writeStderr);
		if (cacheMode) assertCacheModeSupported(targets);
		// Explicit `--service-tier` (a single value broadcast across families) wins;
		// otherwise fall back to the configured per-family `tier.*` settings. Each
		// model resolves its own family's tier below before reaching the wire.
		const flagTier = command.flags.serviceTier ? serviceTierSettingToTier(command.flags.serviceTier) : undefined;
		const serviceTierByFamily = command.flags.serviceTier
			? serviceTierForAllFamilies(flagTier)
			: buildServiceTierByFamily(
					runtime.settings?.get("tier.openai") ?? "none",
					runtime.settings?.get("tier.anthropic") ?? "none",
					runtime.settings?.get("tier.google") ?? "none",
				);
		if (!json && flagTier) print(chalk.dim(`service tier: ${flagTier}`));
		const reports: BenchModelReport[] = [];
		for (const { selector, model, thinking } of targets) {
			if (!json) {
				const resolvedModel = formatModelSelectorValue(formatModelString(model), thinking);
				const resolvedNote = selector === resolvedModel ? "" : chalk.dim(` (${selector})`);
				print(`${chalk.bold(resolvedModel)}${resolvedNote}`);
				progress = {
					label: resolvedModel,
					unit: cacheMode ? "pairs" : "runs",
					total: cacheMode ? cachePairs! : runs,
					completed: 0,
					failed: 0,
					inFlight: 0,
					okCount: 0,
					ttftSumMs: 0,
					tpsSum: 0,
				};
				board?.repaint();
			}
			const results: BenchRunResult[] = [];

			// Preflight check: let's verify credentials before starting any runs.
			// This matches the old sequential break behavior exactly and avoids launching/printing
			// multiple failures.
			const testSessionId = randomSessionId();
			const preflightKey = await runtime.modelRegistry.getApiKey(model, testSessionId);
			if (!preflightKey) {
				const failure: BenchRunFailure = {
					ok: false,
					error: `No credentials for provider "${model.provider}". Run \`omp\` and use /login, or set the provider API key.`,
				};
				results.push(failure);
				if (!json) print(formatRunLine(failure, 0, runs));
				progress = undefined;
				board?.repaint();
				const report = buildModelReport(selector, model, thinking, results);
				if (cacheMode) report.cachePairs = [];
				reports.push(report);
				continue;
			}

			const serviceTier = resolveModelServiceTier(serviceTierByFamily, model);
			if (cacheMode) {
				const pairs = await runWithConcurrency(
					cachePairs!,
					cacheConcurrency!,
					async (pairIndex): Promise<BenchCachePairReport> => {
						const cacheNamespace = randomSessionId();
						if (progress) {
							progress.inFlight++;
							board?.repaint();
						}
						const promptCacheKey = `bench-cache:${cacheNamespace}`;
						const stablePrefix = renderCacheBenchmarkPrefix(cachePrefix!, cacheNamespace);
						const coldSuffix = prompt.render(cacheSuffixTemplate, { variant: "A" }).trim();
						const warmSuffix = prompt.render(cacheSuffixTemplate, { variant: "B" }).trim();
						const coldCapture: CacheRequestCapture = {
							requestIdObserved: false,
							responseCacheHit: false,
						};
						// Keep the gateway's credential selection stable for both phases.
						// Provider-session state is still recreated by runBenchRequest and
						// stateful Responses chaining is disabled below.
						const credentialAffinitySessionId = pairIndex === 0 ? testSessionId : randomSessionId();
						const credentialResolver = runtime.modelRegistry.resolver(model, credentialAffinitySessionId);
						const coldResult = await runBenchRequest(
							model,
							{
								apiKey: credentialResolver,
								sessionId: credentialAffinitySessionId,
								messages: cacheBenchmarkMessages(stablePrefix, coldSuffix),
								maxTokens: cacheMaxTokens!,
								reasoning: toReasoningEffort(thinking),
								disableReasoning: shouldDisableReasoning(thinking) ? true : undefined,
								serviceTier,
								promptCacheKey,
								statefulResponses: false,
								cacheCapture: coldCapture,
							},
							streamFn,
							now,
						);
						const warmCapture: CacheRequestCapture = {
							requestIdObserved: false,
							responseCacheHit: false,
						};
						const warmResult = await runBenchRequest(
							model,
							{
								apiKey: credentialResolver,
								sessionId: credentialAffinitySessionId,
								messages: cacheBenchmarkMessages(stablePrefix, warmSuffix),
								maxTokens: cacheMaxTokens!,
								reasoning: toReasoningEffort(thinking),
								disableReasoning: shouldDisableReasoning(thinking) ? true : undefined,
								serviceTier,
								promptCacheKey,
								statefulResponses: false,
								cacheCapture: warmCapture,
							},
							streamFn,
							now,
						);
						if (progress) {
							progress.inFlight--;
							progress.completed++;
							for (const result of [coldResult, warmResult]) {
								if (result.ok) {
									progress.okCount++;
									progress.ttftSumMs += result.ttftMs;
									progress.tpsSum += result.tokensPerSecond;
								} else {
									progress.failed++;
								}
							}
							board?.repaint();
						}
						return {
							cold: cacheRunReport("cold", coldResult, coldCapture),
							warm: cacheRunReport("warm", warmResult, warmCapture),
							coldAlreadyWarm: (coldCapture.usage?.cacheReadTokens ?? 0) > 0 || coldCapture.responseCacheHit,
							stablePrefix: true,
							suffixChanged: true,
							promptCacheKeyStable: true,
							statefulResponsesDisabled: true,
							freshProviderSessionState: true,
							payloadStructureStable:
								coldCapture.payloadStructure === undefined || warmCapture.payloadStructure === undefined
									? "unavailable"
									: coldCapture.payloadStructure === warmCapture.payloadStructure,
						};
					},
				);
				for (const pair of pairs) results.push(pair.cold.result, pair.warm.result);
				const report = buildModelReport(selector, model, thinking, results);
				report.cachePairs = pairs;
				reports.push(report);
				if (!json) {
					for (const [index, pair] of pairs.entries()) {
						print(formatCachePairLine(pair, index, pairs.length));
					}
				}
				continue;
			}

			// We will launch up to `par` workers/requests concurrently.
			// To keep output clean, non-JSON output emits entries in correct index order.
			let nextToPrint = 0;
			const runWorker = async (index: number) => {
				const sessionId = index === 0 ? testSessionId : randomSessionId();
				const challenge = buildBenchChallenge(kinds[index % kinds.length]!, {
					promptOverride,
					prefillBytes,
					nonce: randomSessionId(),
					random,
					maxTokensOverride,
				});
				const result = await runBenchRequest(
					model,
					{
						apiKey: runtime.modelRegistry.resolver(model, sessionId),
						sessionId,
						messages: challenge.messages,
						maxTokens: challenge.maxTokens,
						reasoning: toReasoningEffort(thinking),
						disableReasoning: shouldDisableReasoning(thinking) ? true : undefined,
						serviceTier,
					},
					streamFn,
					now,
				);
				results[index] = { ...result, challenge: challenge.kind };
			};
			const queue = Array.from({ length: runs }, (_, i) => i);
			const activeWorkers: Promise<void>[] = [];
			const processNext = async (): Promise<void> => {
				if (queue.length === 0) return;
				const index = queue.shift()!;
				if (progress) {
					progress.inFlight++;
					board?.repaint();
				}
				await runWorker(index);
				if (progress) {
					progress.inFlight--;
					progress.completed++;
					const result = results[index]!;
					if (result.ok) {
						progress.okCount++;
						progress.ttftSumMs += result.ttftMs;
						progress.tpsSum += result.tokensPerSecond;
					} else {
						progress.failed++;
					}
					board?.repaint();
				}
				if (!json) {
					while (nextToPrint < runs && results[nextToPrint] !== undefined) {
						print(formatRunLine(results[nextToPrint], nextToPrint, runs));
						nextToPrint++;
					}
				}
				await processNext();
			};
			for (let worker = 0; worker < Math.min(par, runs); worker++) activeWorkers.push(processNext());
			await Promise.all(activeWorkers);
			reports.push(buildModelReport(selector, model, thinking, results));
		}
		const failures = reports.reduce((sum, report) => sum + report.results.filter(result => !result.ok).length, 0);
		const summary: BenchSummary = {
			runs,
			...(cacheMode
				? { maxTokens: cacheMaxTokens }
				: maxTokensOverride !== undefined
					? { maxTokens: maxTokensOverride }
					: {}),
			models: reports,
			failures,
			serviceTierByFamily,
			...(cacheMode ? { cache: { pairs: cachePairs!, concurrency: cacheConcurrency! } } : { profile }),
		};
		progress = undefined;
		if (json) {
			writeStdout(`${JSON.stringify(summary, null, 2)}\n`);
		} else if (!cacheMode && (reports.length > 1 || runs > 1)) {
			print(`\n${formatBenchTable(summary)}`.trimEnd());
		}
		if (failures > 0) setExitCode(1);
		return summary;
	} finally {
		board?.close();
		runtime.close?.();
	}
}
