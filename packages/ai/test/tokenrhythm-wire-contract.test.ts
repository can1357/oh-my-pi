/**
 * Wire-contract tests for TokenRhythm's OpenAI-compatible chat endpoint,
 * pinned to behavior verified against production `POST /v1/chat/completions`
 * (2026-10-13/14):
 *
 *  - `thinking: {type: "enabled"|"disabled"}` toggles reasoning. The dated
 *    DeepSeek V4 SKUs do not think unless it is enabled.
 *  - `reasoning_effort` only reaches DeepSeek (unknown values return 400
 *    there); every other family accepts any value and ignores it, so it is
 *    never sent to them.
 *  - GLM-5.3, Kimi K2.7 Code, LongCat 2.0 and MiniMax M2.7 return 400
 *    "当前模型必须开启深度思考" on any disable field, so always-on families
 *    must never receive one.
 *  - Budget fields (`thinking_budget`, `reasoning.max_tokens`,
 *    `thinking.budget_tokens`) are rejected as unknown request fields.
 */
import { describe, expect, it } from "bun:test";
import { streamOpenAICompletions } from "@oh-my-pi/pi-ai/providers/openai-completions";
import type { Context, FetchImpl, Model } from "@oh-my-pi/pi-ai/types";
import { buildModel } from "@oh-my-pi/pi-catalog/build";

const BASE_URL = "https://tokenrhythm.studio/v1";

function tokenrhythmModel(id: string): Model<"openai-completions"> {
	return buildModel({
		id,
		name: id,
		api: "openai-completions",
		provider: "tokenrhythm",
		baseUrl: BASE_URL,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 32_000,
	});
}

const userTurn: Context = { messages: [{ role: "user", content: "What is 2+2?", timestamp: 0 }] };

function sse(model: Model<"openai-completions">, delta: Record<string, unknown>): Response {
	const chunk = (d: Record<string, unknown>, finish?: string) =>
		`data: ${JSON.stringify({
			id: "chatcmpl-tokenrhythm-contract",
			object: "chat.completion.chunk",
			created: 0,
			model: model.id,
			choices: [{ index: 0, delta: d, ...(finish ? { finish_reason: finish } : {}) }],
		})}`;
	return new Response(`${[chunk(delta), chunk({}, "stop"), "data: [DONE]"].join("\n\n")}\n\n`, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

type CaptureOptions = { reasoning?: "low" | "high" | "max"; disableReasoning?: boolean };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function capture(
	id: string,
	options: CaptureOptions,
): Promise<{ url: string; payload: Record<string, unknown> }> {
	const model = tokenrhythmModel(id);
	let url = "";
	let payload: Record<string, unknown> | undefined;
	const fetchMock: FetchImpl = Object.assign(
		async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			url = input.toString();
			const parsed: unknown = JSON.parse(typeof init?.body === "string" ? init.body : "{}");
			if (!isRecord(parsed)) throw new Error("Expected a JSON object request body");
			payload = parsed;
			return sse(model, { content: "4" });
		},
		{ preconnect: fetch.preconnect },
	);
	const result = await streamOpenAICompletions(model, userTurn, {
		apiKey: "test-key",
		fetch: fetchMock,
		...options,
	}).result();
	expect(result.stopReason).toBe("stop");
	if (!payload) throw new Error("Expected a captured request payload");
	return { url, payload };
}

function expectNoBudgetFields(payload: Record<string, unknown>): void {
	expect(payload.thinking_budget).toBeUndefined();
	const thinking = payload.thinking;
	if (thinking !== undefined) {
		expect(isRecord(thinking)).toBe(true);
		if (isRecord(thinking)) expect(thinking.budget_tokens).toBeUndefined();
	}
	expect(payload.reasoning).toBeUndefined();
	expect(payload.enable_thinking).toBeUndefined();
	expect(payload.chat_template_kwargs).toBeUndefined();
}

describe("TokenRhythm reasoning wire contract", () => {
	it("enables DeepSeek thinking with thinking.type and the selected effort", async () => {
		const { url, payload } = await capture("deepseek-v4-pro-0813", { reasoning: "max" });
		expect(url).toBe(`${BASE_URL}/chat/completions`);
		expect(payload.thinking).toEqual({ type: "enabled" });
		expect(payload.reasoning_effort).toBe("max");
		expectNoBudgetFields(payload);
	});

	it("disables DeepSeek thinking with thinking.type disabled and no effort", async () => {
		const { payload } = await capture("deepseek-v4-flash-0731", { disableReasoning: true });
		expect(payload.thinking).toEqual({ type: "disabled" });
		expect(payload.reasoning_effort).toBeUndefined();
	});

	it("toggles Qwen and Seed with thinking.type and never sends reasoning_effort", async () => {
		for (const id of ["qwen3.8-max", "seed-2.1-pro"]) {
			const on = await capture(id, { reasoning: "high" });
			expect(on.payload.thinking).toEqual({ type: "enabled" });
			expect(on.payload.reasoning_effort).toBeUndefined();
			expectNoBudgetFields(on.payload);

			const off = await capture(id, { disableReasoning: true });
			expect(off.payload.thinking).toEqual({ type: "disabled" });
			expect(off.payload.reasoning_effort).toBeUndefined();
		}
	});

	it("never sends a disable or effort field to always-on families", async () => {
		for (const id of ["glm-5.3", "kimi-k2.7-code", "longcat-2.0", "minimax-m2.7", "glm-5.1", "mimo-v2.5-pro"]) {
			const variants: CaptureOptions[] = [{ disableReasoning: true }, { reasoning: "high" }, {}];
			for (const options of variants) {
				const { payload } = await capture(id, options);
				expect(payload.thinking).toBeUndefined();
				expect(payload.reasoning_effort).toBeUndefined();
				expectNoBudgetFields(payload);
			}
		}
	});

	it("parses streamed delta.reasoning_content into a thinking block", async () => {
		const model = tokenrhythmModel("glm-5.3");
		const fetchMock: FetchImpl = Object.assign(async () => sse(model, { reasoning_content: "2 plus 2 is 4." }), {
			preconnect: fetch.preconnect,
		});
		const result = await streamOpenAICompletions(model, userTurn, { apiKey: "test-key", fetch: fetchMock }).result();
		const thinking = result.content.find(block => block.type === "thinking");
		expect(thinking && "thinking" in thinking ? thinking.thinking : undefined).toBe("2 plus 2 is 4.");
	});
});
