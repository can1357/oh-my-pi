import type { Usage } from "@oh-my-pi/pi-catalog/types";

export type TranscriptionResponseFormat = "json" | "verbose_json";
export type TranscriptionTimestampGranularity = "word" | "segment";

export interface TranscriptionRequest {
	audio: Uint8Array;
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
