import { instrumentedCompleteSimple, resolveTelemetry } from "@oh-my-pi/pi-agent-core";
import { type Api, type AssistantMessage, completeSimple, type Model, type Usage } from "@oh-my-pi/pi-ai";
import { prompt } from "@oh-my-pi/pi-utils";
import { extractTextContent } from "../commit/utils";
import {
	expandRoleAlias,
	extractExplicitThinkingSelector,
	getModelMatchPreferences,
	resolveModelFromString,
} from "../config/model-resolver";
import imageQuestionSystemPromptTemplate from "../prompts/tools/image-question-system.md" with { type: "text" };
import { concreteThinkingLevel, resolveThinkingLevelForModel, toReasoningEffort } from "../thinking";
import type { ToolSession } from "../tools";
import { ToolError } from "../tools/tool-errors";
import type { LoadedImageInput } from "./image-loading";

/** Vision-capable model selected for an explicit image question. */
export interface ResolvedImageQuestionModel {
	model: Model<Api>;
	selectedPattern: string | undefined;
}

/** Text and accounting returned by one explicit image question. */
export interface ImageQuestionResult {
	text: string;
	model: string;
	usage: Usage;
}

/** Resolve the vision model used by `read <image>?q=<question>`. */
export function resolveImageQuestionModel(session: ToolSession): ResolvedImageQuestionModel {
	const modelRegistry = session.modelRegistry;
	if (!modelRegistry) {
		throw new ToolError("Model registry is unavailable for image questions.");
	}

	const availableModels = modelRegistry.getAvailable();
	if (availableModels.length === 0) {
		throw new ToolError("No models available for image questions.");
	}

	const matchPreferences = getModelMatchPreferences(session.settings);
	const resolvePattern = (pattern: string | undefined): Model<Api> | undefined => {
		if (!pattern) return undefined;
		const expanded = expandRoleAlias(pattern, session.settings);
		return resolveModelFromString(expanded, availableModels, matchPreferences);
	};

	const activeModelPattern = session.getActiveModelString?.() ?? session.getModelString?.();
	let model: Model<Api> | undefined;
	let selectedPattern: string | undefined;
	for (const pattern of ["@vision", "@default", activeModelPattern]) {
		const resolved = resolvePattern(pattern);
		if (resolved?.input.includes("image")) {
			model = resolved;
			selectedPattern = pattern;
			break;
		}
	}

	const activeProvider = resolvePattern(activeModelPattern)?.provider;
	model ??= availableModels.find(
		candidate => candidate.provider === activeProvider && candidate.input.includes("image"),
	);
	model ??= availableModels.find(candidate => candidate.input.includes("image"));
	if (!model) {
		const textOnly = resolvePattern("@vision") ?? resolvePattern("@default") ?? resolvePattern(activeModelPattern);
		if (!textOnly) throw new ToolError("Unable to resolve a model for image questions.");
		throw new ToolError(
			`Resolved model ${textOnly.provider}/${textOnly.id} does not support image input. Configure a vision-capable model for modelRoles.vision.`,
		);
	}

	return { model, selectedPattern };
}

/** Ask the resolved vision model a question about an already-loaded image. */
export async function askImageQuestion(
	session: ToolSession,
	resolved: ResolvedImageQuestionModel,
	image: LoadedImageInput,
	question: string,
	signal: AbortSignal | undefined,
	completeImpl: typeof completeSimple = completeSimple,
): Promise<ImageQuestionResult> {
	if (session.settings.get("images.blockImages")) {
		throw new ToolError(
			"Image submission is disabled by settings (images.blockImages=true). Disable it to ask about images.",
		);
	}

	const modelRegistry = session.modelRegistry;
	if (!modelRegistry) {
		throw new ToolError("Model registry is unavailable for image questions.");
	}
	const availableModels = modelRegistry.getAvailable();
	if (availableModels.length === 0) {
		throw new ToolError("No models available for image questions.");
	}

	const { model, selectedPattern } = resolved;
	const apiKey = await modelRegistry.getApiKey(model);
	if (!apiKey) {
		throw new ToolError(
			`No API key available for ${model.provider}/${model.id}. Configure credentials for this provider or choose another vision-capable model.`,
		);
	}

	const telemetry = resolveTelemetry(session.getTelemetry?.(), session.getSessionId?.() ?? undefined);
	const timeoutMs = session.settings.get("images.questionTimeoutMs");
	const hasTimeout = typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0;
	const timeoutSignal = hasTimeout ? AbortSignal.timeout(timeoutMs) : undefined;
	const effectiveSignal = timeoutSignal ? (signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal) : signal;
	const timedOut = (): boolean => Boolean(timeoutSignal?.aborted) && !signal?.aborted;
	const formatTimeoutMessage = (): string => {
		const seconds = timeoutMs % 1000 === 0 ? `${timeoutMs / 1000}` : (timeoutMs / 1000).toFixed(1);
		return `Image question timed out after ${seconds}s. Increase images.questionTimeoutMs (currently ${timeoutMs}ms; 0 disables) or check the vision model provider.`;
	};

	const configuredThinking = concreteThinkingLevel(
		extractExplicitThinkingSelector(selectedPattern, session.settings, {
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
				systemPrompt: [prompt.render(imageQuestionSystemPromptTemplate)],
				messages: [
					{
						role: "user",
						content: [
							{ type: "image", data: image.data, mimeType: image.mimeType },
							{ type: "text", text: question },
						],
						timestamp: Date.now(),
					},
				],
			},
			{
				apiKey: modelRegistry.resolver(model, session.getSessionId?.() ?? undefined),
				signal: effectiveSignal,
				reasoning,
			},
			{ telemetry, oneshotKind: "image_question", completeImpl },
		);
	} catch (error) {
		if (error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError")) {
			if (timedOut()) throw new ToolError(formatTimeoutMessage());
		}
		throw error;
	}

	if (response.stopReason === "error") {
		throw new ToolError(response.errorMessage ?? "Image question request failed.");
	}
	if (response.stopReason === "aborted") {
		if (timedOut()) throw new ToolError(formatTimeoutMessage());
		throw new ToolError("Image question request aborted.");
	}

	const text = extractTextContent(response);
	if (!text) {
		throw new ToolError("Vision model returned no text output.");
	}

	return {
		text,
		model: `${model.provider}/${model.id}`,
		usage: response.usage,
	};
}
