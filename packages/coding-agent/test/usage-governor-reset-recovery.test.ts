import { expect, test } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { TurnRecovery, type TurnRecoveryHost } from "@oh-my-pi/pi-coding-agent/session/turn-recovery";

test("governor prediction does not redeem a reset, but a credential-attributed provider error does", async () => {
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected bundled model");
	const settings = Settings.isolated({
		"usageGovernor.enabled": true,
		"retry.modelFallback": true,
		"retry.baseDelayMs": 1,
	});
	const predictions: string[] = [];
	const marked: unknown[] = [];
	const resetCalls: Array<number | undefined> = [];
	let scheduled = 0;
	const state = { messages: [] as AssistantMessage[] };
	const host = {
		settings,
		usesRegistryAuth: () => true,
		model: () => model,
		sessionId: () => "reset-test",
		agent: {
			state,
			replaceMessages: (messages: AssistantMessage[]) => {
				state.messages = messages;
			},
		},
		modelRegistry: {
			authStorage: {
				limits: {
					markReached: async (...args: unknown[]) => {
						marked.push(args);
						return { switched: false };
					},
				},
			},
		},
		usageRouting: {
			candidates: async (...args: unknown[]) => {
				predictions.push(args[4] as string);
				return [];
			},
		},
		sessionManager: { getBranchView: () => [], getBranch: () => [], getSessionId: () => "reset-test" },
		configWarnings: [],
		thinkingLevel: () => undefined,
		textOutputCommitted: () => false,
		abortInProgress: () => false,
		isDisposed: () => false,
		promptGeneration: () => 0,
		promptSequence: () => 0,
		persistedAssistantEntryId: () => undefined,
		waitForSessionMessagePersistence: async () => {},
		sessionMessageAlreadyPersisted: () => true,
		emitSessionEvent: async () => {},
		scheduleAgentContinue: () => {
			scheduled++;
		},
		maybeAutoRedeemReset: async (unblockAtMs?: number) => {
			resetCalls.push(unblockAtMs);
			return { restored: true };
		},
	} as unknown as TurnRecoveryHost;
	const recovery = new TurnRecovery(host, { deferFallbackChainValidation: true });
	const current = { model, apiKey: () => undefined, resolved: { apiKey: "test-key", credentialId: 123 } };
	const prepared = await recovery.prepareGovernedModelCall(model, async () => current, { kind: "role", role: "task" });
	expect(prepared).toBe(current);
	expect(predictions).toEqual(["proactive"]);
	expect(resetCalls).toEqual([]);

	const message = {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		stopReason: "error",
		errorMessage: "429 Weekly usage limit reached. type=GoUsageLimitError retry-after-ms=3242000",
		credentialId: 123,
		timestamp: Date.now(),
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
	} as AssistantMessage;
	expect(await recovery.recordUsageLimitOutcome({ ...message, credentialId: undefined })).toBe(false);
	expect(marked).toHaveLength(0);
	expect(resetCalls).toHaveLength(0);
	expect(await recovery.recordUsageLimitOutcome(message)).toBe(false);
	expect(marked).toHaveLength(1);
	expect((marked[0] as unknown[])[2]).toMatchObject({ credentialId: 123, modelId: model.id });
	expect(await recovery.handleRetryableError(message, { allowModelFallback: false })).toBe(true);
	expect(resetCalls).toHaveLength(1);
	expect(resetCalls[0]).toBeGreaterThan(Date.now());
	expect(scheduled).toBe(1);
});
