import { describe, expect, it, vi } from "bun:test";
import type { Model } from "@oh-my-pi/pi-ai";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { executeBuiltinSlashCommand } from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import { resolveRetryFallbackChainKey } from "@oh-my-pi/pi-coding-agent/session/retry-fallback-chains";

const MODELS: Model[] = [
	{ provider: "anthropic", id: "claude-opus-4-5", contextWindow: 200_000 },
	{ provider: "anthropic", id: "claude-sonnet-4-5", contextWindow: 200_000 },
	{ provider: "openai", id: "gpt-5.2", contextWindow: 400_000 },
	{ provider: "unauth", id: "ghost-model", contextWindow: 100_000 },
];

function createRuntime(authenticatedModels: Model[] = [MODELS[0]!, MODELS[1]!, MODELS[2]!]) {
	const showModelSelector = vi.fn();
	const switchSessionModel = vi.fn(async () => {});
	const showError = vi.fn();
	const showStatus = vi.fn();
	const setText = vi.fn();
	const settings = Settings.isolated();

	const hasConfiguredAuth = vi.fn((model: Model) =>
		authenticatedModels.some(m => m.provider === model.provider && m.id === model.id),
	);

	return {
		showModelSelector,
		switchSessionModel,
		showError,
		showStatus,
		setText,
		settings,
		hasConfiguredAuth,
		runtime: {
			ctx: {
				editor: { setText } as unknown as InteractiveModeContext["editor"],
				settings,
				session: {
					scopedModels: [],
					modelRegistry: {
						getAll: () => MODELS,
						getAvailable: () => authenticatedModels,
						hasConfiguredAuth,
						hasProvider: (p: string) => MODELS.some(m => m.provider === p),
					},
				},
				showModelSelector,
				switchSessionModel,
				showError,
				showStatus,
			} as unknown as InteractiveModeContext,
		},
	};
}

describe("/switch fallback support", () => {
	it("falls back to the next model in a comma-separated list when the first is unauthenticated", async () => {
		// ghost-model has no auth, gpt-5.2 has auth
		const harness = createRuntime([MODELS[2]!]);

		await executeBuiltinSlashCommand("/switch ghost-model,gpt-5.2", harness.runtime);

		expect(harness.switchSessionModel).toHaveBeenCalledWith(
			MODELS[2],
			undefined,
			expect.objectContaining({
				fallbackNotice: expect.stringContaining("fell back from ghost-model"),
			}),
		);
	});

	it("falls back to the next model in a space-separated list when the first is unauthenticated", async () => {
		const harness = createRuntime([MODELS[1]!]);

		await executeBuiltinSlashCommand("/switch unauth/ghost-model anthropic/claude-sonnet-4-5", harness.runtime);

		expect(harness.switchSessionModel).toHaveBeenCalledWith(
			MODELS[1],
			undefined,
			expect.objectContaining({
				fallbackNotice: expect.stringContaining("fell back from unauth/ghost-model"),
			}),
		);
	});

	it("consults configured retry.fallbackChains when a single requested model lacks auth", async () => {
		const harness = createRuntime([MODELS[1]!]);
		harness.settings.set("retry.fallbackChains", {
			"unauth/ghost-model": ["anthropic/claude-sonnet-4-5"],
		});

		await executeBuiltinSlashCommand("/switch unauth/ghost-model", harness.runtime);

		expect(harness.switchSessionModel).toHaveBeenCalledWith(
			MODELS[1],
			undefined,
			expect.objectContaining({
				fallbackNotice: expect.stringContaining("fell back from unauth/ghost-model"),
			}),
		);
	});

	it("consults provider wildcard fallback chain when single model lacks auth", async () => {
		const harness = createRuntime([MODELS[2]!]);
		harness.settings.set("retry.fallbackChains", {
			"unauth/*": ["openai/gpt-5.2"],
		});

		await executeBuiltinSlashCommand("/switch unauth/ghost-model", harness.runtime);

		expect(harness.switchSessionModel).toHaveBeenCalledWith(
			MODELS[2],
			undefined,
			expect.objectContaining({
				fallbackNotice: expect.stringContaining("fell back from unauth/ghost-model"),
			}),
		);
	});

	it("consults default fallback chain when single model lacks auth", async () => {
		const harness = createRuntime([MODELS[2]!]);
		harness.settings.set("retry.fallbackChains", {
			default: ["openai/gpt-5.2"],
		});

		await executeBuiltinSlashCommand("/switch unauth/ghost-model", harness.runtime);

		expect(harness.switchSessionModel).toHaveBeenCalledWith(
			MODELS[2],
			undefined,
			expect.objectContaining({
				fallbackNotice: expect.stringContaining("fell back from unauth/ghost-model"),
			}),
		);
	});

	it("resolves default fallback chain for session-switched models when no specific chain matches", () => {
		const context = {
			chains: {
				default: ["openai/gpt-5.2"],
			},
			getModelRole: (_role: string) => undefined,
			modelLookup: {
				find: (provider: string, id: string) => MODELS.find(m => m.provider === provider && m.id === id),
				hasProvider: (provider: string) => MODELS.some(m => m.provider === provider),
			},
		};

		// Session switched to a model without an explicit chain
		const resolvedChainKey = resolveRetryFallbackChainKey(context, "anthropic/claude-opus-4-5", MODELS[0]);

		expect(resolvedChainKey).toBe("default");
	});
});
