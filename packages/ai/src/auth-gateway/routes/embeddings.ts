import { embed } from "../../embeddings";
import type { EmbeddingResult } from "../../embeddings/types";
import * as embeddings from "../../providers/embeddings-server";
import type { AuthGatewayRouteOptions } from "../dispatch";
import { handleUnaryGatewayRoute, type UnaryGatewayRoute } from "./unary";

const ROUTE: UnaryGatewayRoute<embeddings.EmbeddingsParsedRequest, EmbeddingResult> = {
	format: "embeddings",
	failure: "embeddings",
	parse: embeddings.parseRequest,
	parseErrorStatus: error => (error instanceof embeddings.EmbeddingsWireError ? error.status : 400),
	unsupported: (model, modelId) =>
		model.api === "openai-embeddings" ? undefined : `Model ${modelId} does not support embeddings`,
	call: (model, parsed, options) => embed(model, parsed.request, options),
	encode: (result, parsed) => embeddings.encodeResponse(result, parsed.modelId),
};

/** OpenAI-compatible `POST /v1/embeddings` gateway handler. */
export function handleEmbeddings(bootOpts: AuthGatewayRouteOptions, req: Request, peer: string): Promise<Response> {
	return handleUnaryGatewayRoute(ROUTE, bootOpts, req, peer);
}
