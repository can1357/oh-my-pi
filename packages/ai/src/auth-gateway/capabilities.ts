import type { Api, Context, Model } from "../types";

export interface ModelCapabilities {
	text: boolean;
	vision: boolean;
	tools: boolean;
	parallelTools: boolean;
	reasoning: boolean;
	responsesApi: boolean;
	messagesApi: boolean;
	imageGeneration?: boolean;
	audio?: boolean;
	maxContext?: number;
	maxOutput?: number;
	stateFeatures?: string[];
}

export interface RouteCapabilities {
	guaranteed: ModelCapabilities;
	conditional: ModelCapabilities;
}

export interface RequestNeed {
	vision?: boolean;
	tools?: boolean;
	reasoning?: boolean;
}

type RequiredBooleanKey = "text" | "vision" | "tools" | "parallelTools" | "reasoning" | "responsesApi" | "messagesApi";

const REQUIRED_BOOLEAN_KEYS: readonly RequiredBooleanKey[] = [
	"text",
	"vision",
	"tools",
	"parallelTools",
	"reasoning",
	"responsesApi",
	"messagesApi",
];

function falseCapabilities(): ModelCapabilities {
	return {
		text: false,
		vision: false,
		tools: false,
		parallelTools: false,
		reasoning: false,
		responsesApi: false,
		messagesApi: false,
	};
}

/**
 * Derive per-model fabric capabilities. Text, tools, and parallel tool calls
 * default on; vision/reasoning/API surface come from the model record.
 */
export function capabilitiesFor(model: Model<Api>): ModelCapabilities {
	return {
		text: true,
		vision: model.input.includes("image"),
		tools: model.supportsTools !== false,
		parallelTools: model.supportsTools !== false,
		reasoning: model.reasoning,
		responsesApi:
			model.api.includes("responses") || model.api === "openai-codex-responses" || model.api === "openai-responses",
		messagesApi: model.api.includes("anthropic"),
	};
}

/**
 * AND guaranteed / OR-minus-AND conditional across target capability sets.
 * An empty list is all-false on both sides (empty AND is not treated as true).
 */
export function routeCapabilities(caps: readonly ModelCapabilities[]): RouteCapabilities {
	const guaranteed = falseCapabilities();
	const conditional = falseCapabilities();
	if (caps.length === 0) {
		return { guaranteed, conditional };
	}
	for (const key of REQUIRED_BOOLEAN_KEYS) {
		let all = true;
		let any = false;
		for (const cap of caps) {
			if (cap[key]) {
				any = true;
			} else {
				all = false;
			}
		}
		guaranteed[key] = all;
		conditional[key] = any && !all;
	}
	return { guaranteed, conditional };
}

/** True when `caps` satisfies every requested need flag. Absent needs are ignored. */
export function fitsRequest(caps: ModelCapabilities, need: RequestNeed): boolean {
	if (need.vision && !caps.vision) return false;
	if (need.tools && !caps.tools) return false;
	if (need.reasoning && !caps.reasoning) return false;
	return true;
}

/** Request facts shared by conditional route selection. */
export function requestNeeds(context: Context): RequestNeed {
	return {
		vision: context.messages.some(
			message => Array.isArray(message.content) && message.content.some(block => block.type === "image"),
		),
	};
}
