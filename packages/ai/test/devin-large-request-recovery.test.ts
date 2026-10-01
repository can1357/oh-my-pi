import { describe, expect, it } from "bun:test";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { streamDevin } from "@oh-my-pi/pi-ai/providers/devin";
import type { Context, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { GetChatMessageResponseSchema, GetUserJwtResponseSchema } from "@oh-my-pi/pi-catalog/discovery/devin-proto";
import { create, toBinary } from "@oh-my-pi/pi-catalog/discovery/protobuf";

const CONNECT_END_STREAM_FLAG = 0x02;
const LARGE_TOOL_RESULT_BYTES = 160 * 1024;

const devinModel: Model<"devin-agent"> = buildModel({
	id: "devin-test",
	name: "Devin Test",
	api: "devin-agent",
	provider: "devin",
	baseUrl: "https://server.codeium.com",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 1_000_000,
	maxTokens: 64_000,
});

const largeReadContext: Context = {
	messages: Array.from({ length: 4 }, (_, index) => ({
		role: "toolResult" as const,
		toolCallId: `read-${index}`,
		toolName: "read",
		content: [{ type: "text" as const, text: String(index).repeat(LARGE_TOOL_RESULT_BYTES) }],
		isError: false,
		timestamp: index + 1,
	})),
};
const largeFixedContext: Context = {
	systemPrompt: ["s".repeat(320 * 1024)],
	messages: [{ role: "user", content: "small history", timestamp: 1 }],
	tools: [
		{
			name: "large_tool",
			description: "d".repeat(320 * 1024),
			parameters: { type: "object", properties: {} },
		},
	],
};

function connectFrame(payload: Uint8Array, flag = 0): Uint8Array {
	const frame = Buffer.alloc(5 + payload.length);
	frame[0] = flag;
	frame.writeUInt32BE(payload.length, 1);
	frame.set(payload, 5);
	return frame;
}

function connectErrorFrame(code: string, message: string): Uint8Array {
	const payload = Buffer.from(JSON.stringify({ error: { code, message } }), "utf8");
	return connectFrame(payload, CONNECT_END_STREAM_FLAG);
}

async function runTrailerError(context: Context, code: string, message: string, leadingFrames: Uint8Array[] = []) {
	const authPayload = toBinary(GetUserJwtResponseSchema, create(GetUserJwtResponseSchema, { userJwt: "jwt" }));
	const trailer = connectErrorFrame(code, message);
	const fetchImpl = (async (input: string | URL | Request) => {
		if (String(input).includes("GetUserJwt")) return new Response(authPayload);
		return new Response(
			new ReadableStream<Uint8Array>({
				start(controller) {
					for (const frame of leadingFrames) controller.enqueue(frame);
					controller.enqueue(trailer);
					controller.close();
				},
			}),
			{ status: 200 },
		);
	}) as typeof fetch;

	return streamDevin(devinModel, context, { apiKey: "token", fetch: fetchImpl }).result();
}

describe("streamDevin large request recovery", () => {
	it("classifies an opaque invalid_argument on cumulative large read output as context overflow", async () => {
		const result = await runTrailerError(
			largeReadContext,
			"invalid_argument",
			"an internal error occurred (trace ID: large-request)",
		);

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("trace ID: large-request");
		expect(AIError.is(result.errorId, AIError.Flag.ContextOverflow)).toBe(true);
	});

	it("keeps the same opaque trailer transient for a small request", async () => {
		const result = await runTrailerError(
			{ messages: [{ role: "user", content: "hi", timestamp: 1 }] },
			"invalid_argument",
			"an internal error occurred (trace ID: small-request)",
		);

		expect(AIError.is(result.errorId, AIError.Flag.ContextOverflow)).toBe(false);
		expect(AIError.is(result.errorId, AIError.Flag.Transient)).toBe(true);
	});

	it("does not compact a large system prompt and tool schema with small history", async () => {
		const result = await runTrailerError(
			largeFixedContext,
			"invalid_argument",
			"an internal error occurred (trace ID: fixed-request)",
		);

		expect(AIError.is(result.errorId, AIError.Flag.ContextOverflow)).toBe(false);
		expect(AIError.is(result.errorId, AIError.Flag.Transient)).toBe(true);
	});

	it("does not compact a large history after partial output", async () => {
		const partial = toBinary(
			GetChatMessageResponseSchema,
			create(GetChatMessageResponseSchema, { deltaText: "partial" }),
		);
		const result = await runTrailerError(
			largeReadContext,
			"invalid_argument",
			"an internal error occurred (trace ID: partial-output)",
			[connectFrame(partial)],
		);

		expect(result.content).toContainEqual({ type: "text", text: "partial" });
		expect(AIError.is(result.errorId, AIError.Flag.ContextOverflow)).toBe(false);
		expect(AIError.is(result.errorId, AIError.Flag.Transient)).toBe(true);
	});

	it("does not reinterpret a specific invalid argument on a large request", async () => {
		const result = await runTrailerError(largeReadContext, "invalid_argument", "unknown chat model uid");

		expect(AIError.is(result.errorId, AIError.Flag.ContextOverflow)).toBe(false);
	});

	it("keeps the trailer transient for a huge active turn user message with no prior history", async () => {
		const result = await runTrailerError(
			{
				messages: [
					{
						role: "user" as const,
						content: "u".repeat(520 * 1024),
						timestamp: 1,
					},
				],
			},
			"invalid_argument",
			"an internal error occurred (trace ID: huge-user-request)",
		);

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("trace ID: huge-user-request");
		expect(AIError.is(result.errorId, AIError.Flag.ContextOverflow)).toBe(false);
		expect(AIError.is(result.errorId, AIError.Flag.Transient)).toBe(true);
	});

	it("classifies as context overflow if there is huge eligible prior history before the active turn user message", async () => {
		const result = await runTrailerError(
			{
				messages: [
					{
						role: "toolResult" as const,
						toolCallId: "read-prior",
						toolName: "read",
						content: [{ type: "text" as const, text: "p".repeat(520 * 1024) }],
						isError: false,
						timestamp: 1,
					},
					{
						role: "user" as const,
						content: "small user prompt",
						timestamp: 2,
					},
				],
			},
			"invalid_argument",
			"an internal error occurred (trace ID: prior-history-overflow)",
		);

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("trace ID: prior-history-overflow");
		expect(AIError.is(result.errorId, AIError.Flag.ContextOverflow)).toBe(true);
	});

	it("classifies as context overflow if the request follows a large tool execution", async () => {
		const result = await runTrailerError(
			{
				messages: [
					{
						role: "user" as const,
						content: "small user prompt",
						timestamp: 1,
					},
					{
						role: "assistant" as const,
						content: [
							{ type: "text" as const, text: "running a tool" },
							{
								type: "toolCall" as const,
								id: "call-1",
								name: "large_tool",
								arguments: {},
							},
						],
						api: "devin-agent" as const,
						provider: "devin" as const,
						model: "devin-test",
						usage: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 0,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
						stopReason: "toolUse" as const,
						timestamp: 2,
					},
					{
						role: "toolResult" as const,
						toolCallId: "call-1",
						toolName: "large_tool",
						content: [{ type: "text" as const, text: "t".repeat(520 * 1024) }],
						isError: false,
						timestamp: 3,
					},
				],
			},
			"invalid_argument",
			"an internal error occurred (trace ID: tool-execution-overflow)",
		);

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("trace ID: tool-execution-overflow");
		expect(AIError.is(result.errorId, AIError.Flag.ContextOverflow)).toBe(true);
	});
	it("keeps prior user-role execution history eligible before the active prompt", async () => {
		const result = await runTrailerError(
			{
				messages: [
					{
						role: "user" as const,
						content: "execution output: ".concat("x".repeat(520 * 1024)),
						timestamp: 1,
					},
					{
						role: "user" as const,
						content: "small active prompt",
						timestamp: 2,
					},
				],
			},
			"invalid_argument",
			"an internal error occurred (trace ID: user-role-history)",
		);

		expect(result.stopReason).toBe("error");
		expect(AIError.is(result.errorId, AIError.Flag.ContextOverflow)).toBe(true);
	});

	it("keeps the trailer transient for a large current prompt split across multiple trailing user/developer messages", async () => {
		const result = await runTrailerError(
			{
				messages: [
					{
						role: "user" as const,
						content: "u".repeat(520 * 1024),
						timestamp: 1,
					},
					{
						role: "developer" as const,
						content: "small notice/companion",
						timestamp: 2,
					},
				],
			},
			"invalid_argument",
			"an internal error occurred (trace ID: split-active-prompt)",
		);

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("trace ID: split-active-prompt");
		expect(AIError.is(result.errorId, AIError.Flag.ContextOverflow)).toBe(false);
		expect(AIError.is(result.errorId, AIError.Flag.Transient)).toBe(true);
	});
});
