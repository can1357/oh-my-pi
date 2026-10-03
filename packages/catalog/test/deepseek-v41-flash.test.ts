import { describe, expect, test } from "bun:test";
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
		expect(model.name).toBe("DeepSeek V4.1 Flash");
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
		// Yolo-Auto resells the same model behind an id the release-name glob
		// must not claim.
		expect(bundled("yolo-auto", "deepseek-flash-v4").compat.stripImageInput).toBe(true);
	});
});
