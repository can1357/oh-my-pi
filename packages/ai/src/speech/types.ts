import type { FetchImpl, SpeechFormat, Usage } from "@oh-my-pi/pi-catalog/types";
import type { ApiKey } from "../auth-retry";

export type { SpeechFormat };

export const SPEECH_FORMAT_MIME_TYPES: Record<SpeechFormat, string> = {
	mp3: "audio/mpeg",
	wav: "audio/wav",
	pcm: "audio/pcm",
	opus: "audio/opus",
	aac: "audio/aac",
	flac: "audio/flac",
};

export interface SpeechRequest {
	text: string;
	voice?: string;
	language?: string;
	format: SpeechFormat;
	speed?: number;
	sampleRate?: number;
	bitRate?: number;
	instructions?: string;
}

export interface SpeechResult {
	audio: Uint8Array;
	mimeType: string;
	usage: Usage;
}

export interface SpeechOptions {
	apiKey: ApiKey;
	fetch?: FetchImpl;
	signal?: AbortSignal;
}
