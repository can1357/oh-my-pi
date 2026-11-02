import type { FetchImpl, Usage } from "@oh-my-pi/pi-catalog/types";
import type { ApiKey } from "../auth-retry";

export const SPEECH_FORMATS = ["mp3", "wav", "pcm", "opus", "aac", "flac"] as const;

export type SpeechFormat = (typeof SPEECH_FORMATS)[number];

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
