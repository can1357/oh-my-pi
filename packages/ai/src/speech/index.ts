import type { Api, Model } from "@oh-my-pi/pi-catalog/types";
import * as AIError from "../error";
import { synthesizeOpenAiSpeech } from "./openai-speech";
import type { SpeechOptions, SpeechRequest, SpeechResult } from "./types";
import { synthesizeXaiSpeech } from "./xai-tts";

export * from "./openai-speech";
export * from "./transport";
export * from "./types";
export * from "./xai-tts";

/** Catalog APIs {@link synthesizeSpeech} serves; the `tts` tool and the gateway gate on these. */
export const SPEECH_APIS = ["xai-tts", "openai-speech"] as const;
export type SpeechApi = (typeof SPEECH_APIS)[number];

/** Whether a catalog API synthesizes speech through a cloud transport (local inference is tool-only). */
export function isSpeechApi(api: Api): api is SpeechApi {
	return api === "xai-tts" || api === "openai-speech";
}

/** Synthesize speech through the transport selected by the catalog model's `api`. */
export function synthesizeSpeech(
	model: Model<Api>,
	request: SpeechRequest,
	options: SpeechOptions,
): Promise<SpeechResult> {
	switch (model.api) {
		case "xai-tts":
			return synthesizeXaiSpeech(model, request, options);
		case "openai-speech":
			return synthesizeOpenAiSpeech(model, request, options);
		default:
			throw new AIError.ConfigurationError(`Unsupported speech API: ${model.api}`);
	}
}
