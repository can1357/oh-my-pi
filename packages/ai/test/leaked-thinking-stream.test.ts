import { describe, expect, it } from "bun:test";
import { stream } from "@oh-my-pi/pi-ai/stream";
import type {
	AnthropicServerToolContent,
	AssistantMessage,
	AssistantMessageEvent,
	Context,
	FetchImpl,
	Model,
	TextContent,
	ThinkingContent,
	ToolCall,
} from "@oh-my-pi/pi-ai/types";
import { getStreamingPartialJson, setStreamingPartialJson } from "@oh-my-pi/pi-ai/utils/block-symbols";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { wrapLeakedThinkingStream } from "@oh-my-pi/pi-ai/utils/leaked-thinking-stream";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { withOfficialAnthropicEndpoint } from "./helpers";

/** Minimal assistant message; `content`/`stopReason` overridden per event. */
function msg(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "mock",
		provider: "mock",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: 0,
		...overrides,
	};
}

/**
 * Drive the wrapper: push inner events synchronously, then drain the healed
 * output. Returns every emitted event plus the resolved final message.
 */
async function runWrapper(
	feed: (inner: AssistantMessageEventStream) => void,
): Promise<{ events: AssistantMessageEvent[]; result: AssistantMessage }> {
	const inner = new AssistantMessageEventStream();
	const out = wrapLeakedThinkingStream(inner);
	feed(inner);
	const events: AssistantMessageEvent[] = [];
	for await (const event of out) events.push(event);
	const result = await out.result();
	return { events, result };
}

function texts(message: AssistantMessage): string[] {
	return message.content.filter((b): b is TextContent => b.type === "text").map(b => b.text);
}

function thinks(message: AssistantMessage): ThinkingContent[] {
	return message.content.filter((b): b is ThinkingContent => b.type === "thinking");
}

type ToolSnapshot = {
	type: "toolcall_start" | "toolcall_delta" | "toolcall_end";
	id: string;
	name: string;
	arguments: Record<string, unknown>;
	partialJson: string | undefined;
	delta?: string;
};

async function nextToolSnapshot(iterator: AsyncIterator<AssistantMessageEvent>): Promise<ToolSnapshot> {
	for (;;) {
		const next = await iterator.next();
		if (next.done) throw new Error("stream ended before a tool-call event");
		const event = next.value;
		if (event.type !== "toolcall_start" && event.type !== "toolcall_delta" && event.type !== "toolcall_end") {
			continue;
		}
		const block = event.partial.content[event.contentIndex];
		if (block?.type !== "toolCall") throw new Error("tool-call event did not point at a toolCall block");
		return {
			type: event.type,
			id: block.id,
			name: block.name,
			arguments: JSON.parse(JSON.stringify(block.arguments)) as Record<string, unknown>,
			partialJson: getStreamingPartialJson(block),
			...(event.type === "toolcall_delta" ? { delta: event.delta } : {}),
		};
	}
}

withOfficialAnthropicEndpoint();

describe("wrapLeakedThinkingStream", () => {
	async function runLeakedText(chunks: readonly string[]): Promise<{
		events: AssistantMessageEvent[];
		result: AssistantMessage;
	}> {
		let text = "";
		return runWrapper(inner => {
			inner.push({ type: "start", partial: msg() });
			inner.push({ type: "text_start", contentIndex: 0, partial: msg({ content: [{ type: "text", text: "" }] }) });
			for (const chunk of chunks) {
				text += chunk;
				inner.push({
					type: "text_delta",
					contentIndex: 0,
					delta: chunk,
					partial: msg({ content: [{ type: "text", text }] }),
				});
			}
			inner.push({
				type: "text_end",
				contentIndex: 0,
				content: text,
				partial: msg({ content: [{ type: "text", text }] }),
			});
			inner.push({ type: "done", reason: "stop", message: msg({ content: [{ type: "text", text }] }) });
		});
	}

	it("splits a leaked fence into structured blocks live during streaming", async () => {
		const leaked = "Visible before.```thinking\nplan\n```Visible after.";
		const { events, result } = await runWrapper(inner => {
			inner.push({ type: "start", partial: msg() });
			inner.push({ type: "text_start", contentIndex: 0, partial: msg({ content: [{ type: "text", text: "" }] }) });
			inner.push({
				type: "text_delta",
				contentIndex: 0,
				delta: leaked,
				partial: msg({ content: [{ type: "text", text: leaked }] }),
			});
			inner.push({
				type: "text_end",
				contentIndex: 0,
				content: leaked,
				partial: msg({ content: [{ type: "text", text: leaked }] }),
			});
			inner.push({ type: "done", reason: "stop", message: msg({ content: [{ type: "text", text: leaked }] }) });
		});

		expect(result.content.map(b => b.type)).toEqual(["text", "thinking", "text"]);
		expect(texts(result)).toEqual(["Visible before.", "Visible after."]);
		expect(thinks(result).map(b => b.thinking)).toEqual(["plan\n"]);
		// The split happened live, not only in the terminal message.
		expect(events.some(e => e.type === "thinking_delta")).toBe(true);
	});

	for (const { name, chunks } of [
		{
			name: "whole chunk",
			chunks: ["Intro.```thinking\nPlan:\n```rs\nfn main() {}\n```\nThen decide.\n```Visible after"],
		},
		{
			name: "character stream",
			chunks: [..."Intro.```thinking\nPlan:\n```rs\nfn main() {}\n```\nThen decide.\n```Visible after"],
		},
	]) {
		it(`keeps nested Markdown fences inside leaked thinking in ${name}`, async () => {
			const { events, result } = await runLeakedText(chunks);
			expect(result.content.map(b => b.type)).toEqual(["text", "thinking", "text"]);
			expect(texts(result)).toEqual(["Intro.", "Visible after"]);
			expect(thinks(result).map(b => b.thinking)).toEqual(["Plan:\n```rs\nfn main() {}\n```\nThen decide.\n"]);
			expect(texts(result).join("")).not.toContain("fn main");
			expect(events.some(e => e.type === "thinking_delta")).toBe(true);
		});
	}

	for (const { suffix, visible } of [
		{ suffix: "Visible after", visible: "Visible after" },
		{ suffix: " after", visible: " after" },
		{ suffix: "Done", visible: "Done" },
	]) {
		for (const { name, chunks } of [
			{ name: "whole chunk", chunks: [`\`\`\`thinking\nplan\n\`\`\`${suffix}`] },
			{ name: "character stream", chunks: [...`\`\`\`thinking\nplan\n\`\`\`${suffix}`] },
		]) {
			it(`treats leaked inline close plus ${JSON.stringify(suffix)} as visible reply in ${name}`, async () => {
				const { result } = await runLeakedText(chunks);
				expect(result.content.map(b => b.type)).toEqual(["thinking", "text"]);
				expect(thinks(result).map(b => b.thinking)).toEqual(["plan\n"]);
				expect(texts(result)).toEqual([visible]);
			});
		}
	}

	// DeepSeek-R1 / Qwen3-Thinking chat templates prefill `<think>` into the
	// prompt, so a host that does not split reasoning into its own field streams
	// `reasoning</think>answer`: the healer sees no opener and the whole chain of
	// thought used to land in the visible answer with a stray `</think>`.
	describe("implied-open reasoning (template-prefilled `<think>`)", () => {
		for (const { name, chunks } of [
			{ name: "whole chunk", chunks: ["Let me think. 2 plus 2.\n</think>\n\nThe answer is 4."] },
			{ name: "character stream", chunks: [..."Let me think. 2 plus 2.\n</think>\n\nThe answer is 4."] },
			{ name: "close split across deltas", chunks: ["Let me think. 2 plus 2.\n</th", "ink>\n\nThe answer is 4."] },
		]) {
			it(`re-projects the leading text as a closed thinking block in ${name}`, async () => {
				const { events, result } = await runLeakedText(chunks);
				expect(result.content.map(b => b.type)).toEqual(["thinking", "text"]);
				expect(thinks(result).map(b => b.thinking)).toEqual(["Let me think. 2 plus 2.\n"]);
				expect(texts(result)).toEqual(["\n\nThe answer is 4."]);

				// Wire contract for event-replaying consumers: the text block at index 0
				// is closed, then replaced in place by a thinking block carrying the
				// full reasoning, and the answer opens a fresh text block at index 1.
				const boundary = events.findIndex(e => e.type === "thinking_start");
				expect(boundary).toBeGreaterThan(0);
				const [textEnd, thinkingStart, thinkingDelta, thinkingEnd, answerStart] = events.slice(boundary - 1);
				expect(textEnd).toMatchObject({ type: "text_end", contentIndex: 0, content: "Let me think. 2 plus 2.\n" });
				expect(thinkingStart).toMatchObject({ type: "thinking_start", contentIndex: 0 });
				expect(thinkingStart?.type === "thinking_start" && thinkingStart.partial.content[0]?.type).toBe("thinking");
				expect(thinkingDelta).toMatchObject({
					type: "thinking_delta",
					contentIndex: 0,
					delta: "Let me think. 2 plus 2.\n",
				});
				expect(thinkingEnd).toMatchObject({ type: "thinking_end", contentIndex: 0 });
				expect(answerStart).toMatchObject({ type: "text_start", contentIndex: 1 });
			});
		}

		it("leaves an ordinary answer with no close tag as visible text", async () => {
			const { result } = await runLeakedText(["The answer ", "is 4."]);
			expect(result.content.map(b => b.type)).toEqual(["text"]);
			expect(texts(result)).toEqual(["The answer is 4."]);
		});

		it("keeps a literal close tag inside inline code as visible text", async () => {
			const { result } = await runLeakedText(["Qwen ends reasoning with `</think>` on its own line."]);
			expect(result.content.map(b => b.type)).toEqual(["text"]);
			expect(texts(result)).toEqual(["Qwen ends reasoning with `</think>` on its own line."]);
		});

		it("drops a stray close after an explicit reasoning block instead of re-projecting the answer", async () => {
			const { result } = await runLeakedText(["<think>plan</think>answer</think> more"]);
			expect(result.content.map(b => b.type)).toEqual(["thinking", "text"]);
			expect(thinks(result).map(b => b.thinking)).toEqual(["plan"]);
			expect(texts(result)).toEqual(["answer more"]);
		});

		it("drops a stray close when a native reasoning field already preceded the text", async () => {
			const { result } = await runWrapper(inner => {
				const thinking = { type: "thinking" as const, thinking: "structured reasoning" };
				inner.push({ type: "start", partial: msg() });
				inner.push({ type: "thinking_start", contentIndex: 0, partial: msg({ content: [thinking] }) });
				inner.push({
					type: "thinking_delta",
					contentIndex: 0,
					delta: "structured reasoning",
					partial: msg({ content: [thinking] }),
				});
				inner.push({
					type: "thinking_end",
					contentIndex: 0,
					content: "structured reasoning",
					partial: msg({ content: [thinking] }),
				});
				const text = "answer</think> more";
				inner.push({
					type: "text_start",
					contentIndex: 1,
					partial: msg({ content: [thinking, { type: "text", text: "" }] }),
				});
				inner.push({
					type: "text_delta",
					contentIndex: 1,
					delta: text,
					partial: msg({ content: [thinking, { type: "text", text }] }),
				});
				inner.push({
					type: "done",
					reason: "stop",
					message: msg({ content: [thinking, { type: "text", text }] }),
				});
			});
			expect(result.content.map(b => b.type)).toEqual(["thinking", "text"]);
			expect(thinks(result).map(b => b.thinking)).toEqual(["structured reasoning"]);
			expect(texts(result)).toEqual(["answer more"]);
		});

		it("drops the close of an empty prefilled block without inventing a thinking block", async () => {
			const { result } = await runLeakedText(["\n</think>\n", "The answer is 4."]);
			expect(result.content.map(b => b.type)).toEqual(["text"]);
			expect(texts(result)).toEqual(["\n\nThe answer is 4."]);
		});
	});

	it("preserves text, thinking, and tool-call signatures across the split", async () => {
		const leaked = "before ```thinking\nhmm\n``` after";
		const call: ToolCall = {
			type: "toolCall",
			id: "call_1",
			name: "read",
			arguments: { path: "x" },
			thoughtSignature: "tsig",
		};
		const { result } = await runWrapper(inner => {
			inner.push({ type: "start", partial: msg() });
			inner.push({
				type: "text_start",
				contentIndex: 0,
				partial: msg({ content: [{ type: "text", text: "", textSignature: "sig" }] }),
			});
			inner.push({
				type: "text_delta",
				contentIndex: 0,
				delta: leaked,
				partial: msg({ content: [{ type: "text", text: leaked, textSignature: "sig" }] }),
			});
			const withCall = msg({
				content: [{ type: "text", text: leaked, textSignature: "sig" }, call],
				stopReason: "toolUse",
			});
			inner.push({ type: "toolcall_start", contentIndex: 1, partial: withCall });
			inner.push({ type: "toolcall_end", contentIndex: 1, toolCall: call, partial: withCall });
			inner.push({ type: "done", reason: "toolUse", message: withCall });
		});

		const textBlocks = result.content.filter((b): b is TextContent => b.type === "text");
		expect(textBlocks.map(b => b.text)).toEqual(["before ", " after"]);
		expect(textBlocks.map(b => b.textSignature)).toEqual(["sig", "sig"]);
		// Healed (leaked) thinking carries no signature.
		expect(thinks(result).every(b => b.thinkingSignature === undefined)).toBe(true);
		const calls = result.content.filter((b): b is ToolCall => b.type === "toolCall");
		expect(calls[0]?.thoughtSignature).toBe("tsig");
	});

	it("captures a native thinking signature delivered at thinking_end, not on the delta", async () => {
		// Anthropic sends thinking_delta first (no signature), then signature_delta,
		// so the completed signature only appears on the thinking_end partial.
		const signature = `SIG_${"x".repeat(400)}`;
		const { result } = await runWrapper(inner => {
			inner.push({ type: "start", partial: msg() });
			inner.push({
				type: "thinking_delta",
				contentIndex: 0,
				delta: "reason",
				partial: msg({ content: [{ type: "thinking", thinking: "reason", thinkingSignature: "" }] }),
			});
			const signed = msg({ content: [{ type: "thinking", thinking: "reason", thinkingSignature: signature }] });
			inner.push({ type: "thinking_end", contentIndex: 0, content: "reason", partial: signed });
			inner.push({ type: "done", reason: "stop", message: signed });
		});

		expect(thinks(result).map(b => b.thinkingSignature)).toEqual([signature]);
	});

	it("emits a late native thinking signature by source index after later blocks start", async () => {
		const firstSignature = "sig-first";
		const secondSignature = "sig-second";
		const call: ToolCall = {
			type: "toolCall",
			id: "call_between_thinking",
			name: "read",
			arguments: { path: "x" },
		};
		const first = { type: "thinking" as const, thinking: "first", thinkingSignature: "" };
		const second = { type: "thinking" as const, thinking: "second", thinkingSignature: "" };
		const { events, result } = await runWrapper(inner => {
			inner.push({ type: "start", partial: msg() });
			inner.push({
				type: "thinking_delta",
				contentIndex: 0,
				delta: first.thinking,
				partial: msg({ content: [first] }),
			});
			const withCall = msg({ content: [first, call] });
			inner.push({ type: "toolcall_start", contentIndex: 1, partial: withCall });
			inner.push({ type: "toolcall_end", contentIndex: 1, toolCall: call, partial: withCall });
			inner.push({
				type: "thinking_delta",
				contentIndex: 2,
				delta: second.thinking,
				partial: msg({ content: [first, call, second] }),
			});
			const firstSigned = {
				...first,
				thinkingSignature: firstSignature,
			};
			const secondSigned = {
				...second,
				thinkingSignature: secondSignature,
			};
			inner.push({
				type: "thinking_end",
				contentIndex: 0,
				content: first.thinking,
				partial: msg({ content: [firstSigned, call, second] }),
			});
			const signed = msg({ content: [firstSigned, call, secondSigned] });
			inner.push({ type: "thinking_end", contentIndex: 2, content: second.thinking, partial: signed });
			inner.push({ type: "done", reason: "stop", message: signed });
		});

		const firstEnd = events.find(event => event.type === "thinking_end" && event.contentIndex === 0);
		if (firstEnd?.type !== "thinking_end") throw new Error("Missing first projected thinking_end");
		expect(firstEnd.partial.content[firstEnd.contentIndex]).toEqual({
			type: "thinking",
			thinking: first.thinking,
			thinkingSignature: firstSignature,
		});
		expect(events.indexOf(firstEnd)).toBeGreaterThan(events.findIndex(event => event.type === "toolcall_start"));
		expect(events.filter(event => event.type === "thinking_end" && event.contentIndex === 0)).toHaveLength(1);
		expect(thinks(result).map(block => [block.thinking, block.thinkingSignature])).toEqual([
			["first", firstSignature],
			["second", secondSignature],
		]);
	});
	it("projects a signature-only thinking block that streamed no deltas before its tool call", async () => {
		// OpenRouter's Responses translation of Gemini thought signatures: a
		// text-less reasoning item opens and closes with only a signature at
		// output_item.done, immediately before the function call it signs.
		const signature = JSON.stringify({
			id: "Lg2okuAw",
			type: "reasoning",
			summary: [],
			encrypted_content: "ErgLCrULARFNMg9buQ",
			format: "google-gemini-v1",
		});
		const call: ToolCall = {
			type: "toolCall",
			id: "Lg2okuAw|fc_tmp_s3divb08p1a",
			name: "lookup_population",
			arguments: { city: "Paris" },
		};
		const signedBlock = { type: "thinking" as const, thinking: "", thinkingSignature: signature };
		const { events, result } = await runWrapper(inner => {
			inner.push({ type: "start", partial: msg() });
			const withBlock = msg({ content: [signedBlock] });
			inner.push({ type: "thinking_end", contentIndex: 0, content: "", partial: withBlock });
			const withCall = msg({ content: [signedBlock, call] });
			inner.push({ type: "toolcall_start", contentIndex: 1, partial: withCall });
			inner.push({ type: "toolcall_end", contentIndex: 1, toolCall: call, partial: withCall });
			inner.push({
				type: "done",
				reason: "toolUse",
				message: msg({ content: [signedBlock, call], stopReason: "toolUse" }),
			});
		});

		expect(result.content.map(b => b.type)).toEqual(["thinking", "toolCall"]);
		expect(thinks(result).map(b => [b.thinking, b.thinkingSignature])).toEqual([["", signature]]);
		// The signature block must be projected before the function call it signs.
		const thinkingEnd = events.findIndex(event => event.type === "thinking_end");
		const toolStart = events.findIndex(event => event.type === "toolcall_start");
		expect(thinkingEnd).toBeGreaterThanOrEqual(0);
		expect(thinkingEnd).toBeLessThan(toolStart);
	});

	it("preserves complete Anthropic web-search history at its source positions", async () => {
		const firstThinking = { type: "thinking" as const, thinking: "choose source", thinkingSignature: "sig-1" };
		const serverBlocks: AnthropicServerToolContent[] = [
			{
				type: "anthropicServerTool",
				block: {
					type: "server_tool_use",
					id: "srvtoolu_search",
					name: "web_search",
					input: { query: "current UTC date", nested: { source: "authoritative" } },
				},
			},
			{
				type: "anthropicServerTool",
				block: {
					type: "web_search_tool_result",
					tool_use_id: "srvtoolu_search",
					content: [
						{
							type: "web_search_result",
							url: "https://example.test/date",
							encrypted_content: "opaque-ciphertext",
						},
					],
				},
			},
		];
		const secondThinking = { type: "thinking" as const, thinking: "use result", thinkingSignature: "sig-2" };
		const call: ToolCall = {
			type: "toolCall",
			id: "toolu_write",
			name: "write",
			arguments: { path: "date.txt", content: "2026-07-26" },
		};
		const content: AssistantMessage["content"] = [firstThinking, ...serverBlocks, secondThinking, call];

		const { result } = await runWrapper(inner => {
			inner.push({ type: "start", partial: msg() });
			inner.push({
				type: "thinking_delta",
				contentIndex: 0,
				delta: firstThinking.thinking,
				partial: msg({ content: [firstThinking] }),
			});
			inner.push({
				type: "thinking_end",
				contentIndex: 0,
				content: firstThinking.thinking,
				partial: msg({ content: [firstThinking] }),
			});
			inner.push({
				type: "thinking_delta",
				contentIndex: 3,
				delta: secondThinking.thinking,
				partial: msg({ content: content.slice(0, 4) }),
			});
			inner.push({
				type: "thinking_end",
				contentIndex: 3,
				content: secondThinking.thinking,
				partial: msg({ content: content.slice(0, 4) }),
			});
			const terminal = msg({ content, stopReason: "toolUse" });
			inner.push({ type: "toolcall_start", contentIndex: 4, partial: terminal });
			inner.push({ type: "toolcall_end", contentIndex: 4, toolCall: call, partial: terminal });
			inner.push({ type: "done", reason: "toolUse", message: terminal });
		});

		expect(result.content).toEqual(content);
		expect(result.content.slice(1, 3)).toEqual(serverBlocks);
	});

	it("preserves complete Anthropic tool-search history through the custom-endpoint projector", async () => {
		const firstThinking: ThinkingContent = {
			type: "thinking",
			thinking: "find the deferred tool",
			thinkingSignature: "sig-1",
		};
		const serverBlocks: AnthropicServerToolContent[] = [
			{
				type: "anthropicServerTool",
				block: {
					type: "server_tool_use",
					id: "srvtoolu_search",
					name: "tool_search_tool_regex",
					input: { pattern: "read" },
				},
			},
			{
				type: "anthropicServerTool",
				block: {
					type: "tool_search_tool_result",
					tool_use_id: "srvtoolu_search",
					content: {
						type: "tool_search_tool_search_result",
						tool_references: [{ type: "tool_reference", tool_name: "_read" }],
					},
				},
			},
		];
		const secondThinking: ThinkingContent = {
			type: "thinking",
			thinking: "use the discovered tool",
			thinkingSignature: "sig-2",
		};
		const call: ToolCall = {
			type: "toolCall",
			id: "toolu_read",
			name: "_read",
			arguments: { path: "notes.txt" },
		};
		const content: AssistantMessage["content"] = [firstThinking, ...serverBlocks, secondThinking, call];
		const terminal = msg({ content, stopReason: "toolUse" });

		const { result } = await runWrapper(inner => {
			inner.push({ type: "start", partial: msg() });
			inner.push({ type: "toolcall_start", contentIndex: 4, partial: terminal });
			inner.push({ type: "toolcall_end", contentIndex: 4, toolCall: call, partial: terminal });
			inner.push({ type: "done", reason: "toolUse", message: terminal });
		});

		expect(result.content).toEqual(content);
	});

	it("drops incomplete Anthropic web-search history instead of replaying orphan blocks", async () => {
		const content: AssistantMessage["content"] = [
			{
				type: "anthropicServerTool",
				block: {
					type: "server_tool_use",
					id: "srvtoolu_unmatched_call",
					name: "web_search",
					input: { query: "orphan call" },
				},
			},
			{
				type: "anthropicServerTool",
				block: {
					type: "web_search_tool_result",
					tool_use_id: "srvtoolu_unmatched_result",
					content: [],
				},
			},
			{ type: "text", text: "safe terminal text" },
		];
		const { result } = await runWrapper(inner => {
			inner.push({ type: "start", partial: msg() });
			inner.push({ type: "done", reason: "stop", message: msg({ content }) });
		});

		expect(result.content).toEqual([{ type: "text", text: "safe terminal text" }]);
	});

	it("recovers a signature-bearing thinking block that emitted no per-block events", async () => {
		const signature = JSON.stringify({ id: "rs_1", type: "reasoning", encrypted_content: "abc" });
		const block = { type: "thinking" as const, thinking: "recovered reasoning", thinkingSignature: signature };
		const { result } = await runWrapper(inner => {
			inner.push({ type: "start", partial: msg() });
			inner.push({ type: "done", reason: "stop", message: msg({ content: [block] }) });
		});

		expect(thinks(result).map(b => [b.thinking, b.thinkingSignature])).toEqual([["recovered reasoning", signature]]);
	});

	it("preserves native tool-call ids and streamed partial JSON while healing", async () => {
		const inner = new AssistantMessageEventStream();
		const out = wrapLeakedThinkingStream(inner);
		const iterator = out[Symbol.asyncIterator]();
		const call: ToolCall = {
			type: "toolCall",
			id: "toolu_real",
			name: "Bash",
			arguments: {},
		};
		setStreamingPartialJson(call, "");
		const partial = msg({ content: [call], stopReason: "toolUse" });
		inner.push({ type: "start", partial });

		const startPromise = nextToolSnapshot(iterator);
		inner.push({ type: "toolcall_start", contentIndex: 0, partial });
		const start = await startPromise;

		setStreamingPartialJson(call, '{"command":"echo hi');
		const deltaPromise = nextToolSnapshot(iterator);
		inner.push({
			type: "toolcall_delta",
			contentIndex: 0,
			delta: '{"command":"echo hi',
			partial,
		});
		const delta = await deltaPromise;

		call.arguments = { command: "echo hi" };
		setStreamingPartialJson(call, '{"command":"echo hi"}');
		const endPromise = nextToolSnapshot(iterator);
		inner.push({ type: "toolcall_end", contentIndex: 0, toolCall: call, partial });
		const end = await endPromise;
		inner.push({ type: "done", reason: "toolUse", message: partial });
		await out.result();

		expect([start, delta, end]).toEqual([
			{
				type: "toolcall_start",
				id: "toolu_real",
				name: "Bash",
				arguments: {},
				partialJson: "",
			},
			{
				type: "toolcall_delta",
				id: "toolu_real",
				name: "Bash",
				arguments: {},
				partialJson: '{"command":"echo hi',
				delta: '{"command":"echo hi',
			},
			{
				type: "toolcall_end",
				id: "toolu_real",
				name: "Bash",
				arguments: { command: "echo hi" },
				partialJson: '{"command":"echo hi"}',
			},
		]);
	});

	it("heals a fence that only appears in the terminal message (no prior text deltas)", async () => {
		const leaked = "Intro.```thinking\nquiet\n```Outro.";
		const { result } = await runWrapper(inner => {
			inner.push({ type: "start", partial: msg() });
			inner.push({
				type: "done",
				reason: "stop",
				message: msg({ content: [{ type: "text", text: leaked, textSignature: "sig" }] }),
			});
		});

		expect(result.content.map(b => b.type)).toEqual(["text", "thinking", "text"]);
		expect(texts(result)).toEqual(["Intro.", "Outro."]);
		// Tail-replayed text still carries the source signature.
		expect(result.content.filter((b): b is TextContent => b.type === "text").map(b => b.textSignature)).toEqual([
			"sig",
			"sig",
		]);
	});

	it("resets terminal text signatures at source block boundaries", async () => {
		const content: AssistantMessage["content"] = [
			{ type: "text", text: "signed text", textSignature: "sig-1" },
			{ type: "text", text: "unsigned text" },
		];
		const { result } = await runWrapper(inner => {
			inner.push({ type: "start", partial: msg() });
			inner.push({ type: "done", reason: "stop", message: msg({ content }) });
		});

		expect(result.content).toEqual(content);
	});

	it("passes clean text through unchanged and forwards native thinking", async () => {
		const clean = "Just a normal answer.";
		const cleanRun = await runWrapper(inner => {
			inner.push({ type: "start", partial: msg() });
			inner.push({ type: "text_start", contentIndex: 0, partial: msg({ content: [{ type: "text", text: "" }] }) });
			inner.push({
				type: "text_delta",
				contentIndex: 0,
				delta: clean,
				partial: msg({ content: [{ type: "text", text: clean }] }),
			});
			inner.push({ type: "done", reason: "stop", message: msg({ content: [{ type: "text", text: clean }] }) });
		});
		expect(cleanRun.result.content.map(b => b.type)).toEqual(["text"]);
		expect(texts(cleanRun.result)).toEqual([clean]);

		const nativeThinking = msg({
			content: [
				{ type: "thinking", thinking: "native reasoning", thinkingSignature: "tk" },
				{ type: "text", text: "answer" },
			],
		});
		const nativeRun = await runWrapper(inner => {
			inner.push({ type: "start", partial: msg() });
			inner.push({
				type: "thinking_start",
				contentIndex: 0,
				partial: msg({ content: [{ type: "thinking", thinking: "" }] }),
			});
			inner.push({
				type: "thinking_delta",
				contentIndex: 0,
				delta: "native reasoning",
				partial: msg({ content: [{ type: "thinking", thinking: "native reasoning", thinkingSignature: "tk" }] }),
			});
			inner.push({
				type: "thinking_end",
				contentIndex: 0,
				content: "native reasoning",
				partial: msg({ content: [{ type: "thinking", thinking: "native reasoning", thinkingSignature: "tk" }] }),
			});
			inner.push({ type: "text_start", contentIndex: 1, partial: nativeThinking });
			inner.push({ type: "text_delta", contentIndex: 1, delta: "answer", partial: nativeThinking });
			inner.push({ type: "done", reason: "stop", message: nativeThinking });
		});
		expect(nativeRun.result.content.map(b => b.type)).toEqual(["thinking", "text"]);
		expect(thinks(nativeRun.result)[0]?.thinking).toBe("native reasoning");
		expect(thinks(nativeRun.result)[0]?.thinkingSignature).toBe("tk");
		expect(texts(nativeRun.result)).toEqual(["answer"]);
	});

	it("heals a terminal error message and keeps its error stop reason", async () => {
		const leaked = "Partial.```thinking\noops\n```Recovered.";
		const { result } = await runWrapper(inner => {
			inner.push({ type: "start", partial: msg() });
			inner.push({
				type: "error",
				reason: "error",
				error: msg({ content: [{ type: "text", text: leaked }], stopReason: "error" }),
			});
		});

		expect(result.content.map(b => b.type)).toEqual(["text", "thinking", "text"]);
		expect(texts(result)).toEqual(["Partial.", "Recovered."]);
		expect(result.stopReason).toBe("error");
	});
});

describe("leaked thinking healing through stream()", () => {
	function sseFrame(event: string, data: unknown): string {
		return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
	}

	function anthropicLeakFetch(text: string): FetchImpl {
		const body = [
			sseFrame("message_start", {
				type: "message_start",
				message: { id: "msg_leak", usage: { input_tokens: 5, output_tokens: 0 } },
			}),
			sseFrame("content_block_start", {
				type: "content_block_start",
				index: 0,
				content_block: { type: "text", text: "" },
			}),
			sseFrame("content_block_delta", {
				type: "content_block_delta",
				index: 0,
				delta: { type: "text_delta", text },
			}),
			sseFrame("content_block_stop", { type: "content_block_stop", index: 0 }),
			sseFrame("message_delta", {
				type: "message_delta",
				delta: { stop_reason: "end_turn" },
				usage: { input_tokens: 5, output_tokens: 4 },
			}),
			sseFrame("message_stop", { type: "message_stop" }),
		].join("");
		const fn = async (_input: string | URL | Request, _init?: RequestInit): Promise<Response> =>
			new Response(body, {
				status: 200,
				headers: { "content-type": "text/event-stream", "request-id": "req_mock" },
			});
		return Object.assign(fn, { preconnect: fetch.preconnect });
	}

	function anthropicThinkingFetch(): FetchImpl {
		const body = [
			sseFrame("message_start", {
				type: "message_start",
				message: { id: "msg_thinking_prefix", usage: { input_tokens: 5, output_tokens: 0 } },
			}),
			sseFrame("content_block_start", {
				type: "content_block_start",
				index: 0,
				content_block: { type: "thinking", thinking: "Summary prefix" },
			}),
			sseFrame("content_block_delta", {
				type: "content_block_delta",
				index: 0,
				delta: { type: "thinking_delta", thinking: " summary tail" },
			}),
			sseFrame("content_block_delta", {
				type: "content_block_delta",
				index: 0,
				delta: { type: "signature_delta", signature: "sig_thinking" },
			}),
			sseFrame("content_block_stop", { type: "content_block_stop", index: 0 }),
			sseFrame("message_delta", {
				type: "message_delta",
				delta: { stop_reason: "end_turn" },
				usage: { input_tokens: 5, output_tokens: 4 },
			}),
			sseFrame("message_stop", { type: "message_stop" }),
		].join("");
		const fn = async (_input: string | URL | Request, _init?: RequestInit): Promise<Response> =>
			new Response(body, {
				status: 200,
				headers: { "content-type": "text/event-stream", "request-id": "req_thinking_prefix" },
			});
		return Object.assign(fn, { preconnect: fetch.preconnect });
	}

	function anthropicModel(overrides: Partial<Model<"anthropic-messages">> = {}): Model<"anthropic-messages"> {
		return buildModel({
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
			...overrides,
		});
	}

	const leaked = "```thinking\nDeliberate.\n```\nFinal answer.";
	const context: Context = { messages: [{ role: "user", content: "hi", timestamp: Date.now() }] };

	/** OpenAI-compatible SSE whose `content` deltas carry the given strings, then `[DONE]`. */
	function completionsContentFetch(deltas: readonly string[]): FetchImpl {
		const chunk = (delta: Record<string, unknown>, finish: string | null = null): string =>
			`data: ${JSON.stringify({
				id: "chatcmpl-prefill",
				object: "chat.completion.chunk",
				created: 0,
				model: "qwen3-thinking",
				choices: [{ index: 0, delta, finish_reason: finish }],
			})}\n\n`;
		const body = [
			chunk({ role: "assistant", content: "" }),
			...deltas.map(content => chunk({ content })),
			chunk({}, "stop"),
			"data: [DONE]\n\n",
		].join("");
		const fn = async (_input: string | URL | Request, _init?: RequestInit): Promise<Response> =>
			new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
		return Object.assign(fn, { preconnect: fetch.preconnect });
	}

	// A local host serving a template that prefills `<think>` (DeepSeek-R1,
	// Qwen3-Thinking) without splitting reasoning into a field streams the chain
	// of thought inline, terminated only by `</think>`. Issue #10571's shape.
	it("recovers template-prefilled reasoning from a local openai-completions host", async () => {
		const model = buildModel({
			id: "qwen3-thinking",
			name: "Qwen3 Thinking",
			api: "openai-completions",
			provider: "localai",
			baseUrl: "http://localhost:8080/v1",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 32_000,
			maxTokens: 8_192,
		});
		const result = await stream(model, context, {
			apiKey: "test",
			fetch: completionsContentFetch(["Let me think.", " 2 plus 2.\n</th", "ink>\n\nThe answer is 4."]),
		}).result();

		expect(result.content.map(b => b.type)).toEqual(["thinking", "text"]);
		expect(thinks(result).map(b => b.thinking)).toEqual(["Let me think. 2 plus 2.\n"]);
		expect(texts(result).join("").trim()).toBe("The answer is 4.");
	});

	it("leaves a leaked fence intact for the official Anthropic API", async () => {
		// Official first-party endpoints return structured thinking and are exempt
		// from the central healer, so a leaked fence must stay verbatim visible text.
		const result = await stream(anthropicModel(), context, {
			apiKey: "test",
			fetch: anthropicLeakFetch(leaked),
		}).result();

		expect(result.content.map(b => b.type)).toEqual(["text"]);
		expect(thinks(result)).toHaveLength(0);
		expect(texts(result).join("")).toBe(leaked);
	});

	it("splits a leaked fence for a non-official anthropic-messages endpoint", async () => {
		// A third-party gateway reusing the anthropic-messages wire format may leak,
		// so the central wrapper still heals when the endpoint is not official.
		const result = await stream(
			anthropicModel({ provider: "zai", baseUrl: "https://api.z.ai/api/anthropic" }),
			context,
			{
				apiKey: "test",
				fetch: anthropicLeakFetch(leaked),
			},
		).result();

		expect(result.content.map(b => b.type)).toEqual(["thinking", "text"]);
		const thinking = thinks(result)
			.map(b => b.thinking)
			.join("");
		expect(thinking).toContain("Deliberate.");
		expect(texts(result).join("").trim()).toBe("Final answer.");
	});

	it("preserves thinking bytes from content_block_start through a non-official endpoint", async () => {
		const result = await stream(
			anthropicModel({ provider: "zai", baseUrl: "https://api.z.ai/api/anthropic" }),
			context,
			{
				apiKey: "test",
				fetch: anthropicThinkingFetch(),
			},
		).result();

		expect(thinks(result)).toEqual([
			{
				type: "thinking",
				thinking: "Summary prefix summary tail",
				thinkingSignature: "sig_thinking",
			},
		]);
	});

	it("replays native web-search history on a custom Anthropic continuation", async () => {
		const searchResult = {
			type: "web_search_tool_result",
			tool_use_id: "srvtoolu_1",
			content: [
				{
					type: "web_search_result",
					url: "https://example.test/date",
					title: "UTC date",
					encrypted_content: "opaque-search-result",
				},
			],
		};
		const nativeSearchResponse = [
			sseFrame("message_start", {
				type: "message_start",
				message: { id: "msg_native_search", usage: { input_tokens: 12, output_tokens: 0 } },
			}),
			sseFrame("content_block_start", {
				type: "content_block_start",
				index: 0,
				content_block: { type: "thinking", thinking: "" },
			}),
			sseFrame("content_block_delta", {
				type: "content_block_delta",
				index: 0,
				delta: { type: "thinking_delta", thinking: "Choose an authoritative source." },
			}),
			sseFrame("content_block_delta", {
				type: "content_block_delta",
				index: 0,
				delta: { type: "signature_delta", signature: "sig-1" },
			}),
			sseFrame("content_block_stop", { type: "content_block_stop", index: 0 }),
			sseFrame("content_block_start", {
				type: "content_block_start",
				index: 1,
				content_block: { type: "server_tool_use", id: "srvtoolu_1", name: "web_search" },
			}),
			sseFrame("content_block_delta", {
				type: "content_block_delta",
				index: 1,
				delta: { type: "input_json_delta", partial_json: '{"query":"current UTC date"}' },
			}),
			sseFrame("content_block_stop", { type: "content_block_stop", index: 1 }),
			sseFrame("content_block_start", {
				type: "content_block_start",
				index: 2,
				content_block: searchResult,
			}),
			sseFrame("content_block_stop", { type: "content_block_stop", index: 2 }),
			sseFrame("content_block_start", {
				type: "content_block_start",
				index: 3,
				content_block: { type: "thinking", thinking: "" },
			}),
			sseFrame("content_block_delta", {
				type: "content_block_delta",
				index: 3,
				delta: { type: "thinking_delta", thinking: "Use the result." },
			}),
			sseFrame("content_block_delta", {
				type: "content_block_delta",
				index: 3,
				delta: { type: "signature_delta", signature: "sig-2" },
			}),
			sseFrame("content_block_stop", { type: "content_block_stop", index: 3 }),
			sseFrame("content_block_start", {
				type: "content_block_start",
				index: 4,
				content_block: { type: "text", text: "" },
			}),
			sseFrame("content_block_delta", {
				type: "content_block_delta",
				index: 4,
				delta: { type: "text_delta", text: "Writing the date." },
			}),
			sseFrame("content_block_stop", { type: "content_block_stop", index: 4 }),
			sseFrame("content_block_start", {
				type: "content_block_start",
				index: 5,
				content_block: { type: "tool_use", id: "toolu_write", name: "write", input: {} },
			}),
			sseFrame("content_block_delta", {
				type: "content_block_delta",
				index: 5,
				delta: { type: "input_json_delta", partial_json: '{"path":"date.txt","content":"2026-07-26"}' },
			}),
			sseFrame("content_block_stop", { type: "content_block_stop", index: 5 }),
			sseFrame("message_delta", {
				type: "message_delta",
				delta: { stop_reason: "tool_use" },
				usage: {
					input_tokens: 12,
					output_tokens: 20,
					server_tool_use: { web_search_requests: 1 },
				},
			}),
			sseFrame("message_stop", { type: "message_stop" }),
		].join("");
		const continuationResponse = [
			sseFrame("message_start", {
				type: "message_start",
				message: { id: "msg_continuation", usage: { input_tokens: 30, output_tokens: 0 } },
			}),
			sseFrame("content_block_start", {
				type: "content_block_start",
				index: 0,
				content_block: { type: "text", text: "" },
			}),
			sseFrame("content_block_delta", {
				type: "content_block_delta",
				index: 0,
				delta: { type: "text_delta", text: "DONE" },
			}),
			sseFrame("content_block_stop", { type: "content_block_stop", index: 0 }),
			sseFrame("message_delta", {
				type: "message_delta",
				delta: { stop_reason: "end_turn" },
				usage: { input_tokens: 30, output_tokens: 1 },
			}),
			sseFrame("message_stop", { type: "message_stop" }),
		].join("");
		let requestCount = 0;
		let continuationRequest: unknown;
		const customFetch = Object.assign(
			async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
				requestCount++;
				if (requestCount === 2) {
					if (typeof init?.body !== "string") throw new Error("Expected JSON request body");
					continuationRequest = JSON.parse(init.body);
				}
				return new Response(requestCount === 1 ? nativeSearchResponse : continuationResponse, {
					status: 200,
					headers: { "content-type": "text/event-stream", "request-id": `req_${requestCount}` },
				});
			},
			{ preconnect: fetch.preconnect },
		);
		const customModel = anthropicModel({
			provider: "anthropic",
			baseUrl: "https://anthropic-proxy.example.test/v1",
		});
		const first = await stream(customModel, context, { apiKey: "test", fetch: customFetch }).result();
		expect(first.content.map(block => block.type)).toEqual([
			"thinking",
			"anthropicServerTool",
			"anthropicServerTool",
			"thinking",
			"text",
			"toolCall",
		]);

		const continuedContext: Context = {
			messages: [
				...context.messages,
				first,
				{
					role: "toolResult",
					toolCallId: "toolu_write",
					toolName: "write",
					content: [{ type: "text", text: "Wrote date.txt" }],
					isError: false,
					timestamp: 2,
				},
			],
		};
		await stream(customModel, continuedContext, { apiKey: "test", fetch: customFetch }).result();

		if (
			typeof continuationRequest !== "object" ||
			continuationRequest === null ||
			!("messages" in continuationRequest) ||
			!Array.isArray(continuationRequest.messages)
		) {
			throw new Error("Expected captured Anthropic messages");
		}
		const assistant = continuationRequest.messages.find(
			message =>
				typeof message === "object" && message !== null && "role" in message && message.role === "assistant",
		);
		if (
			typeof assistant !== "object" ||
			assistant === null ||
			!("content" in assistant) ||
			!Array.isArray(assistant.content)
		) {
			throw new Error("Expected captured assistant content");
		}
		const assistantContent: unknown[] = assistant.content;
		expect(
			assistantContent.map(block =>
				typeof block === "object" && block !== null && "type" in block ? block.type : undefined,
			),
		).toEqual(["thinking", "server_tool_use", "web_search_tool_result", "thinking", "text", "tool_use"]);
	});
});
