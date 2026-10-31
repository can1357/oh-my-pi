import { afterEach, describe, expect, it } from "bun:test";
import { clearCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import { createMockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import { streamSimple } from "@oh-my-pi/pi-ai/stream";
import type { AssistantMessage, Context, CursorExecHandlers, ToolCall, ToolResultMessage } from "@oh-my-pi/pi-ai/types";
import { getStreamingPartialJson, setStreamingPartialJson } from "@oh-my-pi/pi-ai/utils/block-symbols";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { applyGlyphCodec, decodeGlyphText, encodeGlyphText } from "@oh-my-pi/pi-ai/utils/glyph-codec";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { PiEditExecArgsSchema, PiEditReplacementSchema } from "@oh-my-pi/pi-catalog/discovery/cursor-proto";
import { create } from "@oh-my-pi/pi-catalog/discovery/protobuf";

const ZERO_USAGE: AssistantMessage["usage"] = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistantMessage(
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "mock",
		provider: "mock",
		model: "mock",
		usage: ZERO_USAGE,
		stopReason,
		timestamp: 0,
	};
}

afterEach(() => {
	clearCustomApis();
});

describe("glyph text codec", () => {
	it("encodes every private-use range boundary and preserves ordinary text", () => {
		expect(encodeGlyphText("\ue000")).toBe("⟦Ue000⟧");
		expect(encodeGlyphText("\uf8ff")).toBe("⟦Uf8ff⟧");
		expect(encodeGlyphText(String.fromCodePoint(0xf0000))).toBe("⟦Uf0000⟧");
		expect(encodeGlyphText(String.fromCodePoint(0x100000))).toBe("⟦U100000⟧");
		const ordinary = "plain Ω text";
		expect(encodeGlyphText(ordinary)).toBe(ordinary);
	});

	it("roundtrips glyphs beside adversarial literal token syntax", () => {
		const glyph = "\ue0a0";
		const astral = String.fromCodePoint(0xf0000);
		const cases = [
			`plain ${glyph}`,
			"literal ⟦Ue0a0⟧",
			"literal ⟦E⟧",
			`bracket ⟦${glyph}`,
			`${glyph}⟦Ue0a0⟧⟦E⟧${astral}`,
		];

		for (const source of cases) {
			expect(decodeGlyphText(encodeGlyphText(source))).toBe(source);
		}
	});

	it("decodes every valid glyph token and preserves invalid codepoints", () => {
		expect(decodeGlyphText("known ⟦Ue0a0⟧ unknown ⟦UE0A1⟧ escape ⟦E⟧ invalid ⟦U110000⟧")).toBe(
			"known \ue0a0 unknown \ue0a1 escape ⟦ invalid ⟦U110000⟧",
		);
	});
});

describe("applyGlyphCodec", () => {
	it("injects one notice at the first changed message without mutating history", () => {
		const glyph = "\ue0a0";
		const context: Context = {
			systemPrompt: ["plain system"],
			messages: [
				{ role: "user", content: "plain first", timestamp: 1 },
				{ role: "user", content: `second ${glyph}`, timestamp: 2 },
				{ role: "user", content: `third ${glyph}`, timestamp: 3 },
			],
		};
		const snapshot = structuredClone(context);
		const first = context.messages[0];
		const second = context.messages[1];
		const codec = applyGlyphCodec(context);

		expect(context).toEqual(snapshot);
		expect(codec.context.messages[0]).toBe(first);
		expect(codec.context.messages[1]).not.toBe(second);
		expect(JSON.stringify(codec.context).match(/<glyph-tokens>/g)).toHaveLength(1);
		const encodedSecond = codec.context.messages[1];
		const encodedThird = codec.context.messages[2];
		if (encodedSecond?.role !== "user" || typeof encodedSecond.content !== "string") {
			throw new Error("expected encoded second user message");
		}
		if (encodedThird?.role !== "user" || typeof encodedThird.content !== "string") {
			throw new Error("expected encoded third user message");
		}
		expect(encodedSecond.content).toContain("second ⟦Ue0a0⟧\n\n<glyph-tokens>");
		expect(encodedThird.content).toBe("third ⟦Ue0a0⟧");
	});

	it("leaves glyph-free paths shared and does not wrap their stream", () => {
		const context: Context = { systemPrompt: ["plain"], messages: [{ role: "user", content: "hi", timestamp: 1 }] };
		const codec = applyGlyphCodec(context);
		const inner = new AssistantMessageEventStream();

		expect(codec.active).toBe(false);
		expect(codec.context).not.toBe(context);
		expect(codec.context.systemPrompt).toBe(context.systemPrompt);
		expect(codec.context.messages).toBe(context.messages);
		expect(codec.wrap(inner)).toBe(inner);
		expect(JSON.stringify(codec.context)).not.toContain("<glyph-tokens>");
	});

	it("normalizes a bare-string systemPrompt from legacy extensions instead of crashing", () => {
		const glyph = "\ue0a0";
		// legacy earendil-works extensions type Context.systemPrompt as `string`
		const context = { systemPrompt: `classify ${glyph}`, messages: [] } as unknown as Context;
		const codec = applyGlyphCodec(context);

		expect(codec.active).toBe(true);
		expect(Array.isArray(codec.context.systemPrompt)).toBe(true);
		const [encoded] = codec.context.systemPrompt ?? [];
		expect(encoded).toContain("⟦Ue0a0⟧");
		expect(decodeGlyphText(encoded ?? "")).toContain(`classify ${glyph}`);
	});

	it("makes a branded reapplication inert", () => {
		const first = applyGlyphCodec({ messages: [{ role: "user", content: "\ue0a0", timestamp: 1 }] });
		const second = applyGlyphCodec(first.context);
		const inner = new AssistantMessageEventStream();

		expect(second.context).toBe(first.context);
		expect(second.active).toBe(false);
		expect(second.wrap(inner)).toBe(inner);
	});

	it("keeps signature-bearing thinking bytes and references untouched", () => {
		const thinking = {
			type: "thinking" as const,
			thinking: "private \ue0a0 ⟦Ue0a0⟧",
			thinkingSignature: "signed-bytes",
		};
		const source = assistantMessage([thinking, { type: "text", text: "visible \ue0a0" }]);
		const codec = applyGlyphCodec({ messages: [source] });
		const encoded = codec.context.messages[0];
		if (encoded?.role !== "assistant") throw new Error("expected assistant history");

		expect(encoded.content[0]).toBe(thinking);
		expect(encoded.content[0]).toEqual(thinking);
		const text = encoded.content[1];
		expect(text?.type === "text" ? text.text : undefined).toContain("visible ⟦Ue0a0⟧");
	});
});

describe("glyph stream decode", () => {
	it("decodes terminal text, nested tool arguments, keys, and partial JSON", async () => {
		const glyph = "\ue0a0";
		const codec = applyGlyphCodec({ messages: [{ role: "user", content: glyph, timestamp: 1 }] });
		const call: ToolCall = {
			type: "toolCall",
			id: "tool-1",
			name: "write",
			arguments: {
				"⟦Ue0a0⟧": ["value ⟦Ue0a0⟧", { nested: "⟦Uefff⟧" }],
			},
		};
		setStreamingPartialJson(call, '{"content":"⟦Ue0a0⟧","bad":"⟦Uefff⟧"}');
		const thinking = { type: "thinking" as const, thinking: "thought ⟦Ue0a0⟧", thinkingSignature: "sig" };
		const message = assistantMessage([{ type: "text", text: "answer ⟦Ue0a0⟧" }, thinking, call], "toolUse");
		const inner = new AssistantMessageEventStream();
		const wrapped = codec.wrap(inner);
		inner.push({ type: "done", reason: "toolUse", message });
		const result = await wrapped.result();

		expect(result).toBe(message);
		const text = result.content[0];
		expect(text?.type === "text" ? text.text : undefined).toBe(`answer ${glyph}`);
		expect(result.content[1]).toBe(thinking);
		expect(thinking.thinking).toBe("thought ⟦Ue0a0⟧");
		const decodedCall = result.content[2];
		if (decodedCall?.type !== "toolCall") throw new Error("expected decoded tool call");
		expect(decodedCall.arguments).toEqual({
			[glyph]: [`value ${glyph}`, { nested: "\uefff" }],
		});
		expect(getStreamingPartialJson(decodedCall)).toBe(`{"content":"${glyph}","bad":"\uefff"}`);
	});

	it("decodes tokens split across text deltas in forwarded deltas and partials", async () => {
		const glyph = String.fromCodePoint(0xf030c);
		const token = encodeGlyphText(glyph);
		const codec = applyGlyphCodec({ messages: [{ role: "user", content: glyph, timestamp: 1 }] });
		// A glyph token, an escaped literal token, and an opener the model never closed.
		const wire = `Goal: ${token} KARA ${encodeGlyphText(token)} ⟦`;
		const expected = `Goal: ${glyph} KARA ${token} ⟦`;
		// Each event carries the provider's partial as of that event.
		const partial = (text: string) => assistantMessage([{ type: "text", text }]);
		const inner = new AssistantMessageEventStream();
		const wrapped = codec.wrap(inner);
		inner.push({ type: "start", partial: partial("") });
		inner.push({ type: "text_start", contentIndex: 0, partial: partial("") });
		let raw = "";
		for (let i = 0; i < wire.length; i += 3) {
			const delta = wire.slice(i, i + 3);
			raw += delta;
			inner.push({ type: "text_delta", contentIndex: 0, delta, partial: partial(raw) });
		}
		inner.push({ type: "text_end", contentIndex: 0, content: raw, partial: partial(raw) });
		inner.push({ type: "done", reason: "stop", message: partial(raw) });

		let streamed = "";
		let ended: string | undefined;
		for await (const event of wrapped) {
			if (event.type === "text_delta") {
				streamed += event.delta;
				const block = event.partial.content[0];
				expect(block?.type === "text" ? block.text : undefined).toBe(streamed);
			} else if (event.type === "text_end") {
				ended = event.content;
			}
		}
		expect(streamed).toBe(expected);
		expect(ended).toBe(expected);
		const final = (await wrapped.result()).content[0];
		expect(final?.type === "text" ? final.text : undefined).toBe(expected);
	});

	it("decodes tokens split across tool-call deltas, previews, and the completed call", async () => {
		const glyph = String.fromCodePoint(0xf030c);
		const token = encodeGlyphText(glyph);
		const codec = applyGlyphCodec({ messages: [{ role: "user", content: glyph, timestamp: 1 }] });
		const wireJson = JSON.stringify({ content: `${token} key` });
		// Each event carries the provider's tool-call block as of that event.
		const call = (json: string | undefined, args: Record<string, unknown> = {}): ToolCall => {
			const block: ToolCall = { type: "toolCall", id: "tool-1", name: "write", arguments: args };
			if (json !== undefined) setStreamingPartialJson(block, json);
			return block;
		};
		const partial = (block: ToolCall) => assistantMessage([block], "toolUse");
		const inner = new AssistantMessageEventStream();
		const wrapped = codec.wrap(inner);
		inner.push({ type: "start", partial: partial(call("")) });
		inner.push({ type: "toolcall_start", contentIndex: 0, partial: partial(call("")) });
		let json = "";
		for (let i = 0; i < wireJson.length; i += 4) {
			const delta = wireJson.slice(i, i + 4);
			json += delta;
			inner.push({ type: "toolcall_delta", contentIndex: 0, delta, partial: partial(call(json)) });
		}
		const completedCall = call(undefined, JSON.parse(json));
		inner.push({ type: "toolcall_end", contentIndex: 0, toolCall: completedCall, partial: partial(completedCall) });
		inner.push({ type: "done", reason: "toolUse", message: partial(completedCall) });

		let streamed = "";
		let completed: ToolCall | undefined;
		for await (const event of wrapped) {
			if (event.type === "toolcall_delta") {
				streamed += event.delta;
				const preview = event.partial.content[0];
				expect(preview?.type === "toolCall" ? getStreamingPartialJson(preview) : undefined).not.toContain(token);
			} else if (event.type === "toolcall_end") {
				completed = event.toolCall;
			}
		}
		expect(streamed).toBe(JSON.stringify({ content: `${glyph} key` }));
		expect(completed?.arguments).toEqual({ content: `${glyph} key` });
	});

	it("decodes Cursor Pi args and encodes new glyphs in returned results", async () => {
		const glyph = "\ue0a0";
		const newGlyph = String.fromCodePoint(0xf0000);
		const codec = applyGlyphCodec({ messages: [{ role: "user", content: glyph, timestamp: 1 }] });
		let received = "";
		let localResult: ToolResultMessage | undefined;
		const handlers: CursorExecHandlers = {
			async piEdit(call) {
				received = call.args.edits[0]?.newText ?? "";
				localResult = {
					role: "toolResult",
					toolCallId: call.toolCallId,
					toolName: "edit",
					content: [{ type: "text", text: `new ${newGlyph}` }],
					isError: false,
					timestamp: 0,
				};
				return localResult;
			},
		};
		const wrapped = codec.wrapCursorExecHandlers(handlers);
		if (wrapped.piEdit === undefined) throw new Error("expected wrapped piEdit handler");
		const result = await wrapped.piEdit({
			toolCallId: "tool-1",
			args: create(PiEditExecArgsSchema, {
				path: "file.ts",
				edits: [create(PiEditReplacementSchema, { oldText: "before", newText: "⟦Ue0a0⟧" })],
			}),
		});

		expect(received).toBe(glyph);
		expect(localResult?.content[0]).toEqual({ type: "text", text: `new ${newGlyph}` });
		if (!("role" in result) || result.role !== "toolResult") throw new Error("expected encoded tool result");
		expect(result.content[0]).toEqual({ type: "text", text: "new ⟦Uf0000⟧" });
	});
});
describe("streamSimple glyph boundary", () => {
	it("leaves mock requests and responses untouched", async () => {
		registerMockApi();
		const glyph = "\ue0a0";
		const context: Context = {
			messages: [
				{
					role: "toolResult",
					toolCallId: "read-1",
					toolName: "read",
					content: [{ type: "text", text: `icon: ${glyph}` }],
					isError: false,
					timestamp: 1,
				},
			],
		};
		const mock = createMockModel({
			handler(wireContext) {
				const message = wireContext.messages[0];
				if (message?.role !== "toolResult") throw new Error("expected provider-visible tool result");
				const block = message.content[0];
				if (block?.type !== "text") throw new Error("expected provider-visible text");
				expect(block.text).toBe(`icon: ${glyph}`);
				return {
					content: [{ type: "toolCall", name: "write", arguments: { content: "left ⟦Ue0a0⟧ right" } }],
				};
			},
		});
		const result = await streamSimple(mock.model, context).result();
		const call = result.content[0];
		if (call?.type !== "toolCall") throw new Error("expected resolved tool call");
		expect(call.arguments).toEqual({ content: "left ⟦Ue0a0⟧ right" });
		const stored = context.messages[0];
		if (stored?.role !== "toolResult" || stored.content[0]?.type !== "text") {
			throw new Error("expected stored tool result");
		}
		expect(stored.content[0].text).toBe(`icon: ${glyph}`);
	});
	it("encodes Anthropic-compatible requests", async () => {
		const glyph = "\ue0a0";
		const model = buildModel({
			id: "claude-opus-4-8",
			name: "Anthropic-compatible model",
			api: "anthropic-messages",
			provider: "custom-anthropic",
			baseUrl: "https://llm.example.com/anthropic",
			reasoning: false,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 16_000,
			maxTokens: 1_000,
		});
		expect(model.requiresGlyphTokenization).toBe(true);
		const payload = await new Promise<unknown>(resolve => {
			streamSimple(
				model,
				{
					messages: [{ role: "user", content: `icon: ${glyph}`, timestamp: 1 }],
				},
				{
					apiKey: "test",
					signal: AbortSignal.abort(),
					onPayload: payload => {
						resolve(payload);
						throw new Error("stop after capturing Anthropic glyph payload");
					},
				},
			);
		});
		const wire = JSON.stringify(payload);
		expect(wire).toContain("icon: ⟦Ue0a0⟧");
		expect(wire.match(/<glyph-tokens>/g)).toHaveLength(1);
	});
});
