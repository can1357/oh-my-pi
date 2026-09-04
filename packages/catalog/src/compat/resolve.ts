/**
 * `resolveModelPolicy` — the single model-policy resolver. Layering, later
 * layers win:
 *
 *   1. unconditional per-API compat defaults;
 *   2. host-derived flags: URL/provider detection via `hosts.ts`, including
 *      compound host×identity branches (keyed on {@link ModelIdentity} fields,
 *      never on model-name matching);
 *   3. compat-cascade axes compiled from `rules/` (pure identity- and
 *      provider-keyed policy lives there, not here);
 *   4. spec-authored sparse overrides (`applyCompatOverrides`), then the
 *      spec-undefined fixups the legacy builders applied.
 *
 * Thinking metadata resolves after compat: explicit spec thinking wins,
 * cascade thinking axes drive the ladder/mode/wire facts, and identity-generic
 * fallbacks cover unmatched targets.
 */
import { Effort, THINKING_EFFORTS } from "../effort";
import { hostMatchesUrl, modelMatchesHost } from "../hosts";
import type {
	Api,
	CompatOf,
	ModelSpec,
	OpenAICompat,
	ResolvedAnthropicCompat,
	ResolvedBedrockCompat,
	ResolvedDevinCompat,
	ResolvedGoogleCompat,
	ResolvedOpenAICompat,
	ResolvedOpenAIResponsesCompat,
	ResolvedOpenAISharedCompat,
	ThinkingConfig,
} from "../types";
import { isAnthropicSigningProxyUrl, isAzureAnthropicRoute, isOfficialAnthropicApiUrl } from "./anthropic";
import { applyCompatOverrides } from "./apply";
import { API_COMPAT_RECORDS, AXES, type CompatRecordName } from "./axes";
import { resolveCascade } from "./cascade";
import { compareRevision, parseRevision, type Revision } from "./revision";
import { classifyModel, stripThinkingVariantSuffix } from "./taxonomy";
import type { ModelIdentity, ResolvedAxes, ResolveTarget } from "./types";

/** Result of resolving one model spec through the compat engine. */
export interface ResolvedModelPolicy<TApi extends Api = Api> {
	identity: ModelIdentity;
	compat: CompatOf<TApi>;
	thinking: ThinkingConfig | undefined;
	/** Catalog-data axis assignments (longContext, priority, …) for generation. */
	catalog: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Identity facts — every check reads ModelIdentity fields, never id strings.
// ---------------------------------------------------------------------------

/** Structured identity plus revision comparison helpers. */
class IdentityFacts {
	readonly revision: Revision | undefined;

	constructor(readonly identity: ModelIdentity) {
		this.revision = identity.revision === undefined ? undefined : parseRevision(identity.revision);
	}

	is(cls: string): boolean {
		return this.identity.class === cls;
	}

	family(...families: string[]): boolean {
		return this.identity.family !== undefined && families.includes(this.identity.family);
	}

	revGte(min: string): boolean {
		if (!this.revision) return false;
		const bound = parseRevision(min);
		return bound !== undefined && compareRevision(this.revision, bound) >= 0;
	}

	revMajor(): number | undefined {
		return this.revision?.[0];
	}

	/** Kimi K2.7-Code / K3 lines whose native hosts mandate enabled thinking. */
	get kimiMandatoryThinking(): boolean {
		return this.is("kimi") && this.family("k2.7-code", "k3");
	}

	/** Adaptive-thinking Claude generation floor (Opus ≥ min; Sonnet/Fable/Mythos ≥ 5). */
	anthropicAdaptiveGenAtLeast(opusMin: string): boolean {
		if (!this.is("anthropic")) return false;
		if (this.family("opus")) return this.revGte(opusMin);
		if (this.family("sonnet", "fable", "mythos")) return this.revGte("5");
		return false;
	}
}

function resolveIdentity<TApi extends Api>(spec: ModelSpec<TApi>): ModelIdentity {
	// Strict on purpose: ambiguous identity is a rule-authoring defect surfaced
	// at build/CI time, never silently degraded to `unknown`. Discovery
	// normalization opts into leniency through `classifyModel` directly.
	return classifyModel(spec.provider, spec.id);
}

// ---------------------------------------------------------------------------
// Axis application
// ---------------------------------------------------------------------------

interface AxisKeyInfo {
	records: readonly CompatRecordName[];
}

let keyRecords: Record<string, AxisKeyInfo> | undefined;

function getKeyRecords(): Record<string, AxisKeyInfo> {
	if (!keyRecords) {
		keyRecords = {};
		for (const directive in AXES) {
			const axis = AXES[directive];
			if (axis.set === "wire" && axis.records) {
				keyRecords[axis.key] = { records: axis.records };
			}
		}
	}
	return keyRecords;
}

/**
 * Assigns resolved wire axes onto a freshly-detected compat record. An axis
 * lands only when the model's API maps to one of the axis's declared records
 * — the axes table is the single applicability authority, so optional keys
 * absent from the detected baseline still land.
 */
function applyWireAxes(compat: object, wire: Record<string, unknown>, api: Api): void {
	const records = API_COMPAT_RECORDS[api];
	if (!records) return;
	const info = getKeyRecords();
	for (const key in wire) {
		const meta = info[key];
		if (!meta?.records.some(record => records.includes(record))) continue;
		Reflect.set(compat, key, wire[key]);
	}
}
/**
 * Preserves legacy per-key merge semantics for map-valued effort remaps: a
 * cascade-provided `reasoningEffortMap` is the detected base and sparse spec
 * overrides overlay it key by key (spec keys win, unseen keys survive).
 */
function overlayEffortMapAxis(
	compat: { reasoningEffortMap: Partial<Record<Effort, string>> },
	axes: ResolvedAxes,
	specCompat: OpenAICompat | undefined,
): void {
	const axisMap = effortRecord(axes.wire.reasoningEffortMap);
	if (axisMap && specCompat?.reasoningEffortMap) {
		compat.reasoningEffortMap = { ...axisMap, ...specCompat.reasoningEffortMap };
	}
}

function effortList(value: unknown): readonly Effort[] | undefined {
	if (!Array.isArray(value) || value.length === 0) return undefined;
	const out: Effort[] = [];
	for (const entry of value) {
		const effort = THINKING_EFFORTS.find(candidate => candidate === entry);
		if (effort === undefined) return undefined;
		out.push(effort);
	}
	return out;
}

function effortValue(value: unknown): Effort | undefined {
	return THINKING_EFFORTS.find(candidate => candidate === value);
}

function objectPayload(value: unknown): object | undefined {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? value : undefined;
}

function effortRecord(value: unknown): Partial<Record<Effort, string>> | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const out: Partial<Record<Effort, string>> = {};
	let any = false;
	for (const key in value) {
		const effort = effortValue(key);
		const mapped: unknown = Reflect.get(value, key);
		if (effort === undefined || typeof mapped !== "string") continue;
		out[effort] = mapped;
		any = true;
	}
	return any ? out : undefined;
}

function effortNumberRecord(value: unknown): Partial<Record<Effort, number>> | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const out: Partial<Record<Effort, number>> = {};
	let any = false;
	for (const key in value) {
		const effort = effortValue(key);
		const mapped: unknown = Reflect.get(value, key);
		if (effort === undefined || typeof mapped !== "number") continue;
		out[effort] = mapped;
		any = true;
	}
	return any ? out : undefined;
}

function thinkingMode(value: unknown): ThinkingConfig["mode"] | undefined {
	switch (value) {
		case "effort":
		case "budget":
		case "google-level":
		case "anthropic-adaptive":
		case "anthropic-budget-effort":
			return value;
		default:
			return undefined;
	}
}

// ---------------------------------------------------------------------------
// Detected baselines (layers 1+2) — ported from the legacy builders with
// pure identity/provider policy removed (rules own it).
// ---------------------------------------------------------------------------

const GLM_CODING_PLAN_STREAM_IDLE_TIMEOUT_MS = 600_000;
const LOCAL_OPENAI_COMPAT_STREAM_IDLE_TIMEOUT_MS = 300_000;

// Mechanism only: provider ids identify local/proxy endpoint shape, while
// loopback URL detection handles custom endpoints; neither is model policy.
const LOCAL_OPENAI_COMPAT_PROVIDERS: Record<string, true> = {
	"llama.cpp": true,
	"lm-studio": true,
	vllm: true,
	ollama: true,
};
const PROXY_OPENAI_COMPAT_PROVIDERS: Record<string, true> = { litellm: true };
function hasLocalLoopbackBaseUrl(baseUrl: string | undefined): boolean {
	if (!baseUrl) return false;
	let hostname: string;
	try {
		hostname = new URL(baseUrl).hostname.toLowerCase();
	} catch {
		return false;
	}
	if (
		hostname === "localhost" ||
		hostname === "127.0.0.1" ||
		hostname === "0.0.0.0" ||
		hostname === "::1" ||
		hostname === "[::1]"
	) {
		return true;
	}
	if (hostname.startsWith("10.")) return true;
	if (hostname.startsWith("192.168.")) return true;
	if (/^172\.(1[6-9]|2[0-9]|3[01])\./.test(hostname)) return true;
	if (hostname.endsWith(".local")) return true;
	return false;
}

function resolveReasoningDisableMode(
	thinkingFormat: ResolvedOpenAISharedCompat["thinkingFormat"],
): ResolvedOpenAISharedCompat["reasoningDisableMode"] {
	switch (thinkingFormat) {
		case "openrouter":
			return "openrouter-enabled-false";
		case "zai":
		case "kimi":
			return "zai-thinking-disabled";
		case "qwen":
			return "qwen-enable-thinking-false";
		case "qwen-chat-template":
			return "qwen-template-false";
		case "chat-template":
			return "chat-template-thinking-false";
		default:
			return "lowest-effort";
	}
}

/** Strict official-OpenAI check: provider id `openai` and an `api.openai.com` host. */
function isOfficialOpenAIEndpoint(provider: string, baseUrl: string): boolean {
	if (provider !== "openai") return false;
	if (!baseUrl) return true;
	try {
		return new URL(baseUrl).hostname === "api.openai.com";
	} catch {
		return false;
	}
}

interface OpenAIDetection {
	facts: IdentityFacts;
	isClinePass: boolean;
	isZai: boolean;
	isZhipu: boolean;
	isMoonshotNative: boolean;
	isOpenCodeHost: boolean;
	isOpenCodeProvider: boolean;
	isDirectDeepseekApi: boolean;
	isDeepseekReasoning: boolean;
	isDirectDeepseekReasoning: boolean;
	isVenice: boolean;
	requiresEnabledThinking: boolean;
	isXiaomiMimo: boolean;
	isLocalOpenAICompatBackend: boolean;
	isLocalServingBackend: boolean;
	isOpenRouter: boolean;
}

function detectOpenAI(spec: ModelSpec<"openai-completions" | "openrouter">, facts: IdentityFacts): OpenAIDetection {
	const provider = spec.provider;
	const baseUrl = spec.baseUrl;
	const hostModel = { provider, baseUrl };
	const isZai = modelMatchesHost(hostModel, "zai");
	const isZhipu = modelMatchesHost(hostModel, "zhipu");
	const isMoonshotNative = modelMatchesHost(hostModel, "moonshotNative");
	const isXiaomiHost = modelMatchesHost(hostModel, "xiaomi");
	const isDirectDeepseekApi = modelMatchesHost(hostModel, "deepseekDirect");
	const isDeepseekFamily = modelMatchesHost(hostModel, "deepseekFamily") || facts.is("deepseek");
	const isDeepseekReasoning = isDeepseekFamily && Boolean(spec.reasoning);
	const isLocalOpenAICompatBackend =
		PROXY_OPENAI_COMPAT_PROVIDERS[provider] !== true &&
		(LOCAL_OPENAI_COMPAT_PROVIDERS[provider] === true || hasLocalLoopbackBaseUrl(baseUrl));
	return {
		facts,
		isClinePass: provider === "cline-pass",
		isZai,
		isZhipu,
		isMoonshotNative,
		isOpenCodeHost: modelMatchesHost(hostModel, "opencode"),
		isOpenCodeProvider: provider === "opencode-go" || provider === "opencode-zen",
		isDirectDeepseekApi,
		isDeepseekReasoning,
		isDirectDeepseekReasoning: isDirectDeepseekApi && isDeepseekReasoning,
		isVenice: modelMatchesHost(hostModel, "venice"),
		requiresEnabledThinking: isMoonshotNative && facts.is("kimi") && facts.family("k2.7-code"),
		isXiaomiMimo: isXiaomiHost && facts.is("mimo"),
		isLocalOpenAICompatBackend,
		isLocalServingBackend: isLocalOpenAICompatBackend || hasLocalLoopbackBaseUrl(baseUrl),
		isOpenRouter: modelMatchesHost(hostModel, "openrouter"),
	};
}

/**
 * Detected chat-completions baseline. Pure identity policy (Kimi max-token
 * behavior, DeepSeek reasoning-content contracts, Qwen dialects, sampling
 * restrictions, effort maps, markup healers, …) is rule-owned and absent
 * here; compound host×identity branches remain, keyed on identity fields.
 */
function detectOpenAICompat(
	spec: ModelSpec<"openai-completions" | "openrouter">,
	d: OpenAIDetection,
): ResolvedOpenAICompat {
	const provider = spec.provider;
	const baseUrl = spec.baseUrl;
	const hostModel = { provider, baseUrl };
	const facts = d.facts;
	const isCerebras = modelMatchesHost(hostModel, "cerebras");
	const isCerebrasHost = hostMatchesUrl(baseUrl, "cerebras");
	const isKilo = modelMatchesHost(hostModel, "kilo");
	const isAlibaba = modelMatchesHost(hostModel, "alibabaDashscope");
	const isXiaomiHost = modelMatchesHost(hostModel, "xiaomi");
	const isGrok = modelMatchesHost(hostModel, "xai");
	const isMistral = modelMatchesHost(hostModel, "mistral");
	const isGoogleAistudioOpenAI = hostMatchesUrl(baseUrl, "googleAistudio");
	const isOpenAIHost = modelMatchesHost(hostModel, "openai");
	const isAzureHost = modelMatchesHost(hostModel, "azureOpenAI");
	const isVercelGateway = modelMatchesHost(hostModel, "vercelAIGateway");
	const isTogether = modelMatchesHost(hostModel, "together");
	const isFireworks = hostMatchesUrl(baseUrl, "fireworks");
	const isGroqHost = modelMatchesHost(hostModel, "groq");
	const isMiniMaxHost = modelMatchesHost(hostModel, "minimax");
	const isQwenPortal = modelMatchesHost(hostModel, "qwenPortal");
	const isMoonshotKimi = facts.is("kimi") && d.isMoonshotNative;
	const isMoonshotKimiK3 = isMoonshotKimi && facts.family("k3");
	const usesMoonshotKimiPreservedThinking = isMoonshotKimi && facts.family("k2.6");
	const isAnthropicModel = modelMatchesHost(hostModel, "anthropic") || facts.is("anthropic");
	const isQwen = facts.is("qwen");
	const isDeepseekFamily = modelMatchesHost(hostModel, "deepseekFamily") || facts.is("deepseek");
	const supportsZaiReasoningEffort = (d.isZai || d.isZhipu) && facts.is("glm") && facts.revGte("5.2");

	const isNonStandard =
		isCerebras ||
		isGrok ||
		isMistral ||
		isGoogleAistudioOpenAI ||
		hostMatchesUrl(baseUrl, "chutes") ||
		hostMatchesUrl(baseUrl, "deepseekFamily") ||
		isFireworks ||
		isAlibaba ||
		d.isZai ||
		d.isZhipu ||
		isKilo ||
		isQwen ||
		isXiaomiHost ||
		d.isMoonshotNative ||
		d.isOpenCodeHost;

	const useMaxTokens =
		isMistral ||
		d.isMoonshotNative ||
		d.isZai ||
		d.isZhipu ||
		hostMatchesUrl(baseUrl, "chutes") ||
		isFireworks ||
		d.isDirectDeepseekApi;

	const supportsPromptCacheBreakpoints =
		isOfficialOpenAIEndpoint(provider, baseUrl) && facts.is("openai") && facts.revGte("5.6");

	const supportsMultipleSystemMessagesDefault =
		!isMiniMaxHost &&
		!isAlibaba &&
		!isQwenPortal &&
		!isQwen &&
		(isOpenAIHost ||
			isAzureHost ||
			d.isOpenRouter ||
			isCerebras ||
			isTogether ||
			isFireworks ||
			isGroqHost ||
			isDeepseekFamily ||
			isMistral ||
			isGrok ||
			d.isZai ||
			d.isZhipu ||
			provider === "github-copilot" ||
			provider === "zenmux");

	// Endpoint-only watchdogs remain here; provider and lineage policy lives in KDL.
	const streamIdleTimeoutMs =
		facts.is("glm") &&
		facts.revGte("5") &&
		!facts.family("vision") &&
		(hostMatchesUrl(baseUrl, "zai") || hostMatchesUrl(baseUrl, "zhipu") || hostMatchesUrl(baseUrl, "opencode"))
			? GLM_CODING_PLAN_STREAM_IDLE_TIMEOUT_MS
			: facts.is("mimo") && hostMatchesUrl(baseUrl, "xiaomi")
				? 300_000
				: spec.reasoning &&
					  facts.is("kimi") &&
					  (facts.family("k3") || facts.family("k2.7-code")) &&
					  hostMatchesUrl(baseUrl, "moonshotNative")
					? 300_000
					: spec.reasoning && facts.is("deepseek") && hostMatchesUrl(baseUrl, "deepseekDirect")
						? 300_000
						: d.isLocalServingBackend
							? LOCAL_OPENAI_COMPAT_STREAM_IDLE_TIMEOUT_MS
							: undefined;

	const wireModelIdMode: ResolvedOpenAISharedCompat["wireModelIdMode"] = hostMatchesUrl(baseUrl, "openrouter")
		? "openrouter"
		: "raw";

	// Provider and lineage formats are rule-owned; endpoint-only dialects remain here.
	const thinkingFormat: ResolvedOpenAISharedCompat["thinkingFormat"] =
		(facts.is("kimi") && !facts.family("k3") && hostMatchesUrl(baseUrl, "moonshotNative")) ||
		hostMatchesUrl(baseUrl, "zai") ||
		hostMatchesUrl(baseUrl, "zhipu") ||
		(facts.is("mimo") && hostMatchesUrl(baseUrl, "xiaomi"))
			? "zai"
			: hostMatchesUrl(baseUrl, "openrouter")
				? "openrouter"
				: isQwen && hostMatchesUrl(baseUrl, "nvidia")
					? "qwen-chat-template"
					: isQwen && (isFireworks || hostMatchesUrl(baseUrl, "venice"))
						? "openai"
						: hostMatchesUrl(baseUrl, "alibabaDashscope") || isQwen
							? "qwen"
							: "openai";

	return {
		supportsStore: !isNonStandard,
		supportsDeveloperRole: isOpenAIHost || isAzureHost,
		supportsMultipleSystemMessages: supportsMultipleSystemMessagesDefault,
		supportsReasoningEffort: !isGrok && !d.isXiaomiMimo && (!(d.isZai || d.isZhipu) || supportsZaiReasoningEffort),
		// API-conditional: this completions-only Copilot exclusion cannot be a
		// provider rule without changing Copilot Responses rows.
		supportsReasoningParams: provider !== "github-copilot",
		supportsSamplingParams: !(facts.is("openai") && (facts.family("o-series") || facts.revGte("5"))),
		supportsPenaltyAndStopParams: !(isGrok && Boolean(spec.reasoning)),
		reasoningEffortMap: {},
		supportsUsageInStreaming: !isCerebrasHost,
		alwaysSendMaxTokens: facts.is("kimi"),
		disableReasoningOnForcedToolChoice:
			!d.isClinePass && ((facts.is("kimi") && !isMoonshotKimiK3) || isAnthropicModel),
		disableReasoningOnToolChoice: !d.isClinePass && isDeepseekFamily && Boolean(spec.reasoning) && !d.isOpenRouter,
		supportsToolChoice: d.isClinePass || !d.isDirectDeepseekReasoning,
		supportsForcedToolChoice:
			!d.requiresEnabledThinking && !(d.isOpenCodeHost && d.isDeepseekReasoning) && !(d.isClinePass && isQwen),
		supportsNamedToolChoice: true,
		maxTokensField: useMaxTokens ? "max_tokens" : "max_completion_tokens",
		requiresToolResultName: isMistral,
		requiresAssistantAfterToolResult: isMistral,
		requiresThinkingAsText: isMistral,
		requiresMistralToolIds: isMistral,
		thinkingFormat,
		kimiApiFormat: undefined,
		reasoningDisableMode: d.isClinePass
			? "cline-enabled-false"
			: d.isVenice
				? "venice-disable-thinking"
				: resolveReasoningDisableMode(thinkingFormat),
		omitReasoningEffort: false,
		includeEncryptedReasoning: true,
		filterReasoningHistory: d.isOpenRouter && isAnthropicModel,
		thinkingKeep: usesMoonshotKimiPreservedThinking ? "all" : undefined,
		reasoningContentField: d.isClinePass ? "reasoning" : "reasoning_content",
		requiresReasoningContentForToolCalls:
			(facts.is("kimi") && !d.isOpenCodeProvider) ||
			(isDeepseekFamily && Boolean(spec.reasoning)) ||
			d.isXiaomiMimo ||
			(d.isOpenRouter && Boolean(spec.reasoning)),
		requiresReasoningContentForAllAssistantTurns:
			((isDeepseekFamily && Boolean(spec.reasoning)) || d.isXiaomiMimo) && !d.isOpenRouter,
		allowsSyntheticReasoningContentForToolCalls: (!isDeepseekFamily || !spec.reasoning) && !d.isXiaomiMimo,
		replayReasoningContent: d.isLocalOpenAICompatBackend,
		qwenPreserveThinking:
			(thinkingFormat === "qwen" || thinkingFormat === "qwen-chat-template") && d.isLocalOpenAICompatBackend,
		qwenTemplateReasoningEffort:
			(thinkingFormat === "qwen" || thinkingFormat === "qwen-chat-template") &&
			d.isLocalOpenAICompatBackend &&
			provider !== "ollama" &&
			isQwen &&
			facts.revGte("3.8"),
		requiresAssistantContentForToolCalls: facts.is("kimi") || d.isDirectDeepseekReasoning,
		cacheControlFormat:
			(d.isClinePass && (isQwen || isAnthropicModel)) || (d.isOpenRouter && isAnthropicModel)
				? "anthropic"
				: undefined,
		supportsPromptCacheBreakpoints,
		promptCacheBreakpointTtl: supportsPromptCacheBreakpoints ? "30m" : undefined,
		openRouterRouting: undefined,
		vercelGatewayRouting: undefined,
		isOpenRouterHost: d.isOpenRouter,
		wireModelIdMode,
		isVercelGatewayHost: isVercelGateway,
		supportsStrictMode:
			hostMatchesUrl(baseUrl, "openai") ||
			hostMatchesUrl(baseUrl, "azureOpenAI") ||
			hostMatchesUrl(baseUrl, "cerebras") ||
			hostMatchesUrl(baseUrl, "together") ||
			hostMatchesUrl(baseUrl, "openrouter") ||
			hostMatchesUrl(baseUrl, "deepseekFamily"),
		extraBody: undefined,
		toolStrictMode: isCerebrasHost ? "all_strict" : "mixed",
		toolSchemaFlavor:
			d.isMoonshotNative || facts.is("kimi")
				? "moonshot-mfjs"
				: d.isLocalOpenAICompatBackend
					? "grammar"
					: undefined,
		streamFirstEventTimeoutMs: d.isLocalServingBackend ? 0 : undefined,
		streamIdleTimeoutMs,
		stripDeepseekSpecialTokens: facts.is("deepseek") && (provider === "nvidia" || provider === "deepseek"),
		streamMarkupHealingPattern: detectStreamMarkupHealing(spec.provider, facts, baseUrl),
		reasoningDeltasMayBeCumulative: false,
		emptyLengthFinishIsContextError: false,
		usesOpenAIToolCallIdLimit: false,
		promptCacheSessionHeader: hostMatchesUrl(baseUrl, "xai") ? "x-grok-conv-id" : undefined,
		dropThinkingWhenReasoningEffort: false,
		nativeKimiK3Reasoning: false,
		zaiReasoningEffortDialect: false,
		clampOutputToModelMax: false,
		stripImageInput: false,
		thinkingLoopGuard: undefined,
		rejectRootObjectUnion: false,
		retryWithoutStrictOnGrammarError: false,
		supportsPromptCacheKey: false,
	};
}

const DSML_HEALING_PROVIDERS: Record<string, true> = {
	ollama: true,
	"ollama-cloud": true,
	nvidia: true,
	deepseek: true,
	fireworks: true,
	nanogpt: true,
	"opencode-go": true,
	openrouter: true,
};

/**
 * Default leaked-markup healer. Kimi/DeepSeek dedicated grammars are keyed on
 * identity class; official OpenAI heals nothing; everything else defaults to
 * the generic `thinking` healer.
 */
function detectStreamMarkupHealing(
	provider: string,
	facts: IdentityFacts,
	baseUrl: string,
): ResolvedOpenAISharedCompat["streamMarkupHealingPattern"] {
	// The dedicated Kimi grammar targets the K2 chat template; K3 and unranked
	// Kimi ids keep the generic healer, matching the census.
	const isKimiK2 = facts.is("kimi") && facts.identity.family?.startsWith("k2") === true;
	if (provider === "kimi-code" || provider === "moonshot" || isKimiK2) return "kimi";
	if (facts.is("deepseek") && DSML_HEALING_PROVIDERS[provider] === true) return "dsml";
	if (isOfficialOpenAIEndpoint(provider, baseUrl)) return undefined;
	return "thinking";
}

function fixupOpenAICompat(
	spec: ModelSpec<"openai-completions" | "openrouter">,
	compat: ResolvedOpenAICompat,
	d: OpenAIDetection,
	axes: ResolvedAxes,
): void {
	const deepseekThinking = compat.extraBody?.thinking;
	if (
		d.isDirectDeepseekReasoning &&
		typeof deepseekThinking === "object" &&
		deepseekThinking !== null &&
		"type" in deepseekThinking &&
		deepseekThinking.type === "enabled"
	) {
		const extraBody = { ...compat.extraBody };
		delete extraBody.thinking;
		compat.extraBody = Object.keys(extraBody).length > 0 ? extraBody : undefined;
	}
	if (spec.compat?.reasoningDisableMode === undefined && !("reasoningDisableMode" in axes.wire)) {
		compat.reasoningDisableMode = d.isClinePass
			? "cline-enabled-false"
			: d.requiresEnabledThinking
				? "omit"
				: d.isDirectDeepseekReasoning
					? "zai-thinking-disabled"
					: d.isVenice
						? "venice-disable-thinking"
						: resolveReasoningDisableMode(compat.thinkingFormat);
	}
	if (
		spec.compat?.omitReasoningEffort === undefined &&
		!("omitReasoningEffort" in axes.wire) &&
		!compat.supportsReasoningEffort
	) {
		compat.omitReasoningEffort = true;
	}

	const axisWhenThinking = spec.reasoning ? objectPayload(axes.wire.whenThinking) : undefined;
	const whenThinkingPolicy =
		spec.compat?.whenThinking ??
		axisWhenThinking ??
		(d.isDirectDeepseekReasoning ? { extraBody: { ...compat.extraBody, thinking: { type: "enabled" } } } : undefined);
	if (whenThinkingPolicy) {
		const variant: ResolvedOpenAICompat = { ...compat, whenThinking: undefined };
		applyCompatOverrides(variant, whenThinkingPolicy);
		if (Reflect.get(whenThinkingPolicy, "reasoningDisableMode") === undefined) {
			variant.reasoningDisableMode = d.isVenice
				? "venice-disable-thinking"
				: resolveReasoningDisableMode(variant.thinkingFormat);
		}
		if (Reflect.get(whenThinkingPolicy, "omitReasoningEffort") === undefined && !variant.supportsReasoningEffort) {
			variant.omitReasoningEffort = true;
		}
		compat.whenThinking = variant;
	} else {
		compat.whenThinking = undefined;
	}
}

function resolveOpenAICompletionsPolicy(
	spec: ModelSpec<"openai-completions" | "openrouter">,
	facts: IdentityFacts,
	axes: ResolvedAxes,
): ResolvedOpenAICompat {
	const d = detectOpenAI(spec, facts);
	const compat = detectOpenAICompat(spec, d);
	applyWireAxes(compat, axes.wire, "openai-completions");
	applyCompatOverrides(compat, spec.compat);
	overlayEffortMapAxis(compat, axes, spec.compat);
	fixupOpenAICompat(spec, compat, d, axes);
	return compat;
}

/** Detected Responses-API baseline (ported from `buildOpenAIResponsesCompat`). */
function resolveOpenAIResponsesPolicy(
	spec: ModelSpec<"openai-responses" | "azure-openai-responses" | "openai-codex-responses" | "openrouter">,
	facts: IdentityFacts,
	axes: ResolvedAxes,
	api: Api,
): ResolvedOpenAIResponsesCompat {
	const baseUrl = spec.baseUrl ?? "";
	const provider = spec.provider;
	const hostModel = { provider, baseUrl };
	const isAzure = modelMatchesHost(hostModel, "azureOpenAI");
	const isOpenRouter = modelMatchesHost(hostModel, "openrouter");
	const isOpenAIUrl = hostMatchesUrl(baseUrl, "openai");
	const isVercelGateway = modelMatchesHost(hostModel, "vercelAIGateway");
	const isXaiHost = modelMatchesHost(hostModel, "xai");
	const supportsPromptCacheBreakpoints =
		isOfficialOpenAIEndpoint(provider, baseUrl) && facts.is("openai") && facts.revGte("5.6");
	const thinkingFormat: ResolvedOpenAISharedCompat["thinkingFormat"] = isOpenRouter ? "openrouter" : "openai";
	const reasoningCapable = Boolean(spec.reasoning);
	const isLocalServingBackend =
		(PROXY_OPENAI_COMPAT_PROVIDERS[provider] !== true && LOCAL_OPENAI_COMPAT_PROVIDERS[provider] === true) ||
		hasLocalLoopbackBaseUrl(baseUrl);
	const isAnthropicModel = facts.is("anthropic");
	const isDeepseekFamily = facts.is("deepseek");

	const compat: ResolvedOpenAIResponsesCompat = {
		supportsDeveloperRole: isAzure || isOpenAIUrl || hostMatchesUrl(baseUrl, "githubCopilot"),
		supportsStrictMode:
			isAzure ||
			hostMatchesUrl(baseUrl, "openai") ||
			hostMatchesUrl(baseUrl, "azureOpenAI") ||
			hostMatchesUrl(baseUrl, "cerebras") ||
			hostMatchesUrl(baseUrl, "together") ||
			hostMatchesUrl(baseUrl, "openrouter") ||
			hostMatchesUrl(baseUrl, "deepseekFamily"),
		supportsReasoningEffort: !isXaiHost,
		supportsLongPromptCacheRetention: isOpenAIUrl,
		supportsPromptCacheBreakpoints,
		promptCacheBreakpointTtl: supportsPromptCacheBreakpoints ? "30m" : undefined,
		strictResponsesPairing: isAzure || provider === "github-copilot",
		supportsImageDetailOriginal: !isXaiHost && !modelMatchesHost(hostModel, "githubCopilot"),
		supportsReasoningSummary: !isXaiHost,
		supportsAllTurnsReasoningContext: false,
		supportsConfigurationUpdate: false,
		requiresReasoningOffJuiceInstruction: false,
		stripImageInput: false,
		thinkingLoopGuard: undefined,
		reasoningEffortMap: {},
		supportsReasoningParams: true,
		supportsSamplingParams: !(facts.is("openai") && (facts.family("o-series") || facts.revGte("5"))),
		supportsPenaltyAndStopParams: !isXaiHost,
		thinkingFormat,
		reasoningDisableMode: resolveReasoningDisableMode(thinkingFormat),
		omitReasoningEffort: false,
		includeEncryptedReasoning: true,
		filterReasoningHistory: isOpenRouter && isAnthropicModel,
		disableReasoningOnForcedToolChoice: facts.is("kimi"),
		disableReasoningOnToolChoice: isDeepseekFamily && reasoningCapable && !isOpenRouter,
		supportsToolChoice: true,
		supportsForcedToolChoice: provider !== "opencode-go" && provider !== "opencode-zen",
		supportsNamedToolChoice: true,
		reasoningContentField: "reasoning_content",
		requiresReasoningContentForToolCalls:
			(facts.is("kimi") || (isDeepseekFamily && reasoningCapable) || (isOpenRouter && reasoningCapable)) &&
			reasoningCapable,
		requiresReasoningContentForAllAssistantTurns: isDeepseekFamily && reasoningCapable && !isOpenRouter,
		allowsSyntheticReasoningContentForToolCalls: !isDeepseekFamily || !reasoningCapable,
		replayReasoningContent: false,
		qwenPreserveThinking: false,
		qwenTemplateReasoningEffort: false,
		requiresThinkingAsText: false,
		requiresMistralToolIds: false,
		requiresToolResultName: false,
		requiresAssistantAfterToolResult: false,
		requiresAssistantContentForToolCalls: facts.is("kimi"),
		openRouterRouting: undefined,
		vercelGatewayRouting: undefined,
		isOpenRouterHost: isOpenRouter,
		isVercelGatewayHost: isVercelGateway,
		wireModelIdMode: isOpenRouter ? "openrouter" : "raw",
		toolSchemaFlavor: facts.is("kimi") ? "moonshot-mfjs" : undefined,
		alwaysSendMaxTokens: facts.is("kimi"),
		supportsObfuscationOptOut: isOpenAIUrl || provider === "openai",
		officialEndpoint: isOfficialOpenAIEndpoint(provider, baseUrl),
		harmonyLeakMitigation: false,
		rejectRootObjectUnion: false,
		retryWithoutStrictOnGrammarError: false,
		cacheControlFormat: isOpenRouter && isAnthropicModel ? "anthropic" : undefined,
		stripDeepseekSpecialTokens: facts.is("deepseek") && (provider === "nvidia" || provider === "deepseek"),
		streamMarkupHealingPattern: detectStreamMarkupHealing(provider, facts, baseUrl),
		reasoningDeltasMayBeCumulative: false,
		emptyLengthFinishIsContextError: false,
		usesOpenAIToolCallIdLimit: false,
		promptCacheSessionHeader: hostMatchesUrl(baseUrl, "xai") ? "x-grok-conv-id" : undefined,
		streamFirstEventTimeoutMs: isLocalServingBackend ? 0 : spec.compat?.streamFirstEventTimeoutMs,
		streamIdleTimeoutMs: isLocalServingBackend
			? LOCAL_OPENAI_COMPAT_STREAM_IDLE_TIMEOUT_MS
			: spec.compat?.streamIdleTimeoutMs,
	};
	applyWireAxes(compat, axes.wire, api);
	applyCompatOverrides(compat, spec.compat);
	overlayEffortMapAxis(compat, axes, spec.compat);
	if (isXaiHost && "reasoningEffortMap" in axes.wire) {
		// The rules carry the canonical first-party xAI effort map; re-assert it
		// over stale spec/cache overrides and drop clamp keys the canonical map
		// no longer declares (xhigh-capable SKUs keep xhigh unmapped).
		const canonical = effortRecord(axes.wire.reasoningEffortMap) ?? {};
		compat.reasoningEffortMap = { ...compat.reasoningEffortMap, ...canonical };
		for (const key of [Effort.XHigh, Effort.Max]) {
			if (!(key in canonical)) delete compat.reasoningEffortMap[key];
		}
	}
	if (spec.compat?.reasoningDisableMode === undefined && !("reasoningDisableMode" in axes.wire)) {
		compat.reasoningDisableMode = resolveReasoningDisableMode(compat.thinkingFormat);
	}
	if (
		spec.compat?.omitReasoningEffort === undefined &&
		!("omitReasoningEffort" in axes.wire) &&
		!compat.supportsReasoningEffort
	) {
		compat.omitReasoningEffort = true;
	}
	if (
		provider === "xai-oauth" &&
		axes.wire.supportsReasoningEffort === true &&
		spec.compat?.supportsReasoningEffort !== false
	) {
		// Stale cached rows written before a SKU joined the effort-capable
		// rules still carry omitReasoningEffort; the rules are the live wire
		// contract.
		compat.supportsReasoningEffort = true;
		compat.omitReasoningEffort = false;
	}
	return compat;
}

type ResponsesOnlyCompat = Omit<ResolvedOpenAIResponsesCompat, keyof ResolvedOpenAISharedCompat>;

function pickResponsesOnly(compat: ResolvedOpenAIResponsesCompat): ResponsesOnlyCompat {
	return {
		supportsLongPromptCacheRetention: compat.supportsLongPromptCacheRetention,
		strictResponsesPairing: compat.strictResponsesPairing,
		supportsImageDetailOriginal: compat.supportsImageDetailOriginal,
		supportsObfuscationOptOut: compat.supportsObfuscationOptOut,
		supportsAllTurnsReasoningContext: compat.supportsAllTurnsReasoningContext,
		supportsConfigurationUpdate: compat.supportsConfigurationUpdate,
		officialEndpoint: compat.officialEndpoint,
		harmonyLeakMitigation: compat.harmonyLeakMitigation,
		cacheControlFormat: compat.cacheControlFormat,
		requiresReasoningOffJuiceInstruction: compat.requiresReasoningOffJuiceInstruction,
		supportsReasoningSummary: compat.supportsReasoningSummary,
		isVercelGatewayHost: compat.isVercelGatewayHost,
	} satisfies ResponsesOnlyCompat;
}

function resolveAnthropicPolicy(
	spec: ModelSpec<"anthropic-messages">,
	facts: IdentityFacts,
	axes: ResolvedAxes,
): ResolvedAnthropicCompat {
	const baseUrl = spec.baseUrl;
	const official = isOfficialAnthropicApiUrl(baseUrl);
	const isCopilot = modelMatchesHost(spec, "githubCopilot");
	const isZenmux = modelMatchesHost(spec, "zenmux");
	const requiresThinkingEnabled = modelMatchesHost(spec, "moonshotNative") && facts.kimiMandatoryThinking;
	const isAzure = isAzureAnthropicRoute(baseUrl);
	const signingEndpoint = official || isCopilot || isZenmux || isAnthropicSigningProxyUrl(baseUrl);
	const compat: ResolvedAnthropicCompat = {
		officialEndpoint: official,
		signingEndpoint,
		supportsContextManagement: true,
		supportsOutputEffort: true,
		disableStrictTools: isAzure,
		disableAdaptiveThinking: false,
		allowAnthropicHeaderOverrides: false,
		supportsEagerToolInputStreaming: official,
		supportsLongCacheRetention: official,
		supportsMidConversationSystem: official && !facts.family("sonnet") && facts.anthropicAdaptiveGenAtLeast("4.8"),
		supportsTurnScopedSystem: false,
		supportsMidConversationToolChanges: false,
		supportsPerMessageEffort: false,
		supportsThinkingBindingControls: false,
		supportsForcedToolChoice: !requiresThinkingEnabled && !facts.family("fable", "mythos"),
		supportsSamplingParams: !facts.anthropicAdaptiveGenAtLeast("4.7"),
		requiresToolResultId: false,
		requiresThinkingEnabled,
		replayUnsignedThinking: !signingEndpoint && (Boolean(spec.reasoning) || modelMatchesHost(spec, "deepseekFamily")),
		escapeBuiltinToolNames: false,
		injectClaudeCodeInstruction: true,
		stripImageInput: false,
		thinkingLoopGuard: undefined,
		streamIdleTimeoutMs: spec.compat?.streamIdleTimeoutMs,
	};
	applyWireAxes(compat, axes.wire, "anthropic-messages");
	applyCompatOverrides(compat, spec.compat);
	return compat;
}

const BEDROCK_REASONING_STREAM_IDLE_TIMEOUT_MS = 600_000;
function resolveBedrockPolicy(spec: ModelSpec<"bedrock-converse-stream">, axes: ResolvedAxes): ResolvedBedrockCompat {
	// Prompt-cache checkpoint tables are rule-owned (class/family/revision
	// rules under `on "amazon-bedrock"`); the baseline is the conservative
	// no-checkpoint shape.
	const compat: ResolvedBedrockCompat = {
		promptCacheMode: "none",
		supportsLongPromptCacheRetention: false,
		promptCacheMinimumTokens: 0,
		promptCacheMaximumCheckpoints: 0,
	};
	// Reasoning capability is a mechanism gate; adaptive-lineage duration is rule-owned.
	compat.streamIdleTimeoutMs = spec.reasoning ? BEDROCK_REASONING_STREAM_IDLE_TIMEOUT_MS : undefined;
	applyWireAxes(compat, axes.wire, "bedrock-converse-stream");
	applyCompatOverrides(compat, spec.compat);
	return compat;
}

function resolveDevinPolicy(spec: ModelSpec<"devin-agent">, axes: ResolvedAxes): ResolvedDevinCompat {
	const compat: ResolvedDevinCompat = {
		trustExplicitThinkingOnly: true,
		modelRouter: false,
		supportsParallelToolCalls: false,
	};
	applyWireAxes(compat, axes.wire, "devin-agent");
	applyCompatOverrides(compat, spec.compat);
	return compat;
}

function resolveGooglePolicy(
	spec: ModelSpec<"google-generative-ai" | "google-vertex" | "google-gemini-cli">,
	axes: ResolvedAxes,
): ResolvedGoogleCompat {
	const compat: ResolvedGoogleCompat = {
		supportsFunctionPartId: false,
		requiresSkipThoughtSignature: false,
		requiresSkipThoughtSignatureOnFirstFunctionCall: false,
		dropUnsignedThinking: false,
		ccaLegacyParametersSchema: false,
		multimodalFunctionResponse: false,
		flashStreamLeakWorkaround: false,
		claudeThinkingBetaHeader: false,
		antigravityClaudeToolMode: false,
		stripImageInput: false,
	};
	applyWireAxes(compat, axes.wire, spec.api);
	applyCompatOverrides(compat, spec.compat);
	return compat;
}

// ---------------------------------------------------------------------------
// Thinking resolution
// ---------------------------------------------------------------------------

const DEFAULT_REASONING_EFFORTS: readonly Effort[] = [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High];
const DEFAULT_REASONING_EFFORTS_WITH_XHIGH: readonly Effort[] = [...DEFAULT_REASONING_EFFORTS, Effort.XHigh];

function omitsWireReasoningEffort(api: Api, compat: CompatOf<Api>): boolean {
	if (api !== "openai-responses" && api !== "openai-codex-responses" && api !== "azure-openai-responses") {
		return false;
	}
	return compat !== undefined && "supportsReasoningEffort" in compat && compat.supportsReasoningEffort === false;
}

function readCompatEffortMap(compat: CompatOf<Api>): Partial<Record<Effort, string>> | undefined {
	if (compat === undefined || !("reasoningEffortMap" in compat)) return undefined;
	const map = compat.reasoningEffortMap;
	return map && Object.keys(map).length > 0 ? map : undefined;
}
/** Host-quirk effort remaps detected outside the rules (URL/API compounds). */
const FIREWORKS_THINKING_EFFORT_MAP: Readonly<Partial<Record<Effort, string>>> = {
	[Effort.Minimal]: "none",
};

/** Identity/API-derived default control mode; `thinking-mode` rules override. */
function defaultThinkingMode<TApi extends Api>(spec: ModelSpec<TApi>, facts: IdentityFacts): ThinkingConfig["mode"] {
	switch (spec.api) {
		case "google-generative-ai":
		case "google-gemini-cli":
		case "google-vertex":
			return facts.is("gemini") && facts.revMajor() === 3 ? "google-level" : "budget";
		case "anthropic-messages":
			if (facts.is("minimax") && facts.family("m2", "m3")) return "anthropic-adaptive";
			if (facts.is("glm") && facts.revGte("5.2") && (spec.provider === "umans" || spec.provider === "zai")) {
				return "anthropic-budget-effort";
			}
			if (facts.is("anthropic")) {
				if (facts.revGte("4.6") && !facts.family("haiku")) return "anthropic-adaptive";
				if (facts.family("opus") && facts.revGte("4.5")) return "anthropic-budget-effort";
			}
			return "budget";
		case "bedrock-converse-stream":
			if (facts.is("anthropic")) {
				if (facts.anthropicAdaptiveGenAtLeast("4.6")) return "anthropic-adaptive";
				if (facts.family("opus") && facts.revGte("4.5")) return "anthropic-budget-effort";
			}
			if (facts.is("openai")) return "effort";
			return "budget";
		default:
			return "effort";
	}
}

/** API/compat-generic fallback ladder for targets no rule covered. */
function fallbackEfforts<TApi extends Api>(spec: ModelSpec<TApi>, compat: CompatOf<TApi>): readonly Effort[] {
	if (spec.api === "anthropic-messages") return DEFAULT_REASONING_EFFORTS_WITH_XHIGH;
	if (spec.api === "bedrock-converse-stream") return DEFAULT_REASONING_EFFORTS;
	if (
		(spec.api === "openai-completions" || spec.api === "openrouter") &&
		compat !== undefined &&
		"thinkingFormat" in compat
	) {
		if (compat.thinkingFormat === "openai" && compat.supportsReasoningEffort) {
			return DEFAULT_REASONING_EFFORTS_WITH_XHIGH;
		}
		return DEFAULT_REASONING_EFFORTS;
	}
	if (
		spec.api === "openai-responses" ||
		spec.api === "openai-codex-responses" ||
		spec.api === "azure-openai-responses"
	) {
		return DEFAULT_REASONING_EFFORTS_WITH_XHIGH;
	}
	return DEFAULT_REASONING_EFFORTS;
}

function filterEffortMap(
	map: Partial<Record<Effort, string>>,
	efforts: readonly Effort[],
): Partial<Record<Effort, string>> | undefined {
	let filtered: Partial<Record<Effort, string>> | undefined;
	for (const effort of efforts) {
		const mapped = map[effort];
		if (mapped === undefined) continue;
		filtered ??= {};
		filtered[effort] = mapped;
	}
	return filtered;
}

interface RuleThinking {
	mode?: ThinkingConfig["mode"];
	efforts?: readonly Effort[];
	defaultLevel?: Effort;
	effortMap?: Partial<Record<Effort, string>>;
	effortBudgets?: Partial<Record<Effort, number>>;
	requiresEffort?: boolean;
	suppressWhenOff?: boolean;
	supportsDisplay?: boolean;
	prefixBinding?: boolean;
}

function readRuleThinking(axes: ResolvedAxes): RuleThinking {
	const raw = axes.thinking;
	const out: RuleThinking = {};
	const mode = thinkingMode(raw.mode);
	if (mode !== undefined) out.mode = mode;
	const efforts = effortList(raw.efforts);
	if (efforts !== undefined) out.efforts = efforts;
	const defaultLevel = effortValue(raw.defaultLevel);
	if (defaultLevel !== undefined) out.defaultLevel = defaultLevel;
	const effortMap = effortRecord(raw.effortMap);
	if (effortMap !== undefined) out.effortMap = effortMap;
	const effortBudgets = effortNumberRecord(raw.effortBudgets);
	if (effortBudgets !== undefined) out.effortBudgets = effortBudgets;
	if (typeof raw.requiresEffort === "boolean") out.requiresEffort = raw.requiresEffort;
	if (typeof raw.suppressWhenOff === "boolean") out.suppressWhenOff = raw.suppressWhenOff;
	if (typeof raw.supportsDisplay === "boolean") out.supportsDisplay = raw.supportsDisplay;
	if (typeof raw.prefixBinding === "boolean") out.prefixBinding = raw.prefixBinding;
	return out;
}

/** Identity-derived `requiresEffort` default (mandatory-reasoning lineages). */
function impliesMandatoryReasoning(facts: IdentityFacts, modelId: string): boolean {
	if (facts.identity.thinkingVariant) return true;
	// Thinking-variant orphans: a bounded pair token anywhere in the id
	// (`runtime-thinking-model`, `qwen3-…-thinking-2507`) names the
	// reasoning-locked sibling even when it is not a collapse suffix.
	if (stripThinkingVariantSuffix(modelId) !== undefined) return true;
	return false;
}

function isQwenTemplateReasoningEffortCompat(compat: CompatOf<Api>): boolean {
	return (
		compat !== undefined && "qwenTemplateReasoningEffort" in compat && compat.qwenTemplateReasoningEffort === true
	);
}

function resolveThinkingPolicy<TApi extends Api>(
	spec: ModelSpec<TApi>,
	facts: IdentityFacts,
	axes: ResolvedAxes,
	compat: CompatOf<TApi>,
): ThinkingConfig | undefined {
	if (!spec.reasoning) return undefined;
	if (
		spec.provider === "cline-pass" &&
		compat !== undefined &&
		"supportsReasoningEffort" in compat &&
		compat.supportsReasoningEffort === false
	) {
		return undefined;
	}
	if (omitsWireReasoningEffort(spec.api, compat)) return undefined;
	const rule = readRuleThinking(axes);
	if (spec.thinking && Array.isArray(spec.thinking.efforts) && spec.thinking.efforts.length > 0) {
		return fillExplicitThinking(spec, facts, compat, spec.thinking, rule);
	}
	if (compat !== undefined && "trustExplicitThinkingOnly" in compat && compat.trustExplicitThinkingOnly === true) {
		return undefined;
	}
	const config: ThinkingConfig = {
		mode: rule.mode ?? defaultThinkingMode(spec, facts),
		efforts: rule.efforts ?? fallbackEfforts(spec, compat),
	};
	if (config.efforts.length === 0) {
		throw new Error(`Model ${spec.provider}/${spec.id} resolved to an empty thinking range`);
	}
	if (rule.defaultLevel !== undefined) config.defaultLevel = rule.defaultLevel;
	const effortMap = mergeEffortMap(spec, rule.effortMap, compat, config.efforts);
	if (effortMap !== undefined) config.effortMap = effortMap;
	if (rule.effortBudgets !== undefined) config.effortBudgets = rule.effortBudgets;
	const supportsDisplay = rule.supportsDisplay ?? defaultSupportsDisplay(spec, facts);
	if (supportsDisplay) config.supportsDisplay = true;
	if (rule.prefixBinding) config.prefixBinding = true;
	const requiresEffort =
		rule.requiresEffort ?? (impliesMandatoryReasoning(facts, spec.id) || isQwenTemplateReasoningEffortCompat(compat));
	if (requiresEffort) config.requiresEffort = true;
	if (rule.suppressWhenOff) config.suppressWhenOff = true;
	return config;
}
/**
 * Displayable-thinking default: an api-conditioned lineage fact (Anthropic
 * wire dialects streaming adaptive Claude 4.7+ thinking) that KDL cannot
 * express — cascade selectors have no api dimension. `thinking-supports-display`
 * rules override per deployment.
 */
function defaultSupportsDisplay<TApi extends Api>(spec: ModelSpec<TApi>, facts: IdentityFacts): boolean {
	return (
		(spec.api === "anthropic-messages" || spec.api === "bedrock-converse-stream") &&
		facts.anthropicAdaptiveGenAtLeast("4.7")
	);
}

function mergeEffortMap(
	spec: ModelSpec<Api>,
	ruleMap: Partial<Record<Effort, string>> | undefined,
	compat: CompatOf<Api>,
	efforts: readonly Effort[],
): Partial<Record<Effort, string>> | undefined {
	const detected =
		(spec.api === "openai-completions" || spec.api === "openrouter") &&
		modelMatchesHost({ provider: spec.provider, baseUrl: spec.baseUrl ?? "" }, "fireworks")
			? FIREWORKS_THINKING_EFFORT_MAP
			: undefined;
	const configured = readCompatEffortMap(compat);
	if (detected === undefined && ruleMap === undefined && configured === undefined) return undefined;
	return filterEffortMap({ ...detected, ...ruleMap, ...configured }, efforts);
}

/**
 * Backfill missing wire/default fields onto explicit thinking metadata.
 * Explicit spec thinking is layer 4 of the resolution order: its ladder and
 * every explicitly-set field always win; only absent fields are filled from
 * the rules and identity-derived defaults.
 */
function fillExplicitThinking<TApi extends Api>(
	spec: ModelSpec<TApi>,
	facts: IdentityFacts,
	compat: CompatOf<TApi>,
	thinking: ThinkingConfig,
	rule: RuleThinking,
): ThinkingConfig {
	const effortMap =
		thinking.effortMap === undefined ? mergeEffortMap(spec, rule.effortMap, compat, thinking.efforts) : undefined;
	const needsDisplay =
		thinking.supportsDisplay === undefined && (rule.supportsDisplay ?? defaultSupportsDisplay(spec, facts));
	const needsRequiresEffort =
		thinking.requiresEffort === undefined &&
		(rule.requiresEffort ??
			(impliesMandatoryReasoning(facts, spec.id) || isQwenTemplateReasoningEffortCompat(compat)));
	const needsDefaultLevel = thinking.defaultLevel === undefined && rule.defaultLevel !== undefined;
	const needsPrefixBinding = thinking.prefixBinding === undefined && rule.prefixBinding === true;
	if (effortMap === undefined && !needsDisplay && !needsRequiresEffort && !needsDefaultLevel && !needsPrefixBinding) {
		return thinking;
	}
	const filled: ThinkingConfig = { ...thinking };
	if (effortMap !== undefined) filled.effortMap = effortMap;
	if (needsDisplay) filled.supportsDisplay = true;
	if (needsDefaultLevel && rule.defaultLevel !== undefined) filled.defaultLevel = rule.defaultLevel;
	if (needsRequiresEffort) filled.requiresEffort = true;
	if (needsPrefixBinding) filled.prefixBinding = true;
	return filled;
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

function buildResolveTarget<TApi extends Api>(spec: ModelSpec<TApi>, identity: ModelIdentity): ResolveTarget {
	const target: ResolveTarget = {
		provider: spec.provider,
		class: identity.class,
		model: spec.id,
		reasoning: Boolean(spec.reasoning),
	};
	if (identity.family !== undefined) target.family = identity.family;
	if (identity.revision !== undefined) target.revision = identity.revision;
	return target;
}

function specUsesApi<TApi extends Api>(spec: ModelSpec<Api>, api: TApi): spec is ModelSpec<TApi> {
	return spec.api === api;
}

/**
 * Resolves the full policy surface for one model spec: structured identity,
 * complete compat record, thinking metadata, and catalog-data corrections.
 */
export function resolveModelPolicy<TApi extends Api>(spec: ModelSpec<TApi>): ResolvedModelPolicy<TApi>;
export function resolveModelPolicy(spec: ModelSpec<Api>): ResolvedModelPolicy<Api> {
	const identity = resolveIdentity(spec);
	const facts = new IdentityFacts(identity);
	const axes = resolveCascade(buildResolveTarget(spec, identity));
	let compat: CompatOf<Api>;
	if (specUsesApi(spec, "openrouter")) {
		const chat = resolveOpenAICompletionsPolicy(spec, facts, axes);
		const responses = resolveOpenAIResponsesPolicy(spec, facts, axes, "openrouter");
		compat = { ...chat, ...pickResponsesOnly(responses) };
	} else if (specUsesApi(spec, "openai-completions")) {
		compat = resolveOpenAICompletionsPolicy(spec, facts, axes);
	} else if (
		specUsesApi(spec, "openai-responses") ||
		specUsesApi(spec, "azure-openai-responses") ||
		specUsesApi(spec, "openai-codex-responses")
	) {
		compat = resolveOpenAIResponsesPolicy(spec, facts, axes, spec.api);
	} else if (specUsesApi(spec, "anthropic-messages")) {
		compat = resolveAnthropicPolicy(spec, facts, axes);
	} else if (specUsesApi(spec, "bedrock-converse-stream")) {
		compat = resolveBedrockPolicy(spec, axes);
	} else if (specUsesApi(spec, "devin-agent")) {
		compat = resolveDevinPolicy(spec, axes);
	} else if (
		specUsesApi(spec, "google-generative-ai") ||
		specUsesApi(spec, "google-vertex") ||
		specUsesApi(spec, "google-gemini-cli")
	) {
		compat = resolveGooglePolicy(spec, axes);
	} else {
		compat = undefined;
	}
	return {
		identity,
		compat,
		thinking: resolveThinkingPolicy(spec, facts, axes, compat),
		catalog: axes.catalog,
	};
}
