import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Model } from "@oh-my-pi/pi-ai";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { SecretObfuscator } from "@oh-my-pi/pi-coding-agent/secrets";
import { AgentSession, type AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { CacheWarmer } from "@oh-my-pi/pi-coding-agent/session/cache-warmer";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

import { cfgCompactionEnabled } from "@oh-my-pi/pi-coding-agent/session/context-settings";
import {
	cfgProvidersCacheRetention,
	cfgProvidersCacheWarming,
	cfgRetryEnabled,
} from "@oh-my-pi/pi-coding-agent/session/settings";

function makeConverseModel(): Model {
	return buildModel({
		id: "us.anthropic.claude-opus-5-5",
		name: "Claude Opus 5.5",
		api: "bedrock-converse-stream",
		provider: "amazon-bedrock",
		baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
		reasoning: false,
		input: ["text"],
		cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
		promptCache: { short: 300, long: 3600 },
		contextWindow: 200_000,
		maxTokens: 8_192,
		compat: {
			promptCacheMode: "explicit",
			supportsLongPromptCacheRetention: true,
			promptCacheMinimumTokens: 0,
			promptCacheMaximumCheckpoints: 2,
		},
	});
}

/**
 * Regression guard for #11431: `set_auto_compaction`/`set_auto_retry` (which drive
 * `AgentSession.setAutoCompactionEnabled`/`setAutoRetryEnabled`) must configure only
 * the calling session by default, never write the machine-global `config.yml`. The
 * explicit `persist` flag — used by the TUI settings panel — is the only path that
 * mutates durable global state.
 */
describe("AgentSession auto-maintenance controls and cache-warming retention", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let settings: Settings;
	let session: AgentSession;
	let configPath: string;
	let warmer: CacheWarmer;
	let model: Model;
	let refreshCount: number;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-auto-scope-");
		const agentDir = tempDir.path();
		configPath = path.join(agentDir, "config.yml");

		authStorage = await AuthStorage.create(path.join(agentDir, "auth.db"));
		authStorage.keys.setRuntime("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage);

		model = { ...getBundledModel("anthropic", "claude-sonnet-4-5"), promptCache: { short: 11 } } as Model;
		settings = await Settings.loadIsolated({ agentDir, cwd: agentDir });
		refreshCount = 0;
		warmer = new CacheWarmer({
			getMode: () => cfgProvidersCacheWarming.get(settings),
			getPromptTokens: () => 100_000,
			stream: () => {
				refreshCount++;
				const message: AssistantMessage = {
					role: "assistant",
					content: [],
					api: model.api,
					provider: model.provider,
					model: model.id,
					stopReason: "stop",
					timestamp: Date.now(),
					usage: {
						input: 1,
						output: 0,
						cacheRead: 100_000,
						cacheWrite: 0,
						totalTokens: 100_001,
						cost: { input: 0.000003, output: 0, cacheRead: 0.03, cacheWrite: 0, total: 0.030003 },
					},
				};
				return {
					async *[Symbol.asyncIterator]() {
						yield { type: "done" as const, reason: "stop" as const, message };
					},
					result: () => Promise.resolve(message),
				};
			},
		});

		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
			sessionManager: SessionManager.create(agentDir, agentDir),
			settings,
			cacheWarmer: warmer,
			modelRegistry,
			obfuscator: new SecretObfuscator([]),
		});
	});

	afterEach(async () => {
		warmer.cancel();
		vi.useRealTimers();
		authStorage.close();
		try {
			await tempDir.remove();
		} catch {}
	});

	it("applies the change in-session without persisting to global config.yml", async () => {
		session.setAutoCompactionEnabled(false);
		session.setAutoRetryEnabled(false);
		session.setCacheWarmingMode("off");
		await settings.flush();

		// Value is live for this session.
		expect(cfgCompactionEnabled.get(settings)).toBe(false);
		expect(cfgRetryEnabled.get(settings)).toBe(false);
		expect(cfgProvidersCacheWarming.get(settings)).toBe("off");

		// ...but it never touched the persisted global layer or disk.
		expect(settings.getGlobalSettings()).toEqual({});
		expect(await Bun.file(configPath).exists()).toBe(false);
	});

	it("persists to global config.yml when persist=true (settings panel path)", async () => {
		session.setAutoCompactionEnabled(false);
		session.setAutoRetryEnabled(false);
		session.setAutoCompactionEnabled(true, true);
		session.setAutoRetryEnabled(true, true);
		await settings.flush();

		expect(cfgCompactionEnabled.get(settings)).toBe(true);
		expect(cfgRetryEnabled.get(settings)).toBe(true);
		expect(settings.getGlobalSettings()).toMatchObject({
			compaction: { enabled: true },
			retry: { enabled: true },
		});
		const onDisk = await Bun.file(configPath).text();
		expect(onDisk).toContain("enabled: true");
	});

	it("schedules Converse warming from configured long retention", () => {
		vi.useFakeTimers();
		model = makeConverseModel();
		session.agent.setModel(model);
		cfgProvidersCacheRetention.override(settings, "long");

		session.startCacheWarming(model, { messages: [] }, {});

		expect(warmer.status.state).toBe("scheduled");
		expect(warmer.status.nextWarmAt! - Date.now()).toBe(54 * 60_000);
	});

	it("does not replay requests when retention is configured as none", async () => {
		vi.useFakeTimers();
		model = makeConverseModel();
		session.agent.setModel(model);
		cfgProvidersCacheRetention.override(settings, "none");

		session.startCacheWarming(model, { messages: [] }, {});
		expect(warmer.status).toMatchObject({ state: "inactive", reason: "request disabled prompt caching" });

		vi.advanceTimersByTime(60 * 60_000);
		await Promise.resolve();
		expect(refreshCount).toBe(0);
	});

	it("lets explicit per-request short retention override the long setting", () => {
		vi.useFakeTimers();
		model = makeConverseModel();
		session.agent.setModel(model);
		cfgProvidersCacheRetention.override(settings, "long");

		session.startCacheWarming(model, { messages: [] }, { cacheRetention: "short" });

		expect(warmer.status.state).toBe("scheduled");
		expect(warmer.status.nextWarmAt! - Date.now()).toBe(4.5 * 60_000);
	});

	it("leaves auto retention unset so PI_CACHE_RETENTION remains authoritative", () => {
		const savedRetention = process.env.PI_CACHE_RETENTION;
		process.env.PI_CACHE_RETENTION = "long";
		try {
			vi.useFakeTimers();
			model = makeConverseModel();
			session.agent.setModel(model);
			cfgProvidersCacheRetention.override(settings, "auto");

			session.startCacheWarming(model, { messages: [] }, {});

			expect(warmer.status.state).toBe("scheduled");
			expect(warmer.status.nextWarmAt! - Date.now()).toBe(54 * 60_000);
		} finally {
			if (savedRetention === undefined) delete process.env.PI_CACHE_RETENTION;
			else process.env.PI_CACHE_RETENTION = savedRetention;
		}
	});

	it("disabling cache warming cancels the live timer through the settings override", async () => {
		vi.useFakeTimers();
		warmer.start({ model, context: { messages: [] }, options: { cacheRetention: "short" } }, () => true);
		session.setCacheWarmingMode("off");
		expect(warmer.status).toMatchObject({ state: "inactive", reason: "cache warming disabled" });
		vi.advanceTimersByTime(2_000);
		for (let i = 0; i < 100; i++) await Promise.resolve();
		expect(refreshCount).toBe(0);
	});

	it("emits the persisted cache-warm usage so event consumers can reconcile session costs", async () => {
		vi.useFakeTimers();
		const events: AgentSessionEvent[] = [];
		session.subscribe(event => events.push(event));
		warmer.start({ model, context: { messages: [] }, options: { cacheRetention: "short" } }, () => true);
		vi.advanceTimersByTime(1_000);
		for (let i = 0; i < 100; i++) await Promise.resolve();
		const entries = session.sessionManager.getEntries().filter(entry => entry.type === "model_usage");
		expect(entries).toHaveLength(1);
		expect(entries[0]?.purpose).toBe("cache-warm");
		expect(events).toEqual([
			{ type: "cache_warming_start", phase: "streaming", provider: model.provider, model: model.id },
			{
				type: "cache_warming_end",
				phase: "streaming",
				provider: model.provider,
				model: model.id,
				outcome: "hit",
				usage: entries[0]?.usage,
			},
		]);
	});
});
