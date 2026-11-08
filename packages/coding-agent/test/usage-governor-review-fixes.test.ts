import { afterEach, expect, spyOn, test } from "bun:test";
import { Agent, PROVISIONAL_USAGE_CONTEXT } from "@oh-my-pi/pi-agent-core";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { createSettingsAwareStreamFn } from "@oh-my-pi/pi-coding-agent/session/settings-stream-fn";
import * as path from "node:path";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { createHash } from "node:crypto";
import {
	configureUsageAdmission,
	currentUsageAdmission,
	validateSendRoute,
} from "@oh-my-pi/pi-ai/usage-governor/admission";
import { Effort, type AssistantMessage } from "@oh-my-pi/pi-ai";
import type { UsageRouteBinding } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { TurnRecovery, type TurnRecoveryHost } from "@oh-my-pi/pi-coding-agent/session/turn-recovery";
import { SessionUsageRouting } from "@oh-my-pi/pi-coding-agent/session/usage-routing";
import { formatRetryFallbackSelector } from "@oh-my-pi/pi-coding-agent/session/retry-fallback-chains";
import {
	CODEX,
	PROVIDER,
	createHarness,
	credentialIdOf,
	disposeHarness,
	ENABLED,
	expectNoStrayFetch,
	seedAccounts,
	seedReports,
	windowAt,
} from "../../ai/test/fixtures/usage-governor/harness";

afterEach(async () => {
	await disposeHarness();
});

async function setup(later = false) {
	const h = await createHarness(ENABLED);
	const original = h.usage.provider.bind(h.usage);
	h.usage.provider = id => {
		const provider = original(id);
		return {
			...provider,
			governorAllowance: () => ["primary"],
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
		"usageGovernor.enabled": true,
		"retry.modelFallback": true,
		"retry.fallbackChains": {
			task: [`${CODEX}/fallback`, ...(later ? [`${PROVIDER}/later`] : [])],
			[`${PROVIDER}/primary:high`]: [`${CODEX}/fallback`],
			[`${PROVIDER}/primary:low`]: [],
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
		models: [definition("primary"), ...(later ? [definition("later")] : [])],
	});
	registry.registerProvider(CODEX, {
		api: "openai-completions",
		baseUrl: "https://fallback.example.test",
		oauth,
		models: [definition("fallback")],
	});
	const routing = new SessionUsageRouting(settings, registry);
	return {
		h,
		settings,
		registry,
		routing,
		source: registry.find(PROVIDER, "primary")!,
		fallback: registry.find(CODEX, "fallback")!,
		sourceId: credentialIdOf(h, PROVIDER, "source"),
		failedId: credentialIdOf(h, CODEX, "failed"),
		pinnedId: credentialIdOf(h, CODEX, "pinned"),
	};
}

test("failed usage is attributed to the response credential without clearing another pin", async () => {
	const x = await setup();
	try {
		expect(x.h.storage.sessions.pin(CODEX, "s", x.pinnedId)).toBe(true);
		const host = {
			settings: x.settings,
			usesRegistryAuth: () => true,
			modelRegistry: x.registry,
			model: () => x.fallback,
			sessionId: () => "s",
			configWarnings: [],
		} as unknown as TurnRecoveryHost;
		const recovery = new TurnRecovery(host, { deferFallbackChainValidation: true });
		const message = {
			role: "assistant",
			content: [],
			api: "openai-completions",
			provider: CODEX,
			model: "fallback",
			stopReason: "error",
			errorMessage: "429 Weekly usage limit reached. type=GoUsageLimitError retry-after-ms=3242000",
			credentialId: x.failedId,
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
		const missing = { ...message, credentialId: undefined };
		await recovery.recordUsageLimitOutcome(missing);
		expect(x.h.store.getCredentialBlockScopes(x.pinnedId, `${CODEX}:oauth`).size).toBe(0);
		expect(x.h.redemptionPosts()).toHaveLength(0);
		await recovery.recordUsageLimitOutcome(message);
		expect(x.h.storage.sessions.selected(CODEX, "s")).toMatchObject({ credentialId: x.pinnedId, explicit: true });
		expect(x.h.store.getCredentialBlockScopes(x.failedId, `${CODEX}:oauth`).size).toBeGreaterThan(0);
		expect(x.h.store.getCredentialBlockScopes(x.pinnedId, `${CODEX}:oauth`).size).toBe(0);
		expectNoStrayFetch(x.h);
	} finally {
		x.routing.dispose();
	}
});

test("model-owned routes distinguish effort-specific chains", async () => {
	const x = await setup();
	try {
		const high = formatRetryFallbackSelector(x.source, Effort.High);
		const low = formatRetryFallbackSelector(x.source, Effort.Low);
		expect(high).toBe(`${PROVIDER}/primary:high`);
		const routes = await x.routing.candidates({ kind: "model", selector: high }, "s", x.source, x.sourceId, "error");
		expect(routes.map(route => route.target.selector)).toEqual([`${CODEX}/fallback`, `${CODEX}/fallback`]);
		expect(new Set(routes.map(route => route.credentialId))).toEqual(new Set([x.failedId, x.pinnedId]));
		expect(await x.routing.candidates({ kind: "model", selector: low }, "s", x.source, x.sourceId, "error")).toEqual(
			[],
		);
		expectNoStrayFetch(x.h);
	} finally {
		x.routing.dispose();
	}
});

test("a stale fallback is rebound to a newly authorized revision without throwing", async () => {
	const x = await setup();
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
		x.routing.refresh(true);
		const fresh = await recovery.prepareGovernedModelCall(active, current, owner);
		const binding = typeof fresh?.resolved === "object" ? fresh.resolved?.usageRouteBinding : undefined;
		expect(binding?.revision).toBeGreaterThan(oldRevision);
		expectNoStrayFetch(x.h);
		expect(x.h.redemptionPosts()).toHaveLength(0);
	} finally {
		x.routing.dispose();
	}
});

for (const failure of ["usage", "policy"] as const) {
	for (const siblingState of ["included", "unknown", "spent", "later"] as const) {
		test(`bound ${failure} recovery handles ${siblingState} sibling`, async () => {
			const x = await setup(siblingState === "later");
			try {
				const owner = { kind: "role", role: "task" } as const;
				let active = x.source;
				const selection: { siblingId?: number } = {};
				let retryScheduled = false;
				const routing = {
					refresh: x.routing.refresh.bind(x.routing),
					candidates: (
						requestedOwner: typeof owner,
						sessionId: string,
						model: typeof active,
						credentialId: number | undefined,
						intent: "error" | "proactive",
						signal?: AbortSignal,
					) =>
						x.routing.candidates(
							requestedOwner,
							sessionId,
							model,
							credentialId,
							intent === "proactive" ? "error" : intent,
							signal,
						),
					evaluate: async (requestedOwner: typeof owner, sessionId: string, signal?: AbortSignal) => {
						const result = await x.routing.evaluate(requestedOwner, sessionId, signal);
						if (!result || siblingState === "included" || selection.siblingId === undefined) return result;
						return {
							...result,
							accounts: result.accounts.map(account =>
								account.credentialId === selection.siblingId
									? { ...account, allowance: siblingState === "later" ? ("unknown" as const) : siblingState }
									: account,
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
					model: x.source,
					apiKey: () => undefined,
					resolved: { apiKey: "source", credentialId: x.sourceId },
				});
				const initial = await recovery.prepareGovernedModelCall(x.source, current, owner);
				const first = typeof initial?.resolved === "object" ? initial.resolved?.credentialId : undefined;
				expect(first).toBeDefined();
				selection.siblingId = first === x.failedId ? x.pinnedId : x.failedId;
				const message = {
					role: "assistant",
					content: [],
					api: "openai-codex-responses",
					provider: CODEX,
					model: "fallback",
					stopReason: "error",
					credentialId: first,
					timestamp: Date.now(),
					errorMessage:
						failure === "usage"
							? "429 Weekly usage limit reached. type=GoUsageLimitError retry-after-ms=3242000"
							: "Codex error event: This content was flagged for possible cybersecurity risk. Join Trusted Access for Cyber. (code=cyber_policy)",
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
				} as AssistantMessage;
				if (failure === "usage") expect(await recovery.recordUsageLimitOutcome(message)).toBe(true);
				const retried = await recovery.handleRetryableError(message);
				expect(retried).toBe(true);
				expect(retryScheduled).toBe(true);
				if (siblingState === "included") {
					const prepared = await recovery.prepareGovernedModelCall(active, current, owner);
					expect(
						typeof prepared?.resolved === "object" && prepared.resolved?.usageRouteBinding?.credentialId,
					).toBe(selection.siblingId);
				} else if (siblingState === "later") {
					const prepared = await recovery.prepareGovernedModelCall(active, current, owner);
					expect(
						typeof prepared?.resolved === "object" && prepared.resolved?.usageRouteBinding?.credentialId,
					).toBe(x.sourceId);
				} else {
					const prepared = await recovery.prepareGovernedModelCall(active, current, owner);
					expect(prepared).toBeDefined();
					const binding =
						typeof prepared?.resolved === "object" ? prepared.resolved?.usageRouteBinding : undefined;
					expect(binding).toBeUndefined();
				}
				expectNoStrayFetch(x.h);
				expect(x.h.redemptionPosts()).toHaveLength(0);
			} finally {
				x.routing.dispose();
			}
		});
	}
}

test("switch restores transcript role and a rejected switch preserves it", async () => {
	const x = await setup();
	const manager = SessionManager.create(x.h.dir, path.join(x.h.dir, "sessions"));
	const target = SessionManager.create(x.h.dir, path.join(x.h.dir, "target"));
	target.appendModelChange(`${PROVIDER}/primary`, "task");
	await target.ensureOnDisk();
	const targetFile = target.getSessionFile()!;
	await target.close();
	const rejectedTarget = SessionManager.create(x.h.dir, path.join(x.h.dir, "rejected"));
	rejectedTarget.appendModelChange(`${PROVIDER}/primary`, "default");
	await rejectedTarget.ensureOnDisk();
	const rejectedFile = rejectedTarget.getSessionFile()!;
	await rejectedTarget.close();
	const agent = new Agent({ initialState: { model: x.source, systemPrompt: [], tools: [], messages: [] } });
	const session = new AgentSession({
		agent,
		sessionManager: manager,
		settings: x.settings,
		modelRegistry: x.registry,
		routingRole: "default",
	});
	try {
		expect(session.usageRoutingContext?.routingRole).toBe("default");
		expect(await session.switchSession(targetFile)).toBe(true);
		expect(session.usageRoutingContext?.routingRole).toBe("task");
		const failure = new Error("target model switch failed");
		const setModel = spyOn(agent, "setModel").mockImplementationOnce(() => {
			expect(session.usageRoutingContext?.routingRole).toBe("default");
			throw failure;
		});
		try {
			await expect(session.switchSession(rejectedFile)).rejects.toBe(failure);
		} finally {
			setModel.mockRestore();
		}
		expect(session.usageRoutingContext?.routingRole).toBe("task");
		expectNoStrayFetch(x.h);
	} finally {
		await session.dispose();
		await manager.close();
		x.routing.dispose();
	}
});

test("a custom direct-session stream validates a bound route with the issuing transcript", async () => {
	const x = await setup();
	const mock = createMockModel({ responses: [{ content: ["ok"] }] });
	const manager = SessionManager.create(x.h.dir, path.join(x.h.dir, "direct"));
	const owner = { kind: "role", role: "task" } as const;
	const priorAdmission = currentUsageAdmission();
	let binding: UsageRouteBinding;
	let bearer = "";
	let reached = false;
	const registryResolver = () => undefined;
	const agent = new Agent({
		getApiKey: registryResolver,
		initialState: { model: x.fallback, systemPrompt: [], tools: [], messages: [] },
		streamFn: async (model, context, options) => {
			const key = options?.apiKey;
			const actual = typeof key === "function" ? await key({ lastChance: false, error: undefined }) : key;
			if (!actual || typeof actual === "string") throw new Error("bound credential was lost");
			validateSendRoute({
				provider: model.provider,
				modelId: model.id,
				baseUrl: model.baseUrl,
				credentialId: actual.credentialId,
				bearer: actual.apiKey,
				context: options?.usageContext,
				usageRouteBinding: actual.usageRouteBinding,
			});
			if (!actual.usageRouteBinding) throw new Error("route binding was lost");
			reached = true;
			return mock.stream(model, context, options);
		},
	});
	const session = new AgentSession({
		agent,
		registryAuthResolver: registryResolver,
		sessionManager: manager,
		settings: x.settings,
		modelRegistry: x.registry,
		routingRole: "task",
	});
	try {
		const candidate = (await x.routing.candidates(owner, session.sessionId, x.source, x.sourceId, "error"))[0]!;
		expect(candidate).toBeDefined();
		const resolved = await x.registry.getApiKeyWithCredentialForProvider(CODEX, session.sessionId, {
			modelId: x.fallback.id,
			baseUrl: x.fallback.baseUrl,
			requestCredential: { credentialId: candidate.credentialId },
			recordAffinity: false,
		});
		expect(resolved).toBeDefined();
		bearer = resolved!.apiKey;
		binding = { ...candidate, bearerFingerprint: createHash("sha256").update(bearer).digest("base64url") };
		const prepare = agent.prepareModelCallAuth!;
		agent.prepareModelCallAuth = (model, _resolve, signal) =>
			prepare(
				model,
				async () => ({
					model,
					apiKey: () => undefined,
					resolved: { ...resolved!, usageRouteBinding: binding },
				}),
				signal,
			);
		configureUsageAdmission(x.h.storage.governor);
		await agent.prompt("test");
		expect(reached).toBe(true);
		expect(mock.calls[0]?.options?.usageContext).toMatchObject({
			sessionId: session.sessionId,
			source: "unattributed",
		});
		expectNoStrayFetch(x.h);
		expect(x.h.redemptionPosts()).toHaveLength(0);
	} finally {
		configureUsageAdmission(priorAdmission);
		await session.dispose();
		await manager.close();
		x.routing.dispose();
	}
});

test("settings wrapper enriches provisional attribution without replacing explicit context", async () => {
	const settings = Settings.isolated({});
	const mock = createMockModel({ responses: [{ content: ["one"] }, { content: ["two"] }] });
	const wrapper = createSettingsAwareStreamFn(settings, mock.stream, {
		usageContext: () => ({ source: "subagent", role: "task", routingRole: "task", sessionId: "actual-session" }),
	});
	const provisional = {
		source: "unattributed" as const,
		sessionId: "issuing-session",
		[PROVISIONAL_USAGE_CONTEXT]: true,
	};
	const context = { systemPrompt: [], messages: [] };
	await (await wrapper(mock.model, context, { usageContext: provisional })).result();
	await (
		await wrapper(mock.model, context, { usageContext: { source: "advisor", role: "judge", sessionId: "explicit" } })
	).result();
	expect(mock.calls[0]?.options?.usageContext).toEqual({
		source: "subagent",
		role: "task",
		routingRole: "task",
		sessionId: "issuing-session",
	});
	expect(mock.calls[1]?.options?.usageContext).toEqual({ source: "advisor", role: "judge", sessionId: "explicit" });
});
