import { describe, expect, it } from "bun:test";
import { streamOllama } from "@oh-my-pi/pi-ai/providers/ollama";
import type { AssistantMessageEvent, Context } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

const model = buildModel({
	id: "qwen3:8b",
	name: "Qwen 3 8B",
	api: "ollama-chat",
	provider: "ollama",
	baseUrl: "http://127.0.0.1:11434",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 32_768,
	maxTokens: 8192,
});
const context: Context = {
	messages: [{ role: "user", content: "List the files in the current directory.", timestamp: 0 }],
};
const errorMessage = "an error was encountered while running the model";
const errorFrame = `${JSON.stringify({ error: errorMessage })}\n`;

describe("Ollama in-band stream errors", () => {
	it("surfaces an error-only response instead of retrying it as an empty completion", async () => {
		let requests = 0;
		const result = await streamOllama(model, context, {
			apiKey: "ollama",
			fetch: async () => {
				requests++;
				return new Response(errorFrame, { headers: { "Content-Type": "application/x-ndjson" } });
			},
		}).result();

		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain(errorMessage);
		expect(result.errorStatus).toBeUndefined();
		expect(requests).toBe(1);
	});

	it("reports a mid-stream failure rather than completing the partial answer", async () => {
		const stream = streamOllama(model, context, {
			apiKey: "ollama",
			fetch: async () =>
				new Response(`${JSON.stringify({ message: { content: "The files are" }, done: false })}\n${errorFrame}`),
		});
		const events: AssistantMessageEvent[] = [];
		for await (const event of stream) events.push(event);
		const result = await stream.result();

		expect(events.some(event => event.type === "text_delta" && event.delta === "The files are")).toBe(true);
		expect(events.at(-1)?.type).toBe("error");
		expect(events.some(event => event.type === "done")).toBe(false);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain(errorMessage);
	});

	it("does not promote tool calls from a failed stream to a successful tool-use turn", async () => {
		const result = await streamOllama(model, context, {
			apiKey: "ollama",
			fetch: async () =>
				new Response(
					`${JSON.stringify({
						message: { tool_calls: [{ function: { name: "bash", arguments: { command: "ls" } } }] },
						done: false,
					})}\n${errorFrame}`,
				),
		}).result();

		expect(result.content).toContainEqual(
			expect.objectContaining({ type: "toolCall", name: "bash", arguments: { command: "ls" } }),
		);
		expect(result.stopReason).toBe("error");
		expect(result.errorMessage).toContain(errorMessage);
	});
});
