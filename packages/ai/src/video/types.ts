import type { Usage } from "@oh-my-pi/pi-catalog/types";

export type VideoResolution = "360p" | "480p" | "720p" | "768p" | "1080p" | "1K" | "2K" | "4K";
export type VideoAspectRatio = "16:9" | "9:16" | "1:1" | "4:3" | "3:4" | "3:2" | "2:3" | "21:9" | "9:21";

export interface VideoImageReference {
	type: "image_url";
	imageUrl: { url: string };
}

export interface VideoFrameImage extends VideoImageReference {
	frameType: "first_frame" | "last_frame";
}

export interface VideoAudioReference {
	type: "audio_url";
	audioUrl: { url: string };
}

export interface VideoVideoReference {
	type: "video_url";
	videoUrl: { url: string };
}

export type VideoInputReference = VideoImageReference | VideoAudioReference | VideoVideoReference;

/** Canonical camel-case form of OpenRouter's asynchronous video submit request. */
export interface VideoGenerationRequest {
	prompt?: string;
	duration?: number;
	resolution?: VideoResolution;
	aspectRatio?: VideoAspectRatio;
	size?: string;
	frameImages?: VideoFrameImage[];
	inputReferences?: VideoInputReference[];
	generateAudio?: boolean;
	seed?: number;
	callbackUrl?: string;
	provider?: { options?: Record<string, unknown> };
	previousJobId?: string;
	sessionId?: string;
	trace?: Record<string, unknown>;
	user?: string;
	creativity?: number;
	upscaleFactor?: number;
}

export type VideoJobStatus =
	| "queued"
	| "processing"
	| "pending"
	| "in_progress"
	| "completed"
	| "failed"
	| "cancelled"
	| "expired";

export interface VideoJob {
	id: string;
	status: VideoJobStatus;
	pollingUrl?: string;
	generationId?: string;
	contentUrls?: string[];
	error?: string;
	usage?: Usage;
}

export interface VideoContent {
	body: ReadableStream<Uint8Array>;
	contentType: string;
	contentLength?: number;
}
