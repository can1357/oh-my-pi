import { describe, expect, test } from "bun:test";
import { streamOpenAICompletions } from "@oh-my-pi/pi-ai/providers/openai-completions";
import { streamOpenAIResponses } from "@oh-my-pi/pi-ai/providers/openai-responses";
import type { Context, FetchImpl, Model, ModelSpec } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { USER_AGENT } from "@oh-my-pi/pi-utils";
import { resolveOpenAIRequestSetup } from "../src/providers/openai-shared";

const context: Context = {
	messages: [{ role: "user", content: "ping", timestamp: 0 }],
};

function createResponsesSse(): Response {
	return new Response(
		`data: ${JSON.stringify({
			type: "response.output_item.added",
			output_index: 0,
			item: { type: "message", id: "msg_1", role: "assistant", content: [] },
		})}\n\n` +
			`data: ${JSON.stringify({ type: "response.content_part.added", part: { type: "output_text", text: "" } })}\n\n` +
			`data: ${JSON.stringify({ type: "response.output_text.delta", delta: "ok" })}\n\n` +
			`data: ${JSON.stringify({
				type: "response.output_item.done",
				output_index: 0,
				item: { type: "message", id: "msg_1", role: "assistant", content: [{ type: "output_text", text: "ok" }] },
			})}\n\n` +
			`data: ${JSON.stringify({
				type: "response.completed",
				response: {
					status: "completed",
					usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
				},
			})}\n\n`,
		{ status: 200, headers: { "content-type": "text/event-stream" } },
	);
}

function createChatSse(): Response {
	return new Response(
		`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: "ok" }, finish_reason: null }] })}\n\n` +
			`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n` +
			`data: [DONE]\n\n`,
		{ status: 200, headers: { "content-type": "text/event-stream" } },
	);
}

function xaiResponsesModel(provider: "xai" | "xai-oauth" = "xai"): Model<"openai-responses"> {
	return buildModel({
		id: "grok-4.6",
		name: "Grok 4.6",
		api: "openai-responses",
		provider,
		baseUrl: "https://api.x.ai/v1",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 500_000,
		maxTokens: 8192,
	} as ModelSpec<"openai-responses">);
}

function openaiCompletionsModel(): Model<"openai-completions"> {
	return buildModel({
		id: "gpt-4o-mini",
		name: "GPT-4o Mini",
		api: "openai-completions",
		provider: "openai",
		baseUrl: "https://api.openai.com/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128_000,
		maxTokens: 4096,
	} as ModelSpec<"openai-completions">);
}

async function captureStreamHeaders(
	run: (fetch: FetchImpl) => AsyncIterable<{ type: string }>,
	sse: Response,
): Promise<{ url: string; userAgent: string | null }> {
	let url = "";
	let userAgent: string | null = null;
	const fetchMock: FetchImpl = async (input, init) => {
		url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
		userAgent = new Headers(init?.headers).get("user-agent");
		return sse;
	};
	for await (const event of run(fetchMock)) {
		if (event.type === "done" || event.type === "error") break;
	}
	return { url, userAgent };
}

describe("resolveOpenAIRequestSetup User-Agent", () => {
	test("sets omp User-Agent on xAI when none is provided", () => {
		for (const provider of ["xai", "xai-oauth"] as const) {
			const setup = resolveOpenAIRequestSetup(
				{ provider, id: "grok-4.6", baseUrl: "https://api.x.ai/v1" },
				{ apiKey: "sk-test", messages: [] },
			);
			expect(setup.headers["User-Agent"]).toBe(USER_AGENT);
			expect(setup.requestHeaders["User-Agent"]).toBe(USER_AGENT);
		}
	});

	test("does not set User-Agent on other OpenAI-wire providers", () => {
		for (const provider of ["openai", "deepseek"] as const) {
			const setup = resolveOpenAIRequestSetup(
				{ provider, id: "m", baseUrl: "https://api.example/v1" },
				{ apiKey: "sk-test", messages: [] },
			);
			expect(setup.headers["User-Agent"]).toBeUndefined();
			expect(setup.requestHeaders["User-Agent"]).toBeUndefined();
		}
	});

	test("does not override a caller-supplied xAI User-Agent", () => {
		const setup = resolveOpenAIRequestSetup(
			{
				provider: "xai",
				id: "grok-4.6",
				baseUrl: "https://api.x.ai/v1",
				headers: { "User-Agent": "custom-xai-client/1.0" },
			},
			{ apiKey: "sk-test", messages: [] },
		);
		expect(setup.headers["User-Agent"]).toBe("custom-xai-client/1.0");
	});

	test("does not override a lowercase xAI user-agent header", () => {
		const setup = resolveOpenAIRequestSetup(
			{
				provider: "xai",
				id: "grok-4.6",
				baseUrl: "https://api.x.ai/v1",
				headers: { "user-agent": "custom-xai-client/1.0" },
			},
			{ apiKey: "sk-test", messages: [] },
		);
		expect(setup.headers["user-agent"]).toBe("custom-xai-client/1.0");
		expect(setup.headers["User-Agent"]).toBeUndefined();
	});
});

describe("xAI stream User-Agent", () => {
	test("xAI Responses POST sends omp User-Agent", async () => {
		const captured = await captureStreamHeaders(
			fetch => streamOpenAIResponses(xaiResponsesModel(), context, { apiKey: "sk-test", fetch }),
			createResponsesSse(),
		);
		expect(captured.url).toBe("https://api.x.ai/v1/responses");
		expect(captured.userAgent).toBe(USER_AGENT);
		expect(captured.userAgent).toMatch(/^omp\/\d+\.\d+\.\d+$/);
	});

	test("xAI OAuth Responses POST sends omp User-Agent", async () => {
		const captured = await captureStreamHeaders(
			fetch => streamOpenAIResponses(xaiResponsesModel("xai-oauth"), context, { apiKey: "sk-test", fetch }),
			createResponsesSse(),
		);
		expect(captured.url).toBe("https://api.x.ai/v1/responses");
		expect(captured.userAgent).toBe(USER_AGENT);
	});

	test("OpenAI Completions POST does not send omp User-Agent", async () => {
		const captured = await captureStreamHeaders(
			fetch => streamOpenAICompletions(openaiCompletionsModel(), context, { apiKey: "sk-test", fetch }),
			createChatSse(),
		);
		expect(captured.url).toBe("https://api.openai.com/v1/chat/completions");
		expect(captured.userAgent).toBeNull();
	});
});
