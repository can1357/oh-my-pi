import { describe, expect, test } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import type { ModelSpec } from "@oh-my-pi/pi-catalog/types";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { cfgCompaction } from "@oh-my-pi/pi-coding-agent/session/context-settings";
import { resolveSpeculationMethod } from "@oh-my-pi/pi-coding-agent/session/compaction-methods";

/** Resolve Bedrock support from the authored identity and compat rules, not generated model data. */
function getBedrockCompactionModel() {
	const sourceSpec: ModelSpec<"bedrock-converse-stream"> = {
		id: "global.anthropic.claude-opus-5-5",
		name: "Claude Opus 5.5 (Global)",
		api: "bedrock-converse-stream",
		provider: "amazon-bedrock",
		baseUrl: "",
		reasoning: true,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 32_000,
	};
	return buildModel(sourceSpec);
}

describe("Bedrock native compaction method selection", () => {
	test("prefers native remote compaction and keeps ineligible routes on the soft fallback", () => {
		const model = getBedrockCompactionModel();
		const settings = Settings.isolated({ "compaction.methodOrder": ["remote", "soft"] });
		const compaction = cfgCompaction.get(settings);

		expect(resolveSpeculationMethod(model, compaction)).toBe("remote");
		expect(resolveSpeculationMethod({ ...model, remoteCompaction: { enabled: false } }, compaction)).toBe("soft");
	});
});
