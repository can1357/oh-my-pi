import * as rerankWire from "../../providers/rerank-server";
import { rerank } from "../../rerank";
import type { RerankResult } from "../../rerank/types";
import type { AuthGatewayRouteOptions } from "../dispatch";
import { handleUnaryGatewayRoute, type UnaryGatewayRoute } from "./unary";

const ROUTE: UnaryGatewayRoute<rerankWire.RerankParsedRequest, RerankResult> = {
	format: "rerank",
	failure: "rerank",
	parse: rerankWire.parseRequest,
	parseErrorStatus: error => (error instanceof rerankWire.RerankWireError ? error.status : 400),
	unsupported: (model, modelId) =>
		model.api === "openrouter-rerank" ? undefined : `Model ${modelId} does not support reranking`,
	call: (model, parsed, options) => rerank(model, parsed.request, options),
	encode: (result, parsed) =>
		rerankWire.encodeResponse(
			result,
			parsed.modelId,
			parsed.originalDocuments,
			parsed.request.returnDocuments ?? false,
		),
};

/** OpenRouter-compatible `POST /v1/rerank` gateway handler. */
export function handleRerank(bootOpts: AuthGatewayRouteOptions, req: Request, peer: string): Promise<Response> {
	return handleUnaryGatewayRoute(ROUTE, bootOpts, req, peer);
}
