import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test";
import { type ChildProcess, execSync, spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { Effort } from "@oh-my-pi/pi-ai";
import { __resetVertexTokenCache } from "@oh-my-pi/pi-ai/providers/google-auth";
import { complete, getEnvApiKey, stream } from "@oh-my-pi/pi-ai/stream";
import type { Api, Context, ImageContent, Model, OptionsForApi, Tool, ToolResultMessage } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { $which } from "@oh-my-pi/pi-utils";
import { removeWithRetries } from "../../utils/src/temp";
import { e2eApiKey, resolveApiKey } from "./oauth";

// Resolve OAuth tokens at module level (async, runs before tests)
const oauthTokens = await Promise.all([
	resolveApiKey("anthropic"),
	resolveApiKey("github-copilot"),
	resolveApiKey("google-gemini-cli"),
	resolveApiKey("google-antigravity"),
	resolveApiKey("openai-codex"),
]);
const [anthropicOAuthToken, githubCopilotToken, geminiCliToken, antigravityToken, openaiCodexToken] = oauthTokens;

function hasBedrockCredentials(): boolean {
	const region = e2eApiKey("AWS_REGION") ?? e2eApiKey("AWS_DEFAULT_REGION");
	if (!region) return false;

	// Conservative check: Bedrock needs a region plus either explicit env creds or a profile.
	// Reads go through e2eApiKey so the live test only runs under E2E=1.
	const awsProfile = e2eApiKey("AWS_PROFILE");
	return Boolean(
		(e2eApiKey("AWS_ACCESS_KEY_ID") && e2eApiKey("AWS_SECRET_ACCESS_KEY")) || (awsProfile && awsProfile.length > 0),
	);
}

// Calculator tool definition (same as examples)
const calculatorSchema = type({
	a: "number",
	b: "number",
	operation: "'add'|'subtract'|'multiply'|'divide'",
});

const calculatorTool: Tool<typeof calculatorSchema> = {
	name: "math_operation",
	description: "Perform basic arithmetic operations",
	parameters: calculatorSchema,
};

async function basicTextGeneration<TApi extends Api>(model: Model<TApi>, options?: OptionsForApi<TApi>) {
	const context: Context = {
		systemPrompt: ["You are a helpful assistant. Be concise."],
		messages: [{ role: "user", content: "Reply with exactly: 'Hello test successful'", timestamp: Date.now() }],
	};
	const response = await complete(model, context, options);

	expect(response.role).toBe("assistant");
	expect(response.usage.input + response.usage.cacheRead).toBeGreaterThan(0);
	expect(response.usage.output).toBeGreaterThan(0);
	expect(response.errorMessage).toBeFalsy();
	expect(response.content.map(b => (b.type === "text" ? b.text : "")).join("")).toContain("Hello test successful");

	context.messages.push(response);
	context.messages.push({ role: "user", content: "Now say 'Goodbye test successful'", timestamp: Date.now() });

	const secondResponse = await complete(model, context, options);

	expect(secondResponse.role).toBe("assistant");
	expect(secondResponse.usage.input + secondResponse.usage.cacheRead).toBeGreaterThan(0);
	expect(secondResponse.usage.output).toBeGreaterThan(0);
	expect(secondResponse.errorMessage).toBeFalsy();
	expect(secondResponse.content.map(b => (b.type === "text" ? b.text : "")).join("")).toContain(
		"Goodbye test successful",
	);
}

async function handleToolCall<TApi extends Api>(model: Model<TApi>, options?: OptionsForApi<TApi>) {
	const context: Context = {
		systemPrompt: ["You are a helpful assistant that uses tools when asked."],
		messages: [
			{
				role: "user",
				content: "Calculate 15 + 27 using the math_operation tool.",
				timestamp: Date.now(),
			},
		],
		tools: [calculatorTool],
	};

	const s = stream(model, context, options);
	let hasToolStart = false;
	let hasToolDelta = false;
	let hasToolEnd = false;
	let accumulatedToolArgs = "";
	let index = 0;
	for await (const event of s) {
		if (event.type === "toolcall_start") {
			hasToolStart = true;
			const toolCall = event.partial.content[event.contentIndex];
			index = event.contentIndex;
			expect(toolCall.type).toBe("toolCall");
			if (toolCall.type === "toolCall") {
				expect(toolCall.name).toBe("math_operation");
				expect(toolCall.id).toBeTruthy();
			}
		}
		if (event.type === "toolcall_delta") {
			hasToolDelta = true;
			const toolCall = event.partial.content[event.contentIndex];
			expect(event.contentIndex).toBe(index);
			expect(toolCall.type).toBe("toolCall");
			if (toolCall.type === "toolCall") {
				expect(toolCall.name).toBe("math_operation");
				accumulatedToolArgs += event.delta;
				// Check that we have a parsed arguments object during streaming
				expect(toolCall.arguments).toBeDefined();
				expect(typeof toolCall.arguments).toBe("object");
				// The arguments should be partially populated as we stream
				// At minimum it should be an empty object, never undefined
				expect(toolCall.arguments).not.toBeNull();
			}
		}
		if (event.type === "toolcall_end") {
			hasToolEnd = true;
			const toolCall = event.partial.content[event.contentIndex];
			expect(event.contentIndex).toBe(index);
			expect(toolCall.type).toBe("toolCall");
			if (toolCall.type === "toolCall") {
				expect(toolCall.name).toBe("math_operation");
				JSON.parse(accumulatedToolArgs);
				expect(toolCall.arguments).not.toBeUndefined();
				expect((toolCall.arguments as any).a).toBe(15);
				expect((toolCall.arguments as any).b).toBe(27);
				expect(["add", "subtract", "multiply", "divide"]).toContain((toolCall.arguments as any).operation);
			}
		}
	}

	expect(hasToolStart).toBe(true);
	expect(hasToolDelta).toBe(true);
	expect(hasToolEnd).toBe(true);

	const response = await s.result();
	expect(response.stopReason).toBe("toolUse");
	expect(response.content.some(b => b.type === "toolCall")).toBeTruthy();
	const toolCall = response.content.find(b => b.type === "toolCall");
	if (toolCall && toolCall.type === "toolCall") {
		expect(toolCall.name).toBe("math_operation");
		expect(toolCall.id).toBeTruthy();
	} else {
		throw new Error("No tool call found in response");
	}
}

async function handleStreaming<TApi extends Api>(model: Model<TApi>, options?: OptionsForApi<TApi>) {
	let textStarted = false;
	let textChunks = "";
	let textCompleted = false;

	const context: Context = {
		messages: [{ role: "user", content: "Count from 1 to 3", timestamp: Date.now() }],
	};

	const s = stream(model, context, options);

	for await (const event of s) {
		if (event.type === "text_start") {
			textStarted = true;
		} else if (event.type === "text_delta") {
			textChunks += event.delta;
		} else if (event.type === "text_end") {
			textCompleted = true;
		}
	}

	const response = await s.result();

	expect(textStarted).toBe(true);
	expect(textChunks.length).toBeGreaterThan(0);
	expect(textCompleted).toBe(true);
	expect(response.content.some(b => b.type === "text")).toBeTruthy();
}

async function handleThinking<TApi extends Api>(model: Model<TApi>, options?: OptionsForApi<TApi>) {
	let thinkingStarted = false;
	let thinkingChunks = "";
	let thinkingCompleted = false;

	const context: Context = {
		messages: [
			{
				role: "user",
				content: `Think long and hard about ${
					(Math.random() * 255) | 0
				} + 27. Think step by step. Then output the result.`,
				timestamp: Date.now(),
			},
		],
	};

	const s = stream(model, context, options);

	for await (const event of s) {
		if (event.type === "thinking_start") {
			thinkingStarted = true;
		} else if (event.type === "thinking_delta") {
			thinkingChunks += event.delta;
		} else if (event.type === "thinking_end") {
			thinkingCompleted = true;
		}
	}

	const response = await s.result();

	expect(response.stopReason, `Error: ${response.errorMessage}`).toBe("stop");
	expect(thinkingStarted).toBe(true);
	expect(thinkingChunks.length).toBeGreaterThan(0);
	expect(thinkingCompleted).toBe(true);
	expect(response.content.some(b => b.type === "thinking")).toBeTruthy();
}

async function handleImage<TApi extends Api>(model: Model<TApi>, options?: OptionsForApi<TApi>) {
	// Check if the model supports images
	if (!model.input.includes("image")) {
		console.log(`Skipping image test - model ${model.id} doesn't support images`);
		return;
	}

	// Read the test image
	const imagePath = path.join(import.meta.dir, "data", "red-circle.png");
	const imageBuffer = await fs.readFile(imagePath);
	const base64Image = imageBuffer.toBase64();

	const imageContent: ImageContent = {
		type: "image",
		data: base64Image,
		mimeType: "image/png",
	};

	const context: Context = {
		messages: [
			{
				role: "user",
				content: [
					{
						type: "text",
						text: "What do you see in this image? Please describe the shape (circle, rectangle, square, triangle, ...) and color (red, blue, green, ...). You MUST reply in English.",
					},
					imageContent,
				],
				timestamp: Date.now(),
			},
		],
	};

	const response = await complete(model, context, options);

	// Check the response mentions red and circle
	const textContent = response.content.find(b => b.type === "text");
	if (textContent && textContent.type === "text") {
		const lowerContent = textContent.text.toLowerCase();
		expect(lowerContent).toContain("red");
		expect(lowerContent).toContain("circle");
	}
}

async function multiTurn<TApi extends Api>(model: Model<TApi>, options?: OptionsForApi<TApi>) {
	const context: Context = {
		systemPrompt: ["You are a helpful assistant that can use tools to answer questions."],
		messages: [
			{
				role: "user",
				content: "Think about this briefly, then calculate 42 * 17 and 453 + 434 using the math_operation tool.",
				timestamp: Date.now(),
			},
		],
		tools: [calculatorTool],
	};

	// Collect all text content from all assistant responses
	let allTextContent = "";
	let hasSeenThinking = false;
	let hasSeenToolCalls = false;
	const maxTurns = 5; // Prevent infinite loops

	for (let turn = 0; turn < maxTurns; turn++) {
		const response = await complete(model, context, options);

		// Add the assistant response to context
		context.messages.push(response);

		// Process content blocks
		const results: ToolResultMessage[] = [];
		for (const block of response.content) {
			if (block.type === "text") {
				allTextContent += block.text;
			} else if (block.type === "thinking") {
				hasSeenThinking = true;
			} else if (block.type === "toolCall") {
				hasSeenToolCalls = true;

				// Process the tool call
				expect(block.name).toBe("math_operation");
				expect(block.id).toBeTruthy();
				expect(block.arguments).toBeTruthy();

				const a = Number(block.arguments.a);
				const b = Number(block.arguments.b);
				const operation = typeof block.arguments.operation === "string" ? block.arguments.operation : "";
				let result: number;
				switch (operation) {
					case "add":
						result = a + b;
						break;
					case "multiply":
						result = a * b;
						break;
					default:
						result = 0;
				}

				// Add tool result to context
				results.push({
					role: "toolResult",
					toolCallId: block.id,
					toolName: block.name,
					content: [{ type: "text", text: `${result}` }],
					isError: false,
					timestamp: Date.now(),
				});
			}
		}
		context.messages.push(...results);

		// If we got a stop response with text content, we're likely done
		expect(response.stopReason, `Error: ${response.errorMessage}`).not.toBe("error");
		if (response.stopReason === "stop") {
			break;
		}
	}

	// Verify we got either thinking content or tool calls (or both)
	expect(hasSeenThinking || hasSeenToolCalls).toBe(true);

	// The accumulated text should reference both calculations
	expect(allTextContent.includes("714")).toBe(true);
	expect(allTextContent.includes("887")).toBe(true);
}

describe("Generate E2E Tests", () => {
	describe.skipIf(!e2eApiKey("GEMINI_API_KEY"))("Gemini Provider (gemini-2.5-flash)", () => {
		const llm = getBundledModel("google", "gemini-2.5-flash");

		it(
			"should complete basic text generation",
			async () => {
				await basicTextGeneration(llm);
			},
			{ retry: 3 },
		);

		it(
			"should handle tool calling",
			async () => {
				await handleToolCall(llm);
			},
			{ retry: 3 },
		);

		it(
			"should handle streaming",
			async () => {
				await handleStreaming(llm);
			},
			{ retry: 3 },
		);

		it(
			"should handle ",
			async () => {
				await handleThinking(llm, { thinking: { enabled: true, budgetTokens: 1024 } });
			},
			{ retry: 3 },
		);

		it(
			"should handle multi-turn with thinking and tools",
			async () => {
				await multiTurn(llm, { thinking: { enabled: true, budgetTokens: 2048 } });
			},
			{ retry: 3 },
		);

		it(
			"should handle image input",
			async () => {
				await handleImage(llm);
			},
			{ retry: 3 },
		);
	});

	describe("google-vertex env auth", () => {
		it("treats GOOGLE_CLOUD_API_KEY as a configured google-vertex credential", () => {
			const originalApiKey = Bun.env.GOOGLE_CLOUD_API_KEY;
			const originalProject = Bun.env.GOOGLE_CLOUD_PROJECT;
			const originalGcloudProject = Bun.env.GCLOUD_PROJECT;
			const originalLocation = Bun.env.GOOGLE_CLOUD_LOCATION;
			const originalApplicationCredentials = Bun.env.GOOGLE_APPLICATION_CREDENTIALS;

			try {
				Bun.env.GOOGLE_CLOUD_API_KEY = "vertex-test-key";
				delete Bun.env.GOOGLE_CLOUD_PROJECT;
				delete Bun.env.GCLOUD_PROJECT;
				delete Bun.env.GOOGLE_CLOUD_LOCATION;
				delete Bun.env.GOOGLE_APPLICATION_CREDENTIALS;

				expect(getEnvApiKey("google-vertex")).toBe("vertex-test-key");
			} finally {
				if (originalApiKey === undefined) delete Bun.env.GOOGLE_CLOUD_API_KEY;
				else Bun.env.GOOGLE_CLOUD_API_KEY = originalApiKey;
				if (originalProject === undefined) delete Bun.env.GOOGLE_CLOUD_PROJECT;
				else Bun.env.GOOGLE_CLOUD_PROJECT = originalProject;
				if (originalGcloudProject === undefined) delete Bun.env.GCLOUD_PROJECT;
				else Bun.env.GCLOUD_PROJECT = originalGcloudProject;
				if (originalLocation === undefined) delete Bun.env.GOOGLE_CLOUD_LOCATION;
				else Bun.env.GOOGLE_CLOUD_LOCATION = originalLocation;
				if (originalApplicationCredentials === undefined) delete Bun.env.GOOGLE_APPLICATION_CREDENTIALS;
				else Bun.env.GOOGLE_APPLICATION_CREDENTIALS = originalApplicationCredentials;
			}
		});

		it("ignores sentinel apiKey values like '<authenticated>' passed from agent loop", async () => {
			const originalProject = Bun.env.GOOGLE_CLOUD_PROJECT;
			const originalLocation = Bun.env.GOOGLE_CLOUD_LOCATION;
			const originalApiKey = Bun.env.GOOGLE_CLOUD_API_KEY;
			const llm = getBundledModel("google-vertex", "gemini-3-flash-preview");
			const controller = new AbortController();
			controller.abort();

			// Capture console.debug to detect SDK warnings
			const debugMessages: string[] = [];
			const origDebug = console.debug;
			console.debug = (...args: unknown[]) => {
				debugMessages.push(args.map(String).join(" "));
			};

			try {
				Bun.env.GOOGLE_CLOUD_PROJECT = "test-project";
				Bun.env.GOOGLE_CLOUD_LOCATION = "us-central1";
				delete Bun.env.GOOGLE_CLOUD_API_KEY;

				// The agent loop passes "<authenticated>" as apiKey for credential-less providers.
				// google-vertex should ignore this sentinel and use ADC (project/location) instead.
				await complete(
					llm,
					{ messages: [{ role: "user", content: "Hello", timestamp: Date.now() }] },
					{ apiKey: "<authenticated>", signal: controller.signal },
				);

				// Should NOT trigger the SDK warning about API key taking precedence
				const hasWarning = debugMessages.some(m => m.includes("API key will take precedence"));
				expect(hasWarning).toBe(false);
			} finally {
				console.debug = origDebug;
				if (originalProject === undefined) delete Bun.env.GOOGLE_CLOUD_PROJECT;
				else Bun.env.GOOGLE_CLOUD_PROJECT = originalProject;
				if (originalLocation === undefined) delete Bun.env.GOOGLE_CLOUD_LOCATION;
				else Bun.env.GOOGLE_CLOUD_LOCATION = originalLocation;
				if (originalApiKey === undefined) delete Bun.env.GOOGLE_CLOUD_API_KEY;
				else Bun.env.GOOGLE_CLOUD_API_KEY = originalApiKey;
			}
		});

		it("keeps every system prompt array entry in Vertex systemInstruction", async () => {
			const llm = getBundledModel("google-vertex", "gemini-3-flash-preview");
			const controller = new AbortController();
			const { promise, resolve } = Promise.withResolvers<{
				config: { systemInstruction?: unknown };
				contents: unknown[];
			}>();
			const events = stream(
				llm,
				{
					systemPrompt: ["Primary instruction.", "Secondary instruction."],
					messages: [{ role: "user", content: "Hello", timestamp: Date.now() }],
				},
				{
					apiKey: "vertex-test-key",
					signal: controller.signal,
					onPayload: payload => {
						resolve(payload as { config: { systemInstruction?: unknown }; contents: unknown[] });
						controller.abort();
					},
				},
			);

			const drain = (async () => {
				for await (const _ of events) {
				}
			})();

			const payload = await promise;
			await drain;

			expect(payload.config.systemInstruction).toEqual({
				parts: [{ text: "Primary instruction." }, { text: "Secondary instruction." }],
			});
			expect(payload.contents).toEqual([{ role: "user", parts: [{ text: "Hello" }] }]);
		});

		it("allows explicit Vertex API keys without requiring project or location", async () => {
			const originalApiKey = Bun.env.GOOGLE_CLOUD_API_KEY;
			const originalProject = Bun.env.GOOGLE_CLOUD_PROJECT;
			const originalGcloudProject = Bun.env.GCLOUD_PROJECT;
			const originalLocation = Bun.env.GOOGLE_CLOUD_LOCATION;
			const llm = getBundledModel("google-vertex", "gemini-3-flash-preview");
			const controller = new AbortController();
			controller.abort();

			try {
				delete Bun.env.GOOGLE_CLOUD_API_KEY;
				delete Bun.env.GOOGLE_CLOUD_PROJECT;
				delete Bun.env.GCLOUD_PROJECT;
				delete Bun.env.GOOGLE_CLOUD_LOCATION;

				const response = await complete(
					llm,
					{ messages: [{ role: "user", content: "Hello", timestamp: Date.now() }] },
					{ apiKey: "vertex-test-key", signal: controller.signal },
				);

				expect(response.stopReason).toBe("aborted");
				expect(response.errorMessage).not.toContain("Vertex AI requires a project ID");
				expect(response.errorMessage).not.toContain("Vertex AI requires a location");
			} finally {
				if (originalApiKey === undefined) delete Bun.env.GOOGLE_CLOUD_API_KEY;
				else Bun.env.GOOGLE_CLOUD_API_KEY = originalApiKey;
				if (originalProject === undefined) delete Bun.env.GOOGLE_CLOUD_PROJECT;
				else Bun.env.GOOGLE_CLOUD_PROJECT = originalProject;
				if (originalGcloudProject === undefined) delete Bun.env.GCLOUD_PROJECT;
				else Bun.env.GCLOUD_PROJECT = originalGcloudProject;
				if (originalLocation === undefined) delete Bun.env.GOOGLE_CLOUD_LOCATION;
				else Bun.env.GOOGLE_CLOUD_LOCATION = originalLocation;
			}
		});

		it.each([
			{ location: "global", host: "aiplatform.googleapis.com" },
			{ location: "eu", host: "aiplatform.eu.rep.googleapis.com" },
			{ location: "us", host: "aiplatform.us.rep.googleapis.com" },
		] as const)("routes Vertex Claude rawPredict to $host for location $location", async ({ location, host }) => {
			const originalProject = Bun.env.GOOGLE_CLOUD_PROJECT;
			const originalGcpProject = Bun.env.GCP_PROJECT;
			const originalGcloudProject = Bun.env.GCLOUD_PROJECT;
			const originalVertexLocation = Bun.env.GOOGLE_VERTEX_LOCATION;
			const originalCloudLocation = Bun.env.GOOGLE_CLOUD_LOCATION;
			const originalLocation = Bun.env.VERTEX_LOCATION;
			const originalApiKey = Bun.env.GOOGLE_CLOUD_API_KEY;
			const originalGac = Bun.env.GOOGLE_APPLICATION_CREDENTIALS;
			// Force the GCE/Cloud Run metadata-server token path: neutralize any host
			// ADC so resolveAccessTokenUncached() falls through to fetchMetadataToken().
			// Without this the test reads ~/.config/gcloud/application_default_credentials.json
			// when present and hangs on the OAuth exchange (form body, not JSON).
			const homedirSpy = spyOn(os, "homedir").mockReturnValue(
				path.join(os.tmpdir(), `vertex-adc-absent-${location}-${Date.now()}`),
			);
			const model: Model<"anthropic-messages"> = buildModel({
				id: "claude-sonnet-4@20250514",
				name: "Claude Sonnet 4",
				api: "anthropic-messages",
				provider: "google-vertex",
				baseUrl:
					"https://{location}-aiplatform.googleapis.com/v1/projects/{project}/locations/{location}/publishers/anthropic/models/claude-sonnet-4@20250514:streamRawPredict",
				reasoning: true,
				input: ["text", "image"],
				cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
				contextWindow: 200_000,
				maxTokens: 64_000,
			});
			const captured = Promise.withResolvers<{
				url: string;
				authorization: string | null;
				betaHeader: string | null;
				body: unknown;
			}>();

			try {
				__resetVertexTokenCache();
				Bun.env.GOOGLE_CLOUD_PROJECT = "vertex-project";
				Bun.env.GOOGLE_VERTEX_LOCATION = location;
				delete Bun.env.GCP_PROJECT;
				delete Bun.env.GCLOUD_PROJECT;
				delete Bun.env.GOOGLE_CLOUD_LOCATION;
				delete Bun.env.VERTEX_LOCATION;
				delete Bun.env.GOOGLE_CLOUD_API_KEY;
				delete Bun.env.GOOGLE_APPLICATION_CREDENTIALS;

				const events = stream(
					model,
					{ messages: [{ role: "user", content: "Hello", timestamp: Date.now() }] },
					{
						apiKey: "<authenticated>",
						thinkingEnabled: true,
						fetch: async (input, init) => {
							const url = input instanceof Request ? input.url : input.toString();
							if (
								url ===
								"http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token"
							) {
								return new Response(JSON.stringify({ access_token: "vertex-token", expires_in: 3600 }));
							}
							const headers = input instanceof Request ? input.headers : new Headers(init?.headers);
							const bodyText = input instanceof Request ? await input.clone().text() : String(init?.body ?? "");
							captured.resolve({
								url,
								authorization: headers.get("authorization"),
								betaHeader: headers.get("anthropic-beta"),
								body: JSON.parse(bodyText),
							});
							return new Response(JSON.stringify({ error: { message: "stop after capture" } }), {
								status: 400,
							});
						},
					},
				);

				for await (const _event of events) {
				}

				const request = await captured.promise;
				// Placeholder baseUrl + GOOGLE_VERTEX_LOCATION must rewrite through
				// resolveVertexRequest: multi-region eu/us hit REP hosts, not the
				// invalid {location}-aiplatform.googleapis.com regional pattern.
				expect(request.url).toBe(
					`https://${host}/v1/projects/vertex-project/locations/${location}/publishers/anthropic/models/claude-sonnet-4@20250514:streamRawPredict`,
				);
				expect(request.authorization).toBe("Bearer vertex-token");
				expect(request.body).toMatchObject({
					anthropic_version: "vertex-2023-10-16",
					messages: [{ role: "user", content: [{ type: "text", text: "Hello" }] }],
					stream: true,
				});
				expect((request.body as Record<string, unknown>).model).toBeUndefined();
				expect((request.body as Record<string, { type?: string }>).thinking?.type).toBe("enabled");
				expect((request.body as Record<string, unknown>).context_management).toBeUndefined();
				expect(request.betaHeader ?? "").not.toContain("context-management-2025-06-27");
			} finally {
				__resetVertexTokenCache();
				homedirSpy.mockRestore();
				if (originalProject === undefined) delete Bun.env.GOOGLE_CLOUD_PROJECT;
				else Bun.env.GOOGLE_CLOUD_PROJECT = originalProject;
				if (originalGcpProject === undefined) delete Bun.env.GCP_PROJECT;
				else Bun.env.GCP_PROJECT = originalGcpProject;
				if (originalGcloudProject === undefined) delete Bun.env.GCLOUD_PROJECT;
				else Bun.env.GCLOUD_PROJECT = originalGcloudProject;
				if (originalVertexLocation === undefined) delete Bun.env.GOOGLE_VERTEX_LOCATION;
				else Bun.env.GOOGLE_VERTEX_LOCATION = originalVertexLocation;
				if (originalCloudLocation === undefined) delete Bun.env.GOOGLE_CLOUD_LOCATION;
				else Bun.env.GOOGLE_CLOUD_LOCATION = originalCloudLocation;
				if (originalLocation === undefined) delete Bun.env.VERTEX_LOCATION;
				else Bun.env.VERTEX_LOCATION = originalLocation;
				if (originalApiKey === undefined) delete Bun.env.GOOGLE_CLOUD_API_KEY;
				else Bun.env.GOOGLE_CLOUD_API_KEY = originalApiKey;
				if (originalGac === undefined) delete Bun.env.GOOGLE_APPLICATION_CREDENTIALS;
				else Bun.env.GOOGLE_APPLICATION_CREDENTIALS = originalGac;
			}
		});

		it("routes impersonated_service_account ADC through IAM to the Vertex request", async () => {
			const originalProject = Bun.env.GOOGLE_CLOUD_PROJECT;
			const originalGcpProject = Bun.env.GCP_PROJECT;
			const originalGcloudProject = Bun.env.GCLOUD_PROJECT;
			const originalVertexLocation = Bun.env.GOOGLE_VERTEX_LOCATION;
			const originalCloudLocation = Bun.env.GOOGLE_CLOUD_LOCATION;
			const originalLocation = Bun.env.VERTEX_LOCATION;
			const originalApiKey = Bun.env.GOOGLE_CLOUD_API_KEY;
			const originalGac = Bun.env.GOOGLE_APPLICATION_CREDENTIALS;
			const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-vertex-impersonation-"));
			const adcPath = path.join(tmpDir, "impersonated-adc.json");
			await Bun.write(
				adcPath,
				JSON.stringify({
					type: "impersonated_service_account",
					service_account_impersonation_url:
						"https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/target@project.iam.gserviceaccount.com:generateAccessToken",
					source_credentials: {
						type: "authorized_user",
						client_id: "client-id",
						client_secret: "client-secret",
						refresh_token: "refresh-token",
					},
					delegates: ["projects/-/serviceAccounts/delegate@project.iam.gserviceaccount.com"],
				}),
			);
			const model: Model<"anthropic-messages"> = buildModel({
				id: "claude-sonnet-4@20250514",
				name: "Claude Sonnet 4",
				api: "anthropic-messages",
				provider: "google-vertex",
				baseUrl:
					"https://{location}-aiplatform.googleapis.com/v1/projects/{project}/locations/{location}/publishers/anthropic/models/claude-sonnet-4@20250514:streamRawPredict",
				reasoning: true,
				input: ["text", "image"],
				cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
				contextWindow: 200_000,
				maxTokens: 64_000,
			});
			const callOrder: string[] = [];
			let iamRequest: { url: string; authorization: string | null; body: unknown } | undefined;
			const captured = Promise.withResolvers<{ url: string; authorization: string | null }>();

			try {
				__resetVertexTokenCache();
				Bun.env.GOOGLE_CLOUD_PROJECT = "vertex-project";
				Bun.env.GOOGLE_VERTEX_LOCATION = "global";
				delete Bun.env.GCP_PROJECT;
				delete Bun.env.GCLOUD_PROJECT;
				delete Bun.env.GOOGLE_CLOUD_LOCATION;
				delete Bun.env.VERTEX_LOCATION;
				delete Bun.env.GOOGLE_CLOUD_API_KEY;
				Bun.env.GOOGLE_APPLICATION_CREDENTIALS = adcPath;

				const events = stream(
					model,
					{ messages: [{ role: "user", content: "Hello", timestamp: Date.now() }] },
					{
						apiKey: "<authenticated>",
						fetch: async (input, init) => {
							const url = input instanceof Request ? input.url : input.toString();
							const headers = input instanceof Request ? input.headers : new Headers(init?.headers);
							if (url === "https://oauth2.googleapis.com/token") {
								callOrder.push("source");
								return new Response(JSON.stringify({ access_token: "source-token", expires_in: 3600 }));
							}
							if (url.startsWith("https://iamcredentials.googleapis.com/")) {
								callOrder.push("iam");
								const bodyText =
									input instanceof Request ? await input.clone().text() : String(init?.body ?? "");
								iamRequest = { url, authorization: headers.get("authorization"), body: JSON.parse(bodyText) };
								return new Response(
									JSON.stringify({
										accessToken: "impersonated-token",
										expireTime: new Date(Date.now() + 3_600_000).toISOString(),
									}),
								);
							}
							callOrder.push("vertex");
							captured.resolve({ url, authorization: headers.get("authorization") });
							return new Response(JSON.stringify({ error: { message: "stop after capture" } }), { status: 400 });
						},
					},
				);

				for await (const _event of events) {
				}

				const request = await captured.promise;

				// Source refresh, then IAM generateAccessToken, then the actual Vertex call.
				expect(callOrder).toEqual(["source", "iam", "vertex"]);

				// IAM exchange is authorized by the freshly minted source token, posts the
				// reconstructed canonical URL, and forwards the configured delegates verbatim.
				expect(iamRequest?.url).toBe(
					"https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/target@project.iam.gserviceaccount.com:generateAccessToken",
				);
				expect(iamRequest?.authorization).toBe("Bearer source-token");
				expect(iamRequest?.body).toEqual({
					delegates: ["projects/-/serviceAccounts/delegate@project.iam.gserviceaccount.com"],
					scope: ["https://www.googleapis.com/auth/cloud-platform"],
					lifetime: "3600s",
				});

				// The impersonated token (not the source token) authorizes the Vertex request.
				expect(request.url).toBe(
					"https://aiplatform.googleapis.com/v1/projects/vertex-project/locations/global/publishers/anthropic/models/claude-sonnet-4@20250514:streamRawPredict",
				);
				expect(request.authorization).toBe("Bearer impersonated-token");
			} finally {
				__resetVertexTokenCache();
				await removeWithRetries(tmpDir);
				if (originalProject === undefined) delete Bun.env.GOOGLE_CLOUD_PROJECT;
				else Bun.env.GOOGLE_CLOUD_PROJECT = originalProject;
				if (originalGcpProject === undefined) delete Bun.env.GCP_PROJECT;
				else Bun.env.GCP_PROJECT = originalGcpProject;
				if (originalGcloudProject === undefined) delete Bun.env.GCLOUD_PROJECT;
				else Bun.env.GCLOUD_PROJECT = originalGcloudProject;
				if (originalVertexLocation === undefined) delete Bun.env.GOOGLE_VERTEX_LOCATION;
				else Bun.env.GOOGLE_VERTEX_LOCATION = originalVertexLocation;
				if (originalCloudLocation === undefined) delete Bun.env.GOOGLE_CLOUD_LOCATION;
				else Bun.env.GOOGLE_CLOUD_LOCATION = originalCloudLocation;
				if (originalLocation === undefined) delete Bun.env.VERTEX_LOCATION;
				else Bun.env.VERTEX_LOCATION = originalLocation;
				if (originalApiKey === undefined) delete Bun.env.GOOGLE_CLOUD_API_KEY;
				else Bun.env.GOOGLE_CLOUD_API_KEY = originalApiKey;
				if (originalGac === undefined) delete Bun.env.GOOGLE_APPLICATION_CREDENTIALS;
				else Bun.env.GOOGLE_APPLICATION_CREDENTIALS = originalGac;
			}
		});
	});

	describe("Google Vertex Provider (gemini-3-flash-preview)", () => {
		const vertexApiKey = e2eApiKey("GOOGLE_CLOUD_API_KEY");
		const vertexProject = e2eApiKey("GOOGLE_CLOUD_PROJECT") || e2eApiKey("GCLOUD_PROJECT");
		const vertexLocation = e2eApiKey("GOOGLE_CLOUD_LOCATION");
		const isVertexConfigured = Boolean(vertexProject && vertexLocation);
		const vertexOptions = { project: vertexProject, location: vertexLocation } as const;
		const llm = getBundledModel("google-vertex", "gemini-3-flash-preview");

		it.skipIf(!vertexApiKey)(
			"should complete basic text generation with Vertex API key",
			async () => {
				await basicTextGeneration(llm, { apiKey: vertexApiKey! });
			},
			{ retry: 3 },
		);

		it.skipIf(!isVertexConfigured)(
			"should complete basic text generation",
			async () => {
				await basicTextGeneration(llm, vertexOptions);
			},
			{ retry: 3 },
		);

		it.skipIf(!isVertexConfigured)(
			"should handle tool calling",
			async () => {
				await handleToolCall(llm, vertexOptions);
			},
			{ retry: 3 },
		);

		it.skipIf(!isVertexConfigured)(
			"should handle thinking",
			async () => {
				await handleThinking(llm, {
					...vertexOptions,
					thinking: { enabled: true, budgetTokens: 1024, level: "LOW" },
				});
			},
			{ retry: 3 },
		);

		it.skipIf(!isVertexConfigured)(
			"should handle streaming",
			async () => {
				await handleStreaming(llm, vertexOptions);
			},
			{ retry: 3 },
		);

		it.skipIf(!isVertexConfigured)(
			"should handle multi-turn with thinking and tools",
			async () => {
				await multiTurn(llm, {
					...vertexOptions,
					thinking: { enabled: true, budgetTokens: 1024, level: "MEDIUM" },
				});
			},
			{ retry: 3 },
		);

		it.skipIf(!isVertexConfigured)(
			"should handle image input",
			async () => {
				await handleImage(llm, vertexOptions);
			},
			{ retry: 3 },
		);
	});

	describe.skipIf(!e2eApiKey("OPENAI_API_KEY"))("OpenAI Completions Provider (gpt-4o-mini)", () => {
		const llm: Model<"openai-completions"> = {
			...(getBundledModel("openai", "gpt-4o-mini") as Model<"openai-completions">),
			api: "openai-completions",
		};

		it(
			"should complete basic text generation",
			async () => {
				await basicTextGeneration(llm);
			},
			{ retry: 3 },
		);

		it(
			"should handle tool calling",
			async () => {
				await handleToolCall(llm);
			},
			{ retry: 3 },
		);

		it(
			"should handle streaming",
			async () => {
				await handleStreaming(llm);
			},
			{ retry: 3 },
		);

		it(
			"should handle image input",
			async () => {
				await handleImage(llm);
			},
			{ retry: 3 },
		);
	});

	describe.skipIf(!e2eApiKey("OPENAI_API_KEY"))("OpenAI Responses Provider (gpt-5-mini)", () => {
		const llm = getBundledModel("openai", "gpt-5-mini") as Model<"openai-responses">;

		it(
			"should complete basic text generation",
			async () => {
				await basicTextGeneration(llm);
			},
			{ retry: 3 },
		);

		it(
			"should handle tool calling",
			async () => {
				await handleToolCall(llm);
			},
			{ retry: 3 },
		);

		it(
			"should handle streaming",
			async () => {
				await handleStreaming(llm);
			},
			{ retry: 3 },
		);

		it(
			"should handle thinking",
			async () => {
				await handleThinking(llm, { reasoning: Effort.High });
			},
			{ retry: 2 },
		);

		it(
			"should handle multi-turn with thinking and tools",
			async () => {
				await multiTurn(llm, { reasoning: Effort.High });
			},
			{ retry: 3 },
		);

		it(
			"should handle image input",
			async () => {
				await handleImage(llm);
			},
			{ retry: 3 },
		);
	});

	describe.skipIf(!e2eApiKey("ANTHROPIC_API_KEY"))("Anthropic Provider (claude-haiku-4-5-20251001)", () => {
		const model = getBundledModel("anthropic", "claude-haiku-4-5-20251001");

		it(
			"should complete basic text generation",
			async () => {
				await basicTextGeneration(model, { thinkingEnabled: true });
			},
			{ retry: 3 },
		);

		it(
			"should handle tool calling",
			async () => {
				await handleToolCall(model);
			},
			{ retry: 3 },
		);

		it(
			"should handle streaming",
			async () => {
				await handleStreaming(model);
			},
			{ retry: 3 },
		);

		it(
			"should handle image input",
			async () => {
				await handleImage(model);
			},
			{ retry: 3 },
		);
	});

	describe.skipIf(!e2eApiKey("XAI_API_KEY"))("xAI Provider (grok-code-fast-1 via OpenAI Responses)", () => {
		const llm = getBundledModel("xai", "grok-code-fast-1");

		it(
			"should complete basic text generation",
			async () => {
				await basicTextGeneration(llm);
			},
			{ retry: 3 },
		);

		it(
			"should handle tool calling",
			async () => {
				await handleToolCall(llm);
			},
			{ retry: 3 },
		);

		it(
			"should handle streaming",
			async () => {
				await handleStreaming(llm);
			},
			{ retry: 3 },
		);

		it(
			"should handle thinking mode",
			async () => {
				await handleThinking(llm, { reasoning: Effort.Medium });
			},
			{ retry: 3 },
		);

		it(
			"should handle multi-turn with thinking and tools",
			async () => {
				await multiTurn(llm, { reasoning: Effort.Medium });
			},
			{ retry: 3 },
		);
	});

	describe.skipIf(!e2eApiKey("GROQ_API_KEY"))("Groq Provider (gpt-oss-20b via OpenAI Completions)", () => {
		const llm = getBundledModel("groq", "openai/gpt-oss-20b");

		it(
			"should complete basic text generation",
			async () => {
				await basicTextGeneration(llm);
			},
			{ retry: 3 },
		);

		it(
			"should handle tool calling",
			async () => {
				await handleToolCall(llm);
			},
			{ retry: 3 },
		);

		it(
			"should handle streaming",
			async () => {
				await handleStreaming(llm);
			},
			{ retry: 3 },
		);

		it(
			"should handle thinking mode",
			async () => {
				await handleThinking(llm, { reasoning: Effort.Medium });
			},
			{ retry: 3 },
		);

		it(
			"should handle multi-turn with thinking and tools",
			async () => {
				await multiTurn(llm, { reasoning: Effort.Medium });
			},
			{ retry: 3 },
		);
	});

	describe.skipIf(!e2eApiKey("CEREBRAS_API_KEY"))("Cerebras Provider (gpt-oss-120b via OpenAI Completions)", () => {
		const llm = getBundledModel("cerebras", "gpt-oss-120b");

		it(
			"should complete basic text generation",
			async () => {
				await basicTextGeneration(llm);
			},
			{ retry: 3 },
		);

		it(
			"should handle tool calling",
			async () => {
				await handleToolCall(llm);
			},
			{ retry: 3 },
		);

		it(
			"should handle streaming",
			async () => {
				await handleStreaming(llm);
			},
			{ retry: 3 },
		);

		it(
			"should handle thinking mode",
			async () => {
				await handleThinking(llm, { reasoning: Effort.Medium });
			},
			{ retry: 3 },
		);

		it(
			"should handle multi-turn with thinking and tools",
			async () => {
				await multiTurn(llm, { reasoning: Effort.Medium });
			},
			{ retry: 3 },
		);
	});

	describe.skipIf(!e2eApiKey("OPENROUTER_API_KEY"))("OpenRouter Provider (glm-4.5v via OpenAI Completions)", () => {
		const llm = getBundledModel("openrouter", "z-ai/glm-4.5v");

		it(
			"should complete basic text generation",
			async () => {
				await basicTextGeneration(llm);
			},
			{ retry: 3 },
		);

		it(
			"should handle tool calling",
			async () => {
				await handleToolCall(llm);
			},
			{ retry: 3 },
		);

		it(
			"should handle streaming",
			async () => {
				await handleStreaming(llm);
			},
			{ retry: 3 },
		);

		it(
			"should handle thinking mode",
			async () => {
				await handleThinking(llm, { reasoning: Effort.Medium });
			},
			{ retry: 3 },
		);

		it(
			"should handle multi-turn with thinking and tools",
			async () => {
				await multiTurn(llm, { reasoning: Effort.Medium });
			},
			{ retry: 2 },
		);

		it(
			"should handle image input",
			async () => {
				await handleImage(llm);
			},
			{ retry: 3 },
		);
	});

	describe.skipIf(!e2eApiKey("ZAI_API_KEY"))("zAI Provider (glm-4.5-air via OpenAI Completions)", () => {
		const llm = getBundledModel("zai", "glm-4.5-air");

		it(
			"should complete basic text generation",
			async () => {
				await basicTextGeneration(llm);
			},
			{ retry: 3 },
		);

		it(
			"should handle tool calling",
			async () => {
				await handleToolCall(llm);
			},
			{ retry: 3 },
		);

		it(
			"should handle streaming",
			async () => {
				await handleStreaming(llm);
			},
			{ retry: 3 },
		);

		it.skip(
			"should handle thinking mode",
			async () => {
				await handleThinking(llm, { reasoning: Effort.Medium });
			},
			{ retry: 3 },
		);

		it(
			"should handle multi-turn with thinking and tools",
			async () => {
				await multiTurn(llm, { reasoning: Effort.Medium });
			},
			{ retry: 3 },
		);
	});

	describe.skipIf(!e2eApiKey("ZAI_API_KEY"))("zAI Provider (glm-4.5v via OpenAI Completions)", () => {
		const llm = getBundledModel("zai", "glm-4.5v");

		it(
			"should complete basic text generation",
			async () => {
				await basicTextGeneration(llm);
			},
			{ retry: 3 },
		);

		it(
			"should handle tool calling",
			async () => {
				await handleToolCall(llm);
			},
			{ retry: 3 },
		);

		it(
			"should handle streaming",
			async () => {
				await handleStreaming(llm);
			},
			{ retry: 3 },
		);

		it(
			"should handle thinking mode",
			async () => {
				await handleThinking(llm, { reasoning: Effort.Medium });
			},
			{ retry: 3 },
		);

		it(
			"should handle multi-turn with thinking and tools",
			async () => {
				await multiTurn(llm, { reasoning: Effort.Medium });
			},
			{ retry: 3 },
		);

		it(
			"should handle image input",
			async () => {
				await handleImage(llm);
			},
			{ retry: 3 },
		);
	});

	describe.skipIf(!e2eApiKey("MISTRAL_API_KEY"))(
		"Mistral Provider (devstral-medium-latest via OpenAI Completions)",
		() => {
			const llm = getBundledModel("mistral", "devstral-medium-latest");

			it(
				"should complete basic text generation",
				async () => {
					await basicTextGeneration(llm);
				},
				{ retry: 3 },
			);

			it(
				"should handle tool calling",
				async () => {
					await handleToolCall(llm);
				},
				{ retry: 3 },
			);

			it(
				"should handle streaming",
				async () => {
					await handleStreaming(llm);
				},
				{ retry: 3 },
			);

			it(
				"should handle multi-turn with thinking and tools",
				async () => {
					await multiTurn(llm, { reasoning: Effort.Medium });
				},
				{ retry: 3 },
			);
		},
	);

	describe.skipIf(!e2eApiKey("MISTRAL_API_KEY"))("Mistral Provider (pixtral-12b with image support)", () => {
		const llm = getBundledModel("mistral", "pixtral-12b");

		it(
			"should complete basic text generation",
			async () => {
				await basicTextGeneration(llm);
			},
			{ retry: 3 },
		);

		it(
			"should handle tool calling",
			async () => {
				await handleToolCall(llm);
			},
			{ retry: 3 },
		);

		it(
			"should handle streaming",
			async () => {
				await handleStreaming(llm);
			},
			{ retry: 3 },
		);

		it(
			"should handle image input",
			async () => {
				await handleImage(llm);
			},
			{ retry: 3 },
		);
	});

	describe("Anthropic OAuth Provider (claude-sonnet-4-20250514)", () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-20250514");

		it.skipIf(!anthropicOAuthToken)(
			"should complete basic text generation",
			async () => {
				await basicTextGeneration(model, { apiKey: anthropicOAuthToken });
			},
			{ retry: 3 },
		);

		it.skipIf(!anthropicOAuthToken)(
			"should handle tool calling",
			async () => {
				await handleToolCall(model, { apiKey: anthropicOAuthToken });
			},
			{ retry: 3 },
		);

		it.skipIf(!anthropicOAuthToken)(
			"should handle streaming",
			async () => {
				await handleStreaming(model, { apiKey: anthropicOAuthToken });
			},
			{ retry: 3 },
		);

		it.skipIf(!anthropicOAuthToken)(
			"should handle thinking",
			async () => {
				await handleThinking(model, { apiKey: anthropicOAuthToken, thinkingEnabled: true });
			},
			{ retry: 3 },
		);

		it.skipIf(!anthropicOAuthToken)(
			"should handle multi-turn with thinking and tools",
			async () => {
				await multiTurn(model, { apiKey: anthropicOAuthToken, thinkingEnabled: true });
			},
			{ retry: 3 },
		);

		it.skipIf(!anthropicOAuthToken)(
			"should handle image input",
			async () => {
				await handleImage(model, { apiKey: anthropicOAuthToken });
			},
			{ retry: 3 },
		);
	});

	describe("GitHub Copilot Provider (gpt-4o via OpenAI Completions)", () => {
		const llm = getBundledModel("github-copilot", "gpt-4o");

		it.skipIf(!githubCopilotToken)(
			"should complete basic text generation",
			async () => {
				await basicTextGeneration(llm, { apiKey: githubCopilotToken });
			},
			{ retry: 3 },
		);

		it.skipIf(!githubCopilotToken)(
			"should handle tool calling",
			async () => {
				await handleToolCall(llm, { apiKey: githubCopilotToken });
			},
			{ retry: 3 },
		);

		it.skipIf(!githubCopilotToken)(
			"should handle streaming",
			async () => {
				await handleStreaming(llm, { apiKey: githubCopilotToken });
			},
			{ retry: 3 },
		);

		it.skipIf(!githubCopilotToken)(
			"should handle thinking",
			async () => {
				const thinkingModel = getBundledModel("github-copilot", "gpt-5-mini");
				await handleThinking(thinkingModel, { apiKey: githubCopilotToken, reasoning: Effort.High });
			},
			{ retry: 2 },
		);

		it.skipIf(!githubCopilotToken)(
			"should handle multi-turn with thinking and tools",
			async () => {
				const thinkingModel = getBundledModel("github-copilot", "gpt-5-mini");
				await multiTurn(thinkingModel, { apiKey: githubCopilotToken, reasoning: Effort.High });
			},
			{ retry: 3 },
		);

		it.skipIf(!githubCopilotToken)(
			"should handle image input",
			async () => {
				await handleImage(llm, { apiKey: githubCopilotToken });
			},
			{ retry: 3 },
		);
	});

	describe("Google Gemini CLI Provider (gemini-2.5-flash)", () => {
		const llm = getBundledModel("google-gemini-cli", "gemini-2.5-flash");

		it.skipIf(!geminiCliToken)(
			"should complete basic text generation",
			async () => {
				await basicTextGeneration(llm, { apiKey: geminiCliToken });
			},
			{ retry: 3 },
		);

		it.skipIf(!geminiCliToken)(
			"should handle tool calling",
			async () => {
				await handleToolCall(llm, { apiKey: geminiCliToken });
			},
			{ retry: 3 },
		);

		it.skipIf(!geminiCliToken)(
			"should handle streaming",
			async () => {
				await handleStreaming(llm, { apiKey: geminiCliToken });
			},
			{ retry: 3 },
		);

		it.skipIf(!geminiCliToken)(
			"should handle thinking",
			async () => {
				await handleThinking(llm, { apiKey: geminiCliToken, thinking: { enabled: true, budgetTokens: 1024 } });
			},
			{ retry: 3 },
		);

		it.skipIf(!geminiCliToken)(
			"should handle multi-turn with thinking and tools",
			async () => {
				await multiTurn(llm, { apiKey: geminiCliToken, thinking: { enabled: true, budgetTokens: 2048 } });
			},
			{ retry: 3 },
		);

		it.skipIf(!geminiCliToken)(
			"should handle image input",
			async () => {
				await handleImage(llm, { apiKey: geminiCliToken });
			},
			{ retry: 3 },
		);
	});

	describe("Google Gemini CLI Provider (gemini-3-flash-preview with thinkingLevel)", () => {
		const llm = getBundledModel("google-gemini-cli", "gemini-3-flash-preview");

		it.skipIf(!geminiCliToken)(
			"should handle thinking with thinkingLevel",
			async () => {
				await handleThinking(llm, { apiKey: geminiCliToken, thinking: { enabled: true, level: "LOW" } });
			},
			{ retry: 3 },
		);

		it.skipIf(!geminiCliToken)(
			"should handle multi-turn with thinking and tools",
			async () => {
				await multiTurn(llm, { apiKey: geminiCliToken, thinking: { enabled: true, level: "MEDIUM" } });
			},
			{ retry: 3 },
		);
	});

	describe("Google Antigravity Provider (gemini-3-pro-high)", () => {
		const llm = getBundledModel("google-antigravity", "gemini-3-pro-high");

		it.skipIf(!antigravityToken)(
			"should complete basic text generation",
			async () => {
				await basicTextGeneration(llm, { apiKey: antigravityToken });
			},
			{ retry: 3 },
		);

		it.skipIf(!antigravityToken)(
			"should handle tool calling",
			async () => {
				await handleToolCall(llm, { apiKey: antigravityToken });
			},
			{ retry: 3 },
		);

		it.skipIf(!antigravityToken)(
			"should handle streaming",
			async () => {
				await handleStreaming(llm, { apiKey: antigravityToken });
			},
			{ retry: 3 },
		);

		it.skipIf(!antigravityToken)(
			"should handle thinking with thinkingLevel",
			async () => {
				// gemini-3-pro only supports LOW/HIGH
				await handleThinking(llm, {
					apiKey: antigravityToken,
					thinking: { enabled: true, level: "LOW" },
				});
			},
			{ retry: 3 },
		);

		it.skipIf(!antigravityToken)(
			"should handle multi-turn with thinking and tools",
			async () => {
				await multiTurn(llm, { apiKey: antigravityToken, thinking: { enabled: true, level: "HIGH" } });
			},
			{ retry: 3 },
		);

		it.skipIf(!antigravityToken)(
			"should handle image input",
			async () => {
				await handleImage(llm, { apiKey: antigravityToken });
			},
			{ retry: 3 },
		);
	});

	describe("Google Antigravity Provider (claude-sonnet-4-5)", () => {
		const llm = getBundledModel("google-antigravity", "claude-sonnet-4-5");

		it.skipIf(!antigravityToken)(
			"should complete basic text generation",
			async () => {
				await basicTextGeneration(llm, { apiKey: antigravityToken });
			},
			{ retry: 3 },
		);

		it.skipIf(!antigravityToken)(
			"should handle tool calling",
			async () => {
				await handleToolCall(llm, { apiKey: antigravityToken });
			},
			{ retry: 3 },
		);

		it.skipIf(!antigravityToken)(
			"should handle streaming",
			async () => {
				await handleStreaming(llm, { apiKey: antigravityToken });
			},
			{ retry: 3 },
		);

		it.skipIf(!antigravityToken)(
			"should handle thinking",
			async () => {
				// claude-sonnet-4-5 has reasoning: false, use claude-sonnet-4-5-thinking
				const thinkingModel = getBundledModel("google-antigravity", "claude-sonnet-4-5-thinking");
				await handleThinking(thinkingModel, {
					apiKey: antigravityToken,
					thinking: { enabled: true, budgetTokens: 4096 },
				});
			},
			{ retry: 3 },
		);

		it.skipIf(!antigravityToken)(
			"should handle multi-turn with thinking and tools",
			async () => {
				const thinkingModel = getBundledModel("google-antigravity", "claude-sonnet-4-5-thinking");
				await multiTurn(thinkingModel, {
					apiKey: antigravityToken,
					thinking: { enabled: true, budgetTokens: 4096 },
				});
			},
			{ retry: 3 },
		);

		it.skipIf(!antigravityToken)(
			"should handle image input",
			async () => {
				await handleImage(llm, { apiKey: antigravityToken });
			},
			{ retry: 3 },
		);
	});

	describe("OpenAI Codex Provider (gpt-5.2-codex)", () => {
		const llm = getBundledModel("openai-codex", "gpt-5.2-codex");

		it.skipIf(!openaiCodexToken)(
			"should complete basic text generation",
			async () => {
				await basicTextGeneration(llm, { apiKey: openaiCodexToken });
			},
			{ retry: 3 },
		);

		it.skipIf(!openaiCodexToken)(
			"should handle tool calling",
			async () => {
				await handleToolCall(llm, { apiKey: openaiCodexToken });
			},
			{ retry: 3 },
		);

		it.skipIf(!openaiCodexToken)(
			"should handle streaming",
			async () => {
				await handleStreaming(llm, { apiKey: openaiCodexToken });
			},
			{ retry: 3 },
		);

		it.skipIf(!openaiCodexToken)(
			"should handle thinking",
			async () => {
				await handleThinking(llm, { apiKey: openaiCodexToken, reasoning: Effort.High });
			},
			{ retry: 3 },
		);

		it.skipIf(!openaiCodexToken)(
			"should handle multi-turn with thinking and tools",
			async () => {
				await multiTurn(llm, { apiKey: openaiCodexToken });
			},
			{ retry: 3 },
		);

		it.skipIf(!openaiCodexToken)(
			"should handle image input",
			async () => {
				await handleImage(llm, { apiKey: openaiCodexToken });
			},
			{ retry: 3 },
		);
	});

	describe.skipIf(!hasBedrockCredentials())("Amazon Bedrock Provider (claude-opus-4-6 interleaved thinking)", () => {
		const llm = getBundledModel("amazon-bedrock", "global.anthropic.claude-opus-4-6-v1");

		it(
			"should use adaptive thinking without anthropic_beta",
			async () => {
				let capturedPayload: unknown;
				const response = await complete(
					llm,
					{
						systemPrompt: ["You are a helpful assistant that uses tools when asked."],
						messages: [
							{
								role: "user",
								content: "Think first, then calculate 15 + 27 using the math_operation tool.",
								timestamp: Date.now(),
							},
						],
						tools: [calculatorTool],
					},
					{
						reasoning: Effort.Max,
						interleavedThinking: true,
						onPayload: payload => {
							capturedPayload = payload;
						},
					},
				);

				expect(response.stopReason, `Error: ${response.errorMessage}`).not.toBe("error");

				const payload = capturedPayload as {
					additionalModelRequestFields?: {
						thinking?: { type?: string };
						output_config?: { effort?: string };
						anthropic_beta?: string[];
					};
				};

				expect(payload.additionalModelRequestFields?.thinking).toEqual({ type: "adaptive" });
				expect(payload.additionalModelRequestFields?.output_config).toEqual({ effort: "max" });
				expect(payload.additionalModelRequestFields?.anthropic_beta).toBeUndefined();
			},
			{ retry: 3 },
		);
	});

	// Ollama tests require PI_LOCAL_LLM=1 and ollama installed
	const ollamaInstalled = !!Bun.env.PI_LOCAL_LLM && !!$which("ollama");

	describe.skipIf(!ollamaInstalled)("Ollama Provider (gpt-oss-20b via OpenAI Completions)", () => {
		let llm: Model<"openai-completions"> | undefined;
		let ollamaProcess: ChildProcess | null = null;

		beforeAll(async () => {
			if (!ollamaInstalled) return;
			// Check if model is available, if not pull it
			try {
				execSync("ollama list | grep -q 'gpt-oss:20b'", { stdio: "ignore" });
			} catch {
				console.log("Pulling gpt-oss:20b model for Ollama tests...");
				try {
					execSync("ollama pull gpt-oss:20b", { stdio: "inherit" });
				} catch {
					console.warn("Failed to pull gpt-oss:20b model, tests will be skipped");
					return;
				}
			}

			// Start ollama server
			ollamaProcess = spawn("ollama", ["serve"], {
				stdio: "ignore",
			});

			// Wait for server to be ready
			await new Promise<void>(resolve => {
				const checkServer = async () => {
					try {
						const response = await fetch("http://localhost:11434/api/tags");
						if (response.ok) {
							resolve();
						} else {
							setTimeout(checkServer, 500);
						}
					} catch {
						setTimeout(checkServer, 500);
					}
				};
				setTimeout(checkServer, 1000); // Initial delay
			});

			llm = buildModel({
				id: "gpt-oss:20b",
				api: "openai-completions",
				provider: "ollama",
				baseUrl: "http://localhost:11434/v1",
				reasoning: true,
				input: ["text"],
				contextWindow: 128000,
				maxTokens: 16000,
				cost: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
				},
				name: "Ollama GPT-OSS 20B",
			});
		}, 30000); // 30 second timeout for setup

		afterAll(() => {
			// Kill ollama server
			if (ollamaProcess) {
				ollamaProcess.kill("SIGTERM");
				ollamaProcess = null;
			}
		});

		it(
			"should complete basic text generation",
			async () => {
				if (!llm) return;
				await basicTextGeneration(llm, { apiKey: "test" });
			},
			{ retry: 3 },
		);

		it(
			"should handle tool calling",
			async () => {
				if (!llm) return;
				await handleToolCall(llm, { apiKey: "test" });
			},
			{ retry: 3 },
		);

		it(
			"should handle streaming",
			async () => {
				if (!llm) return;
				await handleStreaming(llm, { apiKey: "test" });
			},
			{ retry: 3 },
		);

		it(
			"should handle thinking mode",
			async () => {
				if (!llm) return;
				await handleThinking(llm, { apiKey: "test", reasoning: Effort.Medium });
			},
			{ retry: 3 },
		);

		it(
			"should handle multi-turn with thinking and tools",
			async () => {
				if (!llm) return;
				await multiTurn(llm, { apiKey: "test", reasoning: Effort.Medium });
			},
			{ retry: 3 },
		);
	});
});
