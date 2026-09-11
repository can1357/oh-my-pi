import { crc32 } from "@oh-my-pi/pi-ai/providers/aws-eventstream";
import type { Context, FetchImpl, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { ModelSpec } from "@oh-my-pi/pi-catalog/types";
import { withEnv } from "./index";

// Shared harness for the Bedrock Converse-Stream provider tests: encodes the
// AWS eventstream wire format, captures what `streamBedrock` actually sends,
// and builds the one Claude 3.5 Sonnet spec both suites exercise. Keep this
// the single copy — `bedrock-request-metadata.test.ts` and
// `bedrock-caller-headers.test.ts` used to carry ~100 duplicated lines of it.

/**
 * Run `body` with dummy AWS credentials, restoring the environment immediately.
 * Scoped to the one test rather than the file: a `beforeAll` override leaves
 * every later Bedrock file in the same Bun process on the dummy-credential path
 * until `afterAll` runs, which is the full-suite hazard `AGENTS.md` rules out.
 */
export function withSkippedBedrockAuth(fn: () => Promise<void>): Promise<void> {
	return withEnv({ AWS_BEDROCK_SKIP_AUTH: "1", AWS_BEARER_TOKEN_BEDROCK: undefined }, fn);
}

export function encodeBedrockFrame(headers: Record<string, string>, payload: Uint8Array): Uint8Array {
	const headerParts: Uint8Array[] = [];
	for (const [name, value] of Object.entries(headers)) {
		const nameBytes = new TextEncoder().encode(name);
		const valueBytes = new TextEncoder().encode(value);
		const part = new Uint8Array(1 + nameBytes.length + 1 + 2 + valueBytes.length);
		const partView = new DataView(part.buffer);
		let cursor = 0;
		partView.setUint8(cursor, nameBytes.length);
		cursor += 1;
		part.set(nameBytes, cursor);
		cursor += nameBytes.length;
		partView.setUint8(cursor, 7);
		cursor += 1;
		partView.setUint16(cursor, valueBytes.length, false);
		cursor += 2;
		part.set(valueBytes, cursor);
		headerParts.push(part);
	}
	const headerLength = headerParts.reduce((total, part) => total + part.length, 0);
	const headerBytes = new Uint8Array(headerLength);
	let offset = 0;
	for (const part of headerParts) {
		headerBytes.set(part, offset);
		offset += part.length;
	}
	const totalLength = 12 + headerLength + payload.length + 4;
	const frame = new Uint8Array(totalLength);
	const view = new DataView(frame.buffer);
	view.setUint32(0, totalLength, false);
	view.setUint32(4, headerLength, false);
	view.setUint32(8, crc32(frame.subarray(0, 8)), false);
	frame.set(headerBytes, 12);
	frame.set(payload, 12 + headerLength);
	view.setUint32(totalLength - 4, crc32(frame.subarray(0, totalLength - 4)), false);
	return frame;
}

export function bedrockEvent(eventType: string, payload: string): Uint8Array {
	return encodeBedrockFrame({ ":message-type": "event", ":event-type": eventType }, new TextEncoder().encode(payload));
}

/** The minimal valid five-event stream every happy-path Bedrock test replays. */
export function bedrockHappyPathFrames(): Uint8Array[] {
	return [
		bedrockEvent("messageStart", '{"role":"assistant"}'),
		bedrockEvent("contentBlockDelta", '{"contentBlockIndex":0,"delta":{"text":"hi"}}'),
		bedrockEvent("contentBlockStop", '{"contentBlockIndex":0}'),
		bedrockEvent("messageStop", '{"stopReason":"end_turn"}'),
		bedrockEvent("metadata", '{"usage":{"inputTokens":1,"outputTokens":1,"totalTokens":2}}'),
	];
}

export interface BedrockCapture {
	headers?: Record<string, string>;
	body?: unknown;
}

/** Captures both the request headers and the JSON-parsed body, and replies with the happy-path stream. */
export function capturingBedrockFetch(seen: BedrockCapture): FetchImpl {
	const frames = bedrockHappyPathFrames();
	return Object.assign(
		async (_input: string | URL | Request, init?: RequestInit) => {
			seen.headers = (init?.headers ?? {}) as Record<string, string>;
			const raw = init?.body;
			const bytes = raw instanceof Uint8Array ? raw : new TextEncoder().encode(String(raw ?? ""));
			seen.body = JSON.parse(new TextDecoder().decode(bytes));
			let index = 0;
			const body = new ReadableStream<Uint8Array>({
				pull(controller) {
					if (index < frames.length) controller.enqueue(frames[index++]!);
					else controller.close();
				},
			});
			return new Response(body, {
				status: 200,
				headers: { "content-type": "application/vnd.amazon.eventstream" },
			});
		},
		{ preconnect: fetch.preconnect },
	) as FetchImpl;
}

export function bedrockTestModel(
	overrides?: Partial<ModelSpec<"bedrock-converse-stream">>,
): Model<"bedrock-converse-stream"> {
	return buildModel({
		id: "anthropic.claude-3-5-sonnet-20241022-v2:0",
		name: "Claude 3.5 Sonnet",
		api: "bedrock-converse-stream",
		provider: "amazon-bedrock",
		baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 8_192,
		...overrides,
	});
}

export const BEDROCK_TEST_CONTEXT: Context = {
	messages: [{ role: "user", content: "hi", timestamp: 0 }],
};
