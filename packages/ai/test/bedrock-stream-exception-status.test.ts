// Regression: ConverseStream exception/error frames ride inside an HTTP 200
// event stream, so the frame's shape name is the only evidence of the upstream
// failure. Stamping every frame with a hardcoded 400 made transient service
// faults (internalServerException, serviceUnavailableException, throttling)
// read as deterministic client rejections: the retry classifier refused a
// same-model replay and the turn surfaced as a hard error. The shape name now
// maps to its service-model status, so a transient frame classifies retriable
// and a genuine validation rejection stays terminal.
import { describe, expect, it, vi } from "bun:test";
import { retriable } from "@oh-my-pi/pi-ai/error";
import { bedrockStreamExceptionStatus, streamBedrock } from "@oh-my-pi/pi-ai/providers/amazon-bedrock";
import { crc32 } from "@oh-my-pi/pi-ai/providers/aws-eventstream";
import type { AssistantMessage, Context, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

function model(): Model<"bedrock-converse-stream"> {
	return buildModel({
		id: "us.anthropic.claude-haiku-4-5-20251001-v1:0",
		name: "haiku",
		api: "bedrock-converse-stream",
		provider: "amazon-bedrock",
		baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
		reasoning: false,
		input: ["text"],
		cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
		contextWindow: 1_000_000,
		maxTokens: 128_000,
	});
}

const context: Context = {
	messages: [{ role: "user", content: "hi", timestamp: 0 }],
};

// Frame builder mirroring aws-eventstream.test.ts: the decoder is the
// production code, these helpers only own fixture bytes.
function encodeStringHeader(name: string, value: string): Uint8Array {
	const nameBytes = new TextEncoder().encode(name);
	const valueBytes = new TextEncoder().encode(value);
	const buf = new Uint8Array(1 + nameBytes.length + 1 + 2 + valueBytes.length);
	const view = new DataView(buf.buffer);
	let p = 0;
	view.setUint8(p, nameBytes.length);
	p += 1;
	buf.set(nameBytes, p);
	p += nameBytes.length;
	view.setUint8(p, 7); // string type
	p += 1;
	view.setUint16(p, valueBytes.length, false);
	p += 2;
	buf.set(valueBytes, p);
	return buf;
}

function encodeFrame(headers: Record<string, string>, payload: Uint8Array): Uint8Array {
	const headerChunks: Uint8Array[] = [];
	for (const name in headers) headerChunks.push(encodeStringHeader(name, headers[name]));
	const headerLen = headerChunks.reduce((s, c) => s + c.length, 0);
	const headerBytes = new Uint8Array(headerLen);
	let off = 0;
	for (const c of headerChunks) {
		headerBytes.set(c, off);
		off += c.length;
	}
	const total = 4 + 4 + 4 + headerLen + payload.length + 4;
	const out = new Uint8Array(total);
	const view = new DataView(out.buffer);
	view.setUint32(0, total, false);
	view.setUint32(4, headerLen, false);
	view.setUint32(8, crc32(out.subarray(0, 8)), false);
	out.set(headerBytes, 12);
	out.set(payload, 12 + headerLen);
	view.setUint32(total - 4, crc32(out.subarray(0, total - 4)), false);
	return out;
}

/** Drive one turn whose response stream carries a single failure frame; return the failed message. */
async function failWithFrame(frame: Uint8Array): Promise<AssistantMessage> {
	const fetchMock = vi.fn(
		async () =>
			new Response(
				new ReadableStream<Uint8Array>({
					start(controller) {
						controller.enqueue(frame);
						controller.close();
					},
				}),
				{ status: 200, headers: { "content-type": "application/vnd.amazon.eventstream" } },
			),
	) as unknown as typeof fetch;

	const stream = streamBedrock(model(), context, { bearerToken: "test-token", fetch: fetchMock });
	for await (const event of stream) {
		if (event.type === "error") return event.error;
	}
	throw new Error("stream ended without an error event");
}

function exceptionFrame(exceptionType: string, message: string): Uint8Array {
	return encodeFrame(
		{ ":message-type": "exception", ":exception-type": exceptionType, ":content-type": "application/json" },
		new TextEncoder().encode(JSON.stringify({ message })),
	);
}

describe("bedrockStreamExceptionStatus", () => {
	it("maps every documented ConverseStream exception shape to its service-model status", () => {
		expect(bedrockStreamExceptionStatus("accessDeniedException")).toBe(403);
		expect(bedrockStreamExceptionStatus("conflictException")).toBe(400);
		expect(bedrockStreamExceptionStatus("internalServerException")).toBe(500);
		expect(bedrockStreamExceptionStatus("modelErrorException")).toBe(424);
		expect(bedrockStreamExceptionStatus("modelNotReadyException")).toBe(429);
		expect(bedrockStreamExceptionStatus("modelStreamErrorException")).toBe(424);
		expect(bedrockStreamExceptionStatus("modelTimeoutException")).toBe(408);
		expect(bedrockStreamExceptionStatus("resourceNotFoundException")).toBe(404);
		expect(bedrockStreamExceptionStatus("serviceQuotaExceededException")).toBe(400);
		expect(bedrockStreamExceptionStatus("serviceUnavailableException")).toBe(503);
		expect(bedrockStreamExceptionStatus("throttlingException")).toBe(429);
		expect(bedrockStreamExceptionStatus("validationException")).toBe(400);
	});

	it("normalizes PascalCase error-frame codes", () => {
		expect(bedrockStreamExceptionStatus("InternalServerException")).toBe(500);
		expect(bedrockStreamExceptionStatus("ThrottlingException")).toBe(429);
	});

	it("keeps unknown shapes terminal at 400", () => {
		expect(bedrockStreamExceptionStatus("Exception")).toBe(400);
		expect(bedrockStreamExceptionStatus("someFutureException")).toBe(400);
	});
});

describe("bedrock in-stream failure classification", () => {
	it("classifies an internalServerException frame as a retriable 500", async () => {
		const failed = await failWithFrame(
			exceptionFrame(
				"internalServerException",
				"The server had an error while processing your request. Sorry about that!",
			),
		);
		expect(failed.stopReason).toBe("error");
		expect(failed.errorStatus).toBe(500);
		expect(failed.errorId !== undefined && retriable(failed.errorId)).toBe(true);
	}, 10_000);

	it("classifies a throttlingException frame as a retriable 429", async () => {
		const failed = await failWithFrame(
			exceptionFrame("throttlingException", "Your request was denied due to exceeding the account quotas."),
		);
		expect(failed.errorStatus).toBe(429);
		expect(failed.errorId !== undefined && retriable(failed.errorId)).toBe(true);
	}, 10_000);

	it("classifies a PascalCase error frame by its code", async () => {
		const failed = await failWithFrame(
			encodeFrame(
				{
					":message-type": "error",
					":error-code": "ServiceUnavailableException",
					":error-message": "The service isn't currently available.",
				},
				new Uint8Array(0),
			),
		);
		expect(failed.errorStatus).toBe(503);
		expect(failed.errorId !== undefined && retriable(failed.errorId)).toBe(true);
	}, 10_000);

	it("keeps a validationException frame terminal at 400", async () => {
		const failed = await failWithFrame(
			exceptionFrame(
				"validationException",
				"The input fails to satisfy the constraints specified by Amazon Bedrock.",
			),
		);
		expect(failed.errorStatus).toBe(400);
		expect(failed.errorId === undefined || !retriable(failed.errorId)).toBe(true);
	}, 10_000);

	it("keeps an unrecognized exception frame terminal at 400", async () => {
		const failed = await failWithFrame(exceptionFrame("someFutureException", "something new broke"));
		expect(failed.errorStatus).toBe(400);
		expect(failed.errorId === undefined || !retriable(failed.errorId)).toBe(true);
	}, 10_000);
});
