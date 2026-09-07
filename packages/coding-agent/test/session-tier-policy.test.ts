import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent, type StreamFn } from "@oh-my-pi/pi-agent-core";
import type { Api, AssistantMessage, Model, ServiceTier, ServiceTierByFamily } from "@oh-my-pi/pi-ai";
import { Effort } from "@oh-my-pi/pi-ai";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { buildServiceTierByFamily, type ServiceTierOverrides } from "@oh-my-pi/pi-coding-agent/config/service-tier";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession, type AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

describe("session tier policy at the request boundary", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	const sessions: AgentSession[] = [];

	beforeAll(async () => {
		tempDir = TempDir.createSync("@pi-session-tier-policy-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		authStorage.setRuntimeApiKey("openai", "test-key");
		authStorage.setRuntimeApiKey("openai-codex", "test-key");
		modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
	});

	afterEach(async () => {
		await Promise.all(sessions.splice(0).map(session => session.dispose()));
	});

	afterAll(() => {
		authStorage.close();
		tempDir.removeSync();
	});

	function bundledModelOrThrow(provider: Parameters<typeof getBundledModel>[0], id: string): Model<Api> {
		const model = getBundledModel(provider, id);
		if (!model) throw new Error(`Expected bundled test model ${provider}/${id} to exist`);
		return model;
	}

	const ZERO_USAGE: AssistantMessage["usage"] = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};

	function completedStream(model: Model<Api>, text: string, disabledFeatures?: string[]): AssistantMessageEventStream {
		const stream = new AssistantMessageEventStream();
		queueMicrotask(() => {
			const partial: AssistantMessage = {
				role: "assistant",
				content: [{ type: "text", text }],
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: ZERO_USAGE,
				stopReason: "stop",
				timestamp: Date.now(),
				...(disabledFeatures ? { disabledFeatures } : {}),
			};
			stream.push({ type: "start", partial });
			stream.push({ type: "done", reason: "stop", message: partial });
		});
		return stream;
	}

	function errorStream(model: Model<Api>, message: string): AssistantMessageEventStream {
		const stream = new AssistantMessageEventStream();
		queueMicrotask(() => {
			const failure: AssistantMessage = {
				role: "assistant",
				content: [],
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: ZERO_USAGE,
				stopReason: "error",
				errorMessage: message,
				timestamp: Date.now(),
				duration: 1,
			};
			stream.push({ type: "start", partial: failure });
			stream.push({ type: "error", reason: "error", error: failure });
		});
		return stream;
	}

	interface WireCall {
		selector: string;
		reasoning: string | undefined;
		disableReasoning: boolean;
		serviceTier: ServiceTier | undefined;
	}

	function recordingStreamFn(respond: (selector: string, model: Model<Api>) => AssistantMessageEventStream): {
		calls: WireCall[];
		streamFn: StreamFn;
	} {
		const calls: WireCall[] = [];
		const streamFn: StreamFn = (model, _context, options) => {
			calls.push({
				selector: `${model.provider}/${model.id}`,
				reasoning: options?.reasoning,
				disableReasoning: options?.disableReasoning === true,
				serviceTier: options?.serviceTier,
			});
			return respond(`${model.provider}/${model.id}`, model);
		};
		return { calls, streamFn };
	}

	function tierSettings(
		options: {
			modelOverrides?: Record<string, string>;
			configuredTier?: ServiceTierByFamily & { anthropic?: "priority"; google?: "flex" | "priority" };
			retryFallbackChain?: string[];
			defaultRole?: string;
		} = {},
	): Settings {
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"todo.enabled": false,
			"retry.baseDelayMs": 5,
		});
		if (options.modelOverrides) settings.set("tier.modelOverrides", options.modelOverrides);
		if (options.configuredTier?.openai) settings.set("tier.openai", options.configuredTier.openai);
		if (options.configuredTier?.anthropic) settings.set("tier.anthropic", options.configuredTier.anthropic);
		if (options.configuredTier?.google) settings.set("tier.google", options.configuredTier.google);
		if (options.retryFallbackChain) settings.set("retry.fallbackChains", { default: options.retryFallbackChain });
		if (options.defaultRole) settings.setModelRole("default", options.defaultRole);
		return settings;
	}

	async function createSession(options: {
		model: Model<Api>;
		streamFn: StreamFn;
		thinkingLevel?: Effort;
		settings?: Settings;
		/** Launch-option manual layer (`--service-tier` / `serviceTierOverrides`), as the SDK derives it. */
		manualOverrides?: ServiceTierOverrides;
		persisted?: boolean;
	}): Promise<AgentSession> {
		const settings = options.settings ?? tierSettings();
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: {
				model: options.model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
				thinkingLevel: options.thinkingLevel ?? Effort.High,
			},
			streamFn: options.streamFn,
		});
		const session = new AgentSession({
			agent,
			sessionManager: options.persisted
				? SessionManager.create(tempDir.path(), tempDir.path())
				: SessionManager.inMemory(),
			settings,
			modelRegistry,
			thinkingLevel: options.thinkingLevel ?? Effort.High,
			// SDK parity: the configured `tier.*` policy rides in as the live
			// family baseline while launch options stay a separate manual layer.
			serviceTierByFamily: buildServiceTierByFamily(
				settings.get("tier.openai"),
				settings.get("tier.anthropic"),
				settings.get("tier.google"),
			),
			...(options.manualOverrides !== undefined ? { serviceTierOverrides: options.manualOverrides } : {}),
		});
		session.subscribe(() => {});
		sessions.push(session);
		return session;
	}

	function tierEntries(session: AgentSession) {
		return session.sessionManager.getEntries().filter(entry => entry.type === "service_tier_change");
	}

	it("matches tier.modelOverrides keys against the actual resolved provider identity", async () => {
		const luna = bundledModelOrThrow("openai-codex", "gpt-5.6-luna");
		const { calls, streamFn } = recordingStreamFn(() => completedStream(luna, "ok"));
		const session = await createSession({
			model: luna,
			streamFn,
			settings: tierSettings({
				modelOverrides: { "openai/gpt-5.6-luna": "none", "openai-codex/gpt-5.6-luna": "priority" },
			}),
		});

		await session.prompt("Implement a focused parser fix");

		// The provider-exact key drives the wire; the same-id key naming the
		// sibling `openai` provider stays inert instead of suppressing priority.
		expect(calls).toHaveLength(1);
		expect(calls[0]?.selector).toBe("openai-codex/gpt-5.6-luna");
		expect(calls[0]?.reasoning).toBe(Effort.High);
		expect(calls[0]?.serviceTier).toBe("priority");
		expect(session.isFastModeEnabled()).toBe(true);
		expect(session.isFastModeActive()).toBe(true);
	});

	it("rescinds an automatic model-rule priority after the provider rejects it and keeps it off", async () => {
		const luna = bundledModelOrThrow("openai-codex", "gpt-5.6-luna");
		let rejected = false;
		const { calls, streamFn } = recordingStreamFn(() => {
			const features = rejected ? undefined : ["priority"];
			rejected = true;
			return completedStream(luna, "served", features);
		});
		const session = await createSession({
			model: luna,
			streamFn,
			settings: tierSettings({ modelOverrides: { "openai-codex/gpt-5.6-luna:high": "priority" } }),
		});
		const notices: Array<Extract<AgentSessionEvent, { type: "notice" }>> = [];
		session.subscribe(event => {
			if (event.type === "notice") notices.push(event);
		});

		await session.prompt("Implement a focused parser fix");
		expect(calls[0]?.serviceTier).toBe("priority");
		expect(notices.some(notice => notice.message.includes("Priority/fast mode rejected"))).toBe(true);

		await session.prompt("Follow-up turn after the rejection");
		expect(calls).toHaveLength(2);
		expect(calls[1]?.selector).toBe("openai-codex/gpt-5.6-luna");
		expect(calls[1]?.serviceTier).toBeUndefined();
		expect(session.isFastModeEnabled()).toBe(false);
		expect(session.isFastModeActive()).toBe(false);
	});

	it("re-arms an explicitly re-set family tier after a provider rejection", async () => {
		const luna = bundledModelOrThrow("openai-codex", "gpt-5.6-luna");
		let call = 0;
		const { calls, streamFn } = recordingStreamFn(() => {
			call += 1;
			// Calls 1 and 3 drop priority server-side; every other call serves cleanly.
			const features = call === 1 || call === 3 ? ["priority"] : undefined;
			return completedStream(luna, "served", features);
		});
		const session = await createSession({
			model: luna,
			streamFn,
			settings: tierSettings({ modelOverrides: { "openai-codex/gpt-5.6-luna:high": "priority" } }),
		});

		await session.prompt("Implement a focused parser fix");
		expect(calls[0]?.serviceTier).toBe("priority");

		await session.prompt("Follow-up turn after the rejection");
		expect(calls[1]?.serviceTier).toBeUndefined();
		expect(session.isFastModeEnabled()).toBe(false);

		expect(session.setFastMode(true)).toBe(true);
		expect(session.isFastModeEnabled()).toBe(true);
		await session.prompt("Follow-up turn after the explicit re-arm");
		expect(calls[2]?.serviceTier).toBe("priority");

		await session.prompt("Follow-up turn that gets rejected again");
		expect(calls[3]?.serviceTier).toBeUndefined();
		expect(session.isFastModeEnabled()).toBe(false);
		expect(session.setFastMode(true)).toBe(true);
		await session.prompt("Follow-up turn after the second re-arm");
		expect(calls[4]?.serviceTier).toBe("priority");
		expect(session.isFastModeEnabled()).toBe(true);
	});

	it("re-resolves the tier rule against the fallback model mid-turn without sticking to the primary", async () => {
		const luna = bundledModelOrThrow("openai-codex", "gpt-5.6-luna");
		const sol = bundledModelOrThrow("openai-codex", "gpt-5.6-sol");
		const { calls, streamFn } = recordingStreamFn(selector =>
			selector === "openai-codex/gpt-5.6-luna"
				? errorStream(luna, "rate limit exceeded retry-after-ms=60000")
				: completedStream(sol, "Recovered on fallback"),
		);
		const session = await createSession({
			model: luna,
			streamFn,
			settings: tierSettings({
				modelOverrides: {
					"openai-codex/gpt-5.6-luna:high": "priority",
					"openai-codex/gpt-5.6-sol:high": "flex",
				},
				retryFallbackChain: ["openai-codex/gpt-5.6-sol"],
				defaultRole: "openai-codex/gpt-5.6-luna",
			}),
		});

		await session.prompt("Recover from rate limits");

		expect(session.model?.id).toBe(sol.id);
		expect(calls[0]).toMatchObject({ selector: "openai-codex/gpt-5.6-luna", serviceTier: "priority" });
		const solCalls = calls.filter(entry => entry.selector === "openai-codex/gpt-5.6-sol");
		expect(solCalls.length).toBeGreaterThan(0);
		for (const call of solCalls) {
			expect(call.serviceTier).toBe("flex");
		}
	});

	it("keeps a config-only session free of synthetic manual tier entries across a resume", async () => {
		const opus = bundledModelOrThrow("anthropic", "claude-opus-4-7");
		const { calls, streamFn } = recordingStreamFn(() => completedStream(opus, "ok"));
		const session = await createSession({
			model: opus,
			streamFn,
			persisted: true,
			settings: tierSettings({ configuredTier: { anthropic: "priority" } }),
		});

		await session.prompt("Implement a focused parser fix");
		expect(calls[0]?.serviceTier).toBe("priority");
		expect(tierEntries(session)).toHaveLength(0);

		const sessionFile = session.sessionFile;
		expect(sessionFile).toBeDefined();
		await session.sessionManager.flush();
		expect(await session.switchSession(sessionFile!)).toBe(true);
		expect(tierEntries(session)).toHaveLength(0);

		await session.prompt("Follow-up turn after resume");
		expect(calls.at(-1)?.serviceTier).toBe("priority");
	});

	it("suppresses a matching model rule after a resumed explicit off and restores it when cleared", async () => {
		const opus = bundledModelOrThrow("anthropic", "claude-opus-4-7");
		const { calls, streamFn } = recordingStreamFn(() => completedStream(opus, "ok"));
		const session = await createSession({
			model: opus,
			streamFn,
			persisted: true,
			settings: tierSettings({ modelOverrides: { "anthropic/claude-opus-4-7:high": "priority" } }),
		});

		await session.prompt("Implement a focused parser fix");
		expect(calls[0]?.serviceTier).toBe("priority");

		session.setFastMode(false);
		const sessionFile = session.sessionFile;
		expect(sessionFile).toBeDefined();
		await session.sessionManager.flush();
		expect(await session.switchSession(sessionFile!)).toBe(true);

		await session.prompt("Follow-up turn after resumed explicit off");
		expect(calls.at(-1)?.serviceTier).toBeUndefined();

		session.setServiceTierFamily("anthropic", undefined);
		await session.prompt("Follow-up turn after clear");
		expect(calls.at(-1)?.serviceTier).toBe("priority");
	});

	it("gives CLI-origin manual priority and explicit off precedence over a matching model rule", async () => {
		const luna = bundledModelOrThrow("openai-codex", "gpt-5.6-luna");
		const rule = { "openai-codex/gpt-5.6-luna:high": "priority" };

		const manualOn = recordingStreamFn(() => completedStream(luna, "ok"));
		const prioritySession = await createSession({
			model: luna,
			streamFn: manualOn.streamFn,
			settings: tierSettings({ modelOverrides: rule }),
			manualOverrides: { openai: "flex" },
		});
		await prioritySession.prompt("Implement a focused parser fix");
		expect(manualOn.calls[0]?.serviceTier).toBe("flex");
		await prioritySession.prompt("Second turn under the manual selection");
		expect(manualOn.calls[1]?.serviceTier).toBe("flex");

		const manualOff = recordingStreamFn(() => completedStream(luna, "ok"));
		const offSession = await createSession({
			model: luna,
			streamFn: manualOff.streamFn,
			settings: tierSettings({ modelOverrides: rule }),
			manualOverrides: { openai: null },
		});
		await offSession.prompt("Implement a focused parser fix");
		expect(manualOff.calls[0]?.serviceTier).toBeUndefined();
	});

	it("lets an extension clear surface the automatic rule again without writing synthetic entries", async () => {
		const luna = bundledModelOrThrow("openai-codex", "gpt-5.6-luna");
		const { calls, streamFn } = recordingStreamFn(() => completedStream(luna, "ok"));
		const session = await createSession({
			model: luna,
			streamFn,
			settings: tierSettings({ modelOverrides: { "openai-codex/gpt-5.6-luna:high": "priority" } }),
			manualOverrides: { openai: "flex" },
		});

		await session.prompt("Implement a focused parser fix");
		expect(calls[0]?.serviceTier).toBe("flex");

		// Extension hosts call setServiceTier(family, undefined) on the session.
		session.setServiceTierFamily("openai", undefined);
		await session.prompt("Follow-up turn after the extension clear");
		expect(calls.at(-1)?.serviceTier).toBe("priority");

		const entriesBefore = tierEntries(session).length;
		session.setServiceTierFamily("openai", undefined);
		expect(tierEntries(session)).toHaveLength(entriesBefore);
	});
});
