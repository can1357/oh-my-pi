/** `compat.requiresStringMessageContent`: text-only content arrays become one string. */
import { describe, expect, test } from "bun:test";
import { stream } from "@oh-my-pi/pi-ai/stream";
import type { AssistantMessage, Context, FetchImpl, Model, ModelSpec, Usage } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

const MODEL = buildModel({
	id: "compat-string-content",
	name: "Compat String Content",
	api: "openai-completions",
	provider: "test-provider",
	baseUrl: "https://example.com/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128_000,
	maxTokens: 4096,
	compat: { requiresStringMessageContent: true },
} satisfies ModelSpec<"openai-completions">);

const VISION_MODEL = buildModel({
	id: "compat-string-content-vision",
	name: "Compat String Content (vision)",
	api: "openai-completions",
	provider: "test-provider",
	baseUrl: "https://example.com/v1",
	reasoning: false,
	input: ["text", "image"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128_000,
	maxTokens: 4096,
	compat: { requiresStringMessageContent: true },
} satisfies ModelSpec<"openai-completions">);

/** Control: flag unset. */
const CONTROL_MODEL = buildModel({
	id: "compat-string-content-control",
	name: "Compat String Content (control)",
	api: "openai-completions",
	provider: "test-provider",
	baseUrl: "https://example.com/v1",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128_000,
	maxTokens: 4096,
} satisfies ModelSpec<"openai-completions">);

const EMPTY_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

interface CapturedRequest {
	body?: string;
}

interface BodyMessage {
	role: string;
	content: unknown;
	tool_calls?: Array<{ function: { name: string } }>;
}

function captureRequest(captured: CapturedRequest): FetchImpl {
	return Object.assign(
		async (_input: string | URL | Request, init?: RequestInit) => {
			captured.body = typeof init?.body === "string" ? init.body : undefined;
			return Response.json({ error: { message: "captured" } }, { status: 400 });
		},
		{ preconnect: fetch.preconnect },
	);
}

async function capturedBody(model: Model, context: Context): Promise<{ messages: BodyMessage[] }> {
	const captured: CapturedRequest = {};
	await stream(model, context, { apiKey: "test-key", fetch: captureRequest(captured) }).result();
	return JSON.parse(captured.body ?? "{}");
}

describe("openai-completions requiresStringMessageContent", () => {
	test("resolves false by default and true when set on the model", () => {
		expect(CONTROL_MODEL.compat.requiresStringMessageContent).toBe(false);
		expect(MODEL.compat.requiresStringMessageContent).toBe(true);
	});

	test("a system prompt and a multi-block user turn both ride as plain strings", async () => {
		const body = await capturedBody(MODEL, {
			systemPrompt: ["You are a test assistant."],
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: "Environment: /repo" },
						{ type: "text", text: "What is the weather in Paris?" },
					],
					timestamp: 0,
				},
			],
		});

		expect(body.messages.map(message => message.role)).toEqual(["system", "user"]);
		for (const message of body.messages) expect(typeof message.content).toBe("string");
		expect(body.messages[0]?.content).toBe("You are a test assistant.");
		expect(body.messages[1]?.content).toBe("Environment: /repo\nWhat is the weather in Paris?");
	});

	test("a tool-call round trip stays string-shaped end to end", async () => {
		const assistant: AssistantMessage = {
			role: "assistant",
			content: [{ type: "toolCall", id: "call_abc123", name: "get_weather", arguments: { city: "Paris" } }],
			api: "openai-completions",
			provider: "test-provider",
			model: MODEL.id,
			usage: EMPTY_USAGE,
			stopReason: "toolUse",
			timestamp: 1,
		};
		const body = await capturedBody(MODEL, {
			systemPrompt: ["You are a test assistant."],
			messages: [
				{ role: "user", content: [{ type: "text", text: "Weather in Paris?" }], timestamp: 0 },
				assistant,
				{
					role: "toolResult",
					toolCallId: "call_abc123",
					toolName: "get_weather",
					content: [
						{ type: "text", text: "18C" },
						{ type: "text", text: "sunny" },
					],
					isError: false,
					timestamp: 2,
				},
				{ role: "user", content: [{ type: "text", text: "Thanks." }], timestamp: 3 },
			],
		});

		expect(body.messages.map(message => message.role)).toEqual(["system", "user", "assistant", "tool", "user"]);
		for (const message of body.messages) expect(typeof message.content).toBe("string");
		// Tool-call-only assistant turns already carry `""`.
		expect(body.messages[2]?.content).toBe("");
		expect(body.messages[2]?.tool_calls?.[0]?.function.name).toBe("get_weather");
		expect(body.messages[3]?.content).toBe("18C\nsunny");
	});

	test("an image part keeps its array beside a string system prompt", async () => {
		const body = await capturedBody(VISION_MODEL, {
			systemPrompt: ["You are a test assistant."],
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: "What colour is this?" },
						{ type: "image", data: "ZmFrZQ==", mimeType: "image/png" },
					],
					timestamp: 0,
				},
			],
		});

		expect(body.messages[0]?.content).toBe("You are a test assistant.");
		expect(body.messages[1]?.content).toEqual([
			{ type: "text", text: "What colour is this?" },
			{ type: "image_url", image_url: { url: "data:image/png;base64,ZmFrZQ==" } },
		]);
	});

	test("the same model without the flag still sends a parts array", async () => {
		expect(CONTROL_MODEL.compat.requiresStringMessageContent).toBe(false);
		const body = await capturedBody(CONTROL_MODEL, {
			systemPrompt: ["You are a test assistant."],
			messages: [
				{
					role: "user",
					content: [
						{ type: "text", text: "Environment: /repo" },
						{ type: "text", text: "What is the weather in Paris?" },
					],
					timestamp: 0,
				},
			],
		});

		expect(body.messages[1]?.content).toEqual([
			{ type: "text", text: "Environment: /repo" },
			{ type: "text", text: "What is the weather in Paris?" },
		]);
	});
});
