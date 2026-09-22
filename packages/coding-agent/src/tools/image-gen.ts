import * as os from "node:os";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import type { AgentToolResult } from "@oh-my-pi/pi-agent-core";
import {
	generateImage,
	type ImageGenerationRequest,
	type ImageGenerationResult,
	isImageGenerationApi,
	type Model,
	parseAntigravityCredentials,
} from "@oh-my-pi/pi-ai";
import { ProviderHttpError } from "@oh-my-pi/pi-ai/error";
import { isEnoent, logger, parseImageMetadata, prompt, ptree, Snowflake, untilAborted } from "@oh-my-pi/pi-utils";
import { resolveModelRoleValue, resolveRoleChain } from "../config/model-resolver";
import { roleCandidatePool } from "../config/model-roles";
import { isAuthenticated, type ModelRegistry } from "../config/model-registry";
import { settings } from "../config/settings";
import type { CustomTool } from "../extensibility/custom-tools/types";
import imageGenDescription from "../prompts/tools/image-gen.md" with { type: "text" };
import { resolveReadPath } from "./path-utils";

const IMAGE_TIMEOUT = 3 * 60 * 1000;
const MAX_IMAGE_SIZE = 35 * 1024 * 1024;

const aspectRatioSchema = type('"1:1" | "3:4" | "4:3" | "9:16" | "16:9" | "3:2" | "2:3"').describe("aspect ratio");
const imageSizeSchema = type('"1024x1024" | "1536x1024" | "1024x1536"').describe("image size");
const inputImageSchema = type({
	"path?": type("string").describe("input image path"),
	"data?": type("string").describe("base64 image data"),
	"mime_type?": type("string").describe("mime type"),
});

export const imageGenSchema = type({
	subject: type("string").describe("main subject"),
	"action?": type("string").describe("what subject is doing"),
	"scene?": type("string").describe("location or environment"),
	"composition?": type("string").describe("camera angle and framing"),
	"lighting?": type("string").describe("lighting setup"),
	"style?": type("string").describe("artistic style"),
	"text?": type("string").describe("text to render"),
	"changes?": type("string[]").describe("edits to make"),
	"aspect_ratio?": aspectRatioSchema,
	"image_size?": imageSizeSchema,
	"input?": inputImageSchema.array().describe("input images"),
	"model?": type("string").describe("image model selector for this request"),
});
export type ImageGenParams = typeof imageGenSchema.infer;

interface ImageGenToolDetails {
	provider: string;
	model: string;
	imageCount: number;
	imagePaths: string[];
	images: Array<{ data: string; mimeType: string }>;
	responseText?: string;
	usage?: ImageGenerationResult["usage"];
}

interface ImageInput {
	path?: string;
	data?: string;
	mime_type?: string;
}

function assemblePrompt(params: ImageGenParams): string {
	const parts: string[] = [];
	const subjectParts = [params.subject];
	if (params.action) subjectParts.push(params.action);
	if (params.scene) subjectParts.push(params.scene);
	parts.push(subjectParts.join(", "));
	if (params.composition) parts.push(params.composition);
	if (params.lighting) parts.push(params.lighting);
	if (params.style) parts.push(params.style);
	let result = `${parts.map(part => part.replace(/[.!,;:]+$/, "")).join(". ")}.`;
	if (params.text) result += `\n\nText: ${params.text}`;
	if (params.changes?.length) result += `\n\nChanges:\n${params.changes.map(change => `- ${change}`).join("\n")}`;
	return result;
}

function normalizeDataUrl(data: string): { data: string; mimeType?: string } {
	const match = data.match(/^data:([^;]+);base64,(.+)$/);
	if (!match) return { data };
	return { data: match[2] ?? "", mimeType: match[1] };
}

async function loadImageFromPath(imagePath: string, cwd: string): Promise<{ data: string; mimeType: string }> {
	const resolved = resolveReadPath(imagePath, cwd);
	try {
		const buffer = await Bun.file(resolved).bytes();
		if (buffer.length > MAX_IMAGE_SIZE) throw new Error(`Image file too large: ${imagePath}`);
		const mimeType = parseImageMetadata(buffer)?.mimeType;
		if (!mimeType) throw new Error(`Unsupported image type: ${imagePath}`);
		return { data: buffer.toBase64(), mimeType };
	} catch (error) {
		if (isEnoent(error)) throw new Error(`Image file not found: ${imagePath}`);
		throw error;
	}
}

async function resolveInputImage(input: ImageInput, cwd: string): Promise<{ data: string; mimeType: string }> {
	if (input.path) return loadImageFromPath(input.path, cwd);
	if (input.data) {
		const normalized = normalizeDataUrl(input.data.trim());
		const mimeType = normalized.mimeType ?? input.mime_type;
		if (!mimeType) throw new Error("mime_type is required when providing raw base64 data.");
		if (!normalized.data) throw new Error("Image data is empty.");
		return { data: normalized.data, mimeType };
	}
	throw new Error("input entries must include either path or data.");
}

function imageExtension(mimeType: string): string {
	const extensions: Record<string, string> = {
		"image/png": "png",
		"image/jpeg": "jpg",
		"image/gif": "gif",
		"image/webp": "webp",
	};
	return extensions[mimeType] ?? "png";
}

async function saveImagesToTemp(images: ImageGenerationResult["images"]): Promise<string[]> {
	return Promise.all(
		images.map(async image => {
			const filepath = path.join(os.tmpdir(), `omp-image-${Snowflake.next()}.${imageExtension(image.mimeType)}`);
			await Bun.write(filepath, Buffer.from(image.data, "base64"));
			return filepath;
		}),
	);
}

function isOpenAIHostedImageModel(model: Model | undefined): model is Model {
	if (!model) return false;
	if (model.provider !== "openai" && model.provider !== "openai-codex") return false;
	if (model.api !== "openai-responses" && model.api !== "openai-codex-responses") return false;
	const modelId = model.id.toLowerCase();
	return modelId.startsWith("gpt-") || modelId === "o3" || modelId.startsWith("o3-");
}

const HOSTED_CHAT_MODEL_PRIORITY = ["gpt-5.5", "gpt-5.4", "gpt-5.1", "gpt-5", "gpt-5-codex"];

function resolveHostedImageCarrier(
	modelRegistry: ModelRegistry,
	selectedModel: Model,
	activeModel: Model | undefined,
): Model | undefined {
	if (activeModel?.provider === selectedModel.provider && isOpenAIHostedImageModel(activeModel)) return activeModel;
	for (const id of HOSTED_CHAT_MODEL_PRIORITY) {
		const model = modelRegistry.find(selectedModel.provider, id);
		if (model && isOpenAIHostedImageModel(model)) return model;
	}
	return modelRegistry
		.getAvailable()
		.find(model => model.provider === selectedModel.provider && isOpenAIHostedImageModel(model));
}

async function buildToolResult(
	model: Model,
	result: ImageGenerationResult,
): Promise<AgentToolResult<ImageGenToolDetails, ImageGenParams>> {
	const imagePaths = await saveImagesToTemp(result.images);
	if (imagePaths.length === 0) {
		return {
			content: [{ type: "text", text: `No image data returned.${result.text ? `\n\n${result.text}` : ""}` }],
			details: {
				provider: model.provider,
				model: model.id,
				imageCount: 0,
				imagePaths: [],
				images: [],
				responseText: result.text,
				usage: result.usage,
			},
		};
	}
	const lines = [`Provider: ${model.provider}`, `Model: ${model.id}`, `Generated ${imagePaths.length} image(s):`];
	for (const imagePath of imagePaths) lines.push(`  ${imagePath}`);
	if (result.text) lines.push("", result.text.trim());
	return {
		content: [{ type: "text", text: lines.join("\n") }],
		details: {
			provider: model.provider,
			model: model.id,
			imageCount: result.images.length,
			imagePaths,
			images: result.images,
			responseText: result.text,
			usage: result.usage,
		},
	};
}

export const imageGenTool: CustomTool<typeof imageGenSchema, ImageGenToolDetails> = {
	name: "generate_image",
	label: "GenerateImage",
	strict: false,
	approval: "write",
	description: prompt.render(imageGenDescription),
	parameters: imageGenSchema,
	async execute(_toolCallId, params, _onUpdate, ctx, signal) {
		return untilAborted(signal, async () => {
			const sessionId = ctx.sessionManager.getSessionId();
			const requestSignal = ptree.combineSignals(signal, IMAGE_TIMEOUT);
			const effectiveSettings = ctx.settings ?? settings;
			const pool = roleCandidatePool("image", effectiveSettings, ctx.modelRegistry);
			let candidates: Model[];
			if (params.model) {
				const selected = resolveModelRoleValue(params.model, pool, { settings: effectiveSettings }).model;
				if (!selected)
					throw new Error(`Image model selector did not match an available image model: ${params.model}`);
				candidates = [selected];
			} else {
				candidates = resolveRoleChain("image", effectiveSettings, pool, {
					hoistProvider: ctx.model?.provider,
				}).map(candidate => candidate.model);
			}

			const failures: ProviderHttpError[] = [];
			const skipped: string[] = [];
			let inputImages: ImageGenerationRequest["inputImages"];
			for (const model of candidates) {
				if (!isImageGenerationApi(model.api)) {
					logger.warn("Skipping unsupported image model API", {
						provider: model.provider,
						model: model.id,
						api: model.api,
					});
					skipped.push(`${model.provider}/${model.id} (unsupported ${model.api})`);
					continue;
				}

				if (sessionId) ctx.applyStartupOAuthAccountPin?.(model.provider, sessionId);
				const initialKey = await ctx.modelRegistry.getApiKey(model, sessionId, { signal: requestSignal });
				if (!isAuthenticated(initialKey)) {
					skipped.push(`${model.provider}/${model.id} (credentials unavailable)`);
					continue;
				}
				if (model.api === "google-gemini-cli" && !parseAntigravityCredentials(initialKey)) {
					skipped.push(`${model.provider}/${model.id} (invalid credentials)`);
					continue;
				}

				let carrier: Model | undefined;
				let apiKey = ctx.modelRegistry.resolver(model, sessionId);
				if (model.api === "openai-responses" || model.api === "openai-codex-responses") {
					carrier = resolveHostedImageCarrier(ctx.modelRegistry, model, ctx.model);
					if (!carrier) {
						skipped.push(`${model.provider}/${model.id} (hosted chat carrier unavailable)`);
						continue;
					}
					const carrierKey = await ctx.modelRegistry.getApiKey(carrier, sessionId, { signal: requestSignal });
					if (!isAuthenticated(carrierKey)) {
						skipped.push(`${model.provider}/${model.id} (carrier credentials unavailable)`);
						continue;
					}
					apiKey = ctx.modelRegistry.resolver(carrier, sessionId);
				}

				if (!inputImages) {
					inputImages = [];
					for (const input of params.input ?? []) {
						inputImages.push(await resolveInputImage(input, ctx.sessionManager.getCwd()));
					}
				}
				const request: ImageGenerationRequest = {
					prompt: assemblePrompt(params),
					inputImages,
					aspectRatio: params.aspect_ratio,
					imageSize: params.image_size,
					count: 1,
				};
				const resolvedModel = {
					...model,
					resolveHeaders: (headerSignal?: AbortSignal) =>
						ctx.modelRegistry.resolveModelHeaders(model, headerSignal),
				};
				const resolvedCarrier = carrier
					? {
							...carrier,
							resolveHeaders: (headerSignal?: AbortSignal) =>
								ctx.modelRegistry.resolveModelHeaders(carrier, headerSignal),
						}
					: undefined;
				try {
					const result = await generateImage(resolvedModel, request, {
						apiKey,
						fetch: ctx.fetch ?? fetch,
						signal: requestSignal,
						carrier: resolvedCarrier,
						sessionId,
					});
					return buildToolResult(model, result);
				} catch (error) {
					if (!(error instanceof ProviderHttpError) || requestSignal?.aborted) throw error;
					failures.push(error);
				}
			}

			const attempted = candidates.map(model => `${model.provider}/${model.id}`).join(", ");
			const suffix = skipped.length > 0 ? ` Skipped: ${skipped.join(", ")}.` : "";
			throw new AggregateError(
				failures,
				`Image generation exhausted the resolved image chain${attempted ? `: ${attempted}` : "."}${suffix}`,
			);
		});
	},
};

export async function getImageGenTools(
	_modelRegistry?: ModelRegistry,
	_activeModel?: Model,
): Promise<Array<CustomTool<typeof imageGenSchema, ImageGenToolDetails>>> {
	return [imageGenTool];
}

export async function getImageGenToolsWithRegistry(
	_modelRegistry: ModelRegistry,
	_activeModel?: Model,
): Promise<Array<CustomTool<typeof imageGenSchema, ImageGenToolDetails>>> {
	return [imageGenTool];
}
