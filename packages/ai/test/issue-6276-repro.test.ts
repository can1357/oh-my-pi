import { describe, expect, it } from "bun:test";
import { streamBedrock } from "@oh-my-pi/pi-ai/providers/amazon-bedrock";
import { crc32 } from "@oh-my-pi/pi-ai/providers/aws-eventstream";
import { streamSimple } from "@oh-my-pi/pi-ai/stream";
import type { Context, FetchImpl, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

interface GuardrailPayload {
	guardrailConfig?: {
		guardrailIdentifier: string;
		guardrailVersion: string;
		trace?: "enabled" | "disabled" | "enabled_full";
	};
}

function model(): Model<"bedrock-converse-stream"> {
	return buildModel({
		id: "openai.gpt-oss-20b-1:0",
		name: "gpt-oss-20b",
		api: "bedrock-converse-stream",
		provider: "amazon-bedrock",
		baseUrl: "",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 131_072,
		maxTokens: 4_096,
	});
}

const context: Context = {
	messages: [{ role: "user", content: "Reply briefly", timestamp: 0 }],
	tools: [],
};

function encodeStringHeader(name: string, value: string): Uint8Array {
	const nameBytes = new TextEncoder().encode(name);
	const valueBytes = new TextEncoder().encode(value);
	const header = new Uint8Array(1 + nameBytes.length + 1 + 2 + valueBytes.length);
	const view = new DataView(header.buffer);
	let offset = 0;
	view.setUint8(offset, nameBytes.length);
	offset += 1;
	header.set(nameBytes, offset);
	offset += nameBytes.length;
	view.setUint8(offset, 7);
	offset += 1;
	view.setUint16(offset, valueBytes.length, false);
	offset += 2;
	header.set(valueBytes, offset);
	return header;
}

function encodeStopReasonFrame(stopReason: string): Uint8Array {
	const headerChunks = [
		encodeStringHeader(":message-type", "event"),
		encodeStringHeader(":event-type", "messageStop"),
	];
	const headerLength = headerChunks.reduce((sum, chunk) => sum + chunk.length, 0);
	const headers = new Uint8Array(headerLength);
	let headerOffset = 0;
	for (const chunk of headerChunks) {
		headers.set(chunk, headerOffset);
		headerOffset += chunk.length;
	}
	const payload = new TextEncoder().encode(JSON.stringify({ stopReason }));
	const totalLength = 4 + 4 + 4 + headerLength + payload.length + 4;
	const frame = new Uint8Array(totalLength);
	const view = new DataView(frame.buffer);
	view.setUint32(0, totalLength, false);
	view.setUint32(4, headerLength, false);
	view.setUint32(8, crc32(frame.subarray(0, 8)), false);
	frame.set(headers, 12);
	frame.set(payload, 12 + headerLength);
	view.setUint32(totalLength - 4, crc32(frame.subarray(0, totalLength - 4)), false);
	return frame;
}

function stopReasonFetch(stopReason: string): FetchImpl {
	const frame = encodeStopReasonFrame(stopReason);
	return Object.assign(
		async () =>
			new Response(
				new ReadableStream<Uint8Array>({
					start(controller) {
						controller.enqueue(frame);
						controller.close();
					},
				}),
				{
					status: 200,
					headers: { "content-type": "application/vnd.amazon.eventstream" },
				},
			),
		{ preconnect: fetch.preconnect },
	);
}

async function capturePayload(options: {
	guardrailIdentifier?: string;
	guardrailVersion?: string;
	guardrailTrace?: "enabled" | "disabled" | "enabled_full";
}): Promise<GuardrailPayload> {
	const controller = new AbortController();
	controller.abort();
	const { promise, resolve } = Promise.withResolvers<GuardrailPayload>();
	const stream = streamBedrock(model(), context, {
		...options,
		bearerToken: "test-token",
		signal: controller.signal,
		fetch: async () => new Response(new Uint8Array(), { status: 200 }),
		onPayload: payload => {
			resolve(payload as GuardrailPayload);
			return undefined;
		},
	});
	const drain = (async () => {
		for await (const _ of stream) {
			// Drain the provider stream so request errors are observed.
		}
	})();
	const [payload] = await Promise.all([promise, drain]);
	return payload;
}

describe("issue #6276 — Amazon Bedrock guardrails", () => {
	it("sends configured guardrail values in the Converse request", async () => {
		const payload = await capturePayload({
			guardrailIdentifier: "arn:aws:bedrock:eu-west-1:123456789012:guardrail/abcd1234",
			guardrailVersion: "7",
			guardrailTrace: "enabled_full",
		});

		expect(payload.guardrailConfig).toEqual({
			guardrailIdentifier: "arn:aws:bedrock:eu-west-1:123456789012:guardrail/abcd1234",
			guardrailVersion: "7",
			trace: "enabled_full",
		});
	});
	it("maps transport guardrails into the Bedrock provider options", async () => {
		const controller = new AbortController();
		controller.abort();
		const { promise, resolve } = Promise.withResolvers<GuardrailPayload>();
		const stream = streamSimple(model(), context, {
			guardrailIdentifier: "arn:aws:bedrock:eu-west-1:123456789012:guardrail/abcd1234",
			guardrailVersion: "7",
			guardrailTrace: "enabled_full",
			providerOptions: { bearerToken: "test-token" },
			signal: controller.signal,
			fetch: async () => new Response(new Uint8Array(), { status: 200 }),
			onPayload: payload => {
				resolve(payload as GuardrailPayload);
				return undefined;
			},
		});
		const drain = (async () => {
			for await (const _ of stream) {
				// Drain the provider stream so request errors are observed.
			}
		})();
		const [payload] = await Promise.all([promise, drain]);

		expect(payload.guardrailConfig).toEqual({
			guardrailIdentifier: "arn:aws:bedrock:eu-west-1:123456789012:guardrail/abcd1234",
			guardrailVersion: "7",
			trace: "enabled_full",
		});
	});

	it("defaults configured guardrails to the DRAFT version", async () => {
		const payload = await capturePayload({ guardrailIdentifier: "abcd1234" });

		expect(payload.guardrailConfig).toEqual({
			guardrailIdentifier: "abcd1234",
			guardrailVersion: "DRAFT",
			trace: undefined,
		});
	});

	it("keeps model content filtering distinct from guardrail intervention", async () => {
		const result = await streamBedrock(model(), context, {
			bearerToken: "test-token",
			fetch: stopReasonFetch("content_filtered"),
		}).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain("content filters");
		expect(result.errorMessage).not.toContain("guardrail");
	});
});
