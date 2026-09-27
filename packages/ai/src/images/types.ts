import type { Api, FetchImpl, Model, Usage } from "@oh-my-pi/pi-catalog/types";
import type { ApiKey } from "../auth-retry";

export interface ImageInput {
	data: string;
	mimeType: string;
}

export interface ImageGenerationRequest {
	prompt: string;
	inputImages?: ImageInput[];
	aspectRatio?: string;
	imageSize?: string;
	count?: number;
}

export interface GeneratedImage {
	data: string;
	mimeType: string;
}

export interface ImageGenerationResult {
	images: GeneratedImage[];
	text?: string;
	usage: Usage;
}

export interface ImageGenerationOptions {
	apiKey: ApiKey;
	fetch?: FetchImpl;
	signal?: AbortSignal;
	/** Chat model that carries a Responses `image_generation` tool call. */
	carrier?: Model<Api>;
	/** Stable provider session id, used by the Codex Responses carrier. */
	sessionId?: string;
}
