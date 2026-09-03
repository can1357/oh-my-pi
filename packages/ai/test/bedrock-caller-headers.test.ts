import { describe, expect, it } from "bun:test";
import { streamBedrock } from "@oh-my-pi/pi-ai/providers/amazon-bedrock";
import { crc32 } from "@oh-my-pi/pi-ai/providers/aws-eventstream";
import type { Context, FetchImpl, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

// Caller headers (including `before_provider_headers` extension edits) reach the
// Bedrock request, but SigV4's own headers must never come from the caller:
// `signRequest` signs the caller's value and then RETURNS its own, so the wire
// would carry different bytes than the signature covers and Bedrock would reject
// every request. Exercised through the real signing path, not a unit stub.

/**
 * Run `body` with dummy AWS credentials, restoring the environment immediately.
 *
 * Scoped to the one test rather than the file: a `beforeAll` override leaves
 * every later Bedrock file in the same Bun process on the dummy-credential path
 * until `afterAll` runs, which is the full-suite hazard `AGENTS.md` rules out.
 */
async function withSkippedAuth<T>(body: () => Promise<T>): Promise<T> {
	const originalSkipAuth = process.env.AWS_BEDROCK_SKIP_AUTH;
	const originalBearerToken = process.env.AWS_BEARER_TOKEN_BEDROCK;
	process.env.AWS_BEDROCK_SKIP_AUTH = "1";
	delete process.env.AWS_BEARER_TOKEN_BEDROCK;
	try {
		return await body();
	} finally {
		if (originalSkipAuth === undefined) delete process.env.AWS_BEDROCK_SKIP_AUTH;
		else process.env.AWS_BEDROCK_SKIP_AUTH = originalSkipAuth;
		if (originalBearerToken === undefined) delete process.env.AWS_BEARER_TOKEN_BEDROCK;
		else process.env.AWS_BEARER_TOKEN_BEDROCK = originalBearerToken;
	}
}

function encodeFrame(headers: Record<string, string>, payload: Uint8Array): Uint8Array {
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

function bedrockEvent(eventType: string, payload: string): Uint8Array {
	return encodeFrame({ ":message-type": "event", ":event-type": eventType }, new TextEncoder().encode(payload));
}

/** Captures the headers actually sent, and replies with a minimal valid stream. */
function capturingFetch(seen: { headers?: Record<string, string> }): FetchImpl {
	const frames = [
		bedrockEvent("messageStart", '{"role":"assistant"}'),
		bedrockEvent("contentBlockDelta", '{"contentBlockIndex":0,"delta":{"text":"hi"}}'),
		bedrockEvent("contentBlockStop", '{"contentBlockIndex":0}'),
		bedrockEvent("messageStop", '{"stopReason":"end_turn"}'),
		bedrockEvent("metadata", '{"usage":{"inputTokens":1,"outputTokens":1,"totalTokens":2}}'),
	];
	return Object.assign(
		async (_input: string | URL | Request, init?: RequestInit) => {
			seen.headers = (init?.headers ?? {}) as Record<string, string>;
			let index = 0;
			const body = new ReadableStream<Uint8Array>({
				pull(controller) {
					if (index < frames.length) controller.enqueue(frames[index++]!);
					else controller.close();
				},
			});
			return new Response(body, { status: 200, headers: { "content-type": "application/vnd.amazon.eventstream" } });
		},
		{ preconnect: fetch.preconnect },
	);
}

function model(): Model<"bedrock-converse-stream"> {
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
	});
}

const context: Context = { messages: [{ role: "user", content: "hi", timestamp: 0 }] };

describe("Bedrock caller headers", () => {
	it("forwards caller headers but never lets them supply SigV4's own", async () => {
		const seen: { headers?: Record<string, string> } = {};
		await withSkippedAuth(async () => {
			const stream = streamBedrock(model(), context, {
				region: "us-east-1",
				fetch: capturingFetch(seen),
				headers: {
					"x-trace": "kept",
					// Every header SigV4 generates for itself. Signed as the caller's value
					// but sent as the signer's, these would break the signature.
					host: "evil.example.com",
					"x-amz-date": "19700101T000000Z",
					"x-amz-content-sha256": "deadbeef",
					"x-amz-security-token": "forged",
				},
			});
			await stream.result();
		});

		const headers = seen.headers ?? {};
		// The benign caller header still reaches the request: that is the feature.
		expect(headers["x-trace"]).toBe("kept");
		// None of the signer-owned values are the caller's.
		expect(headers.host).not.toBe("evil.example.com");
		expect(headers["x-amz-date"]).not.toBe("19700101T000000Z");
		expect(headers["x-amz-content-sha256"]).not.toBe("deadbeef");
		expect(headers["x-amz-security-token"]).not.toBe("forged");
		// And the request was actually signed, so this is the real path.
		expect(headers.authorization ?? headers.Authorization).toContain("AWS4-HMAC-SHA256");
	});

	// A caller spelling differing only in case leaves two object keys: SigV4 signs
	// one, fetch comma-joins both onto the wire, and AWS rejects the mismatch.
	it("does not leave a differently cased duplicate of a header it sets itself", async () => {
		const seen: { headers?: Record<string, string> } = {};
		await withSkippedAuth(async () => {
			const stream = streamBedrock(model(), context, {
				region: "us-east-1",
				fetch: capturingFetch(seen),
				headers: {
					"Content-Type": "text/plain",
					Accept: "text/plain",
					Host: "evil.example.com",
					// Recomputed by the fetch layer from the serialized body, so a caller
					// value would be signed but never sent.
					"Content-Length": "999",
					"X-Trace": "kept",
				},
			});
			await stream.result();
		});

		const headers = seen.headers ?? {};
		const names = Object.keys(headers).map(name => name.toLowerCase());
		// Each field appears exactly once, whatever casing the caller used.
		for (const field of ["content-type", "accept", "host", "content-length"]) {
			expect(names.filter(name => name === field).length).toBeLessThanOrEqual(1);
		}
		expect(headers["content-type"]).toBe("application/json");
		// Ordinary caller headers still land, lower-cased.
		expect(headers["x-trace"]).toBe("kept");
	});
});
