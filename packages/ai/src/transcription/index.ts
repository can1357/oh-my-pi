import type { Api, Model } from "@oh-my-pi/pi-catalog/types";
import * as AIError from "../error";
import { transcribeOpenAI, type TranscriptionOptions } from "./openai-transcriptions";
import { transcribeOpenAICodex } from "./openai-codex-transcriptions";
import type { TranscriptionRequest, TranscriptionResult } from "./types";

export * from "./openai-transcriptions";
export * from "./openai-codex-transcriptions";
export * from "./types";

/** Catalog APIs {@link transcribeAudio} serves through a cloud transport (local inference is tool-only). */
export const CLOUD_TRANSCRIPTION_APIS = ["openai-transcriptions", "openai-codex-transcriptions"] as const;
export type CloudTranscriptionApi = (typeof CLOUD_TRANSCRIPTION_APIS)[number];

/** Whether a catalog API transcribes audio through one of the pi-ai cloud clients. */
export function isCloudTranscriptionApi(api: Api | string | undefined): api is CloudTranscriptionApi {
	return (CLOUD_TRANSCRIPTION_APIS as readonly (string | undefined)[]).includes(api);
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
		case "openai-codex-transcriptions":
			return transcribeOpenAICodex(model, request, options);
		default:
			throw new AIError.ConfigurationError(`Unsupported transcription API: ${model.api}`);
	}
}
