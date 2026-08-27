// Contract: an ImageContent carrying `url` ships the URL to providers whose
// APIs fetch remote images — and its base64 payload stays off the wire.
// Undecorated blocks keep the inline base64 forms byte-for-byte.
import { describe, expect, it } from "bun:test";
import { convertAnthropicMessages } from "@oh-my-pi/pi-ai/providers/anthropic";
import { convertMessages as convertGoogleMessages } from "@oh-my-pi/pi-ai/providers/google-shared";
import { streamOpenAICompletions } from "@oh-my-pi/pi-ai/providers/openai-completions";
import { convertResponsesInputContent } from "@oh-my-pi/pi-ai/providers/openai-shared";
import type {
	Context,
	FetchImpl,
	Message,
	Model,
	ModelSpec,
	ProviderFileReference,
	UserMessage,
} from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";

const PNG_B64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";
const BLOB_URL = "https://blobs.example.com/0123456789abcdef0123456789abcdef.png";

const userMessage: Message = {
	role: "user",
	content: [
		{ type: "text", text: "what is in these?" },
		{ type: "image", data: PNG_B64, mimeType: "image/png", url: BLOB_URL },
		{ type: "image", data: PNG_B64, mimeType: "IMAGE/PNG; charset=binary" },
	],
	timestamp: 0,
};

function withProviderFile(providerFile: ProviderFileReference): UserMessage {
	return {
		role: "user",
		content: [
			{ type: "text", text: "what is in this?" },
			{ type: "image", data: PNG_B64, mimeType: "image/png", url: BLOB_URL, providerFile },
		],
		timestamp: 0,
	};
}

describe("image url parts", () => {
	it("anthropic prefers its provider file over the url and base64 payload", () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5") as Model<"anthropic-messages">;
		const params = convertAnthropicMessages(
			[withProviderFile({ provider: "anthropic", id: "file_anthropic_123" })],
			model,
			false,
		);

		const content = params[0].content as Array<{ type: string; source?: Record<string, unknown> }>;
		expect(content.find(block => block.type === "image")?.source).toEqual({
			type: "file",
			file_id: "file_anthropic_123",
		});
	});

	it("anthropic custom endpoints fall back from provider files to inline data", () => {
		const model = buildModel({
			id: "custom-claude",
			name: "Custom Claude",
			api: "anthropic-messages",
			provider: "anthropic",
			baseUrl: "https://gateway.example.invalid/anthropic",
			reasoning: false,
			input: ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 32_768,
			maxTokens: 4_096,
		} satisfies ModelSpec<"anthropic-messages">);
		const params = convertAnthropicMessages(
			[
				{
					role: "user",
					content: [
						{
							type: "image",
							data: PNG_B64,
							mimeType: "image/png",
							providerFile: { provider: "anthropic", id: "file_anthropic_123" },
						},
					],
					timestamp: 0,
				},
			],
			model,
			false,
		);

		const content = params[0].content as Array<{ type: string; source?: Record<string, unknown> }>;
		expect(content.find(block => block.type === "image")?.source).toEqual({
			type: "base64",
			media_type: "image/png",
			data: PNG_B64,
		});
	});

	it("openai responses prefer its provider file over the url and base64 payload", () => {
		const message = withProviderFile({ provider: "openai", id: "file_openai_123" });
		if (!Array.isArray(message.content)) {
			throw new Error("expected array content");
		}
		const converted = convertResponsesInputContent(message.content, true, true);

		expect(converted?.find(part => part.type === "input_image")).toEqual({
			type: "input_image",
			detail: "auto",
			file_id: "file_openai_123",
		});
	});

	it("rejects an unsupported provider file when no replayable image source remains", () => {
		const model = buildModel({
			id: "vision-model",
			name: "Vision Model",
			api: "openai-responses",
			provider: "xai",
			baseUrl: "https://api.x.ai/v1",
			reasoning: false,
			input: ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 32_768,
			maxTokens: 4_096,
		} satisfies ModelSpec<"openai-responses">);

		expect(() =>
			convertResponsesInputContent(
				[
					{
						type: "image",
						data: "",
						mimeType: "image/png",
						providerFile: { provider: "openai", id: "file_openai_123" },
					},
				],
				true,
				true,
				false,
				model,
			),
		).toThrow("without non-empty image data or a supported reference");
	});

	it("google prefers its provider file over the url and base64 payload", () => {
		const model = getBundledModel("google", "gemini-2.5-flash") as Model<"google-generative-ai">;
		const contents = convertGoogleMessages(model, {
			messages: [
				withProviderFile({ provider: "google", uri: "https://generativelanguage.googleapis.com/v1/files/abc" }),
			],
		});

		expect(contents[0].parts?.find(part => part.fileData !== undefined)).toEqual({
			fileData: {
				fileUri: "https://generativelanguage.googleapis.com/v1/files/abc",
				mimeType: "image/png",
			},
		});
	});

	it("google custom endpoints fall back from provider files to inline data", () => {
		const model = buildModel({
			id: "custom-gemini",
			name: "Custom Gemini",
			api: "google-generative-ai",
			provider: "google",
			baseUrl: "https://gateway.example.invalid/v1beta",
			reasoning: false,
			input: ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 32_768,
			maxTokens: 4_096,
		} satisfies ModelSpec<"google-generative-ai">);
		const contents = convertGoogleMessages(model, {
			messages: [
				{
					role: "user",
					content: [
						{
							type: "image",
							data: PNG_B64,
							mimeType: "image/png",
							providerFile: {
								provider: "google",
								uri: "https://generativelanguage.googleapis.com/v1/files/abc",
							},
						},
					],
					timestamp: 0,
				},
			],
		});

		expect(contents[0]?.parts).toContainEqual({ inlineData: { mimeType: "image/png", data: PNG_B64 } });
		expect(contents.flatMap(content => content.parts ?? []).some(part => part.fileData !== undefined)).toBe(false);
	});

	it("ignores a provider file for a different provider and falls back to the url", () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5") as Model<"anthropic-messages">;
		const params = convertAnthropicMessages(
			[withProviderFile({ provider: "openai", id: "file_openai_123" })],
			model,
			false,
		);

		const content = params[0].content as Array<{ type: string; source?: Record<string, unknown> }>;
		expect(content.find(block => block.type === "image")?.source).toEqual({ type: "url", url: BLOB_URL });
	});

	it("anthropic sends a url source for decorated blocks and base64 for the rest", () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5") as Model<"anthropic-messages">;
		const params = convertAnthropicMessages([userMessage], model, false);

		expect(params).toHaveLength(1);
		const content = params[0].content as Array<{ type: string; source?: Record<string, unknown> }>;
		const images = content.filter(block => block.type === "image");
		expect(images[0].source).toEqual({ type: "url", url: BLOB_URL });
		expect(images[1].source).toMatchObject({ type: "base64", media_type: "image/png", data: PNG_B64 });
		// The decorated block's bytes must not ride along anywhere in the message.
		expect(JSON.stringify(images[0])).not.toContain(PNG_B64);
	});

	it("anthropic falls back to inline data for unsupported URL and expired file references", () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5") as Model<"anthropic-messages">;
		const expired = convertAnthropicMessages(
			[
				{
					role: "user",
					content: [
						{
							type: "image",
							data: PNG_B64,
							mimeType: "image/png",
							providerFile: { provider: "anthropic", id: "file_expired", expiresAt: Date.now() - 1 },
						},
					],
					timestamp: 0,
				},
			],
			model,
			false,
		);
		const nonOfficial = buildModel({
			id: "custom-claude",
			name: "Custom Claude",
			api: "anthropic-messages",
			provider: "custom",
			baseUrl: "https://proxy.example/v1",
			reasoning: false,
			input: ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 32_768,
			maxTokens: 4_096,
		} satisfies ModelSpec<"anthropic-messages">);
		const unsupportedUrl = convertAnthropicMessages([userMessage], nonOfficial, false);

		expect(
			(expired[0]?.content as Array<{ type: string; source?: Record<string, unknown> }> | undefined)?.find(
				block => block.type === "image",
			)?.source,
		).toEqual({ type: "base64", media_type: "image/png", data: PNG_B64 });
		expect(
			(unsupportedUrl[0]?.content as Array<{ type: string; source?: Record<string, unknown> }> | undefined)?.find(
				block => block.type === "image",
			)?.source,
		).toEqual({ type: "base64", media_type: "image/png", data: PNG_B64 });
	});

	it("anthropic rejects an unsupported reference without usable inline data", () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5") as Model<"anthropic-messages">;

		expect(() =>
			convertAnthropicMessages(
				[
					{
						role: "user",
						content: [
							{
								type: "image",
								data: "",
								mimeType: "image/png",
								providerFile: {
									provider: "anthropic",
									id: "file_expired",
									expiresAt: Date.now() - 1,
								},
							},
						],
						timestamp: 0,
					},
				],
				model,
				false,
			),
		).toThrow("input_image cannot be forwarded to anthropic-messages without non-empty image data");
	});

	it("responses input uses the url as image_url and a data URI otherwise", () => {
		const converted = convertResponsesInputContent(
			userMessage.content as Exclude<typeof userMessage.content, string>,
			true,
			true,
		);

		const images = (converted ?? []).flatMap(part => (part.type === "input_image" ? [part] : []));
		expect(images[0].image_url).toBe(BLOB_URL);
		expect(images[1].image_url).toBe(`data:image/png;base64,${PNG_B64}`);
	});

	it("responses falls back to inline data when the image URL is malformed", () => {
		const model = getBundledModel("openai", "gpt-5-mini") as Model<"openai-responses">;
		const converted = convertResponsesInputContent(
			[{ type: "image", data: PNG_B64, mimeType: "image/png", url: "not-a-url" }],
			true,
			model.compat.supportsImageDetailOriginal,
			false,
			model,
		);

		expect(converted).toEqual([
			{ type: "input_image", detail: "auto", image_url: `data:image/png;base64,${PNG_B64}` },
		]);
	});

	it("google keeps inline data when remote URLs are unsupported", () => {
		const model = getBundledModel("google", "gemini-2.5-flash") as Model<"google-generative-ai">;
		const toolCallMessage: Message = {
			role: "assistant",
			content: [{ type: "toolCall", id: "call_1", name: "screenshot", arguments: {} }],
			api: "google-generative-ai",
			provider: "google",
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "toolUse",
			timestamp: 0,
		};
		const toolResultMessage: Message = {
			role: "toolResult",
			toolCallId: "call_1",
			toolName: "screenshot",
			content: [{ type: "image", data: PNG_B64, mimeType: "image/png", url: BLOB_URL }],
			isError: false,
			timestamp: 0,
		};

		const contents = convertGoogleMessages(model, { messages: [userMessage, toolCallMessage, toolResultMessage] });

		const userParts = contents[0].parts ?? [];
		expect(userParts).toContainEqual({ inlineData: { mimeType: "image/png", data: PNG_B64 } });

		const trailingParts = contents.flatMap(content => content.parts ?? []);
		const fileDataParts = trailingParts.filter(part => part.fileData !== undefined);
		expect(fileDataParts).toHaveLength(0);
		expect(trailingParts.filter(part => part.inlineData !== undefined)).toHaveLength(3);
	});

	it("google rejects a reference-only image when its URL is not replayable", () => {
		const model = getBundledModel("google", "gemini-2.5-flash") as Model<"google-generative-ai">;
		expect(() =>
			convertGoogleMessages(model, {
				messages: [
					{
						role: "user",
						content: [{ type: "image", data: "", mimeType: "image/png", url: BLOB_URL }],
						timestamp: 0,
					},
				],
			}),
		).toThrow("without non-empty image data or a supported reference");
	});

	it("google falls back to valid inline data and rejects invalid image media", () => {
		const model = getBundledModel("google", "gemini-2.5-flash") as Model<"google-generative-ai">;
		const expired = convertGoogleMessages(model, {
			messages: [
				{
					role: "user",
					content: [
						{
							type: "image",
							data: PNG_B64,
							mimeType: "image/png",
							providerFile: {
								provider: "google",
								uri: "https://generativelanguage.googleapis.com/v1/files/expired",
								expiresAt: 0,
							},
						},
					],
					timestamp: 0,
				},
			],
		});
		expect(expired[0]?.parts).toContainEqual({ inlineData: { mimeType: "image/png", data: PNG_B64 } });
		expect(() =>
			convertGoogleMessages(model, {
				messages: [
					{
						role: "user",
						content: [
							{
								type: "image",
								data: Buffer.from("not an image").toString("base64"),
								mimeType: "application/octet-stream",
							},
						],
						timestamp: 0,
					},
				],
			}),
		).toThrow("without non-empty image data or a supported reference");
	});

	it("completions sends the url in image_url content parts", async () => {
		const model = {
			...(getBundledModel("openai", "gpt-4o-mini") as Model<"openai-completions">),
			api: "openai-completions",
		} satisfies Model<"openai-completions">;
		let captured: { messages?: Array<{ content: unknown }> } | undefined;
		const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
			captured = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
			const sse =
				`data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 0, model: model.id, choices: [{ index: 0, delta: { role: "assistant", content: "ok" } }] })}\n\n` +
				`data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 0, model: model.id, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n` +
				"data: [DONE]\n\n";
			return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
		}) as FetchImpl;

		const context: Context = { messages: [userMessage] };
		await streamOpenAICompletions(model, context, { apiKey: "test", fetch: fetchImpl }).result();

		const parts = captured?.messages?.[0]?.content as Array<{ type: string; image_url?: { url: string } }>;
		const images = parts.filter(part => part.type === "image_url");
		expect(images[0].image_url?.url).toBe(BLOB_URL);
		expect(images[1].image_url?.url).toBe(`data:image/png;base64,${PNG_B64}`);
	});

	it("completions falls back to inline data when a native URL is unsupported", async () => {
		const model = buildModel({
			id: "kimi-k2.5",
			name: "Kimi K2.5",
			api: "openai-completions",
			provider: "moonshot",
			baseUrl: "https://api.moonshot.ai/v1",
			reasoning: false,
			input: ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 32_768,
			maxTokens: 4_096,
		} satisfies ModelSpec<"openai-completions">);
		let captured: { messages?: Array<{ content: unknown }> } | undefined;
		const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
			captured = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
			const sse =
				`data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 0, model: model.id, choices: [{ index: 0, delta: { role: "assistant", content: "ok" } }] })}\n\n` +
				`data: ${JSON.stringify({ id: "c", object: "chat.completion.chunk", created: 0, model: model.id, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n` +
				"data: [DONE]\n\n";
			return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
		}) as FetchImpl;

		await streamOpenAICompletions(model, { messages: [userMessage] }, { apiKey: "test", fetch: fetchImpl }).result();

		const parts = captured?.messages?.[0]?.content as Array<{ type: string; image_url?: { url: string } }>;
		const images = parts.filter(part => part.type === "image_url");
		expect(images[0].image_url?.url).toBe(`data:image/png;base64,${PNG_B64}`);
	});

	it("rejects Base64 text mislabeled as an image across direct serializers", async () => {
		const invalidImage = {
			type: "image" as const,
			data: Buffer.from("not an image").toString("base64"),
			mimeType: "image/png",
		};
		const anthropicModel = getBundledModel("anthropic", "claude-sonnet-4-5") as Model<"anthropic-messages">;
		const completionsModel = {
			...(getBundledModel("openai", "gpt-4o-mini") as Model<"openai-completions">),
			api: "openai-completions",
		} satisfies Model<"openai-completions">;
		let providerCalls = 0;
		const fetchImpl = (async () => {
			providerCalls++;
			return new Response(null, { status: 500 });
		}) as FetchImpl;

		expect(() => convertResponsesInputContent([invalidImage], true, true)).toThrow(
			"without non-empty image data or a supported reference",
		);
		expect(() =>
			convertAnthropicMessages(
				[{ role: "user", content: [invalidImage], timestamp: 0 }],
				anthropicModel,
				false,
			),
		).toThrow("without non-empty image data or a supported reference");
		const completionsResult = await streamOpenAICompletions(
			completionsModel,
			{ messages: [{ role: "user", content: [invalidImage], timestamp: 0 }] },
			{ apiKey: "test", fetch: fetchImpl },
		).result();
		expect(completionsResult.stopReason).toBe("error");
		expect(completionsResult.errorMessage).toContain("without non-empty image data or a supported reference");
		expect(providerCalls).toBe(0);
	});
});
