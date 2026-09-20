/**
 * Grok Bot wire tests use deterministic synthetic protobuf fixtures.
 *
 * The field numbers and response shapes mirror the verified Sand protocol,
 * while identifiers, signatures, usage values, and errors remain local test
 * data. Request goldens likewise contain only explicit synthetic values.
 */
import { describe, expect, test } from "bun:test";
import { ToolCallAssembler } from "../../src/providers/grokbot/assemble";
import {
	CONNECT_END_STREAM_FLAG,
	ConnectFrameReader,
	parseEndStreamTrailer,
	type ConnectFrame,
} from "../../src/providers/grokbot/connect";
import { resolveGrokbotRequestedModel } from "../../src/providers/grokbot/model-request";
import {
	decodeInferenceStreamResponse,
	encodeInferenceStreamRequest,
	type InferenceStreamRequest,
} from "../../src/providers/grokbot/wire";

function encodeVarint(value: number): Buffer {
	const bytes: number[] = [];
	let remaining = value;
	do {
		const byte = remaining & 0x7f;
		remaining = Math.floor(remaining / 128);
		bytes.push(remaining > 0 ? byte | 0x80 : byte);
	} while (remaining > 0);
	return Buffer.from(bytes);
}

function protoBytes(fieldNumber: number, payload: Uint8Array): Buffer {
	const body = Buffer.from(payload);
	return Buffer.concat([encodeVarint((fieldNumber << 3) | 2), encodeVarint(body.length), body]);
}

function protoString(fieldNumber: number, value: string): Buffer {
	return protoBytes(fieldNumber, Buffer.from(value, "utf8"));
}

function protoInt(fieldNumber: number, value: number): Buffer {
	return Buffer.concat([encodeVarint(fieldNumber << 3), encodeVarint(value)]);
}

function protoMessage(fieldNumber: number, ...fields: Buffer[]): Buffer {
	return protoBytes(fieldNumber, Buffer.concat(fields));
}

interface SyntheticToolCallFrame {
	id: string;
	name?: string;
	args?: string;
	complete?: boolean;
}

function toolCallFrame(frame: SyntheticToolCallFrame): Buffer {
	const fields = [protoString(1, frame.id)];
	if (frame.name !== undefined) fields.push(protoString(2, frame.name));
	if (frame.args !== undefined) fields.push(protoString(3, frame.args));
	if (frame.complete === true) fields.push(protoInt(4, 1));
	return protoMessage(2, ...fields);
}

const TOOLCALL_FRAMES = [
	toolCallFrame({ id: "tool-call-primary", name: "bash" }),
	toolCallFrame({ id: "tool-call-primary" }),
	toolCallFrame({ id: "tool-call-primary", args: "{" }),
	toolCallFrame({ id: "tool-call-primary", args: '"command":"echo wire-truth"}' }),
	toolCallFrame({
		id: "tool-call-primary",
		name: "bash",
		args: '{"command":"echo wire-truth"}',
		complete: true,
	}),
];

const USAGE_FRAMES = [
	protoMessage(3, protoInt(1, 10), protoInt(2, 20), protoInt(3, 30)),
	protoMessage(5, protoInt(1, 10), protoInt(2, 20), protoInt(3, 3), protoInt(4, 4), protoInt(5, 4096)),
];

const TEXT_FRAME = protoMessage(1, protoString(1, "HELLO-WIRE"));

// Signature content is opaque to the decoder; keep it explicitly synthetic.
const THINKING_SIG_FRAME = protoMessage(9, protoString(2, "synthetic-thinking-signature"));

// Two synthetic parallel calls exercise independent assembler state.
const MULTITOOL_FRAMES = [
	toolCallFrame({ id: "tool-call-one", name: "bash" }),
	toolCallFrame({ id: "tool-call-one", args: "{" }),
	toolCallFrame({ id: "tool-call-one", name: "bash", args: '{"command":"echo one"}', complete: true }),
	toolCallFrame({ id: "tool-call-two", name: "bash" }),
	toolCallFrame({ id: "tool-call-two", args: "{" }),
	toolCallFrame({ id: "tool-call-two", name: "bash", args: '{"command":"echo two"}', complete: true }),
];

// Deterministic Connect error trailer; no upstream response metadata.
const ERROR_TRAILER = Buffer.from(
	JSON.stringify({
		error: { code: "resource_exhausted", message: "Synthetic provider limit", details: [] },
	}),
	"utf8",
);

// Golden request bytes contain only the synthetic request cases below.
const GOLDEN_REQUESTS = {
	simple:
		"ChsIBBIXWW91IGFyZSBhIGNvZGluZyBhZ2VudC4KDggBEgpoZWxsbyB3aXJlMhRzeW50aGV0aWMtaW52b2NhdGlvbjoqCghncm9rLTQuNhABGg4KBmVmZm9ydBIEaGlnaBoMCgRmYXN0EgR0cnVlQhZzeW50aGV0aWMtY29udmVyc2F0aW9u",
	tools: "CgwIARIIcnVuIGJhc2gSkgEKBGJhc2gSElJ1biBhIGJhc2ggY29tbWFuZBp2ChAKBHR5cGUSCBoGb2JqZWN0CkcKCnByb3BlcnRpZXMSOSo3CjUKB2NvbW1hbmQSKiooChAKBHR5cGUSCBoGc3RyaW5nChQKC2Rlc2NyaXB0aW9uEgUaA2NtZAoZCghyZXF1aXJlZBINMgsKCRoHY29tbWFuZBJtCgRyZWFkEglSZWFkIGZpbGUaWgoQCgR0eXBlEggaBm9iamVjdAouCgpwcm9wZXJ0aWVzEiAqHgocCgRwYXRoEhQqEgoQCgR0eXBlEggaBnN0cmluZwoWCghyZXF1aXJlZBIKMggKBhoEcGF0aDIFaW52LTE6CgoIZ3Jvay00LjZCBmNvbnYtMQ==",
	history:
		"Cg8IBBILc3lzdGVtIGxpbmUKDggBEgpjaGVjayBmaWxlClQIAhIRdGhpbmtpbmcgYWJvdXQgaXQiKgoPY2FsbC1hYmMtMApmY194EgRiYXNoGhEKDwoHY29tbWFuZBIEGgJsczoREgd0aG91Z2h0GgZzaWcxMjMKKQgDMiUKIwoPY2FsbC1hYmMtMApmY194EgRiYXNoGgoaCGZpbGUudHh0CggIAhIEZG9uZQovCAEaKwoQCg4KDHdoYXQgaXMgdGhpcwoXEhUKCGFHVnNiRzg9EglpbWFnZS9wbmcSawoEYmFzaBIBZBpgChAKBHR5cGUSCBoGb2JqZWN0CjEKCnByb3BlcnRpZXMSIyohCh8KB2NvbW1hbmQSFCoSChAKBHR5cGUSCBoGc3RyaW5nChkKCHJlcXVpcmVkEg0yCwoJGgdjb21tYW5kIhIIgCAVMzMzPx1mZmY/IgNFTkQyBWludi0yOg4KDHNhbmQtZGVmYXVsdEIGY29udi0y",
	grammar:
		"Cg0IARIJZWRpdCBmaWxlCj4IAiI6CghjYWxsLWctMBIJZWRpdF93aXJlIiMqKiogQmVnaW4gUGF0Y2gKLWEKK2IKKioqIEVuZCBQYXRjaAohCAMyHQobCghjYWxsLWctMBIJZWRpdF93aXJlGgQaAm9rEloKBGVkaXQSC2FwcGx5IHBhdGNoGiQKEAoEdHlwZRIIGgZvYmplY3QKEAoKcHJvcGVydGllcxICKgAiHwoHZ3JhbW1hchIOc3RhcnQ6IHBhdHRlcm4aBHdicGwyBWludi0zOgoKCGdyb2stNC42QgZjb252LTM=",
	toolresult:
		"Cg4IARIKc2NyZWVuc2hvdAoUCAIiEAoIY2FsbC1zLTASBHNob3QKMAgDMiwKKgoIY2FsbC1zLTASBHNob3QaAhoAKhQSEgoEYUdrPRIKaW1hZ2UvanBlZzIFaW52LTQ6CgoIZ3Jvay00LjZCBmNvbnYtNA==",
};

describe("grokbot wire: synthetic text part", () => {
	const parts = decodeInferenceStreamResponse(TEXT_FRAME);

	test("decodes text delta without isFinal", () => {
		expect(parts).toHaveLength(1);
		expect(parts[0]).toMatchObject({ kind: "text", text: "HELLO-WIRE", isFinal: false });
	});
});

describe("grokbot wire: synthetic thinking part", () => {
	const parts = decodeInferenceStreamResponse(THINKING_SIG_FRAME);

	test("decodes signature-only thinking (no plaintext reasoning on this model)", () => {
		expect(parts).toHaveLength(1);
		const part = parts[0]!;
		if (part.kind !== "thinking") throw new Error("expected thinking part");
		expect(part.text).toBe("");
		expect(part.signature).toBe("synthetic-thinking-signature");
		expect(part.isFinal).toBe(false);
	});
});

describe("grokbot wire: synthetic usage parts", () => {
	const usage = decodeInferenceStreamResponse(USAGE_FRAMES[0]!);
	const extended = decodeInferenceStreamResponse(USAGE_FRAMES[1]!);

	test("usage carries input/output/total", () => {
		expect(usage).toHaveLength(1);
		const part = usage[0]!;
		if (part.kind !== "usage") throw new Error("expected usage part");
		expect(part.input).toBe(10);
		expect(part.output).toBe(20);
		expect(part.total).toBe(30);
	});

	test("extendedUsage carries maxTokens", () => {
		const part = extended[0]!;
		if (part.kind !== "extendedUsage") throw new Error("expected extendedUsage part");
		expect(part.input).toBe(10);
		expect(part.output).toBe(20);
		expect(part.maxTokens).toBe(4096);
	});
});

describe("grokbot wire: synthetic tool call parts", () => {
	const parts = TOOLCALL_FRAMES.map(payload => decodeInferenceStreamResponse(payload)[0]!);

	test("frames decode to toolCall parts with expected fields", () => {
		expect(parts.every(p => p.kind === "toolCall")).toBe(true);
		const [first, idOnly, delta1, delta2, final] = parts as never as Array<
			Extract<ReturnType<typeof decodeInferenceStreamResponse>[number], { kind: "toolCall" }>
		>;
		expect(first!.toolName).toBe("bash");
		expect(first!.args).toBeUndefined(); // intro frame carries no args
		expect(idOnly!.toolName).toBeUndefined();
		expect(delta1!.args).toBe("{");
		expect(delta2!.args).toBe('"command":"echo wire-truth"}');
		expect(final!.args).toBe('{"command":"echo wire-truth"}');
		expect(final!.isComplete).toBe(true);
	});

	test("assembler concatenates increments and replaces on completion", () => {
		const asm = new ToolCallAssembler();
		const events: string[] = [];
		for (const part of parts) {
			if (part.kind !== "toolCall") continue;
			const r = asm.onToolCallPart(part);
			if (r.started) events.push("start");
			if (r.delta !== undefined) events.push(`delta:${r.delta}`);
			if (part.isComplete) events.push(`complete:${r.argsText}`);
		}
		expect(events).toEqual([
			"start",
			"delta:{",
			'delta:"command":"echo wire-truth"}',
			'complete:{"command":"echo wire-truth"}',
		]);
	});

	test("parallel calls assemble independently by id", () => {
		const asm = new ToolCallAssembler();
		const completed: Array<{ id: string; args: string }> = [];
		for (const payload of MULTITOOL_FRAMES) {
			for (const part of decodeInferenceStreamResponse(payload)) {
				if (part.kind !== "toolCall") continue;
				const r = asm.onToolCallPart(part);
				if (part.isComplete) completed.push({ id: part.toolCallId, args: r.argsText });
			}
		}
		expect(completed).toHaveLength(2);
		expect(completed[0]!.args).toBe('{"command":"echo one"}');
		expect(completed[1]!.args).toBe('{"command":"echo two"}');
		expect(completed[0]!.id).not.toBe(completed[1]!.id);
	});
});

describe("grokbot wire: end-stream trailer", () => {
	test("parses a synthetic resource_exhausted error trailer", () => {
		const trailer = parseEndStreamTrailer(ERROR_TRAILER);
		expect(trailer.error?.code).toBe("resource_exhausted");
		expect(trailer.error?.message).toBe("Synthetic provider limit");
	});

	test("empty trailer is a clean end", () => {
		const trailer = parseEndStreamTrailer(Buffer.from("{}", "utf8"));
		expect(trailer.error).toBeUndefined();
	});

	test("rejects malformed end-stream metadata", () => {
		for (const payload of [
			'{"metadata":null}',
			'{"metadata":[]}',
			'{"metadata":{"x-cursor-request":"value"}}',
			'{"metadata":{"x-cursor-request":["value",1]}}',
		]) {
			expect(() => parseEndStreamTrailer(Buffer.from(payload, "utf8"))).toThrow(/metadata/);
		}
	});

	test("invalid trailer JSON throws", () => {
		expect(() => parseEndStreamTrailer(Buffer.from("not json", "utf8"))).toThrow(/not valid JSON/);
	});

	test("rejects structurally malformed end-stream trailers", () => {
		for (const payload of [
			"",
			"null",
			"[]",
			'{"error":null}',
			'{"error":[]}',
			'{"error":"failed"}',
			'{"error":{}}',
		]) {
			expect(() => parseEndStreamTrailer(Buffer.from(payload, "utf8"))).toThrow(/trailer/);
		}
	});
});

describe("grokbot wire: connect framing", () => {
	test("frame reassembles when split across chunks", () => {
		const payload = TEXT_FRAME;
		const whole = Buffer.alloc(5 + payload.length);
		whole[0] = 0;
		whole.writeUInt32BE(payload.length, 1);
		payload.copy(whole, 5);
		const reader = new ConnectFrameReader();
		const a = [...reader.push(whole.subarray(0, 2))];
		const b = [...reader.push(whole.subarray(2, 7))];
		const c = [...reader.push(whole.subarray(7))];
		expect(a).toHaveLength(0);
		expect(b).toHaveLength(0);
		expect(c).toHaveLength(1);
		expect(c[0]!.flags).toBe(0);
		expect(c[0]!.bytes).toEqual(payload);
	});

	test("reassembles back-to-back frames split at every byte without invalidating prior frames", () => {
		const bytes = Buffer.concat([
			Buffer.from([0, 0, 0, 0, 3]),
			Buffer.from("one"),
			Buffer.from([0, 0, 0, 0, 3]),
			Buffer.from("two"),
		]);
		const reader = new ConnectFrameReader();
		const frames: ConnectFrame[] = [];
		for (let offset = 0; offset < bytes.length; offset++) {
			for (const frame of reader.push(bytes.subarray(offset, offset + 1))) frames.push(frame);
		}

		expect(frames.map(frame => frame.bytes.toString("utf8"))).toEqual(["one", "two"]);
		expect(reader.buffered).toBe(0);
	});

	test("reassembles a large byte-fragmented payload", () => {
		const payload = Buffer.alloc(64 * 1024, 0x61);
		const bytes = Buffer.concat([Buffer.from([0, 0, 1, 0, 0]), payload]);
		const reader = new ConnectFrameReader();
		let emitted: ConnectFrame | undefined;
		for (let offset = 0; offset < bytes.length; offset++) {
			for (const frame of reader.push(bytes.subarray(offset, offset + 1))) emitted = frame;
		}

		expect(emitted?.bytes).toEqual(payload);
		expect(reader.buffered).toBe(0);
	});

	test("keeps an emitted frame stable after later pushes", () => {
		const reader = new ConnectFrameReader();
		const [first] = reader.push(Buffer.from([0, 0, 0, 0, 3, 0x6f, 0x6e, 0x65]));
		reader.push(Buffer.from([0, 0, 0, 0, 3, 0x74, 0x77, 0x6f])).next();

		expect(first!.bytes.toString("utf8")).toBe("one");
	});

	test("rejects an oversized first header without retaining its chunk", () => {
		const reader = new ConnectFrameReader();
		const evil = Buffer.alloc(1024 * 1024);
		evil.writeUInt32BE(64 * 1024 * 1024, 1);
		expect(() => [...reader.push(evil)]).toThrow(/too large/);
		expect(reader.buffered).toBe(0);
	});

	test("applies an OAuth verifier payload cap before allocating a declared partial frame", () => {
		const reader = new ConnectFrameReader({ maxPayload: 64 * 1024 });
		const declaredOversize = Buffer.alloc(5);
		declaredOversize.writeUInt32BE(64 * 1024 + 1, 1);

		expect(() => [...reader.push(declaredOversize)]).toThrow(/cap 65536/);
		expect(reader.buffered).toBe(0);
	});

	test("ignores an oversized header after the first end-stream trailer", () => {
		const reader = new ConnectFrameReader();
		const trailer = Buffer.from([CONNECT_END_STREAM_FLAG, 0, 0, 0, 2, 0x7b, 0x7d]);
		const oversizedHeader = Buffer.alloc(5);
		oversizedHeader.writeUInt32BE(64 * 1024 * 1024, 1);

		const frames = [...reader.push(Buffer.concat([trailer, oversizedHeader]))];
		expect(frames).toEqual([{ flags: CONNECT_END_STREAM_FLAG, bytes: Buffer.from("{}") }]);
		expect(reader.buffered).toBe(0);
		expect([...reader.push(oversizedHeader)]).toEqual([]);
	});
});

describe("grokbot requested-model parameter contract", () => {
	test("defaults advertised fast models to fast mode", () => {
		expect(resolveGrokbotRequestedModel("grok-4.6", { sandParameterIds: ["fast"] })).toEqual({
			modelId: "grok-4.6",
			parameters: [{ id: "fast", value: "true" }],
		});
	});

	test("preserves an explicit direct-provider fast disablement", () => {
		expect(resolveGrokbotRequestedModel("grok-4.6", { sandParameterIds: ["fast"], fast: false })).toEqual({
			modelId: "grok-4.6",
			parameters: [{ id: "fast", value: "false" }],
		});
	});

	test("forwards explicitly enabled and disabled thinking", () => {
		for (const thinking of [true, false]) {
			expect(resolveGrokbotRequestedModel("grok-4.6", { sandParameterIds: ["thinking"], thinking })).toEqual({
				modelId: "grok-4.6",
				parameters: [{ id: "thinking", value: String(thinking) }],
			});
		}
	});

	test("enables boolean thinking when an effort request has no effort parameter", () => {
		expect(resolveGrokbotRequestedModel("grok-4.6", { sandParameterIds: ["thinking"], effort: "high" })).toEqual({
			modelId: "grok-4.6",
			parameters: [{ id: "thinking", value: "true" }],
		});
	});

	test("uses live reasoning parameter ids and exact effort wire aliases", () => {
		expect(
			resolveGrokbotRequestedModel("gpt-live", {
				effort: "xhigh",
				sandParameterIds: ["reasoning_effort"],
				sandEffortValues: { xhigh: "extra-high" },
			}),
		).toEqual({
			modelId: "gpt-live",
			parameters: [{ id: "reasoning_effort", value: "extra-high" }],
		});
	});

	test("omits parameters unsupported by the model metadata", () => {
		expect(
			resolveGrokbotRequestedModel("grok-4.6", {
				sandParameterIds: ["fast"],
				thinking: false,
			}),
		).toEqual({
			modelId: "grok-4.6",
			parameters: [{ id: "fast", value: "true" }],
		});
	});

	test("keeps the routed Auto model parameter-free", () => {
		expect(
			resolveGrokbotRequestedModel("default", {
				sandParameterIds: ["fast", "thinking"],
				fast: false,
				thinking: false,
			}),
		).toEqual({ modelId: "default" });
	});
});

describe("grokbot wire: request encoder matches verified wire bytes", () => {
	const cases: Record<string, InferenceStreamRequest> = {
		simple: {
			messages: [
				{ role: 4, text: "You are a coding agent." },
				{ role: 1, text: "hello wire" },
			],
			requestedModel: {
				modelId: "grok-4.6",
				maxMode: true,
				parameters: [
					{ id: "effort", value: "high" },
					{ id: "fast", value: "true" },
				],
			},
			invocationId: "synthetic-invocation",
			conversationId: "synthetic-conversation",
		},
		tools: {
			messages: [{ role: 1, text: "run bash" }],
			tools: [
				{
					name: "bash",
					description: "Run a bash command",
					parameters: {
						type: "object",
						properties: { command: { type: "string", description: "cmd" } },
						required: ["command"],
					},
				},
				{
					name: "read",
					description: "Read file",
					parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
				},
			],
			requestedModel: { modelId: "grok-4.6" },
			invocationId: "inv-1",
			conversationId: "conv-1",
		},
		history: {
			messages: [
				{ role: 4, text: "system line" },
				{ role: 1, text: "check file" },
				{
					role: 2,
					text: "thinking about it",
					toolCalls: [{ toolCallId: "call-abc-0\nfc_x", toolName: "bash", args: { command: "ls" } }],
					reasoningParts: [{ isRedacted: false, text: "thought", signature: "sig123" }],
				},
				{
					role: 3,
					toolContent: {
						parts: [{ toolCallId: "call-abc-0\nfc_x", toolName: "bash", result: "file.txt" }],
					},
				},
				{ role: 2, text: "done" },
				{
					role: 1,
					parts: {
						parts: [
							{ type: "text", text: "what is this" },
							{ type: "image", data: "aGVsbG8=", mimeType: "image/png" },
						],
					},
				},
			],
			tools: [
				{
					name: "bash",
					description: "d",
					parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
				},
			],
			modelConfig: { maxTokens: 4096, temperature: 0.7, topP: 0.9, stopSequences: ["END"] },
			requestedModel: { modelId: "sand-default" },
			invocationId: "inv-2",
			conversationId: "conv-2",
		},
		grammar: {
			messages: [
				{ role: 1, text: "edit file" },
				{
					role: 2,
					toolCalls: [
						{
							toolCallId: "call-g-0",
							toolName: "edit_wire",
							rawToolCallArgs: "*** Begin Patch\n-a\n+b\n*** End Patch",
						},
					],
				},
				{ role: 3, toolContent: { parts: [{ toolCallId: "call-g-0", toolName: "edit_wire", result: "ok" }] } },
			],
			tools: [
				{
					name: "edit",
					description: "apply patch",
					parameters: { type: "object", properties: {} },
					customToolFormat: { type: "grammar", definition: "start: pattern", syntax: "wbpl" },
				},
			],
			requestedModel: { modelId: "grok-4.6" },
			invocationId: "inv-3",
			conversationId: "conv-3",
		},
		toolresult: {
			messages: [
				{ role: 1, text: "screenshot" },
				{ role: 2, toolCalls: [{ toolCallId: "call-s-0", toolName: "shot", args: {} }] },
				{
					role: 3,
					toolContent: {
						parts: [
							{
								toolCallId: "call-s-0",
								toolName: "shot",
								result: "",
								experimentalContent: [{ type: "image", data: "aGk=", mimeType: "image/jpeg" }],
							},
						],
					},
				},
			],
			requestedModel: { modelId: "grok-4.6" },
			invocationId: "inv-4",
			conversationId: "conv-4",
		},
	};

	for (const [name, request] of Object.entries(cases)) {
		test(`encodes ${name} byte-identical to verified bytes`, () => {
			const golden = (GOLDEN_REQUESTS as Record<string, string>)[name]!;
			expect(encodeInferenceStreamRequest(request).toString("base64")).toBe(golden);
		});
	}
});
