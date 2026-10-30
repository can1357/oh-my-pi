import type { Usage } from "@oh-my-pi/pi-catalog/types";

export type TranscriptionResponseFormat = "json" | "verbose_json";
export type TranscriptionTimestampGranularity = "word" | "segment";

/** Audio container MIME type by file extension, as the gateway wire and the Codex dictation upload name resolve them. */
export const TRANSCRIPTION_AUDIO_MIME_TYPES: Readonly<Record<string, string>> = {
	wav: "audio/wav",
	wave: "audio/wav",
	mp3: "audio/mpeg",
	mpeg: "audio/mpeg",
	flac: "audio/flac",
	m4a: "audio/mp4",
	mp4: "audio/mp4",
	ogg: "audio/ogg",
	opus: "audio/ogg",
	oga: "audio/ogg",
	webm: "audio/webm",
	aac: "audio/aac",
};

export interface TranscriptionRequest {
	/** Audio bytes. A `Blob`/`File` (e.g. a parsed multipart upload) is sent without copying. */
	audio: Uint8Array | Blob;
	mimeType: string;
	fileName?: string;
	language?: string;
	prompt?: string;
	temperature?: number;
	responseFormat: TranscriptionResponseFormat;
	timestampGranularities?: TranscriptionTimestampGranularity[];
}

/** Provider-specific segment fields are preserved alongside the normalized timestamps and text. */
export interface TranscriptionSegment {
	id?: number | string;
	start: number;
	end: number;
	text: string;
	speaker?: number | string;
	[key: string]: unknown;
}

/** Provider-specific word fields are preserved alongside the normalized timestamps and spelling. */
export interface TranscriptionWord {
	word: string;
	start: number;
	end: number;
	speaker?: number | string;
	confidence?: number;
	[key: string]: unknown;
}

export interface TranscriptionResult {
	text: string;
	language?: string;
	duration?: number;
	segments?: TranscriptionSegment[];
	words?: TranscriptionWord[];
	/** Provider-billed audio duration, which may be present without verbose output. */
	seconds?: number;
	usage: Usage;
}
