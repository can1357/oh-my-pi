import { type } from "@oh-my-pi/omptype";
import * as AIError from "../error";
import type { SpeechRequest, SpeechResult } from "../speech/types";

const speechRequestSchema = type({
	model: "string > 0",
	input: "string > 0",
	"voice?": "string > 0",
	"response_format?": "'mp3' | 'wav' | 'pcm' | 'opus' | 'aac' | 'flac'",
	"speed?": "number",
	"instructions?": "string",
});

export interface SpeechParsedRequest {
	modelId: string;
	request: SpeechRequest;
}

export function parseRequest(body: unknown, _headers?: Headers): SpeechParsedRequest {
	const parsed = speechRequestSchema(body);
	if (parsed instanceof type.errors) throw new AIError.ValidationError(`speech: ${parsed.summary}`);
	return {
		modelId: parsed.model,
		request: {
			text: parsed.input,
			format: parsed.response_format ?? "mp3",
			...(parsed.voice !== undefined ? { voice: parsed.voice } : {}),
			...(parsed.speed !== undefined ? { speed: parsed.speed } : {}),
			...(parsed.instructions !== undefined ? { instructions: parsed.instructions } : {}),
		},
	};
}

export function encodeResponse(result: SpeechResult, _requestedModelId: string): Response {
	return new Response(result.audio, {
		status: 200,
		headers: {
			"Content-Type": result.mimeType,
			"Cache-Control": "no-store",
			"X-Content-Type-Options": "nosniff",
		},
	});
}

export function formatError(status: number, errorType: string, message: string): Response {
	return new Response(JSON.stringify({ error: { code: status, type: errorType, message } }), {
		status,
		headers: {
			"Content-Type": "application/json; charset=utf-8",
			"Cache-Control": "no-store",
		},
	});
}
