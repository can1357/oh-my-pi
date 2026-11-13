import type { Api, Model } from "@oh-my-pi/pi-catalog/types";
import * as AIError from "../error";
import { synthesizeOpenAiSpeech } from "./openai-speech";
import type { SpeechFormat, SpeechOptions, SpeechRequest, SpeechResult } from "./types";
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

/** Whether a speech model returns `format`; a model without `speechFormats` accepts every format. */
export function speechModelSupportsFormat(model: Model<Api>, format: SpeechFormat): boolean {
	return model.speechFormats?.includes(format) ?? true;
}

/**
 * Synthesize speech through the transport selected by the catalog model's `api`.
 * A request without a voice takes the model's configured default (`voice`).
 */
export function synthesizeSpeech(
	model: Model<Api>,
	request: SpeechRequest,
	options: SpeechOptions,
): Promise<SpeechResult> {
	if (request.voice === undefined && model.voice !== undefined) request = { ...request, voice: model.voice };
	switch (model.api) {
		case "xai-tts":
			return synthesizeXaiSpeech(model, request, options);
		case "openai-speech":
			return synthesizeOpenAiSpeech(model, request, options);
		default:
			throw new AIError.ConfigurationError(`Unsupported speech API: ${model.api}`);
	}
}
