import { describe, expect, test } from "bun:test";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import { getBundledModels } from "@oh-my-pi/pi-catalog/models";
import { DEFAULT_MODEL_PER_PROVIDER } from "@oh-my-pi/pi-catalog/provider-models";
import { pickDefaultAvailableModel } from "@oh-my-pi/pi-coding-agent/config/model-resolver";

describe("provider default selection", () => {
	/**
	 * `pickDefaultAvailableModel` prefers the first model whose id equals its
	 * provider's declared default and falls through to `availableModels[0]`
	 * when nothing matches. Synthetic's default pointed at `hf:zai-org/GLM-5.1`
	 * after the provider moved to GLM-5.2, so an account with only
	 * `SYNTHETIC_API_KEY` opened on whichever model sorted first instead of the
	 * declared default.
	 *
	 * The default is moved to the back of the availability list rather than
	 * relying on catalog order, so the assertion keeps proving that the picker
	 * overrides position — not that `gen:models` happens to sort some other
	 * model first.
	 */
	test("picks Synthetic's declared default over availability order", () => {
		const bundled = getBundledModels("synthetic") as Model<Api>[];
		const declaredDefault = bundled.find(model => model.id === DEFAULT_MODEL_PER_PROVIDER.synthetic);
		expect(declaredDefault).toBeDefined();
		if (!declaredDefault) return;

		const available = [...bundled.filter(model => model !== declaredDefault), declaredDefault];
		expect(available.length).toBeGreaterThan(1);

		const picked = pickDefaultAvailableModel(available);

		expect(picked?.id).toBe(DEFAULT_MODEL_PER_PROVIDER.synthetic);
	});
});
