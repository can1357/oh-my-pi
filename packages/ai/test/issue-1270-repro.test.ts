import { afterEach, describe, expect, it } from "bun:test";
import { __resetVertexTokenCache } from "@oh-my-pi/pi-ai/providers/google-auth";
import { streamGoogleVertex } from "@oh-my-pi/pi-ai/providers/google-vertex";
import type { Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

const OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
const METADATA_TOKEN_URL = "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token";

const context = {
	messages: [{ role: "user" as const, content: "hello", timestamp: 0 }],
};

const model: Model<"google-vertex"> = buildModel({
	id: "gemini-3.1-pro-preview",
	name: "Gemini 3.1 Pro Preview",
	api: "google-vertex",
	provider: "google-vertex",
	baseUrl: "https://{location}-aiplatform.googleapis.com",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1_000_000,
	maxTokens: 65_536,
});

describe("issue #1270: Vertex AI global endpoint", () => {
	const originalApiKey = Bun.env.GOOGLE_CLOUD_API_KEY;
	const originalCredentials = Bun.env.GOOGLE_APPLICATION_CREDENTIALS;

	afterEach(() => {
		__resetVertexTokenCache();
		if (originalApiKey === undefined) delete Bun.env.GOOGLE_CLOUD_API_KEY;
		else Bun.env.GOOGLE_CLOUD_API_KEY = originalApiKey;
		if (originalCredentials === undefined) delete Bun.env.GOOGLE_APPLICATION_CREDENTIALS;
		else Bun.env.GOOGLE_APPLICATION_CREDENTIALS = originalCredentials;
	});

	it("uses the global Vertex AI service host for locations/global", async () => {
		delete Bun.env.GOOGLE_CLOUD_API_KEY;
		delete Bun.env.GOOGLE_APPLICATION_CREDENTIALS;

		const urls: string[] = [];
		const stream = streamGoogleVertex(model, context, {
			project: "vertex-project",
			location: "global",
			fetch: async input => {
				const url = input instanceof Request ? input.url : input.toString();
				urls.push(url);
				// The assertion below is about the Vertex model URL; local user ADC may
				// hit OAuth before the model request, while CI without ADC uses metadata.
				if (url === METADATA_TOKEN_URL || url === OAUTH_TOKEN_URL) {
					return new Response(JSON.stringify({ access_token: "token", expires_in: 3600 }));
				}
				return new Response('{"error":{"message":"stop after capture"}}', { status: 400 });
			},
		});

		await stream.result();

		expect(urls).toContain(
			"https://aiplatform.googleapis.com/v1/projects/vertex-project/locations/global/publishers/google/models/gemini-3.1-pro-preview:streamGenerateContent?alt=sse",
		);
	});

	it.each([
		{
			location: "eu",
			host: "aiplatform.eu.rep.googleapis.com",
		},
		{
			location: "us",
			host: "aiplatform.us.rep.googleapis.com",
		},
		{
			location: "europe-west4",
			host: "europe-west4-aiplatform.googleapis.com",
		},
	] as const)("uses the $host host for location $location", async ({ location, host }) => {
		delete Bun.env.GOOGLE_CLOUD_API_KEY;
		delete Bun.env.GOOGLE_APPLICATION_CREDENTIALS;

		const urls: string[] = [];
		const stream = streamGoogleVertex(model, context, {
			project: "vertex-project",
			location,
			fetch: async input => {
				const url = input instanceof Request ? input.url : input.toString();
				urls.push(url);
				if (url === METADATA_TOKEN_URL || url === OAUTH_TOKEN_URL) {
					return new Response(JSON.stringify({ access_token: "token", expires_in: 3600 }));
				}
				return new Response('{"error":{"message":"stop after capture"}}', { status: 400 });
			},
		});

		await stream.result();

		expect(urls).toContain(
			`https://${host}/v1/projects/vertex-project/locations/${location}/publishers/google/models/gemini-3.1-pro-preview:streamGenerateContent?alt=sse`,
		);
	});
});
