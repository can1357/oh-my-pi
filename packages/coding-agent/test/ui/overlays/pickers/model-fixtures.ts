/** The models and preferences the `overlays/model-*` corpus cases were captured with. */
import type { Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import type { ModelBrowserSource } from "../../../../src/modes/view-model/overlays/model-browser";

export function model(provider: string, id: string, extra: Partial<Model> = {}): Model {
	return buildModel({
		id,
		name: id,
		api: "openai-completions",
		provider,
		baseUrl: "http://127.0.0.1/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 3, output: 15, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 8192,
		...extra,
	} as Parameters<typeof buildModel>[0]);
}

/** `thinking` is a catalog field `Partial<Model>` does not list. */
const efforts = (list: Effort[]): Partial<Model> => ({ thinking: { mode: "effort", efforts: list } }) as Partial<Model>;

export const MODELS: Model[] = [
	model("anthropic", "claude-sonnet-5-5", {
		int: 60,
		isNew: true,
		description: "Balanced model for everyday coding tasks.",
	}),
	model("anthropic", "claude-opus-5", { isRecommended: true, input: ["text", "image"], tps: 80 }),
	model("demo", "demo", efforts([Effort.Low, Effort.Medium, Effort.High])),
	model("demo", "demo-lite", efforts([Effort.Low, Effort.Medium])),
	model("openai", "gpt-5.6", { isBeta: true, int: 71.4 }),
	model("openai", "gpt-5.6-mini", { cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }),
	model("local", "tiny", { reasoning: false, contextWindow: 4096 }),
	model("unicode", "模型-日本語-🚀-very-long-identifier-that-overflows-every-narrow-width", {
		contextWindow: 1_000_000,
	}),
];

export function source(roles: Record<string, string>, mru: string[]): ModelBrowserSource {
	return {
		revision: 0,
		defaultThinkingLevel: "off",
		modelProviderOrder: [],
		knownRoleIds: ["default", "smol"],
		mruOrder: mru,
		modelPerf: new Map([
			["openai/gpt-5.6", { samples: 4, tps: 25, ttftMs: 500 }],
			["openai/gpt-5.6@ultrafast", { samples: 2, tps: 300, ttftMs: 120 }],
			["demo/demo-lite@flex", { samples: 1, tps: 12, ttftMs: null }],
		]),
		getRoleInfo: role => ({ tag: role, name: `${role} role`, section: "chat", accepts: () => true }),
		defaultRoleChain: () => [],
		resolveRoleValue: (value, models) => ({
			model: models.find(candidate => `${candidate.provider}/${candidate.id}` === value),
			explicitThinkingLevel: false,
		}),
		getModelRole: role => roles[role],
	};
}
