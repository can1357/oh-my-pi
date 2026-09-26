import { describe, expect, test } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { seedModels } from "@oh-my-pi/pi-catalog/compat/providers";
import { modelKind } from "@oh-my-pi/pi-catalog/types";

function h3Seed(provider: string) {
	const spec = seedModels(provider).find(model => model.id === "MiniMax-H3-Image");
	if (!spec) throw new Error(`missing ${provider} MiniMax-H3-Image seed`);
	return buildModel(spec);
}

describe("MiniMax image seeds", () => {
	test("routes each credential origin to its canonical image host", () => {
		// M Plan/Token Plan keys are valid on the H3 image endpoint; the region
		// follows the credential origin (China plan → api.minimaxi.com, others → api.minimax.io).
		expect(h3Seed("minimax").baseUrl).toBe("https://api.minimax.io/v1");
		expect(h3Seed("minimax-code").baseUrl).toBe("https://api.minimax.io/v1");
		expect(h3Seed("minimax-code-cn").baseUrl).toBe("https://api.minimaxi.com/v1");
	});

	test("declares the openai-images runner api for the image kind", () => {
		for (const provider of ["minimax", "minimax-code", "minimax-code-cn"]) {
			const model = h3Seed(provider);
			expect(model.api).toBe("openai-images");
			expect(modelKind(model)).toBe("image");
		}
	});
});
