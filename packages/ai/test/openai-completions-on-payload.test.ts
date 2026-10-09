// Regression: openai-completions ignored the onPayload replacement return
// value (fire-and-forget), so extensions hooking before_provider_request
// could never transform the body actually sent upstream. The replacement
// contract matches anthropic / openai-responses / google: await the hook,
// and use its non-undefined return as the request body.
import { describe, expect, it } from "bun:test";
import { streamOpenAICompletions } from "@oh-my-pi/pi-ai/providers/openai-completions";
import type { Context, FetchImpl, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";

const completionsModel = {
	...(getBundledModel("openai", "gpt-4o-mini") as Model<"openai-completions">),
	api: "openai-completions",
} satisfies Model<"openai-completions">;

function baseContext(): Context {
	return {
		messages: [{ role: "user", content: "Say hello", timestamp: Date.now() }],
	};
}

function createSseFetch(capture?: (body: unknown) => void): FetchImpl {
	async function mockFetch(_input: string | URL | Request, init?: RequestInit): Promise<Response> {
		capture?.(typeof init?.body === "string" ? JSON.parse(init.body) : undefined);
		const encoder = new TextEncoder();
		const chunk = (extra: Record<string, unknown>) =>
			`data: ${JSON.stringify({ id: "chatcmpl-payload", object: "chat.completion.chunk", created: 0, model: completionsModel.id, ...extra })}\n\n`;
		const sse =
			chunk({ choices: [{ index: 0, delta: { role: "assistant", content: "ok" } }] }) +
			chunk({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }) +
			"data: [DONE]\n\n";
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(encoder.encode(sse));
				controller.close();
			},
		});
		return new Response(stream, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});
	}
	return mockFetch as typeof fetch;
}

type Body = Record<string, any>;

describe("openai-completions onPayload replacement", () => {
	it("sends an async onPayload replacement body", async () => {
		let captured: Body | undefined;
		const result = await streamOpenAICompletions(completionsModel, baseContext(), {
			apiKey: "test-key",
			fetch: createSseFetch(body => (captured = body as Body)),
			onPayload: async payload => ({
				...(payload as Record<string, unknown>),
				messages: [{ role: "user", content: "replacement" }],
			}),
		}).result();

		expect(result.stopReason).toBe("stop");
		expect(captured?.messages).toEqual([{ role: "user", content: "replacement" }]);
		expect(JSON.stringify(captured)).not.toContain("Say hello");
	}, 10_000);

	it("sends a synchronous onPayload replacement body", async () => {
		let captured: Body | undefined;
		await streamOpenAICompletions(completionsModel, baseContext(), {
			apiKey: "test-key",
			fetch: createSseFetch(body => (captured = body as Body)),
			onPayload: payload => ({
				...(payload as Record<string, unknown>),
				messages: [{ role: "user", content: "sync-replacement" }],
			}),
		}).result();

		expect(captured?.messages).toEqual([{ role: "user", content: "sync-replacement" }]);
	}, 10_000);

	it("keeps the original body when onPayload returns undefined", async () => {
		let captured: Body | undefined;
		await streamOpenAICompletions(completionsModel, baseContext(), {
			apiKey: "test-key",
			fetch: createSseFetch(body => (captured = body as Body)),
			onPayload: async () => undefined,
		}).result();

		expect(JSON.stringify(captured?.messages)).toContain("Say hello");
	}, 10_000);
});

describe("openai-completions governed payload selection", () => {
	const model = buildModel({
		provider: "payload-selection-test",
		id: "bound-model",
		name: "Bound model",
		api: "openai-completions",
		baseUrl: "http://127.0.0.1:1/v1",
		reasoning: true,
		thinking: { mode: "effort", efforts: [Effort.Low, Effort.High] },
		input: ["text"],
		supportsTools: true,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 8192,
		compat: { supportsReasoningEffort: true, thinkingFormat: "openai" },
	});

	for (const field of ["models", "fallbacks"] as const) {
		it(`rejects baseline extraBody ${field} alternatives rather than dropping them`, async () => {
			let requests = 0;
			const configured = {
				...model,
				compat: { ...model.compat, extraBody: { [field]: [model.id, "catalog-outsider"] } },
			};
			const result = await streamOpenAICompletions(configured, baseContext(), {
				apiKey: "test-key",
				fetch: createSseFetch(() => requests++),
				reasoning: Effort.High,
				preserveModelSelection: true,
			}).result();
			expect(result.stopReason).toBe("error");
			expect(requests).toBe(0);
		});
	}

	for (const change of ["model", "reasoning_effort", "models", "fallbacks"] as const) {
		it(`rejects a late in-place ${change} rewrite before sending a governed request`, async () => {
			let requests = 0;
			const result = await streamOpenAICompletions(model, baseContext(), {
				apiKey: "test-key",
				fetch: createSseFetch(() => requests++),
				reasoning: Effort.High,
				preserveModelSelection: true,
				onPayload: payload => {
					Object.assign(payload as Record<string, unknown>, {
						[change]:
							change === "models" || change === "fallbacks"
								? [model.id, "catalog-outsider"]
								: change === "model"
									? "catalog-outsider"
									: Effort.Low,
					});
				},
			}).result();
			expect(result.stopReason).toBe("error");
			expect(requests).toBe(0);
		});
	}

	it("rejects a replacement body that discards governed controls", async () => {
		let requests = 0;
		const result = await streamOpenAICompletions(model, baseContext(), {
			apiKey: "test-key",
			fetch: createSseFetch(() => requests++),
			reasoning: Effort.High,
			preserveModelSelection: true,
			onPayload: () => [],
		}).result();
		expect(result.stopReason).toBe("error");
		expect(requests).toBe(0);
	});
});
