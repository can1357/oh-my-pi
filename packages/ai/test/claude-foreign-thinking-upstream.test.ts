import { describe, expect, it } from "bun:test";
import { type AnthropicOptions, streamAnthropic } from "@oh-my-pi/pi-ai/providers/anthropic";
import { streamFactoryDroid } from "@oh-my-pi/pi-ai/providers/factory-droid";
import { streamGitLabDuo } from "@oh-my-pi/pi-ai/providers/gitlab-duo";
import type { AssistantMessage, Context, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { getGitLabDuoModels } from "@oh-my-pi/pi-catalog/provider-models";
import {
	type CapturedRequest,
	anthropicChunks,
	captureFetch,
	factoryModel,
	WORKOS_TOKEN,
} from "./helpers/factory-droid";

const FOREIGN_THINKING = "FOREIGN_THINKING: inspect config before editing the parser.";
const FOREIGN_ANSWER = "I will inspect config first.";
const OWN_THINKING = "OWN_THINKING: the parser handles this token.";

const SSE = new TextEncoder().encode(
	[
		{
			type: "message_start",
			message: {
				id: "msg_stub",
				type: "message",
				role: "assistant",
				model: "claude-opus-4-8",
				content: [],
				usage: { input_tokens: 1, output_tokens: 0 },
			},
		},
		{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
		{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
		{ type: "content_block_stop", index: 0 },
		{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
		{ type: "message_stop" },
	]
		.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
		.join(""),
);

function claude(baseUrl: string): Model<"anthropic-messages"> {
	return buildModel({
		id: "claude-opus-4-8",
		name: "Claude Opus 4.8",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl,
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 8_192,
	});
}

function assistant(
	content: AssistantMessage["content"],
	api: AssistantMessage["api"],
	provider: string,
	model: string,
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api,
		provider,
		model,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: 1,
	};
}

async function send(messages: Context["messages"], options: AnthropicOptions = {}): Promise<string> {
	let requestBody: unknown;
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: async request => {
			requestBody = await request.json();
			return new Response(SSE, { headers: { "content-type": "text/event-stream" } });
		},
	});
	try {
		await streamAnthropic(claude(server.url.toString()), { messages }, { apiKey: "sk-test", ...options }).result();
		if (requestBody === undefined) throw new Error("the Anthropic stub received no request");
		return JSON.stringify(requestBody);
	} finally {
		server.stop(true);
	}
}

interface SentRequest {
	thinking?: unknown;
	messages: Array<{ role: string; content: Array<{ type: string }> }>;
}

function foreignHistory(): Context["messages"] {
	return [
		{ role: "user", content: "Fix the parser.", timestamp: 0 },
		assistant(
			[
				{ type: "thinking", thinking: FOREIGN_THINKING, thinkingSignature: "reasoning_content" },
				{ type: "text", text: FOREIGN_ANSWER },
				{ type: "toolCall", id: "call_1", name: "read", arguments: { path: "config.ts" } },
			],
			"openai-completions",
			"vertex",
			"google/gemini-3.1-pro-preview",
		),
		{
			role: "toolResult",
			toolCallId: "call_1",
			toolName: "read",
			content: [{ type: "text", text: "export const config = {};" }],
			isError: false,
			timestamp: 2,
		},
		{ role: "user", content: "Continue.", timestamp: 3 },
	];
}

function expectForeignThinkingDropped(payload: unknown): void {
	const body = JSON.stringify(payload);
	expect(body).not.toContain(FOREIGN_THINKING);
	expect(body).toContain(FOREIGN_ANSWER);
	expect(body).toContain('"type":"tool_use"');
}

describe("Claude history on the Anthropic wire", () => {
	it("sends another model's answer and tool call without its thinking", async () => {
		const body = await send([
			{ role: "user", content: "Fix the parser.", timestamp: 0 },
			assistant(
				[
					{ type: "thinking", thinking: FOREIGN_THINKING, thinkingSignature: "reasoning_content" },
					{ type: "text", text: FOREIGN_ANSWER },
					{ type: "toolCall", id: "call_1", name: "read", arguments: { path: "config.ts" } },
				],
				"openai-completions",
				"vertex",
				"google/gemini-3.1-pro-preview",
			),
			{
				role: "toolResult",
				toolCallId: "call_1",
				toolName: "read",
				content: [{ type: "text", text: "export const config = {};" }],
				isError: false,
				timestamp: 2,
			},
			{ role: "user", content: "Continue.", timestamp: 3 },
		]);

		expect(body).not.toContain(FOREIGN_THINKING);
		expect(body).toContain(FOREIGN_ANSWER);
		expect(body).toContain('"type":"tool_use"');
	});

	it("keeps Claude's own signed thinking", async () => {
		const body = await send([
			{ role: "user", content: "Fix the parser.", timestamp: 0 },
			assistant(
				[
					{ type: "thinking", thinking: OWN_THINKING, thinkingSignature: "sig_own" },
					{ type: "toolCall", id: "toolu_own", name: "read", arguments: { path: "config.ts" } },
				],
				"anthropic-messages",
				"anthropic",
				"claude-opus-4-8",
			),
			{
				role: "toolResult",
				toolCallId: "toolu_own",
				toolName: "read",
				content: [{ type: "text", text: "export const config = {};" }],
				isError: false,
				timestamp: 2,
			},
		]);

		expect(body).toContain(OWN_THINKING);
		expect(body).toContain("sig_own");
	});

	it("sends a mid-tool-loop switch from another Claude model as it sends any other model's loop", async () => {
		const loopCall = { type: "toolCall", id: "toolu_loop", name: "read", arguments: { path: "config.ts" } } as const;
		const sonnet = assistant(
			[{ type: "thinking", thinking: FOREIGN_THINKING, thinkingSignature: "sig_sonnet" }, loopCall],
			"anthropic-messages",
			"anthropic",
			"claude-sonnet-4-6",
		);
		const gemini = assistant(
			[{ type: "thinking", thinking: FOREIGN_THINKING, thinkingSignature: "reasoning_content" }, loopCall],
			"openai-completions",
			"vertex",
			"google/gemini-3.1-pro-preview",
		);
		const requests: SentRequest[] = [];
		for (const source of [sonnet, gemini]) {
			const body = await send(
				[
					{ role: "user", content: "Fix the parser.", timestamp: 0 },
					source,
					{
						role: "toolResult",
						toolCallId: "toolu_loop",
						toolName: "read",
						content: [{ type: "text", text: "export const config = {};" }],
						isError: false,
						timestamp: 2,
					},
				],
				{ thinkingEnabled: true },
			);
			expect(body).not.toContain(FOREIGN_THINKING);
			const request = JSON.parse(body) as SentRequest;
			const [loopTurn, loopResult] = request.messages.slice(-2);
			expect(loopTurn?.role).toBe("assistant");
			expect(loopTurn?.content.map(block => block.type)).toEqual(["tool_use"]);
			expect(loopResult?.content.map(block => block.type)).toContain("tool_result");
			requests.push(request);
		}
		const [fromSonnet, fromGemini] = requests;
		expect(JSON.stringify(fromSonnet)).not.toContain("sig_sonnet");
		expect(fromSonnet?.thinking).toBeDefined();
		expect(fromSonnet?.thinking).toEqual(fromGemini?.thinking);
	});
});

describe("Claude history through provider wrappers", () => {
	it("removes foreign thinking through Factory Droid's Anthropic route", async () => {
		const captured: CapturedRequest[] = [];
		await streamFactoryDroid(
			factoryModel("claude-sonnet-4-5-20250929"),
			{ messages: foreignHistory() },
			{ apiKey: WORKOS_TOKEN, fetch: captureFetch(captured, anthropicChunks("OK")) },
		).result();

		expect(captured).toHaveLength(1);
		expectForeignThinkingDropped(captured[0]?.body);
	});

	it("removes foreign thinking through GitLab Duo's Anthropic route", async () => {
		const model = getGitLabDuoModels().find(candidate => candidate.id === "duo-chat-sonnet-4-5");
		if (!model) throw new Error("GitLab Duo Claude model is missing");
		let payload: unknown;
		await streamGitLabDuo(
			model,
			{ messages: foreignHistory() },
			{
				apiKey: "sk-test",
				fetch: async input => {
					if (String(input).includes("/direct_access")) {
						return new Response(JSON.stringify({ token: "direct-access-token", headers: {} }), {
							status: 200,
							headers: { "content-type": "application/json" },
						});
					}
					throw new Error("the payload hook should stop the proxy request before fetch");
				},
				onPayload: body => {
					payload = body;
					throw new Error("stop after payload capture");
				},
			},
		).result();

		if (payload === undefined) throw new Error("GitLab Duo did not create an Anthropic request");
		expectForeignThinkingDropped(payload);
	});
});
