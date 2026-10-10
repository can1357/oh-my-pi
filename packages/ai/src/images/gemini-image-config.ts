import type { ImageGenerationRequest } from "./types";

/** Translate tool image dimensions into Gemini resolution tiers and ratios. */
export function geminiImageConfig(request: ImageGenerationRequest): { aspectRatio?: string; imageSize?: string } {
	let aspectRatio = request.aspectRatio;
	let imageSize = request.imageSize;
	switch (imageSize) {
		case "1024x1024":
			imageSize = "1K";
			aspectRatio ??= "1:1";
			break;
		case "1536x1024":
			imageSize = "2K";
			aspectRatio ??= "3:2";
			break;
		case "1024x1536":
			imageSize = "2K";
			aspectRatio ??= "2:3";
			break;
	}
	return { aspectRatio, imageSize };
}
