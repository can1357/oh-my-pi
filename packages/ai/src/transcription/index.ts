import type { Api, Model } from "@oh-my-pi/pi-catalog/types";
import * as AIError from "../error";
import { transcribeOpenAI, type TranscriptionOptions } from "./openai-transcriptions";
import type { TranscriptionRequest, TranscriptionResult } from "./types";
import { transcribeXai } from "./xai-stt";

export * from "./openai-transcriptions";
export * from "./types";
export * from "./xai-stt";

/** Catalog APIs {@link transcribeAudio} serves; dictation and the gateway gate on these. */
export const TRANSCRIPTION_APIS = ["openai-transcriptions", "xai-stt"] as const;
export type TranscriptionApi = (typeof TRANSCRIPTION_APIS)[number];

/** Whether a catalog API transcribes audio through a cloud transport (local inference streams on-device). */
export function isTranscriptionApi(api: Api): api is TranscriptionApi {
	return TRANSCRIPTION_APIS.some(id => id === api);
}

/** Dispatch an audio transcription through the transport selected by the catalog model. */
export function transcribeAudio(
	model: Model<Api>,
	request: TranscriptionRequest,
	options: TranscriptionOptions,
): Promise<TranscriptionResult> {
	switch (model.api) {
		case "openai-transcriptions":
			return transcribeOpenAI(model, request, options);
		case "xai-stt":
			return transcribeXai(model, request, options);
		default:
			throw new AIError.ConfigurationError(`Unsupported transcription API: ${model.api}`);
	}
}
