import { afterEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { ThinkingLevel } from "@pk-nerdsaver-ai/pi-agent-core";
import { Effort, type Model } from "@pk-nerdsaver-ai/pi-ai";
import { getBundledModel } from "@pk-nerdsaver-ai/pi-catalog/models";
import {
	classifyDifficulty,
	parseDifficultyBucket,
	parseDifficultyLevel,
} from "@pk-nerdsaver-ai/pi-coding-agent/auto-thinking/classifier";
import { ModelRegistry } from "@pk-nerdsaver-ai/pi-coding-agent/config/model-registry";
import { Settings } from "@pk-nerdsaver-ai/pi-coding-agent/config/settings";
import { AuthStorage } from "@pk-nerdsaver-ai/pi-coding-agent/session/auth-storage";
import {
	AUTO_THINKING,
	clampAutoThinkingEffort,
	parseCliThinkingLevel,
	parseConfiguredThinkingLevel,
	parseEffort,
	parseThinkingLevel,
	resolveProvisionalAutoLevel,
} from "@pk-nerdsaver-ai/pi-coding-agent/thinking";
import type { TinyMemoryLocalModelKey } from "@pk-nerdsaver-ai/pi-coding-agent/tiny/models";
import { tinyModelClient } from "@pk-nerdsaver-ai/pi-coding-agent/tiny/title-client";
import { TempDir } from "@pk-nerdsaver-ai/pi-utils";

describe("auto thinking classifier helpers", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	interface LocalClassifierFixture {
		settings: Settings;
		registry: ModelRegistry;
		model: Model;
		cleanup: () => void;
	}

	async function createLocalClassifierFixture(
		autoThinkingModel: TinyMemoryLocalModelKey,
	): Promise<LocalClassifierFixture> {
		const tempDir = TempDir.createSync("@pi-auto-thinking-classifier-");
		const authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		const model = getBundledModel("anthropic", "claude-sonnet-4-6");
		if (!model) {
			authStorage.close();
			tempDir.removeSync();
			throw new Error("Expected bundled Claude Sonnet 4.6 model");
		}

		return {
			settings: Settings.isolated({ "providers.autoThinkingModel": autoThinkingModel }),
			registry: new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml")),
			model,
			cleanup: () => {
				authStorage.close();
				tempDir.removeSync();
			},
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
		expect(parseCliThinkingLevel("max")).toBe(ThinkingLevel.XHigh);
		expect(parseCliThinkingLevel(ThinkingLevel.Inherit)).toBeUndefined();
		expect(parseCliThinkingLevel("bogus")).toBeUndefined();
	});

	it("maps online 4-way classifier labels to effort levels", () => {
		expect(parseDifficultyLevel("x-high")).toBe(Effort.XHigh);
		expect(parseDifficultyLevel("The answer is HIGH.")).toBe(Effort.High);
		expect(parseDifficultyLevel("med")).toBe(Effort.Medium);
		expect(parseDifficultyLevel("low")).toBe(Effort.Low);
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
		const fixture = await createLocalClassifierFixture("qwen3-1.7b");
		vi.spyOn(tinyModelClient, "complete").mockImplementation(async (_modelKey, _prompt, options) => {
			maxTokens = options?.maxTokens;
			return "moderate";
		});

		try {
			const effort = await classifyDifficulty("fix the local classifier token budget", {
				settings: fixture.settings,
				registry: fixture.registry,
				model: fixture.model,
			});

			expect(effort).toBe(Effort.High);
			expect(maxTokens).toBe(1024);
		} finally {
			fixture.cleanup();
		}
	});

	it("uses a larger local non-reasoning classifier floor", async () => {
		let maxTokens: number | undefined;
		const fixture = await createLocalClassifierFixture("qwen2.5-1.5b");
		vi.spyOn(tinyModelClient, "complete").mockImplementation(async (_modelKey, _prompt, options) => {
			maxTokens = options?.maxTokens;
			return "moderate";
		});

		try {
			const effort = await classifyDifficulty("rename a local helper", {
				settings: fixture.settings,
				registry: fixture.registry,
				model: fixture.model,
			});

			expect(effort).toBe(Effort.High);
			expect(maxTokens).toBe(16);
		} finally {
			fixture.cleanup();
		}
	});

	it("clamps auto effort to model support while never resolving below low", () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-6");
		if (!model) throw new Error("Expected bundled Claude Sonnet 4.6 model");

		expect(clampAutoThinkingEffort(model, Effort.XHigh)).toBe(Effort.High);
		expect(clampAutoThinkingEffort(model, Effort.Minimal)).toBe(Effort.Low);
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
		expect(resolveProvisionalAutoLevel(devinModel)).toBeUndefined();
	});

	it("accepts max as the top configured thinking alias", () => {
		expect(parseEffort("max")).toBe(Effort.XHigh);
		expect(parseThinkingLevel("max")).toBeUndefined();
		expect(parseConfiguredThinkingLevel("max")).toBe(ThinkingLevel.XHigh);
	});

	it("rejects inherited object keys as thinking selectors", () => {
		for (const selector of ["toString", "constructor", "__proto__"]) {
			expect(parseEffort(selector)).toBeUndefined();
			expect(parseThinkingLevel(selector)).toBeUndefined();
			expect(parseConfiguredThinkingLevel(selector)).toBeUndefined();
		}
	});
});
