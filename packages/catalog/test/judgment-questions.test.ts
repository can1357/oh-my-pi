import { describe, expect, test } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { resolveJudgmentQuestionsMax } from "@oh-my-pi/pi-catalog/compat/judgment-questions";

const base = {
	reasoning: false,
	input: ["text"] as "text"[],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 32_000,
	maxTokens: 0,
};

describe("judgment-questions-max", () => {
	const judge = (
		id: string,
		api: "typesafe" | "openrouter-decisions" | "workers-ai-systemone" | "openai-decisions",
		provider: string,
	) => buildModel({ ...base, id, name: id, api, provider, baseUrl: "http://localhost:8000" });

	test("caps unidentified OpenJEV judges at 16; razorback16/openjev wire names at 256 over the glob", () => {
		expect(resolveJudgmentQuestionsMax(judge("openjev-4b", "typesafe", "my-openjev"))).toBe(16);
		expect(resolveJudgmentQuestionsMax(judge("openjev-latest", "typesafe", "my-openjev"))).toBe(256);
		expect(resolveJudgmentQuestionsMax(judge("verdict-1.4", "typesafe", "my-openjev"))).toBe(256);
	});

	test("leaves hosted jev uncapped", () => {
		expect(resolveJudgmentQuestionsMax(judge("jev-latest", "typesafe", "typesafe"))).toBeUndefined();
		expect(
			resolveJudgmentQuestionsMax(judge("~typesafe/jev-latest", "openrouter-decisions", "openrouter")),
		).toBeUndefined();
		expect(resolveJudgmentQuestionsMax(judge("gpt-6-luna-decisions", "openai-decisions", "openai"))).toBeUndefined();
	});

	test("caps Cloudflare Clef at the Workers AI schema's 64 questions, on Workers AI and through OpenRouter", () => {
		expect(
			resolveJudgmentQuestionsMax(judge("@cf/cloudflare/clef", "workers-ai-systemone", "cloudflare-workers-ai")),
		).toBe(64);
		expect(
			resolveJudgmentQuestionsMax(
				judge("@cf/cloudflare/clef-flash", "workers-ai-systemone", "cloudflare-workers-ai"),
			),
		).toBe(64);
		expect(resolveJudgmentQuestionsMax(judge("cloudflare/clef-flash", "openrouter-decisions", "openrouter"))).toBe(
			64,
		);
		// The OpenRouter-scoped Clef glob does not leak onto TypeSafe's adapter.
		expect(resolveJudgmentQuestionsMax(judge("cloudflare/clef", "typesafe", "my-judge"))).toBeUndefined();
		expect(resolveJudgmentQuestionsMax(judge("jev-latest", "typesafe", "typesafe"))).toBeUndefined();
	});
});
