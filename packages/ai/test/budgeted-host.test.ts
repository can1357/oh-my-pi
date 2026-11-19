import { describe, expect, it } from "bun:test";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { toModelSpec } from "@oh-my-pi/pi-catalog/provider-models/bundled-references";
import { reachesBudgetedHost, reachesOfficialEndpoint } from "../src/providers/anthropic-state";
import type { Model, ModelSpec } from "../src/types";

function factoryModel(baseUrl: string): Model {
	const spec: ModelSpec<"factory-droid-agent"> = {
		id: "claude-haiku-4-5-20251001",
		name: "Haiku 4.5",
		api: "factory-droid-agent",
		provider: "factory-droid",
		baseUrl,
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 64_000,
	};
	return buildModel(spec);
}

describe("reachesBudgetedHost", () => {
	it.each([
		["unset baseUrl", "", true],
		["global Messages route", "https://api.factory.ai/api/llm/a", true],
		["EU Responses route", "https://api.eu.factory.ai/api/llm/o/v1", true],
		["bare global host", "https://api.factory.ai", true],
		["lookalike host", "https://api.factory.ai.evil.example/api/llm/a", false],
		["plain http", "http://api.factory.ai/api/llm/a", false],
		["custom gateway", "https://factory-gateway.example.com/api/llm/a", false],
		["unparseable URL", "not a url", false],
	])("Factory Droid %s → %p", (_label, baseUrl, expected) => {
		expect(reachesBudgetedHost(factoryModel(baseUrl))).toBe(expected);
	});

	it("follows reachesOfficialEndpoint for every other provider", () => {
		const opus = getBundledModel("anthropic", "claude-opus-5-5");
		const proxied = buildModel({ ...toModelSpec(opus), baseUrl: "https://proxy.example/v1" });
		const openrouter = getBundledModel("openrouter", "anthropic/claude-opus-5.5");
		for (const model of [opus, proxied, openrouter]) {
			expect(reachesBudgetedHost(model)).toBe(reachesOfficialEndpoint(model));
		}
		expect(reachesBudgetedHost(opus)).toBe(true);
		expect(reachesBudgetedHost(proxied)).toBe(false);
	});
});
