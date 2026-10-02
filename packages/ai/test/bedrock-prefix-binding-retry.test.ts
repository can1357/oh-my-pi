import { describe, expect, it, vi } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { streamBedrock } from "@oh-my-pi/pi-ai/providers/amazon-bedrock";
import type { AssistantMessage, Context, Model, Tool } from "@oh-my-pi/pi-ai/types";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { bedrockHappyPathFrames, bedrockTestModel, withSkippedBedrockAuth } from "./helpers/bedrock-stream";

const PREFIX_BINDING_ERROR =
	'messages.1.content.0: Invalid `signature` in `thinking` block. The block is bound to a different conversation. Remove the block, or set `thinking.block_binding.prefix_mismatch_behavior` to "drop_block". That setting requires the "thinking-binding-controls-2026-08-01" value in the "anthropic-beta" header. The "system" prompt differs from the one this block was created with.';

interface CapturedRequest {
	messages: Array<{ role: string; content: unknown[] }>;
	additionalModelRequestFields?: { thinking?: { block_binding?: unknown } };
}

const target: Model<"bedrock-converse-stream"> = bedrockTestModel({
	id: "global.anthropic.claude-opus-5-5",
	name: "Claude Opus 5.5",
	reasoning: true,
	thinking: { mode: "anthropic-adaptive", efforts: [Effort.Medium], prefixBinding: false },
});

const boundTarget: Model<"bedrock-converse-stream"> = bedrockTestModel({
	id: "global.anthropic.claude-opus-5-5",
	name: "Claude Opus 5.5",
	reasoning: true,
	thinking: { mode: "anthropic-adaptive", efforts: [Effort.Medium], prefixBinding: true },
});

const tools: Tool[] = [{ name: "read", description: "Read a file", parameters: type({ path: "string" }) }];

const context: Context = {
	messages: [
		{ role: "user", content: "Read notes.txt.", timestamp: 0 },
		{
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "Read the note before answering.", thinkingSignature: "signed-thinking" },
				{ type: "text", text: "I will read the note." },
				{ type: "toolCall", id: "call_read", name: "read", arguments: { path: "notes.txt" } },
			],
			api: "bedrock-converse-stream",
			provider: "amazon-bedrock",
			model: target.id,
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
		},
		{
			role: "toolResult",
			toolCallId: "call_read",
			toolName: "read",
			content: [{ type: "text", text: "The note says to keep the history." }],
			isError: false,
			timestamp: 2,
		},
		{ role: "user", content: "Summarize it.", timestamp: 3 },
	],
	tools,
};

function readRequest(init?: RequestInit): CapturedRequest {
	const body = init?.body;
	const json = body instanceof Uint8Array ? new TextDecoder().decode(body) : String(body ?? "");
	return JSON.parse(json) as CapturedRequest;
}

function eventStreamResponse(): Response {
	const frames = bedrockHappyPathFrames();
	let index = 0;
	return new Response(
		new ReadableStream<Uint8Array>({
			pull(controller) {
				if (index < frames.length) controller.enqueue(frames[index++]!);
				else controller.close();
			},
		}),
		{ status: 200, headers: { "content-type": "application/vnd.amazon.eventstream" } },
	);
}

function mockedFetch(reply: (requestIndex: number) => Response) {
	const requests: CapturedRequest[] = [];
	const fetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
		const requestIndex = requests.length;
		requests.push(readRequest(init));
		return reply(requestIndex);
	}) as unknown as typeof globalThis.fetch;
	return { fetch, requests };
}

describe("Bedrock signed-thinking prefix mismatch recovery", () => {
	it("retries without replayed reasoning while preserving tool history", async () => {
		const { fetch, requests } = mockedFetch(requestIndex =>
			requestIndex === 0 ? new Response(PREFIX_BINDING_ERROR, { status: 400 }) : eventStreamResponse(),
		);
		let result: AssistantMessage | undefined;

		await withSkippedBedrockAuth(async () => {
			result = await streamBedrock(target, context, {
				fetch,
				maxTokens: 64,
				reasoning: Effort.Medium,
			}).result();
		});

		expect(requests).toHaveLength(2);
		const firstAssistant = requests[0]?.messages.find(message => message.role === "assistant");
		const secondRequest = requests[1];
		const secondAssistant = secondRequest?.messages.find(message => message.role === "assistant");
		expect(requests[0]?.additionalModelRequestFields?.thinking).toBeDefined();
		expect(requests[0]?.additionalModelRequestFields?.thinking?.block_binding).toBeUndefined();
		expect(
			firstAssistant?.content.some(
				block => typeof block === "object" && block !== null && "reasoningContent" in block,
			),
		).toBe(true);
		expect(
			secondRequest?.messages.some(message =>
				message.content.some(block => typeof block === "object" && block !== null && "reasoningContent" in block),
			),
		).toBe(false);
		expect(secondAssistant?.content).toContainEqual({ text: "I will read the note." });
		expect(secondAssistant?.content).toContainEqual({
			toolUse: { toolUseId: "call_read", name: "read", input: { path: "notes.txt" } },
		});
		const toolResultBlock = secondRequest?.messages
			.flatMap(message => message.content)
			.find(block => typeof block === "object" && block !== null && "toolResult" in block);
		expect(toolResultBlock).toEqual({
			toolResult: {
				toolUseId: "call_read",
				content: [{ text: "The note says to keep the history." }],
				status: "success",
			},
		});
		expect(secondRequest?.additionalModelRequestFields?.thinking).toBeDefined();
		expect(result?.stopReason).toBe("stop");
	});

	it("does not retry a different Bedrock validation error", async () => {
		const { fetch, requests } = mockedFetch(
			() => new Response("ValidationException: invalid request setting", { status: 400 }),
		);
		let result: AssistantMessage | undefined;

		await withSkippedBedrockAuth(async () => {
			result = await streamBedrock(target, context, {
				fetch,
				maxTokens: 64,
				reasoning: Effort.Medium,
			}).result();
		});

		expect(requests).toHaveLength(1);
		expect(result?.stopReason).toBe("error");
		expect(result?.errorMessage).toContain("ValidationException: invalid request setting");
	});

	it("surfaces a repeated prefix-binding error after one retry", async () => {
		const { fetch, requests } = mockedFetch(() => new Response(PREFIX_BINDING_ERROR, { status: 400 }));
		let result: AssistantMessage | undefined;

		await withSkippedBedrockAuth(async () => {
			result = await streamBedrock(target, context, {
				fetch,
				maxTokens: 64,
				reasoning: Effort.Medium,
			}).result();
		});

		expect(requests).toHaveLength(2);
		expect(result?.stopReason).toBe("error");
		expect(result?.errorMessage).toContain("bound to a different conversation");
	});

	it("keeps the prefix-binding 400 when the caller asked mismatches to fail", async () => {
		const { fetch, requests } = mockedFetch(() => new Response(PREFIX_BINDING_ERROR, { status: 400 }));
		let result: AssistantMessage | undefined;

		await withSkippedBedrockAuth(async () => {
			result = await streamBedrock(boundTarget, context, {
				fetch,
				maxTokens: 64,
				reasoning: Effort.Medium,
				anthropicPrefixMismatchBehavior: "error",
			}).result();
		});

		expect(requests).toHaveLength(1);
		expect(requests[0]?.additionalModelRequestFields?.thinking?.block_binding).toEqual({
			prefix_mismatch_behavior: "error",
		});
		expect(result?.stopReason).toBe("error");
		expect(result?.errorMessage).toContain("bound to a different conversation");
	});
});
