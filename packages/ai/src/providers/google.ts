import * as AIError from "../error";
import { getEnvApiKey } from "../stream";
import type { Context, Model, StreamFunction } from "../types";
import type { AssistantMessageEventStream } from "../utils/event-stream";
import {
	buildGoogleGenerateContentParams,
	type GoogleGenAIRequestPlan,
	type GoogleSharedStreamOptions,
	streamGoogleGenAI,
} from "./google-shared";

export type GoogleOptions = GoogleSharedStreamOptions;

const DEFAULT_GENERATIVE_LANGUAGE_BASE = "https://generativelanguage.googleapis.com/v1beta";

export const streamGoogle: StreamFunction<"google-generative-ai"> = (
	model: Model<"google-generative-ai">,
	context: Context,
	options?: GoogleOptions,
): AssistantMessageEventStream =>
	streamGoogleGenAI({
		model,
		options,
		api: "google-generative-ai",
		prepare: (): GoogleGenAIRequestPlan => {
			const apiKey = options?.apiKey || getEnvApiKey(model.provider);
			if (!apiKey) {
				throw new AIError.MissingApiKeyError(
					undefined,
					"Google Generative AI requires an API key (GEMINI_API_KEY or options.apiKey).",
				);
			}
			const params = buildGoogleGenerateContentParams(model, context, options ?? {});
			// `model.baseUrl` already includes the API version segment when set (mirrors the
			// `apiVersion: ""` reset that the SDK relied on for custom base URLs).
			const base = model.baseUrl?.trim() || DEFAULT_GENERATIVE_LANGUAGE_BASE;
			const url = `${base}/models/${model.id}:streamGenerateContent?alt=sse`;
			const headers: Record<string, string> = {
				"x-goog-api-key": apiKey,
				...(model.headers ?? {}),
				...(options?.headers ?? {}),
			};
			return { params, url, headers, fetch: options?.fetch };
		},
	});
