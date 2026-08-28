import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import { instrumentedCompleteSimple, resolveTelemetry } from "@oh-my-pi/pi-agent-core";
import {
	type Api,
	type AssistantMessage,
	completeSimple,
	type ImageContent,
	type Model,
	type ToolExample,
} from "@oh-my-pi/pi-ai";
import { prompt } from "@oh-my-pi/pi-utils";
import { extractTextContent } from "../commit/utils";

import {
	expandRoleAlias,
	extractExplicitThinkingSelector,
	getModelMatchPreferences,
	resolveModelFromString,
} from "../config/model-resolver";
import inspectImageDescription from "../prompts/tools/inspect-image.md" with { type: "text" };
import inspectImageSystemPromptTemplate from "../prompts/tools/inspect-image-system.md" with { type: "text" };
import { concreteThinkingLevel, resolveThinkingLevelForModel, toReasoningEffort } from "../thinking";
import {
	ImageInputTooLargeError,
	type LoadedImageInput,
	loadImageAttachmentInput,
	loadImageInput,
	loadSvgImageInput,
	MAX_IMAGE_INPUT_BYTES,
	webpExclusionForModel,
} from "../utils/image-loading";
import type { ToolSession } from "./index";
import { splitPathAndSelPreferringLiteral } from "./path-utils";
import { ToolError } from "./tool-errors";

const inspectImageSchema = type({
	path: type("string").describe(
		"image file path, local .svg/.svgz path with :img, Image #N label, or attachment://N URI",
	),
	question: type("string").describe("question about image"),
	"+": "reject",
});

export type InspectImageParams = typeof inspectImageSchema.infer;

interface ImageAttachmentReference {
	index: number;
}

const IMAGE_ATTACHMENT_REFERENCE_REGEX =
	/^\s*(?:\[?Image #([1-9]\d*)(?:,[^\]\n]*)?\]?|(?:attachment|image):\/\/([1-9]\d*))\s*$/i;

function parseImageAttachmentReference(path: string): ImageAttachmentReference | null {
	const match = IMAGE_ATTACHMENT_REFERENCE_REGEX.exec(path);
	if (!match) return null;
	const rawIndex = match[1] ?? match[2];
	if (!rawIndex) return null;
	return { index: Number(rawIndex) };
}

function formatAvailableImageAttachments(attachments: readonly { label: string; uri: string }[]): string {
	if (attachments.length === 0) return "none";
	return attachments.map(attachment => `${attachment.label} -> ${attachment.uri}`).join(", ");
}

async function loadAttachmentReferenceInput(options: {
	path: string;
	reference: ImageAttachmentReference;
	attachments: readonly { label: string; uri: string; image: ImageContent }[];
	autoResize: boolean;
	excludeWebP: boolean | undefined;
}): Promise<LoadedImageInput | null> {
	const attachment = options.attachments[options.reference.index - 1];
	if (!attachment) {
		const available = formatAvailableImageAttachments(options.attachments);
		if (options.attachments.length === 0) {
			throw new ToolError(
				`No image attachments are available in this turn. path="${options.path}" must be a readable file path or attachment URI.`,
			);
		}
		throw new ToolError(
			`Could not resolve image attachment '${options.path}'. Available image attachments: ${available}. Pass an attachment URI or a readable filesystem path.`,
		);
	}
	return loadImageAttachmentInput({
		image: attachment.image,
		label: attachment.label,
		uri: attachment.uri,
		autoResize: options.autoResize,
		maxBytes: MAX_IMAGE_INPUT_BYTES,
		excludeWebP: options.excludeWebP,
	});
}

export interface InspectImageToolDetails {
	model: string;
	imagePath: string;
	mimeType: string;
}

export class InspectImageTool implements AgentTool<typeof inspectImageSchema, InspectImageToolDetails> {
	readonly name = "inspect_image";
	readonly approval = "read" as const;
	readonly label = "InspectImage";
	readonly loadMode = "discoverable";
	readonly summary = "Describe or analyze an image file";
	readonly description: string;
	readonly parameters = inspectImageSchema;
	readonly strict = false;

	readonly examples: readonly ToolExample<typeof inspectImageSchema.infer>[] = [
		{
			caption: "OCR with strict formatting",
			call: {
				path: "screenshots/error.png",
				question: "Extract all visible text verbatim. Return as bullet list in reading order.",
			},
		},
		{
			caption: "Screenshot debugging",
			call: {
				path: "screenshots/settings.png",
				question:
					"Identify the likely cause of the disabled Save button. Return: (1) observations, (2) likely cause, (3) confidence.",
			},
		},
		{
			caption: "Scene/object question",
			call: {
				path: "photos/shelf.jpg",
				question:
					"List all clearly visible product labels and their shelf positions (top/middle/bottom). If unreadable, say unreadable.",
			},
		},
	];

	constructor(
		private readonly session: ToolSession,
		private readonly completeImageRequest: typeof completeSimple = completeSimple,
	) {
		this.description = prompt.render(inspectImageDescription);
	}

	async execute(
		_toolCallId: string,
		params: InspectImageParams,
		signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<InspectImageToolDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<InspectImageToolDetails>> {
		if (this.session.settings.get("images.blockImages")) {
			throw new ToolError(
				"Image submission is disabled by settings (images.blockImages=true). Disable it to use inspect_image.",
			);
		}

		const modelRegistry = this.session.modelRegistry;
		if (!modelRegistry) {
			throw new ToolError("Model registry is unavailable for inspect_image.");
		}

		const availableModels = modelRegistry.getAvailable();
		if (availableModels.length === 0) {
			throw new ToolError("No models available for inspect_image.");
		}

		const matchPreferences = getModelMatchPreferences(this.session.settings);
		const resolvePattern = (pattern: string | undefined): Model<Api> | undefined => {
			if (!pattern) return undefined;
			const expanded = expandRoleAlias(pattern, this.session.settings);
			return resolveModelFromString(expanded, availableModels, matchPreferences);
		};

		const activeModelPattern = this.session.getActiveModelString?.() ?? this.session.getModelString?.();
		let model: Model<Api> | undefined;
		let selectedPattern: string | undefined;
		for (const pattern of ["@vision", "@default", activeModelPattern]) {
			const resolved = resolvePattern(pattern);
			if (resolved) {
				model = resolved;
				selectedPattern = pattern;
				break;
			}
		}
		model ??= availableModels[0];
		if (!model) {
			throw new ToolError("Unable to resolve a model for inspect_image.");
		}

		if (!model.input.includes("image")) {
			throw new ToolError(
				`Resolved model ${model.provider}/${model.id} does not support image input. Configure a vision-capable model for modelRoles.vision.`,
			);
		}

		const apiKey = await modelRegistry.getApiKey(model);
		if (!apiKey) {
			throw new ToolError(
				`No API key available for ${model.provider}/${model.id}. Configure credentials for this provider or choose another vision-capable model.`,
			);
		}

		let imageInput: LoadedImageInput | null;
		const autoResize = this.session.settings.get("images.autoResize");
		const excludeWebP = webpExclusionForModel(model);
		const attachmentReference = parseImageAttachmentReference(params.path);
		const imageTarget = attachmentReference
			? undefined
			: await splitPathAndSelPreferringLiteral(params.path, this.session.cwd);
		const isSvgImage = imageTarget?.sel?.toLowerCase() === "img";
		try {
			if (attachmentReference) {
				imageInput = await loadAttachmentReferenceInput({
					path: params.path,
					reference: attachmentReference,
					attachments: this.session.getImageAttachments?.() ?? [],
					autoResize,
					excludeWebP,
				});
			} else if (isSvgImage && imageTarget) {
				imageInput = await loadSvgImageInput({
					path: imageTarget.path,
					cwd: this.session.cwd,
					autoResize,
					maxBytes: MAX_IMAGE_INPUT_BYTES,
					excludeWebP,
				});
			} else {
				imageInput = await loadImageInput({
					path: params.path,
					cwd: this.session.cwd,
					autoResize,
					maxBytes: MAX_IMAGE_INPUT_BYTES,
					excludeWebP,
				});
			}
		} catch (error) {
			if (error instanceof ImageInputTooLargeError) {
				throw new ToolError(error.message);
			}
			throw error;
		}

		if (!imageInput) {
			throw new ToolError(
				isSvgImage
					? "inspect_image ':img' only supports .svg and .svgz files."
					: "inspect_image only supports PNG, JPEG, GIF, and WEBP files detected by file content.",
			);
		}

		const telemetry = resolveTelemetry(this.session.getTelemetry?.(), this.session.getSessionId?.() ?? undefined);
		const timeoutMs = this.session.settings.get("inspect_image.timeoutMs");
		const hasTimeout = typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0;
		const timeoutSignal = hasTimeout ? AbortSignal.timeout(timeoutMs) : undefined;
		const effectiveSignal = timeoutSignal
			? signal
				? AbortSignal.any([signal, timeoutSignal])
				: timeoutSignal
			: signal;
		const timedOut = (): boolean => Boolean(timeoutSignal?.aborted) && !signal?.aborted;
		const formatTimeoutMessage = (): string => {
			const seconds = timeoutMs % 1000 === 0 ? `${timeoutMs / 1000}` : (timeoutMs / 1000).toFixed(1);
			return `inspect_image request timed out after ${seconds}s. Increase inspect_image.timeoutMs (currently ${timeoutMs}ms; 0 disables) or check the vision model provider.`;
		};

		// Honor the thinking effort configured on the resolved model role
		// (e.g. `modelRoles.vision: <model>:high`). Without it the oneshot sent a
		// suppressed/zero thinking budget, which thinking-only models (Gemini 3.x)
		// reject with HTTP 400 ("Budget 0 is invalid. This model only works in
		// thinking mode.").
		const configuredThinking = concreteThinkingLevel(
			extractExplicitThinkingSelector(selectedPattern, this.session.settings, {
				isLiteralModelId: (provider, id) =>
					availableModels.some(candidate => candidate.provider === provider && candidate.id === id),
			}),
		);
		const reasoning = toReasoningEffort(resolveThinkingLevelForModel(model, configuredThinking));

		let response: AssistantMessage;
		try {
			response = await instrumentedCompleteSimple(
				model,
				{
					systemPrompt: [prompt.render(inspectImageSystemPromptTemplate)],
					messages: [
						{
							role: "user",
							content: [
								{ type: "image", data: imageInput.data, mimeType: imageInput.mimeType },
								{ type: "text", text: params.question },
							],
							timestamp: Date.now(),
						},
					],
				},
				{
					apiKey: modelRegistry.resolver(model, this.session.getSessionId?.() ?? undefined),
					signal: effectiveSignal,
					reasoning,
				},
				{ telemetry, oneshotKind: "inspect_image", completeImpl: this.completeImageRequest },
			);
		} catch (error) {
			if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) {
				if (timedOut()) throw new ToolError(formatTimeoutMessage());
			}
			throw error;
		}

		if (response.stopReason === "error") {
			throw new ToolError(response.errorMessage ?? "inspect_image request failed.");
		}
		if (response.stopReason === "aborted") {
			if (timedOut()) throw new ToolError(formatTimeoutMessage());
			throw new ToolError("inspect_image request aborted.");
		}

		const text = extractTextContent(response);
		if (!text) {
			throw new ToolError("inspect_image model returned no text output.");
		}

		return {
			content: [{ type: "text", text }],
			details: {
				model: `${model.provider}/${model.id}`,
				imagePath: imageInput.resolvedPath,
				mimeType: imageInput.mimeType,
			},
		};
	}
}

export { inspectImageToolRenderer } from "./inspect-image-renderer";
