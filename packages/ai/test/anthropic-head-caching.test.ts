/**
 * Unit test: the general (API-key, non-OAuth) Anthropic path must anchor a
 * cache breakpoint on the stable request head — the last system block and the
 * last tool definition — in addition to the moving message tail. Without the
 * head anchor, tail churn re-writes the whole tools+system prefix uncached,
 * which is the prompt-cache hit-rate regression this patch fixes.
 *
 * The canonical cache order is tools -> system -> messages and Anthropic allows
 * at most 4 breakpoints per request, so we also assert the total stays within
 * budget and that head caching is gated off when caching is disabled.
 *
 * No network: a capturing `fetch` records the serialized wire body and returns
 * a 400 so the request short-circuits.
 */
import { describe, expect, it } from "bun:test";
import type { MessageCreateParams } from "@oh-my-pi/pi-ai/providers/anthropic-wire";
import { streamAnthropic } from "@oh-my-pi/pi-ai/providers/anthropic";
import type { AssistantMessage, CacheRetention, Context, Message, Model, ModelSpec } from "@oh-my-pi/pi-ai/types";
import { markPerCallContextMessage } from "@oh-my-pi/pi-ai/utils/block-symbols";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

const MODEL_SPEC: ModelSpec<"anthropic-messages"> = {
	id: "claude-sonnet-4-5",
	name: "Claude Sonnet 4.5",
	api: "anthropic-messages",
	provider: "anthropic",
	baseUrl: "https://api.anthropic.com",
	reasoning: true,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 8_192,
};

const MODEL: Model<"anthropic-messages"> = buildModel(MODEL_SPEC);
const VISION_MODEL: Model<"anthropic-messages"> = buildModel({ ...MODEL_SPEC, input: ["text", "image"] });

const CONTEXT: Context = {
	systemPrompt: ["You are a precise assistant.", "Follow the house style guide."],
	messages: [{ role: "user", content: "Use the tools", timestamp: 1 }],
	tools: [
		{
			name: "lookup",
			description: "Lookup a value",
			parameters: { type: "object", properties: {}, additionalProperties: false },
		},
		{
			name: "compute",
			description: "Compute a value",
			parameters: { type: "object", properties: {}, additionalProperties: false },
		},
	],
};

async function captureWireBody(
	cacheRetention?: CacheRetention,
	context: Context = CONTEXT,
	model: Model<"anthropic-messages"> = MODEL,
): Promise<MessageCreateParams> {
	let body: MessageCreateParams | undefined;
	const fetchMock = (async (_input: string | URL | Request, init?: RequestInit) => {
		body = JSON.parse(String(init?.body ?? "{}")) as MessageCreateParams;
		return new Response(
			JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "captured" } }),
			{ status: 400, headers: { "Content-Type": "application/json" } },
		);
	}) as typeof fetch;

	await streamAnthropic(model, context, {
		apiKey: "sk-ant-api-test",
		...(cacheRetention ? { cacheRetention } : {}),
		fetch: fetchMock,
	})
		.result()
		.catch(() => undefined);

	if (!body) throw new Error("wire body was not captured");
	return body;
}

function countCacheBreakpoints(body: MessageCreateParams): number {
	let count = 0;
	for (const block of body.system ?? []) {
		if (typeof block !== "string" && block.cache_control != null) count++;
	}
	for (const tool of body.tools ?? []) {
		if ((tool as { cache_control?: unknown }).cache_control != null) count++;
	}
	for (const message of body.messages ?? []) {
		if (Array.isArray(message.content)) {
			for (const block of message.content) {
				if ((block as { cache_control?: unknown }).cache_control != null) count++;
			}
		}
	}
	return count;
}

function findCachedMessageIndices(body: MessageCreateParams): number[] {
	const indices: number[] = [];
	for (let idx = 0; idx < (body.messages?.length ?? 0); idx++) {
		const msg = body.messages[idx];
		if (
			Array.isArray(msg?.content) &&
			msg.content.some(b => typeof b === "object" && b != null && "cache_control" in b && b.cache_control != null)
		) {
			indices.push(idx);
		}
	}
	return indices;
}
function assistantMessage(text: string, timestamp: number): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: {
			input: 1,
			output: 1,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 2,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp,
	};
}

describe("anthropic head caching (general API-key path)", () => {
	it("anchors cache_control on the last system block", async () => {
		const body = await captureWireBody();
		const system = body.system;
		if (!Array.isArray(system)) throw new Error("expected system blocks array");

		const last = system[system.length - 1];
		expect(typeof last === "string" ? undefined : last.cache_control?.type).toBe("ephemeral");

		// Only the final system block is anchored, not every block.
		const earlier = system[0];
		expect(typeof earlier === "string" ? undefined : earlier.cache_control).toBeUndefined();
	});

	it("anchors cache_control on the last tool definition", async () => {
		const body = await captureWireBody();
		const tools = body.tools ?? [];
		expect(tools.length).toBeGreaterThan(1);

		const last = tools[tools.length - 1] as { cache_control?: { type?: string } };
		expect(last.cache_control?.type).toBe("ephemeral");

		// Only the final tool is anchored, not every tool.
		const first = tools[0] as { cache_control?: unknown };
		expect(first.cache_control).toBeUndefined();
	});

	it("preserves the moving message-tail breakpoint", async () => {
		const body = await captureWireBody();
		const trailing = body.messages[body.messages.length - 1];
		expect(Array.isArray(trailing.content)).toBe(true);
		if (!Array.isArray(trailing.content)) return;
		const lastBlock = trailing.content[trailing.content.length - 1] as { cache_control?: { type?: string } };
		expect(lastBlock.cache_control?.type).toBe("ephemeral");
	});

	it("keeps rolling and decimation breakpoints before per-call context", async () => {
		const messages: Message[] = [
			{ role: "user", content: "stable user", timestamp: 1 },
			assistantMessage("stable assistant", 2),
		];
		const perCallMessage: Message = {
			role: "developer",
			content: "per-call context",
			attribution: "agent",
			timestamp: 3,
		};
		markPerCallContextMessage(perCallMessage);
		messages.push(perCallMessage);
		for (let turn = 1; turn <= 15; turn++) {
			messages.push({ role: "user", content: `later user ${turn}`, timestamp: turn * 2 + 2 });
			messages.push(assistantMessage(`later assistant ${turn}`, turn * 2 + 3));
		}

		const body = await captureWireBody(undefined, { ...CONTEXT, messages });

		expect(findCachedMessageIndices(body)).toEqual([0, 1]);
	});

	it("stays within Anthropic's 4-breakpoint budget", async () => {
		const body = await captureWireBody();
		expect(countCacheBreakpoints(body)).toBeLessThanOrEqual(4);
	});

	it("adds no breakpoints when caching is disabled", async () => {
		const body = await captureWireBody("none");
		expect(countCacheBreakpoints(body)).toBe(0);
	});

	it("anchors historical decimation checkpoints every 15 user turns in long conversations", async () => {
		const messages: Message[] = [];
		for (let i = 1; i <= 20; i++) {
			messages.push({ role: "user", content: `user ${i}`, timestamp: i * 2 });
			messages.push(assistantMessage(`assistant ${i}`, i * 2 + 1));
		}

		const body = await captureWireBody(undefined, {
			...CONTEXT,
			messages,
		});

		expect(countCacheBreakpoints(body)).toBeLessThanOrEqual(4);
		const cached = findCachedMessageIndices(body);
		// The 15th user turn is at index 28 (user 1 = 0, assistant 1 = 1 ... user 15 = 28).
		expect(cached).toContain(28);
		// The trailing assistant message (index 39) is also cached.
		expect(cached).toContain(39);
		expect(cached).toHaveLength(2);
	});

	it("keeps the same decimation checkpoint anchored across successive turns", async () => {
		const messages16: Message[] = [];
		for (let i = 1; i <= 16; i++) {
			messages16.push({ role: "user", content: `user ${i}`, timestamp: i * 2 });
			messages16.push(assistantMessage(`assistant ${i}`, i * 2 + 1));
		}

		const messages17: Message[] = [...messages16];
		messages17.push({ role: "user", content: "user 17", timestamp: 35 });
		messages17.push(assistantMessage("assistant 17", 36));

		const body16 = await captureWireBody(undefined, { ...CONTEXT, messages: messages16 });
		const body17 = await captureWireBody(undefined, { ...CONTEXT, messages: messages17 });

		const cached16 = findCachedMessageIndices(body16);
		const cached17 = findCachedMessageIndices(body17);

		// Index 28 is the 15th user turn. Both turns 16 and 17 must keep index 28 anchored.
		expect(cached16).toContain(28);
		expect(cached17).toContain(28);

		// The trailing message advances while the decimation anchor stays stable.
		expect(cached16).toContain(31);
		expect(cached17).toContain(33);
	});

	it("does not count tool_result messages toward decimation and anchors the 15th conversational turn", async () => {
		const messages: Message[] = [];
		for (let i = 1; i <= 15; i++) {
			messages.push({ role: "user", content: `user ${i}`, timestamp: i * 10 });
			messages.push({
				role: "assistant",
				content: [{ type: "toolCall", id: `call-${i}`, name: "lookup", arguments: {} }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-sonnet-4-5",
				usage: {
					input: 1,
					output: 1,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 2,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "toolUse",
				timestamp: i * 10 + 1,
			});
			messages.push({
				role: "toolResult",
				toolCallId: `call-${i}`,
				toolName: "lookup",
				isError: false,
				content: [{ type: "text", text: `result ${i}` }],
				timestamp: i * 10 + 2,
			});
		}

		const body = await captureWireBody(undefined, { ...CONTEXT, messages });
		expect(countCacheBreakpoints(body)).toBeLessThanOrEqual(4);

		const cached = findCachedMessageIndices(body);
		// Each turn adds 3 messages: user text (idx 3*(i-1)), toolCall (3*(i-1)+1), toolResult (3*(i-1)+2).
		// The 15th conversational user message is at index 3 * 14 = 42.
		// If wire user messages were counted, ordinal 15 would be user 8 at index 21.
		expect(cached).toContain(42);
		expect(cached).not.toContain(21);
		// The trailing toolResult message (index 44) is also cached.
		expect(cached).toContain(44);
	});

	it("treats an error tool result with hoisted images as a tool result, not a conversational turn", async () => {
		const messages: Message[] = [];
		for (let i = 1; i <= 15; i++) {
			messages.push({ role: "user", content: `user ${i}`, timestamp: i * 10 });
			messages.push({
				role: "assistant",
				content: [{ type: "toolCall", id: `call-${i}`, name: "lookup", arguments: {} }],
				api: "anthropic-messages",
				provider: "anthropic",
				model: "claude-sonnet-4-5",
				usage: {
					input: 1,
					output: 1,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 2,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "toolUse",
				timestamp: i * 10 + 1,
			});
			// Anthropic rejects images inside an error tool result, so buildToolResultBlock
			// hoists them after the tool_result run, producing [tool_result, text, image] on
			// the wire. Detecting tool results by `content[0]` keeps these out of the turn count.
			messages.push({
				role: "toolResult",
				toolCallId: `call-${i}`,
				toolName: "lookup",
				isError: true,
				content: [
					{ type: "text", text: `failure ${i}` },
					{ type: "image", data: "iVBORw0KGgo=", mimeType: "image/png" },
				],
				timestamp: i * 10 + 2,
			});
		}

		const body = await captureWireBody(undefined, { ...CONTEXT, messages }, VISION_MODEL);
		expect(countCacheBreakpoints(body)).toBeLessThanOrEqual(4);

		// Confirm the hoisted shape actually reached the wire: tool_result followed by the
		// "Attached image(s)" text and the image block.
		const toolResultMessage = body.messages[2];
		const blocks = Array.isArray(toolResultMessage?.content) ? toolResultMessage.content : [];
		expect(blocks[0]?.type).toBe("tool_result");
		expect(blocks.some(block => block.type === "image")).toBe(true);

		const cached = findCachedMessageIndices(body);
		// The 15th conversational user message is still at index 42; an `every(...)` check
		// would misread these three-block messages as conversational turns and drift the anchor.
		expect(cached).toContain(42);
		expect(cached).not.toContain(21);
	});

	it("does not count a serialized developer message as a conversational turn", async () => {
		// A persistent developer message is serialized as wire `role: "user"` on models
		// without mid-conversation system support, so counting wire roles would treat it
		// as turn 1 and shift every later checkpoint one message earlier.
		const messages: Message[] = [{ role: "developer", content: "Session policy reminder.", timestamp: 1 }];
		for (let i = 1; i <= 15; i++) {
			messages.push({ role: "user", content: `user ${i}`, timestamp: i * 2 + 1 });
			messages.push(assistantMessage(`assistant ${i}`, i * 2 + 2));
		}

		const body = await captureWireBody(undefined, { ...CONTEXT, messages });
		expect(countCacheBreakpoints(body)).toBeLessThanOrEqual(4);

		// The developer message occupies wire index 0, so user 1 is at index 1 and the
		// 15th conversational turn is at index 29. Counting wire users would anchor
		// index 27 (user 14) after only 14 real turns.
		const developerWire = body.messages[0];
		expect(developerWire?.role).toBe("user");
		const cached = findCachedMessageIndices(body);
		expect(cached).toContain(29);
		expect(cached).not.toContain(27);
	});

	it("does not count interior Continue. pads as conversational turns", async () => {
		// Two adjacent assistant messages force an interior `Continue.` pad, which
		// enters the wire as `role: "user"` without being a real turn.
		const messages: Message[] = [];
		for (let i = 1; i <= 15; i++) {
			messages.push({ role: "user", content: `user ${i}`, timestamp: i * 3 });
			messages.push(assistantMessage(`assistant ${i}a`, i * 3 + 1));
			messages.push(assistantMessage(`assistant ${i}b`, i * 3 + 2));
		}

		const body = await captureWireBody(undefined, { ...CONTEXT, messages });
		expect(countCacheBreakpoints(body)).toBeLessThanOrEqual(4);

		// Each turn emits user, assistant, pad, assistant, so the pads sit at indices
		// 2, 6, 10, … and the 15th conversational turn lands at index 56.
		const pad = body.messages[2];
		expect(pad?.role).toBe("user");
		expect(pad?.content).toBe("Continue.");
		const cached = findCachedMessageIndices(body);
		expect(cached).toContain(56);
		expect(cached).not.toContain(28);
	});

	it("does not count synthesized stale-tool-result notes as conversational turns", async () => {
		// An orphan toolResult (no matching toolCall, as after compaction) is rewritten by
		// transformMessages into a `<stale-tool-result>` note carrying `role: "user"`, so it
		// is indistinguishable from a real turn by role alone.
		const messages: Message[] = [
			{
				role: "toolResult",
				toolCallId: "orphan-1",
				toolName: "lookup",
				isError: false,
				content: [{ type: "text", text: "output from a call that no longer exists" }],
				timestamp: 1,
			},
		];
		for (let i = 1; i <= 15; i++) {
			messages.push({ role: "user", content: `user ${i}`, timestamp: i * 2 + 1 });
			messages.push(assistantMessage(`assistant ${i}`, i * 2 + 2));
		}

		const body = await captureWireBody(undefined, { ...CONTEXT, messages });
		expect(countCacheBreakpoints(body)).toBeLessThanOrEqual(4);

		// The note reaches the wire as a `user` message at index 0.
		const note = body.messages[0];
		expect(note?.role).toBe("user");
		expect(String(note?.content)).toContain("<stale-tool-result");

		// User 1 therefore sits at index 1 and the 15th conversational turn at index 29.
		// Counting the note would anchor index 27 after only 14 real turns.
		const cached = findCachedMessageIndices(body);
		expect(cached).toContain(29);
		expect(cached).not.toContain(27);
	});

	it("does not count agent-authored user messages as conversational turns", async () => {
		// Compaction and branch summaries are emitted as `role: "user"` with
		// `attribution: "agent"`, and auto-continue injections carry `synthetic: true`.
		// Neither is a turn the user took.
		const messages: Message[] = [
			{
				role: "user",
				content: "<compaction-summary>earlier work</compaction-summary>",
				attribution: "agent",
				timestamp: 1,
			},
			{ role: "user", content: "auto-continue", synthetic: true, timestamp: 2 },
		];
		for (let i = 1; i <= 15; i++) {
			messages.push({ role: "user", content: `user ${i}`, timestamp: i * 2 + 3 });
			messages.push(assistantMessage(`assistant ${i}`, i * 2 + 4));
		}

		const body = await captureWireBody(undefined, { ...CONTEXT, messages });
		expect(countCacheBreakpoints(body)).toBeLessThanOrEqual(4);

		// Both land on the wire as `user`, occupying indices 0 and 1, so the 15th
		// conversational turn is at index 30. Counting them would anchor index 26.
		expect(body.messages[0]?.role).toBe("user");
		expect(body.messages[1]?.role).toBe("user");
		const cached = findCachedMessageIndices(body);
		expect(cached).toContain(30);
		expect(cached).not.toContain(26);
	});

	it("preserves the decimation anchor when the trailing assistant turn is thinking-only", async () => {
		const messages: Message[] = [];
		for (let i = 1; i <= 15; i++) {
			messages.push({ role: "user", content: `user ${i}`, timestamp: i * 2 });
			messages.push(assistantMessage(`assistant ${i}`, i * 2 + 1));
		}
		messages.push({ role: "user", content: "user 16", timestamp: 35 });
		messages.push({
			role: "assistant",
			content: [{ type: "thinking", thinking: "long deliberation", thinkingSignature: "sig-1" }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 36,
		});

		const body = await captureWireBody(undefined, { ...CONTEXT, messages });
		expect(countCacheBreakpoints(body)).toBeLessThanOrEqual(4);

		const cached = findCachedMessageIndices(body);
		// The 15th user turn is at index 28. It must still be anchored even though the trailing assistant
		// cannot receive cache_control.
		expect(cached).toContain(28);
		// The trailing thinking assistant cannot accept cache_control, so the fallback user turn 16 (index 30) gets it.
		expect(cached).toContain(30);
	});
	it("clamps total breakpoints to 4 even with multiple decimation checkpoints", async () => {
		const messages: Message[] = [];
		for (let i = 1; i <= 35; i++) {
			messages.push({ role: "user", content: `user ${i}`, timestamp: i * 2 });
			messages.push(assistantMessage(`assistant ${i}`, i * 2 + 1));
		}

		const body = await captureWireBody(undefined, {
			...CONTEXT,
			messages,
		});

		expect(countCacheBreakpoints(body)).toBeLessThanOrEqual(4);
		const cached = findCachedMessageIndices(body);
		// When budget is 2, the latest decimation checkpoint (user 30, index 58) is selected.
		expect(cached).toContain(58);
		expect(cached).toContain(69);
		expect(cached).toHaveLength(2);
	});

	it("allocates additional decimation checkpoints when head breakpoints are absent", async () => {
		const messages: Message[] = [];
		for (let i = 1; i <= 35; i++) {
			messages.push({ role: "user", content: `user ${i}`, timestamp: i * 2 });
			messages.push(assistantMessage(`assistant ${i}`, i * 2 + 1));
		}

		const body = await captureWireBody(undefined, {
			systemPrompt: [],
			tools: [],
			messages,
		});

		expect(countCacheBreakpoints(body)).toBeLessThanOrEqual(4);
		const cached = findCachedMessageIndices(body);
		// With 0 head breakpoints, budget is 4: keeps both turn 15 (idx 28) and turn 30 (idx 58)
		// plus the trailing 2 messages (idx 68 and 69).
		expect(cached).toContain(28);
		expect(cached).toContain(58);
		expect(cached).toContain(68);
		expect(cached).toContain(69);
		expect(cached).toHaveLength(4);
	});
});
