import { isDashscopeCompatibleModeUrl, modelMatchesHost } from "@oh-my-pi/pi-catalog/hosts";
import { isDeepseekModelIdOrName, isQwenModelId } from "@oh-my-pi/pi-catalog/identity";

import type { ImageContent, Model, TextContent } from "../types";

export const NON_VISION_IMAGE_PLACEHOLDER = "[image omitted: model does not support vision]";
// `vision` delimited by non-alphanumerics, so `deepseek-v4-flash-vision-exp`
// and `deepseek_vision` match but `deepseek-r1-revision-0528` does not.
// Inputs are lowercased before testing.
const VISION_TOKEN = /(?<![a-z0-9])vision(?![a-z0-9])/;

export function partitionVisionContent(
	content: ReadonlyArray<TextContent | ImageContent>,
	supportsImages: boolean,
): {
	textBlocks: TextContent[];
	imageBlocks: ImageContent[];
	omittedImages: boolean;
} {
	const textBlocks = content.filter((block): block is TextContent => block.type === "text");
	const imageBlocks = content.filter((block): block is ImageContent => block.type === "image");
	return {
		textBlocks,
		imageBlocks: supportsImages ? imageBlocks : [],
		omittedImages: !supportsImages && imageBlocks.length > 0,
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
 * Detect known text-only Qwen models served via Alibaba DashScope's consumer
 * `compatible-mode` endpoint that the upstream chat-completions API rejects
 * multimodal content arrays for. The compatible-mode endpoint also serves
 * multimodal Qwen SKUs without `vl` in the id (e.g. `qwen3.7-plus`), so this
 * guard only covers families verified to be text-only for issue #1859:
 * `qwen*-coder*` and `qwen*-max` up to and including `qwen3.7-max`.
 *
 * Qwen-Max became multimodal at `qwen3.8-max` (image input, issue #8019), so
 * `-max` SKUs at version 3.8 or newer are excluded — otherwise the override
 * would strip images from a genuinely vision-capable flagship (issue #8305).
 *
 * Used as a defensive override in `convertMessages` so a misconfigured custom
 * provider (issue #1859) can't drive the request into an unrecoverable 400.
 */
export function isDashscopeCompatibleModeTextOnlyQwen(model: Model<"openai-completions">): boolean {
	if (!isDashscopeCompatibleModeUrl(model.baseUrl)) {
		return false;
	}
	if (!isQwenModelId(model.id)) return false;
	const id = model.id.toLowerCase();
	if (/\bqwen(?:[\d.]+)?-coder\b/.test(id)) return true;
	const maxMatch = id.match(/\bqwen(?:(\d+)(?:\.(\d+))?)?-max\b/);
	if (!maxMatch) return false;
	// Bare `qwen-max` (no version) is the text-only 2.5-era flagship. Compare
	// major/minor component-wise, not as a decimal float, so `qwen3.10-max`
	// sorts after `qwen3.8-max`: text-only through 3.7, multimodal from 3.8 on.
	const major = maxMatch[1] ? Number.parseInt(maxMatch[1], 10) : 0;
	const minor = maxMatch[2] ? Number.parseInt(maxMatch[2], 10) : 0;
	return major < 3 || (major === 3 && minor < 8);
}

/**
 * Detect known text-only DeepSeek models served via OpenAI-compatible Chat
 * Completions endpoints whose server-side deserializers reject `image_url`
 * content parts with HTTP 400 (`unknown variant \`image_url\`, expected \`text\``).
 *
 * Used as a defensive override in `convertMessages` so misconfigured model
 * definitions or user overrides (e.g. `models.yml` claiming `input: [text, image]`)
 * do not crash the session with an unrecoverable 400.
 */
export function isTextOnlyDeepSeek(model: Model<"openai-completions">): boolean {
	const id = model.id.toLowerCase();
	const name = (model.name ?? "").toLowerCase();
	// DeepSeek OCR and the multimodal vision SKUs (deepseek-v4-flash-vision-exp,
	// future -vision- ids) genuinely accept image_url parts; same marker as the
	// catalog's deepseek mapModel heuristic. `vision` must be a bounded token:
	// `revision` contains it as a substring and must stay guarded.
	if (id.includes("deepseek-ocr") || name.includes("deepseek-ocr")) return false;
	if (VISION_TOKEN.test(id) || VISION_TOKEN.test(name)) return false;
	return (
		modelMatchesHost(model, "deepseekFamily") ||
		isDeepseekModelIdOrName(model.id) ||
		isDeepseekModelIdOrName(model.name ?? "") ||
		model.provider === "deepseek"
	);
}

/**
 * Evaluates whether an OpenAI-compatible Chat Completions model genuinely
 * supports multimodal image inputs on the wire. Defensive guards override
 * misconfigured provider descriptors or user model entries (e.g. text-only
 * DashScope Qwen SKUs, DeepSeek models) whose endpoints reject `image_url`.
 */
export function isOpenAICompletionsVisionSupported(model: Model<"openai-completions">): boolean {
	if (!model.input.includes("image")) return false;
	if (isDashscopeCompatibleModeTextOnlyQwen(model)) return false;
	if (isTextOnlyDeepSeek(model)) return false;
	return true;
}
