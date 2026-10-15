/**
 * Unit test: an in-place history rewrite (advisor stale-result eviction,
 * tool-output pruning) invalidates every prefix hash from the first rewritten
 * message onward. Anthropic's lookback window is 20 positions, so when the
 * rewritten region is longer than that the tail breakpoint finds no entry and
 * the check falls back to the previous explicit breakpoint — re-writing the
 * whole span at the cacheWrite premium. `applyPromptCaching` therefore anchors
 * an extra breakpoint on the last message before a long rewritten region, and
 * leaves the common shallow prune on today's trailing/decimation behavior.
 *
 * No network: a capturing `fetch` records the serialized wire body and returns
 * a 400 so the request short-circuits.
 */
import { describe, expect, it } from "bun:test";
import type { MessageCreateParams } from "@oh-my-pi/pi-ai/providers/anthropic-wire";
import { streamAnthropic } from "@oh-my-pi/pi-ai/providers/anthropic";
import type { Context, Message, Model, ModelSpec } from "@oh-my-pi/pi-ai/types";
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

const USAGE = {
	input: 1,
	output: 1,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 2,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const TOOLS: Context["tools"] = [
	{
		name: "lookup",
		description: "Lookup a value",
		parameters: { type: "object", properties: {}, additionalProperties: false },
	},
];

async function captureWireBody(
	messages: Message[],
	{
		apiKey = "sk-ant-api-test",
		systemPrompt = ["You are a precise assistant."],
		tools = TOOLS,
		model = MODEL,
	}: { apiKey?: string; systemPrompt?: string[]; tools?: Context["tools"]; model?: Model<"anthropic-messages"> } = {},
): Promise<MessageCreateParams> {
	let body: MessageCreateParams | undefined;
	const fetchMock = (async (_input: string | URL | Request, init?: RequestInit) => {
		body = (await new Response(init?.body).json()) as MessageCreateParams;
		return new Response(
			JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "captured" } }),
			{ status: 400, headers: { "Content-Type": "application/json" } },
		);
	}) as typeof fetch;

	await streamAnthropic(model, { systemPrompt, messages, tools }, { apiKey, fetch: fetchMock })
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

function cachedMessageIndices(body: MessageCreateParams): number[] {
	const indices: number[] = [];
	for (let index = 0; index < (body.messages?.length ?? 0); index++) {
		const message = body.messages[index];
		if (
			Array.isArray(message?.content) &&
			message.content.some(
				block =>
					typeof block === "object" && block != null && "cache_control" in block && block.cache_control != null,
			)
		) {
			indices.push(index);
		}
	}
	return indices;
}

/**
 * Wire layout: index 0 is the opening user turn, tool cycle `i` occupies
 * indices `2i - 1` (assistant: text + tool_use) and `2i` (its tool_result),
 * and the closing user turn sits at `2 * cycles + 1`. Each cycle is three
 * lookback positions (text, tool_use run, tool_result run).
 */
function history(cycles: number, prunedAt: ReadonlyMap<number, number>, thinkingCycle?: number): Message[] {
	const messages: Message[] = [{ role: "user", content: "start", timestamp: 1 }];
	for (let cycle = 1; cycle <= cycles; cycle++) {
		const timestamp = cycle * 10;
		messages.push({
			role: "assistant",
			content:
				cycle === thinkingCycle
					? [
							{ type: "text", text: `step ${cycle}` },
							{ type: "toolCall", id: `call-${cycle}`, name: "lookup", arguments: {} },
							{ type: "thinking", thinking: `weighing step ${cycle}`, thinkingSignature: "sig-1" },
						]
					: [
							{ type: "text", text: `step ${cycle}` },
							{ type: "toolCall", id: `call-${cycle}`, name: "lookup", arguments: {} },
						],
			api: "anthropic-messages",
			provider: "anthropic",
			model: MODEL_SPEC.id,
			usage: USAGE,
			stopReason: "toolUse",
			timestamp: timestamp + 1,
		});
		const pruned = prunedAt.get(cycle);
		messages.push({
			role: "toolResult",
			toolCallId: `call-${cycle}`,
			toolName: "lookup",
			isError: false,
			content: [{ type: "text", text: pruned === undefined ? `result ${cycle}` : "[Stale result elided]" }],
			timestamp: timestamp + 2,
			...(pruned === undefined ? {} : { prunedAt: pruned }),
		});
	}
	messages.push({ role: "user", content: "wrap up", timestamp: cycles * 10 + 5 });
	return messages;
}

/**
 * A session of `turns` user turns plus a closing one. Wire layout for turn
 * `k` (1-based): user at `4(k - 1)`, assistant text + tool_use at `4(k - 1) + 1`,
 * its tool_result at `4(k - 1) + 2`, assistant reply at `4(k - 1) + 3`; the
 * closing user turn sits at `4 * turns`. `prunedTurns` rewrites those turns'
 * tool results after every assistant turn was sent, so the rewrite is unbilled;
 * `perCallTurn` marks that turn's tool_use assistant as per-call context.
 */
function longSession(turns: number, prunedTurns: readonly number[], perCallTurn?: number): Message[] {
	const messages: Message[] = [];
	for (let turn = 1; turn <= turns; turn++) {
		const timestamp = turn * 100;
		messages.push({ role: "user", content: `turn ${turn}`, timestamp });
		const toolUse: Message = {
			role: "assistant",
			content: [
				{ type: "text", text: `checking ${turn}` },
				{ type: "toolCall", id: `call-${turn}`, name: "lookup", arguments: {} },
			],
			api: "anthropic-messages",
			provider: "anthropic",
			model: MODEL_SPEC.id,
			usage: USAGE,
			stopReason: "toolUse",
			timestamp: timestamp + 1,
		};
		if (turn === perCallTurn) markPerCallContextMessage(toolUse);
		messages.push(toolUse);
		const pruned = prunedTurns.includes(turn);
		messages.push({
			role: "toolResult",
			toolCallId: `call-${turn}`,
			toolName: "lookup",
			isError: false,
			content: [{ type: "text", text: pruned ? "[Stale result elided]" : `result ${turn}` }],
			timestamp: timestamp + 2,
			...(pruned ? { prunedAt: 1_000_000 } : {}),
		});
		messages.push({
			role: "assistant",
			content: [{ type: "text", text: `done ${turn}` }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: MODEL_SPEC.id,
			usage: USAGE,
			stopReason: "stop",
			timestamp: timestamp + 3,
		});
	}
	messages.push({ role: "user", content: "wrap up", timestamp: turns * 100 + 50 });
	return messages;
}

describe("anthropic rewrite-boundary caching", () => {
	it("anchors a breakpoint before a rewritten region deeper than the lookback window", async () => {
		// Cycle 2's result is pruned: 26 lookback positions from there to the tail.
		const body = await captureWireBody(history(10, new Map([[2, 1_000]])));

		expect(countCacheBreakpoints(body)).toBeLessThanOrEqual(4);
		// Index 3 is cycle 2's assistant — the last message before the rewrite;
		// index 21 is the trailing user turn.
		expect(cachedMessageIndices(body)).toEqual([3, 21]);
	});

	it("leaves a shallow rewrite on the trailing breakpoints", async () => {
		const pruned = await captureWireBody(history(10, new Map([[10, 1_000]])));
		const unpruned = await captureWireBody(history(10, new Map()));

		// Two lookback positions behind the tail: the tail breakpoint's own
		// window still reaches the last good entry, so nothing changes.
		expect(cachedMessageIndices(pruned)).toEqual(cachedMessageIndices(unpruned));
		expect(cachedMessageIndices(pruned)).not.toContain(19);
	});

	it("drops the boundary once a later request has already re-billed the rewrite", async () => {
		// Cycle 2's result was pruned at t=25, before cycle 3's assistant turn
		// (t=31) was sent: that request paid for the rewrite and wrote its own
		// tail entry, so the layout returns to the unpruned one.
		const rebilled = await captureWireBody(history(10, new Map([[2, 25]])));
		const unpruned = await captureWireBody(history(10, new Map()));

		expect(cachedMessageIndices(rebilled)).toEqual(cachedMessageIndices(unpruned));
		expect(cachedMessageIndices(rebilled)).not.toContain(3);
	});

	it("starts the region at the earliest unbilled rewrite, not the newest", async () => {
		// Two prune passes before one request: cycle 3 (deep) at t=1000, cycle 11
		// (shallow) at t=2000. Neither is billed, so the region starts at cycle 3.
		const body = await captureWireBody(
			history(
				12,
				new Map([
					[3, 1_000],
					[11, 2_000],
				]),
			),
		);

		// Index 5 is cycle 3's assistant; index 25 is the trailing user turn.
		expect(cachedMessageIndices(body)).toEqual([5, 25]);
	});

	it("ignores an older rewrite a later request already billed", async () => {
		// Cycle 3 was pruned at t=25, before cycle 3's assistant (t=31) was sent;
		// only the shallow cycle-11 rewrite is unbilled, and the tail bridges it.
		const body = await captureWireBody(
			history(
				12,
				new Map([
					[3, 25],
					[11, 2_000],
				]),
			),
		);
		const unpruned = await captureWireBody(history(12, new Map()));

		expect(cachedMessageIndices(body)).toEqual(cachedMessageIndices(unpruned));
	});

	it("adds no boundary for a model without a catalog lookback", async () => {
		const model = buildModel({ ...MODEL_SPEC, id: "kimi-k2", name: "Kimi K2" });
		const pruned = await captureWireBody(history(10, new Map([[2, 1_000]])), { model });
		const unpruned = await captureWireBody(history(10, new Map()), { model });

		expect(cachedMessageIndices(unpruned)).toContain(21);
		expect(cachedMessageIndices(pruned)).toEqual(cachedMessageIndices(unpruned));
	});

	it("skips reasoning blocks when the boundary message ends in thinking", async () => {
		const body = await captureWireBody(history(10, new Map([[2, 1_000]]), 2));

		const boundary = body.messages[3];
		if (!Array.isArray(boundary.content)) throw new Error("expected block content on the boundary message");
		const lastBlock = boundary.content[boundary.content.length - 1];
		expect(lastBlock.type).toBe("thinking");
		expect((lastBlock as { cache_control?: unknown }).cache_control).toBeUndefined();
		// The breakpoint falls back to the last cacheable block of that message.
		expect(cachedMessageIndices(body)).toContain(3);
		expect(countCacheBreakpoints(body)).toBeLessThanOrEqual(4);
	});

	it("keeps the boundary and the trailing turn under the heaviest head", async () => {
		// OAuth identity block + `<memories>` suffix: the identity breakpoint
		// moves to the stable-system anchor, so the head spends two (system +
		// tool) and the boundary still fits beside the trailing turn.
		const body = await captureWireBody(history(10, new Map([[2, 1_000]])), {
			apiKey: "sk-ant-oat-test",
			systemPrompt: ["You are a precise assistant.", "<memories>recalled note</memories>"],
		});

		expect(countCacheBreakpoints(body)).toBe(4);
		expect(cachedMessageIndices(body)).toEqual([3, 21]);
	});

	it("ranks the boundary above decimation anchors inside the rewritten region", async () => {
		// 17 user turns: the 15th (index 56) is upstream's decimation anchor.
		// Turn 3's result is pruned, so the boundary is turn 3's assistant (9)
		// and the anchor sits inside the rewritten region.
		const unpruned = await captureWireBody(longSession(16, []));
		const pruned = await captureWireBody(longSession(16, [3]));

		expect(cachedMessageIndices(unpruned)).toEqual([56, 64]);
		// System + tool anchors leave two message breakpoints: the trailing turn
		// keeps one and the boundary outranks the in-region anchor for the other.
		expect(cachedMessageIndices(pruned)).toEqual([9, 64]);
		expect(countCacheBreakpoints(pruned)).toBe(4);
	});

	it("keeps the boundary ahead of a decimation anchor within its lookback", async () => {
		// 20 user turns: the decimation anchor is turn 15's user message (56).
		// Turn 15's result is pruned, so the boundary (57) sits right after the
		// anchor and its own lookback reaches the anchor's entry.
		const unpruned = await captureWireBody(longSession(19, []));
		const pruned = await captureWireBody(longSession(19, [15]));

		expect(cachedMessageIndices(unpruned)).toEqual([56, 76]);
		expect(cachedMessageIndices(pruned)).toEqual([57, 76]);
		expect(countCacheBreakpoints(pruned)).toBe(4);
	});

	it("ranks a decimation anchor beyond the boundary's lookback ahead of the boundary", async () => {
		// 25 user turns: the decimation anchor is turn 15's user message (56).
		// Turn 20's result is pruned; the boundary (77) is 27 positions past the
		// anchor, so its lookback cannot reach the anchor's entry.
		const unpruned = await captureWireBody(longSession(24, []));
		const pruned = await captureWireBody(longSession(24, [20]));

		expect(cachedMessageIndices(unpruned)).toEqual([56, 96]);
		// Two message breakpoints: trailing turn + the anchor; the boundary drops.
		expect(cachedMessageIndices(pruned)).toEqual([56, 96]);
		expect(countCacheBreakpoints(pruned)).toBe(4);
	});

	it("measures a decimation anchor's reach to the boundary's cache_control block, not past trailing thinking", async () => {
		// 25 user turns: the decimation anchor is turn 15's user message (56).
		// Turn 18's result is pruned, so the boundary is turn 18's tool_use
		// assistant (69). Its two leading thinking blocks put its tool_use 19
		// positions past the anchor — inside the lookback — while its trailing
		// thinking block would make the whole message 20.
		const messages = longSession(24, [18]);
		const boundary = messages[69];
		if (boundary.role !== "assistant") throw new Error("expected the boundary assistant at index 69");
		boundary.content = [
			{ type: "thinking", thinking: "planning", thinkingSignature: "sig-a" },
			{ type: "thinking", thinking: "planning more", thinkingSignature: "sig-b" },
			...boundary.content,
			{ type: "thinking", thinking: "after the call", thinkingSignature: "sig-c" },
		];
		const body = await captureWireBody(messages);

		const wireBoundary = body.messages[69];
		if (!Array.isArray(wireBoundary.content)) throw new Error("expected block content on the boundary message");
		expect(wireBoundary.content.map(block => block.type)).toEqual([
			"thinking",
			"thinking",
			"text",
			"tool_use",
			"thinking",
		]);
		// The anchor's entry is within the boundary's reach, so the boundary
		// keeps the second message breakpoint and the anchor does not take it.
		expect(cachedMessageIndices(body)).toEqual([69, 96]);
		expect(countCacheBreakpoints(body)).toBe(4);
	});

	it("keeps the far decimation anchor and the boundary when three message breakpoints remain", async () => {
		// No tools, so only the system anchor spends a head breakpoint.
		const pruned = await captureWireBody(longSession(24, [20]), { tools: [] });

		expect(cachedMessageIndices(pruned)).toEqual([56, 77, 96]);
		expect(countCacheBreakpoints(pruned)).toBe(4);
	});

	it("displaces the oldest decimation anchor first when three message breakpoints remain", async () => {
		// 32 user turns: decimation anchors at the 15th (56) and 30th (116).
		// No tools, so only the system anchor spends a head breakpoint.
		const unpruned = await captureWireBody(longSession(31, []), { tools: [] });
		const pruned = await captureWireBody(longSession(31, [3]), { tools: [] });

		expect(cachedMessageIndices(unpruned)).toEqual([56, 116, 124]);
		// Ranked trailing, boundary, then decimation newest first: the 15th
		// turn's anchor is the one that falls off the budget.
		expect(cachedMessageIndices(pruned)).toEqual([9, 116, 124]);
		expect(countCacheBreakpoints(pruned)).toBe(4);
	});

	it("never anchors the boundary on a per-call message", async () => {
		// Turn 3's assistant (9) is rebuilt every request, so a breakpoint on
		// it could never match; upstream skips such messages as candidates.
		// The boundary falls back to the nearest message before it (turn 3's
		// user message, 8), which still precedes the rewritten region.
		const body = await captureWireBody(longSession(16, [3], 3));

		expect(cachedMessageIndices(body)).toEqual([8, 64]);
		expect(countCacheBreakpoints(body)).toBe(4);
	});
});
