/**
 * Contract: advisor asides queued for the primary's next model step must not
 * strand when no loop is left to poll the aside queue. At settle (the turn
 * ends with the aside still queued) and on a deliberate user interrupt, the
 * queued aside is re-recorded as a visible, persisted advisor card; the aside
 * queue is left empty and no extra model turn runs.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import type { ToolResultMessage } from "@oh-my-pi/pi-ai";
import { createMockModel, type MockModel, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import type { AdvisorMessageDetails } from "@oh-my-pi/pi-coding-agent/advisor/advise-tool";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm, USER_INTERRUPT_LABEL } from "@oh-my-pi/pi-coding-agent/session/messages";
import { isAdvisorCard } from "@oh-my-pi/pi-coding-agent/session/queued-messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

const ADVISOR_TYPE = "advisor";
/** The one concern the advisor raises against the first (mid-turn) delta. */
const MID_TURN_CONCERN = "the fixture edit looks incomplete; double-check the second step";

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

	/**
	 * The advisor only sees the primary through turn-end deltas, so a concern it
	 * raises while the primary is mid-turn can only travel as a YieldQueue aside:
	 * the primary script issues a tool call, then a second tool call the test
	 * holds open, then a final answer, and the advisor raises one concern
	 * against the first (in-progress) delta while that second tool call is parked.
	 */
	interface MidTurnConcernHarness {
		session: AgentSession;
		mock: MockModel;
		advisorMock: MockModel;
		/** Resolves with the held tool call's abort signal once that call starts. */
		heldToolStarted: Promise<AbortSignal>;
		/** Releases the held tool call. */
		releaseHeldTool: () => void;
	}

	async function createMidTurnConcernSession(): Promise<MidTurnConcernHarness> {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const stepCall = (input: string): MockResponse => ({
			content: [{ type: "toolCall", name: "fixture_step", arguments: { input } }],
		});
		const mock = createMockModel({
			responses: [stepCall("first"), stepCall("second"), { content: ["DONE"], stopReason: "stop" }],
		});
		const advisorMock = createMockModel({
			responses: [
				{
					// Small delay so the concern cannot race the loop's aside poll that
					// runs immediately after the first turn end; it must arrive while
					// the second tool call is in flight.
					delayMs: 5,
					content: [
						{ type: "toolCall", name: "advise", arguments: { note: MID_TURN_CONCERN, severity: "concern" } },
					],
				},
				{ content: [], stopReason: "stop" },
			],
			// Later deltas (second turn end, final answer) must not error the advisor.
			handler: () => ({ content: [], stopReason: "stop" }),
		});

		const fixtureStepParams = type({ input: "string" });
		let invocations = 0;
		const heldToolStarted = Promise.withResolvers<AbortSignal>();
		const gate = Promise.withResolvers<void>();
		const fixtureStep: AgentTool<typeof fixtureStepParams> = {
			name: "fixture_step",
			label: "Fixture Step",
			description: "Deterministic two-step test tool",
			parameters: fixtureStepParams,
			execute: async (_toolCallId, _params, signal) => {
				invocations++;
				if (invocations === 2) {
					if (!signal) throw new Error("expected the loop to pass an abort signal to the tool");
					heldToolStarted.resolve(signal);
					await gate.promise;
				}
				return { content: [{ type: "text", text: `step ${invocations} ran` }] };
			},
		};

		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [fixtureStep] },
			streamFn: mock.stream,
			// Production wires the session converter at the agent boundary
			// (sdk.ts); without it a bare test agent drops the custom advisor
			// card from the provider request instead of folding it in.
			convertToLlm,
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
		return {
			session,
			mock,
			advisorMock,
			heldToolStarted: heldToolStarted.promise,
			releaseHeldTool: () => gate.resolve(),
		};
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

	it("preserves a queued advisor aside when user-interrupt cleanup rejects", async () => {
		const { session: harness, sessionManager, streamStarted } = await createParkedAdvisorSession();
		const persisted = capturePersistedAdvisorCards(sessionManager);

		expect(harness.setAdvisorEnabled(true)).toBe(true);
		const running = harness.prompt("do the thing");
		await streamStarted;
		harness.yieldQueue.enqueue("advisor", { note: "cleanup rejection fixture note", severity: "concern" });

		vi.spyOn(harness.goalRuntime, "onTaskAborted").mockRejectedValueOnce(new Error("fixture cleanup rejected"));
		await expect(harness.abort({ reason: USER_INTERRUPT_LABEL })).rejects.toThrow("fixture cleanup rejected");
		await harness.waitForIdle();
		await running.catch(() => {});

		expect(harness.agent.state.messages.filter(isAdvisorCard)).toHaveLength(1);
		expect(persisted).toHaveLength(1);
		expect(persisted[0]).toContain("cleanup rejection fixture note");
		expect(harness.yieldQueue.has("advisor")).toBe(false);
	});

	it("delivers a mid-turn advisor concern to the primary at its next model step without aborting the running tool", async () => {
		const {
			session: harness,
			mock,
			advisorMock,
			heldToolStarted,
			releaseHeldTool,
		} = await createMidTurnConcernSession();

		expect(harness.setAdvisorEnabled(true)).toBe(true);
		const running = harness.prompt("run the fixture steps");
		const heldSignal = await heldToolStarted;

		// The advisor reviews the first (in-progress) delta while the second tool
		// call is parked. Its advise call runs inside that review prompt, so once
		// the advisor catches up the concern is on the aside queue; the loop only
		// polls asides again after the held tool resolves.
		expect(await harness.waitForAdvisorCatchup(10_000)).toBe(true);
		expect(harness.yieldQueue.has("advisor")).toBe(true);

		// Non-interrupting: the concern bypasses the steering queue entirely.
		expect(harness.agent.peekSteeringQueue().filter(isAdvisorCard)).toHaveLength(0);

		// The running tool is not aborted to make room for the aside.
		expect(heldSignal.aborted).toBe(false);
		releaseHeldTool();

		await running;
		await harness.waitForIdle();
		expect(await harness.waitForAdvisorCatchup(10_000)).toBe(true);

		// The concern reached the primary at its next model step (request three).
		expect(mock.calls).toHaveLength(3);
		const thirdRequestAsides: string[] = [];
		for (const message of mock.calls[2].context.messages) {
			if (message.role !== "developer") continue;
			const blocks =
				typeof message.content === "string" ? [{ type: "text" as const, text: message.content }] : message.content;
			for (const part of blocks) {
				if (part.type === "text") thirdRequestAsides.push(part.text);
			}
		}
		const asideText = thirdRequestAsides.join("\n");
		expect(asideText).toContain("<advisory");
		expect(asideText).toContain('severity="concern"');
		expect(asideText).toContain(MID_TURN_CONCERN);

		// And it exists as a proper advisor card in the transcript (not a steer).
		const messageLog = harness.agent.state.messages;
		const cards = messageLog.filter(isAdvisorCard);
		expect(cards).toHaveLength(1);
		const details = cards[0].details as AdvisorMessageDetails;
		expect(details.notes).toHaveLength(1);
		expect(details.notes[0].note).toBe(MID_TURN_CONCERN);
		expect(details.notes[0].severity).toBe("concern");

		// The card landed mid-run: after the held tool's result, before the
		// final assistant answer — not parked to the end of the transcript.
		const cardIndex = messageLog.findIndex(isAdvisorCard);
		const lastToolResultIndex = messageLog.findLastIndex(message => message.role === "toolResult");
		const finalAssistantIndex = messageLog.findLastIndex(message => message.role === "assistant");
		expect(cardIndex).toBeGreaterThan(lastToolResultIndex);
		expect(cardIndex).toBeLessThan(finalAssistantIndex);

		// No tool call was skipped to make room for the advisory.
		const toolResults: ToolResultMessage[] = [];
		for (const message of messageLog) {
			if (message.role === "toolResult") toolResults.push(message);
		}
		expect(toolResults.length).toBeGreaterThan(0);
		for (const result of toolResults) {
			expect(JSON.stringify(result.content)).not.toContain("Skipped due to pending system advisory");
		}

		// The advisor was not told to defer: its advise call got `Recorded.`.
		expect(advisorMock.calls.length).toBeGreaterThanOrEqual(2);
		const adviseResults: ToolResultMessage[] = [];
		for (const message of advisorMock.calls[1].context.messages) {
			if (message.role === "toolResult" && message.toolName === "advise") adviseResults.push(message);
		}
		expect(adviseResults).toHaveLength(1);
		expect(adviseResults[0].content.some(part => part.type === "text" && part.text === "Recorded.")).toBe(true);

		// The loop consumed the aside: nothing stranded at settle.
		expect(harness.yieldQueue.has("advisor")).toBe(false);
	});
});
