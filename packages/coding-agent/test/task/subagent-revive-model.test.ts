import { afterEach, describe, expect, it, vi } from "bun:test";
import type { Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { Effort } from "@oh-my-pi/pi-catalog/effort";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import type { RevivedModels } from "@oh-my-pi/pi-coding-agent/task/executor";
import { PerCallModelError, PerCallModelUnavailableError } from "@oh-my-pi/pi-coding-agent/task/model-approval";
import { chooseColdReviveModel, choosePerCallModel } from "@oh-my-pi/pi-coding-agent/task/revive-model";
import { mayReviveUseParentModel, readSpawnSpec } from "@oh-my-pi/pi-coding-agent/task/spawn-spec";
import { logger } from "@oh-my-pi/pi-utils";

/** A model that thinks at `efforts` only. */
const thinkingModel = (id: string, efforts: Effort[]) =>
	buildModel({
		id,
		name: id,
		api: "anthropic-messages",
		provider: "mock",
		reasoning: true,
		thinking: { mode: "effort", efforts },
		baseUrl: "https://example.invalid",
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 8192,
	});

const saved = { provider: "mock", id: "saved" } as Model;
const parent = thinkingModel("parent", [Effort.Low, Effort.High]);

/** A record's model part; a later held-model setting writes `parentFallbackHeld` when it records the spawn. */
function storedModel(parentFallbackHeld?: boolean, perCallModel = false) {
	return readSpawnSpec({ spawnSpec: { v: 1, model: "mock/saved", perCallModel, parentFallbackHeld } });
}

interface ModelInputs {
	models: RevivedModels;
	modelRegistry: ModelRegistry;
}

/** The registry holds `available` for the saved identity, its provider with a credential unless `credentialed` is false. */
function modelInputs(available: Model | undefined, credentialed = true): ModelInputs {
	const models = {
		resolve: async () => available,
		notFoundMessage: (identity: string) => `Model "${identity}" not found`,
	} as unknown as RevivedModels;
	const modelRegistry = {
		awaitBackgroundRefresh: async () => {},
		hasConfiguredAuth: () => credentialed,
	} as unknown as ModelRegistry;
	return { models, modelRegistry };
}

const coldChoice = (inputs: ModelInputs, mayUseParent: boolean, ceiling?: Effort, fallback: Model = parent) =>
	chooseColdReviveModel({
		id: "cold",
		identity: "mock/saved",
		level: undefined,
		...inputs,
		ceiling,
		fallback,
		mayUseParent,
		guard: undefined,
	});

const cold = async (inputs: ModelInputs, mayUseParent: boolean, ceiling?: Effort, fallback: Model = parent) =>
	(await coldChoice(inputs, mayUseParent, ceiling, fallback)).model;

const perCall = (
	inputs: ModelInputs,
	mayUseParent: boolean,
	approve: (model: Model) => void,
	ceiling?: Effort,
	fallback: Model = parent,
) =>
	choosePerCallModel({
		id: "per-call",
		identity: "mock/saved",
		level: undefined,
		...inputs,
		approve,
		ceiling,
		fallback,
		mayUseParent,
		guard: undefined,
	});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("stored subagent model fallback", () => {
	it("uses the live parent model unless the spawn spec holds its named model", () => {
		expect(mayReviveUseParentModel(storedModel())).toBe(true);
		expect(mayReviveUseParentModel(storedModel(false))).toBe(true);
		expect(mayReviveUseParentModel(storedModel(true))).toBe(false);
	});

	it("falls back to the parent's model for a gone stored model, with one warning naming both", async () => {
		const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
		expect((await cold(modelInputs(undefined), true)).model).toBe(parent);
		expect(warn).toHaveBeenCalledWith('Model "mock/saved" not found', { subagent: "cold", model: "mock/parent" });
	});

	it("refuses a held cold revive whose stored model is gone rather than use the parent's model", async () => {
		await expect(cold(modelInputs(undefined), mayReviveUseParentModel(storedModel(true)))).rejects.toThrow(
			"its spawn holds it to that model",
		);
	});

	it("applies the same held guard to a per-call worker", async () => {
		const approved: Model[] = [];
		const approve = (model: Model) => {
			approved.push(model);
		};
		await expect(
			perCall(modelInputs(undefined), mayReviveUseParentModel(storedModel(true, true)), approve),
		).rejects.toBeInstanceOf(PerCallModelError);
		expect(approved).toEqual([]);
		const unheld = await perCall(
			modelInputs(undefined),
			mayReviveUseParentModel(storedModel(undefined, true)),
			approve,
		);
		expect(unheld.model).toBe(parent);
		// The parent's model is held to the same grant check.
		expect(approved).toEqual([parent]);
	});

	it("treats a saved model without a credential as gone", async () => {
		expect((await cold(modelInputs(saved, false), true)).model).toBe(parent);
		expect((await perCall(modelInputs(saved, false), true, () => {})).model).toBe(parent);
	});

	it("keeps a per-call worker's grant refusal: only a model the registry no longer serves falls back", async () => {
		const denied = new PerCallModelError("Per-call model mock/saved is not approved");
		await expect(
			perCall(modelInputs(saved), true, model => {
				if (model === saved) throw denied;
			}),
		).rejects.toBe(denied);
		const unavailable = await perCall(modelInputs(saved), true, model => {
			if (model === saved) throw new PerCallModelUnavailableError("Per-call model mock/saved is not available");
		});
		expect(unavailable.model).toBe(parent);
		// A parent model the grants refuse refuses the worker.
		await expect(
			perCall(modelInputs(undefined), true, () => {
				throw denied;
			}),
		).rejects.toBe(denied);
	});

	it("names the cause in the fallback warning: no credential, or over the effort ceiling", async () => {
		const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
		await cold(modelInputs(saved, false), true);
		expect(warn).toHaveBeenLastCalledWith('Model "mock/saved" has no credential', {
			subagent: "cold",
			model: "mock/parent",
		});
		await cold(modelInputs(thinkingModel("saved", [Effort.High])), true, Effort.Low);
		expect(warn).toHaveBeenLastCalledWith(
			"mock/saved has no supported thinking effort at or below task.maxEffort=low",
			{ subagent: "cold", model: "mock/parent" },
		);
	});

	it("revives on the parent's model at its lowest effort, with a notice, where that model is over the ceiling too", async () => {
		vi.spyOn(logger, "warn").mockImplementation(() => {});
		const highOnly = thinkingModel("saved", [Effort.High]);
		const highParent = thinkingModel("parent", [Effort.Medium, Effort.High]);
		expect(await coldChoice(modelInputs(highOnly), true, Effort.Low)).toEqual({
			model: { kind: "model", model: parent, thinkingLevel: undefined },
		});
		const choice = await coldChoice(modelInputs(highOnly), true, Effort.Low, highParent);
		// The lowest effort holds: no level the transcript records replaces it.
		expect(choice.model).toEqual({ kind: "model", model: highParent, thinkingLevel: Effort.Medium, levelHeld: true });
		expect(choice.ceilingNotice).toBe(
			'mock/saved has no supported thinking effort at or below task.maxEffort=low, and mock/parent has no supported thinking effort at or below task.maxEffort=low: subagent "cold" runs on mock/parent at its lowest effort, medium, above that ceiling.',
		);
		// The lowest in canonical order, also for a ladder a model lists out of that order.
		const unordered = thinkingModel("parent", [Effort.High, Effort.Medium]);
		expect((await coldChoice(modelInputs(highOnly), true, Effort.Low, unordered)).model).toEqual({
			kind: "model",
			model: unordered,
			thinkingLevel: Effort.Medium,
			levelHeld: true,
		});
	});

	it("falls back from a per-call worker's model over the ceiling, never to a parent model over it", async () => {
		const highOnly = thinkingModel("saved", [Effort.High]);
		const highParent = thinkingModel("parent", [Effort.High]);
		// A per-call worker's fallback is held to the grants and the ceiling its spawn was held to; main has no fallback.
		const approved: Model[] = [];
		const approve = (model: Model) => {
			approved.push(model);
		};
		vi.spyOn(logger, "warn").mockImplementation(() => {});
		expect((await perCall(modelInputs(highOnly), true, approve, Effort.Low)).model).toBe(parent);
		expect(approved).toEqual([highOnly, parent]);
		await expect(perCall(modelInputs(highOnly), true, approve, Effort.Low, highParent)).rejects.toThrow(
			"mock/parent has no supported thinking effort at or below task.maxEffort=low",
		);
	});
});
