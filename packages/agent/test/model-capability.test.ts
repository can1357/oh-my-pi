import { describe, expect, test } from "bun:test";
import type { Model } from "@oh-my-pi/pi-ai";
import { createModelCapabilityTelemetry, createStrategyProfile, deriveModelCapabilities, getModelCapabilityCacheSize, invalidateModelCapabilities, recordCapabilityEvidence } from "../src/model-capability";

function model(overrides: Partial<Model> = {}): Model {
	return {
		id: "test-model", name: "Test", provider: "test", api: "openai-completions", baseUrl: "https://example.invalid",
		identity: {} as Model["identity"], reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000, maxTokens: 16000, compat: {}, ...overrides,
	} as Model;
}

const task = { complexity: "COMPLEX", confidence: 0.92, score: 4, reasons: ["cross-file"], signals: {} as never, workflow: { inspect: true, plan: true, explore: true, architecture: true, specialistResearch: false, verification: "deep", reviewPasses: 1, maxEscalations: 2, reasoningDepth: "high" } };

describe("model capability strategy", () => {
	test("keeps missing metadata unknown", () => {
		invalidateModelCapabilities();
		const profile = deriveModelCapabilities(model());
		expect(profile.toolCalling).toBe("unknown");
		expect(profile.parallelToolCalls).toBe("unknown");
		expect(profile.structuredOutput).toBe("unknown");
		expect(profile.supportsToolChoice).toBe("unknown");
	});

	test("uses explicit thinking/tool/vision metadata", () => {
		invalidateModelCapabilities();
		const profile = deriveModelCapabilities(model({
			reasoning: true,
			thinking: { mode: "effort", efforts: ["minimal", "low", "medium", "high", "max"] } as Model["thinking"],
			supportsTools: true,
			input: ["text", "image"],
			supportsComputerUse: true,
			compat: { supportsToolChoice: true, supportsForcedToolChoice: true, supportsNamedToolChoice: true, supportsParallelToolCalls: true, supportsDeveloperRole: true } as Model["compat"],
		}));
		expect(profile.reasoning).toBe("supported");
		expect(profile.reasoningLevels).toEqual(["minimal", "low", "medium", "high", "max"]);
		expect(profile.parallelToolCalls).toBe("supported");
		expect(profile.vision).toBe("supported");
		expect(profile.computerUse).toBe("supported");
	});

	test("changes strategy for model capability differences", () => {
		const strong = deriveModelCapabilities(model({ reasoning: true, supportsTools: true, compat: { supportsToolChoice: true, supportsForcedToolChoice: true, supportsNamedToolChoice: true, supportsParallelToolCalls: true }, thinking: { mode: "effort", efforts: ["minimal", "low", "medium", "high", "max"] } as Model["thinking"] }));
		const weak = deriveModelCapabilities(model({ reasoning: true, supportsTools: true, compat: { supportsToolChoice: false, supportsForcedToolChoice: false, supportsNamedToolChoice: false, supportsParallelToolCalls: false } as Model["compat"] }));
		const strongStrategy = createStrategyProfile(task, strong);
		const weakStrategy = createStrategyProfile(task, weak);
		expect(strongStrategy.reasoningMode).toBe("max");
		expect(strongStrategy.allowParallelTools).toBe(true);
		expect(weakStrategy.reasoningMode).toBe("default");
		expect(weakStrategy.allowParallelTools).toBe(false);
		expect(weakStrategy.fallbackPolicy).toBe("capability-and-health");
	});

	test("cache reuses a stable profile and invalidates after repeated evidence", () => {
		invalidateModelCapabilities();
		const m = model();
		const first = deriveModelCapabilities(m);
		const second = deriveModelCapabilities(m);
		expect(first).toBe(second);
		expect(getModelCapabilityCacheSize()).toBe(1);
		const telemetry = createModelCapabilityTelemetry(m, task);
		recordCapabilityEvidence(telemetry, "providerErrors", m);
		recordCapabilityEvidence(telemetry, "providerErrors", m);
		expect(getModelCapabilityCacheSize()).toBe(1);
		recordCapabilityEvidence(telemetry, "providerErrors", m);
		expect(getModelCapabilityCacheSize()).toBe(0);
	});
});
