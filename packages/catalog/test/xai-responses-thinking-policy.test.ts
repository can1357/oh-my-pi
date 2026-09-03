import { describe, expect, it } from "bun:test";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import MODELS_JSON from "@oh-my-pi/pi-catalog/models.json" with { type: "json" };
import {
	MODELS_DEV_PROVIDER_DESCRIPTORS,
	mapModelsDevToModels,
} from "@oh-my-pi/pi-catalog/provider-models/openai-compat";
import type { ModelSpec } from "@oh-my-pi/pi-catalog/types";
import { applyGeneratedModelPolicies } from "../scripts/generated-policies";

const XAI_MODELS_DEV_FIXTURE = {
	xai: {
		models: {
			"grok-4.5": {
				name: "Grok 4.5",
				tool_call: true,
				reasoning: true,
				modalities: { input: ["text", "image"] },
				limit: { context: 500_000, output: 500_000 },
				cost: { input: 2, output: 6, cache_read: 0.3 },
			},
			"grok-4.6": {
				name: "Grok 4.6",
				tool_call: true,
				reasoning: true,
				modalities: { input: ["text", "image"] },
				limit: { context: 500_000, output: 500_000 },
				cost: { input: 2, output: 6, cache_read: 0.5 },
			},
			"grok-code-fast-1": {
				name: "Grok Code Fast 1",
				tool_call: true,
				reasoning: true,
				modalities: { input: ["text"] },
				limit: { context: 256_000, output: 10_000 },
				cost: { input: 0.2, output: 1.5 },
			},
			"grok-build-0.1": {
				name: "Grok Build 0.1",
				tool_call: true,
				reasoning: true,
				modalities: { input: ["text", "image"] },
				limit: { context: 256_000, output: 256_000 },
				cost: { input: 0, output: 0 },
			},
			"grok-4.20-0309-reasoning": {
				name: "Grok 4.20 (Reasoning)",
				tool_call: true,
				reasoning: true,
				modalities: { input: ["text", "image"] },
				limit: { context: 2_000_000, output: 64_000 },
				cost: { input: 2, output: 6 },
			},
			"grok-2": {
				name: "Grok 2",
				tool_call: true,
				reasoning: false,
				modalities: { input: ["text"] },
				limit: { context: 131_072, output: 8192 },
				cost: { input: 2, output: 10 },
			},
			"grok-4.20-multi-agent-beta-latest": {
				name: "Grok 4.20 (Multi-Agent)",
				tool_call: true,
				reasoning: true,
				modalities: { input: ["text"] },
				limit: { context: 2_000_000, output: 64_000 },
				cost: { input: 2, output: 6 },
			},
		},
	},
};

describe("paid xAI Responses thinking policy", () => {
	it("bakes the effort-dial allowlist on stencil.so → openai-responses mapping", () => {
		const mapped = mapModelsDevToModels(XAI_MODELS_DEV_FIXTURE, MODELS_DEV_PROVIDER_DESCRIPTORS).filter(
			model => model.provider === "xai",
		);
		const byId = Object.fromEntries(mapped.map(model => [model.id, model]));

		expect(byId["grok-4.5"]?.api).toBe("openai-responses");
		expect(byId["grok-4.5"]?.compat).toMatchObject({
			supportsReasoningEffort: true,
			omitReasoningEffort: false,
			reasoningEffortMap: { minimal: "low" },
		});
		for (const id of ["grok-code-fast-1", "grok-build-0.1", "grok-4.20-0309-reasoning"] as const) {
			expect(byId[id]?.reasoning, id).toBe(true);
			expect(byId[id]?.compat, id).toMatchObject({
				supportsReasoningEffort: false,
				omitReasoningEffort: true,
			});
			expect(byId[id]?.compat, id).not.toHaveProperty("reasoningEffortMap");
		}
		expect(byId["grok-2"]?.compat).toMatchObject({
			supportsReasoningEffort: false,
			omitReasoningEffort: true,
		});
		expect(byId["grok-2"]?.compat).not.toHaveProperty("reasoningEffortMap");
	});

	it("strips stale thinking dials from off-allowlist paid xAI reasoners during generation", () => {
		const mapped = mapModelsDevToModels(XAI_MODELS_DEV_FIXTURE, MODELS_DEV_PROVIDER_DESCRIPTORS).filter(
			model => model.provider === "xai",
		);
		// Snapshot-era Completions rows still carry a default effort ladder after the
		// api flip; the generator must not re-emit that dial for Responses.
		const snapshotStale = mapped.find(model => model.id === "grok-code-fast-1");
		expect(snapshotStale).toBeDefined();
		snapshotStale!.thinking = { mode: "effort", efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High] };

		applyGeneratedModelPolicies(mapped);
		const byId = Object.fromEntries(mapped.map(model => [model.id, model]));

		expect(byId["grok-4.5"]?.thinking).toEqual({
			mode: "effort",
			efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High],
			effortMap: { minimal: "low" },
		});
		expect(byId["grok-4.6"]?.thinking).toEqual({
			mode: "effort",
			efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High, Effort.XHigh],
			effortMap: { minimal: "low" },
		});
		expect(byId["grok-4.6"]?.compat).toMatchObject({
			supportsReasoningEffort: true,
			reasoningEffortMap: { minimal: "low" },
		});
		expect(byId["grok-4.6"]?.compat).not.toMatchObject({
			reasoningEffortMap: { xhigh: "high" },
		});
		expect(byId["grok-4.20-multi-agent-beta-latest"]?.thinking).toEqual({
			mode: "effort",
			efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High, Effort.XHigh],
			effortMap: { minimal: "low" },
		});
		expect(byId["grok-4.20-multi-agent-beta-latest"]?.compat).toMatchObject({
			supportsReasoningEffort: true,
			reasoningEffortMap: { minimal: "low" },
		});
		expect(byId["grok-4.20-multi-agent-beta-latest"]?.compat).not.toMatchObject({
			reasoningEffortMap: { xhigh: "high" },
		});
		for (const id of ["grok-code-fast-1", "grok-build-0.1", "grok-4.20-0309-reasoning"] as const) {
			expect(byId[id]?.reasoning, id).toBe(true);
			expect(byId[id]?.thinking, id).toBeUndefined();
			expect(byId[id]?.compat, id).toMatchObject({ supportsReasoningEffort: false });
		}
	});

	it("exports no-dial rows in the bundled models.json snapshot", () => {
		const bundled =
			(MODELS_JSON as unknown as Record<string, Record<string, ModelSpec<"openai-responses">>>).xai ?? {};
		for (const id of ["grok-code-fast-1", "grok-build-0.1", "grok-4.20-0309-reasoning"] as const) {
			expect(bundled[id], `xai/${id} missing from models.json`).toBeDefined();
			expect(bundled[id]?.reasoning, id).toBe(true);
			expect(bundled[id]?.thinking, id).toBeUndefined();
			expect(bundled[id]?.compat?.supportsReasoningEffort, id).toBe(false);
		}
		expect(bundled["grok-4.5"]?.thinking?.efforts).toEqual([Effort.Minimal, Effort.Low, Effort.Medium, Effort.High]);
		expect(bundled["grok-4.5"]?.thinking?.efforts).not.toContain(Effort.XHigh);
		expect(bundled["grok-4.5"]?.compat?.supportsReasoningEffort).toBe(true);
		expect(bundled["grok-4.6"]?.thinking?.efforts).toContain(Effort.XHigh);
		expect(bundled["grok-4.6"]?.compat).not.toMatchObject({
			reasoningEffortMap: { xhigh: "high" },
		});
		expect(bundled["grok-4.20-multi-agent-beta-latest"]?.thinking?.efforts).toContain(Effort.XHigh);
		expect(bundled["grok-4.20-multi-agent-beta-latest"]?.compat).not.toMatchObject({
			reasoningEffortMap: { xhigh: "high" },
		});
	});
});
