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
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import { buildSessionOptions } from "@oh-my-pi/pi-coding-agent/main";

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

	it("drives buildSessionOptions into createAgentSession across pi/<role>, @<role>, and bare <role>", async () => {
		for (const cliModelArg of ["pi/lead", "@lead", "lead"]) {
			const { modelRegistry, activeSettings, storage } = setupEnvironment();
			const sessionManager = SessionManager.inMemory();

			const parsed = parseArgs(["--model", cliModelArg]);
			const options = await buildSessionOptions(parsed, [], sessionManager, modelRegistry, activeSettings);

			expect(options.modelRole).toBe("lead");
			expect(options.model?.provider).toBe("devin");
			expect(options.model?.id).toBe("claude-opus-5-5");

			const { session } = await createAgentSession({
				...options,
				modelRegistry,
				settings: activeSettings,
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
				const chainKeys = recovery.retryFallbackChainKeys(currentSelector, session.model);
				expect(chainKeys).toEqual(["lead"]);

				const candidates = chainKeys.flatMap(key =>
					recovery.findRetryFallbackCandidates(key, currentSelector, session.model).map(c => c.raw),
				);
				expect(candidates).toEqual(["anthropic/claude-opus-5-5:low"]);
			} finally {
				await session.dispose();
			}
		}
	});

	it("preserves explicit role ownership when resuming an existing session with --continue --model pi/lead", async () => {
		const { modelRegistry, activeSettings, storage } = setupEnvironment();
		const sessionManager = SessionManager.inMemory();

		// Resumed session starts with pre-existing default entries
		sessionManager.appendModelChange("google-antigravity/gemini-4-argon");
		expect(sessionManager.getLastModelChangeRole({ skipEphemeral: true })).toBe("default");

		const parsed = parseArgs(["--continue", "--model", "pi/lead"]);
		const options = await buildSessionOptions(parsed, [], sessionManager, modelRegistry, activeSettings);

		expect(options.modelRole).toBe("lead");

		const { session } = await createAgentSession({
			...options,
			modelRegistry,
			settings: activeSettings,
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
			const chainKeys = recovery.retryFallbackChainKeys(currentSelector, session.model);
			expect(chainKeys).toEqual(["lead"]);

			const candidates = chainKeys.flatMap(key =>
				recovery.findRetryFallbackCandidates(key, currentSelector, session.model).map(c => c.raw),
			);
			expect(candidates).toEqual(["anthropic/claude-opus-5-5:low"]);
		} finally {
			await session.dispose();
		}
	});

	it("preserves existing saved model and role when continuing without --model", async () => {
		const { modelRegistry, activeSettings, storage } = setupEnvironment();
		const sessionManager = SessionManager.inMemory();

		// Resumed session starts with pre-existing role entries
		sessionManager.appendModelChange("devin/claude-opus-5-5");
		sessionManager.appendModelChange("devin/claude-opus-5-5", "lead");
		expect(sessionManager.getLastModelChangeRole({ skipEphemeral: true })).toBe("lead");

		// Continue without --model
		const continueParsed = parseArgs(["--continue"]);
		const continueOptions = await buildSessionOptions(
			continueParsed,
			[],
			sessionManager,
			modelRegistry,
			activeSettings,
		);
		const resumed = await createAgentSession({
			...continueOptions,
			modelRegistry,
			settings: activeSettings,
			authStorage: storage,
		});

		try {
			expect(resumed.session.model?.provider).toBe("devin");
			expect(resumed.session.model?.id).toBe("claude-opus-5-5");
			expect(resumed.session.sessionManager.getLastModelChangeRole({ skipEphemeral: true })).toBe("lead");

			const recovery = new TurnRecovery({
				model: () => resumed.session.model,
				thinkingLevel: () => resumed.session.thinkingLevel,
				thinkingLevelCeiling: () => undefined,
				sessionManager: resumed.session.sessionManager,
				settings: resumed.session.settings,
				modelRegistry: resumed.session.modelRegistry,
				configWarnings: [],
				sessionId: () => resumed.session.sessionId,
				contextFitsModel: () => true,
				isRetryFallbackSelectorSuppressed: () => false,
			} as unknown as TurnRecoveryHost);

			const currentSelector = "devin/claude-opus-5-5:low";
			const chainKeys = recovery.retryFallbackChainKeys(currentSelector, resumed.session.model);
			expect(chainKeys).toEqual(["lead"]);
		} finally {
			await resumed.session.dispose();
		}
	});

	it("verifies concrete model without role alias resolves to default fallback chain", async () => {
		const { modelRegistry, activeSettings, storage } = setupEnvironment();
		const sessionManager = SessionManager.inMemory();

		const parsed = parseArgs(["--model", "devin/claude-opus-5-5"]);
		const options = await buildSessionOptions(parsed, [], sessionManager, modelRegistry, activeSettings);

		expect(options.modelRole).toBeUndefined();

		const { session } = await createAgentSession({
			...options,
			modelRegistry,
			settings: activeSettings,
			authStorage: storage,
		});

		try {
			expect(session.sessionManager.getLastModelChangeRole({ skipEphemeral: true })).toBe("default");

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
			const chainKeys = recovery.retryFallbackChainKeys(currentSelector, session.model);
			expect(chainKeys).toEqual(["default"]);
		} finally {
			await session.dispose();
		}
	});
});
