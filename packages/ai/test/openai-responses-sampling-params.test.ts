import { afterEach, describe, expect, it, vi } from "bun:test";
import { streamSimple } from "@oh-my-pi/pi-ai/stream";
import type { Context, FetchImpl, Model } from "@oh-my-pi/pi-ai/types";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";

function mockSseFetch(): { fetchMock: FetchImpl; captured: Record<string, unknown> } {
	const captured: Record<string, unknown> = {};
	const fetchMock: FetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
		const body = typeof init?.body === "string" ? (JSON.parse(init.body) as Record<string, unknown>) : {};
		Object.assign(captured, body);
		const event = {
			type: "response.completed",
			response: {
				status: "completed",
				usage: {
					input_tokens: 1,
					output_tokens: 1,
					total_tokens: 2,
					input_tokens_details: { cached_tokens: 0 },
				},
			},
		};
		return new Response(`data: ${JSON.stringify(event)}\n\n`, {
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});
	});
	return { fetchMock, captured };
}

const ctx: Context = {
	systemPrompt: ["hi"],
	messages: [{ role: "user", content: "ping", timestamp: Date.now() }],
};

async function drain(
	model: Model<"openai-responses">,
	options: { forceReasoningOff?: boolean } = {},
): Promise<Record<string, unknown>> {
	const { fetchMock, captured } = mockSseFetch();
	const stream = streamSimple(model, ctx, { apiKey: "k", fetch: fetchMock, temperature: 0, ...options });
	for await (const event of stream) {
		if (event.type === "done" || event.type === "error") break;
	}
	return captured;
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("openai-responses sampling-param gating (#5606)", () => {
	it("omits temperature for OpenAI reasoning models that reject it", async () => {
		const model = getBundledModel("openai", "gpt-5") as Model<"openai-responses">;
		expect(model.compat.supportsSamplingParams).toBe(false);
		const body = await drain(model);
		expect(body).not.toHaveProperty("temperature");
	});

	it("omits temperature for GitHub Copilot gpt-5.6 (the reported model)", async () => {
		const model = getBundledModel("github-copilot", "gpt-5.6-luna") as Model<"openai-responses">;
		expect(model.compat.supportsSamplingParams).toBe(false);
		const body = await drain(model);
		expect(body).not.toHaveProperty("temperature");
	});

	it("still forwards temperature for non-restricted OpenAI models", async () => {
		const model = getBundledModel("openai", "gpt-4o-mini") as Model<"openai-responses">;
		expect(model.compat.supportsSamplingParams).toBe(true);
		const body = await drain(model);
		expect(body.temperature).toBe(0);
	});

	it("disables native reasoning with effort none when an external scratchpad replaces it", async () => {
		const model = getBundledModel("openai", "gpt-5") as Model<"openai-responses">;
		const body = await drain(model, { forceReasoningOff: true });
		expect(body.reasoning).toEqual({ effort: "none" });
	});
});
