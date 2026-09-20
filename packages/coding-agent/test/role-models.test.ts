import { describe, expect, test } from "bun:test";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import {
	resolveCompactionConfiguredTarget,
	resolveContextPromotionConfiguredTarget,
} from "@oh-my-pi/pi-coding-agent/session/role-models";

function grokbotModel(
	id: string,
	aliases: readonly string[] = [],
	targets: Pick<Model<Api>, "contextPromotionTarget" | "compactionModel"> = {},
): Model<Api> {
	return buildModel({
		id,
		aliases,
		name: id,
		api: "grokbot-sand",
		provider: "grokbot",
		baseUrl: "https://api2.cursor.sh",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 64_000,
		...targets,
	});
}

describe("configured model targets", () => {
	test("resolves qualified native aliases and same-provider bare aliases", () => {
		const promotionTarget = grokbotModel("grok-4.6-fast", ["grok-4.6"]);
		const compactionTarget = grokbotModel("grok-4.6-reasoning", ["fast"]);
		const current = grokbotModel("grok-4.5", [], {
			contextPromotionTarget: "GROKBOT/GROK-4.6",
			compactionModel: "FAST",
		});
		const availableModels = [current, promotionTarget, compactionTarget];

		expect(resolveContextPromotionConfiguredTarget(current, availableModels)).toBe(promotionTarget);
		expect(resolveCompactionConfiguredTarget(current, availableModels)).toBe(compactionTarget);
	});

	test("prefers exact canonical ids over colliding aliases", () => {
		const canonical = grokbotModel("grok-4.6");
		const aliased = grokbotModel("grok-4.6-fast", ["GROK-4.6"]);
		const current = grokbotModel("grok-4.5", [], {
			contextPromotionTarget: "GROKBOT/GROK-4.6",
			compactionModel: "grok-4.6",
		});
		const availableModels = [current, canonical, aliased];

		expect(resolveContextPromotionConfiguredTarget(current, availableModels)).toBe(canonical);
		expect(resolveCompactionConfiguredTarget(current, availableModels)).toBe(canonical);
	});

	test("preserves thinking suffixes while matching mixed-case canonical ids", () => {
		const baseTarget = grokbotModel("grok-4.6-fast");
		const literalMaxTarget = grokbotModel("grok-4.6-fast:max");
		const current = grokbotModel("grok-4.5", [], {
			contextPromotionTarget: "GrOkBoT/GrOk-4.6-FaSt:high",
			compactionModel: "GrOkBoT/GrOk-4.6-FaSt:max",
		});
		const availableModels = [current, baseTarget, literalMaxTarget];

		expect(resolveContextPromotionConfiguredTarget(current, availableModels)).toBe(baseTarget);
		expect(resolveCompactionConfiguredTarget(current, availableModels)).toBe(literalMaxTarget);
	});

	test("rejects ambiguous native aliases", () => {
		const first = grokbotModel("grok-4.6", ["latest"]);
		const second = grokbotModel("grok-4.6-fast", ["LATEST"]);
		const current = grokbotModel("grok-4.5", [], {
			contextPromotionTarget: "grokbot/latest",
			compactionModel: "latest",
		});
		const availableModels = [current, first, second];

		expect(resolveContextPromotionConfiguredTarget(current, availableModels)).toBeUndefined();
		expect(resolveCompactionConfiguredTarget(current, availableModels)).toBeUndefined();
	});

	test("rejects duplicate canonical ids", () => {
		const first = grokbotModel("grok-4.6");
		const second = grokbotModel("GROK-4.6");
		const current = grokbotModel("grok-4.5", [], {
			contextPromotionTarget: "grokbot/grok-4.6",
			compactionModel: "GROK-4.6",
		});
		const availableModels = [current, first, second];

		expect(resolveContextPromotionConfiguredTarget(current, availableModels)).toBeUndefined();
		expect(resolveCompactionConfiguredTarget(current, availableModels)).toBeUndefined();
	});
});
