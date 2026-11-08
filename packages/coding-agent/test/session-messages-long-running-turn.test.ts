/**
 * Long-running single-turn regression for oversized tool-call arguments.
 *
 * One real user turn hosts a completed `task` call carrying five nested
 * 400 KB base64 argument strings, then keeps running: three async worker
 * notices (`async-result` custom messages) and assistant replies follow with
 * no new real user message. Every normal send must stay under 100 KB on the
 * wire because the completed call's arguments are shrunk everywhere — the
 * model already has the result and does not need its own argument bytes —
 * while the pending-call and tool-result rules stay as they are (no pending
 * call is built here; results are small and stay intact).
 *
 * Each of the four sends goes through the coding-agent `convertToLlm`
 * pipeline and the actual Anthropic `streamSimple` request builder against a
 * loopback HTTP/SSE provider mock with a deterministic 1,000,000 input-byte
 * limit (explicit 400 above the bound). On the pre-fix baseline the first
 * request carries the full ~2 MB of arguments, so the mock answers the real
 * 400 overflow and the test fails there; after the fix every request shrinks
 * below 100 KB and no overflow occurs. The full arguments and results remain
 * in the fixture (execution/source) messages, and the signed thinking block's
 * signature is replayed byte-for-byte (no signature metadata change; the mock
 * does not perform provider signature verification).
 */
import { describe, expect, it } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, ToolCall } from "@oh-my-pi/pi-ai";
import { streamSimple } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { convertToLlm } from "../src/session/messages";
import { latestUserTurnIndex } from "../src/session/tool-history-shrink";

/** Exactly 400,000 UTF-8 bytes of deterministic base64 (100,000 complete groups). */
const HUGE_BASE64 = Buffer.alloc(300_000, 0x41).toString("base64");

/** The provider mock's deterministic input bound; larger bodies get a real 400. */
const MOCK_PROVIDER_INPUT_LIMIT_BYTES = 1_000_000;

/** Every encoded request must stay below this many bytes. */
const MAX_REQUEST_BYTES = 100_000;

const MOCK_API_KEY = "test-key";
const MODEL_ID = "claude-sonnet-4-5";
const THINKING_TEXT = "Plan: dispatch the batch to the background worker.";
const THINKING_SIGNATURE = "sig_fixture_unchanged_2f9c41d7e0a8b65c";

const OMITTED_MARKER = /\[omitted 400000 bytes, sha256=[0-9a-f]{12}; full value kept in the session file\]/;

let clock = 1_700_000_000_000;

type ContentBlock = AssistantMessage["content"][number];

function user(text: string): AgentMessage {
	return { role: "user", content: text, timestamp: clock++ } as AgentMessage;
}

function assistantMessage(content: AssistantMessage["content"], stopReason: string): AgentMessage {
	return {
		role: "assistant",
		content,
		api: "anthropic-messages",
		provider: "anthropic",
		model: MODEL_ID,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason,
		timestamp: clock++,
	} as AgentMessage;
}

function taskCallArguments(): { tasks: Array<{ artifacts: Array<{ data: string }> }> } {
	return { tasks: [{ artifacts: Array.from({ length: 5 }, () => ({ data: HUGE_BASE64 })) }] };
}

/** Async worker notice: a custom message that must NOT count as a real user turn. */
function workerNotice(index: number): AgentMessage {
	return {
		role: "custom",
		customType: "async-result",
		content: `Background worker ${index} finished.`,
		display: true,
		attribution: "agent",
		details: { jobs: [{ jobId: `job-${index}`, type: "task", label: `worker ${index}` }] },
		timestamp: clock++,
	} as AgentMessage;
}

interface RecordedRequest {
	bytes: number;
	status: number;
	body: string;
}

interface WireBlock {
	type: string;
	text?: string;
	thinking?: string;
	signature?: string;
	id?: string;
	name?: string;
	input?: unknown;
	tool_use_id?: string;
	content?: unknown;
}

/** Runtime-narrowed read of the fixture's artifact data strings from wire `input`. */
function artifactDataFromInput(input: unknown): string[] {
	if (typeof input !== "object" || input === null || !("tasks" in input) || !Array.isArray(input.tasks)) {
		throw new Error("unexpected tool input shape");
	}
	const artifacts: string[] = [];
	for (const task of input.tasks) {
		if (typeof task !== "object" || task === null || !("artifacts" in task) || !Array.isArray(task.artifacts)) {
			throw new Error("unexpected tool input artifacts shape");
		}
		for (const artifact of task.artifacts) {
			if (
				typeof artifact !== "object" ||
				artifact === null ||
				!("data" in artifact) ||
				typeof artifact.data !== "string"
			) {
				throw new Error("unexpected tool input artifact shape");
			}
			artifacts.push(artifact.data);
		}
	}
	return artifacts;
}

function wireBlocks(body: string): WireBlock[] {
	const parsed: unknown = JSON.parse(body);
	if (typeof parsed !== "object" || parsed === null || !("messages" in parsed) || !Array.isArray(parsed.messages)) {
		throw new Error("unexpected wire request shape");
	}
	const blocks: WireBlock[] = [];
	for (const message of parsed.messages) {
		if (typeof message !== "object" || message === null || !("content" in message)) continue;
		const content: unknown = message.content;
		if (!Array.isArray(content)) continue;
		for (const block of content) {
			if (typeof block !== "object" || block === null || !("type" in block) || typeof block.type !== "string") {
				continue;
			}
			// One-off cast of a JSON block already narrowed to an object with a
			// string discriminant; optional fields read through the WireBlock view.
			const wireBlock = block as WireBlock;
			blocks.push(wireBlock);
		}
	}
	return blocks;
}

describe("session messages long-running turn oversized tool arguments", () => {
	it("keeps every Anthropic request under 100KB across four sends in one real user turn with async worker notices", async () => {
		const requests: RecordedRequest[] = [];
		// Loopback HTTP/SSE provider mock: consumes each request body, records its
		// actual encoded byte size, and rejects above the deterministic 1M bound
		// with a real 400 overflow error. Anything smaller gets a complete SSE turn.
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			idleTimeout: 30,
			fetch: async (request: Request): Promise<Response> => {
				const body = Buffer.from(await request.arrayBuffer());
				const text = body.toString("utf8");
				if (body.byteLength > MOCK_PROVIDER_INPUT_LIMIT_BYTES) {
					requests.push({ bytes: body.byteLength, status: 400, body: text });
					return new Response(
						JSON.stringify({
							type: "error",
							error: { type: "invalid_request_error", message: "input length exceeds 1000000 bytes" },
						}),
						{ status: 400, headers: { "content-type": "application/json" } },
					);
				}
				requests.push({ bytes: body.byteLength, status: 200, body: text });
				const events: Array<Record<string, unknown>> = [
					{
						type: "message_start",
						message: {
							id: "msg_mock",
							type: "message",
							role: "assistant",
							model: MODEL_ID,
							content: [],
							stop_reason: null,
							usage: { input_tokens: 1, output_tokens: 0 },
						},
					},
					{ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
					{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "ok" } },
					{ type: "content_block_stop", index: 0 },
					{ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 1 } },
					{ type: "message_stop" },
				];
				const sse = events
					.map(event => `event: ${String(event.type)}\ndata: ${JSON.stringify(event)}\n\n`)
					.join("");
				return new Response(sse, { headers: { "content-type": "text/event-stream" } });
			},
		});

		try {
			const model = buildModel({
				id: MODEL_ID,
				name: "Claude Sonnet 4.5",
				api: "anthropic-messages",
				provider: "anthropic",
				baseUrl: `http://127.0.0.1:${server.port}`,
				reasoning: true,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 400_000,
				maxTokens: 128_000,
			});

			const send = async (history: AgentMessage[]): Promise<AssistantMessage> => {
				const before = requests.length;
				const stream = streamSimple(
					model,
					{ systemPrompt: [], messages: convertToLlm(history) },
					{ apiKey: MOCK_API_KEY },
				);
				const finalResult = stream.result();
				finalResult.catch(() => undefined);
				for await (const _event of stream) {
					// Drain the real provider stream through its terminal event.
				}
				expect(requests.length).toBe(before + 1); // one request per send, no retries
				const received = requests[before]!;
				expect({ status: received.status, bytes: received.bytes }).toEqual({
					status: 200,
					bytes: expect.any(Number),
				});
				const outcome = await finalResult;
				expect(outcome.stopReason).toBe("stop");
				expect(outcome.content).toEqual([{ type: "text", text: "ok" }]);
				return outcome;
			};

			// Fixture: ONE real user message; inside its turn a completed assistant
			// task call (five nested 400 KB base64 argument strings, signed thinking
			// before the call), the call's result, then three async worker notices
			// with assistant replies. No further real user message is ever appended.
			const originalArguments = taskCallArguments();
			const call: ToolCall = { type: "toolCall", id: "call-task", name: "task", arguments: originalArguments };
			const thinking: ContentBlock = {
				type: "thinking",
				thinking: THINKING_TEXT,
				thinkingSignature: THINKING_SIGNATURE,
			};
			const history: AgentMessage[] = [
				user("Process the batch with the background workers."),
				assistantMessage([thinking, call], "toolUse"),
				{
					role: "toolResult",
					toolCallId: call.id,
					toolName: "task",
					content: [{ type: "text", text: "task complete" }],
					isError: false,
					timestamp: clock++,
				} as AgentMessage,
			];

			// Scenario realism (negative control of the bound itself): the raw
			// arguments genuinely exceed the mock's deterministic input limit.
			expect(Buffer.byteLength(HUGE_BASE64, "utf8")).toBe(400_000);
			expect(Buffer.byteLength(JSON.stringify(originalArguments))).toBeGreaterThan(MOCK_PROVIDER_INPUT_LIMIT_BYTES);
			expect(latestUserTurnIndex(history)).toBe(0);

			// Send 1: initial completed call inside the current real user turn.
			await send(history);

			// Sends 2-4: async worker notices plus assistant turns, same array,
			// still inside the same real user turn.
			for (let index = 1; index <= 3; index++) {
				history.push(
					workerNotice(index),
					assistantMessage([{ type: "text", text: `Noted worker ${index}.` }], "endTurn"),
				);
				// Async custom worker notices must NOT count as real user turns.
				expect(latestUserTurnIndex(history)).toBe(0);
				await send(history);
			}

			// Every built request stayed below 100 KB with no overflow error at all.
			expect(requests).toHaveLength(4);
			for (const request of requests) {
				expect(request.status).toBe(200);
				expect(request.bytes).toBeLessThan(MAX_REQUEST_BYTES);
				// Shrunk arguments on the wire: exactly the five omitted markers, and
				// none of the original 400 KB strings.
				expect(request.body.match(new RegExp(OMITTED_MARKER.source, "g")) ?? []).toHaveLength(5);
				expect(request.body).not.toContain(HUGE_BASE64);

				// Ids/names/result pairing intact on every request.
				const blocks = wireBlocks(request.body);
				const toolUses = blocks.filter(block => block.type === "tool_use");
				expect(toolUses).toHaveLength(1);
				expect(toolUses[0]).toMatchObject({ id: "call-task", name: "task" });
				const artifacts = artifactDataFromInput(toolUses[0]!.input);
				expect(artifacts).toHaveLength(5);
				for (const data of artifacts) expect(data).toMatch(new RegExp(`^${OMITTED_MARKER.source}$`));
				const toolResults = blocks.filter(block => block.type === "tool_result");
				expect(toolResults).toHaveLength(1);
				expect(toolResults[0]!.tool_use_id).toBe("call-task");
				expect(JSON.stringify(toolResults[0]!.content)).toContain("task complete");

				// Signed thinking before the call: signature metadata unchanged.
				const thinkingBlocks = blocks.filter(block => block.type === "thinking");
				expect(thinkingBlocks).toHaveLength(1);
				expect(thinkingBlocks[0]!.thinking).toBe(THINKING_TEXT);
				expect(thinkingBlocks[0]!.signature).toBe(THINKING_SIGNATURE);
			}

			// Full execution/source fixture values remain unchanged: the session's
			// assistant call keeps every original argument byte and the result text.
			const savedTurn = history[1]!;
			if (savedTurn.role !== "assistant") throw new Error("expected assistant task turn");
			const savedCall = savedTurn.content.find((block): block is ToolCall => block.type === "toolCall");
			if (!savedCall) throw new Error("expected completed task call");
			expect(savedCall.arguments).toEqual(originalArguments);
			for (const data of artifactDataFromInput(savedCall.arguments)) {
				expect(data).toBe(HUGE_BASE64);
				expect(Buffer.byteLength(data, "utf8")).toBe(400_000);
			}
			const savedResult = history[2]!;
			if (savedResult.role !== "toolResult") throw new Error("expected task result");
			expect(JSON.stringify(savedResult.content)).toContain("task complete");
		} finally {
			server.stop(true);
		}
	});
});
