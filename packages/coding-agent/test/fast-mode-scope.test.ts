import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { Api, AssistantMessage, Model, ProviderSessionState, ServiceTier, UsageReport } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { withOfficialAnthropicEndpoint } from "./helpers/anthropic-endpoint";

withOfficialAnthropicEndpoint();

describe("/fast targets the current model's service-tier family", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession | undefined;
	let modelRegistry: ModelRegistry;

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-fast-mode-scope-");
	});

	afterEach(async () => {
		await session?.dispose();
		session = undefined;
		authStorage?.close();
		tempDir.removeSync();
		vi.restoreAllMocks();
	});

	async function createSession(provider: "anthropic" | "openai", modelId: string): Promise<AgentSession> {
		const model = getBundledModel(provider, modelId);
		if (!model) {
			throw new Error(`Expected bundled test model ${provider}/${modelId} to exist`);
		}
		return createSessionForModel(model);
	}

	async function createSessionForModel(
		model: Model<Api>,
		settings = Settings.isolated(),
		streamFn?: Agent["streamFn"],
		agentKind?: "main" | "sub",
		usageReports?: UsageReport[],
	): Promise<AgentSession> {
		const agent = new Agent({
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn,
		});
		authStorage = await AuthStorage.create(
			path.join(tempDir.path(), "testauth.db"),
			usageReports ? { fetchUsageReports: async () => usageReports } : {},
		);
		authStorage.setRuntimeApiKey(model.provider, "token");
		modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry,
			agentKind,
		});
		session.subscribe(() => {});
		return session;
	}

	it("enables priority on the Anthropic family for a Claude model", async () => {
		const session = await createSession("anthropic", "claude-sonnet-4-5");
		session.setFastMode(true);
		expect(session.serviceTierByFamily).toEqual({ anthropic: "priority" });
		expect(session.isFastModeEnabled()).toBe(true);
	});

	it("keeps Anthropic priority enabled while an exact-model provider fallback makes it inactive", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled test model anthropic/claude-sonnet-4-5 to exist");
		const session = await createSessionForModel(model);
		session.setFastMode(true);
		const state = {
			strictToolsDisabled: false,
			fastModeDisabled: true,
			replayUnsignedThinkingDisabled: false,
			close: () => {},
		} as ProviderSessionState & { fastModeDisabled: boolean };
		session.providerSessionState.set(`anthropic-messages:${model.baseUrl}\u0000${model.id}`, state);

		expect(session.isFastModeEnabled()).toBe(true);
		expect(session.isFastModeActive()).toBe(false);

		session.setFastMode(true);
		expect(session.isFastModeEnabled()).toBe(true);
		expect(session.isFastModeActive()).toBe(true);
		expect(state.fastModeDisabled).toBe(false);
	});

	it("enables priority on the OpenAI family for an OpenAI model", async () => {
		const session = await createSession("openai", "gpt-5.2");
		session.setFastMode(true);
		expect(session.serviceTierByFamily).toEqual({ openai: "priority" });
		expect(session.isFastModeEnabled()).toBe(true);
	});

	it("enables priority for a custom OpenAI-compatible relay serving an OpenAI model", async () => {
		const session = await createSessionForModel(
			buildModel({
				id: "o4-mini",
				name: "O4 Mini Relay",
				api: "openai-responses",
				provider: "custom-relay",
				baseUrl: "https://relay.example/v1",
				reasoning: true,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 400_000,
				maxTokens: 64_000,
			}),
		);
		expect(session.setFastMode(true)).toBe(true);
		expect(session.serviceTierByFamily).toEqual({ openai: "priority" });
		expect(session.isFastModeEnabled()).toBe(true);
		expect(session.isFastModeActive()).toBe(true);
	});

	it("leaves Fireworks models on the dedicated Fireworks tier control", async () => {
		const session = await createSessionForModel(
			buildModel({
				id: "gpt-oss-120b",
				name: "GPT OSS 120B",
				api: "openai-completions",
				provider: "fireworks",
				baseUrl: "https://api.fireworks.ai/inference/v1",
				reasoning: true,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128_000,
				maxTokens: 64_000,
			}),
		);
		expect(session.setFastMode(true)).toBe(false);
		expect(session.serviceTierByFamily).toEqual({});
		expect(session.isFastModeEnabled()).toBe(false);
		expect(session.isFastModeActive()).toBe(false);
	});

	it("clears only the current model's family when disabled", async () => {
		const session = await createSession("anthropic", "claude-sonnet-4-5");
		session.setFastMode(true);
		session.setFastMode(false);
		expect(session.serviceTierByFamily).toEqual({});
		expect(session.isFastModeEnabled()).toBe(false);
	});

	it("toggle reports the resulting state", async () => {
		const session = await createSession("anthropic", "claude-sonnet-4-5");
		expect(session.toggleFastMode()).toBe(true);
		expect(session.serviceTierByFamily.anthropic).toBe("priority");
		expect(session.toggleFastMode()).toBe(false);
		expect(session.serviceTierByFamily.anthropic).toBeUndefined();
	});

	describe("automatic user-activity priority", () => {
		function createAutoFastSession(
			agentKind?: "main" | "sub",
			autoFastModeDurationMinutes = 20,
		): {
			model: Model<Api>;
			sessionPromise: Promise<AgentSession>;
			sentTiers: Array<ServiceTier | undefined>;
		} {
			const model = getBundledModel("openai", "gpt-5.2");
			if (!model) throw new Error("Expected bundled gpt-5.2 model to exist");
			const mock = createMockModel({ responses: [{ content: ["Done"] }, { content: ["Done"] }] });
			const sentTiers: Array<ServiceTier | undefined> = [];
			return {
				model,
				sentTiers,
				sessionPromise: createSessionForModel(
					model,
					Settings.isolated({
						"tier.autoFastMode": true,
						"tier.autoFastModeDurationMinutes": autoFastModeDurationMinutes,
						"compaction.enabled": false,
					}),
					(streamModel, context, options) => {
						sentTiers.push(options?.serviceTier);
						return mock.stream(streamModel, context, options);
					},
					agentKind,
				),
			};
		}

		it("uses priority only while a user-activity lease is current", async () => {
			let now = 1_000;
			vi.spyOn(Date, "now").mockImplementation(() => now);
			const { model, sentTiers, sessionPromise } = createAutoFastSession();
			const session = await sessionPromise;
			expect(session.isFastModeActive()).toBe(false);

			await session.prompt("Respond now");
			await session.waitForIdle();

			expect(sentTiers).toEqual(["priority"]);
			expect(session.serviceTierByFamily).toEqual({});
			expect(session.configuredServiceTier(model)).toBeUndefined();
			expect(session.isFastModeActive()).toBe(true);

			now += 20 * 60 * 1000;
			expect(session.agent.serviceTierResolver?.(model)).toBeUndefined();
			expect(session.isFastModeActive()).toBe(false);
		});

		it("uses the configured activity duration", async () => {
			let now = 1_000;
			vi.spyOn(Date, "now").mockImplementation(() => now);
			const { model, sessionPromise } = createAutoFastSession(undefined, 1);
			const session = await sessionPromise;

			await session.prompt("Respond now");
			await session.waitForIdle();

			now += 60 * 1000 - 1;
			expect(session.agent.serviceTierResolver?.(model)).toBe("priority");
			now += 1;
			expect(session.agent.serviceTierResolver?.(model)).toBeUndefined();
		});

		it("lets a manual fast-off suppress the current activity lease", async () => {
			const { model, sentTiers, sessionPromise } = createAutoFastSession();
			const session = await sessionPromise;

			await session.prompt("Respond now");
			await session.waitForIdle();

			session.setFastMode(false);
			expect(session.agent.serviceTierResolver?.(model)).toBeUndefined();

			await session.prompt("A new user prompt renews the lease");
			await session.waitForIdle();
			expect(sentTiers).toEqual(["priority", "priority"]);
		});

		it("lets fast toggle turn an active lease off", async () => {
			const { model, sessionPromise } = createAutoFastSession();
			const session = await sessionPromise;

			await session.prompt("Respond now");
			await session.waitForIdle();
			expect(session.isFastModeActive()).toBe(true);

			expect(session.toggleFastMode()).toBe(false);
			expect(session.isFastModeActive()).toBe(false);
			expect(session.agent.serviceTierResolver?.(model)).toBeUndefined();
		});

		it("activates for a user-attributed custom prompt", async () => {
			const { sentTiers, sessionPromise } = createAutoFastSession();
			const session = await sessionPromise;

			await session.promptCustomMessage({
				customType: "user-action",
				content: "Run this user action",
				display: false,
				attribution: "user",
			});
			await session.waitForIdle();

			expect(sentTiers).toEqual(["priority"]);
		});

		it("keeps child sessions at their configured tier", async () => {
			const { sentTiers, sessionPromise } = createAutoFastSession("sub");
			const session = await sessionPromise;

			await session.prompt("Do child work");
			await session.waitForIdle();

			expect(sentTiers).toEqual([undefined]);
			expect(session.isFastModeActive()).toBe(false);
		});

		it("keeps agent-attributed side-session prompts at their configured tier", async () => {
			const { sentTiers, sessionPromise } = createAutoFastSession();
			const session = await sessionPromise;

			await session.prompt("Generate a side-session result", { attribution: "agent" });
			await session.waitForIdle();

			expect(sentTiers).toEqual([undefined]);
			expect(session.isFastModeActive()).toBe(false);
		});

		it("does not start a lease for an agent-attributed prompt queued while streaming", async () => {
			const model = getBundledModel("openai", "gpt-5.2");
			if (!model) throw new Error("Expected bundled gpt-5.2 model to exist");
			const started = Promise.withResolvers<void>();
			const mock = createMockModel({
				responses: [
					() => {
						started.resolve();
						return { content: ["Working"], delayMs: 60_000 };
					},
					{ content: ["Done"] },
				],
			});
			const sentTiers: Array<ServiceTier | undefined> = [];
			const session = await createSessionForModel(
				model,
				Settings.isolated({
					"tier.autoFastMode": true,
					"tier.autoFastModeDurationMinutes": 20,
					"compaction.enabled": false,
				}),
				(streamModel, context, options) => {
					sentTiers.push(options?.serviceTier);
					return mock.stream(streamModel, context, options);
				},
			);

			const firstPrompt = session.prompt("Kick off agent work", { attribution: "agent" });
			await started.promise;
			expect(session.isStreaming).toBe(true);
			expect(session.isFastModeActive()).toBe(false);

			await session.prompt("Follow-up agent request", {
				attribution: "agent",
				streamingBehavior: "steer",
			});
			expect(session.isFastModeActive()).toBe(false);

			await session.abort();
			await firstPrompt;
		});

		it("does not activate for a synthetic prompt", async () => {
			const { model, sessionPromise } = createAutoFastSession();
			const session = await sessionPromise;

			await session.prompt("Synthetic continuation", { synthetic: true });
			await session.waitForIdle();

			expect(session.agent.serviceTierResolver?.(model)).toBeUndefined();
		});

		it("warns once when the provider refuses an activity-lease priority request", async () => {
			const model = getBundledModel("anthropic", "claude-sonnet-4-5");
			if (!model) throw new Error("Expected bundled claude-sonnet-4-5 model to exist");
			// The provider drops the priority signal and reports it on every later
			// turn of the session, so the warning has to dedupe by provider/model.
			const session = await createSessionForModel(
				model,
				Settings.isolated({
					"tier.autoFastMode": true,
					"tier.autoFastModeDurationMinutes": 20,
					"compaction.enabled": false,
				}),
				streamModel => {
					const stream = new AssistantMessageEventStream();
					queueMicrotask(() => {
						const message: AssistantMessage = {
							role: "assistant",
							content: [{ type: "text", text: "Done" }],
							api: streamModel.api,
							provider: streamModel.provider,
							model: streamModel.id,
							usage: {
								input: 0,
								output: 0,
								cacheRead: 0,
								cacheWrite: 0,
								totalTokens: 0,
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
							},
							stopReason: "stop",
							disabledFeatures: ["priority"],
							timestamp: Date.now(),
						};
						stream.push({ type: "start", partial: message });
						stream.push({ type: "text_start", contentIndex: 0, partial: message });
						stream.push({ type: "text_delta", contentIndex: 0, delta: "Done", partial: message });
						stream.push({ type: "text_end", contentIndex: 0, content: "Done", partial: message });
						stream.push({ type: "done", reason: "stop", message });
					});
					return stream;
				},
			);
			const notices: string[] = [];
			session.subscribe(event => {
				if (event.type === "notice" && event.source === "priority") notices.push(event.message);
			});

			await session.prompt("First prompt");
			await session.waitForIdle();
			await session.prompt("Second prompt");
			await session.waitForIdle();

			expect(notices).toEqual([
				`Auto fast mode rejected for ${model.provider}/${model.id}; retried without it. Other models keep auto fast mode; /fast on re-arms this one.`,
			]);
			// The lease is per-request, so the family map stays untouched and every
			// other model keeps its own lease.
			expect(session.serviceTierByFamily).toEqual({});
		});

		function creditlessReport(): UsageReport {
			return {
				provider: "anthropic",
				fetchedAt: Date.now(),
				limits: [],
				priorityEntitlement: { available: false, reason: "usage credits are disabled" },
			};
		}

		async function createEntitlementSession(): Promise<{
			model: Model<Api>;
			session: AgentSession;
			sentTiers: Array<ServiceTier | undefined>;
		}> {
			const model = getBundledModel("anthropic", "claude-sonnet-4-5");
			if (!model) throw new Error("Expected bundled claude-sonnet-4-5 model to exist");
			const mock = createMockModel({ responses: [{ content: ["Done"] }, { content: ["Done"] }] });
			const sentTiers: Array<ServiceTier | undefined> = [];
			const session = await createSessionForModel(
				model,
				Settings.isolated({
					"tier.autoFastMode": true,
					"tier.autoFastModeDurationMinutes": 20,
					"compaction.enabled": false,
				}),
				(streamModel, context, options) => {
					sentTiers.push(options?.serviceTier);
					return mock.stream(streamModel, context, options);
				},
				undefined,
				[creditlessReport()],
			);
			// The status-line poll is what populates the entitlement snapshot.
			await session.fetchUsageReports();
			return { model, session, sentTiers };
		}

		it("skips the auto lease when the account cannot use priority", async () => {
			const { session, sentTiers } = await createEntitlementSession();

			await session.prompt("Respond now");
			await session.waitForIdle();

			expect(sentTiers).toEqual([undefined]);
			// Intent is still on, so the state reports blocked (red icon) rather
			// than off, which would read as "nobody asked for priority".
			expect(session.fastModeState()).toBe("blocked");
			expect(session.isFastModeActive()).toBe(false);
		});

		it("keeps the auto lease on another family after falling back off a blocked one", async () => {
			// Anthropic reports the entitlement per account, so it must not leak onto
			// the OpenAI-family model a fallback chain lands on.
			const model = getBundledModel("openai-codex", "gpt-5.6-terra");
			if (!model) throw new Error("Expected bundled gpt-5.6-terra model to exist");
			const mock = createMockModel({ responses: [{ content: ["Done"] }] });
			const sentTiers: Array<ServiceTier | undefined> = [];
			const session = await createSessionForModel(
				model,
				Settings.isolated({
					"tier.autoFastMode": true,
					"tier.autoFastModeDurationMinutes": 20,
					"compaction.enabled": false,
				}),
				(streamModel, context, options) => {
					sentTiers.push(options?.serviceTier);
					return mock.stream(streamModel, context, options);
				},
				undefined,
				[creditlessReport()],
			);
			await session.fetchUsageReports();

			await session.prompt("Respond now");
			await session.waitForIdle();

			expect(sentTiers).toEqual(["priority"]);
			expect(session.fastModeState()).toBe("active");
		});

		it("still attempts priority on an explicit /fast on, with a warning", async () => {
			const { session, sentTiers } = await createEntitlementSession();
			const notices: string[] = [];
			session.subscribe(event => {
				if (event.type === "notice" && event.source === "priority") notices.push(event.message);
			});

			expect(session.setFastMode(true)).toBe(true);
			await session.prompt("Respond now");
			await session.waitForIdle();

			expect(sentTiers).toEqual(["priority"]);
			expect(notices).toEqual([
				"Fast mode enabled, but usage credits are disabled; expect the provider to refuse it.",
			]);
		});

		it("clears the blocked state once the provider serves priority again", async () => {
			const model = getBundledModel("openai", "gpt-5.2");
			if (!model) throw new Error("Expected bundled gpt-5.2 model to exist");
			// First turn is downgraded (OpenAI echoes a lower `service_tier`), second
			// is served at priority.
			let downgrade = true;
			const session = await createSessionForModel(
				model,
				Settings.isolated({
					"tier.autoFastMode": true,
					"tier.autoFastModeDurationMinutes": 20,
					"compaction.enabled": false,
				}),
				streamModel => {
					const stream = new AssistantMessageEventStream();
					const disabledFeatures = downgrade ? ["priority"] : undefined;
					downgrade = false;
					queueMicrotask(() => {
						const message: AssistantMessage = {
							role: "assistant",
							content: [{ type: "text", text: "Done" }],
							api: streamModel.api,
							provider: streamModel.provider,
							model: streamModel.id,
							usage: {
								input: 0,
								output: 0,
								cacheRead: 0,
								cacheWrite: 0,
								totalTokens: 0,
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
							},
							stopReason: "stop",
							...(disabledFeatures ? { disabledFeatures } : {}),
							timestamp: Date.now(),
						};
						stream.push({ type: "start", partial: message });
						stream.push({ type: "text_start", contentIndex: 0, partial: message });
						stream.push({ type: "text_delta", contentIndex: 0, delta: "Done", partial: message });
						stream.push({ type: "text_end", contentIndex: 0, content: "Done", partial: message });
						stream.push({ type: "done", reason: "stop", message });
					});
					return stream;
				},
			);

			await session.prompt("First prompt");
			await session.waitForIdle();
			expect(session.fastModeState()).toBe("blocked");

			await session.prompt("Second prompt");
			await session.waitForIdle();
			expect(session.fastModeState()).toBe("active");
		});
	});
});
