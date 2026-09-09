/**
 * Vision fallback for text-only models. When a user attaches an image to a model
 * that cannot accept image input, this:
 *  1. saves each image under the session `local://` root (for later analysis), and
 *  2. asks a vision-capable model to describe it and injects that description as
 *     a text block in place of the image:
 *
 *     <image path="local://image-<hash>.png">
 *     <description>
 *     </image>
 *
 * Without this the provider layer drops the image entirely (NON_VISION_IMAGE_PLACEHOLDER).
 */
import * as path from "node:path";
import {
	type AgentTelemetry,
	type AgentTelemetryConfig,
	instrumentedCompleteSimple,
	resolveTelemetry,
} from "@oh-my-pi/pi-agent-core";
import type { Api, completeSimple, ImageContent, Model, TextContent } from "@oh-my-pi/pi-ai";
import { logger, prompt, toError } from "@oh-my-pi/pi-utils";
import { extractTextContent } from "../commit/utils";
import type { ModelRegistry } from "../config/model-registry";
import { expandRoleAlias, getModelMatchPreferences, resolveModelFromString } from "../config/model-resolver";
import type { Settings } from "../config/settings";
import { type LocalProtocolOptions, resolveLocalRoot } from "../internal-urls";
import describeUserPrompt from "../prompts/tools/image-attachment-describe.md" with { type: "text" };
import describeSystemPrompt from "../prompts/tools/image-attachment-describe-system.md" with { type: "text" };

/** Telemetry tag for the oneshot vision-description calls. */
const ONESHOT_KIND = "image_attachment_describe";

const NO_VISION_MODEL_NOTE =
	"[No vision-capable model is configured, so this image could not be described automatically. " +
	"The image was saved; configure a vision model role (modelRoles.vision) and read the saved image with ?q=<question> to analyze it.]";

const DESCRIPTION_UNAVAILABLE_NOTE =
	"[Image description unavailable: the vision model returned no usable text. The image was saved for further analysis.]";

/** Registry surface needed to resolve a vision model and authorize requests. */
export type VisionFallbackRegistry = Pick<ModelRegistry, "getAvailable" | "getApiKey" | "resolver">;

export interface DescribeAttachedImagesDeps {
	/** Active (text-only) model the prompt is destined for. */
	activeModel: Model<Api>;
	modelRegistry: VisionFallbackRegistry;
	settings: Settings;
	/** Inputs for resolving the session-scoped `local://` root. */
	localProtocolOptions: LocalProtocolOptions;
	/** `provider/id` of the active model; a last-resort vision-model candidate (filtered to image-capable). */
	activeModelString?: string;
	telemetryConfig?: AgentTelemetryConfig;
	sessionId?: string;
	/** Test seam: overrides the underlying completeSimple call. */
	completeImpl?: typeof completeSimple;
}

/** Map an image MIME type to a file extension for the saved artifact. */
function extensionForMime(mimeType: string): string {
	const subtype = mimeType.split("/")[1]?.toLowerCase() ?? "";
	switch (subtype) {
		case "jpeg":
		case "jpg":
			return "jpg";
		case "png":
			return "png";
		case "gif":
			return "gif";
		case "webp":
			return "webp";
		default: {
			const sanitized = subtype.replace(/[^a-z0-9]/g, "");
			return sanitized || "png";
		}
	}
}

/** Content-addressed file name so re-pasting the same image reuses one artifact. */
function imageFileName(image: ImageContent): string {
	const hash = Bun.hash(image.data).toString(16);
	return `image-${hash}.${extensionForMime(image.mimeType)}`;
}

/** Persist an image under the local root; returns its `local://` URL. */
async function saveImage(image: ImageContent, localRoot: string): Promise<string> {
	const fileName = imageFileName(image);
	const filePath = path.join(localRoot, fileName);
	// Content-addressed: identical bytes overwrite themselves harmlessly. Bun.write creates parent dirs.
	await Bun.write(filePath, Buffer.from(image.data, "base64"));
	return `local://${fileName}`;
}

function formatImageBlock(localUrl: string, description: string): string {
	return `<image path="${localUrl}">\n${description}\n</image>`;
}

/**
 * Resolve a vision-capable model, mirroring image-question priority
 * (`@vision` → `@default` → active → first image-capable available), but
 * never returning a text-only model.
 */
function resolveVisionModel(deps: DescribeAttachedImagesDeps): Model<Api> | undefined {
	const available = deps.modelRegistry.getAvailable();
	if (available.length === 0) return undefined;
	const preferences = getModelMatchPreferences(deps.settings);
	const resolvePattern = (pattern: string | undefined): Model<Api> | undefined => {
		if (!pattern) return undefined;
		const expanded = expandRoleAlias(pattern, deps.settings);
		const model = resolveModelFromString(expanded, available, preferences);
		return model?.input.includes("image") ? model : undefined;
	};
	return (
		resolvePattern("@vision") ??
		resolvePattern("@default") ??
		resolvePattern(deps.activeModelString) ??
		available.find(model => model.input.includes("image"))
	);
}

/** Run one vision-description round-trip; returns trimmed text or `null` on any failure. */
async function describeImage(
	image: ImageContent,
	visionModel: Model<Api>,
	deps: DescribeAttachedImagesDeps,
	telemetry: AgentTelemetry | undefined,
	signal: AbortSignal | undefined,
): Promise<string | null> {
	try {
		const response = await instrumentedCompleteSimple(
			visionModel,
			{
				systemPrompt: [prompt.render(describeSystemPrompt)],
				messages: [
					{
						role: "user",
						content: [
							{ type: "image", data: image.data, mimeType: image.mimeType },
							{ type: "text", text: prompt.render(describeUserPrompt) },
						],
						timestamp: Date.now(),
					},
				],
			},
			{ apiKey: deps.modelRegistry.resolver(visionModel, deps.sessionId), signal },
			{ telemetry, oneshotKind: ONESHOT_KIND, completeImpl: deps.completeImpl },
		);
		if (response.stopReason === "error" || response.stopReason === "aborted") {
			logger.warn("image attachment description did not complete", {
				stopReason: response.stopReason,
				model: `${visionModel.provider}/${visionModel.id}`,
			});
			return null;
		}
		const text = extractTextContent(response).trim();
		return text.length > 0 ? text : null;
	} catch (err) {
		logger.warn("image attachment description failed", {
			error: toError(err).message,
			model: `${visionModel.provider}/${visionModel.id}`,
		});
		return null;
	}
}

/**
 * Save each attached image under `local://` and replace it with a descriptive
 * text block. Returns one {@link TextContent} per input image, in order. Never
 * throws for an individual image: a failed description falls back to a note while
 * the saved-path block is still emitted.
 */
export async function describeAttachedImagesForTextModel(
	images: readonly ImageContent[],
	deps: DescribeAttachedImagesDeps,
	signal?: AbortSignal,
): Promise<TextContent[]> {
	const localRoot = resolveLocalRoot(deps.localProtocolOptions);
	const visionModel = resolveVisionModel(deps);
	const apiKey = visionModel ? await deps.modelRegistry.getApiKey(visionModel, deps.sessionId) : undefined;
	const canDescribe = Boolean(visionModel && apiKey);
	const telemetry = resolveTelemetry(deps.telemetryConfig, deps.sessionId);

	return Promise.all(
		images.map(async (image): Promise<TextContent> => {
			const localUrl = await saveImage(image, localRoot);
			let description: string;
			if (canDescribe && visionModel) {
				description =
					(await describeImage(image, visionModel, deps, telemetry, signal)) ?? DESCRIPTION_UNAVAILABLE_NOTE;
			} else {
				description = NO_VISION_MODEL_NOTE;
			}
			return { type: "text", text: formatImageBlock(localUrl, description) };
		}),
	);
}
