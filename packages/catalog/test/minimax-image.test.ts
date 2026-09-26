import { describe, expect, test } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { seedModels } from "@oh-my-pi/pi-catalog/compat/providers";
import { modelKind } from "@oh-my-pi/pi-catalog/types";

function imageSeed(provider: string) {
	const spec = seedModels(provider).find(model => model.id === "image-01");
	if (!spec) throw new Error(`missing ${provider} image-01 seed`);
	return buildModel(spec);
}

describe("MiniMax image seeds", () => {
	test("routes each credential origin to its canonical image host", () => {
		// Token Plan keys are valid on the image endpoint; the region follows the
		// credential origin (China plan → api.minimaxi.com, others → api.minimax.io).
		expect(imageSeed("minimax").baseUrl).toBe("https://api.minimax.io/v1");
		expect(imageSeed("minimax-code").baseUrl).toBe("https://api.minimax.io/v1");
		expect(imageSeed("minimax-code-cn").baseUrl).toBe("https://api.minimaxi.com/v1");
	});

	test("declares the minimax-images runner api for the image kind", () => {
		for (const provider of ["minimax", "minimax-code", "minimax-code-cn"]) {
			const model = imageSeed(provider);
			expect(model.api).toBe("minimax-images");
			expect(modelKind(model)).toBe("image");
		}
	});
});
