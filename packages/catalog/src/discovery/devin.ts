import { logger } from "@oh-my-pi/pi-utils";
import { Effort, THINKING_EFFORTS } from "../effort";
import type { DevinCompat, FetchImpl, ModelCost, ModelSpec } from "../types";
import { discoveryFetch } from "../utils";
import { collapseEffortVariants, DEVIN_VARIANT_COLLAPSE_TABLE, type EffortVariantFamily } from "../variant-collapse";
import { DEVIN_DEFAULT_BASE_URL, devinDiscoveryMetadata } from "../wire/devin";
import { decodeDevinUnaryMessage } from "../wire/devin-proto";
import {
	type ClientModelConfig,
	DisplayOption,
	GetCliModelConfigsRequestSchema,
	GetCliModelConfigsResponseSchema,
	MetadataSchema,
	ModelDimensionKind,
} from "./devin-proto";
import { create, toBinary } from "./protobuf";

const DEVIN_GET_CLI_MODEL_CONFIGS_PATH = "/exa.api_server_pb.ApiServerService/GetCliModelConfigs";

const DEFAULT_CONTEXT_WINDOW = 200_000;
const DEFAULT_MAX_TOKENS = 64_000;

/**
 * `DISPLAY_OPTION_INTERNAL_DEFAULT` — display slot for configs the server only
 * reveals to clients that opt in, used for internal default/eval models.
 *
 * The vendored descriptor predates display options 6-8, so the generated
 * `DisplayOption` enum stops at `QUICK_REVIEW` (4). Wire display options are
 * plain int32, so the extra values decode and re-encode faithfully; casting
 * here keeps the generated code untouched.
 */
const DEVIN_DISPLAY_OPTION_INTERNAL_DEFAULT = 6 as DisplayOption;
/** Unclassified native display slot: requested for parity, never filtered on. */
const DEVIN_DISPLAY_OPTION_UNCLASSIFIED = 7 as DisplayOption;
/** Second visible-model slot, used beside `UNSPECIFIED` (0) for normal models. */
const DEVIN_DISPLAY_OPTION_NORMAL = 8 as DisplayOption;

/**
 * Display slots the native client advertises. `UNSPECIFIED` (0) is implicit —
 * it is the default for configs with no display opinion. Asking for the
 * internal slots is what makes the server return its full catalog; the
 * internal ones are filtered client-side, exactly as native does.
 */
const DEVIN_SUPPORTED_MODEL_DISPLAYS: readonly DisplayOption[] = [
	DisplayOption.MODEL_ROUTER,
	DisplayOption.QUICK_REVIEW,
	DEVIN_DISPLAY_OPTION_INTERNAL_DEFAULT,
	DEVIN_DISPLAY_OPTION_UNCLASSIFIED,
	DEVIN_DISPLAY_OPTION_NORMAL,
];

/** Display slots requested but never surfaced: quick-review and internal defaults. */
const DEVIN_INTERNAL_MODEL_DISPLAYS: ReadonlySet<DisplayOption> = new Set([
	DisplayOption.QUICK_REVIEW,
	DEVIN_DISPLAY_OPTION_INTERNAL_DEFAULT,
]);

/** Best-effort match for labels whose wording implies a thinking / reasoning-effort variant. */
const REASONING_LABEL_PATTERN = /think|thinking|minimal|high|medium|low|xhigh|max|reasoning/i;
const NO_REASONING_LABEL_PATTERN = /\bno thinking\b/i;

/**
 * Server model features are authoritative for reasoning support; the label
 * heuristic only covers configs that ship no `modelFeatures` at all.
 */
function supportsDevinThinking(config: ClientModelConfig): boolean {
	const features = config.modelInfo?.modelFeatures;
	if (features !== undefined) {
		return features.supportsThinking;
	}
	if (NO_REASONING_LABEL_PATTERN.test(config.label)) return false;
	return REASONING_LABEL_PATTERN.test(config.label);
}

/** Cost `modelDimensions` labels, normalized, mapped onto catalog token rates. */
const DEVIN_COST_LABEL_INPUT = "input";
const DEVIN_COST_LABEL_CACHE_READ = "cached input";
const DEVIN_COST_LABEL_OUTPUT = "output";

/** Leading token count of a cost denominator ("1M tokens", "1K tokens"). */
const DEVIN_COST_DENOMINATOR_PATTERN = /(\d+(?:\.\d+)?)\s*([kmb])?/i;
const DEVIN_COST_DENOMINATOR_SCALE: Readonly<Partial<Record<string, number>>> = {
	k: 1_000,
	m: 1_000_000,
	b: 1_000_000_000,
};

/**
 * Tokens covered by one cost dimension. Native prices per `1M tokens`; the
 * scale is parsed instead of assumed so a future `1K` denominator still
 * normalizes to catalog per-million rates.
 */
function devinCostDenominatorTokens(denominator: string): number {
	const match = DEVIN_COST_DENOMINATOR_PATTERN.exec(denominator);
	if (match === null) return 1_000_000;
	const suffix = match[2];
	const scale = suffix === undefined ? 1 : (DEVIN_COST_DENOMINATOR_SCALE[suffix.toLowerCase()] ?? 1);
	const tokens = Number(match[1]) * scale;
	return tokens > 0 ? tokens : 1_000_000;
}

/**
 * Per-million-token rates from the config's cost dimensions. `COST_FUZZY` marks
 * an estimated rate, not a different unit, so both kinds are read. `cacheWrite`
 * has no Cascade dimension — Devin bills cache writes at the input rate — and
 * stays 0.
 */
function devinModelCost(config: ClientModelConfig): ModelCost {
	const cost: ModelCost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
	for (const dimension of config.modelDimensions) {
		if (dimension.kind !== ModelDimensionKind.COST && dimension.kind !== ModelDimensionKind.COST_FUZZY) {
			continue;
		}
		// Dimension values arrive as protobuf floats: round off float32 noise
		// (0.1 decodes as 0.10000000149011612) at sub-cent precision.
		const perMillion =
			Math.round(((dimension.value * 1_000_000) / devinCostDenominatorTokens(dimension.denominator)) * 1e6) / 1e6;
		switch (dimension.label.trim().toLowerCase()) {
			case DEVIN_COST_LABEL_INPUT:
				cost.input = perMillion;
				break;
			case DEVIN_COST_LABEL_CACHE_READ:
				cost.cacheRead = perMillion;
				break;
			case DEVIN_COST_LABEL_OUTPUT:
				cost.output = perMillion;
				break;
		}
	}
	return cost;
}

/** `modelFamilyMetadata` entry keys that carry the family's effort axis. */
const DEVIN_FAMILY_EFFORT_KEYS: Readonly<Partial<Record<string, true>>> = { effort: true, "reasoning effort": true };
/** `modelFamilyMetadata` entry key for the service-tier axis; order 1 is the fast lane. */
const DEVIN_FAMILY_FAST_KEY = "fast mode";
const DEVIN_FAMILY_FAST_ORDER = 1;
/** Boolean reasoning axis used by Claude families whose effort name alone is ambiguous. */
const DEVIN_FAMILY_THINKING_KEY = "thinking";
const DEVIN_FAMILY_THINKING_ORDER = 1;
/** Context-window axis; order 1 selects the separate 1M-context lane. */
const DEVIN_FAMILY_CONTEXT_1M_KEY = "1m context";
const DEVIN_FAMILY_CONTEXT_1M_ORDER = 1;

/** Effort-entry display names, normalized to a space-free token, mapped onto pi efforts. */
const DEVIN_FAMILY_EFFORT_BY_NAME: Readonly<Partial<Record<string, Effort | "off">>> = {
	none: "off",
	nothinking: "off",
	minimal: Effort.Minimal,
	low: Effort.Low,
	medium: Effort.Medium,
	high: Effort.High,
	xhigh: Effort.XHigh,
	max: Effort.Max,
};

/**
 * One server-declared family lane. Fast service and 1M context are separate
 * logical models; reasoning effort remains the lane's only selectable axis.
 */
interface DevinFamilyLane {
	/** Logical id: normalized family label plus optional `-1m` / `-fast` suffixes. */
	id: string;
	name: string;
	/** Member wire uids in server order. */
	members: string[];
	/** Wire uid the server marks as the family default, when it declares one. */
	defaultMember?: string;
	/** Effort (or `"off"`) -> member wire uid; first claim wins. */
	routing: Partial<Record<Effort | "off", string>>;
}

/**
 * File `config` under its server-declared family lane. Configs with no family
 * metadata, or whose family carries no effort axis, are left alone and stay
 * standalone specs.
 */
function collectDevinFamilyLane(lanes: Map<string, DevinFamilyLane>, config: ClientModelConfig, uid: string): void {
	const metadata = config.modelFamilyMetadata;
	if (metadata === undefined) return;
	const label = metadata.modelFamilyLabel.trim();
	if (!label) return;

	let effort: Effort | "off" | undefined;
	let thinking: boolean | undefined;
	let fast = false;
	let oneMillionContext = false;
	for (const entry of metadata.entries) {
		const value = entry.value;
		if (value === undefined) continue;
		// Keys collapse punctuation to spaces ("Reasoning Effort" -> "reasoning
		// effort"); effort names drop it entirely ("X High" and "XHigh" -> "xhigh").
		const key = entry.key
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, " ")
			.trim();
		if (key === DEVIN_FAMILY_FAST_KEY) {
			fast = value.order === DEVIN_FAMILY_FAST_ORDER;
			continue;
		}
		if (key === DEVIN_FAMILY_THINKING_KEY) {
			thinking = value.order === DEVIN_FAMILY_THINKING_ORDER;
			continue;
		}
		if (key === DEVIN_FAMILY_CONTEXT_1M_KEY) {
			oneMillionContext = value.order === DEVIN_FAMILY_CONTEXT_1M_ORDER;
			continue;
		}
		if (DEVIN_FAMILY_EFFORT_KEYS[key]) {
			effort = DEVIN_FAMILY_EFFORT_BY_NAME[value.name.toLowerCase().replace(/[^a-z0-9]+/g, "")];
		}
	}
	// Claude's paired non-thinking and thinking configs share the same "High"
	// effort label; its explicit Thinking axis decides whether the route is off.
	if (thinking === false) effort = "off";

	// Family label as an OMP id: "GPT-5.6 Sol" -> "gpt-5-6-sol".
	const baseId = label
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	if (!baseId) return;
	const laneId = `${baseId}${oneMillionContext ? "-1m" : ""}${fast ? "-fast" : ""}`;
	let lane = lanes.get(laneId);
	if (lane === undefined) {
		const name = `${label}${oneMillionContext ? " 1M" : ""}${fast ? " Fast" : ""}`;
		lane = { id: laneId, name, members: [], routing: {} };
		lanes.set(laneId, lane);
	}
	lane.members.push(uid);
	if (lane.defaultMember === undefined && (config.isDefaultModelInFamily || metadata.isDefaultModelInFamily)) {
		lane.defaultMember = uid;
	}
	if (effort !== undefined && lane.routing[effort] === undefined) {
		lane.routing[effort] = uid;
	}
}

/**
 * Collapse families for the lanes that declare an effort ladder. The server
 * default wire uid is hoisted to the front of `members` so collapsing adopts it
 * as the logical model's default `requestModelId`.
 *
 * A lane with no non-`off` effort route has nothing to route: its members stay
 * standalone rather than collapsing into a family with an empty effort list.
 */
function devinDynamicFamilies(lanes: Iterable<DevinFamilyLane>): EffortVariantFamily[] {
	const families: EffortVariantFamily[] = [];
	for (const lane of lanes) {
		const efforts = THINKING_EFFORTS.filter(effort => lane.routing[effort] !== undefined);
		if (efforts.length === 0) continue;
		const defaultMember = lane.defaultMember;
		const members =
			defaultMember === undefined
				? lane.members
				: [defaultMember, ...lane.members.filter(uid => uid !== defaultMember)];
		// The tier the native client selects when the family is picked without an
		// explicit effort, recovered from whichever effort routes to the default
		// member. An `off`-only default has no effort to name.
		const defaultLevel =
			defaultMember === undefined ? undefined : efforts.find(effort => lane.routing[effort] === defaultMember);
		families.push({
			id: lane.id,
			name: lane.name,
			members,
			routing: lane.routing,
			...(defaultMember !== undefined ? { defaultMember } : {}),
			thinking: {
				mode: "effort",
				efforts,
				...(defaultLevel !== undefined ? { defaultLevel } : {}),
				// No `None` tier upstream: there is no wire id that serves this
				// family with thinking disabled, so effort is mandatory.
				...(lane.routing.off === undefined ? { requiresEffort: true } : {}),
			},
		});
	}
	return families;
}

/**
 * Options for fetching dynamic Devin (Codeium Cascade) models from `GetCliModelConfigs`.
 */
export interface DevinModelDiscoveryOptions {
	/** Codeium session token carried inside protobuf `Metadata.apiKey`. */
	apiKey?: string;
	/** Optional Codeium API base URL override. */
	baseUrl?: string;
	/** Optional request timeout in milliseconds (default 5000). */
	timeoutMs?: number;
	/** Optional caller abort signal, combined with the internal timeout. */
	signal?: AbortSignal;
	/** Optional fetch implementation for request-debug/proxy/test transports. */
	fetch?: FetchImpl;
}

/**
 * Fetches Devin models through the `GetCliModelConfigs` unary Connect RPC and
 * normalizes them into canonical model entries.
 *
 * Returns `null` on request/decode failures.
 * Returns `[]` only when the endpoint responds successfully with no usable models.
 */
export async function fetchDevinModels(
	options: DevinModelDiscoveryOptions,
): Promise<ModelSpec<"devin-agent">[] | null> {
	const timeoutMs = options.timeoutMs ?? 5_000;
	const resolvedBaseUrl = options.baseUrl ?? DEVIN_DEFAULT_BASE_URL;
	const requestUrl = `${resolvedBaseUrl.replace(/\/+$/, "")}${DEVIN_GET_CLI_MODEL_CONFIGS_PATH}`;

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;

	try {
		const request = create(GetCliModelConfigsRequestSchema, {
			metadata: create(MetadataSchema, {
				...devinDiscoveryMetadata(options.apiKey),
				supportedModelDisplays: [...DEVIN_SUPPORTED_MODEL_DISPLAYS],
			}),
		});
		const body = toBinary(GetCliModelConfigsRequestSchema, request);

		const headers: Record<string, string> = {
			"content-type": "application/proto",
			"connect-protocol-version": "1",
			accept: "*/*",
		};

		const fetchImpl = discoveryFetch(options.fetch);
		const response = await fetchImpl(requestUrl, { method: "POST", headers, body, signal });
		if (!response.ok) {
			return null;
		}

		const decoded = decodeDevinUnaryMessage(
			GetCliModelConfigsResponseSchema,
			new Uint8Array(await response.arrayBuffer()),
		);
		if (!decoded) {
			return null;
		}
		const models = normalizeDevinModels(decoded.clientModelConfigs, options.baseUrl);
		if (models.length === 0) {
			// The backend gates the native catalog on the pinned CLI identity; an
			// empty-but-200 response is the failure signature of a stale version
			// pin (there is no explicit error). Treat it as failed discovery so
			// the static seed survives, and leave a trail for diagnosis. Apply
			// this after filtering because a response containing only disabled or
			// internal configs is equally unusable.
			logger.warn("Devin returned an empty native model catalog; the pinned CLI identity may be stale", {
				metadata: devinDiscoveryMetadata(undefined),
			});
			return null;
		}

		return models;
	} catch {
		return null;
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Wire uids whose configs advertise `supports_images` but whose backend
 * silently drops the `ChatMessagePrompt.images` field. Verified live
 * (2026-08-14, native CLI identity): SWE-1.6 and SWE-1.6 Fast answer as if no
 * image was attached, while SWE-1.7, SWE-1.7 Lightning, and every proxied
 * frontier model (Claude/Gemini/GPT/Kimi) read the same field correctly.
 * Declaring text-only lets clients use their image fallback path instead of
 * silently losing attachments ([#6072](https://github.com/can1357/oh-my-pi/issues/6072)).
 * Remove entries if Devin ever wires SWE-1.6 vision up.
 */
const DEVIN_IMAGE_BLIND_UIDS = new Set(["swe-1-6", "swe-1-6-fast"]);

/** One config as a raw (pre-collapse) spec keyed on its wire uid. */
function devinModelSpec(
	config: ClientModelConfig,
	uid: string,
	baseUrl: string,
	isRouter: boolean,
): ModelSpec<"devin-agent"> {
	const features = config.modelInfo?.modelFeatures;
	const supportsImages =
		(features !== undefined ? features.supportsImages : config.supportsImages) && !DEVIN_IMAGE_BLIND_UIDS.has(uid);
	const input: ("text" | "image")[] = supportsImages ? ["text", "image"] : ["text"];
	const compat: DevinCompat = {};
	if (isRouter) compat.modelRouter = true;
	if (features?.supportsParallelToolCalls === true) compat.supportsParallelToolCalls = true;
	const maxOutputTokens = config.modelInfo?.maxOutputTokens ?? 0;
	const spec: ModelSpec<"devin-agent"> = {
		id: uid,
		name: config.label.trim() || uid,
		api: "devin-agent",
		provider: "devin",
		baseUrl,
		reasoning: supportsDevinThinking(config),
		input,
		// Router configs ship no model features — the model they route to decides
		// tool use. Cascade only serves tool-calling models, so absent features
		// mean tools are available.
		supportsTools: features !== undefined ? features.supportsToolCalls : true,
		cost: devinModelCost(config),
		contextWindow: config.maxTokens > 0 ? config.maxTokens : DEFAULT_CONTEXT_WINDOW,
		maxTokens: maxOutputTokens > 0 ? maxOutputTokens : DEFAULT_MAX_TOKENS,
		...(Object.keys(compat).length > 0 ? { compat } : {}),
	};
	// Presentation metadata the server already ships, kept sparse: only the
	// flags upstream actually set reach the catalog.
	const description = config.description?.trim();
	if (description) spec.description = description;
	if (config.isNew) spec.isNew = true;
	if (config.isBeta) spec.isBeta = true;
	if (config.isRecommended) spec.isRecommended = true;
	return spec;
}

function normalizeDevinModels(
	configs: readonly ClientModelConfig[],
	baseUrlOverride: string | undefined,
): ModelSpec<"devin-agent">[] {
	const baseUrl = baseUrlOverride ?? DEVIN_DEFAULT_BASE_URL;
	const specs: ModelSpec<"devin-agent">[] = [];
	const seen = new Set<string>();
	const lanes = new Map<string, DevinFamilyLane>();

	for (const config of configs) {
		if (config.disabled) {
			continue;
		}
		const displayOption = config.modelInfo?.displayOption ?? DisplayOption.UNSPECIFIED;
		if (DEVIN_INTERNAL_MODEL_DISPLAYS.has(displayOption)) {
			continue;
		}
		const uid = config.modelUid.trim();
		if (!uid || seen.has(uid)) {
			continue;
		}
		seen.add(uid);
		const isRouter = displayOption === DisplayOption.MODEL_ROUTER || config.modelInfo?.isModelRouter === true;
		specs.push(devinModelSpec(config, uid, baseUrl, isRouter));
		// A router is a server-side dispatcher, not an effort tier: it stays a
		// standalone model even when upstream files it under a family.
		if (!isRouter) {
			collectDevinFamilyLane(lanes, config, uid);
		}
	}

	// Server-declared families first — they are live truth for wire uids, per
	// effort routes, and the native default. The static table then collapses
	// whatever upstream served without family metadata; families already
	// collapsed above pass through it untouched.
	const families = devinDynamicFamilies(lanes.values());
	const dynamic = families.length > 0 ? collapseEffortVariants(specs, { families }) : specs;
	const collapsed = collapseEffortVariants(dynamic, DEVIN_VARIANT_COLLAPSE_TABLE);
	return collapsed.sort((a, b) => a.id.localeCompare(b.id));
}
