import type { Api, Model } from "@oh-my-pi/pi-catalog/types";
import * as AIError from "../error";
import { rerankOpenRouter, type RerankOptions } from "./openrouter-rerank";
import type { RerankRequest, RerankResult } from "./types";

export * from "./openrouter-rerank";
export * from "./types";

/** Dispatch reranking through the transport selected by the catalog model. */
export function rerank(model: Model<Api>, request: RerankRequest, options: RerankOptions): Promise<RerankResult> {
	if (model.api === "openrouter-rerank") return rerankOpenRouter(model, request, options);
	throw new AIError.ConfigurationError(`Unsupported rerank API: ${model.api}`);
}
