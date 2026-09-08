import { afterEach, describe, expect, it, vi } from "bun:test";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
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
	options: {
		reasoning?: Effort;
		disableReasoning?: boolean;
		forceReasoningOff?: boolean;
		openrouterVariant?: string;
		toolChoice?: { type: "tool"; name: string };
	} = {},
	context = ctx,
): Promise<Record<string, unknown>> {
	const { fetchMock, captured } = mockSseFetch();
	const stream = streamSimple(model, context, { apiKey: "k", fetch: fetchMock, temperature: 0, ...options });
	for await (const event of stream) {
		if (event.type === "done" || event.type === "error") break;
	}
	return captured;
}

afterEach(() => {
	vi.restoreAllMocks();
});

function routedModel(): Model<"openai-responses"> {
	const model = getBundledModel("openai", "gpt-5") as Model<"openai-responses">;
	return {
		...model,
		id: "logical-model",
		requestModelId: "fallback-model",
		thinking: {
			...model.thinking!,
			effortMap: { ...model.thinking?.effortMap, max: "high" },
			effortRouting: { off: "standard-model", low: "low-model", max: "max-model" },
		},
	};
}

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

	it("routes by internal effort before mapping the outgoing effort", async () => {
		const body = await drain(routedModel(), { reasoning: Effort.Max });
		expect(body.model).toBe("max-model");
		expect(body.reasoning).toMatchObject({ effort: "high" });
	});

	it("uses an unmapped route fallback and applies the host transform after routing", async () => {
		const model = routedModel();
		const fallback = await drain(
			{
				...model,
				thinking: { ...model.thinking!, effortRouting: { off: "standard-model", max: "max-model" } },
			},
			{ reasoning: Effort.Low },
		);
		expect(fallback.model).toBe("fallback-model");

		const transformed = await drain(
			{ ...model, compat: { ...model.compat, wireModelIdMode: "openrouter" } },
			{ reasoning: Effort.Max, openrouterVariant: "floor" },
		);
		expect(transformed.model).toBe("max-model:floor");
	});

	it("routes disabled reasoning to off", async () => {
		const model = routedModel();
		expect((await drain(model, { reasoning: Effort.Max, disableReasoning: true })).model).toBe("standard-model");
		expect((await drain(model, { reasoning: Effort.Max, forceReasoningOff: true })).model).toBe("standard-model");
	});

	it("uses mandatory reasoning normalization before routing", async () => {
		const model = routedModel();
		const body = await drain(
			{ ...model, thinking: { ...model.thinking!, efforts: [Effort.Low, Effort.Max], requiresEffort: true } },
			{ forceReasoningOff: true },
		);
		expect(body.model).toBe("low-model");
	});

	it("routes from the final policy after forced tool choice suppresses reasoning", async () => {
		const model = routedModel();
		const context: Context = {
			...ctx,
			tools: [{ name: "lookup", description: "Lookup", parameters: { type: "object", properties: {} } }],
		};
		const body = await drain(
			{
				...model,
				compat: { ...model.compat, disableReasoningOnForcedToolChoice: true, supportsForcedToolChoice: true },
			},
			{ reasoning: Effort.Max, toolChoice: { type: "tool", name: "lookup" } },
			context,
		);
		expect(body.model).toBe("standard-model");
	});
});
