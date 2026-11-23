import { describe, expect, it } from "bun:test";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core/thinking";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort, THINKING_EFFORTS } from "@oh-my-pi/pi-catalog/effort";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { toModelSpec } from "@oh-my-pi/pi-catalog/provider-models/bundled-references";
import type { Model } from "@oh-my-pi/pi-catalog/types";
import {
	assertModelSupportsEffortCeiling,
	automaticThinkingLevel,
	AUTO_THINKING,
	clampThinkingLevelToCeiling,
	modelSupportsEffortCeiling,
	newSessionThinkingLevel,
	prewalkWouldBeNoop,
	resolveConfiguredThinkingLevel,
	resolveProvisionalAutoLevel,
} from "../src/thinking";

function customReasoner(): Model {
	return buildModel({
		id: "custom-reasoner",
		name: "custom-reasoner",
		api: "openai-completions",
		provider: "custom",
		baseUrl: "https://example.com/v1",
		reasoning: true,
		thinking: { mode: "effort", efforts: [Effort.Low, Effort.Medium, Effort.High] },
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 32_000,
	});
}

describe("thinking before capability discovery", () => {
	const model = buildModel({
		...toModelSpec(customReasoner()),
		reasoning: undefined,
		thinking: undefined,
	});

	it.each([Effort.Low, Effort.Max, AUTO_THINKING, ThinkingLevel.Off, undefined])(
		"honors the session default %s while capability is unverified",
		level => {
			expect(model.thinking?.unverified).toBe(true);
			expect(model.thinking?.efforts).toEqual(THINKING_EFFORTS);
			expect(automaticThinkingLevel(model, level)).toBe(level);
			expect(newSessionThinkingLevel(model, undefined, level)).toBe(level);
		},
	);

	it("resolves auto to a concrete provisional effort without enabling known non-reasoners", () => {
		expect(resolveProvisionalAutoLevel(model)).toBe(Effort.High);
		expect(resolveConfiguredThinkingLevel(model, AUTO_THINKING)).toBe(Effort.High);
		const nonreasoner = buildModel({ ...toModelSpec(model), reasoning: false, thinking: undefined });
		expect(nonreasoner.thinking).toBeUndefined();
		expect(resolveConfiguredThinkingLevel(nonreasoner, AUTO_THINKING)).toBeUndefined();
	});
});

const DEFERRED_LEVELS: Array<ThinkingLevel | undefined> = [undefined, ThinkingLevel.Inherit, ThinkingLevel.Off];

describe("clampThinkingLevelToCeiling", () => {
	it.each(DEFERRED_LEVELS)("preserves %s under a ceiling that clamps explicit efforts", level => {
		// Deferred selectors keep their documented meaning; the ceiling only applies to explicit efforts.
		expect(clampThinkingLevelToCeiling(customReasoner(), level, Effort.Low)).toBe(level);
	});

	it.each([undefined, Effort.Low, Effort.Max])("caps explicit efforts only when they exceed %s", ceiling => {
		const model = customReasoner();
		expect(clampThinkingLevelToCeiling(model, Effort.High, ceiling)).toBe(
			ceiling === Effort.Low ? Effort.Low : Effort.High,
		);
		expect(clampThinkingLevelToCeiling(model, Effort.Low, ceiling)).toBe(Effort.Low);
		expect(clampThinkingLevelToCeiling(undefined, Effort.High, ceiling)).toBe(
			ceiling === Effort.Low ? Effort.Low : Effort.High,
		);
	});

	it("clamps explicit efforts on unverified models", () => {
		const base = customReasoner();
		const model = { ...base, thinking: { ...base.thinking!, unverified: true } };
		expect(clampThinkingLevelToCeiling(model, Effort.High, Effort.Low)).toBe(Effort.Low);
	});

	it("snaps to the highest supported effort below the ceiling", () => {
		const base = customReasoner();
		const model = { ...base, thinking: { mode: "effort" as const, efforts: [Effort.Minimal, Effort.High] } };
		expect(clampThinkingLevelToCeiling(model, Effort.High, Effort.Low)).toBe(Effort.Minimal);
	});

	it("leaves incompatible floors unchanged for the caller to reject", () => {
		const model = customReasoner();
		expect(clampThinkingLevelToCeiling(model, Effort.High, Effort.Minimal)).toBe(Effort.High);
		expect(modelSupportsEffortCeiling(model, Effort.Minimal)).toBe(false);
		expect(modelSupportsEffortCeiling(model, Effort.Low)).toBe(true);
		expect(() => assertModelSupportsEffortCeiling(model, Effort.Minimal)).toThrow(
			"has no supported thinking effort at or below task.maxEffort=minimal",
		);
	});

	it("accepts models with no controllable effort surface", () => {
		const model = { ...customReasoner(), reasoning: false, thinking: undefined };
		expect(modelSupportsEffortCeiling(model, Effort.Minimal)).toBe(true);
	});
});

describe("prewalkWouldBeNoop", () => {
	it("distinguishes Vercel Gateway upstreams but treats a cloned same-upstream model as a no-op", () => {
		const bundled = getBundledModel("anthropic", "claude-sonnet-4-6");
		if (!bundled) throw new Error("Expected bundled Claude Sonnet 4.6");
		const source = buildModel({
			...toModelSpec(bundled),
			id: "anthropic/claude-sonnet-4.6",
			api: "openai-completions",
			provider: "vercel-ai-gateway",
			baseUrl: "https://ai-gateway.vercel.sh/v1",
			compat: { vercelGatewayRouting: { only: ["anthropic"] } },
		});
		const clone = buildModel(toModelSpec(source));
		const target = buildModel({
			...toModelSpec(source),
			compat: { vercelGatewayRouting: { only: ["bedrock"] } },
		});

		expect(clone).not.toBe(source);
		expect(prewalkWouldBeNoop(source, Effort.High, clone, Effort.High)).toBe(true);
		expect(prewalkWouldBeNoop(source, Effort.High, target, Effort.High)).toBe(false);
	});
});
