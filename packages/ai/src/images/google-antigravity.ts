import {
	ANTIGRAVITY_PRIMARY_ENDPOINT,
	ANTIGRAVITY_SANDBOX_ENDPOINT,
	fetchAntigravityImageModel,
} from "@oh-my-pi/pi-catalog/discovery/antigravity";
import type { Model } from "@oh-my-pi/pi-catalog/types";
import { getAntigravityUserAgent } from "@oh-my-pi/pi-catalog/wire/gemini-headers";
import { readSseJson } from "@oh-my-pi/pi-utils";
import { withAuth } from "../auth-retry";
import * as AIError from "../error";
import { errorMessage, ImageApiError, usageFromWire } from "./shared";
import type { GeneratedImage, ImageGenerationOptions, ImageGenerationRequest, ImageGenerationResult } from "./types";

const IMAGE_SYSTEM_INSTRUCTION =
	"You are an AI image generator. Generate images based on user descriptions. Focus on creating high-quality, visually appealing images that match the user's request.";

interface AntigravityCredentials {
	accessToken: string;
	projectId: string;
}

interface AntigravityTarget {
	model: string;
	endpoints: string[];
}

interface AntigravityChunk {
	response?: {
		candidates?: Array<{
			content?: { parts?: Array<{ text?: string; inlineData?: { data?: string; mimeType?: string } }> };
		}>;
		usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
	};
}

export function parseAntigravityCredentials(raw: string): AntigravityCredentials | undefined {
	try {
		const parsed = JSON.parse(raw) as { token?: unknown; projectId?: unknown };
		if (typeof parsed.token === "string" && typeof parsed.projectId === "string") {
			return { accessToken: parsed.token, projectId: parsed.projectId };
		}
	} catch {
		// Report the same validation error below.
	}
	return undefined;
}

function antigravityEndpoints(model: Model): string[] {
	const configured = model.baseUrl.replace(/\/+$/, "");
	return [...new Set([configured, ANTIGRAVITY_PRIMARY_ENDPOINT, ANTIGRAVITY_SANDBOX_ENDPOINT])];
}

async function resolveTarget(
	model: Model,
	credentials: AntigravityCredentials,
	fetchImpl: ImageGenerationOptions["fetch"],
	signal?: AbortSignal,
): Promise<AntigravityTarget> {
	const endpoints = antigravityEndpoints(model);
	const advertised = await fetchAntigravityImageModel({
		token: credentials.accessToken,
		endpoint: endpoints.length === 1 ? endpoints[0] : undefined,
		userAgent: getAntigravityUserAgent(),
		signal,
		fetcher: fetchImpl,
	});
	return advertised
		? {
				model: advertised.id,
				endpoints: [advertised.endpoint, ...endpoints.filter(endpoint => endpoint !== advertised.endpoint)],
			}
		: { model: model.requestModelId ?? model.id, endpoints };
}

function buildRequest(request: ImageGenerationRequest, model: string, projectId: string): Record<string, unknown> {
	const parts: Array<{ text?: string; inlineData?: GeneratedImage }> = (request.inputImages ?? []).map(image => ({
		inlineData: image,
	}));
	parts.push({ text: request.prompt });
	const imageConfig =
		request.aspectRatio || request.imageSize
			? { aspectRatio: request.aspectRatio, imageSize: request.imageSize }
			: undefined;
	return {
		project: projectId,
		model,
		request: {
			contents: [{ role: "user", parts }],
			systemInstruction: { parts: [{ text: IMAGE_SYSTEM_INSTRUCTION }] },
			generationConfig: {
				responseModalities: ["IMAGE"],
				...(imageConfig ? { imageConfig } : {}),
				candidateCount: request.count ?? 1,
			},
			safetySettings: [
				{ category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_ONLY_HIGH" },
				{ category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_ONLY_HIGH" },
				{ category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_ONLY_HIGH" },
				{ category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_ONLY_HIGH" },
				{ category: "HARM_CATEGORY_CIVIC_INTEGRITY", threshold: "BLOCK_ONLY_HIGH" },
			],
		},
		requestType: "agent",
		requestId: `agent-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`,
		userAgent: "antigravity",
	};
}

async function parseSse(response: Response, signal?: AbortSignal): Promise<ImageGenerationResult> {
	if (!response.body) {
		throw new AIError.ProviderResponseError("Antigravity image response has no body", { kind: "empty-body" });
	}
	const images: GeneratedImage[] = [];
	const texts: string[] = [];
	let usage = usageFromWire(undefined);
	for await (const chunk of readSseJson<AntigravityChunk>(response.body, signal)) {
		for (const candidate of chunk.response?.candidates ?? []) {
			for (const part of candidate.content?.parts ?? []) {
				if (part.text) texts.push(part.text);
				if (part.inlineData?.data && part.inlineData.mimeType) {
					images.push({ data: part.inlineData.data, mimeType: part.inlineData.mimeType });
				}
			}
		}
		const metadata = chunk.response?.usageMetadata;
		if (metadata) {
			usage = usageFromWire({
				input_tokens: metadata.promptTokenCount,
				output_tokens: metadata.candidatesTokenCount,
			});
		}
	}
	const text = texts.join(" ").trim();
	return { images, ...(text ? { text } : {}), usage };
}

export async function generateAntigravityImage(
	model: Model,
	request: ImageGenerationRequest,
	options: ImageGenerationOptions,
): Promise<ImageGenerationResult> {
	const fetchImpl = options.fetch ?? fetch;
	const response = await withAuth(
		options.apiKey,
		async rawKey => {
			const credentials = parseAntigravityCredentials(rawKey);
			if (!credentials) {
				throw new AIError.ValidationError("Antigravity image credentials must contain token and projectId");
			}
			const target = await resolveTarget(model, credentials, fetchImpl, options.signal);
			const body = buildRequest(request, target.model, credentials.projectId);
			let lastError: ImageApiError | undefined;
			for (let index = 0; index < target.endpoints.length; index++) {
				const result = await fetchImpl(`${target.endpoints[index]}/v1internal:streamGenerateContent?alt=sse`, {
					method: "POST",
					headers: {
						Authorization: `Bearer ${credentials.accessToken}`,
						"Content-Type": "application/json",
						Accept: "text/event-stream",
						"User-Agent": getAntigravityUserAgent(),
					},
					body: JSON.stringify(body),
					signal: options.signal,
				});
				if (result.ok) return result;
				const text = await result.text();
				lastError = new ImageApiError(
					`${model.provider}/${model.id} image request failed (${result.status}): ${errorMessage(text)}`,
					result.status,
					{ headers: result.headers },
				);
				const retryable = result.status === 429 || result.status >= 500;
				if (!retryable || index === target.endpoints.length - 1) throw lastError;
			}
			throw lastError ?? new AIError.ProviderResponseError("Antigravity image request failed");
		},
		{ signal: options.signal },
	);
	return parseSse(response, options.signal);
}
