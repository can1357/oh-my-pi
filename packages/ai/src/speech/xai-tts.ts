import type { Api, Model } from "@oh-my-pi/pi-catalog/types";
import * as AIError from "../error";
import { postSpeechRequest } from "./transport";
import type { SpeechOptions, SpeechRequest, SpeechResult } from "./types";

export const DEFAULT_XAI_VOICE_ID = "eve";
export const DEFAULT_XAI_LANGUAGE = "auto";
export const DEFAULT_XAI_SAMPLE_RATE = 24_000;
export const DEFAULT_XAI_BIT_RATE = 128_000;
/** docs.x.ai text-to-speech `text` limit (60,000 characters, 2026-11). */
export const XAI_MAX_TEXT_LENGTH = 60_000;

export async function synthesizeXaiSpeech(
	model: Model<Api>,
	request: SpeechRequest,
	options: SpeechOptions,
): Promise<SpeechResult> {
	if (request.text.length > XAI_MAX_TEXT_LENGTH) {
		throw new AIError.ValidationError(`xai-tts input exceeds the ${XAI_MAX_TEXT_LENGTH}-character limit`);
	}
	if (request.format !== "mp3" && request.format !== "wav" && request.format !== "pcm") {
		throw new AIError.ValidationError(`xai-tts does not support ${request.format} output; use mp3, wav or pcm`);
	}
	if (request.instructions !== undefined) throw new AIError.ValidationError("xai-tts does not support instructions");

	const sampleRate = request.sampleRate ?? DEFAULT_XAI_SAMPLE_RATE;
	const bitRate = request.bitRate ?? DEFAULT_XAI_BIT_RATE;
	const payload: Record<string, unknown> = {
		text: request.text,
		voice_id: request.voice ?? DEFAULT_XAI_VOICE_ID,
		language: request.language ?? DEFAULT_XAI_LANGUAGE,
	};
	// xAI validates the 0.7–1.5 multiplier range itself.
	if (request.speed !== undefined) payload.speed = request.speed;
	const codecOverridden = request.format !== "mp3";
	const sampleRateOverridden = sampleRate !== DEFAULT_XAI_SAMPLE_RATE;
	const bitRateOverridden = request.format === "mp3" && bitRate !== DEFAULT_XAI_BIT_RATE;
	if (codecOverridden || sampleRateOverridden || bitRateOverridden) {
		const outputFormat: Record<string, unknown> = { codec: request.format };
		if (sampleRate > 0) outputFormat.sample_rate = sampleRate;
		if (request.format === "mp3" && bitRate > 0) outputFormat.bit_rate = bitRate;
		payload.output_format = outputFormat;
	}
	return postSpeechRequest(model, "/tts", payload, request.format, options);
}
