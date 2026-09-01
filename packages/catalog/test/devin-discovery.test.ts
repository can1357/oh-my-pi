import { beforeAll, describe, expect, it } from "bun:test";
import type { FetchImpl } from "@oh-my-pi/pi-utils";
// Import from source, not the package specifier: the workspace `node_modules`
// copy resolves to the primary checkout, not this worktree.
import { buildModel } from "../src/build";
import { fetchDevinModels } from "../src/discovery/devin";
import {
	type ClientModelConfig,
	ClientModelConfigSchema,
	DisplayOption,
	GetCliModelConfigsRequestSchema,
	GetCliModelConfigsResponseSchema,
	type Metadata,
	ModelDimensionKind,
	ModelDimensionSchema,
	type ModelFamilyMetadataEntry,
	ModelFamilyMetadataEntrySchema,
	ModelFamilyMetadataSchema,
	ModelFamilyMetadataValueSchema,
	ModelFeaturesSchema,
	ModelInfoSchema,
} from "../src/discovery/devin-proto";
import { create, fromBinary, toBinary } from "../src/discovery/protobuf";
import { Effort } from "../src/effort";
import { CATALOG_PROVIDERS } from "../src/provider-models/descriptors";
import { DEVIN_STATIC_MODELS, devinModelManagerOptions } from "../src/provider-models/special";
import type { ModelSpec, ThinkingConfig } from "../src/types";

/** `DISPLAY_OPTION_INTERNAL_DEFAULT`, absent from the vendored descriptor's enum. */
const DISPLAY_OPTION_INTERNAL_DEFAULT = 6 as DisplayOption;
/** `DISPLAY_OPTION_NORMAL`: the visible slot used beside `UNSPECIFIED`. */
const DISPLAY_OPTION_NORMAL = 8 as DisplayOption;

interface ConfigInit {
	uid: string;
	label?: string;
	disabled?: boolean;
	displayOption?: DisplayOption;
	isModelRouter?: boolean;
	/** `ClientModelConfig.maxTokens` — the context window. */
	contextWindow?: number;
	maxOutputTokens?: number;
	features?: {
		supportsThinking?: boolean;
		supportsToolCalls?: boolean;
		supportsParallelToolCalls?: boolean;
		supportsImages?: boolean;
	};
	supportsImages?: boolean;
	dimensions?: readonly { label: string; value: number; denominator?: string }[];
	/** `modelFamilyMetadata.modelFamilyLabel`. */
	family?: string;
	/** `Reasoning Effort` entry name; omitted means the family has no effort axis. */
	effort?: string;
	effortOrder?: number;
	/** `Fast Mode` entry: `true` -> order 1 (fast lane), `false` -> order 0. */
	fast?: boolean;
	/** `Thinking` entry: `true` -> order 1, `false` -> order 0. */
	thinking?: boolean;
	/** `1M Context` entry: `true` -> order 1, `false` -> order 0. */
	oneMillionContext?: boolean;
	isDefault?: boolean;
	/** Emit no `modelInfo` at all — the pre-`modelFeatures` config shape. */
	omitModelInfo?: boolean;
	/** `ClientModelConfig.description` — the server's own blurb. */
	description?: string;
	isNew?: boolean;
	isBeta?: boolean;
	isRecommended?: boolean;
}

function config(init: ConfigInit): ClientModelConfig {
	const entries: ModelFamilyMetadataEntry[] = [];
	if (init.effort !== undefined) {
		entries.push(
			create(ModelFamilyMetadataEntrySchema, {
				key: "Reasoning Effort",
				value: create(ModelFamilyMetadataValueSchema, { name: init.effort, order: init.effortOrder ?? 0 }),
			}),
		);
	}
	if (init.fast !== undefined) {
		entries.push(
			create(ModelFamilyMetadataEntrySchema, {
				key: "Fast Mode",
				value: create(ModelFamilyMetadataValueSchema, {
					name: init.fast ? "Fast" : "Standard",
					order: init.fast ? 1 : 0,
				}),
			}),
		);
	}
	if (init.thinking !== undefined) {
		entries.push(
			create(ModelFamilyMetadataEntrySchema, {
				key: "Thinking",
				value: create(ModelFamilyMetadataValueSchema, {
					name: init.thinking ? "Thinking" : "No Thinking",
					order: init.thinking ? 1 : 0,
				}),
			}),
		);
	}
	if (init.oneMillionContext !== undefined) {
		entries.push(
			create(ModelFamilyMetadataEntrySchema, {
				key: "1M Context",
				value: create(ModelFamilyMetadataValueSchema, {
					name: init.oneMillionContext ? "1M Context" : "Standard Context",
					order: init.oneMillionContext ? 1 : 0,
				}),
			}),
		);
	}
	return create(ClientModelConfigSchema, {
		label: init.label ?? init.uid,
		modelUid: init.uid,
		disabled: init.disabled ?? false,
		supportsImages: init.supportsImages ?? false,
		maxTokens: init.contextWindow ?? 200_000,
		isDefaultModelInFamily: init.isDefault ?? false,
		description: init.description,
		isNew: init.isNew ?? false,
		isBeta: init.isBeta ?? false,
		isRecommended: init.isRecommended ?? false,
		modelDimensions: (init.dimensions ?? []).map(dimension =>
			create(ModelDimensionSchema, {
				label: dimension.label,
				value: dimension.value,
				denominator: dimension.denominator ?? "1M tokens",
				kind: ModelDimensionKind.COST,
			}),
		),
		...(init.family !== undefined
			? {
					modelFamilyMetadata: create(ModelFamilyMetadataSchema, {
						modelFamilyLabel: init.family,
						entries,
					}),
				}
			: {}),
		...(init.omitModelInfo === true
			? {}
			: {
					modelInfo: create(ModelInfoSchema, {
						modelUid: init.uid,
						displayOption: init.displayOption ?? DisplayOption.UNSPECIFIED,
						maxOutputTokens: init.maxOutputTokens ?? 64_000,
						isModelRouter: init.isModelRouter ?? false,
						...(init.features !== undefined ? { modelFeatures: create(ModelFeaturesSchema, init.features) } : {}),
					}),
				}),
	});
}

/** One family lane: `<uid prefix>-<effort>` members, native default marked. */
function tiers(
	family: string,
	prefix: string,
	efforts: readonly { name: string; uid?: string; default?: boolean }[],
	options?: { fast?: boolean },
): ClientModelConfig[] {
	return efforts.map((effort, index) =>
		config({
			uid: effort.uid ?? `${prefix}-${effort.name.toLowerCase()}`,
			label: `${family} (${effort.name})`,
			family,
			effort: effort.name,
			effortOrder: index,
			fast: options?.fast ?? false,
			isDefault: effort.default ?? false,
			displayOption: DISPLAY_OPTION_NORMAL,
			contextWindow: 400_000,
		}),
	);
}

const FIXTURE_CONFIGS: readonly ClientModelConfig[] = [
	// Live-shaped server families.
	...tiers("Gemini 3.7 Flash", "gemini-3-7-flash", [
		{ name: "Minimal" },
		{ name: "Low" },
		{ name: "Medium", default: true },
		{ name: "High" },
	]),
	...tiers("SWE-1.7 Lightning", "swe-1-7-lightning", [
		{ name: "Medium", default: true },
		// The `Max` tier is served by the bare family uid.
		{ name: "Max", uid: "swe-1-7-lightning" },
	]),
	...tiers("Grok 4.6", "grok-4-6", [
		{ name: "Low" },
		{ name: "Medium", default: true },
		{ name: "High" },
		{ name: "XHigh" },
	]),
	...tiers("DeepSeek V4 Flash", "deepseek-v4-flash", [
		{ name: "Low" },
		{ name: "High", default: true },
		{ name: "Max" },
	]),
	...tiers("DeepSeek V4 Pro", "deepseek-v4-pro", [{ name: "Low" }, { name: "High", default: true }, { name: "Max" }]),
	...tiers("Nemotron 3 Ultra", "nemotron-3-ultra", [
		{ name: "None", uid: "nemotron-3-ultra-none" },
		{ name: "Medium" },
		{ name: "High", default: true },
	]),
	// Fast Mode split: two lanes over one family label, each with its own default.
	...tiers("Claude Opus 5", "claude-opus-5", [{ name: "Medium", default: true }, { name: "High" }]),
	...tiers(
		"Claude Opus 5",
		"claude-opus-5",
		[
			{ name: "Medium", uid: "claude-opus-5-medium-fast" },
			{ name: "High", uid: "claude-opus-5-high-fast", default: true },
		],
		{ fast: true },
	),
	// Thinking and context are independent native axes. They become an off/high
	// effort pair on standard and 1M logical model lanes.
	config({
		uid: "claude-sonnet-4-6",
		label: "Claude Sonnet 4.6",
		family: "Claude Sonnet 4.6",
		effort: "High",
		effortOrder: 3,
		thinking: false,
		oneMillionContext: false,
		contextWindow: 200_000,
	}),
	config({
		uid: "claude-sonnet-4-6-thinking",
		label: "Claude Sonnet 4.6 Thinking",
		family: "Claude Sonnet 4.6",
		effort: "High",
		effortOrder: 3,
		thinking: true,
		oneMillionContext: false,
		contextWindow: 200_000,
		isDefault: true,
	}),
	config({
		uid: "claude-sonnet-4-6-1m",
		label: "Claude Sonnet 4.6 1M",
		family: "Claude Sonnet 4.6",
		effort: "High",
		effortOrder: 3,
		thinking: false,
		oneMillionContext: true,
		contextWindow: 1_000_000,
	}),
	config({
		uid: "claude-sonnet-4-6-thinking-1m",
		label: "Claude Sonnet 4.6 Thinking 1M",
		family: "Claude Sonnet 4.6",
		effort: "High",
		effortOrder: 3,
		thinking: true,
		oneMillionContext: true,
		contextWindow: 1_000_000,
		isDefault: true,
	}),
	// A family the static fallback table has never heard of: collapsing it can
	// only come from the server's own `modelFamilyMetadata`.
	...tiers("Mercury 9.1 Ion", "mercury-9-1-ion", [
		{ name: "Low" },
		{ name: "High", default: true },
		{ name: "X High", uid: "mercury-9-1-ion-xhigh" },
	]),
	// Server-side router: standalone, no metadata of its own.
	config({
		uid: "adaptive",
		label: "Adaptive",
		displayOption: DisplayOption.MODEL_ROUTER,
		isModelRouter: true,
		contextWindow: 0,
		maxOutputTokens: 0,
		family: "Adaptive",
		effort: "Medium",
	}),
	// Internal display slots: requested so the server reveals them, never exposed.
	config({ uid: "quick-review-internal", displayOption: DisplayOption.QUICK_REVIEW }),
	config({ uid: "internal-default", displayOption: DISPLAY_OPTION_INTERNAL_DEFAULT }),
	config({ uid: "retired-model", disabled: true }),
	// Metadata normalization probes.
	config({
		uid: "long-output",
		label: "Long Output",
		contextWindow: 1_000_000,
		maxOutputTokens: 128_000,
		features: { supportsThinking: true, supportsToolCalls: true },
	}),
	config({
		uid: "priced-model",
		label: "Priced Model",
		features: {
			supportsThinking: false,
			supportsToolCalls: true,
			supportsParallelToolCalls: true,
			supportsImages: true,
		},
		dimensions: [
			{ label: "Input", value: 1.25 },
			{ label: "Cached input", value: 0.1 },
			{ label: "Output", value: 10 },
		],
	}),
	// Features present and authoritative: the effort-flavored label loses.
	config({ uid: "label-says-high", label: "Label Says High", features: { supportsThinking: false } }),
	// No `modelInfo`: the label heuristic is the only signal left.
	config({ uid: "legacy-thinking", label: "Legacy Model (Thinking)", omitModelInfo: true, supportsImages: true }),
	config({ uid: "legacy-plain", label: "Legacy Model", omitModelInfo: true }),
	// Family metadata with no effort axis: nothing to route, stays standalone.
	config({ uid: "solo-wire-uid", label: "Solo Family", family: "Solo Family", fast: false }),
	// Native presentation metadata: blurb plus every badge the server sets.
	config({
		uid: "badged-model",
		label: "Badged Model",
		description: "  Frontier coding model.  ",
		isNew: true,
		isBeta: true,
		isRecommended: true,
	}),
	// Live-verified quirk: SWE-1.6 lanes advertise `supports_images` while the
	// backend drops `ChatMessagePrompt.images` (#6072).
	config({
		uid: "swe-1-6",
		label: "SWE-1.6",
		features: { supportsThinking: true, supportsToolCalls: true, supportsImages: true },
	}),
	config({
		uid: "swe-1-6-fast",
		label: "SWE-1.6 Fast",
		features: { supportsToolCalls: true, supportsImages: true },
	}),
];

let models: ModelSpec<"devin-agent">[];
let requestMetadata: Metadata | undefined;

beforeAll(async () => {
	const payload = toBinary(
		GetCliModelConfigsResponseSchema,
		create(GetCliModelConfigsResponseSchema, { clientModelConfigs: [...FIXTURE_CONFIGS] }),
	);
	const fetchImpl: FetchImpl = async (_input, init) => {
		const body = init?.body as Uint8Array;
		requestMetadata = fromBinary(GetCliModelConfigsRequestSchema, new Uint8Array(body)).metadata;
		return new Response(payload, { status: 200, headers: { "content-type": "application/proto" } });
	};
	const fetched = await fetchDevinModels({ apiKey: "fixture-token", fetch: fetchImpl });
	if (fetched === null) {
		throw new Error("expected the fixture transport to yield devin models");
	}
	models = fetched;
});

function model(id: string): ModelSpec<"devin-agent"> {
	const found = models.find(entry => entry.id === id);
	if (found === undefined) {
		throw new Error(`missing devin model ${id}; got ${models.map(entry => entry.id).join(", ")}`);
	}
	return found;
}

function thinking(id: string): ThinkingConfig {
	const found = model(id).thinking;
	if (found === undefined) {
		throw new Error(`expected devin model ${id} to expose a thinking surface`);
	}
	return found;
}

describe("devin native discovery request", () => {
	it("announces the native chisel client and every supported display slot", () => {
		expect(requestMetadata?.ideName).toBe("chisel");
		expect(requestMetadata?.ideVersion).toBe("0.0.0-dev");
		expect(requestMetadata?.extensionName).toBe("chisel");
		expect(requestMetadata?.extensionVersion).toBe("0.0.0-dev");
		expect(requestMetadata?.locale).toBe("en");
		expect(requestMetadata?.os).toBe(process.platform === "win32" ? "windows" : process.platform);
		expect(requestMetadata?.supportedModelDisplays).toEqual([
			DisplayOption.MODEL_ROUTER,
			DisplayOption.QUICK_REVIEW,
			DISPLAY_OPTION_INTERNAL_DEFAULT,
			7 as DisplayOption,
			DISPLAY_OPTION_NORMAL,
		]);
		expect(requestMetadata?.apiKey).toBe("devin-session-token$fixture-token");
	});

	it("treats an empty-but-200 catalog as failed discovery so the seed survives", async () => {
		const emptyPayload = toBinary(
			GetCliModelConfigsResponseSchema,
			create(GetCliModelConfigsResponseSchema, { clientModelConfigs: [] }),
		);
		const fetchImpl: FetchImpl = async () =>
			new Response(emptyPayload, { status: 200, headers: { "content-type": "application/proto" } });
		expect(await fetchDevinModels({ apiKey: "fixture-token", fetch: fetchImpl })).toBeNull();
	});

	it("treats a catalog with no usable configs as failed discovery so the seed survives", async () => {
		const filteredPayload = toBinary(
			GetCliModelConfigsResponseSchema,
			create(GetCliModelConfigsResponseSchema, {
				clientModelConfigs: [config({ uid: "disabled", disabled: true })],
			}),
		);
		const fetchImpl: FetchImpl = async () =>
			new Response(filteredPayload, { status: 200, headers: { "content-type": "application/proto" } });
		expect(await fetchDevinModels({ apiKey: "fixture-token", fetch: fetchImpl })).toBeNull();
	});
});

describe("devin native display filtering", () => {
	it("drops disabled configs and the internal display slots", () => {
		const ids = new Set(models.map(entry => entry.id));
		expect(ids.has("retired-model")).toBe(false);
		expect(ids.has("quick-review-internal")).toBe(false);
		expect(ids.has("internal-default")).toBe(false);
	});

	it("exposes the router once as a standalone model with safe defaults", () => {
		expect(models.filter(entry => entry.compat?.modelRouter === true).map(entry => entry.id)).toEqual(["adaptive"]);
		const adaptive = model("adaptive");
		expect(adaptive.name).toBe("Adaptive");
		expect(adaptive.requestModelId).toBeUndefined();
		expect(adaptive.thinking).toBeUndefined();
		expect(adaptive.supportsTools).toBe(true);
		expect(adaptive.contextWindow).toBe(200_000);
		expect(adaptive.maxTokens).toBe(64_000);
		expect(adaptive.baseUrl).toBe("https://server.codeium.com");
	});
});

describe("devin server metadata normalization", () => {
	it("takes the output cap from modelInfo.maxOutputTokens", () => {
		const longOutput = model("long-output");
		expect(longOutput.maxTokens).toBe(128_000);
		expect(longOutput.contextWindow).toBe(1_000_000);
		expect(longOutput.reasoning).toBe(true);
	});

	it("reads costs, parallel tool support and image support from server metadata", () => {
		const priced = model("priced-model");
		expect(priced.cost).toEqual({ input: 1.25, output: 10, cacheRead: 0.1, cacheWrite: 0 });
		expect(priced.compat?.supportsParallelToolCalls).toBe(true);
		expect(priced.input).toEqual(["text", "image"]);
		expect(priced.supportsTools).toBe(true);
		expect(model("long-output").compat?.supportsParallelToolCalls).toBeUndefined();
		expect(model("long-output").cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
	});

	it("prefers model features over the label heuristic, and falls back when features are absent", () => {
		expect(model("label-says-high").reasoning).toBe(false);
		expect(model("legacy-thinking").reasoning).toBe(true);
		expect(model("legacy-thinking").input).toEqual(["text", "image"]);
		expect(model("legacy-plain").reasoning).toBe(false);
	});

	it("strips the image modality from the SWE-1.6 lanes despite the server flag", () => {
		expect(model("swe-1-6").input).toEqual(["text"]);
		expect(model("swe-1-6-fast").input).toEqual(["text"]);
	});

	it("keeps the server's blurb and badges, and leaves them unset otherwise", () => {
		const badged = model("badged-model");
		expect(badged.description).toBe("Frontier coding model.");
		expect(badged.isNew).toBe(true);
		expect(badged.isBeta).toBe(true);
		expect(badged.isRecommended).toBe(true);

		const plain = model("long-output");
		expect(plain.description).toBeUndefined();
		expect(plain.isNew).toBeUndefined();
		expect(plain.isBeta).toBeUndefined();
		expect(plain.isRecommended).toBeUndefined();
	});
});

describe("devin server-declared family collapsing", () => {
	it("collapses the live effort ladders onto normalized family ids", () => {
		expect(thinking("gemini-3-7-flash").effortRouting).toEqual({
			minimal: "gemini-3-7-flash-minimal",
			low: "gemini-3-7-flash-low",
			medium: "gemini-3-7-flash-medium",
			high: "gemini-3-7-flash-high",
		});
		expect(thinking("grok-4-6").efforts).toEqual([Effort.Low, Effort.Medium, Effort.High, Effort.XHigh]);
		expect(thinking("deepseek-v4-flash").effortRouting).toEqual({
			low: "deepseek-v4-flash-low",
			high: "deepseek-v4-flash-high",
			max: "deepseek-v4-flash-max",
		});
		expect(thinking("deepseek-v4-pro").efforts).toEqual([Effort.Low, Effort.High, Effort.Max]);
		// The `Max` tier's wire uid is the bare family id: the raw row is consumed.
		expect(thinking("swe-1-7-lightning").effortRouting).toEqual({
			medium: "swe-1-7-lightning-medium",
			max: "swe-1-7-lightning",
		});
		expect(model("gemini-3-7-flash").name).toBe("Gemini 3.7 Flash");
		expect(models.some(entry => entry.id === "gemini-3-7-flash-medium")).toBe(false);
	});

	it("collapses a family the static fallback table does not know", () => {
		const mercury = thinking("mercury-9-1-ion");
		expect(mercury.effortRouting).toEqual({
			low: "mercury-9-1-ion-low",
			high: "mercury-9-1-ion-high",
			xhigh: "mercury-9-1-ion-xhigh",
		});
		expect(mercury.efforts).toEqual([Effort.Low, Effort.High, Effort.XHigh]);
		expect(mercury.requiresEffort).toBe(true);
		expect(model("mercury-9-1-ion").name).toBe("Mercury 9.1 Ion");
		expect(model("mercury-9-1-ion").requestModelId).toBe("mercury-9-1-ion-high");
		// The server's default tier becomes the family's default effort.
		expect(mercury.defaultLevel).toBe(Effort.High);
		expect(thinking("gemini-3-7-flash").defaultLevel).toBe(Effort.Medium);
		expect(thinking("claude-opus-5-fast").defaultLevel).toBe(Effort.High);
	});

	it("routes the family default wire uid and keeps the widest member limits", () => {
		expect(model("gemini-3-7-flash").requestModelId).toBe("gemini-3-7-flash-medium");
		expect(model("grok-4-6").requestModelId).toBe("grok-4-6-medium");
		expect(model("deepseek-v4-pro").requestModelId).toBe("deepseek-v4-pro-high");
		expect(model("swe-1-7-lightning").requestModelId).toBe("swe-1-7-lightning-medium");
		expect(model("gemini-3-7-flash").contextWindow).toBe(400_000);
		expect(model("gemini-3-7-flash").reasoning).toBe(true);
	});

	it("maps a None tier to the thinking-off route instead of requiring effort", () => {
		const nemotron = thinking("nemotron-3-ultra");
		expect(nemotron.effortRouting).toEqual({
			off: "nemotron-3-ultra-none",
			medium: "nemotron-3-ultra-medium",
			high: "nemotron-3-ultra-high",
		});
		expect(nemotron.efforts).toEqual([Effort.Medium, Effort.High]);
		expect(nemotron.requiresEffort).toBeUndefined();
		// The default wire uid stays the server's default tier; `off` only routes
		// thinking-disabled requests.
		expect(model("nemotron-3-ultra").requestModelId).toBe("nemotron-3-ultra-high");
		expect(thinking("gemini-3-7-flash").requiresEffort).toBe(true);
	});

	it("splits Fast Mode order 1 into a -fast sibling with its own default", () => {
		expect(thinking("claude-opus-5").effortRouting).toEqual({
			medium: "claude-opus-5-medium",
			high: "claude-opus-5-high",
		});
		expect(model("claude-opus-5").requestModelId).toBe("claude-opus-5-medium");
		expect(model("claude-opus-5-fast").name).toBe("Claude Opus 5 Fast");
		expect(thinking("claude-opus-5-fast").effortRouting).toEqual({
			medium: "claude-opus-5-medium-fast",
			high: "claude-opus-5-high-fast",
		});
		// Server truth wins over the static fallback table's five-tier ladder.
		expect(thinking("claude-opus-5-fast").efforts).toEqual([Effort.Medium, Effort.High]);
		expect(model("claude-opus-5-fast").requestModelId).toBe("claude-opus-5-high-fast");
	});

	it("splits context lanes and maps the Thinking axis onto off and high routes", () => {
		const standard = model("claude-sonnet-4-6");
		expect(standard.name).toBe("Claude Sonnet 4.6");
		expect(standard.contextWindow).toBe(200_000);
		expect(standard.requestModelId).toBe("claude-sonnet-4-6-thinking");
		expect(thinking("claude-sonnet-4-6").effortRouting).toEqual({
			off: "claude-sonnet-4-6",
			high: "claude-sonnet-4-6-thinking",
		});

		const longContext = model("claude-sonnet-4-6-1m");
		expect(longContext.name).toBe("Claude Sonnet 4.6 1M");
		expect(longContext.contextWindow).toBe(1_000_000);
		expect(longContext.requestModelId).toBe("claude-sonnet-4-6-thinking-1m");
		expect(thinking("claude-sonnet-4-6-1m").effortRouting).toEqual({
			off: "claude-sonnet-4-6-1m",
			high: "claude-sonnet-4-6-thinking-1m",
		});
	});

	it("keeps configs whose family declares no effort axis on their wire uid", () => {
		expect(model("solo-wire-uid").name).toBe("Solo Family");
		expect(model("solo-wire-uid").thinking).toBeUndefined();
		expect(models.some(entry => entry.id === "solo-family")).toBe(false);
	});
});

describe("devin catalog seed", () => {
	it("seeds both live SWE-1.6 lanes so the descriptor default resolves offline", () => {
		const descriptor = CATALOG_PROVIDERS.find(entry => entry.id === "devin");
		expect(descriptor?.defaultModel).toBe("swe-1-6");
		expect(DEVIN_STATIC_MODELS.map(model => model.id)).toEqual(["swe-1-6-fast", "swe-1-6"]);
		expect(DEVIN_STATIC_MODELS.some(model => model.id === descriptor?.defaultModel)).toBe(true);

		const fast = buildModel(DEVIN_STATIC_MODELS[0] as ModelSpec<"devin-agent">);
		expect(fast.cost).toEqual({ input: 0.3, output: 1.5, cacheRead: 0.03, cacheWrite: 0 });
		expect(fast.contextWindow).toBe(200_000);
		expect(fast.maxTokens).toBe(128_000);
		expect(fast.compat.supportsParallelToolCalls).toBe(true);
		// Image-blind lanes ship text-only (see DEVIN_IMAGE_BLIND_UIDS).
		expect(fast.input).toEqual(["text"]);
		// One wire uid per lane: Cascade encodes effort in the uid, so a seeded
		// lane reasons without exposing a selectable ladder.
		expect(fast.thinking).toBeUndefined();
		expect(fast.reasoning).toBe(true);
	});

	it("pins the seed to a configured Cascade host", () => {
		expect(devinModelManagerOptions().staticModels).toBe(DEVIN_STATIC_MODELS);
		const scoped = devinModelManagerOptions({ baseUrl: "https://cascade.internal" });
		expect(scoped.staticModels?.map(model => model.baseUrl)).toEqual([
			"https://cascade.internal",
			"https://cascade.internal",
		]);
	});
});
