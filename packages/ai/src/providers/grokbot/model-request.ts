/** Map omp model ids to Grok Bot InferenceRequestedModel. */

import type { Effort } from "@oh-my-pi/pi-catalog/effort";

export type GrokbotRequestedParameter = { id: string; value: string };

export type GrokbotRequestedModel = {
	modelId: string;
	maxMode?: boolean;
	parameters?: GrokbotRequestedParameter[];
};

export type GrokbotRequestedModelOptions = {
	/** omp effort level; mapped onto sand `parameters[{id:effort}]`. */
	effort?: Effort | string;
	/** sand `fast` parameter; defaults to true for parameterized models. */
	fast?: boolean;
};

const BARE_ALIASES = new Set([
	"default",
	"auto",
	"auto-low",
	"auto-medium",
	"auto-high",
	"auto-smart",
	"sand-cua",
	"sand-automation",
	"sand-mock",
	"premium",
]);

const SAND_DEFAULT_MODEL_ID = "grok-4.5";

/** Map omp Effort / string to Grok Bot effort wire values. */
export function toSandEffortValue(effort: Effort | string | undefined): string {
	const raw = typeof effort === "string" ? effort : "high";
	switch (raw) {
		case "minimal":
		case "low":
			return "low";
		case "medium":
			return "medium";
		case "xhigh":
		case "max":
			return "xhigh";
		case "high":
		default:
			return "high";
	}
}

function parameterizedModel(modelId: string, options?: GrokbotRequestedModelOptions): GrokbotRequestedModel {
	const effort = toSandEffortValue(options?.effort);
	const fast = options?.fast === false ? "false" : "true";
	return {
		modelId,
		maxMode: true,
		parameters: [
			{ id: "effort", value: effort },
			{ id: "fast", value: fast },
		],
	};
}

export function resolveGrokbotRequestedModel(
	modelId: string,
	options?: GrokbotRequestedModelOptions,
): GrokbotRequestedModel {
	const raw = typeof modelId === "string" ? modelId : SAND_DEFAULT_MODEL_ID;
	const slug = raw.startsWith("grokbot/") ? raw.slice("grokbot/".length) : raw;
	if (slug === "sand-default") {
		return parameterizedModel(SAND_DEFAULT_MODEL_ID, options);
	}
	if (BARE_ALIASES.has(slug)) return { modelId: slug };
	return parameterizedModel(slug, options);
}

export function isGrokbotBareAlias(modelId: string): boolean {
	const slug = modelId.startsWith("grokbot/") ? modelId.slice("grokbot/".length) : modelId;
	return BARE_ALIASES.has(slug);
}
