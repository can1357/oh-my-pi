import type { Api, Model } from "@oh-my-pi/pi-catalog/types";
import * as AIError from "../error";
import { transcribeCodex } from "./codex-transcriptions";
import { transcribeOpenAI, type TranscriptionOptions } from "./openai-transcriptions";
import type { TranscriptionRequest, TranscriptionResult } from "./types";

export * from "./codex-transcriptions";
export { TranscriptionApiError, transcribeOpenAI } from "./openai-transcriptions";
export type { TranscriptionOptions } from "./openai-transcriptions";
export * from "./types";

/** APIs {@link transcribeAudio} can dispatch; callers branch on this, not on a literal. */
export function isTranscriptionApi(api: string): boolean {
	return api === "openai-transcriptions" || api === "openai-codex-transcriptions";
}

/** Dispatch an audio transcription through the transport selected by the catalog model. */
export function transcribeAudio(
	model: Model<Api>,
	request: TranscriptionRequest,
	options: TranscriptionOptions,
): Promise<TranscriptionResult> {
	if (model.api === "openai-transcriptions") return transcribeOpenAI(model, request, options);
	if (model.api === "openai-codex-transcriptions") return transcribeCodex(model, request, options);
	throw new AIError.ConfigurationError(`Unsupported transcription API: ${model.api}`);
}
