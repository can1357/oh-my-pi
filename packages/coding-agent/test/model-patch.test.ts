import { describe, expect, test } from "bun:test";
import { getBundledModels } from "@oh-my-pi/pi-catalog/models";
import { applyModelOverride } from "@oh-my-pi/pi-coding-agent/config/model-patch";

describe("model overrides", () => {
	test("keeps an explicit reasoning denial over a European gateway fallback", () => {
		const base = getBundledModels("aki-io").find(model => model.id === "kimi-k2.7-code-1100b");
		if (!base) throw new Error("Expected the Aki.IO fallback model");

		const model = applyModelOverride(base, { reasoning: false });

		expect(model.reasoning).toBe(false);
		expect(model.thinking).toBeUndefined();
	});
});
