import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import * as envApiKey from "@oh-my-pi/pi-ai/env-api-key";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession, type AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { mockSchedulerWaitWithClock } from "./helpers/mock-scheduler-clock";

// The exact body LithosAI answers for an account with no credit left. It is a
// 402 `insufficient_quota`, so the retry classifier files it under UsageLimit
// and the QUOTA_EXHAUSTED heuristic asks for a 30-minute wait.
const OUT_OF_CREDIT =
	"402 the organization is out of credit, add more to continue (type=insufficient_quota param=insufficient_quota)";

type RetryEndEvent = Extract<AgentSessionEvent, { type: "auto_retry_end" }>;

describe("AgentSession out-of-credit handling", () => {
	let tempDir: TempDir;
	let fixtureDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let sessions: AgentSession[];

	beforeAll(async () => {
		fixtureDir = TempDir.createSync("@pi-out-of-credit-fixture-");
		authStorage = await AuthStorage.create(path.join(fixtureDir.path(), "testauth.db"));
		modelRegistry = new ModelRegistry(authStorage, path.join(fixtureDir.path(), "models.yml"));
	});

	beforeEach(() => {
		tempDir = TempDir.createSync("@pi-out-of-credit-");
		vi.spyOn(envApiKey, "getEnvApiKey").mockReturnValue(undefined);
		authStorage.keys.removeRuntime("anthropic");
		sessions = [];
	});

	afterEach(async () => {
		for (const activeSession of sessions.splice(0).reverse()) await activeSession.dispose();
		tempDir.removeSync();
		vi.restoreAllMocks();
	});

	/**
	 * A session whose first request fails with `failure` and whose later ones
	 * answer. `retry.maxDelayMs` is left at the ceiling a user raises to wait
	 * out long quota windows, which is what let the 30-minute quota heuristic
	 * sleep through an empty balance.
	 */
	async function createSession(failure: string): Promise<{
		session: AgentSession;
		sessionManager: SessionManager;
		calls: () => number;
		retryEndEvents: RetryEndEvent[];
	}> {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled Anthropic test model to exist");
		authStorage.keys.setRuntime("anthropic", "anthropic-test-key");

		const mock = createMockModel({
			responses: [{ throw: failure }, { content: ["answered after top-up"], stopReason: "stop" }],
		});
		const agent = new Agent({
			getApiKey: () => "anthropic-test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			streamFn: mock.stream,
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 5,
			"retry.maxDelayMs": 1_800_000,
			"retry.maxRetries": 2,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);
		const sessionManager = SessionManager.create(tempDir.path(), path.join(tempDir.path(), "sessions"));
		const session = new AgentSession({ agent, sessionManager, settings, modelRegistry });
		sessions.push(session);

		const retryEndEvents: RetryEndEvent[] = [];
		session.subscribe(event => {
			if (event.type === "auto_retry_end") retryEndEvents.push(event);
		});

		return { session, sessionManager, calls: () => mock.calls.length, retryEndEvents };
	}

	it("surfaces an out-of-credit balance instead of sleeping the quota heuristic", async () => {
		const { session, sessionManager, calls, retryEndEvents } = await createSession(OUT_OF_CREDIT);

		// No `scheduler.wait` is mocked here on purpose: the failure this pins was
		// a real sleep, so a regression has to time out rather than pass silently.
		await session.prompt("hello");
		await session.waitForIdle();

		expect(calls()).toBe(1);
		expect(session.isRetrying).toBe(false);
		expect(retryEndEvents).toHaveLength(1);
		expect(retryEndEvents[0]).toMatchObject({ success: false });
		// The user acts on the provider's own message, not the cap arithmetic.
		expect(retryEndEvents[0]?.finalError).toBe(OUT_OF_CREDIT);

		const assistant = sessionManager
			.getEntries()
			.flatMap(entry => (entry.type === "message" && entry.message.role === "assistant" ? [entry.message] : []));
		expect(assistant).toHaveLength(1);
		expect(assistant[0]).toMatchObject({ stopReason: "error" });
		// A surfaced error is never marked as a recovered retry: the empty
		// balance was fixed by the user, not by an attempt omp made.
		expect(assistant[0]?.retryRecovery).toBeUndefined();

		// Topped up: the error frame's Retry re-attempts immediately.
		expect(await session.retry()).toBe(true);
		await session.waitForIdle();
		expect(calls()).toBe(2);
		expect(session.agent.state.messages.at(-1)).toMatchObject({
			role: "assistant",
			stopReason: "stop",
			content: [{ type: "text", text: "answered after top-up" }],
		});
	});

	it("still retries a transient rate limit within the delay cap", async () => {
		const { session, calls, retryEndEvents } = await createSession(
			"429 Too Many Requests: rate limit exceeded, please retry shortly",
		);
		// The transient lane backs off for its own 30-second guess; the clock is
		// mocked here so the test exercises the retry, not the sleep.
		mockSchedulerWaitWithClock();

		await session.prompt("hello");
		await session.waitForIdle();

		expect(calls()).toBe(2);
		expect(retryEndEvents).toHaveLength(1);
		expect(retryEndEvents[0]).toMatchObject({ success: true, attempt: 1 });
	});
});
