import { describe, expect, it } from "bun:test";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { toModelJson } from "@oh-my-pi/pi-coding-agent/cli/models-cli";

function bundled(provider: "anthropic", id: string): Model<Api> {
	const model = getBundledModel(provider, id);
	if (!model) throw new Error(`Expected bundled model ${provider}/${id}`);
	return model;
}

describe("omp models --json catalog metrics", () => {
	it("carries the catalog intelligence score and output speed the model browser shows", () => {
		const model = bundled("anthropic", "claude-fable-5");
		// Guard: the fixture must actually be scored, or the assertions below prove nothing.
		expect(model.int).toBeGreaterThan(0);
		expect(model.tps).toBeGreaterThan(0);

		const json = toModelJson(model);
		expect(json.int).toBe(model.int as number);
		expect(json.tps).toBe(model.tps as number);
	});

	it("reports null for an unscored model instead of omitting the keys", () => {
		const model = { ...bundled("anthropic", "claude-fable-5"), int: undefined, tps: undefined } as Model<Api>;
		const json = toModelJson(model);
		expect(json).toHaveProperty("int", null);
		expect(json).toHaveProperty("tps", null);
	});

	it("treats a zero speed as unmeasured, matching the model browser", () => {
		const model = { ...bundled("anthropic", "claude-fable-5"), tps: 0 } as Model<Api>;
		expect(toModelJson(model).tps).toBeNull();
	});
});
