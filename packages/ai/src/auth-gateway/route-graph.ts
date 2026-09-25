import type { Api, Model } from "../types";

export type TargetNode = { type: "target"; model: string };

export interface CompiledRoute {
	generation: number;
	id: string;
	root: TargetNode;
}

type ResolveModel = (modelId: string) => Model<Api> | undefined;

/**
 * Wave A compiled-route shim: wrap a model resolver so a known model is one
 * {@link TargetNode} at a frozen generation. Unknown ids stay undefined
 * (gateway 404). No YAML loader, no nested nodes.
 */
export class RouteRegistry {
	#generation = 1;
	#resolveModel: ResolveModel;

	constructor(resolveModel: ResolveModel) {
		this.#resolveModel = resolveModel;
	}

	get generation(): number {
		return this.#generation;
	}

	resolve(modelId: string): CompiledRoute | undefined {
		const model = this.#resolveModel(modelId);
		if (!model) return undefined;
		// Preserve provider-qualified ids (`openai/gpt-5`) as the compiled target.
		const target = modelId.includes("/") ? modelId : model.id;
		return {
			generation: this.#generation,
			id: modelId,
			root: { type: "target", model: target },
		};
	}
}
