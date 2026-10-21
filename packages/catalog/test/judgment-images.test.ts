import { describe, expect, test } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { resolveJudgmentImageInput } from "@oh-my-pi/pi-catalog/compat/judgment-images";

const base = {
	reasoning: false,
	input: ["text", "image"] as ("text" | "image")[],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 32_000,
	maxTokens: 0,
};

const jevImageInput = {
	mimeTypes: ["image/png", "image/jpeg"],
	maxBytes: 16 * 1024 * 1024,
	minPixels: 78_400,
	maxPixels: 2_458_624,
	minSide: 280,
	maxSide: 1_568,
};

function judge(id: string, api: "typesafe" | "openrouter-decisions", provider: string) {
	return buildModel({ ...base, id, name: id, api, provider, baseUrl: "http://localhost:8000" });
}

describe("judgment-image-input", () => {
	test("bounds only the image-enabled TypeSafe and OpenRouter Jev selectors", () => {
		for (const id of ["jev-latest", "jev-preview", "jev-1.13.0", "jev-1.14.0"]) {
			expect(resolveJudgmentImageInput(judge(id, "typesafe", "typesafe"))).toEqual(jevImageInput);
		}
		for (const id of ["~typesafe/jev-latest", "typesafe/jev-1.13", "typesafe/jev-1.14"]) {
			expect(resolveJudgmentImageInput(judge(id, "openrouter-decisions", "openrouter"))).toEqual(jevImageInput);
		}
	});

	test("does not impose Jev bounds on custom or non-Jev models", () => {
		expect(resolveJudgmentImageInput(judge("custom-vision-model", "typesafe", "self-hosted"))).toBeUndefined();
		expect(resolveJudgmentImageInput(judge("jev-latest", "typesafe", "self-hosted"))).toBeUndefined();
		expect(resolveJudgmentImageInput(judge("jev-fast", "typesafe", "typesafe"))).toBeUndefined();
		expect(
			resolveJudgmentImageInput(judge("typesafe/jev-unverified", "openrouter-decisions", "openrouter")),
		).toBeUndefined();
	});
});
