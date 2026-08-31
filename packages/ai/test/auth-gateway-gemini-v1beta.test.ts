import { describe, expect, it } from "bun:test";
import { ValidationError } from "@oh-my-pi/pi-ai/error";
import {
	encodeResponse,
	encodeStream,
	formatError,
	parseRequest,
} from "@oh-my-pi/pi-ai/providers/gemini-v1beta-server";
import type { AssistantMessage, AssistantMessageEvent, AssistantMessageEventStream } from "@oh-my-pi/pi-ai/types";

function makeEventStream(events: AssistantMessageEvent[], final: AssistantMessage): AssistantMessageEventStream {
	async function* iter() {
		for (const e of events) yield e;
	}
	const stream = iter() as unknown as AssistantMessageEventStream;
	(stream as { result(): Promise<AssistantMessage> }).result = async () => final;
	return stream;
}

async function collectStream(stream: ReadableStream<Uint8Array>): Promise<string[]> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let buf = "";
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		if (value) buf += decoder.decode(value, { stream: true });
	}
	buf += decoder.decode();
	return buf.split("\n\n").filter(s => s.length > 0);
}

function parseSseData(frame: string): unknown {
	const stripped = frame.replace(/^data: /, "");
	return JSON.parse(stripped);
}

const baseUsage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function emptyAssistant(): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "google-generative-ai",
		provider: "google",
		model: "gemini-test",
		usage: baseUsage,
		stopReason: "stop",
		timestamp: 0,
	};
}

describe("auth-gateway gemini-v1beta: parseRequest", () => {
	it("maps contents user text into context", () => {
		const parsed = parseRequest({
			model: "gemini-2.0-flash",
			contents: [{ role: "user", parts: [{ text: "hello gemini" }] }],
		});
		expect(parsed.modelId).toBe("gemini-2.0-flash");
		expect(parsed.stream).toBe(true);
		expect(parsed.context.messages).toEqual([expect.objectContaining({ role: "user", content: "hello gemini" })]);
	});

	it("throws on empty or non-object bodies", () => {
		expect(() => parseRequest({})).toThrow(ValidationError);
		expect(() => parseRequest(null)).toThrow(/request body must be a JSON object/);
		expect(() => parseRequest(undefined)).toThrow(/request body must be a JSON object/);
		expect(() => parseRequest([])).toThrow(/request body must be a JSON object/);
	});

	it("rejects contents that is not an array", () => {
		expect(() => parseRequest({ contents: "nope" })).toThrow(/contents must be an array/);
	});

	it("accepts OpenAI-ish messages and honors stream false", () => {
		const parsed = parseRequest({
			model: "gemini-pro",
			messages: [
				{ role: "system", content: "be brief" },
				{ role: "user", content: "hi" },
				{ role: "assistant", content: "hello" },
			],
			stream: false,
			temperature: 0.2,
		});
		expect(parsed.stream).toBe(false);
		expect(parsed.context.systemPrompt).toEqual(["be brief"]);
		expect(parsed.context.messages[0]).toEqual(expect.objectContaining({ role: "user", content: "hi" }));
		expect(parsed.context.messages[1]?.role).toBe("assistant");
		expect(parsed.options.temperature).toBe(0.2);
	});

	it("leaves modelId empty when the body omits model (path-filled later)", () => {
		const parsed = parseRequest({
			contents: [{ role: "user", parts: [{ text: "path model" }] }],
		});
		expect(parsed.modelId).toBe("");
		expect(parsed.context.messages[0]).toEqual(expect.objectContaining({ content: "path model" }));
	});

	it("maps inlineData parts to image content and keeps image-only turns", () => {
		const parsed = parseRequest({
			model: "gemini-2.0-flash",
			contents: [
				{
					role: "user",
					parts: [{ inlineData: { mimeType: "image/png", data: "abc123" } }],
				},
				{
					role: "user",
					parts: [
						{ text: "caption" },
						{ inline_data: { mime_type: "image/jpeg", data: "def456" } },
					],
				},
			],
		});
		expect(parsed.context.messages[0]).toEqual({
			role: "user",
			content: [{ type: "image", mimeType: "image/png", data: "abc123" }],
			timestamp: expect.any(Number),
		});
		expect(parsed.context.messages[1]).toEqual({
			role: "user",
			content: [
				{ type: "text", text: "caption" },
				{ type: "image", mimeType: "image/jpeg", data: "def456" },
			],
			timestamp: expect.any(Number),
		});
	});

	it("joins multiple text parts and maps model role to assistant", () => {
		const parsed = parseRequest({
			model: "gemini-2.0-flash",
			systemInstruction: { parts: [{ text: "sys" }] },
			contents: [
				{ role: "user", parts: [{ text: "a" }, { text: "b" }] },
				{ role: "model", parts: [{ text: "c" }] },
			],
			generationConfig: { temperature: 0.5, maxOutputTokens: 32, topK: 8 },
		});
		expect(parsed.context.systemPrompt).toEqual(["sys"]);
		expect(parsed.context.messages[0]).toEqual(expect.objectContaining({ role: "user", content: "ab" }));
		expect(parsed.context.messages[1]?.role).toBe("assistant");
		expect(parsed.options.temperature).toBe(0.5);
		expect(parsed.options.maxOutputTokens).toBe(32);
		expect(parsed.options.topK).toBe(8);
	});
});

describe("auth-gateway gemini-v1beta: encodeResponse", () => {
	it("emits candidates with text parts and STOP", () => {
		const message: AssistantMessage = {
			...emptyAssistant(),
			content: [
				{ type: "text", text: "the answer" },
				{ type: "thinking", thinking: "hidden" },
			],
		};
		expect(encodeResponse(message, "gemini-2.0-flash")).toMatchObject({
			candidates: [{ content: { parts: [{ text: "the answer" }] }, finishReason: "STOP" }],
			modelVersion: "gemini-2.0-flash",
		});
	});
});

describe("auth-gateway gemini-v1beta: encodeStream", () => {
	it("emits text deltas as candidate parts then STOP", async () => {
		const partial = emptyAssistant();
		const events: AssistantMessageEvent[] = [
			{ type: "text_delta", contentIndex: 0, delta: "Hel", partial },
			{ type: "text_delta", contentIndex: 0, delta: "lo", partial },
			{ type: "done", reason: "stop", message: { ...partial, content: [{ type: "text", text: "Hello" }] } },
		];
		const frames = await collectStream(encodeStream(makeEventStream(events, partial), "gemini-2.0-flash"));
		expect(parseSseData(frames[0] ?? "")).toMatchObject({
			candidates: [{ content: { parts: [{ text: "Hel" }] } }],
		});
		expect(parseSseData(frames[1] ?? "")).toMatchObject({
			candidates: [{ content: { parts: [{ text: "lo" }] } }],
		});
		expect(parseSseData(frames[2] ?? "")).toMatchObject({
			candidates: [{ finishReason: "STOP" }],
		});
	});
});

describe("auth-gateway gemini-v1beta: formatError", () => {
	it("returns Gemini { error: { message, status, code } }", async () => {
		const res = formatError(400, "INVALID_ARGUMENT", "bad request");
		expect(res.status).toBe(400);
		expect(await res.json()).toEqual({
			error: { message: "bad request", status: "INVALID_ARGUMENT", code: 400 },
		});
	});
});
