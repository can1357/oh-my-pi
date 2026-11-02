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

describe("ModelControls durable continuations superseded by a temporary selection", () => {
	function durableHarness(phase: "reconciliation" | "sync") {
		const source = model("source");
		const durable = model("durable");
		durable.thinking = {
			mode: "effort",
			efforts: [Effort.Low, Effort.Medium, Effort.High],
			defaultLevel: Effort.Low,
		};
		const temporary = model("temporary");
		temporary.thinking = { mode: "effort", efforts: [Effort.Low, Effort.Medium, Effort.High, Effort.Max] };
		const entered = Promise.withResolvers<void>();
		const release = Promise.withResolvers<void>();
		const receipts: Array<{ value: string; role?: string }> = [];
		const roles = new Map<string, string>();
		let active = source;
		let held = false;
		async function pause(at: typeof phase) {
			if (phase !== at || held || active !== durable) return;
			held = true;
			entered.resolve();
			await release.promise;
		}
		const host = {
			agent: { setThinkingLevel: () => {}, setDisableReasoning: () => {} },
			settings: {
				getStorage: () => undefined,
				getModelRole: (role: string) => roles.get(role),
				setModelRole: (role: string, value: string) => roles.set(role, value),
			},
			modelRegistry: {
				hasConfiguredAuth: () => true,
				refreshSelectedModelMetadata: async (next: Model) => next,
				clearSuppressedSelector: () => {},
			},
			sessionManager: {
				appendModelChange: (value: string, role?: string) => receipts.push({ value, role }),
				appendThinkingLevelChange: () => {},
			},
			model: () => active,
			sessionGenerationSettled: () => undefined,
			resolveActiveEditMode: () => "replace",
			syncAfterModelChange: async () => {
				await pause("sync");
			},
			setModelWithProviderSessionReset: async (next: Model, _selection: string, onPublished: () => void) => {
				active = next;
				onPublished();
				await pause("reconciliation");
			},
			clearActiveRetryFallback: () => {},
			clearInheritedProviderPromptCacheKey: () => {},
			emit: () => {},
			emitNotice: () => {},
		} as unknown as ModelControlsHost;
		const controls = new ModelControls(host, { thinkingLevel: Effort.Medium });
		return { controls, durable, temporary, entered, release, receipts, roles, active: () => active };
	}

	it.each(["reconciliation", "sync"] as const)(
		"a durable selection superseded during %s keeps its receipt and settings but cannot report success",
		async phase => {
			const h = durableHarness(phase);
			const pending = h.controls.setModel(h.durable, "default", {
				persist: true,
				thinkingLevel: Effort.Low,
			});
			await h.entered.promise;
			try {
				expect(await h.controls.setModelTemporary(h.temporary, Effort.Max, { ephemeral: true })).toBe(true);
			} finally {
				h.release.resolve();
			}
			const result = await pending;

			expect(h.active()).toBe(h.temporary);
			expect(h.controls.configuredThinkingLevel()).toBe(Effort.Max);
			expect(result).toEqual({ switched: false });
			expect(h.roles.get("default")).toBe("test/durable:low");
			expect(h.receipts.findLast(entry => entry.role === "default")).toEqual({
				value: "test/durable",
				role: "default",
			});
		},
	);

	it.each(["reconciliation", "sync"] as const)(
		"a role selection superseded during %s cannot apply its explicit effort or report success",
		async phase => {
			const h = durableHarness(phase);
			const pending = h.controls.applyRoleModel({
				model: h.durable,
				role: "slow",
				thinkingLevel: Effort.High,
				explicitThinkingLevel: true,
			});
			await h.entered.promise;
			try {
				expect(await h.controls.setModelTemporary(h.temporary, Effort.Max, { ephemeral: true })).toBe(true);
			} finally {
				h.release.resolve();
			}
			const result = await pending;

			expect(h.active()).toBe(h.temporary);
			expect(h.controls.configuredThinkingLevel()).toBe(Effort.Max);
			expect(result).toBe(false);
			expect(h.receipts.findLast(entry => entry.role === "slow")).toEqual({
				value: "test/durable",
				role: "slow",
			});
		},
	);
});
