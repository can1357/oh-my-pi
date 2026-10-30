import { type Api, type ModelKind, runnerApiKind } from "@oh-my-pi/pi-catalog/types";
import { isJudgmentApi } from "../judgment/native";
import { isSpeechApi } from "../speech";

/** Image APIs `/v1/images/*` serves; the hosted Responses pair needs a carrier model the gateway cannot resolve. */
const GATEWAY_IMAGE_APIS: Readonly<Partial<Record<Api, true>>> = {
	"openai-images": true,
	"openrouter-images": true,
	"google-generative-ai": true,
	"google-gemini-cli": true,
	"factory-droid-agent": true,
};

/**
 * Whether the gateway route for a model of `kind` accepts `api`. The routes answer `400` for any other API, so
 * the served catalog and stdio fallback chains use this to skip models no route can run. On-device
 * `local-inference` runners never qualify.
 */
export function gatewayRouteAccepts(kind: ModelKind, api: Api): boolean {
	switch (kind) {
		case "chat":
			return api !== "local-inference";
		case "judge":
			return isJudgmentApi(api);
		case "image":
			return GATEWAY_IMAGE_APIS[api] === true;
		case "tts":
			return isSpeechApi(api);
		case "stt":
			return runnerApiKind(api) === "stt";
		case "embedding":
			return api === "openai-embeddings";
		case "rerank":
			return api === "openrouter-rerank";
		case "video":
			return api === "openrouter-video";
		default:
			return false;
	}
}
