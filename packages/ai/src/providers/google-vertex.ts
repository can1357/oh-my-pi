import { $env } from "@pk-nerdsaver-ai/pi-utils";
import * as AIError from "../error";
import type { Context, Model, StreamFunction } from "../types";
import type { AssistantMessageEventStream } from "../utils/event-stream";
import { getVertexAccessToken } from "./google-auth";
import {
	buildGoogleGenerateContentParams,
	type GoogleGenAIRequestPlan,
	type GoogleSharedStreamOptions,
	streamGoogleGenAI,
} from "./google-shared";

export interface GoogleVertexOptions extends GoogleSharedStreamOptions {
	project?: string;
	location?: string;
}

const API_VERSION = "v1";

export const streamGoogleVertex: StreamFunction<"google-vertex"> = (
	model: Model<"google-vertex">,
	context: Context,
	options?: GoogleVertexOptions,
): AssistantMessageEventStream =>
	streamGoogleGenAI({
		model,
		options,
		api: "google-vertex",
		retainTextSignature: true,
		prepare: async (): Promise<GoogleGenAIRequestPlan> => {
			const apiKey = resolveApiKey(options);
			const params = buildGoogleGenerateContentParams(model, context, options ?? {});
			const baseHeaders: Record<string, string> = {
				...(model.headers ?? {}),
				...(options?.headers ?? {}),
			};

			if (apiKey) {
				const url = `https://aiplatform.googleapis.com/${API_VERSION}/publishers/google/models/${model.id}:streamGenerateContent?alt=sse`;
				return {
					params,
					url,
					headers: { ...baseHeaders, "x-goog-api-key": apiKey },
					fetch: options?.fetch,
				};
			}

			const project = resolveProject(options);
			const location = resolveLocation(options);
			const accessToken = await getVertexAccessToken({ signal: options?.signal, fetch: options?.fetch });
			const host = resolveEndpointHost(location);
			const url = `https://${host}/${API_VERSION}/projects/${project}/locations/${location}/publishers/google/models/${model.id}:streamGenerateContent?alt=sse`;
			return {
				params,
				url,
				headers: { ...baseHeaders, Authorization: `Bearer ${accessToken}` },
				fetch: options?.fetch,
			};
		},
	});

function resolveApiKey(options?: GoogleVertexOptions): string | undefined {
	// options.apiKey may contain sentinel values like "<authenticated>" or "N/A"
	// leaked from the agent loop — only use it if it looks like a real API key.
	const optKey = options?.apiKey;
	const realKey = optKey && !optKey.startsWith("<") && optKey !== "N/A" ? optKey : undefined;
	return realKey || $env.GOOGLE_CLOUD_API_KEY;
}

function resolveProject(options?: GoogleVertexOptions): string {
	const project = options?.project || $env.GOOGLE_CLOUD_PROJECT || $env.GCP_PROJECT || $env.GCLOUD_PROJECT;
	if (!project) {
		throw new AIError.ConfigurationError(
			"Vertex AI requires a project ID. Set GOOGLE_CLOUD_PROJECT/GCP_PROJECT/GCLOUD_PROJECT or pass project in options.",
		);
	}
	return project;
}

function resolveEndpointHost(location: string): string {
	return location === "global" ? "aiplatform.googleapis.com" : `${location}-aiplatform.googleapis.com`;
}
function resolveLocation(options?: GoogleVertexOptions): string {
	const location =
		options?.location || $env.GOOGLE_VERTEX_LOCATION || $env.GOOGLE_CLOUD_LOCATION || $env.VERTEX_LOCATION;
	if (!location) {
		throw new AIError.ConfigurationError(
			"Vertex AI requires a location. Set GOOGLE_VERTEX_LOCATION/GOOGLE_CLOUD_LOCATION/VERTEX_LOCATION or pass location in options.",
		);
	}
	return location;
}
