// Regression: sessions that inline the tool catalog into the system prompt
// (`inlineToolDescriptors`, e.g. a session started on Gemini and then switched
// to Bedrock) prune every tool description to "". Bedrock's ToolSpecification
// treats `description` as optional but enforces minLength 1 when present, so
// serializing the pruned "" made AWS reject the whole request with HTTP 400.
// The provider must omit the key instead of sending an empty string.
import { describe, expect, it, vi } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { streamBedrock } from "@oh-my-pi/pi-ai/providers/amazon-bedrock";
import type { Context, Model, Tool } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

interface SentToolSpec {
	name: string;
	description?: string;
	inputSchema: { json: { type?: string; properties?: Record<string, unknown> } };
}

interface SentBody {
	toolConfig: { tools: Array<{ toolSpec: SentToolSpec }> };
}

const model: Model<"bedrock-converse-stream"> = buildModel({
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

// Capture the bytes actually sent to AWS. The response is an empty event
// stream: the fetch (and thus the body capture) happens before any response
// parsing, and the stream's outcome is irrelevant to the assertion.
async function captureSentBody(tools: Tool[]): Promise<SentBody> {
	const { promise, resolve } = Promise.withResolvers<SentBody>();
	const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
		const body = init?.body;
		const text = body instanceof Uint8Array ? new TextDecoder().decode(body) : String(body);
		resolve(JSON.parse(text) as SentBody);
		return new Response(
			new ReadableStream<Uint8Array>({
				start(controller) {
					controller.close();
				},
			}),
			{ status: 200, headers: { "content-type": "application/vnd.amazon.eventstream" } },
		);
	}) as unknown as typeof fetch;

	const context: Context = { messages: [{ role: "user", content: "hi", timestamp: 0 }], tools };
	const stream = streamBedrock(model, context, { bearerToken: "test-token", fetch: fetchMock });
	void (async () => {
		try {
			for await (const _ of stream) {
				// ignore events
			}
		} catch {
			// empty event stream: stream errors are expected and irrelevant
		}
	})();

	return promise;
}

describe("bedrock tool description serialization", () => {
	it('omits a pruned empty description instead of sending description: ""', async () => {
		const body = await captureSentBody([
			{ name: "read", description: "", parameters: type({ path: "string" }) },
			{ name: "write", description: "Write a file", parameters: type({ path: "string" }) },
		]);

		const [pruned, described] = body.toolConfig.tools.map(tool => tool.toolSpec);
		// AWS ToolSpecification.description: optional, minLength 1 when present.
		expect(pruned).not.toHaveProperty("description");
		expect(pruned.name).toBe("read");
		expect(pruned.inputSchema.json.type).toBe("object");
		expect(pruned.inputSchema.json.properties).toHaveProperty("path");
		// Non-empty descriptions still ride the wire verbatim.
		expect(described.description).toBe("Write a file");
	});
});
