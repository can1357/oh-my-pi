import { describe, expect, test } from "bun:test";
import { buildModel } from "@pk-nerdsaver-ai/pi-catalog/build";
import type { ModelRegistry } from "@pk-nerdsaver-ai/pi-coding-agent/config/model-registry";
import {
	resolveAgentModelPatterns,
	resolveModelOverride,
} from "@pk-nerdsaver-ai/pi-coding-agent/config/model-resolver";
import { Settings } from "@pk-nerdsaver-ai/pi-coding-agent/config/settings";

function fastContextBackupRegistry(): Pick<ModelRegistry, "getAvailable"> {
	return {
		getAvailable: () => [
			buildModel({
				id: "nvidia/nemotron-3-super-120b-a12b:free",
				name: "Nemotron 3 Super (free)",
				api: "openrouter",
				provider: "openrouter",
				baseUrl: "https://openrouter.ai/api/v1",
				reasoning: true,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 1_000_000,
				maxTokens: 262_144,
			}),
		],
	};
}

describe("fast-context model role", () => {
	test("prioritizes OpenRouter North Mini Code before NVIDIA backup", () => {
		const settings = Settings.isolated();

		expect(resolveAgentModelPatterns({ agentModel: "pi/fast-context", settings })).toEqual([
			"openrouter/cohere/north-mini-code:free",
			"openrouter/nvidia/nemotron-3-super-120b-a12b:free",
		]);
	});

	test("resolves the NVIDIA backup when North Mini Code is unavailable", () => {
		const settings = Settings.isolated();
		const patterns = resolveAgentModelPatterns({ agentModel: "pi/fast-context", settings });
		const resolved = resolveModelOverride(patterns, fastContextBackupRegistry(), settings);

		expect(resolved.model?.provider).toBe("openrouter");
		expect(resolved.model?.id).toBe("nvidia/nemotron-3-super-120b-a12b:free");
	});
});

describe("browser-control model role", () => {
	test("defaults to MiniMax M3 chain via pi/browser-control", () => {
		const settings = Settings.isolated();

		expect(resolveAgentModelPatterns({ agentModel: "pi/browser-control", settings })).toEqual([
			"9router/minimax/MiniMax-M3",
			"9router/minimax-m3-rr",
			"9router/minimax-m3-fallback",
			"minimax-code/MiniMax-M3",
			"minimax/MiniMax-M3",
		]);
	});

	test("respects modelRoles.browser-control override", () => {
		const settings = Settings.isolated();
		settings.setModelRole("browser-control", "google/gemini-2.5-flash-lite");

		expect(resolveAgentModelPatterns({ agentModel: "pi/browser-control", settings })).toEqual([
			"google/gemini-2.5-flash-lite",
		]);
	});

	test("keeps pi/browser-operation as a compatibility role", () => {
		const settings = Settings.isolated();

		expect(resolveAgentModelPatterns({ agentModel: "pi/browser-operation", settings })).toEqual([
			"9router/minimax/MiniMax-M3",
			"9router/minimax-m3-rr",
			"9router/minimax-m3-fallback",
			"minimax-code/MiniMax-M3",
			"minimax/MiniMax-M3",
		]);
	});
});

describe("9router combo model roles", () => {
	test("prioritizes app-level fallback combos for max-intelligence", () => {
		const settings = Settings.isolated();

		expect(resolveAgentModelPatterns({ agentModel: "pi/max-intelligence", settings }).slice(0, 5)).toEqual([
			"9router/omp",
			"9router/ompk",
			"9router/oh-my-pk",
			"9router/oh-my-pi-fork",
			"9router/omp-default",
		]);
	});

	test("surfaces fast and free 9router combos before public free fallbacks", () => {
		const settings = Settings.isolated();

		expect(resolveAgentModelPatterns({ agentModel: "pi/free", settings }).slice(0, 3)).toEqual([
			"9router/fast",
			"9router/fast-fallback",
			"9router/gpt-oss-120b-fast-tier-rr",
		]);
	});
});
