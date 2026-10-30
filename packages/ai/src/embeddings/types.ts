import type { Usage } from "@oh-my-pi/pi-catalog/types";

export interface EmbeddingRequest {
	input: string | string[] | number[] | number[][];
	dimensions?: number;
	encodingFormat: "float" | "base64";
	user?: string;
}

export interface EmbeddingResult {
	embeddings: Array<{ index: number; embedding: number[] | string }>;
	model: string;
	usage: Usage;
}
