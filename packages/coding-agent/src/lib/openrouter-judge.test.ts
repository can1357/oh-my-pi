import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { judgeState, OPENROUTER_DEFAULT_JUDGE_MODEL, parseJudgeJson } from "./openrouter-judge";

let savedKey: string | undefined;

beforeEach(() => {
	savedKey = process.env.OPENROUTER_API_KEY;
	process.env.OPENROUTER_API_KEY = "or-key";
});

afterEach(() => {
	if (savedKey === undefined) delete process.env.OPENROUTER_API_KEY;
	else process.env.OPENROUTER_API_KEY = savedKey;
});

function completionResponse(content: string, promptTokens = 42): Response {
	return new Response(
		JSON.stringify({
			choices: [{ message: { content } }],
			usage: { prompt_tokens: promptTokens },
		}),
		{ status: 200, headers: { "Content-Type": "application/json" } },
	);
}

const QUESTIONS = { goal_met: { instructions: "Did it work?" } };

describe("parseJudgeJson", () => {
	it("parses a bare JSON object", () => {
		expect(parseJudgeJson('{"goal_met": 0.9}')).toEqual({ goal_met: { noul: 0.9 } });
	});

	it("tolerates prose around the object", () => {
		expect(parseJudgeJson('Sure! {"goal_met": 0.4} hope that helps')).toEqual({
			goal_met: { noul: 0.4 },
		});
	});

	it("accepts {qid: {noul}} shape", () => {
		expect(parseJudgeJson('{"goal_met": {"noul": 0.7}}')).toEqual({ goal_met: { noul: 0.7 } });
	});

	it("throws when no JSON object is present", () => {
		expect(() => parseJudgeJson("no json here")).toThrow("no JSON object");
	});

	it("throws when a question lacks a numeric probability", () => {
		expect(() => parseJudgeJson('{"goal_met": "yes"}')).toThrow("goal_met");
	});
});

describe("judgeState", () => {
	it("posts the verifier prompt and returns parsed answers", async () => {
		const calls: [string, RequestInit][] = [];
		const fetchImpl = (async (url: string, init: RequestInit) => {
			calls.push([url, init]);
			return completionResponse('{"goal_met": 0.95}', 123);
		}) as typeof fetch;

		const result = await judgeState({
			goal: "Complete checkout",
			state: "page: confirmation",
			questions: QUESTIONS,
			fetchImpl,
		});

		expect(result.answers.goal_met.noul).toBe(0.95);
		expect(result.inputTokens).toBe(123);
		expect(result.model).toBe(OPENROUTER_DEFAULT_JUDGE_MODEL);
		const [url, init] = calls[0];
		expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
		expect((init.headers as Record<string, string>).Authorization).toBe("Bearer or-key");
		const body = JSON.parse(init.body as string) as { model: string; messages: { content: string }[] };
		expect(body.model).toBe(OPENROUTER_DEFAULT_JUDGE_MODEL);
		expect(body.messages[0].content).toContain("Complete checkout");
		expect(body.messages[0].content).toContain("page: confirmation");
	});

	it("throws when OPENROUTER_API_KEY is unset", async () => {
		delete process.env.OPENROUTER_API_KEY;
		await expect(judgeState({ goal: "g", state: "s", questions: QUESTIONS })).rejects.toThrow("OPENROUTER_API_KEY");
	});

	it("throws on API error status", async () => {
		const fetchImpl = (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
		await expect(judgeState({ goal: "g", state: "s", questions: QUESTIONS, fetchImpl })).rejects.toThrow(
			"OpenRouter 500",
		);
	});

	it("throws on malformed response shape", async () => {
		const fetchImpl = (async () =>
			new Response(JSON.stringify({ unexpected: true }), { status: 200 })) as unknown as typeof fetch;
		await expect(judgeState({ goal: "g", state: "s", questions: QUESTIONS, fetchImpl })).rejects.toThrow("malformed");
	});
});
