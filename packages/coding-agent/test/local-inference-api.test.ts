import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import {
	type AssistantMessage,
	type AssistantMessageEvent,
	completeSimple,
	type Context,
	streamSimple,
	type Usage,
	type UserMessage,
} from "@oh-my-pi/pi-ai";
import { unregisterCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import {
	buildLocalInferenceMessages,
	registerLocalInferenceApi,
} from "@oh-my-pi/pi-coding-agent/tiny/local-inference-api";
import { TINY_LOCAL_MODELS } from "@oh-my-pi/pi-coding-agent/tiny/models";
import {
	type TinyModelChatOptions,
	TinyTitleClient,
	tinyModelClient,
} from "@oh-my-pi/pi-coding-agent/tiny/title-client";
import type {
	TinyChatMessage,
	TinyWorkerRequest,
	TinyWorkerResponse,
} from "@oh-my-pi/pi-coding-agent/tiny/title-protocol";

const SOURCE_ID = "omp/local-inference";
const model = getBundledModel("local", "lfm2.5-230m")!;

function zeroUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function assistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "local-inference",
		provider: "local",
		model: model.id,
		usage: zeroUsage(),
		stopReason: "stop",
		timestamp: 2,
	};
}

function userMessage(content: string, timestamp = 1): UserMessage {
	return { role: "user", content, timestamp };
}

async function collectEvents(stream: AsyncIterable<AssistantMessageEvent>): Promise<AssistantMessageEvent[]> {
	const events: AssistantMessageEvent[] = [];
	for await (const event of stream) events.push(event);
	return events;
}

class FakeTinyWorker {
	terminated = false;
	refCalls = 0;
	unrefCalls = 0;
	#messageHandlers = new Set<(message: TinyWorkerResponse) => void>();
	#errorHandlers = new Set<(error: Error) => void>();
	#onSend: (message: TinyWorkerRequest, worker: FakeTinyWorker) => void;

	constructor(onSend: (message: TinyWorkerRequest, worker: FakeTinyWorker) => void) {
		this.#onSend = onSend;
	}

	send(message: TinyWorkerRequest): void {
		this.#onSend(message, this);
	}

	onMessage(handler: (message: TinyWorkerResponse) => void): () => void {
		this.#messageHandlers.add(handler);
		return () => this.#messageHandlers.delete(handler);
	}

	onError(handler: (error: Error) => void): () => void {
		this.#errorHandlers.add(handler);
		return () => this.#errorHandlers.delete(handler);
	}

	async terminate(): Promise<void> {
		this.terminated = true;
	}

	ref(): void {
		this.refCalls += 1;
	}

	unref(): void {
		this.unrefCalls += 1;
	}

	emit(message: TinyWorkerResponse): void {
		for (const handler of this.#messageHandlers) handler(message);
	}
}

describe("local inference API", () => {
	beforeEach(() => registerLocalInferenceApi());

	afterEach(() => {
		vi.restoreAllMocks();
		unregisterCustomApis(SOURCE_ID);
	});

	it("flattens assistant context into following user turns and completes through the registered API", async () => {
		let requestedModel: string | undefined;
		let requestedMessages: readonly TinyChatMessage[] | undefined;
		let requestedOptions: TinyModelChatOptions | undefined;
		vi.spyOn(tinyModelClient, "chat").mockImplementation(async (modelKey, messages, options) => {
			requestedModel = modelKey;
			requestedMessages = messages;
			requestedOptions = options;
			return "local answer";
		});
		const context: Context = {
			systemPrompt: ["first system", "second system"],
			messages: [
				userMessage("first user"),
				assistantMessage("assistant context"),
				userMessage("next user", 3),
				assistantMessage("trailing assistant"),
			],
		};

		const result = await completeSimple(model, context, { maxTokens: 37 });

		expect(requestedModel).toBe("lfm2.5-230m");
		expect(requestedMessages).toEqual([
			{ role: "system", content: "first system" },
			{ role: "system", content: "second system" },
			{ role: "user", content: "first user" },
			{ role: "user", content: "assistant context\n\nnext user" },
			{ role: "user", content: "trailing assistant" },
		]);
		expect(requestedOptions).toMatchObject({ maxTokens: 37 });
		expect(result).toMatchObject({
			content: [{ type: "text", text: "local answer" }],
			stopReason: "stop",
			usage: zeroUsage(),
		});
	});

	it("emits the complete assistant text event sequence", async () => {
		vi.spyOn(tinyModelClient, "chat").mockResolvedValue("local answer");
		const stream = streamSimple(model, { messages: [userMessage("question")] });
		const events = await collectEvents(stream);
		const result = await stream.result();

		expect(events.map(event => event.type)).toEqual(["start", "text_start", "text_delta", "text_end", "done"]);
		expect(events[2]).toMatchObject({ type: "text_delta", contentIndex: 0, delta: "local answer" });
		expect(result).toMatchObject({
			content: [{ type: "text", text: "local answer" }],
			stopReason: "stop",
			usage: zeroUsage(),
		});
	});

	it("emits an error instead of a successful empty completion when the worker produces no output", async () => {
		vi.spyOn(tinyModelClient, "chat").mockResolvedValue(null);
		const stream = streamSimple(model, { messages: [userMessage("question")] });
		const events = await collectEvents(stream);
		const result = await stream.result();

		expect(events.map(event => event.type)).toEqual(["start", "error"]);
		expect(events.at(-1)).toMatchObject({
			type: "error",
			reason: "error",
			error: { stopReason: "error", errorMessage: "Local inference returned no output." },
		});
		expect(result).toMatchObject({ stopReason: "error", content: [], usage: zeroUsage() });
	});

	it("keeps cancellation distinct from worker failure", async () => {
		vi.spyOn(tinyModelClient, "chat").mockImplementation(async (_modelKey, _messages, options) => {
			const signal = options?.signal;
			if (!signal) throw new Error("missing test signal");
			if (!signal.aborted) {
				await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
			}
			return null;
		});
		const controller = new AbortController();
		const stream = streamSimple(model, { messages: [userMessage("question")] }, { signal: controller.signal });
		controller.abort(new Error("cancelled locally"));
		const events = await collectEvents(stream);
		const result = await stream.result();

		expect(events.map(event => event.type)).toEqual(["start", "error"]);
		expect(events.at(-1)).toMatchObject({
			type: "error",
			reason: "aborted",
			error: { stopReason: "aborted", errorMessage: "cancelled locally" },
		});
		expect(result.stopReason).toBe("aborted");
	});

	it("rejects non-tiny local models before invoking the worker client", async () => {
		const chat = vi.spyOn(tinyModelClient, "chat").mockResolvedValue("should not run");
		const nonTinyModel = getBundledModel("local", "kokoro")!;
		const stream = streamSimple(nonTinyModel, { messages: [userMessage("question")] });
		const result = await stream.result();

		expect(chat).not.toHaveBeenCalled();
		expect(result).toMatchObject({ stopReason: "error", content: [] });
	});

	it("builds worker messages without dropping text-only structured content", () => {
		expect(
			buildLocalInferenceMessages({
				messages: [
					{ role: "developer", content: [{ type: "text", text: "developer instruction" }], timestamp: 1 },
					{ role: "user", content: [{ type: "text", text: "structured user" }], timestamp: 2 },
				],
			}),
		).toEqual([
			{ role: "system", content: "developer instruction" },
			{ role: "user", content: "structured user" },
		]);
	});
});

describe("tiny model chat client", () => {
	it("accepts every local tiny model key and clamps requested output tokens", async () => {
		const connected: string[] = [];
		const requests: TinyWorkerRequest[] = [];
		const client = new TinyTitleClient(async modelKey => {
			connected.push(modelKey);
			return new FakeTinyWorker((request, worker) => {
				requests.push(request);
				if (request.type === "chat") worker.emit({ type: "text", id: request.id, text: modelKey });
			});
		});

		try {
			for (const [index, spec] of TINY_LOCAL_MODELS.entries()) {
				const maxTokens = index === 0 ? 0 : 100_000;
				expect(await client.chat(spec.key, [{ role: "user", content: "hello" }], { maxTokens })).toBe(spec.key);
			}
			expect(connected).toEqual(TINY_LOCAL_MODELS.map(spec => spec.key));
			expect(requests.map(request => (request.type === "chat" ? request.maxNewTokens : undefined))).toEqual([
				1,
				...TINY_LOCAL_MODELS.slice(1).map(() => 1024),
			]);
		} finally {
			await client.terminate();
		}
	});

	it("resolves an in-flight chat as null when its signal aborts", async () => {
		const worker = new FakeTinyWorker(() => {});
		const client = new TinyTitleClient(async () => worker);
		const controller = new AbortController();

		try {
			const completion = client.chat("lfm2.5-230m", [{ role: "user", content: "hello" }], {
				signal: controller.signal,
			});
			controller.abort();

			expect(await completion).toBeNull();
		} finally {
			await client.terminate();
		}
	});

	it("prewarms and generates titles with memory-group tiny models", async () => {
		const firstRequest = Promise.withResolvers<TinyWorkerRequest>();
		const worker = new FakeTinyWorker((request, current) => {
			firstRequest.resolve(request);
			if (request.type === "chat")
				current.emit({ type: "text", id: request.id, text: "Memory Model Title</title>" });
		});
		const client = new TinyTitleClient(async () => worker);

		try {
			client.prewarm("qwen3-1.7b");
			expect(await firstRequest.promise).toMatchObject({ type: "ping" });
			expect(await client.generate("qwen3-1.7b", "title this session")).toBe("Memory Model Title");
		} finally {
			await client.terminate();
		}
	});
});
