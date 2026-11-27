import * as transcriptions from "../../providers/transcriptions-server";
import { isTranscriptionApi, transcribeAudio } from "../../transcription";
import type { TranscriptionResult } from "../../transcription/types";
import type { AuthGatewayRouteOptions } from "../dispatch";
import { handleUnaryGatewayRoute, type UnaryGatewayRoute } from "./unary";

const ROUTE: UnaryGatewayRoute<transcriptions.TranscriptionParsedRequest, TranscriptionResult> = {
	format: "transcriptions",
	failure: "transcription",
	parse: transcriptions.parseRequest,
	parseErrorStatus: error => (error instanceof transcriptions.TranscriptionWireError ? error.status : 400),
	unsupported: (model, modelId) => {
		if (isTranscriptionApi(model.api)) return undefined;
		return model.api === "local-inference"
			? `Model ${modelId} runs on-device only and cannot be served by the auth gateway`
			: `Model ${modelId} does not support audio transcription`;
	},
	call: (model, parsed, options) => transcribeAudio(model, parsed.request, options),
	encode: result => transcriptions.encodeResponse(result),
};

/** OpenAI-compatible `POST /v1/audio/transcriptions` gateway handler. */
export function handleTranscriptions(bootOpts: AuthGatewayRouteOptions, req: Request, peer: string): Promise<Response> {
	return handleUnaryGatewayRoute(ROUTE, bootOpts, req, peer);
}
