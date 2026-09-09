import { describe, expect, test } from "bun:test";
import { buildModelProviderPriorityRank } from "@oh-my-pi/pi-catalog/identity/priority";

describe("model provider priority", () => {
	test("ranks AIML API with hosted aggregators", () => {
		const rank = buildModelProviderPriorityRank();
		const aimlRank = rank.get("aimlapi");
		const openRouterRank = rank.get("openrouter");
		const togetherRank = rank.get("together");

		expect(aimlRank).toBeDefined();
		expect(openRouterRank).toBeDefined();
		expect(togetherRank).toBeDefined();
		expect(openRouterRank!).toBeLessThan(aimlRank!);
		expect(aimlRank!).toBeLessThan(togetherRank!);
	});
});
