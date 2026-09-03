/**
 * Contract: advisor asides queued for the primary's next model step must not
 * strand when no loop is left to poll the aside queue. At settle (the turn
 * ends with the aside still queued) and on a deliberate user interrupt, the
 * queued aside is re-recorded as a visible, persisted advisor card; the aside
 * queue is left empty and no extra model turn runs.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel, type MockModel, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { USER_INTERRUPT_LABEL } from "@oh-my-pi/pi-coding-agent/session/messages";
import { isAdvisorCard } from "@oh-my-pi/pi-coding-agent/session/queued-messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

const ADVISOR_TYPE = "advisor";

interface CompletedAdvisorHarness {
	session: AgentSession;
	sessionManager: SessionManager;
	mock: MockModel;
	advisorMock: MockModel;
}

interface ParkedAdvisorHarness {
	session: AgentSession;
	sessionManager: SessionManager;
	mock: MockModel;
	advisorMock: MockModel;
	/** Resolves the moment the first turn's model stream begins. */
	streamStarted: Promise<void>;
}

describe("AgentSession advisor next-step delivery", () => {
	let tempDir: TempDir;
	let session: AgentSession;
	const authStorages: AuthStorage[] = [];

	beforeAll(() => {
		tempDir = TempDir.createSync("@pi-advisor-next-step-");
	});

	afterEach(async () => {
		// dispose() aborts the agent, cancelling a parked first-turn stream.
		try {
			await session?.dispose();
		} finally {
			for (const authStorage of authStorages.splice(0)) authStorage.close();
		}
	});

	afterAll(async () => {
		await tempDir?.remove();
	});

	/**
	 * Single primary turn that answers with text. The advisor is enabled (its
	 * yield-queue kind registered) but scripted to emit nothing, so the only
	 * advisor traffic in a test is what the test itself enqueues.
	 */
	async function createCompletedAdvisorSession(): Promise<CompletedAdvisorHarness> {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const mock = createMockModel({
			responses: [{ content: ["EXACT VERDICT"], stopReason: "stop" }],
		});
		const advisorMock = createMockModel({ handler: () => ({ content: [], stopReason: "stop" }) });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			streamFn: mock.stream,
		});
		const sessionManager = SessionManager.inMemory();
		const settings = Settings.isolated({ "compaction.enabled": false, "retry.enabled": false });
		settings.setModelRole("advisor", "anthropic/claude-sonnet-4-5");
		const authStorage = await AuthStorage.create(":memory:");
		authStorages.push(authStorage);
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
		session = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry,
			advisorTools: [],
			advisorStreamFn: advisorMock.stream,
		});
		return { session, sessionManager, mock, advisorMock };
	}

	/**
	 * First turn parks open (a 60s mock delay that abort cancels) so the aside
	 * can be enqueued while the agent is genuinely streaming. `streamStarted`
	 * resolves from the mock handler, before the delay, so tests await the real
	 * stream-begin signal rather than a timer.
	 */
	async function createParkedAdvisorSession(tailResponses: MockResponse[] = []): Promise<ParkedAdvisorHarness> {
		const started = Promise.withResolvers<void>();
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const mock = createMockModel({
			responses: [
				() => {
					started.resolve();
					return { content: ["working"], delayMs: 60_000 };
				},
				...tailResponses,
			],
		});
		const advisorMock = createMockModel({ handler: () => ({ content: [], stopReason: "stop" }) });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			streamFn: mock.stream,
		});
		const sessionManager = SessionManager.inMemory();
		const settings = Settings.isolated({ "compaction.enabled": false, "retry.enabled": false });
		settings.setModelRole("advisor", "anthropic/claude-sonnet-4-5");
		const authStorage = await AuthStorage.create(":memory:");
		authStorages.push(authStorage);
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
		session = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry,
			advisorTools: [],
			advisorStreamFn: advisorMock.stream,
		});
		return { session, sessionManager, mock, advisorMock, streamStarted: started.promise };
	}

	/** Records the transcript content of every persisted advisor card. */
	function capturePersistedAdvisorCards(sessionManager: SessionManager): string[] {
		const persisted: string[] = [];
		sessionManager.onEntryAppended = entry => {
			if (entry.type === "custom_message" && entry.customType === ADVISOR_TYPE) {
				persisted.push(typeof entry.content === "string" ? entry.content : JSON.stringify(entry.content));
			}
		};
		return persisted;
	}

	it("preserves an advisor aside that missed the loop's last poll as a visible card at settle", async () => {
		const { session: harness, sessionManager, mock } = await createCompletedAdvisorSession();
		const persisted = capturePersistedAdvisorCards(sessionManager);

		expect(harness.setAdvisorEnabled(true)).toBe(true);
		// The aside lands via an agent_end listener: after the loop's final aside
		// poll, with no loop left to drain it, until the settle re-records it.
		const unsubscribe = harness.agent.subscribe(event => {
			if (event.type === "agent_end") {
				harness.yieldQueue.enqueue("advisor", { note: "late fixture note", severity: "concern" });
			}
		});
		try {
			await harness.prompt("answer with exactly one line");
			await harness.waitForIdle();
		} finally {
			unsubscribe();
		}

		expect(harness.agent.state.messages.filter(isAdvisorCard)).toHaveLength(1);
		expect(persisted).toHaveLength(1);
		expect(persisted[0]).toContain("late fixture note");
		expect(harness.yieldQueue.has("advisor")).toBe(false);
		// The aside is delivered without waking the primary: one model request.
		expect(mock.calls).toHaveLength(1);
	});

	it("preserves a queued advisor aside across a user interrupt as a visible card without resuming the run", async () => {
		const {
			session: harness,
			sessionManager,
			mock,
			streamStarted,
		} = await createParkedAdvisorSession([{ content: ["must not run"], stopReason: "stop" }]);
		const persisted = capturePersistedAdvisorCards(sessionManager);

		expect(harness.setAdvisorEnabled(true)).toBe(true);
		const running = harness.prompt("do the thing");
		await streamStarted;

		// The advisor queues an aside against the next model step; the user
		// interrupt skips the loop's remaining polls, stranding it while the
		// parked turn is still unwinding.
		harness.yieldQueue.enqueue("advisor", { note: "interrupted fixture note", severity: "concern" });

		await harness.abort({ reason: USER_INTERRUPT_LABEL });
		await harness.waitForIdle();
		await running.catch(() => {});

		expect(harness.agent.state.messages.filter(isAdvisorCard)).toHaveLength(1);
		expect(persisted).toHaveLength(1);
		expect(persisted[0]).toContain("interrupted fixture note");
		expect(harness.yieldQueue.has("advisor")).toBe(false);
		// The parked turn's tail response was never consumed: no resume ran.
		expect(mock.calls).toHaveLength(1);
	});
});
