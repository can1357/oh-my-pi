import { afterEach, describe, expect, test } from "bun:test";
import { Effort } from "@pk-nerdsaver-ai/pi-ai";
import type { DevinOptions } from "@pk-nerdsaver-ai/pi-ai/providers/devin";
import { setDevinProviderModule } from "@pk-nerdsaver-ai/pi-ai/providers/register-builtins";
import { stream, streamSimple } from "@pk-nerdsaver-ai/pi-ai/stream";
import type { AssistantMessage, Context, Model } from "@pk-nerdsaver-ai/pi-ai/types";
import { AssistantMessageEventStream } from "@pk-nerdsaver-ai/pi-ai/utils/event-stream";
import { buildModel } from "@pk-nerdsaver-ai/pi-catalog/build";

const model = {
	...buildModel({
		id: "swe-1-6",
		name: "SWE 1.6",
		api: "devin-agent",
		provider: "devin",
		baseUrl: "https://example.invalid",
		requestModelId: "swe-1-6-wire",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 64_000,
	}),
	thinking: {
		mode: "effort",
		efforts: ["low", "high"],
		effortRouting: { off: "swe-1-6-wire", high: "swe-1-6-thinking-high" },
	},
} as Model<"devin-agent">;

const context: Context = {
	messages: [{ role: "user", content: "hello", timestamp: 0 }],
};

function completedStream(): AssistantMessageEventStream {
	const source = new AssistantMessageEventStream();
	const message: AssistantMessage = {
		role: "assistant",
		content: [{ type: "text", text: "ok" }],
		api: "devin-agent",
		provider: "devin",
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
	queueMicrotask(() => source.end(message));
	return source;
}

afterEach(() => setDevinProviderModule(undefined));

describe("Devin generic stream dispatch", () => {
	test("stream routes devin-agent through the lazy Devin provider", async () => {
		let received: DevinOptions | undefined;
		setDevinProviderModule({
			streamDevin: (_model, _context, options) => {
				received = options;
				return completedStream();
			},
		});

		await stream(model, context, { apiKey: "token", conversationId: "conversation" }).result();

		expect(received?.apiKey).toBe("token");
		expect(received?.conversationId).toBe("conversation");
	});

	test("streamSimple maps shared options to Devin options", async () => {
		let received: DevinOptions | undefined;
		setDevinProviderModule({
			streamDevin: (_model, _context, options) => {
				received = options;
				return completedStream();
			},
		});

		await streamSimple(model, context, {
			apiKey: "token",
			sessionId: "session",
			reasoning: Effort.High,
			stopSequences: ["<stop>"],
		}).result();

		expect(received?.apiKey).toBe("token");
		expect(received?.sessionId).toBe("session");
		expect(received?.chatModelUid).toBe("swe-1-6-thinking-high");
		expect(received?.stopSequences).toEqual(["<stop>"]);
	});

	test("ignores shared reasoning for a non-reasoning Devin fallback", async () => {
		let received: DevinOptions | undefined;
		setDevinProviderModule({
			streamDevin: (_model, _context, options) => {
				received = options;
				return completedStream();
			},
		});
		const nonReasoningModel: Model<"devin-agent"> = {
			...model,
			reasoning: false,
			thinking: undefined,
		};

		await streamSimple(nonReasoningModel, context, { apiKey: "token", reasoning: Effort.High }).result();

		expect(received?.chatModelUid).toBe("swe-1-6-wire");
	});
});
