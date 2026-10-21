import { $env } from "@oh-my-pi/pi-utils";
import type { Api, ImageContent, Model, TextContent } from "../types";

export const NON_VISION_IMAGE_PLACEHOLDER = "[image omitted: model does not support vision]";
export const NON_AUDIO_PLACEHOLDER = "[audio omitted: model does not hear audio]";

/**
 * Whether an inline block carries audio rather than an image. `ImageContent` is the inline-media
 * block; Google sends any MIME type as inline data, and the OpenAI-style converters turn an
 * `audio/*` block into an `input_audio` part. Converters send it only to a model whose `input`
 * has `audio` and put {@link NON_AUDIO_PLACEHOLDER} in its place otherwise.
 */
export function isAudioContent(block: ImageContent): boolean {
	return block.mimeType.startsWith("audio/");
}

/** The `input_audio` format of an audio block: Chat Completions and Responses take mp3 and wav. */
export function inputAudioFormat(block: ImageContent): "mp3" | "wav" {
	return block.mimeType === "audio/wav" ? "wav" : "mp3";
}

export function partitionVisionContent(
	content: ReadonlyArray<TextContent | ImageContent>,
	supportsImages: boolean,
	supportsAudio = false,
): {
	textBlocks: TextContent[];
	imageBlocks: ImageContent[];
	audioBlocks: ImageContent[];
	omittedImages: boolean;
	omittedAudio: boolean;
} {
	const textBlocks = content.filter((block): block is TextContent => block.type === "text");
	const mediaBlocks = content.filter((block): block is ImageContent => block.type === "image");
	const audioBlocks = mediaBlocks.filter(isAudioContent);
	const imageBlocks = mediaBlocks.filter(block => !isAudioContent(block));
	return {
		textBlocks,
		imageBlocks: supportsImages ? imageBlocks : [],
		audioBlocks: supportsAudio ? audioBlocks : [],
		omittedImages: !supportsImages && imageBlocks.length > 0,
		omittedAudio: !supportsAudio && audioBlocks.length > 0,
	};
}

export function joinTextWithImagePlaceholder(text: string, omittedImages: boolean): string {
	const parts: string[] = [];
	if (text.length > 0) {
		parts.push(text);
	}
	if (omittedImages) {
		parts.push(NON_VISION_IMAGE_PLACEHOLDER);
	}
	return parts.join("\n");
}

/**
 * Evaluates whether an OpenAI-compatible Chat Completions model genuinely
 * supports multimodal image inputs on the wire. Defensive guards override
 * misconfigured provider descriptors or user model entries (e.g. text-only
 * DashScope Qwen SKUs, DeepSeek models) whose endpoints reject `image_url`.
 */
export function isOpenAICompletionsVisionSupported(model: Model<"openai-completions" | "openrouter">): boolean {
	if (!model.input.includes("image")) return false;
	if (model.compat.stripImageInput) return false;
	return true;
}

/**
 * Whether the transport that will carry `model` sends image content on the wire.
 *
 * The `pi-native` transport forwards the original context (images included) to
 * the gateway, which resolves its own model server-side, so the Chat
 * Completions guard below never runs client-side and the declared input
 * applies. Otherwise the OpenAI Chat Completions path applies the text-only
 * guard, as does the OpenRouter chat fallback (`PI_OPENROUTER_RESPONSES=0`,
 * which dispatches `openrouter` models through `streamOpenAICompletions`);
 * every other API ships the modalities the model declares. Callers that report
 * or gate on the wire (for example the `omp models` table) read this
 * predicate; declared capability reads `model.input`.
 */
export function sendsImageInputOnWire(model: Model<Api>): boolean {
	if (model.transport === "pi-native") return model.input.includes("image");
	if (isGuardedCompletionsTransport(model)) return isOpenAICompletionsVisionSupported(model);
	return model.input.includes("image");
}

/** True for the transports that encode through the Chat Completions guard. */
function isGuardedCompletionsTransport(model: Model<Api>): model is Model<"openai-completions" | "openrouter"> {
	if (model.api === "openai-completions") return true;
	return model.api === "openrouter" && $env.PI_OPENROUTER_RESPONSES === "0";
}

/**
 * The audio encoding `model`'s transport carries inline in a user message, or undefined when
 * the model hears no audio (`model.input`) or its transport carries none. Google's
 * GenerateContent takes any audio MIME type as inline data, Opus being the smallest for speech;
 * Chat Completions and Responses `input_audio` parts take mp3 or wav. A `pi-native` gateway
 * encodes server-side with whatever version it runs, so it is left out.
 */
export function audioInputMimeType(model: Model<Api>): "audio/ogg" | "audio/mpeg" | undefined {
	if (!model.input.includes("audio") || model.transport === "pi-native") return undefined;
	switch (model.api) {
		case "google-generative-ai":
		case "google-gemini-cli":
		case "google-vertex":
			return "audio/ogg";
		case "openai-completions":
		case "openrouter":
			return "audio/mpeg";
		default:
			return undefined;
	}
}
