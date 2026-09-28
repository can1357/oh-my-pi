import type { Api, Model } from "@oh-my-pi/pi-catalog/types";
import {
	applyCodexResidencyHeader,
	CODEX_BASE_URL,
	getCodexAccountId,
	OPENAI_HEADER_VALUES,
	OPENAI_HEADERS,
	URL_PATHS,
} from "@oh-my-pi/pi-catalog/wire/codex";
import { parseImageMetadata, readSseJson, USER_AGENT } from "@oh-my-pi/pi-utils";
import { withAuth } from "../auth-retry";
import * as AIError from "../error";
import { errorMessage, ImageApiError, modelHeaders, resolveOpenAIImageSize, toDataUrl, usageFromWire } from "./shared";
import type { GeneratedImage, ImageGenerationOptions, ImageGenerationRequest, ImageGenerationResult } from "./types";

const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
const IMAGE_SYSTEM_INSTRUCTION =
	"You are an AI image generator. Generate images based on user descriptions. Focus on creating high-quality, visually appealing images that match the user's request.";

interface HostedOutput {
	type: "image_generation_call" | "message";
	result?: string;
	size?: string;
	quality?: string;
	content?: Array<{ type?: string; text?: string; refusal?: string }>;
}

interface HostedResponse {
	output?: HostedOutput[];
	/** Resolved tool configuration echoed by the backend, including the image model that actually ran. */
	tools?: Array<{ type?: string; model?: string }>;
	usage?: { input_tokens?: number; output_tokens?: number };
	error?: { message?: string };
}

interface HostedEvent {
	type?: string;
	item?: HostedOutput;
	response?: HostedResponse;
	error?: { message?: string };
	message?: string;
}

function responsesUrl(model: Model<Api>): string {
	const fallback =
		model.api === "openai-codex-responses" || model.provider === "openai-codex"
			? CODEX_BASE_URL
			: DEFAULT_OPENAI_BASE_URL;
	const baseUrl = (model.baseUrl || fallback).replace(/\/+$/, "");
	if (model.api !== "openai-codex-responses" && model.provider !== "openai-codex") {
		return `${baseUrl}/responses`;
	}
	const baseWithSlash = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
	return new URL(URL_PATHS.RESPONSES.slice(1), baseWithSlash)
		.toString()
		.replace(URL_PATHS.RESPONSES, URL_PATHS.CODEX_RESPONSES);
}

async function headers(
	carrier: Model<Api>,
	key: string,
	sessionId: string | undefined,
	signal?: AbortSignal,
): Promise<Headers> {
	const result = new Headers(await modelHeaders(carrier, signal));
	result.set("Content-Type", "application/json");
	result.set("Authorization", `Bearer ${key}`);
	if (carrier.api === "openai-codex-responses" || carrier.provider === "openai-codex") {
		const accountId = getCodexAccountId(key);
		result.delete("x-api-key");
		if (accountId) result.set(OPENAI_HEADERS.ACCOUNT_ID, accountId);
		applyCodexResidencyHeader(result, key);
		result.set(OPENAI_HEADERS.BETA, OPENAI_HEADER_VALUES.BETA_RESPONSES);
		result.set(OPENAI_HEADERS.ORIGINATOR, OPENAI_HEADER_VALUES.ORIGINATOR_CODEX);
		result.set("User-Agent", USER_AGENT);
		if (sessionId) {
			result.set(OPENAI_HEADERS.CONVERSATION_ID, sessionId);
			result.set(OPENAI_HEADERS.SESSION_ID, sessionId);
		}
	}
	return result;
}

function collectResponse(response: HostedResponse): ImageGenerationResult {
	const images: GeneratedImage[] = [];
	const texts: string[] = [];
	for (const output of response.output ?? []) {
		if (output.type === "image_generation_call" && output.result) {
			const bytes = Buffer.from(output.result, "base64");
			images.push({
				data: output.result,
				mimeType: parseImageMetadata(bytes)?.mimeType ?? "image/webp",
				...(output.size ? { size: output.size } : {}),
				...(output.quality ? { quality: output.quality } : {}),
			});
		}
		if (output.type === "message") {
			for (const part of output.content ?? []) {
				if (part.type === "output_text" && part.text) texts.push(part.text);
				if (part.type === "refusal" && part.refusal) texts.push(part.refusal);
			}
		}
	}
	const text = texts.join("\n").trim();
	const model = response.tools?.find(tool => tool.type === "image_generation")?.model;
	return {
		images,
		...(text ? { text } : {}),
		usage: usageFromWire(response.usage),
		...(model ? { model } : {}),
	};
}

async function parseSse(response: Response, signal?: AbortSignal): Promise<ImageGenerationResult> {
	if (!response.body) {
		throw new AIError.ProviderResponseError("OpenAI hosted image response has no body", { kind: "empty-body" });
	}
	const fallbackOutput: HostedOutput[] = [];
	let completed: HostedResponse | undefined;
	for await (const event of readSseJson<HostedEvent>(response.body, signal)) {
		if (event.type === "error") {
			throw new AIError.ProviderResponseError(
				event.error?.message ?? event.message ?? "OpenAI image request failed",
			);
		}
		if (event.type === "response.failed") {
			throw new AIError.ProviderResponseError(event.response?.error?.message ?? "OpenAI image request failed");
		}
		if (event.type === "response.output_item.done" && event.item) fallbackOutput.push(event.item);
		if ((event.type === "response.completed" || event.type === "response.done") && event.response) {
			completed = event.response;
		}
	}
	return collectResponse(completed?.output?.length ? completed : { ...completed, output: fallbackOutput });
}

export async function generateHostedImage(
	model: Model,
	request: ImageGenerationRequest,
	options: ImageGenerationOptions,
): Promise<ImageGenerationResult> {
	const carrier = options.carrier;
	if (!carrier) throw new AIError.ValidationError("Hosted image generation requires an explicit carrier model");
	if (carrier.api !== "openai-responses" && carrier.api !== "openai-codex-responses") {
		throw new AIError.ValidationError(`Hosted image carrier API ${carrier.api} is unsupported`);
	}
	const stream = carrier.api === "openai-codex-responses";
	const content: Array<Record<string, unknown>> = [{ type: "input_text", text: request.prompt }];
	for (const image of request.inputImages ?? []) {
		content.push({ type: "input_image", detail: "auto", image_url: toDataUrl(image) });
	}
	const size = resolveOpenAIImageSize(request.aspectRatio, request.imageSize);
	const tool = {
		type: "image_generation",
		action: content.length > 1 ? "edit" : "generate",
		output_format: "webp",
		...(size ? { size } : {}),
		...(model.api === "openai-responses" ? { model: model.requestModelId ?? model.id } : {}),
	};
	const body = {
		model: carrier.requestModelId ?? carrier.id,
		input: [{ role: "user", content }],
		tools: [tool],
		tool_choice: { type: "image_generation" },
		store: false,
		...(stream ? { instructions: IMAGE_SYSTEM_INSTRUCTION, stream: true } : {}),
	};
	const fetchImpl = options.fetch ?? fetch;
	return withAuth(
		options.apiKey,
		async key => {
			const response = await fetchImpl(responsesUrl(carrier), {
				method: "POST",
				headers: await headers(carrier, key, options.sessionId, options.signal),
				body: JSON.stringify(body),
				signal: options.signal,
			});
			if (!response.ok) {
				const text = await response.text();
				throw new ImageApiError(
					`OpenAI image request failed (${response.status}): ${errorMessage(text)}`,
					response.status,
					{ headers: response.headers },
				);
			}
			if (stream || response.headers.get("content-type")?.includes("text/event-stream")) {
				return parseSse(response, options.signal);
			}
			const value = (await response.json()) as HostedResponse;
			if (value.error) throw new AIError.ProviderResponseError(value.error.message ?? "OpenAI image request failed");
			if (!Array.isArray(value.output)) {
				throw new AIError.ProviderResponseError("OpenAI image request returned a malformed response", {
					kind: "envelope",
				});
			}
			return collectResponse(value);
		},
		{ signal: options.signal },
	);
}
