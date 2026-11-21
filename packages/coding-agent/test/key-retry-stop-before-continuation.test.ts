/**
 * A stop that comes after a key retry's backoff ended but before its continuation started. A
 * stop during the backoff cancels the retry; a stop in this window does the same, and the
 * request the user cancelled never goes out.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { scheduler } from "node:timers/promises";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { streamSimple } from "@oh-my-pi/pi-ai";
import { unregisterCustomApis } from "@oh-my-pi/pi-ai/api-registry";
import * as envApiKey from "@oh-my-pi/pi-ai/env-api-key";
import { createMockModel, registerMockApi } from "@oh-my-pi/pi-ai/providers/mock";
import { closeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { __resetDirsFromEnvForTests, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";
import { restoreEnvValue } from "./helpers/settings-test-state";

const MOCK_API_SOURCE = "key-retry-stop-before-continuation-test";
const SESSION_ID = "stop-before-retry-session";
const ENV_KEYS = ["HOME", "PI_CODING_AGENT_DIR", "OMP_PROFILE", "PI_PROFILE"] as const;
let savedEnv: Record<string, string | undefined> = {};
let root: TempDir;
const cleanups: Array<() => unknown> = [];

beforeEach(async () => {
	savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
	root = TempDir.createSync("@pi-key-retry-stop-before-continuation-");
	const home = root.join("home");
	await fs.mkdir(path.join(home, "work"), { recursive: true });
	restoreEnvValue("HOME", home);
	vi.spyOn(os, "homedir").mockReturnValue(home);
	setAgentDir(path.join(home, ".omp", "agent"));
	AgentRegistry.resetGlobalForTests();
	AgentLifecycleManager.resetGlobalForTests();
	vi.spyOn(envApiKey, "getEnvApiKey").mockReturnValue(undefined);
	registerMockApi(MOCK_API_SOURCE);
});

afterEach(async () => {
	for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
	AgentLifecycleManager.resetGlobalForTests();
	AgentRegistry.resetGlobalForTests();
	unregisterCustomApis(MOCK_API_SOURCE);
	vi.restoreAllMocks();
	for (const key of ENV_KEYS) restoreEnvValue(key, savedEnv[key]);
	__resetDirsFromEnvForTests();
	AgentStorage.close();
	closeModelCache();
	root.removeSync();
});

/**
 * A session whose only anthropic login a failed refresh disabled, so its turn fails on the key
 * and retries. Every wait passes at once but the first 1 ms wait after the retry is announced:
 * the delay its continuation is scheduled with, which the test holds (`window`) until released or
 * aborted.
 */
async function openStrandedSession(options: { abortAtContinuationStart?: boolean } = {}) {
	const authStorage = await AuthStorage.create(root.join("auth.db"), { usageProviderResolver: () => undefined });
	cleanups.push(() => authStorage.close());
	await authStorage.credentials.set("anthropic", [
		{ type: "oauth", access: "access-a", refresh: "refresh-a", expires: Date.now() + 3_600_000, accountId: "a" },
	]);
	const [login] = authStorage.oauth.accounts("anthropic");
	await authStorage.credentials.disable(
		login!.credentialId,
		'oauth refresh failed: HTTP 400 {"error":"invalid_grant"}',
	);
	const modelRegistry = new ModelRegistry(authStorage, root.join("models.yml"));
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("bundled anthropic model missing");
	const mock = createMockModel({ id: model.id, provider: model.provider, handler: () => ({ content: ["done"] }) });
	const agent = new Agent({
		getApiKey: async requestModel => modelRegistry.turnResolver(requestModel, SESSION_ID),
		sessionId: SESSION_ID,
		initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
		streamFn: (_requestModel, context, options) => streamSimple(mock.model, context, options),
	});
	const settings = Settings.isolated({
		"compaction.enabled": false,
		"retry.baseDelayMs": 40,
		"retry.maxRetries": 3,
		"retry.modelFallback": false,
	});
	settings.setModelRole("default", `${model.provider}/${model.id}`);
	const sessionManager = SessionManager.create(root.join("home", "work"), root.join("sessions"));
	const session = new AgentSession({ agent, sessionManager, settings, modelRegistry, providerSessionId: SESSION_ID });
	if (options.abortAtContinuationStart) {
		// Esc lands as the continuation starts its run, after every scheduling check passed.
		session.setIrcWakeTurnObserver(() => {
			session.abortRetry();
			return undefined;
		});
	}
	cleanups.push(() => session.dispose());
	const retries: Array<{ type: string; finalError?: string }> = [];
	const secondRetry = Promise.withResolvers<void>();
	session.subscribe(event => {
		if (event.type === "auto_retry_start" || event.type === "auto_retry_end") {
			retries.push({ type: event.type, finalError: "finalError" in event ? event.finalError : undefined });
		}
		if (retries.filter(entry => entry.type === "auto_retry_start").length === 2) secondRetry.resolve();
	});
	const window = Promise.withResolvers<void>();
	const release = Promise.withResolvers<void>();
	let held = false;
	vi.spyOn(scheduler, "wait").mockImplementation(async (delayMs, options) => {
		options?.signal?.throwIfAborted();
		if (held || delayMs !== 1 || !retries.some(event => event.type === "auto_retry_start")) return;
		held = true;
		window.resolve();
		const aborted = Promise.withResolvers<void>();
		options?.signal?.addEventListener("abort", () => aborted.reject(options.signal?.reason), { once: true });
		await Promise.race([release.promise, aborted.promise]);
	});
	return {
		session,
		mock,
		retries,
		window: window.promise,
		secondRetry: secondRetry.promise,
		release: () => release.resolve(),
	};
}

describe("a stop after a key retry's backoff, before its continuation started", () => {
	it("control: the held wait is the retry's continuation, which runs the retry once released", async () => {
		const stranded = await openStrandedSession();
		const prompt = stranded.session.prompt("go");
		await stranded.window;
		stranded.release();
		// The continued turn fails on the key again, and the next retry is announced; stop it so the prompt settles.
		await stranded.secondRetry;
		await stranded.session.abort();
		await prompt.catch(() => undefined);
		expect(stranded.retries.filter(event => event.type === "auto_retry_start").length).toBeGreaterThanOrEqual(2);
	}, 30_000);

	const stops = {
		"the user's stop (an abort)": (session: AgentSession) => session.abort(),
		"Esc (abortRetry)": (session: AgentSession) => session.abortRetry(),
	};
	for (const [name, stop] of Object.entries(stops)) {
		it(`${name} cancels the retry, and its request never goes out`, async () => {
			// If this regresses, the stop finds no retry to cancel, and the retried request the user stopped is sent.
			const stranded = await openStrandedSession();
			const prompt = stranded.session.prompt("go");
			await stranded.window;
			await stop(stranded.session);
			stranded.release();
			await prompt.catch(() => undefined);
			await stranded.session.waitForIdle();
			const retryStarts = stranded.retries.filter(event => event.type === "auto_retry_start").length;
			expect(retryStarts).toBe(1);
			expect(stranded.retries.at(-1)).toEqual({ type: "auto_retry_end", finalError: "Retry cancelled" });
			expect(stranded.mock.calls).toHaveLength(0);
		}, 30_000);
	}

	it("an Esc as the continuation starts, after its scheduling checks passed, cancels the retry before it sends", async () => {
		// If this regresses, the retry's own gate is not checked again at the last boundary before `agent.continue()`,
		// and the request the user cancelled goes out.
		const stranded = await openStrandedSession({ abortAtContinuationStart: true });
		const prompt = stranded.session.prompt("go");
		await stranded.window;
		stranded.release();
		await prompt.catch(() => undefined);
		await stranded.session.waitForIdle();

		expect(stranded.retries.filter(event => event.type === "auto_retry_start")).toHaveLength(1);
		expect(stranded.retries.at(-1)).toEqual({ type: "auto_retry_end", finalError: "Retry cancelled" });
		expect(stranded.mock.calls).toHaveLength(0);
	}, 30_000);
});

describe("the retry's last check before agent.continue() leaves other continuations alone", () => {
	it("runs a steer queued on an idle session", async () => {
		// If this regresses, the check before `agent.continue()` runs the queued-message drain's own predicate after
		// this continuation raised the session's in-flight count: the predicate reads the session as streaming, the
		// drain skips and reschedules itself on microtasks without end, and the steer never reaches the model.
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("bundled anthropic model missing");
		const steered: string[] = [];
		const mock = createMockModel({
			id: model.id,
			provider: model.provider,
			handler: context => {
				const last = context.messages.at(-1);
				if (last?.role === "user") {
					steered.push(
						typeof last.content === "string"
							? last.content
							: last.content.map(part => (part.type === "text" ? part.text : "")).join(""),
					);
				}
				return { content: ["steered"] };
			},
		});
		const authStorage = await AuthStorage.create(root.join("idle-auth.db"), {
			usageProviderResolver: () => undefined,
		});
		cleanups.push(() => authStorage.close());
		authStorage.keys.setRuntime("anthropic", "test-key");
		const agent = new Agent({
			getApiKey: async () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: (_requestModel, context, options) => streamSimple(mock.model, context, options),
		});
		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(root.join("home", "work")),
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry: new ModelRegistry(authStorage, root.join("idle-models.yml")),
		});
		cleanups.push(() => session.dispose());

		await session.steer("steer me please");
		await session.waitForIdle();

		expect(steered).toEqual(["steer me please"]);
	}, 30_000);
});
