import { describe, expect, it } from "bun:test";
import { Database } from "bun:sqlite";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AuthStorage, SqliteAuthCredentialStore } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { resolveCliModel } from "@oh-my-pi/pi-coding-agent/config/model-resolver";
import { TurnRecovery, type TurnRecoveryHost } from "@oh-my-pi/pi-coding-agent/session/turn-recovery";
import { formatModelSelectorValue } from "@oh-my-pi/pi-tui/overlays/model-selector";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";

describe("Issue #18389: --model pi/<role> fallback chain resolution", () => {
	function setupEnvironment() {
		const store = new SqliteAuthCredentialStore(new Database(":memory:"));
		const storage = new AuthStorage(store);
		storage.keys.setRuntime("devin", "devin-key");
		storage.keys.setRuntime("anthropic", "anthropic-key");
		storage.keys.setRuntime("google-antigravity", "google-key");

		const modelRegistry = new ModelRegistry(storage);
		modelRegistry.registerProvider("devin", {
			baseUrl: "https://devin.example.com/v1",
			apiKey: "devin-key",
			api: "openai-completions",
			models: [
				{
					id: "claude-opus-5-5",
					name: "Claude Opus 5.5 (Devin)",
					reasoning: true,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 200000,
					maxTokens: 8192,
				},
			],
		});
		modelRegistry.registerProvider("anthropic", {
			baseUrl: "https://anthropic.example.com/v1",
			apiKey: "anthropic-key",
			api: "anthropic-messages",
			models: [
				{
					id: "claude-opus-5-5",
					name: "Claude Opus 5.5 (Anthropic)",
					reasoning: true,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 200000,
					maxTokens: 8192,
				},
			],
		});
		modelRegistry.registerProvider("google-antigravity", {
			baseUrl: "https://google.example.com/v1",
			apiKey: "google-key",
			api: "google-ai",
			models: [
				{
					id: "gemini-4-argon",
					name: "Gemini 4 Argon",
					reasoning: true,
					input: ["text"],
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
					contextWindow: 200000,
					maxTokens: 8192,
				},
			],
		});

		const activeSettings = Settings.isolated({
			modelRoles: {
				lead: "devin/claude-opus-5-5:low",
			},
			"retry.fallbackChains": {
				lead: ["anthropic/claude-opus-5-5:low"],
				default: ["google-antigravity/gemini-4-argon:low"],
			},
		});

		return { modelRegistry, activeSettings, storage };
	}

	it("reproduces the unpatched behavior when modelRole is omitted (escapes to default)", () => {
		const { modelRegistry, activeSettings } = setupEnvironment();

		const resolved = resolveCliModel({
			cliModel: "pi/lead",
			modelRegistry,
			availableModels: modelRegistry.getAvailable(),
			settings: activeSettings,
		});

		activeSettings.overrideModelRoles({
			default: formatModelSelectorValue(
				resolved.selector ?? `${resolved.model!.provider}/${resolved.model!.id}`,
				resolved.thinkingLevel,
			),
		});

		const sessionManager = SessionManager.inMemory();
		const initialModelStr = `${resolved.model!.provider}/${resolved.model!.id}`;
		// Omit role (simulates pre-fix behavior)
		sessionManager.appendModelChange(initialModelStr);

		const recoveryHost = {
			model: () => resolved.model,
			thinkingLevel: () => resolved.thinkingLevel,
			thinkingLevelCeiling: () => undefined,
			sessionManager,
			settings: activeSettings,
			modelRegistry,
			configWarnings: [],
			sessionId: () => sessionManager.getSessionId(),
			contextFitsModel: () => true,
			isRetryFallbackSelectorSuppressed: () => false,
		} as unknown as TurnRecoveryHost;

		const recovery = new TurnRecovery(recoveryHost);
		const currentSelector = "devin/claude-opus-5-5:low";
		const chainKeys = recovery.retryFallbackChainKeys(currentSelector, resolved.model);

		// Without fix: escapes to default
		expect(chainKeys).toEqual(["default"]);
	});

	it("resolves role's own fallback chain when modelRole is provided across pi/<role>, @<role>, and bare <role>", () => {
		for (const cliModelArg of ["pi/lead", "@lead", "lead"]) {
			const { modelRegistry, activeSettings } = setupEnvironment();

			const resolved = resolveCliModel({
				cliModel: cliModelArg,
				modelRegistry,
				availableModels: modelRegistry.getAvailable(),
				settings: activeSettings,
			});

			expect(resolved.configuredRole).toBe("lead");

			activeSettings.overrideModelRoles({
				default: formatModelSelectorValue(
					resolved.selector ?? `${resolved.model!.provider}/${resolved.model!.id}`,
					resolved.thinkingLevel,
				),
			});

			const sessionManager = SessionManager.inMemory();
			const initialModelStr = `${resolved.model!.provider}/${resolved.model!.id}`;

			// Pattern with fix:
			sessionManager.appendModelChange(initialModelStr);
			if (resolved.configuredRole) {
				sessionManager.appendModelChange(initialModelStr, resolved.configuredRole);
			}

			const recoveryHost = {
				model: () => resolved.model,
				thinkingLevel: () => resolved.thinkingLevel,
				thinkingLevelCeiling: () => undefined,
				sessionManager,
				settings: activeSettings,
				modelRegistry,
				configWarnings: [],
				sessionId: () => sessionManager.getSessionId(),
				contextFitsModel: () => true,
				isRetryFallbackSelectorSuppressed: () => false,
			} as unknown as TurnRecoveryHost;

			const recovery = new TurnRecovery(recoveryHost);
			const currentSelector = "devin/claude-opus-5-5:low";
			const chainKeys = recovery.retryFallbackChainKeys(currentSelector, resolved.model);
			const candidates = chainKeys.flatMap(key =>
				recovery.findRetryFallbackCandidates(key, currentSelector, resolved.model).map(c => c.raw),
			);

			expect(chainKeys).toEqual(["lead"]);
			expect(candidates).toEqual(["anthropic/claude-opus-5-5:low"]);
		}
	});

	it("verifies createAgentSession with modelRole resolves the role's own fallback chain end-to-end", async () => {
		const { modelRegistry, activeSettings, storage } = setupEnvironment();

		const resolved = resolveCliModel({
			cliModel: "pi/lead",
			modelRegistry,
			availableModels: modelRegistry.getAvailable(),
			settings: activeSettings,
		});

		activeSettings.overrideModelRoles({
			default: formatModelSelectorValue(
				resolved.selector ?? `${resolved.model!.provider}/${resolved.model!.id}`,
				resolved.thinkingLevel,
			),
		});

		const sessionManager = SessionManager.inMemory();
		const { session } = await createAgentSession({
			model: resolved.model,
			modelRole: resolved.configuredRole,
			thinkingLevel: resolved.thinkingLevel,
			settings: activeSettings,
			sessionManager,
			modelRegistry,
			authStorage: storage,
		});

		try {
			expect(session.sessionManager.getLastModelChangeRole({ skipEphemeral: true })).toBe("lead");

			const recovery = new TurnRecovery({
				model: () => session.model,
				thinkingLevel: () => session.thinkingLevel,
				thinkingLevelCeiling: () => undefined,
				sessionManager: session.sessionManager,
				settings: session.settings,
				modelRegistry: session.modelRegistry,
				configWarnings: [],
				sessionId: () => session.sessionId,
				contextFitsModel: () => true,
				isRetryFallbackSelectorSuppressed: () => false,
			} as unknown as TurnRecoveryHost);

			const currentSelector = "devin/claude-opus-5-5:low";
			const keys = recovery.retryFallbackChainKeys(currentSelector, session.model);
			expect(keys).toEqual(["lead"]);

			const candidates = keys.flatMap(key =>
				recovery.findRetryFallbackCandidates(key, currentSelector, session.model).map(c => c.raw),
			);
			expect(candidates).toEqual(["anthropic/claude-opus-5-5:low"]);
		} finally {
			await session.dispose();
		}
	});

	it("verifies concrete model without role alias does not adopt an unrelated role chain", () => {
		const { modelRegistry, activeSettings } = setupEnvironment();

		const cliModelArg = "devin/claude-opus-5-5";
		const resolved = resolveCliModel({
			cliModel: cliModelArg,
			modelRegistry,
			availableModels: modelRegistry.getAvailable(),
			settings: activeSettings,
		});

		expect(resolved.configuredRole).toBeUndefined();

		activeSettings.overrideModelRoles({
			default: formatModelSelectorValue(
				resolved.selector ?? `${resolved.model!.provider}/${resolved.model!.id}`,
				resolved.thinkingLevel,
			),
		});

		const sessionManager = SessionManager.inMemory();
		const initialModelStr = `${resolved.model!.provider}/${resolved.model!.id}`;

		sessionManager.appendModelChange(initialModelStr);
		if (resolved.configuredRole) {
			sessionManager.appendModelChange(initialModelStr, resolved.configuredRole);
		}

		const recoveryHost = {
			model: () => resolved.model,
			thinkingLevel: () => resolved.thinkingLevel,
			thinkingLevelCeiling: () => undefined,
			sessionManager,
			settings: activeSettings,
			modelRegistry,
			configWarnings: [],
			sessionId: () => sessionManager.getSessionId(),
			contextFitsModel: () => true,
			isRetryFallbackSelectorSuppressed: () => false,
		} as unknown as TurnRecoveryHost;

		const recovery = new TurnRecovery(recoveryHost);
		const currentSelector = "devin/claude-opus-5-5:low";
		const chainKeys = recovery.retryFallbackChainKeys(currentSelector, resolved.model);

		expect(chainKeys).toEqual(["default"]);
	});
});
