/**
 * Anthropic message threads: after the first turn creates a thread, later
 * turns send only the messages after the previous response. Any turn whose
 * stored prefix no longer matches, or that the API cannot continue, falls back
 * to the full conversation.
 */
import { describe, expect, it } from "bun:test";
import { streamAnthropic } from "@oh-my-pi/pi-ai/providers/anthropic";
import type { MessageCreateParams } from "@oh-my-pi/pi-ai/providers/anthropic-wire";
import type {
	AssistantMessage,
	Context,
	FetchImpl,
	Message,
	Model,
	ProviderSessionState,
	ToolResultMessage,
} from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { withOfficialAnthropicEndpoint } from "./helpers";

const THREADS_BETA = "message-threads-2026-08-12";

const MODEL: Model<"anthropic-messages"> = buildModel({
	id: "claude-sonnet-4-6",
	name: "Claude Sonnet 4.6",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 8_192,
});

const TOOLS: Context["tools"] = [
	{
		name: "read",
		description: "Read a file",
		parameters: { type: "object", properties: { path: { type: "string" } }, additionalProperties: false },
	},
];

const ASK: Message = { role: "user", content: "Read a.txt", timestamp: 1 };

type Reply =
	| { kind: "tool"; id: string }
	| { kind: "text"; id: string; stopReason?: string }
	| { kind: "error"; status: number; code: string };

interface Capture {
	bodies: MessageCreateParams[];
	betas: string[];
}

function sse(events: Array<Record<string, unknown>>): Response {
	const body = `${events.map(event => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}`).join("\n\n")}\n\n`;
	return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

function reply(spec: Reply): Response {
	if (spec.kind === "error") {
		return new Response(
			JSON.stringify({
				type: "error",
				error: {
					type: spec.status === 404 ? "not_found_error" : "invalid_request_error",
					message: `thread rejected: ${spec.code}`,
					details: { error_code: spec.code },
				},
			}),
			{ status: spec.status, headers: { "Content-Type": "application/json" } },
		);
	}
	const usage = { input_tokens: 10, output_tokens: 1 };
	const block =
		spec.kind === "tool"
			? [
					{
						type: "content_block_start",
						index: 0,
						content_block: { type: "tool_use", id: `toolu_${spec.id}`, name: "read", input: {} },
					},
					{
						type: "content_block_delta",
						index: 0,
						delta: { type: "input_json_delta", partial_json: '{"path":"a.txt"}' },
					},
				]
			: [
					{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
					{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "done" } },
				];
	const stopReason = spec.kind === "tool" ? "tool_use" : (spec.stopReason ?? "end_turn");
	return sse([
		{ type: "message_start", message: { id: spec.id, usage } },
		...block,
		{ type: "content_block_stop", index: 0 },
		{ type: "message_delta", delta: { stop_reason: stopReason }, usage },
		{ type: "message_stop" },
	]);
}

/** Answers one turn's requests with `replies` in order, recording every body and beta header. */
function scriptedFetch(capture: Capture, replies: Reply[]): FetchImpl {
	const pending = [...replies];
	return async (input, init) => {
		const raw = init?.body;
		const text = raw instanceof Uint8Array ? new TextDecoder().decode(raw) : String(raw ?? "{}");
		capture.bodies.push(JSON.parse(text) as MessageCreateParams);
		const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
		capture.betas.push(headers.get("anthropic-beta") ?? "");
		const next = pending.shift();
		if (!next) throw new Error(`unexpected request #${capture.bodies.length}`);
		return reply(next);
	};
}

function toolResult(call: AssistantMessage): ToolResultMessage {
	const toolCall = call.content.find(block => block.type === "toolCall");
	if (toolCall?.type !== "toolCall") throw new Error("expected a tool call");
	return {
		role: "toolResult",
		toolCallId: toolCall.id,
		toolName: toolCall.name,
		content: [{ type: "text", text: "file contents" }],
		isError: false,
		timestamp: 2,
	};
}

function session(model: Model<"anthropic-messages"> = MODEL) {
	const capture: Capture = { bodies: [], betas: [] };
	const states = new Map<string, ProviderSessionState>();
	const turn = (messages: Message[], replies: Reply[], statefulResponses?: boolean) =>
		streamAnthropic(
			model,
			{ systemPrompt: ["You are a precise assistant."], messages, tools: TOOLS },
			{
				apiKey: "sk-ant-api-test",
				sessionId: "thread-session",
				providerSessionState: states,
				statefulResponses,
				fetch: scriptedFetch(capture, replies),
			},
		).result();
	return { capture, turn };
}

describe("Anthropic message threads", () => {
	withOfficialAnthropicEndpoint();

	it("creates a thread, then continues it with only the messages after each response", async () => {
		const { capture, turn } = session();
		const first = await turn([ASK], [{ kind: "tool", id: "msg_1" }]);
		const second = await turn([ASK, first, toolResult(first)], [{ kind: "text", id: "msg_2" }]);
		const followUp: Message = { role: "user", content: "Thanks", timestamp: 3 };
		await turn([ASK, first, toolResult(first), second, followUp], [{ kind: "text", id: "msg_3" }]);

		const [create, toolTurn, userTurn] = capture.bodies;
		expect(create?.thread).toEqual({ type: "create" });
		expect(create?.system).toBeDefined();
		expect(create?.tools).toHaveLength(1);
		expect(create?.messages).toHaveLength(1);

		expect(toolTurn?.thread).toEqual({ type: "continue", previous_message_id: "msg_1" });
		expect(toolTurn?.system).toBeUndefined();
		expect(toolTurn?.tools).toBeUndefined();
		expect(toolTurn?.messages).toHaveLength(1);
		expect(toolTurn?.messages[0]?.content).toEqual([
			expect.objectContaining({ type: "tool_result", tool_use_id: "toolu_msg_1" }),
		]);

		expect(userTurn?.thread).toEqual({ type: "continue", previous_message_id: "msg_2" });
		expect(userTurn?.messages).toEqual([
			{ role: "user", content: [expect.objectContaining({ type: "text", text: "Thanks" })] },
		]);
		for (const beta of capture.betas) expect(beta.split(",")).toContain(THREADS_BETA);
	});

	it("creates a new thread when earlier history no longer matches the stored turn", async () => {
		const { capture, turn } = session();
		const first = await turn([ASK], [{ kind: "tool", id: "msg_1" }]);
		const edited: Message = { role: "user", content: "Read b.txt", timestamp: 1 };
		await turn([edited, first, toolResult(first)], [{ kind: "text", id: "msg_2" }]);

		expect(capture.bodies[1]?.thread).toEqual({ type: "create" });
		expect(capture.bodies[1]?.messages).toHaveLength(3);
		expect(capture.bodies[1]?.system).toBeDefined();
	});

	it("does not continue a response the API does not store", async () => {
		const { capture, turn } = session();
		const cut = await turn([ASK], [{ kind: "text", id: "msg_1", stopReason: "max_tokens" }]);
		await turn([ASK, cut, { role: "user", content: "Continue", timestamp: 2 }], [{ kind: "text", id: "msg_2" }]);

		expect(capture.bodies[1]?.thread).toEqual({ type: "create" });
		expect(capture.bodies[1]?.messages).toHaveLength(3);
	});

	it.each([
		{ status: 404, code: "thread_not_found" },
		{ status: 400, code: "thread_already_continued" },
		{ status: 400, code: "thread_fingerprint_mismatch" },
	])("replays the full conversation after a continue fails with $code", async ({ status, code }) => {
		const { capture, turn } = session();
		const first = await turn([ASK], [{ kind: "tool", id: "msg_1" }]);
		const history = [ASK, first, toolResult(first)];
		const second = await turn(history, [
			{ kind: "error", status, code },
			{ kind: "text", id: "msg_2" },
		]);
		const followUp: Message = { role: "user", content: "Thanks", timestamp: 3 };
		await turn([...history, second, followUp], [{ kind: "text", id: "msg_3" }]);

		expect(second.stopReason).toBe("stop");
		expect(capture.bodies[1]?.thread).toEqual({ type: "continue", previous_message_id: "msg_1" });
		expect(capture.bodies[2]?.thread).toEqual({ type: "create" });
		expect(capture.bodies[2]?.messages).toHaveLength(3);
		expect(capture.bodies[2]?.system).toBeDefined();
		// The replay's response is the new continuation point.
		expect(capture.bodies[3]?.thread).toEqual({ type: "continue", previous_message_id: "msg_2" });
	});

	it("stops threading the session once the API reports threads unsupported", async () => {
		const { capture, turn } = session();
		const first = await turn(
			[ASK],
			[
				{ kind: "error", status: 400, code: "thread_unsupported_request" },
				{ kind: "tool", id: "msg_1" },
			],
		);
		await turn([ASK, first, toolResult(first)], [{ kind: "text", id: "msg_2" }]);

		expect(first.stopReason).toBe("toolUse");
		expect(capture.bodies[0]?.thread).toEqual({ type: "create" });
		expect(capture.bodies[1]?.thread).toBeUndefined();
		expect(capture.bodies[2]?.thread).toBeUndefined();
		expect(capture.bodies[2]?.messages).toHaveLength(3);
		expect(capture.betas[2]?.split(",")).not.toContain(THREADS_BETA);
	});

	it("sends no thread when the caller opts out or the endpoint is a gateway", async () => {
		const optedOut = session();
		await optedOut.turn([ASK], [{ kind: "text", id: "msg_1" }], false);
		const gateway = session(
			buildModel({ ...MODEL, provider: "custom-anthropic", baseUrl: "https://gateway.example/anthropic" }),
		);
		await gateway.turn([ASK], [{ kind: "text", id: "msg_1" }]);

		for (const { capture } of [optedOut, gateway]) {
			expect(capture.bodies[0]?.thread).toBeUndefined();
			expect(capture.betas[0]?.split(",")).not.toContain(THREADS_BETA);
		}
	});
});
