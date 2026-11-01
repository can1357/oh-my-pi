import { describe, expect, it } from "bun:test";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import type { Model } from "@oh-my-pi/pi-catalog/types";
import { ModelControls, type ModelControlsHost } from "@oh-my-pi/pi-coding-agent/session/model-controls";

function model(id: string): Model {
	return {
		provider: "test",
		id,
		reasoning: true,
		thinking: { efforts: [Effort.Low, Effort.Medium, Effort.High] },
	} as unknown as Model;
}

function harness(phase: "metadata" | "reconciliation") {
	const source = model("source");
	const target = model("target");
	const entered = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	const journal: string[] = [];
	let active = source;
	const host = {
		agent: { setThinkingLevel: () => {}, setDisableReasoning: () => {} },
		settings: { getStorage: () => undefined },
		modelRegistry: {
			hasConfiguredAuth: () => true,
			refreshSelectedModelMetadata: async (next: Model) => {
				if (phase === "metadata") {
					entered.resolve();
					await release.promise;
				}
				return next;
			},
			clearSuppressedSelector: () => {},
		},
		sessionManager: {
			appendModelChange: (value: string) => journal.push(value),
			appendThinkingLevelChange: () => {},
		},
		model: () => active,
		promptGeneration: () => 0,
		sessionGenerationSettled: () => undefined,
		resolveActiveEditMode: () => "replace",
		syncAfterModelChange: async () => {},
		setModelWithProviderSessionReset: async (next: Model, _selection: string, onPublished: () => void) => {
			active = next;
			onPublished();
			if (phase === "reconciliation") {
				entered.resolve();
				await release.promise;
			}
		},
		clearActiveRetryFallback: () => {},
		clearInheritedProviderPromptCacheKey: () => {},
		emit: () => {},
		emitNotice: () => {},
	} as unknown as ModelControlsHost;
	const controls = new ModelControls(host, { thinkingLevel: Effort.Medium });
	return { controls, target, entered, release, journal, active: () => active };
}

describe("ModelControls automatic selections across a rolled-back switch", () => {
	it.each(["metadata", "reconciliation"] as const)(
		"stay cancelled by a /prewalk takeover made while the switch ran (%s)",
		async phase => {
			const h = harness(phase);
			const pending = h.controls.setModelTemporary(h.target, Effort.Low, { prewalk: true }, "automatic");
			await h.entered.promise;
			const snapshot = h.controls.beginPublicationScope();
			h.controls.invalidateAutomaticSelection();
			h.controls.restorePublicationScope(snapshot);
			h.release.resolve();
			await pending;

			// The takeover replaced the automatic arm, which a rolled-back switch does not restore.
			expect(h.controls.configuredThinkingLevel()).toBe(Effort.Medium);
			if (phase === "metadata") {
				expect(h.active().id).toBe("source");
				expect(h.journal).toEqual([]);
			}
		},
	);
});
