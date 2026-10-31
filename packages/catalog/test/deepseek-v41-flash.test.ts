import { describe, expect, test } from "bun:test";
import { resolveCascade } from "../src/compat/cascade";
import { Effort } from "../src/effort";
import { getBundledModels } from "../src/models";
import type { Model } from "../src/types";

function bundled(provider: Parameters<typeof getBundledModels>[0], id: string): Model<"openai-completions"> {
	const model = getBundledModels(provider).find(candidate => candidate.id === id);
	if (!model) throw new Error(`${provider}/${id} is not bundled`);
	return model as Model<"openai-completions">;
}

/**
 * DeepSeek V4.1 Flash is natively multimodal (vision encoder + projector,
 * image-text pre-training) but its release id carries no `vision` token, and
 * the deepseek class default strips image inputs.
 */
describe("DeepSeek V4.1 Flash", () => {
	test("the bundled native row accepts image input", () => {
		const model = bundled("deepseek", "deepseek-flash");
		expect(model.reasoning).toBe(true);
		expect(model.input).toEqual(["text", "image"]);
		expect(model.compat.stripImageInput).toBe(false);
		expect(model.identity).toMatchObject({ class: "deepseek", family: "flash" });
		expect(model.thinking?.efforts).toEqual([Effort.Low, Effort.High, Effort.Max]);
	});

	test("the exemption does not widen to lookalike or retired SKUs", () => {
		// Retired V4 SKUs stay text-only by reviewed census decision.
		expect(bundled("deepseek", "deepseek-v4-flash").compat.stripImageInput).toBe(true);
		expect(bundled("deepseek", "deepseek-v4-pro").compat.stripImageInput).toBe(true);
	});

	test("publisher-namespaced ids keep the exemption", () => {
		// Gateways that resell the upstream prefix its namespace onto the id, so
		// the carve-out has to key on the release name rather than the exact id.
		const stripImageInput = (model: string) =>
			resolveCascade({
				provider: "omni",
				api: "openai-completions",
				class: "deepseek",
				family: "flash",
				model,
				reasoning: true,
			}).wire.stripImageInput;

		expect(stripImageInput("ds/deepseek-flash")).toBe(false);
		expect(stripImageInput("deepseek/deepseek-flash")).toBe(false);
		// Namespacing must not turn into suffix matching: the retired V4 reseller
		// id still ends in `-v4` and stays text-only.
		expect(stripImageInput("deepseek-flash-v4")).toBe(true);
	});
});
