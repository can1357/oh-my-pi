import { describe, expect, it } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import { resolveWireModelId } from "@oh-my-pi/pi-catalog/model-thinking";
import type { ModelSpec } from "@oh-my-pi/pi-catalog/types";
import modelsJson from "../src/models.json";

describe("issue #3067 — bundled Antigravity Claude 4.6 wire-id routing", () => {
	const antigravity = modelsJson["google-antigravity"] as Record<string, ModelSpec<"google-gemini-cli">>;

	it("never bundles the dead `claude-sonnet-4-6-thinking` wire id as a Sonnet routing target", () => {
		const sonnet = antigravity["claude-sonnet-4-6"];
		expect(sonnet).toBeDefined();
		const routing = sonnet?.thinking?.effortRouting;
		if (routing !== undefined) {
			for (const key in routing) {
				expect(routing[key as keyof typeof routing]).not.toBe("claude-sonnet-4-6-thinking");
			}
		}
		// Resolving through buildModel must land on a live wire id for every effort.
		const model = buildModel(sonnet as ModelSpec<"google-gemini-cli">);
		for (const effort of [undefined, Effort.Minimal, Effort.Low, Effort.Medium, Effort.High] as const) {
			expect(resolveWireModelId(model, effort)).toBe("claude-sonnet-4-6");
		}
	});

	it("routes the bundled Opus 4.6 to the live `claude-opus-4-6-thinking` wire id for every effort", () => {
		const opus = antigravity["claude-opus-4-6"];
		expect(opus).toBeDefined();
		const model = buildModel(opus as ModelSpec<"google-gemini-cli">);
		for (const effort of [undefined, Effort.Minimal, Effort.Low, Effort.Medium, Effort.High] as const) {
			expect(resolveWireModelId(model, effort)).toBe("claude-opus-4-6-thinking");
		}
	});
});
