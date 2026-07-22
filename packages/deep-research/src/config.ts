import type { Model } from "@pk-nerdsaver-ai/pi-ai";
import type { GeneratedProvider } from "@pk-nerdsaver-ai/pi-catalog/models";
import { getBundledModel, getBundledProviders } from "@pk-nerdsaver-ai/pi-catalog/models";
import type { DeepResearchConfig, DeepResearchConfigInput, ModelSpec, UsageTotals } from "./types";

export const DEFAULT_CONFIG: DeepResearchConfig = {
	researchModel: "openai:gpt-4.1",
	summarizationModel: "openai:gpt-4.1-mini",
	compressionModel: "openai:gpt-4.1",
	finalReportModel: "openai:gpt-4.1",
	researchModelMaxTokens: 10000,
	summarizationModelMaxTokens: 8192,
	compressionModelMaxTokens: 8192,
	finalReportModelMaxTokens: 10000,
	allowClarification: true,
	maxConcurrentResearchUnits: 5,
	maxResearcherIterations: 6,
	maxReactToolCalls: 10,
	maxStructuredOutputRetries: 3,
	searchApi: "tavily",
	tavilyMaxResults: 5,
	tavilyTopic: "general",
	maxContentLength: 50000,
	extraTools: [],
	extraToolInstructions: "",
	modelOptions: {},
	fetch: globalThis.fetch.bind(globalThis),
	onEvent: () => {},
};

export function resolveConfig(input: DeepResearchConfigInput = {}): DeepResearchConfig {
	return { ...DEFAULT_CONFIG, ...input };
}

/** Resolve a model spec ("provider:model-id" or a Model) to a catalog Model. */
export function resolveModel(spec: ModelSpec): Model {
	if (typeof spec !== "string") return spec;
	const separator = spec.indexOf(":");
	if (separator <= 0) {
		throw new Error(`Invalid model spec "${spec}". Expected "provider:model-id" (e.g. "openai:gpt-4.1").`);
	}
	const provider = spec.slice(0, separator);
	const modelId = spec.slice(separator + 1);
	const knownProviders: readonly string[] = getBundledProviders();
	if (!knownProviders.includes(provider)) {
		throw new Error(
			`Unknown provider "${provider}" in model spec "${spec}" — not found in the bundled model catalog.`,
		);
	}
	const model = getBundledModel(provider as GeneratedProvider, modelId);
	if (!model) {
		throw new Error(`Unknown model "${spec}" — not found in the bundled model catalog.`);
	}
	return model;
}

export function emptyUsageTotals(): UsageTotals {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: 0 };
}

/** Fully resolved per-run state shared by every stage. */
export interface RunContext {
	config: DeepResearchConfig;
	models: {
		research: Model;
		summarization: Model;
		compression: Model;
		finalReport: Model;
	};
	usage: UsageTotals;
}

export function createRunContext(input: DeepResearchConfigInput = {}): RunContext {
	const config = resolveConfig(input);
	return {
		config,
		models: {
			research: resolveModel(config.researchModel),
			summarization: resolveModel(config.summarizationModel),
			compression: resolveModel(config.compressionModel),
			finalReport: resolveModel(config.finalReportModel),
		},
		usage: emptyUsageTotals(),
	};
}
