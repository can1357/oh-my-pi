import { afterEach, describe, expect, it, vi } from "bun:test";
import { ThinkingLevel } from "@oh-my-pi/pi-agent-core";
import * as ai from "@oh-my-pi/pi-ai";
import { Effort, type Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { classifyDifficulty } from "@oh-my-pi/pi-coding-agent/auto-thinking/classifier";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	AUTO_THINKING,
	AUTO_THINKING_CEILING_SELECTORS,
	AUTO_THINKING_CEILINGS,
	getConfiguredThinkingLevelMetadata,
	AUTO_THINKING_FLOORS,
	AUTO_THINKING_RANGES,
	CLI_THINKING_LEVELS,
	clampAutoThinkingEffort,
	isAutoThinking,
	parseAutoThinkingBounds,
	parseAutoThinkingFloor,
	parseConfiguredThinkingLevel,
	parseEffort,
	parseThinkingLevel,
	resolveProvisionalAutoLevel,
	resolveTaskEffortLevel,
} from "@oh-my-pi/pi-tui/thinking";
import { MAX_THINKING_SUFFIX_OPTIONS, splitThinkingSuffix } from "@oh-my-pi/pi-tui/overlays/model-selector";
import { parseRetryFallbackSelector } from "@oh-my-pi/pi-coding-agent/session/retry-fallback-chains";
import { cfgProvidersAutoThinkingMinEffort } from "@oh-my-pi/pi-coding-agent/session/settings";
import type { TinyMemoryLocalModelKey } from "@oh-my-pi/pi-coding-agent/tiny/models";
import { tinyModelClient } from "@oh-my-pi/pi-coding-agent/tiny/title-client";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

describe("auto thinking classifier helpers", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	function createRegistry(models: Model[], keys: Record<string, string> = {}): ModelRegistry {
		const authStorage = createInMemoryAuthStorage();
		for (const provider in keys) authStorage.keys.setRuntime(provider, keys[provider]!);
		const registry = new ModelRegistry(authStorage, "/nonexistent/auto-thinking-models.yml");
		vi.spyOn(registry, "getAvailable").mockReturnValue(models);
		return registry;
	}

	function createLocalClassifierFixture(autoThinkingModel: TinyMemoryLocalModelKey) {
		const model = getBundledModel("anthropic", "claude-sonnet-4-6");
		if (!model) throw new Error("Expected bundled Claude Sonnet 4.6 model");
		const judge = getBundledModel("local", autoThinkingModel);
		if (!judge) throw new Error(`Expected bundled local judge ${autoThinkingModel}`);

		return {
			settings: Settings.isolated({ modelRoles: { judge: `local/${autoThinkingModel}` } }),
			registry: createRegistry([judge]),
			model,
		};
	}

	it("parses configured thinking without widening provider-facing thinking selectors", () => {
		expect(parseConfiguredThinkingLevel(AUTO_THINKING)).toBe(AUTO_THINKING);
		expect(parseConfiguredThinkingLevel("auto:low")).toBe("auto:low");
		expect(parseConfiguredThinkingLevel("auto:medium")).toBe("auto:medium");
		expect(parseConfiguredThinkingLevel("auto:high")).toBe("auto:high");
		expect(parseConfiguredThinkingLevel("auto:xhigh")).toBe("auto:xhigh");
		expect(parseConfiguredThinkingLevel("auto:minimal")).toBe("auto:minimal");
		expect(parseConfiguredThinkingLevel("auto:max")).toBeUndefined();
		expect(parseConfiguredThinkingLevel("auto:bogus")).toBeUndefined();
		expect(parseConfiguredThinkingLevel(Effort.High)).toBe(Effort.High);
		expect(parseConfiguredThinkingLevel("bogus")).toBeUndefined();
		expect(parseThinkingLevel(AUTO_THINKING)).toBeUndefined();
		expect(parseThinkingLevel("auto:medium")).toBeUndefined();
		expect(parseThinkingLevel("auto:max")).toBeUndefined();
		expect(parseThinkingLevel(ThinkingLevel.Off)).toBe(ThinkingLevel.Off);

		expect(isAutoThinking("auto")).toBe(true);
		expect(isAutoThinking("auto:medium")).toBe(true);
		expect(isAutoThinking("auto:max")).toBe(false);
		expect(isAutoThinking("auto:bogus")).toBe(false);
		expect(isAutoThinking("high")).toBe(false);
		expect(isAutoThinking(undefined)).toBe(false);

		expect(parseAutoThinkingFloor("auto:medium")).toBe(Effort.Medium);
		expect(parseAutoThinkingFloor("auto:xhigh")).toBe(Effort.XHigh);
		expect(parseAutoThinkingFloor("auto:max")).toBeUndefined();
		expect(parseAutoThinkingFloor("auto")).toBeUndefined();
		expect(parseAutoThinkingFloor("high")).toBeUndefined();

		expect(CLI_THINKING_LEVELS).toContain("auto");
		expect(CLI_THINKING_LEVELS).toContain("auto:xhigh");
		expect(CLI_THINKING_LEVELS).not.toContain("auto:max");
	});

	it("parses auto ranges into one canonical selector and rejects non-increasing bounds", () => {
		expect(parseConfiguredThinkingLevel("auto:medium-xhigh")).toBe("auto:medium-xhigh");
		// Abbreviations canonicalize, like the floor-only form.
		expect(parseConfiguredThinkingLevel("auto:med-xhi")).toBe("auto:medium-xhigh");
		expect(parseAutoThinkingBounds("auto:low-max")).toEqual({ floor: Effort.Low, ceiling: Effort.Max });
		expect(parseAutoThinkingBounds("auto:high")).toEqual({ floor: Effort.High });
		for (const invalid of ["auto:high-high", "auto:xhigh-medium", "auto:max-max", "auto:low-high-max", "auto:low-"]) {
			expect(parseConfiguredThinkingLevel(invalid)).toBeUndefined();
			expect(isAutoThinking(invalid)).toBe(false);
		}
		// The literal list the settings enum and RPC wire are built from is exactly the
		// set of pairs the parser accepts; a drift either way silently rejects a valid
		// config value or advertises one the session cannot honor.
		const accepted = AUTO_THINKING_FLOORS.flatMap(floor =>
			AUTO_THINKING_CEILINGS.map(ceiling => `auto:${floor}-${ceiling}`),
		).filter(selector => parseConfiguredThinkingLevel(selector) !== undefined);
		expect(accepted).toEqual([...AUTO_THINKING_RANGES]);
	});

	it("parses a ceiling-only auto:-<ceiling> selector", () => {
		expect(parseConfiguredThinkingLevel("auto:-xhigh")).toBe("auto:-xhigh");
		expect(parseConfiguredThinkingLevel("auto:-hi")).toBe("auto:-high");
		expect(parseAutoThinkingBounds("auto:-max")).toEqual({ ceiling: Effort.Max });
		expect(parseAutoThinkingFloor("auto:-max")).toBeUndefined();
		expect(isAutoThinking("auto:-medium")).toBe(true);
		for (const invalid of ["auto:-minimal", "auto:-", "auto:--max", "auto:-bogus"]) {
			expect(parseConfiguredThinkingLevel(invalid)).toBeUndefined();
			expect(isAutoThinking(invalid)).toBe(false);
		}
		// The list the settings enum and RPC wire are built from matches what the parser accepts.
		const accepted = AUTO_THINKING_CEILINGS.map(ceiling => `auto:-${ceiling}`).filter(
			selector => parseConfiguredThinkingLevel(selector) !== undefined,
		);
		expect(accepted).toEqual([...AUTO_THINKING_CEILING_SELECTORS]);
		expect(getConfiguredThinkingLevelMetadata("auto:-xhigh").label).toBe("auto (up to xhigh)");
		expect(splitThinkingSuffix("openai-codex/gpt-6-luna:auto:-xhigh", -1, MAX_THINKING_SUFFIX_OPTIONS)).toEqual({
			base: "openai-codex/gpt-6-luna",
			level: "auto:-xhigh",
		});
		// Strict-first callers leave it whole for the opted-in pass.
		expect(splitThinkingSuffix("openai-codex/gpt-6-luna:auto:-xhigh")).toEqual({
			base: "openai-codex/gpt-6-luna:auto:-xhigh",
		});
	});

	it("splits an auto range off model and fallback-chain selectors", () => {
		expect(splitThinkingSuffix("openai-codex/gpt-6-luna:auto:medium-xhigh", -1, MAX_THINKING_SUFFIX_OPTIONS)).toEqual(
			{ base: "openai-codex/gpt-6-luna", level: "auto:medium-xhigh" },
		);
		expect(parseRetryFallbackSelector("openai-codex/gpt-6-luna:auto:medium-xhigh")).toEqual({
			raw: "openai-codex/gpt-6-luna:auto:medium-xhigh",
			provider: "openai-codex",
			id: "gpt-6-luna",
			thinkingLevel: undefined,
			autoThinkingLevel: "auto:medium-xhigh",
		});
		// An invalid range is not a suffix; the text stays part of the model id.
		expect(splitThinkingSuffix("p/m:auto:high-low", -1, MAX_THINKING_SUFFIX_OPTIONS)).toEqual({
			base: "p/m:auto:high-low",
		});
	});

	it("expands the local reasoning classifier budget", async () => {
		let maxTokens: number | undefined;
		const fixture = createLocalClassifierFixture("qwen3-1.7b");
		vi.spyOn(tinyModelClient, "complete").mockImplementation(async (_modelKey, _prompt, options) => {
			maxTokens = options?.maxTokens;
			return "moderate";
		});

		const effort = await classifyDifficulty({ request: "fix the local classifier token budget" }, fixture);

		expect(effort).toBe(Effort.High);
		expect(maxTokens).toBe(1024);
	});

	it.each([
		["trivial", Effort.Low],
		["moderate", Effort.High],
		["hard", Effort.XHigh],
	] as const)("maps the local %s bucket to its stable effort boundary", async (answer, expected) => {
		const fixture = createLocalClassifierFixture("qwen3-1.7b");
		vi.spyOn(tinyModelClient, "complete").mockResolvedValue(answer);

		expect(
			await classifyDifficulty(
				{ request: "classify this task" },
				{
					...fixture,
					model: buildLadderModel("bucket-target", XHIGH_LADDER),
				},
			),
		).toBe(expected);
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
			modelRoles: { judge: "local/qwen3-1.7b" },
			"providers.autoThinkingMaxEffort": "max",
		});

		expect(
			await classifyDifficulty(
				{ request: "cut over the storage layer" },
				{
					settings,
					registry: fixture.registry,
					model: sparse,
				},
			),
		).toBeUndefined();
	});

	it("uses a larger local non-reasoning classifier floor", async () => {
		let maxTokens: number | undefined;
		const fixture = createLocalClassifierFixture("qwen2.5-1.5b");
		vi.spyOn(tinyModelClient, "complete").mockImplementation(async (_modelKey, _prompt, options) => {
			maxTokens = options?.maxTokens;
			return "moderate";
		});

		const effort = await classifyDifficulty({ request: "rename a local helper" }, fixture);

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
			{
				request:
					"\u001b[31minvestigate failure\u001b[0m 54783db3f0f17c74cae81976f0e825a909deb71e\n```\nnoisy code\n```",
			},
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
		const settings = Settings.isolated({
			modelRoles: { judge: `${classifierModel.provider}/${classifierModel.id}` },
		});
		const registry = createRegistry([classifierModel], { [classifierModel.provider]: "test-key" });
		const completeSimpleMock = vi.spyOn(ai, "completeSimple").mockResolvedValue({
			stopReason: "stop",
			content: [{ type: "text", text: "high" }],
		} as never);

		const effort = await classifyDifficulty(
			{ request: "add validation around the retry path" },
			{
				settings,
				registry,
				model: baseModel,
			},
		);
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
		const settings = Settings.isolated({
			modelRoles: { judge: `${classifierModel.provider}/${classifierModel.id}` },
			"providers.autoThinkingMaxEffort": maxEffort,
		});
		const registry = createRegistry([classifierModel], { [classifierModel.provider]: "test-key" });
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

	it("classifies a delegated turn from its solution space alone, falling back to the request when blank", async () => {
		const fixture = createOnlineFixture(buildLadderModel("mock-xhigh", XHIGH_LADDER), "xhigh");
		// State rides the user message; the system prompt names the field in its instructions.
		const judgeState = (call: number) => JSON.stringify(fixture.completeSimpleMock.mock.calls[call]?.[1].messages);

		await classifyDifficulty(
			{ request: "update the retry handler", solutionSpace: " deadlock cause open, no repro " },
			fixture.deps,
		);
		await classifyDifficulty({ request: "update the retry handler", solutionSpace: "   " }, fixture.deps);

		expect(judgeState(0)).toContain("<solution_space>deadlock cause open, no repro</solution_space>");
		expect(judgeState(0)).not.toContain("update the retry handler");
		expect(judgeState(1)).toContain("update the retry handler");
		expect(judgeState(1)).not.toContain("<solution_space>");
	});

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

		await classifyDifficulty({ request: "refactor the scheduler" }, { ...fixture.deps, onUsage });

		expect(fixture.completeSimpleMock).toHaveBeenCalledTimes(2);
		expect(onUsage).toHaveBeenCalledTimes(2);
		expect(onUsage).toHaveBeenNthCalledWith(
			1,
			expect.objectContaining({ role: "judge", stopReason: "error", errorMessage: "Internal Server Error" }),
		);
		expect(onUsage).toHaveBeenNthCalledWith(2, {
			purpose: "auto-thinking",
			role: "judge",
			api: fixture.classifierModel.api,
			provider: fixture.classifierModel.provider,
			model: fixture.classifierModel.id,
			usage: fixture.usage,
			stopReason: "stop",
			errorMessage: undefined,
		});
	});

	it("resolves max only when opted in, and rejects it as off-ladder otherwise", async () => {
		const optedIn = createOnlineFixture(buildLadderModel("mock-max", MAX_LADDER), "max", "max");
		expect(await classifyDifficulty({ request: "untangle this cross-service race" }, optedIn.deps)).toBe(Effort.Max);

		vi.restoreAllMocks();

		// A `max` the question never offered is not an answer: the classification
		// fails (the caller keeps its provisional level) rather than crossing the
		// default ceiling.
		const defaulted = createOnlineFixture(buildLadderModel("mock-max", MAX_LADDER), "max");
		await expect(
			classifyDifficulty({ request: "untangle this cross-service race" }, defaulted.deps),
		).rejects.toThrow();
	});

	it("resolves the sparse ladder's max tier when opted in", async () => {
		const fixture = createOnlineFixture(buildLadderModel("mock-sparse", [Effort.High, Effort.Max]), "max", "max");
		expect(await classifyDifficulty({ request: "cut over the storage layer" }, fixture.deps)).toBe(Effort.Max);
	});

	it("takes the first label when the classifier echoes several", async () => {
		// `earliest()` is deliberately conservative: an echoed list resolves to the
		// lowest-positioned label rather than the model's final word.
		const fixture = createOnlineFixture(
			buildLadderModel("mock-max", MAX_LADDER),
			"low, medium, high, xhigh, max",
			"max",
		);
		expect(await classifyDifficulty({ request: "rename a helper" }, fixture.deps)).toBe(Effort.Low);
	});

	it("resolves no level on a max-only ladder without opt-in", async () => {
		// `["max"]` has nothing at or below the default ceiling, so the model clamp
		// must not snap the request back up — auto yields nothing and the session
		// keeps its current level.
		const defaulted = createOnlineFixture(buildLadderModel("mock-max-only", [Effort.Max]), "xhigh");
		expect(await classifyDifficulty({ request: "cut over the storage layer" }, defaulted.deps)).toBeUndefined();

		vi.restoreAllMocks();

		const optedIn = createOnlineFixture(buildLadderModel("mock-max-only", [Effort.Max]), "max", "max");
		expect(await classifyDifficulty({ request: "cut over the storage layer" }, optedIn.deps)).toBe(Effort.Max);
	});

	it("has no provisional level on a max-only ladder", () => {
		expect(resolveProvisionalAutoLevel(buildLadderModel("mock-max-only", [Effort.Max]))).toBeUndefined();
	});

	it("stops at the highest tier under the ceiling on a sparse ladder", async () => {
		const fixture = createOnlineFixture(buildLadderModel("mock-hm", [Effort.High, Effort.Max]), "xhigh");
		expect(await classifyDifficulty({ request: "cut over the storage layer" }, fixture.deps)).toBe(Effort.High);
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

	it("respects the minimum effort floor when clamping auto effort and resolving provisional level", () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-6");
		if (!model) throw new Error("Expected bundled Claude Sonnet 4.6 model");

		// Default floor is Low
		expect(clampAutoThinkingEffort(model, Effort.Minimal)).toBe(Effort.Low);
		// Configured floor: Medium
		expect(clampAutoThinkingEffort(model, Effort.Low, Effort.XHigh, Effort.Medium)).toBe(Effort.Medium);
		expect(clampAutoThinkingEffort(model, Effort.High, Effort.XHigh, Effort.Medium)).toBe(Effort.High);

		// Configured floor: Minimal allows minimal when supported
		const minimalCapableModel = buildModel({
			id: "mock-minimal",
			name: "Mock Minimal",
			api: "openai-completions",
			provider: "mock",
			baseUrl: "https://example.com",
			reasoning: true,
			thinking: { mode: "effort", efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High] },
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128_000,
			maxTokens: 4096,
		});
		expect(clampAutoThinkingEffort(minimalCapableModel, Effort.Minimal, Effort.XHigh, Effort.Minimal)).toBe(
			Effort.Minimal,
		);
		// Default floor Low raises Minimal to Low
		expect(clampAutoThinkingEffort(minimalCapableModel, Effort.Minimal, Effort.XHigh)).toBe(Effort.Low);

		// resolveProvisionalAutoLevel with floor
		const lowDefaultModel = buildModel({
			id: "mock-low-default",
			name: "Mock Low Default",
			api: "openai-completions",
			provider: "mock",
			baseUrl: "https://example.com",
			reasoning: true,
			thinking: { mode: "effort", efforts: [Effort.Low, Effort.Medium, Effort.High], defaultLevel: Effort.Low },
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128_000,
			maxTokens: 4096,
		});
		// Default floor (Low) keeps lowDefaultModel at Low
		expect(resolveProvisionalAutoLevel(lowDefaultModel)).toBe(Effort.Low);
		// Configured floor (Medium) raises provisional level to Medium
		expect(resolveProvisionalAutoLevel(lowDefaultModel, Effort.Medium)).toBe(Effort.Medium);
		// Configured floor (High) raises provisional level to High
		expect(resolveProvisionalAutoLevel(lowDefaultModel, Effort.High)).toBe(Effort.High);
	});

	it("respects minEffort floor in classifyDifficulty via deps and settings", async () => {
		const fixture = createLocalClassifierFixture("qwen3-1.7b");
		vi.spyOn(tinyModelClient, "complete").mockResolvedValue("trivial");

		// Without minEffort, trivial maps to Low
		const defaultEffort = await classifyDifficulty({ request: "simple question" }, fixture);
		expect(defaultEffort).toBe(Effort.Low);

		// With minEffort in deps, trivial is raised to floor
		const highFloorEffort = await classifyDifficulty(
			{ request: "simple question" },
			{ ...fixture, minEffort: Effort.High },
		);
		expect(highFloorEffort).toBe(Effort.High);

		// With providers.autoThinkingMinEffort in settings
		const settingsWithFloor = Settings.isolated({
			modelRoles: { judge: "local/qwen3-1.7b" },
		});
		cfgProvidersAutoThinkingMinEffort.set(settingsWithFloor, Effort.Medium);
		const mediumFloorEffort = await classifyDifficulty(
			{ request: "simple question" },
			{ ...fixture, settings: settingsWithFloor },
		);
		expect(mediumFloorEffort).toBe(Effort.Medium);
	});

	it("caps classification at a range ceiling and lets an auto:<floor>-max range offer max", async () => {
		// Ceiling below the classifier's answer: the range wins over the global setting.
		const capped = createOnlineFixture(buildLadderModel("mock-max", MAX_LADDER), "xhigh");
		expect(
			await classifyDifficulty(
				{ request: "cut over the storage layer" },
				{ ...capped.deps, maxEffort: Effort.Medium },
			),
		).toBe(Effort.Medium);

		vi.restoreAllMocks();

		// `providers.autoThinkingMaxEffort` is xhigh, so `max` is off-ladder by default
		// (see the opt-in test above); a `-max` range ceiling offers it for this turn.
		const lifted = createOnlineFixture(buildLadderModel("mock-max", MAX_LADDER), "max");
		expect(
			await classifyDifficulty(
				{ request: "untangle this cross-service race" },
				{ ...lifted.deps, maxEffort: Effort.Max },
			),
		).toBe(Effort.Max);

		vi.restoreAllMocks();

		// The local bucket question still respects a lower ceiling.
		const local = createLocalClassifierFixture("qwen3-1.7b");
		vi.spyOn(tinyModelClient, "complete").mockResolvedValue("hard");
		expect(await classifyDifficulty({ request: "migrate the cluster" }, { ...local, maxEffort: Effort.High })).toBe(
			Effort.High,
		);
	});

	it("keeps the provisional auto level inside a range ceiling", () => {
		const highDefault = buildLadderModel("mock-xhigh", XHIGH_LADDER);
		// No selector ceiling: the High default stands.
		expect(resolveProvisionalAutoLevel(highDefault, Effort.Low)).toBe(Effort.High);
		expect(resolveProvisionalAutoLevel(highDefault, Effort.Low, Effort.Medium)).toBe(Effort.Medium);
		// A ceiling above xhigh never lets the unclassified placeholder bill max.
		expect(resolveProvisionalAutoLevel(buildLadderModel("mock-max", MAX_LADDER), Effort.Low, Effort.Max)).toBe(
			Effort.High,
		);
	});

	it("maps task effort hints inside the selector's range, under the task.maxEffort ceiling", () => {
		const model = buildLadderModel("mock-max", MAX_LADDER);
		const bounds = { floor: Effort.Medium, ceiling: Effort.XHigh } as const;
		expect(resolveTaskEffortLevel(model, "lo", undefined, bounds)).toBe(Effort.Medium);
		expect(resolveTaskEffortLevel(model, "med", undefined, bounds)).toBe(Effort.High);
		expect(resolveTaskEffortLevel(model, "hi", undefined, bounds)).toBe(Effort.XHigh);
		// The operator's hard ceiling still wins over a higher selector floor, and a
		// floor above it lowers the spawn instead of failing it.
		expect(resolveTaskEffortLevel(model, "lo", Effort.Low, bounds)).toBe(Effort.Low);
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
