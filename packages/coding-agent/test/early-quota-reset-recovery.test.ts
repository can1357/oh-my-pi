import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { Model, UsageProvider, UsageReport } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { initTheme } from "@oh-my-pi/pi-tui/theme";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

type ScriptedReport = { status: "exhausted" | "healthy"; fetchedAt?: number };

const scriptedReports: Record<string, ScriptedReport | undefined> = {};
const usageFetches: Array<{ provider: string; fetchedAt: number }> = [];
let fetchGate: { promise: Promise<void>; open: () => void; started: () => void } | undefined;

function exhausted(status: ScriptedReport["status"]): boolean {
	return status === "exhausted";
}

function claudeReport(scripted: ScriptedReport): UsageReport {
	const amount = { usedFraction: exhausted(scripted.status) ? 1 : 0.1, unit: "percent" as const };
	const status = exhausted(scripted.status) ? ("exhausted" as const) : ("ok" as const);
	const limit = (id: string, windowId: string, label: string): UsageReport["limits"][number] => ({
		id,
		label,
		scope: { provider: "anthropic", shared: true, windowId },
		window: { id: windowId, label },
		amount,
		status,
	});
	return {
		provider: "anthropic",
		fetchedAt: scripted.fetchedAt ?? Date.now(),
		limits: [limit("anthropic:5h", "5h", "5 Hour"), limit("anthropic:7d", "7d", "7 Day")],
	};
}

function codexReport(scripted: ScriptedReport): UsageReport {
	const amount = { usedFraction: exhausted(scripted.status) ? 1 : 0.1, unit: "percent" as const };
	const status = exhausted(scripted.status) ? ("exhausted" as const) : ("ok" as const);
	const limit = (id: string, windowId: string, label: string): UsageReport["limits"][number] => ({
		id,
		label,
		scope: { provider: "openai-codex", accountId: "acct-codex" },
		window: { id: windowId, label },
		amount,
		status,
	});
	return {
		provider: "openai-codex",
		fetchedAt: scripted.fetchedAt ?? Date.now(),
		limits: [limit("openai-codex:primary", "5h", "5 hours"), limit("openai-codex:secondary", "7d", "Weekly")],
		metadata: { allowed: !exhausted(scripted.status), limitReached: exhausted(scripted.status) },
	};
}

function scriptedUsageProvider(provider: string): UsageProvider {
	return {
		id: provider,
		fetchUsage: async () => {
			const scripted = scriptedReports[provider];
			const fetchedAt = scripted?.fetchedAt ?? Date.now();
			usageFetches.push({ provider, fetchedAt });
			if (fetchGate) {
				fetchGate.started();
				await fetchGate.promise;
			}
			if (!scripted) return null;
			return provider === "anthropic" ? claudeReport(scripted) : codexReport(scripted);
		},
	};
}

function useMockClock() {
	let now = Date.now();
	vi.spyOn(Date, "now").mockImplementation(() => now);
	return { now: () => now, advance: (ms: number) => (now += ms) };
}

interface TestEnv {
	registry: ModelRegistry;
	authStorage: AuthStorage;
	dir: TempDir;
}

async function createEnv(): Promise<TestEnv> {
	const dir = TempDir.createSync("@pi-quota-reset-");
	const authStorage = await AuthStorage.create(path.join(dir.path(), "auth.db"), {
		usageProviderResolver: provider =>
			provider === "anthropic" || provider === "openai-codex" ? scriptedUsageProvider(provider) : undefined,
	});
	await authStorage.credentials.set("anthropic", {
		type: "oauth",
		access: "access-claude",
		refresh: "refresh-claude",
		expires: Date.now() + 3_600_000,
		accountId: "acct-claude",
		email: "claude@example.com",
	});
	await authStorage.credentials.set("openai-codex", {
		type: "oauth",
		access: "access-codex",
		refresh: "refresh-codex",
		expires: Date.now() + 3_600_000,
		accountId: "acct-codex",
		email: "codex@example.com",
	});
	authStorage.keys.setRuntime("openai", "openai-test-key");
	const registry = new ModelRegistry(authStorage, path.join(dir.path(), "models.yml"));
	registry.registerProvider("openai-codex", {
		api: "openai-codex-responses",
		baseUrl: "https://codex.example.invalid",
		oauth: {
			name: "OpenAI Codex (early-quota-reset-recovery test)",
			login: async () => {
				throw new Error("oauth login not exercised by this test");
			},
		},
		models: [
			{
				id: "gpt-5.4-codex",
				name: "GPT 5.4 Codex",
				api: "openai-codex-responses",
				reasoning: true,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 272_000,
				maxTokens: 8_192,
			},
		],
	});
	return { registry, authStorage, dir };
}

const PRIMARY_SELECTOR = "anthropic/claude-sonnet-4-5";
const FALLBACK_SELECTOR = "openai/gpt-4o-mini";

async function startFallbackSession(
	env: TestEnv,
	primaryModel: Model,
	primaryFailure: string,
): Promise<{ session: AgentSession; requested: string[] }> {
	const requested: string[] = [];
	const primarySelector = `${primaryModel.provider}/${primaryModel.id}`;
	let primaryAttempts = 0;
	const mock = createMockModel();
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: {
			model: primaryModel,
			systemPrompt: ["Test"],
			tools: [],
			messages: [],
		},
		streamFn: (model, context, options) => {
			const selector = `${model.provider}/${model.id}`;
			requested.push(selector);
			if (selector === primarySelector && primaryAttempts++ === 0) {
				mock.push({ throw: primaryFailure });
			} else {
				mock.push({ content: [`ok:${selector}`] });
			}
			return mock.stream(model, context, options);
		},
	});
	const settings = Settings.isolated({
		"compaction.enabled": false,
		"retry.baseDelayMs": 5,
		"retry.maxRetries": 2,
		"retry.maxDelayMs": 1000,
		"retry.fallbackChains": { default: [FALLBACK_SELECTOR] },
	});
	settings.setModelRole("default", primarySelector);
	const session = new AgentSession({
		agent,
		sessionManager: SessionManager.inMemory(),
		settings,
		modelRegistry: env.registry,
	});
	return { session, requested };
}

describe("early quota reset recovery", () => {
	let env: TestEnv;

	beforeAll(async () => {
		await initTheme();
	});

	afterEach(async () => {
		scriptedReports.anthropic = undefined;
		scriptedReports["openai-codex"] = undefined;
		usageFetches.length = 0;
		fetchGate = undefined;
		if (env) {
			env.registry.unregisterProvider("openai-codex");
			env.authStorage.close();
			env.dir.removeSync();
		}
		vi.restoreAllMocks();
	});

	it("returns an Anthropic session to its primary when fresh usage evidence shows the quota recovered", async () => {
		env = await createEnv();
		const primaryModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!primaryModel) throw new Error("Expected bundled anthropic test model");
		const clock = useMockClock();
		scriptedReports.anthropic = { status: "exhausted" };
		const { session, requested } = await startFallbackSession(
			env,
			primaryModel,
			"usage limit exceeded retry-after-ms=1800000",
		);

		await session.prompt("Hit the quota wall");
		await session.waitForIdle();
		expect(requested).toEqual([PRIMARY_SELECTOR, FALLBACK_SELECTOR]);
		expect(env.registry.isSelectorSuppressed(PRIMARY_SELECTOR)).toBe(true);

		scriptedReports.anthropic = { status: "healthy" };
		clock.advance(100);
		await session.prompt("Quota was reset on the web");
		await session.waitForIdle();
		expect(requested).toEqual([PRIMARY_SELECTOR, FALLBACK_SELECTOR, FALLBACK_SELECTOR]);
		expect(env.registry.isSelectorSuppressed(PRIMARY_SELECTOR)).toBe(true);

		clock.advance(7 * 60_000);
		expect(env.registry.isSelectorSuppressed(PRIMARY_SELECTOR)).toBe(true);
		await session.prompt("Recovered quota serves the primary again");
		await session.waitForIdle();

		expect(requested).toEqual([PRIMARY_SELECTOR, FALLBACK_SELECTOR, FALLBACK_SELECTOR, PRIMARY_SELECTOR]);
		expect(`${session.model?.provider}/${session.model?.id}`).toBe(PRIMARY_SELECTOR);
		expect(env.registry.isSelectorSuppressed(PRIMARY_SELECTOR)).toBe(false);
		await session.dispose();
	});

	it("keeps the Anthropic cooldown when the only usage evidence predates the failure", async () => {
		env = await createEnv();
		const primaryModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!primaryModel) throw new Error("Expected bundled anthropic test model");
		const clock = useMockClock();
		scriptedReports.anthropic = { status: "exhausted" };
		const { session, requested } = await startFallbackSession(env, primaryModel, "usage limit exceeded");

		await session.prompt("Hit the quota wall");
		await session.waitForIdle();

		const failureFetchedAt = usageFetches.findLast(fetch => fetch.provider === "anthropic")?.fetchedAt;
		expect(failureFetchedAt).toBeDefined();
		scriptedReports.anthropic = { status: "healthy", fetchedAt: failureFetchedAt };
		clock.advance(5 * 60_000 + 2_000);
		await session.prompt("Stale snapshot only");
		await session.waitForIdle();

		expect(requested).toEqual([PRIMARY_SELECTOR, FALLBACK_SELECTOR, FALLBACK_SELECTOR]);
		expect(`${session.model?.provider}/${session.model?.id}`).toBe(FALLBACK_SELECTOR);
		expect(env.registry.isSelectorSuppressed(PRIMARY_SELECTOR)).toBe(true);
		await session.dispose();
	});

	it("never probes usage health for a generic rate-limit cooldown and restores it by clock expiry", async () => {
		env = await createEnv();
		const primaryModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!primaryModel) throw new Error("Expected bundled anthropic test model");
		const clock = useMockClock();
		const { session, requested } = await startFallbackSession(
			env,
			primaryModel,
			"rate limit exceeded retry-after-ms=60000",
		);

		await session.prompt("Generic rate limit");
		await session.waitForIdle();
		expect(requested).toEqual([PRIMARY_SELECTOR, FALLBACK_SELECTOR]);
		expect(env.registry.isSelectorSuppressed(PRIMARY_SELECTOR)).toBe(true);

		scriptedReports.anthropic = { status: "healthy" };
		await session.prompt("Healthy evidence exists but this cooldown is not quota-scoped");
		await session.waitForIdle();
		expect(requested).toEqual([PRIMARY_SELECTOR, FALLBACK_SELECTOR, FALLBACK_SELECTOR]);
		expect(usageFetches).toEqual([]);

		clock.advance(61_000);
		await session.prompt("Cooldown expired by clock");
		await session.waitForIdle();
		expect(requested).toEqual([PRIMARY_SELECTOR, FALLBACK_SELECTOR, FALLBACK_SELECTOR, PRIMARY_SELECTOR]);
		await session.dispose();
	});

	it("returns a Codex session to its primary when fresh usage evidence shows the quota recovered", async () => {
		env = await createEnv();
		const codexModel = env.registry.find("openai-codex", "gpt-5.4-codex");
		if (!codexModel) throw new Error("Expected registered codex test model");
		const codexSelector = `${codexModel.provider}/${codexModel.id}`;
		const clock = useMockClock();
		scriptedReports["openai-codex"] = { status: "exhausted" };
		const { session, requested } = await startFallbackSession(
			env,
			codexModel,
			"usage_limit_reached retry-after-ms=1800000",
		);

		await session.prompt("Hit the Codex quota wall");
		await session.waitForIdle();
		expect(requested).toEqual([codexSelector, FALLBACK_SELECTOR]);
		expect(env.registry.isSelectorSuppressed(codexSelector)).toBe(true);

		scriptedReports["openai-codex"] = { status: "healthy" };
		clock.advance(100);
		await session.prompt("Codex quota was reset on the web");
		await session.waitForIdle();
		expect(requested).toEqual([codexSelector, FALLBACK_SELECTOR, FALLBACK_SELECTOR]);
		expect(env.registry.isSelectorSuppressed(codexSelector)).toBe(true);

		clock.advance(7 * 60_000);
		expect(env.registry.isSelectorSuppressed(codexSelector)).toBe(true);
		await session.prompt("Recovered Codex quota serves the primary again");
		await session.waitForIdle();

		expect(requested).toEqual([codexSelector, FALLBACK_SELECTOR, FALLBACK_SELECTOR, codexSelector]);
		expect(`${session.model?.provider}/${session.model?.id}`).toBe(codexSelector);
		expect(env.registry.isSelectorSuppressed(codexSelector)).toBe(false);
		await session.dispose();
	});

	it("preserves an explicit model selection made while quota recovery is pending", async () => {
		env = await createEnv();
		const primary = getBundledModel("anthropic", "claude-sonnet-4-5");
		const fallback = getBundledModel("openai", "gpt-4o-mini");
		if (!primary || !fallback) throw new Error("Expected bundled test models");
		const clock = useMockClock();
		scriptedReports.anthropic = { status: "exhausted" };
		const { session, requested } = await startFallbackSession(
			env,
			primary,
			"usage limit exceeded retry-after-ms=1800000",
		);
		await session.prompt("Hit the quota wall");
		await session.waitForIdle();
		scriptedReports.anthropic = { status: "healthy" };
		clock.advance(7 * 60_000);
		const released = Promise.withResolvers<void>();
		const started = Promise.withResolvers<void>();
		fetchGate = { promise: released.promise, open: () => released.resolve(), started: () => started.resolve() };
		const pending = session.prompt("Probe the recovered quota");
		try {
			await started.promise;
			await session.setModel(fallback, "default", { persist: false });
		} finally {
			released.resolve();
		}
		await pending;
		await session.waitForIdle();
		expect(requested).toEqual([PRIMARY_SELECTOR, FALLBACK_SELECTOR, FALLBACK_SELECTOR]);
		expect(session.model?.provider).toBe("openai");
		await session.dispose();
	});

	it("retires only a healthy-evidenced quota suppression and preserves it otherwise", async () => {
		env = await createEnv();
		const { registry } = env;
		const options = { sessionId: "session-a", reserveFraction: 0.1 };
		const clock = useMockClock();
		const failureTime = clock.now();

		registry.suppressSelector(PRIMARY_SELECTOR, clock.now() + 30 * 60_000, failureTime);

		scriptedReports.anthropic = { status: "exhausted" };
		expect(await registry.isSelectorSuppressedWithRecovery(PRIMARY_SELECTOR, options)).toBe(true);
		expect(registry.isSelectorSuppressed(PRIMARY_SELECTOR)).toBe(true);

		scriptedReports.anthropic = { status: "healthy" };
		clock.advance(7 * 60_000);
		expect(await registry.isSelectorSuppressedWithRecovery(PRIMARY_SELECTOR, options)).toBe(false);
		expect(registry.isSelectorSuppressed(PRIMARY_SELECTOR)).toBe(false);

		registry.suppressSelector(PRIMARY_SELECTOR, clock.now() + 30 * 60_000, failureTime);
		scriptedReports.anthropic = { status: "healthy", fetchedAt: failureTime - 1 };
		clock.advance(7 * 60_000);
		expect(await registry.isSelectorSuppressedWithRecovery(PRIMARY_SELECTOR, options)).toBe(true);
		expect(registry.isSelectorSuppressed(PRIMARY_SELECTOR)).toBe(true);
	});

	it("keeps non-quota suppressions without consulting usage health", async () => {
		env = await createEnv();
		const { registry } = env;
		registry.suppressSelector(PRIMARY_SELECTOR, Date.now() + 60_000);
		scriptedReports.anthropic = { status: "healthy" };

		expect(
			await registry.isSelectorSuppressedWithRecovery(PRIMARY_SELECTOR, {
				sessionId: "session-a",
				reserveFraction: 0.1,
			}),
		).toBe(true);
		expect(registry.isSelectorSuppressed(PRIMARY_SELECTOR)).toBe(true);
		expect(usageFetches).toEqual([]);
	});

	it("preserves a newer concurrent suppression when recovery evidence lands in flight", async () => {
		env = await createEnv();
		const { registry } = env;
		const options = { sessionId: "session-a", reserveFraction: 0.1 };
		const clock = useMockClock();
		registry.suppressSelector(PRIMARY_SELECTOR, clock.now() + 30 * 60_000, clock.now());
		scriptedReports.anthropic = { status: "healthy" };
		const withResolvers = Promise.withResolvers<void>();
		const started = Promise.withResolvers<void>();
		fetchGate = {
			promise: withResolvers.promise,
			open: () => withResolvers.resolve(),
			started: () => started.resolve(),
		};
		const gate = fetchGate;

		const probe = registry.isSelectorSuppressedWithRecovery(PRIMARY_SELECTOR, options);
		await started.promise;
		clock.advance(1500);
		registry.suppressSelector(PRIMARY_SELECTOR, clock.now() + 10 * 60_000, clock.now());
		gate.open();

		expect(await probe).toBe(true);
		expect(registry.isSelectorSuppressed(PRIMARY_SELECTOR)).toBe(true);

		clock.advance(7 * 60_000);
		expect(await registry.isSelectorSuppressedWithRecovery(PRIMARY_SELECTOR, options)).toBe(false);
		expect(registry.isSelectorSuppressed(PRIMARY_SELECTOR)).toBe(false);
	});

	it("resolves concurrent probes independently so the peer of a retired suppression reports unsuppressed", async () => {
		env = await createEnv();
		const { registry } = env;
		const options = { sessionId: "session-a", reserveFraction: 0.1 };
		const clock = useMockClock();
		registry.suppressSelector(PRIMARY_SELECTOR, clock.now() + 30 * 60_000, clock.now());
		clock.advance(1500);
		scriptedReports.anthropic = { status: "healthy" };
		const released = Promise.withResolvers<void>();
		const started = Promise.withResolvers<void>();
		fetchGate = {
			promise: released.promise,
			open: () => released.resolve(),
			started: () => started.resolve(),
		};
		const gate = fetchGate;

		const first = registry.isSelectorSuppressedWithRecovery(PRIMARY_SELECTOR, options);
		const second = registry.isSelectorSuppressedWithRecovery(PRIMARY_SELECTOR, options);
		await started.promise;
		gate.open();

		expect(await first).toBe(false);
		expect(await second).toBe(false);
		expect(registry.isSelectorSuppressed(PRIMARY_SELECTOR)).toBe(false);
	});

	it("preserves the quota suppression when the recovery probe aborts", async () => {
		env = await createEnv();
		const { registry } = env;
		registry.suppressSelector(PRIMARY_SELECTOR, Date.now() + 30 * 60_000, Date.now());
		scriptedReports.anthropic = { status: "healthy" };
		const controller = new AbortController();
		controller.abort();

		expect(
			await registry.isSelectorSuppressedWithRecovery(PRIMARY_SELECTOR, {
				sessionId: "session-a",
				reserveFraction: 0.1,
				signal: controller.signal,
			}),
		).toBe(true);
		expect(registry.isSelectorSuppressed(PRIMARY_SELECTOR)).toBe(true);
	});
});
