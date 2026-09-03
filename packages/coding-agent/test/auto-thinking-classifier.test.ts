import { afterEach, describe, expect, it, vi } from "bun:test";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import * as ai from "@oh-my-pi/pi-ai";
import { Effort, type Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import {
	classifyDifficulty,
	parseDifficultyBucket,
	parseDifficultyLevel,
} from "@oh-my-pi/pi-coding-agent/auto-thinking/classifier";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	AUTO_THINKING,
	clampAutoThinkingEffort,
	parseCliThinkingLevel,
	parseConfiguredThinkingLevel,
	parseEffort,
	parseThinkingLevel,
	resolveProvisionalAutoLevel,
	resolveTaskEffortLevel,
} from "@oh-my-pi/pi-coding-agent/thinking";
import type { TinyMemoryLocalModelKey } from "@oh-my-pi/pi-coding-agent/tiny/models";
import { tinyModelClient } from "@oh-my-pi/pi-coding-agent/tiny/title-client";

describe("auto thinking classifier helpers", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	function createLocalClassifierFixture(autoThinkingModel: TinyMemoryLocalModelKey) {
		const model = getBundledModel("anthropic", "claude-sonnet-4-6");
		if (!model) throw new Error("Expected bundled Claude Sonnet 4.6 model");

		return {
			settings: Settings.isolated({ "providers.autoThinkingModel": autoThinkingModel }),
			registry: null as never,
			model,
		};
	}

	it("parses configured thinking without widening provider-facing thinking selectors", () => {
		expect(parseConfiguredThinkingLevel(AUTO_THINKING)).toBe(AUTO_THINKING);
		expect(parseConfiguredThinkingLevel(Effort.High)).toBe(Effort.High);
		expect(parseConfiguredThinkingLevel("bogus")).toBeUndefined();
		expect(parseThinkingLevel(AUTO_THINKING)).toBeUndefined();
		expect(parseThinkingLevel(ThinkingLevel.Off)).toBe(ThinkingLevel.Off);
	});

	it("parses CLI --thinking selectors while rejecting inherit", () => {
		expect(parseCliThinkingLevel(ThinkingLevel.Off)).toBe(ThinkingLevel.Off);
		expect(parseCliThinkingLevel(AUTO_THINKING)).toBe(AUTO_THINKING);
		expect(parseCliThinkingLevel("max")).toBe(ThinkingLevel.Max);
		expect(parseCliThinkingLevel(ThinkingLevel.Inherit)).toBeUndefined();
		expect(parseCliThinkingLevel("bogus")).toBeUndefined();
	});

	it("maps online level labels to effort levels", () => {
		expect(parseDifficultyLevel("x-high")).toBe(Effort.XHigh);
		expect(parseDifficultyLevel("The answer is HIGH.")).toBe(Effort.High);
		expect(parseDifficultyLevel("med")).toBe(Effort.Medium);
		expect(parseDifficultyLevel("low")).toBe(Effort.Low);
		expect(parseDifficultyLevel("max")).toBe(Effort.Max);
		expect(parseDifficultyLevel("unknown")).toBeUndefined();
	});

	it("maps local 3-bucket labels to coarse effort levels", () => {
		expect(parseDifficultyBucket("trivial")).toBe(Effort.Low);
		expect(parseDifficultyBucket("moderate")).toBe(Effort.High);
		expect(parseDifficultyBucket("hard")).toBe(Effort.XHigh);
		expect(parseDifficultyBucket("medium")).toBeUndefined();
	});

	it("expands the local reasoning classifier budget", async () => {
		let maxTokens: number | undefined;
		const fixture = createLocalClassifierFixture("qwen3-1.7b");
		vi.spyOn(tinyModelClient, "complete").mockImplementation(async (_modelKey, _prompt, options) => {
			maxTokens = options?.maxTokens;
			return "moderate";
		});

		const effort = await classifyDifficulty("fix the local classifier token budget", fixture);

		expect(effort).toBe(Effort.High);
		expect(maxTokens).toBe(1024);
	});

	it("keeps the local classifier capped at xhigh even when opted in to max", async () => {
		// The local backend only ever emits trivial/moderate/hard, so a sparse
		// ladder must not let the opt-in ceiling snap `hard` up to a tier the
		// on-device model never selected. `max` is the model's only tier at or
		// above Low, and the local ceiling hides it, so nothing is eligible —
		// falling through to `minimal` would breach the Low floor.
		const fixture = createLocalClassifierFixture("qwen3-1.7b");
		const sparse = buildLadderModel("mock-minimal-max", [Effort.Minimal, Effort.Max]);
		vi.spyOn(tinyModelClient, "complete").mockResolvedValue("hard");
		const settings = Settings.isolated({
			"providers.autoThinkingModel": "qwen3-1.7b",
			"providers.autoThinkingMaxEffort": "max",
		});

		expect(
			await classifyDifficulty("cut over the storage layer", {
				settings,
				registry: fixture.registry,
				model: sparse,
			}),
		).toBeUndefined();
	});

	it("uses a larger local non-reasoning classifier floor", async () => {
		let maxTokens: number | undefined;
		const fixture = createLocalClassifierFixture("qwen2.5-1.5b");
		vi.spyOn(tinyModelClient, "complete").mockImplementation(async (_modelKey, _prompt, options) => {
			maxTokens = options?.maxTokens;
			return "moderate";
		});

		const effort = await classifyDifficulty("rename a local helper", fixture);

		expect(effort).toBe(Effort.High);
		expect(maxTokens).toBe(16);
	});

	it("uses shared tiny-message preprocessing before local classification", async () => {
		let classifierPrompt = "";
		const fixture = createLocalClassifierFixture("qwen2.5-1.5b");
		vi.spyOn(tinyModelClient, "complete").mockImplementation(async (_modelKey, promptText) => {
			classifierPrompt = promptText;
			return "moderate";
		});

		await classifyDifficulty(
			"\u001b[31minvestigate failure\u001b[0m 54783db3f0f17c74cae81976f0e825a909deb71e\n```\nnoisy code\n```",
			fixture,
		);

		expect(classifierPrompt).toContain("investigate failure 54783db");
		expect(classifierPrompt).not.toContain("54783db3f0f17c74cae81976f0e825a909deb71e");
		expect(classifierPrompt).not.toContain("noisy code");
	});

	it("uses a reasoning-safe online classifier budget when the catalog disables reasoning", async () => {
		const baseModel = getBundledModel("anthropic", "claude-sonnet-4-6");
		if (!baseModel) throw new Error("Expected bundled Claude Sonnet 4.6 model");
		const classifierModel = { ...baseModel, reasoning: false };
		const settings = {
			get(path: string) {
				if (path === "providers.autoThinkingModel") return "online";
				return undefined;
			},
			getModelRole(role: string) {
				return role === "smol" ? `${classifierModel.provider}/${classifierModel.id}` : undefined;
			},
			getStorage() {
				return undefined;
			},
		} as never;
		const registry = {
			getAvailable: () => [classifierModel],
			getApiKey: async () => "test-key",
			resolver: () => async () => "test-key",
		} as never;
		const completeSimpleMock = vi.spyOn(ai, "completeSimple").mockResolvedValue({
			stopReason: "stop",
			content: [{ type: "text", text: "high" }],
		} as never);

		const effort = await classifyDifficulty("add validation around the retry path", {
			settings,
			registry,
			model: baseModel,
		});
		const options = completeSimpleMock.mock.calls[0]?.[2] as
			| { disableReasoning?: boolean; maxTokens?: number }
			| undefined;

		expect(effort).toBe(Effort.High);
		// The cap must exceed Anthropic's 1024-token minimum thinking budget so an
		// Anthropic-dialect proxy (LiteLLM/Vertex) that downgrades the disabled
		// request to the lowest reasoning effort still satisfies
		// `max_tokens > thinking.budget_tokens` (issue #8610).
		expect(options?.disableReasoning).toBe(true);
		expect(options?.maxTokens).toBe(4096);
		expect(options?.maxTokens).toBeGreaterThan(1024);
	});

	function createOnlineFixture(targetModel: Model, answer: string, maxEffort: "xhigh" | "max" = "xhigh") {
		const classifierModel = getBundledModel("anthropic", "claude-sonnet-4-6");
		if (!classifierModel) throw new Error("Expected bundled Claude Sonnet 4.6 model");
		const settings = {
			get(path: string) {
				if (path === "providers.autoThinkingModel") return "online";
				return path === "providers.autoThinkingMaxEffort" ? maxEffort : undefined;
			},
			getModelRole(role: string) {
				return role === "smol" ? `${classifierModel.provider}/${classifierModel.id}` : undefined;
			},
			getStorage() {
				return undefined;
			},
		} as never;
		const registry = {
			getAvailable: () => [classifierModel],
			getApiKey: async () => "test-key",
			resolver: () => async () => "test-key",
		} as never;
		const usage = {
			input: 11,
			output: 2,
			cacheRead: 3,
			cacheWrite: 0,
			totalTokens: 16,
			cost: { input: 0.0011, output: 0.0004, cacheRead: 0.00003, cacheWrite: 0, total: 0.00153 },
		};
		const completeSimpleMock = vi
			.spyOn(ai, "completeSimple")
			.mockImplementation(async (_model, _context, options) => {
				const response = {
					api: classifierModel.api,
					provider: classifierModel.provider,
					model: classifierModel.id,
					usage,
					stopReason: "stop",
					content: [{ type: "text", text: answer }],
				} as never;
				options?.onAttempt?.(response);
				return response;
			});
		return { deps: { settings, registry, model: targetModel }, completeSimpleMock, classifierModel, usage };
	}

	function buildLadderModel(id: string, efforts: Effort[]): Model {
		return buildModel({
			id,
			name: id,
			api: "openai-completions",
			provider: "mock",
			baseUrl: "https://example.com",
			reasoning: true,
			thinking: { mode: "effort", efforts },
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128_000,
			maxTokens: 4096,
		});
	}

	const MAX_LADDER = [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh, Effort.Max];
	const XHIGH_LADDER = [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh];

	it("reports usage for each response when a transient classifier failure is retried", async () => {
		const fixture = createOnlineFixture(buildLadderModel("mock-max", MAX_LADDER), "high");
		fixture.completeSimpleMock.mockImplementationOnce(async (_model, _context, options) => {
			const response = {
				api: fixture.classifierModel.api,
				provider: fixture.classifierModel.provider,
				model: fixture.classifierModel.id,
				usage: fixture.usage,
				stopReason: "error",
				errorStatus: 500,
				errorMessage: "Internal Server Error",
				content: [],
			} as never;
			options?.onAttempt?.(response);
			return response;
		});
		const onUsage = vi.fn();

		await classifyDifficulty("refactor the scheduler", { ...fixture.deps, onUsage });

		expect(fixture.completeSimpleMock).toHaveBeenCalledTimes(2);
		expect(onUsage).toHaveBeenCalledTimes(2);
		expect(onUsage).toHaveBeenNthCalledWith(
			1,
			expect.objectContaining({ stopReason: "error", errorMessage: "Internal Server Error" }),
		);
		expect(onUsage).toHaveBeenNthCalledWith(2, {
			role: "smol",
			api: fixture.classifierModel.api,
			provider: fixture.classifierModel.provider,
			model: fixture.classifierModel.id,
			usage: fixture.usage,
			stopReason: "stop",
			errorMessage: undefined,
		});
	});

	it("offers the max label only when opted in on a model that exposes the tier", async () => {
		const optedIn = createOnlineFixture(buildLadderModel("mock-max", MAX_LADDER), "high", "max");
		await classifyDifficulty("refactor the scheduler", optedIn.deps);
		const optedInRequest = optedIn.completeSimpleMock.mock.calls[0]?.[1] as { systemPrompt: string[] };
		expect(optedInRequest.systemPrompt[0]).toContain("`max`");

		vi.restoreAllMocks();

		const defaulted = createOnlineFixture(buildLadderModel("mock-max", MAX_LADDER), "high");
		await classifyDifficulty("refactor the scheduler", defaulted.deps);
		const defaultedRequest = defaulted.completeSimpleMock.mock.calls[0]?.[1] as { systemPrompt: string[] };
		expect(defaultedRequest.systemPrompt[0]).not.toMatch(/\bmax\b/);
		expect(defaultedRequest.systemPrompt[0]).toContain("`xhigh`");

		vi.restoreAllMocks();

		const unsupported = createOnlineFixture(buildLadderModel("mock-xhigh", XHIGH_LADDER), "high", "max");
		await classifyDifficulty("refactor the scheduler", unsupported.deps);
		const unsupportedRequest = unsupported.completeSimpleMock.mock.calls[0]?.[1] as { systemPrompt: string[] };
		expect(unsupportedRequest.systemPrompt[0]).not.toMatch(/\bmax\b/);
	});

	it("resolves max only when opted in, and snaps it to the ceiling otherwise", async () => {
		const optedIn = createOnlineFixture(buildLadderModel("mock-max", MAX_LADDER), "max", "max");
		expect(await classifyDifficulty("untangle this cross-service race", optedIn.deps)).toBe(Effort.Max);

		vi.restoreAllMocks();

		// Hallucinated `max` on a max-capable model must not cross the default ceiling.
		const defaulted = createOnlineFixture(buildLadderModel("mock-max", MAX_LADDER), "max");
		expect(await classifyDifficulty("untangle this cross-service race", defaulted.deps)).toBe(Effort.XHigh);
	});

	it("resolves the sparse ladder's max tier when opted in", async () => {
		const fixture = createOnlineFixture(buildLadderModel("mock-sparse", [Effort.High, Effort.Max]), "max", "max");
		expect(await classifyDifficulty("cut over the storage layer", fixture.deps)).toBe(Effort.Max);
	});

	it("takes the first label when the classifier echoes several", async () => {
		// `earliest()` is deliberately conservative: an echoed list resolves to the
		// lowest-positioned label rather than the model's final word.
		const fixture = createOnlineFixture(
			buildLadderModel("mock-max", MAX_LADDER),
			"low, medium, high, xhigh, max",
			"max",
		);
		expect(await classifyDifficulty("rename a helper", fixture.deps)).toBe(Effort.Low);
	});

	it("snaps a hallucinated max back to the model's ceiling instead of failing the turn", async () => {
		const fixture = createOnlineFixture(buildLadderModel("mock-xhigh", XHIGH_LADDER), "max");
		expect(await classifyDifficulty("untangle this cross-service race", fixture.deps)).toBe(Effort.XHigh);
	});

	it("resolves no level on a max-only ladder without opt-in", async () => {
		// `["max"]` has nothing at or below the default ceiling, so the model clamp
		// must not snap the request back up — auto yields nothing and the session
		// keeps its current level.
		const defaulted = createOnlineFixture(buildLadderModel("mock-max-only", [Effort.Max]), "xhigh");
		expect(await classifyDifficulty("cut over the storage layer", defaulted.deps)).toBeUndefined();

		vi.restoreAllMocks();

		const optedIn = createOnlineFixture(buildLadderModel("mock-max-only", [Effort.Max]), "max", "max");
		expect(await classifyDifficulty("cut over the storage layer", optedIn.deps)).toBe(Effort.Max);
	});

	it("has no provisional level on a max-only ladder", () => {
		expect(resolveProvisionalAutoLevel(buildLadderModel("mock-max-only", [Effort.Max]))).toBeUndefined();
	});

	it("stops at the highest tier under the ceiling on a sparse ladder", async () => {
		const fixture = createOnlineFixture(buildLadderModel("mock-hm", [Effort.High, Effort.Max]), "max");
		expect(await classifyDifficulty("cut over the storage layer", fixture.deps)).toBe(Effort.High);
	});

	it("keeps the provisional auto level below max even when the model defaults to it", () => {
		const maxDefaultModel = buildModel({
			id: "mock-max-default",
			name: "mock-max-default",
			api: "openai-completions",
			provider: "mock",
			baseUrl: "https://example.com",
			reasoning: true,
			thinking: { mode: "effort", efforts: MAX_LADDER, defaultLevel: Effort.Max },
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128_000,
			maxTokens: 4096,
		});

		expect(resolveProvisionalAutoLevel(maxDefaultModel)).toBe(Effort.XHigh);
	});

	it("clamps auto effort to model support while never resolving below low", () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-6");
		if (!model) throw new Error("Expected bundled Claude Sonnet 4.6 model");

		expect(clampAutoThinkingEffort(model, Effort.XHigh)).toBe(Effort.High);
		expect(clampAutoThinkingEffort(model, Effort.Minimal)).toBe(Effort.Low);
	});

	it("clamps max down to the ladder ceiling on models without a max tier", () => {
		const xhighCeilingModel = buildModel({
			id: "mock-xhigh-ceiling",
			name: "Mock XHigh Ceiling",
			api: "openai-completions",
			provider: "mock",
			baseUrl: "https://example.com",
			reasoning: true,
			thinking: { mode: "effort", efforts: [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh] },
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128_000,
			maxTokens: 4096,
		});

		expect(clampAutoThinkingEffort(xhighCeilingModel, Effort.Max)).toBe(Effort.XHigh);
	});

	it("returns undefined for reasoning models without controllable efforts (devin-agent shape)", () => {
		// Repro for https://github.com/can1357/oh-my-pi/issues/3356 — Devin
		// models report `reasoning: true` but expose no `thinking.efforts` (Cascade
		// selects effort by routing to sibling model ids). `auto` must not invent
		// a concrete effort here, or `requireSupportedEffort` throws in stream.ts.
		const devinModel = {
			id: "glm-5-2",
			name: "GLM-5.2",
			api: "devin-agent",
			provider: "devin",
			baseUrl: "https://server.codeium.com",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128_000,
			maxTokens: 4096,
		} as Model;

		expect(clampAutoThinkingEffort(devinModel, Effort.Low)).toBeUndefined();
		expect(clampAutoThinkingEffort(devinModel, Effort.XHigh)).toBeUndefined();
		expect(clampAutoThinkingEffort(devinModel, Effort.Max)).toBeUndefined();
		expect(resolveProvisionalAutoLevel(devinModel)).toBeUndefined();
	});

	it("parses max as a real thinking level", () => {
		expect(parseEffort("max")).toBe(Effort.Max);
		expect(parseThinkingLevel("max")).toBe(ThinkingLevel.Max);
		expect(parseConfiguredThinkingLevel("max")).toBe(ThinkingLevel.Max);
	});

	it("maps task effort selectors onto each model's supported thinking range", () => {
		const xhighCeilingModel = buildModel({
			id: "mock-xhigh-ceiling",
			name: "Mock XHigh Ceiling",
			api: "openai-completions",
			provider: "mock",
			baseUrl: "https://example.com",
			reasoning: true,
			thinking: { mode: "effort", efforts: [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh] },
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128_000,
			maxTokens: 4096,
		});

		// hi = whatever the model tops out at; lo = its floor; med = middle of
		// the supported range (lower-middle for an even-sized range).
		expect(resolveTaskEffortLevel(xhighCeilingModel, "hi")).toBe(Effort.XHigh);
		expect(resolveTaskEffortLevel(xhighCeilingModel, "lo")).toBe(Effort.Low);
		expect(resolveTaskEffortLevel(xhighCeilingModel, "med")).toBe(Effort.Medium);

		const sonnet = getBundledModel("anthropic", "claude-sonnet-4-6");
		if (!sonnet) throw new Error("Expected bundled Claude Sonnet 4.6 model");
		const sonnetEfforts = sonnet.thinking?.efforts ?? [];
		expect(resolveTaskEffortLevel(sonnet, "hi")).toBe(sonnetEfforts[sonnetEfforts.length - 1]);
		expect(resolveTaskEffortLevel(sonnet, "lo")).toBe(sonnetEfforts[0]);

		const highOnlyModel = buildModel({
			id: "mock-high-only",
			name: "Mock High Only",
			api: "openai-completions",
			provider: "mock",
			baseUrl: "https://example.com",
			reasoning: true,
			thinking: { mode: "effort", efforts: [Effort.High] },
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128_000,
			maxTokens: 4096,
		});
		expect(() => resolveTaskEffortLevel(highOnlyModel, "hi", Effort.Low)).toThrow(
			"mock/mock-high-only has no supported thinking effort at or below task.maxEffort=low",
		);

		// No controllable effort surface (devin-agent shape) → undefined, so the
		// spawn falls back to its default selector instead of forcing an effort.
		const devinModel = {
			id: "glm-5-2",
			name: "GLM-5.2",
			api: "devin-agent",
			provider: "devin",
			baseUrl: "https://server.codeium.com",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128_000,
			maxTokens: 4096,
		} as Model;
		expect(resolveTaskEffortLevel(devinModel, "hi")).toBeUndefined();

		// No model at all → full canonical range.
		expect(resolveTaskEffortLevel(undefined, "lo")).toBe(Effort.Minimal);
		expect(resolveTaskEffortLevel(undefined, "hi")).toBe(Effort.Max);
	});

	it("rejects inherited object keys as thinking selectors", () => {
		for (const selector of ["toString", "constructor", "__proto__"]) {
			expect(parseEffort(selector)).toBeUndefined();
			expect(parseThinkingLevel(selector)).toBeUndefined();
			expect(parseConfiguredThinkingLevel(selector)).toBeUndefined();
		}
	});
});
