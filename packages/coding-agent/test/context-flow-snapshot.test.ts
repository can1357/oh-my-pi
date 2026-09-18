import { describe, expect, it } from "bun:test";
import { buildContextFlowSnapshot, getContextFlowRegistry } from "../src/context-flow";
import { contextFlowBeginTurn, contextFlowSeedResearchStack } from "../src/context-flow/hooks";

describe("context-flow snapshot", () => {
	it("marks NanoJev as not wired in static wiring table", () => {
		const snap = buildContextFlowSnapshot({
			registry: getContextFlowRegistry({}),
			breakdown: {
				model: undefined,
				contextWindow: 200_000,
				categories: [],
				usedTokens: 1000,
				autoCompactBufferTokens: 0,
				freeTokens: 199_000,
			},
			bridge: undefined,
		});
		expect(snap.wiring.nanojev).toBe("present_not_wired");
	});

	it("records user prompt turn on shared registry", () => {
		const owner = {};
		contextFlowSeedResearchStack(owner);
		contextFlowBeginTurn(owner, "hello");
		const snap = buildContextFlowSnapshot({
			registry: getContextFlowRegistry(owner),
			breakdown: {
				model: undefined,
				contextWindow: 100,
				categories: [],
				usedTokens: 10,
				autoCompactBufferTokens: 0,
				freeTokens: 90,
			},
		});
		expect(snap.turn).toBe(1);
		expect(snap.nodes.some(n => n.component === "omp.user")).toBe(true);
	});
});
