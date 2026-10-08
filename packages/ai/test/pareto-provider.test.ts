import { describe, expect, it } from "bun:test";
import { Effort, type FetchImpl } from "@oh-my-pi/pi-ai";
import { streamSimple } from "@oh-my-pi/pi-ai/stream";
import type { Context, Model, Tool } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { seedModels } from "@oh-my-pi/pi-catalog/compat/providers";

/**
 * Top-level request fields Pareto documents (docs.paretoinference.com/api-reference,
 * "Request parameters"); it supports no others. Z.ai's native `thinking`
 * toggle returns HTTP 400 `unsupported_parameter`.
 */
const PARETO_REQUEST_FIELDS = new Set([
	"model",
	"messages",
	"stream",
	"stream_options",
	"max_tokens",
	"max_completion_tokens",
	"temperature",
	"top_p",
	"top_k",
	"min_p",
	"repetition_penalty",
	"stop",
	"seed",
	"tools",
	"tool_choice",
	"parallel_tool_calls",
	"store",
	"prompt_cache_key",
	"user",
	"response_format",
	"frequency_penalty",
	"presence_penalty",
	"logprobs",
	"top_logprobs",
	"reasoning_effort",
]);

const readTool: Tool = {
	name: "read",
	description: "Read a file",
	parameters: {
		type: "object",
		properties: { path: { type: "string" } },
		required: ["path"],
	} as Tool["parameters"],
};

const context: Context = {
	systemPrompt: ["You are a coding agent."],
	messages: [{ role: "user", content: "Read README.md", timestamp: 0 }],
	tools: [readTool],
};

function paretoModel(): Model<"openai-completions"> {
	const seed = seedModels<"openai-completions">("pareto").find(model => model.id === "z-ai/glm-5.3-flash");
	if (!seed) throw new Error("missing pareto seed row");
	return buildModel(seed);
}

async function captureRequest(options: {
	reasoning?: Effort;
	disableReasoning?: boolean;
}): Promise<{ url: string; body: Record<string, unknown> }> {
	let url: string | undefined;
	let body: Record<string, unknown> | undefined;
	const fetchMock: FetchImpl = (input, init) => {
		url = String(input);
		body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<string, unknown>;
		return Promise.resolve(
			new Response(
				'data: {"choices":[{"delta":{"content":"ok"}}]}\ndata: {"choices":[{"finish_reason":"stop"}]}\ndata: [DONE]\n',
				{ status: 200, headers: { "content-type": "text/event-stream" } },
			),
		);
	};
	await streamSimple(paretoModel(), context, {
		apiKey: "test-key",
		fetch: fetchMock,
		sessionId: "session-1",
		...options,
	}).result();
	if (!url || !body) throw new Error("request was not captured");
	return { url, body };
}

describe("Pareto Inference wire contract", () => {
	it("streams GLM 5.3 Flash with reasoning only as reasoning_effort and no undocumented fields", async () => {
		const { url, body } = await captureRequest({ reasoning: Effort.Max });

		expect(url).toBe("https://api.paretoinference.com/v1/chat/completions");
		expect(body).toMatchObject({ model: "z-ai/glm-5.3-flash", stream: true, reasoning_effort: "max" });
		expect(Object.keys(body).filter(field => !PARETO_REQUEST_FIELDS.has(field))).toEqual([]);
	});

	it("turns thinking-off into the lowest effort rather than a `thinking` toggle Pareto rejects", async () => {
		const { body } = await captureRequest({ disableReasoning: true });

		expect(body.reasoning_effort).toBe("low");
		expect(Object.keys(body).filter(field => !PARETO_REQUEST_FIELDS.has(field))).toEqual([]);
	});
});
