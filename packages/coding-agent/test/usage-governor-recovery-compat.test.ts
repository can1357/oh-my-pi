import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { Effort, type AssistantMessage } from "@oh-my-pi/pi-ai";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { TurnRecovery, type TurnRecoveryHost } from "@oh-my-pi/pi-coding-agent/session/turn-recovery";
import { SessionUsageRouting } from "@oh-my-pi/pi-coding-agent/session/usage-routing";
import {
	CODEX,
	PROVIDER,
	createHarness,
	credentialIdOf,
	disposeHarness,
	ENABLED,
	DISABLED,
	expectNoStrayFetch,
	seedAccounts,
	seedReports,
	windowAt,
} from "../../ai/test/fixtures/usage-governor/harness";

afterEach(async () => {
	await disposeHarness();
});

async function setupCompatHarness(options: {
	governorEnabled: boolean;
	siblingAllowance?: "included" | "unknown" | "spent";
	allowFallbackAllowance?: boolean;
}) {
	const h = await createHarness(options.governorEnabled ? ENABLED : DISABLED);
	const original = h.usage.provider.bind(h.usage);
	h.usage.provider = id => {
		const provider = original(id);
		return {
			...provider,
			governorAllowance: () => (id === PROVIDER ? ["primary"] : options.allowFallbackAllowance ? ["primary"] : []),
			fetchUsage: async (params, ctx) => {
				const report = await provider.fetchUsage(params, ctx);
				if (report) for (const limit of report.limits) limit.observedAt = Date.now();
				return report;
			},
		};
	};
	await seedAccounts(h, PROVIDER, [
		{ accountId: "source", email: "source@example.test", window: windowAt(30000, 60000, 0.1) },
	]);
	await seedAccounts(h, CODEX, [
		{ accountId: "failed", email: "failed@example.test", window: windowAt(30000, 60000, 0.1) },
		{ accountId: "pinned", email: "pinned@example.test", window: windowAt(30000, 60000, 0.1) },
	]);
	await seedReports(h, PROVIDER);
	await seedReports(h, CODEX);

	const settings = Settings.isolated({
		"usageGovernor.enabled": options.governorEnabled,
		"retry.modelFallback": true,
		"retry.fallbackChains": {
			task: [`${CODEX}/fallback`],
		},
	});
	settings.setModelRole("task", `${PROVIDER}/primary`);

	const registry = new ModelRegistry(h.storage, `${h.dir}/models.yml`, { settings });
	const oauth = {
		name: "synthetic",
		login: async () => {
			throw new Error("unexpected login");
		},
	};
	const definition = (id: string) => ({
		id,
		name: id,
		reasoning: true,
		thinking: { mode: "effort" as const, efforts: [Effort.Low, Effort.High] },
		input: ["text" as const],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 100000,
		maxTokens: 8192,
	});
	registry.registerProvider(PROVIDER, {
		api: "openai-completions",
		baseUrl: "https://source.example.test",
		oauth,
		models: [definition("primary")],
	});
	registry.registerProvider(CODEX, {
		api: "openai-completions",
		baseUrl: "https://fallback.example.test",
		oauth,
		models: [definition("fallback")],
	});

	const routing = new SessionUsageRouting(settings, registry);
	const source = registry.find(PROVIDER, "primary")!;
	const fallback = registry.find(CODEX, "fallback")!;
	const sourceId = credentialIdOf(h, PROVIDER, "source");
	const failedId = credentialIdOf(h, CODEX, "failed");
	const pinnedId = credentialIdOf(h, CODEX, "pinned");

	return {
		h,
		settings,
		registry,
		routing,
		source,
		fallback,
		sourceId,
		failedId,
		pinnedId,
	};
}

describe("recovery differential tests (governor ON vs OFF)", () => {
	for (const governorEnabled of [false, true]) {
		const label = governorEnabled ? "governor ON" : "governor OFF";

		test(`${label}: provider 500 error falls back to ordinary chain with identical selector and pin`, async () => {
			const x = await setupCompatHarness({ governorEnabled, allowFallbackAllowance: false });
			try {
				const owner = { kind: "role", role: "task" } as const;
				let active = x.source;
				let modelSwitchCount = 0;
				let retryScheduled = false;

				const state = { messages: [] as AssistantMessage[], systemPrompt: [] as string[], tools: [] };
				const host = {
					settings: x.settings,
					usesRegistryAuth: () => true,
					modelRegistry: x.registry,
					usageRouting: x.routing,
					agent: {
						state,
						replaceMessages: (messages: AssistantMessage[]) => {
							state.messages = messages;
						},
					},
					model: () => active,
					sessionId: () => "s",
					routingRole: () => "task",
					thinkingLevel: () => undefined,
					configuredThinkingLevel: () => undefined,
					thinkingLevelCeiling: () => undefined,
					contextFitsModel: () => true,
					resolveActiveEditMode: () => "hashline",
					setModelWithProviderSessionReset: async (model: typeof active) => {
						modelSwitchCount++;
						active = model;
					},
					sessionManager: {
						appendModelChange: () => {},
						getSessionId: () => "s",
						getBranchView: () => [],
						getBranch: () => [],
					},
					setThinkingLevel: () => {},
					syncAfterModelChange: async () => {},
					emitSessionEvent: async () => {},
					maybeAutoRedeemReset: async () => ({ restored: false }),
					configWarnings: [],
					abortInProgress: () => false,
					isDisposed: () => false,
					streamingEditAbortTriggered: () => false,
					promptGeneration: () => 0,
					promptSequence: () => 0,
					textOutputCommitted: () => false,
					persistedAssistantEntryId: () => undefined,
					sessionMessageAlreadyPersisted: () => true,
					waitForSessionMessagePersistence: async () => {},
					appendSessionMessage: () => {},
					scheduleAgentContinue: () => {
						retryScheduled = true;
					},
				} as unknown as TurnRecoveryHost;

				const recovery = new TurnRecovery(host, { deferFallbackChainValidation: true });
				const message = {
					role: "assistant",
					content: [],
					api: "openai-completions",
					provider: PROVIDER,
					model: "primary",
					stopReason: "error",
					timestamp: Date.now(),
					errorMessage: "500 Internal Server Error from upstream",
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
				} as AssistantMessage;

				const retried = await recovery.handleRetryableError(message);
				expect(retried).toBe(true);
				expect(retryScheduled).toBe(true);
				expect(active.id).toBe("fallback");
				expect(active.provider).toBe(CODEX);
				// Single model switch, no oscillation
				expect(modelSwitchCount).toBe(1);

				// Prepare call on the retried model
				const current = async () => ({
					model: active,
					apiKey: () => undefined,
					resolved: { apiKey: "ordinary-fallback-key", credentialId: x.pinnedId },
				});
				const prepared = await recovery.prepareGovernedModelCall(active, current, owner);
				if (governorEnabled) {
					expect(prepared).toBeDefined();
					expect(prepared?.model.id).toBe("fallback");
					const binding =
						typeof prepared?.resolved === "object" ? prepared.resolved?.usageRouteBinding : undefined;
					expect(binding).toBeUndefined();
				} else {
					expect(prepared).toBeUndefined();
				}

				expectNoStrayFetch(x.h);
				expect(x.h.redemptionPosts()).toHaveLength(0);
			} finally {
				x.routing.dispose();
			}
		});

		test(`${label}: missing credential triggers keyed retry fallback walk identically`, async () => {
			const x = await setupCompatHarness({ governorEnabled, allowFallbackAllowance: false });
			try {
				let active = x.source;
				let modelSwitchCount = 0;

				const host = {
					settings: x.settings,
					usesRegistryAuth: () => true,
					modelRegistry: x.registry,
					usageRouting: x.routing,
					agent: { state: { messages: [], systemPrompt: [], tools: [] } },
					model: () => active,
					sessionId: () => "s",
					routingRole: () => "task",
					thinkingLevel: () => undefined,
					configuredThinkingLevel: () => undefined,
					thinkingLevelCeiling: () => undefined,
					contextFitsModel: () => true,
					resolveActiveEditMode: () => "hashline",
					setModelWithProviderSessionReset: async (model: typeof active) => {
						modelSwitchCount++;
						active = model;
					},
					sessionManager: {
						appendModelChange: () => {},
						getSessionId: () => "s",
						getBranchView: () => [],
						getBranch: () => [],
					},
					setThinkingLevel: () => {},
					syncAfterModelChange: async () => {},
					emitSessionEvent: async () => {},
					configWarnings: [],
				} as unknown as TurnRecoveryHost;

				const recovery = new TurnRecovery(host, { deferFallbackChainValidation: true });
				const controller = new AbortController();
				const applied = await recovery.applyMissingCredentialFallback(controller.signal);

				expect(applied).toBe(true);
				expect(active.id).toBe("fallback");
				expect(active.provider).toBe(CODEX);
				expect(modelSwitchCount).toBe(1);

				expectNoStrayFetch(x.h);
				expect(x.h.redemptionPosts()).toHaveLength(0);
			} finally {
				x.routing.dispose();
			}
		});

		for (const siblingState of ["unknown", "spent"] as const) {
			test(`${label}: usage limit on governed route with ${siblingState} sibling rotates identically`, async () => {
				const x = await setupCompatHarness({ governorEnabled, allowFallbackAllowance: true });
				try {
					const owner = { kind: "role", role: "task" } as const;
					let active = x.fallback;
					let retryScheduled = false;

					const routing = {
						refresh: x.routing.refresh.bind(x.routing),
						candidates: x.routing.candidates.bind(x.routing),
						evaluate: async (requestedOwner: typeof owner, sessionId: string, signal?: AbortSignal) => {
							const result = await x.routing.evaluate(requestedOwner, sessionId, signal);
							if (!result) return result;
							return {
								...result,
								accounts: result.accounts.map(account =>
									account.credentialId === x.pinnedId ? { ...account, allowance: siblingState } : account,
								),
							};
						},
					};

					const state = { messages: [] as AssistantMessage[], systemPrompt: [] as string[], tools: [] };
					const host = {
						settings: x.settings,
						usesRegistryAuth: () => true,
						modelRegistry: x.registry,
						usageRouting: routing,
						agent: {
							state,
							replaceMessages: (messages: AssistantMessage[]) => {
								state.messages = messages;
							},
						},
						model: () => active,
						sessionId: () => "s",
						routingRole: () => "task",
						thinkingLevel: () => undefined,
						configuredThinkingLevel: () => undefined,
						thinkingLevelCeiling: () => undefined,
						contextFitsModel: () => true,
						resolveActiveEditMode: () => "hashline",
						setModelWithProviderSessionReset: async (model: typeof active) => {
							active = model;
						},
						sessionManager: {
							appendModelChange: () => {},
							getSessionId: () => "s",
							getBranchView: () => [],
							getBranch: () => [],
						},
						setThinkingLevel: () => {},
						syncAfterModelChange: async () => {},
						emitSessionEvent: async () => {},
						maybeAutoRedeemReset: async () => ({ restored: false }),
						configWarnings: [],
						abortInProgress: () => false,
						isDisposed: () => false,
						streamingEditAbortTriggered: () => false,
						promptGeneration: () => 0,
						promptSequence: () => 0,
						textOutputCommitted: () => false,
						persistedAssistantEntryId: () => undefined,
						sessionMessageAlreadyPersisted: () => true,
						waitForSessionMessagePersistence: async () => {},
						appendSessionMessage: () => {},
						scheduleAgentContinue: () => {
							retryScheduled = true;
						},
					} as unknown as TurnRecoveryHost;

					const recovery = new TurnRecovery(host, { deferFallbackChainValidation: true });

					// Prepare initial call to establish bound route when governor is ON
					const current = async () => ({
						model: x.fallback,
						apiKey: () => undefined,
						resolved: { apiKey: "fallback-key", credentialId: x.failedId },
					});
					await recovery.prepareGovernedModelCall(x.fallback, current, owner);

					const message = {
						role: "assistant",
						content: [],
						api: "openai-completions",
						provider: CODEX,
						model: "fallback",
						stopReason: "error",
						credentialId: x.failedId,
						timestamp: Date.now(),
						errorMessage: "429 Weekly usage limit reached. type=GoUsageLimitError retry-after-ms=3242000",
						usage: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 0,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
					} as AssistantMessage;

					const outcomeSwitched = await recovery.recordUsageLimitOutcome(message);
					expect(outcomeSwitched).toBe(true);

					const retried = await recovery.handleRetryableError(message);
					expect(retried).toBe(true);
					expect(retryScheduled).toBe(true);

					// Next preparation call falls through without throwing and shows no binding
					const prepared = await recovery.prepareGovernedModelCall(active, current, owner);
					if (governorEnabled) {
						expect(prepared).toBeDefined();
						const binding =
							typeof prepared?.resolved === "object" ? prepared.resolved?.usageRouteBinding : undefined;
						expect(binding).toBeUndefined();
					} else {
						expect(prepared).toBeUndefined();
					}
					expectNoStrayFetch(x.h);
					expect(x.h.redemptionPosts()).toHaveLength(0);
				} finally {
					x.routing.dispose();
				}
			});

			test(`${label}: account policy denial on governed route with ${siblingState} sibling rotates identically`, async () => {
				const x = await setupCompatHarness({ governorEnabled, allowFallbackAllowance: true });
				try {
					const owner = { kind: "role", role: "task" } as const;
					let active = x.fallback;
					let retryScheduled = false;

					const routing = {
						refresh: x.routing.refresh.bind(x.routing),
						candidates: x.routing.candidates.bind(x.routing),
						evaluate: async (requestedOwner: typeof owner, sessionId: string, signal?: AbortSignal) => {
							const result = await x.routing.evaluate(requestedOwner, sessionId, signal);
							if (!result) return result;
							return {
								...result,
								accounts: result.accounts.map(account =>
									account.credentialId === x.pinnedId ? { ...account, allowance: siblingState } : account,
								),
							};
						},
					};

					const state = { messages: [] as AssistantMessage[], systemPrompt: [] as string[], tools: [] };
					const host = {
						settings: x.settings,
						usesRegistryAuth: () => true,
						modelRegistry: x.registry,
						usageRouting: routing,
						agent: {
							state,
							replaceMessages: (messages: AssistantMessage[]) => {
								state.messages = messages;
							},
						},
						model: () => active,
						sessionId: () => "s",
						routingRole: () => "task",
						thinkingLevel: () => undefined,
						configuredThinkingLevel: () => undefined,
						thinkingLevelCeiling: () => undefined,
						contextFitsModel: () => true,
						resolveActiveEditMode: () => "hashline",
						setModelWithProviderSessionReset: async (model: typeof active) => {
							active = model;
						},
						sessionManager: {
							appendModelChange: () => {},
							getSessionId: () => "s",
							getBranchView: () => [],
							getBranch: () => [],
						},
						setThinkingLevel: () => {},
						syncAfterModelChange: async () => {},
						emitSessionEvent: async () => {},
						maybeAutoRedeemReset: async () => ({ restored: false }),
						configWarnings: [],
						abortInProgress: () => false,
						isDisposed: () => false,
						streamingEditAbortTriggered: () => false,
						promptGeneration: () => 0,
						promptSequence: () => 0,
						textOutputCommitted: () => false,
						persistedAssistantEntryId: () => undefined,
						sessionMessageAlreadyPersisted: () => true,
						waitForSessionMessagePersistence: async () => {},
						appendSessionMessage: () => {},
						scheduleAgentContinue: () => {
							retryScheduled = true;
						},
					} as unknown as TurnRecoveryHost;

					const recovery = new TurnRecovery(host, { deferFallbackChainValidation: true });

					const current = async () => ({
						model: x.fallback,
						apiKey: () => undefined,
						resolved: { apiKey: "fallback-key", credentialId: x.failedId },
					});
					await recovery.prepareGovernedModelCall(x.fallback, current, owner);

					const message = {
						role: "assistant",
						content: [],
						api: "openai-completions",
						provider: CODEX,
						model: "fallback",
						stopReason: "error",
						credentialId: x.failedId,
						timestamp: Date.now(),
						errorMessage:
							"Codex error event: This content was flagged for possible cybersecurity risk. Join Trusted Access for Cyber. (code=cyber_policy)",
						usage: {
							input: 0,
							output: 0,
							cacheRead: 0,
							cacheWrite: 0,
							totalTokens: 0,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
						},
					} as AssistantMessage;

					const retried = await recovery.handleRetryableError(message);
					expect(retried).toBe(true);
					expect(retryScheduled).toBe(true);

					const prepared = await recovery.prepareGovernedModelCall(active, current, owner);
					if (governorEnabled) {
						expect(prepared).toBeDefined();
						const binding =
							typeof prepared?.resolved === "object" ? prepared.resolved?.usageRouteBinding : undefined;
						expect(binding).toBeUndefined();
					} else {
						expect(prepared).toBeUndefined();
					}
					expectNoStrayFetch(x.h);
					expect(x.h.redemptionPosts()).toHaveLength(0);
				} finally {
					x.routing.dispose();
				}
			});
		}
	}
});

describe("custom-auth sessions contract (CR3d zero-call spies)", () => {
	test("custom-auth session makes zero routing, resolve, validateRoute, or markReached calls", async () => {
		const x = await setupCompatHarness({ governorEnabled: true, allowFallbackAllowance: true });
		try {
			const owner = { kind: "role", role: "task" } as const;
			let active = x.source;
			let retryScheduled = false;

			const candidatesSpy = spyOn(x.routing, "candidates");
			const evaluateSpy = spyOn(x.routing, "evaluate");
			const getApiKeyWithCredentialSpy = spyOn(x.registry, "getApiKeyWithCredentialForProvider");
			const validateRouteSpy = spyOn(x.registry.authStorage.governor, "validateRoute");
			const markReachedSpy = spyOn(x.registry.authStorage.limits, "markReached");

			const state = { messages: [] as AssistantMessage[], systemPrompt: [] as string[], tools: [] };
			const host = {
				settings: x.settings,
				usesRegistryAuth: () => false, // Custom auth session!
				modelRegistry: x.registry,
				usageRouting: x.routing,
				agent: {
					state,
					replaceMessages: (messages: AssistantMessage[]) => {
						state.messages = messages;
					},
				},
				model: () => active,
				sessionId: () => "s",
				routingRole: () => "task",
				thinkingLevel: () => undefined,
				configuredThinkingLevel: () => undefined,
				thinkingLevelCeiling: () => undefined,
				contextFitsModel: () => true,
				resolveActiveEditMode: () => "hashline",
				setModelWithProviderSessionReset: async (model: typeof active) => {
					active = model;
				},
				sessionManager: {
					appendModelChange: () => {},
					getSessionId: () => "s",
					getBranchView: () => [],
					getBranch: () => [],
				},
				setThinkingLevel: () => {},
				syncAfterModelChange: async () => {},
				emitSessionEvent: async () => {},
				maybeAutoRedeemReset: async () => ({ restored: false }),
				configWarnings: [],
				abortInProgress: () => false,
				isDisposed: () => false,
				streamingEditAbortTriggered: () => false,
				promptGeneration: () => 0,
				promptSequence: () => 0,
				textOutputCommitted: () => false,
				persistedAssistantEntryId: () => undefined,
				sessionMessageAlreadyPersisted: () => true,
				waitForSessionMessagePersistence: async () => {},
				appendSessionMessage: () => {},
				scheduleAgentContinue: () => {
					retryScheduled = true;
				},
			} as unknown as TurnRecoveryHost;

			const recovery = new TurnRecovery(host, { deferFallbackChainValidation: true });

			// 1. prepareGovernedModelCall returns undefined with zero calls
			const current = async () => ({
				model: x.source,
				apiKey: () => undefined,
				resolved: { apiKey: "custom-key" },
			});
			const prepared = await recovery.prepareGovernedModelCall(x.source, current, owner);
			expect(prepared).toBeUndefined();
			expect(candidatesSpy).toHaveBeenCalledTimes(0);
			expect(evaluateSpy).toHaveBeenCalledTimes(0);
			expect(getApiKeyWithCredentialSpy).toHaveBeenCalledTimes(0);
			expect(validateRouteSpy).toHaveBeenCalledTimes(0);

			// 2. recordUsageLimitOutcome on custom auth returns false with zero markReached calls
			const usageMessage = {
				role: "assistant",
				content: [],
				api: "openai-completions",
				provider: PROVIDER,
				model: "primary",
				stopReason: "error",
				timestamp: Date.now(),
				errorMessage: "429 Weekly usage limit reached. type=GoUsageLimitError retry-after-ms=3242000",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			} as AssistantMessage;
			const outcome = await recovery.recordUsageLimitOutcome(usageMessage);
			expect(outcome).toBe(false);
			expect(markReachedSpy).toHaveBeenCalledTimes(0);

			// 3. Provider 500 error falls through to ordinary model fallback walk
			const errorMessage = {
				role: "assistant",
				content: [],
				api: "openai-completions",
				provider: PROVIDER,
				model: "primary",
				stopReason: "error",
				timestamp: Date.now(),
				errorMessage: "500 Internal Server Error",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			} as AssistantMessage;

			const retried = await recovery.handleRetryableError(errorMessage);
			expect(retried).toBe(true);
			expect(retryScheduled).toBe(true);
			expect(active.id).toBe("fallback");

			// Ensure zero governed routing or validate calls occurred during the fallback
			expect(candidatesSpy).toHaveBeenCalledTimes(0);
			expect(evaluateSpy).toHaveBeenCalledTimes(0);
			expect(getApiKeyWithCredentialSpy).toHaveBeenCalledTimes(0);
			expect(validateRouteSpy).toHaveBeenCalledTimes(0);
			expect(markReachedSpy).toHaveBeenCalledTimes(0);

			expectNoStrayFetch(x.h);
			expect(x.h.redemptionPosts()).toHaveLength(0);
		} finally {
			x.routing.dispose();
		}
	});
});

describe("pending route recovery without throwing (CR5 & A8)", () => {
	test("revision change on a pending route re-evaluates under CR5 and rebinds without throwing", async () => {
		const x = await setupCompatHarness({ governorEnabled: true, allowFallbackAllowance: true });
		try {
			const owner = { kind: "role", role: "task" } as const;
			let active = x.source;
			const routing = {
				candidates: () => x.routing.candidates(owner, "s", x.source, x.sourceId, "error"),
				refresh: x.routing.refresh.bind(x.routing),
				evaluate: x.routing.evaluate.bind(x.routing),
			};
			const host = {
				settings: x.settings,
				usesRegistryAuth: () => true,
				modelRegistry: x.registry,
				usageRouting: routing,
				agent: { state: { messages: [] } },
				model: () => active,
				sessionId: () => "s",
				thinkingLevel: () => undefined,
				configuredThinkingLevel: () => undefined,
				thinkingLevelCeiling: () => undefined,
				contextFitsModel: () => true,
				resolveActiveEditMode: () => "hashline",
				setModelWithProviderSessionReset: async (model: typeof active) => {
					active = model;
				},
				sessionManager: { appendModelChange: () => {}, getSessionId: () => "s" },
				setThinkingLevel: () => {},
				syncAfterModelChange: async () => {},
				emitSessionEvent: async () => {},
				configWarnings: [],
			} as unknown as TurnRecoveryHost;

			const recovery = new TurnRecovery(host, { deferFallbackChainValidation: true });
			const current = async () => ({
				model: x.source,
				apiKey: () => undefined,
				resolved: { apiKey: "source", credentialId: x.sourceId },
			});

			const first = await recovery.prepareGovernedModelCall(x.source, current, owner);
			expect(first?.model.id).toBe("fallback");

			const oldRevision = x.routing.refresh()!.revision;
			// Bump revision
			x.routing.refresh(true);

			// Next call rebinds without throwing
			const fresh = await recovery.prepareGovernedModelCall(active, current, owner);
			expect(fresh).toBeDefined();
			const binding = typeof fresh?.resolved === "object" ? fresh.resolved?.usageRouteBinding : undefined;
			expect(binding?.revision).toBeGreaterThan(oldRevision);

			expectNoStrayFetch(x.h);
			expect(x.h.redemptionPosts()).toHaveLength(0);
		} finally {
			x.routing.dispose();
		}
	});

	test("failed revalidation on a pending route clears and falls through without throwing", async () => {
		const x = await setupCompatHarness({ governorEnabled: true, allowFallbackAllowance: true });
		try {
			const owner = { kind: "role", role: "task" } as const;
			let active = x.source;
			let valid = true;

			const origValidate = x.registry.authStorage.governor.validateRoute?.bind(x.registry.authStorage.governor);
			x.registry.authStorage.governor.validateRoute = (binding, ctx) => {
				if (!valid) return false;
				return origValidate ? origValidate(binding, ctx) : true;
			};

			const routing = {
				candidates: () => x.routing.candidates(owner, "s", x.source, x.sourceId, "error"),
				refresh: x.routing.refresh.bind(x.routing),
				evaluate: x.routing.evaluate.bind(x.routing),
			};

			const host = {
				settings: x.settings,
				usesRegistryAuth: () => true,
				modelRegistry: x.registry,
				usageRouting: routing,
				agent: { state: { messages: [] } },
				model: () => active,
				sessionId: () => "s",
				thinkingLevel: () => undefined,
				configuredThinkingLevel: () => undefined,
				thinkingLevelCeiling: () => undefined,
				contextFitsModel: () => true,
				resolveActiveEditMode: () => "hashline",
				setModelWithProviderSessionReset: async (model: typeof active) => {
					active = model;
				},
				sessionManager: { appendModelChange: () => {}, getSessionId: () => "s" },
				setThinkingLevel: () => {},
				syncAfterModelChange: async () => {},
				emitSessionEvent: async () => {},
				configWarnings: [],
			} as unknown as TurnRecoveryHost;

			const recovery = new TurnRecovery(host, { deferFallbackChainValidation: true });
			const current = async () => ({
				model: x.source,
				apiKey: () => undefined,
				resolved: { apiKey: "source", credentialId: x.sourceId },
			});

			const first = await recovery.prepareGovernedModelCall(x.source, current, owner);
			expect(first?.model.id).toBe("fallback");

			// Invalidate governor validation
			valid = false;

			// Next call should NOT throw; falls through to current
			const fallbackCurrent = async () => ({
				model: active,
				apiKey: () => undefined,
				resolved: { apiKey: "fallback-key", credentialId: x.pinnedId },
			});
			const second = await recovery.prepareGovernedModelCall(active, fallbackCurrent, owner);
			expect(second).toBeDefined();
			expect(second?.model.id).toBe("fallback");
			const binding = typeof second?.resolved === "object" ? second.resolved?.usageRouteBinding : undefined;
			expect(binding).toBeUndefined();

			expectNoStrayFetch(x.h);
			expect(x.h.redemptionPosts()).toHaveLength(0);
		} finally {
			x.routing.dispose();
		}
	});
});

describe("discriminating failure and race behavior", () => {
	test("model change during candidates await stops retry and does not overwrite selection", async () => {
		const x = await setupCompatHarness({ governorEnabled: true, allowFallbackAllowance: true });
		try {
			let active = x.source;
			let setModelCount = 0;

			const alternate = {
				provider: PROVIDER,
				id: "user-selected-model",
				api: "openai-completions",
				baseUrl: "https://source.example.test",
			} as unknown as typeof x.source;

			const routing = {
				candidates: async () => {
					// Simulate concurrent user action while candidates is resolving
					active = alternate;
					return x.routing.candidates({ kind: "role", role: "task" }, "s", x.source, undefined, "error");
				},
				refresh: x.routing.refresh.bind(x.routing),
				evaluate: x.routing.evaluate.bind(x.routing),
			};

			const host = {
				settings: x.settings,
				usesRegistryAuth: () => true,
				modelRegistry: x.registry,
				usageRouting: routing,
				agent: { state: { messages: [] } },
				model: () => active,
				sessionId: () => "s",
				thinkingLevel: () => undefined,
				configuredThinkingLevel: () => undefined,
				thinkingLevelCeiling: () => undefined,
				contextFitsModel: () => true,
				resolveActiveEditMode: () => "hashline",
				setModelWithProviderSessionReset: async (model: typeof active) => {
					setModelCount++;
					active = model;
				},
				sessionManager: {
					appendModelChange: () => {},
					getSessionId: () => "s",
					getBranchView: () => [],
					getBranch: () => [],
				},
				setThinkingLevel: () => {},
				syncAfterModelChange: async () => {},
				emitSessionEvent: async () => {},
				maybeAutoRedeemReset: async () => ({ restored: false }),
				configWarnings: [],
				abortInProgress: () => false,
				isDisposed: () => false,
				streamingEditAbortTriggered: () => false,
				promptGeneration: () => 0,
				promptSequence: () => 0,
				textOutputCommitted: () => false,
				persistedAssistantEntryId: () => undefined,
				sessionMessageAlreadyPersisted: () => true,
				waitForSessionMessagePersistence: async () => {},
				appendSessionMessage: () => {},
				scheduleAgentContinue: () => {},
			} as unknown as TurnRecoveryHost;

			const recovery = new TurnRecovery(host, { deferFallbackChainValidation: true });
			const errorMessage = {
				role: "assistant",
				content: [],
				api: "openai-completions",
				provider: PROVIDER,
				model: "primary",
				stopReason: "error",
				timestamp: Date.now(),
				errorMessage:
					"Codex error event: This content was flagged for possible cybersecurity risk. (code=cyber_policy)",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
			} as AssistantMessage;

			const retried = await recovery.handleRetryableError(errorMessage);
			expect(retried).toBe(false);
			// The user's selection was preserved and not overwritten
			expect(active).toBe(alternate);
			expect(setModelCount).toBe(0);

			expectNoStrayFetch(x.h);
			expect(x.h.redemptionPosts()).toHaveLength(0);
		} finally {
			x.routing.dispose();
		}
	});

	test("pending route resolveGovernedRoute throwing MissingApiKeyError clears route without throwing", async () => {
		const x = await setupCompatHarness({ governorEnabled: true, allowFallbackAllowance: true });
		try {
			const owner = { kind: "role", role: "task" } as const;
			let active = x.source;
			let throwResolutionError = false;

			const origGetApiKey = x.registry.getApiKeyWithCredentialForProvider.bind(x.registry);
			x.registry.getApiKeyWithCredentialForProvider = async (provider, sessionId, options) => {
				if (throwResolutionError) {
					throw new AIError.MissingApiKeyError("synthetic missing key");
				}
				return origGetApiKey(provider, sessionId, options);
			};

			const routing = {
				candidates: () => x.routing.candidates(owner, "s", x.source, x.sourceId, "error"),
				refresh: x.routing.refresh.bind(x.routing),
				evaluate: x.routing.evaluate.bind(x.routing),
			};

			const host = {
				settings: x.settings,
				usesRegistryAuth: () => true,
				modelRegistry: x.registry,
				usageRouting: routing,
				agent: { state: { messages: [] } },
				model: () => active,
				sessionId: () => "s",
				thinkingLevel: () => undefined,
				configuredThinkingLevel: () => undefined,
				thinkingLevelCeiling: () => undefined,
				contextFitsModel: () => true,
				resolveActiveEditMode: () => "hashline",
				setModelWithProviderSessionReset: async (model: typeof active) => {
					active = model;
				},
				sessionManager: { appendModelChange: () => {}, getSessionId: () => "s" },
				setThinkingLevel: () => {},
				syncAfterModelChange: async () => {},
				emitSessionEvent: async () => {},
				configWarnings: [],
			} as unknown as TurnRecoveryHost;

			const recovery = new TurnRecovery(host, { deferFallbackChainValidation: true });
			const current = async () => ({
				model: x.source,
				apiKey: () => undefined,
				resolved: { apiKey: "source", credentialId: x.sourceId },
			});

			const first = await recovery.prepareGovernedModelCall(x.source, current, owner);
			expect(first?.model.id).toBe("fallback");

			// Cause resolution on pending route to throw MissingApiKeyError
			throwResolutionError = true;

			const fallbackCurrent = async () => ({
				model: active,
				apiKey: () => undefined,
				resolved: { apiKey: "fallback-key", credentialId: x.pinnedId },
			});

			// Must not throw, must clear zombie route, and fall through
			const second = await recovery.prepareGovernedModelCall(active, fallbackCurrent, owner);
			expect(second).toBeDefined();
			expect(second?.model.id).toBe("fallback");
			const binding = typeof second?.resolved === "object" ? second.resolved?.usageRouteBinding : undefined;
			expect(binding).toBeUndefined();

			expectNoStrayFetch(x.h);
			expect(x.h.redemptionPosts()).toHaveLength(0);
		} finally {
			x.routing.dispose();
		}
	});

	test("pending route resolveGovernedRoute with aborted signal propagates abort", async () => {
		const x = await setupCompatHarness({ governorEnabled: true, allowFallbackAllowance: true });
		try {
			const owner = { kind: "role", role: "task" } as const;
			let active = x.source;

			const routing = {
				candidates: () => x.routing.candidates(owner, "s", x.source, x.sourceId, "error"),
				refresh: x.routing.refresh.bind(x.routing),
				evaluate: x.routing.evaluate.bind(x.routing),
			};

			const host = {
				settings: x.settings,
				usesRegistryAuth: () => true,
				modelRegistry: x.registry,
				usageRouting: routing,
				agent: { state: { messages: [] } },
				model: () => active,
				sessionId: () => "s",
				thinkingLevel: () => undefined,
				configuredThinkingLevel: () => undefined,
				thinkingLevelCeiling: () => undefined,
				contextFitsModel: () => true,
				resolveActiveEditMode: () => "hashline",
				setModelWithProviderSessionReset: async (model: typeof active) => {
					active = model;
				},
				sessionManager: { appendModelChange: () => {}, getSessionId: () => "s" },
				setThinkingLevel: () => {},
				syncAfterModelChange: async () => {},
				emitSessionEvent: async () => {},
				configWarnings: [],
			} as unknown as TurnRecoveryHost;

			const recovery = new TurnRecovery(host, { deferFallbackChainValidation: true });
			const current = async () => ({
				model: x.source,
				apiKey: () => undefined,
				resolved: { apiKey: "source", credentialId: x.sourceId },
			});

			const first = await recovery.prepareGovernedModelCall(x.source, current, owner);
			expect(first?.model.id).toBe("fallback");

			const controller = new AbortController();
			controller.abort();

			// Aborted signal must be honored by throwing
			await expect(recovery.prepareGovernedModelCall(active, current, owner, controller.signal)).rejects.toThrow();

			expectNoStrayFetch(x.h);
			expect(x.h.redemptionPosts()).toHaveLength(0);
		} finally {
			x.routing.dispose();
		}
	});
});
