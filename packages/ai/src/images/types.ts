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
	/** Output dimensions (`WIDTHxHEIGHT`) the provider reports for this image, which may differ from the request. */
	size?: string;
	/** Rendering quality the provider reports for this image. */
	quality?: string;
}

export interface ImageGenerationResult {
	images: GeneratedImage[];
	text?: string;
	usage: Usage;
	/**
	 * Image model the provider reports having run. Hosted backends may substitute their own model for the
	 * selected catalog entry (the ChatGPT/Codex backend does), so callers should prefer this over the catalog id.
	 */
	model?: string;
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
