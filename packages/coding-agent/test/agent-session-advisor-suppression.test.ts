/**
 * Contract: after a deliberate user interrupt the advisor must not auto-resume
 * the run, but its concerns must survive as visible, persisted transcript cards
 * so they re-enter context when the user resumes. Internal (non-user) aborts keep
 * the prior behavior — advisor advice stays in the auto-continue path.
 *
 * Five seams:
 *  1. A concern already steered into the agent queue when the user hits Esc is
 *     pulled out of the post-abort auto-continue path and re-recorded as advice.
 *  2. A concern parked hidden (#pendingNextTurnMessages) by the suppressed
 *     delivery while the turn is still tearing down is reclaimed once idle.
 *  3. A non-user abort does NOT suppress: a steered advisor card still drives the
 *     auto-continue, so the gate is keyed to the user interrupt, not any abort.
 *  4. A user message queued (as a steer) before the interrupt is delivered on
 *     resume even though the preserved advisor card is the trailing message.
 *  5. The same queued as a follow-up: continuing from the preserved advisor card
 *     (which converts to `developer`) would send an invalid provider tail, so the
 *     follow-up stays queued for the next explicit resume rather than auto-running.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentMessage, type AgentTool } from "@oh-my-pi/pi-agent-core";
import type { ToolCall } from "@oh-my-pi/pi-ai";
import { createMockModel, type MockModel, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { IrcMessage } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { USER_INTERRUPT_LABEL } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { Snowflake, TempDir } from "@oh-my-pi/pi-utils";

interface MockYieldDetails {
	status: "success";
	data?: unknown;
	type?: string | string[];
}

const mockYieldParameters = type({
	data: "unknown",
	"type?": "unknown",
});

const ADVISOR_TYPE = "advisor";

interface ParkedHarness {
	session: AgentSession;
	sessionManager: SessionManager;
	mock: MockModel;
	/** Resolves the moment the first turn's model stream begins (deterministic
	 *  "now streaming" signal — no wall-clock polling). */
	streamStarted: Promise<void>;
}

interface CompletedAdvisorHarness {
	session: AgentSession;
	sessionManager: SessionManager;
	mock: MockModel;
	advisorMock: MockModel;
}

interface AdvisorTestExtensionRunner {
	hasHandlers(eventType: string): boolean;
	emitBeforeAgentStart(): Promise<undefined>;
	emit(event: { type: string; message?: AgentMessage }): Promise<void>;
}

describe("AgentSession advisor auto-resume suppression", () => {
	let tempDir: TempDir;
	let session: AgentSession;
	const authStorages: AuthStorage[] = [];

	beforeAll(() => {
		tempDir = TempDir.createSync("@pi-advisor-suppress-");
	});

	afterEach(async () => {
		// dispose() aborts the agent, cancelling the parked first-turn stream.
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
	 * First turn parks open (a 60s mock delay that abort cancels) so a steer/park
	 * + interrupt can be sequenced while the agent is genuinely streaming. The
	 * `streamStarted` promise resolves from the mock handler, before the delay, so
	 * tests await the real stream-begin signal rather than a timer.
	 */
	async function createParkedSession(tailResponses: MockResponse[] = []): Promise<ParkedHarness> {
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
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			streamFn: mock.stream,
		});
		const sessionManager = SessionManager.inMemory();
		const settings = Settings.isolated({ "compaction.enabled": false });
		const authStorage = await AuthStorage.create(":memory:");
		authStorages.push(authStorage);
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
		session = new AgentSession({ agent, sessionManager, settings, modelRegistry });
		return { session, sessionManager, mock, streamStarted: started.promise };
	}

	function isYieldType(value: unknown): value is string | string[] {
		return (
			typeof value === "string" ||
			(Array.isArray(value) && value.length > 0 && value.every(item => typeof item === "string"))
		);
	}

	function createMockYieldTool(): AgentTool<typeof mockYieldParameters, MockYieldDetails> {
		return {
			name: "yield",
			label: "Yield",
			description: "Mock yield tool",
			parameters: mockYieldParameters,
			execute: async (_toolCallId, params) => {
				const details: MockYieldDetails = { status: "success", data: params.data };
				if (isYieldType(params.type)) details.type = params.type;
				return {
					content: [{ type: "text", text: "Result submitted." }],
					details,
				};
			},
		};
	}

	function createYieldMockResponse(args: { data: unknown; type?: string | string[] }): MockResponse {
		const toolCall: ToolCall = {
			type: "toolCall",
			id: `call_yield_${Snowflake.next()}`,
			name: "yield",
			arguments: args,
		};
		return {
			content: [toolCall],
			stopReason: "toolUse",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		};
	}

	async function createCompletedAdvisorSession(
		severity: "concern" | "blocker" = "concern",
		extensionRunner?: AdvisorTestExtensionRunner,
	): Promise<CompletedAdvisorHarness> {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const mock = createMockModel({
			responses: [
				{ content: ["EXACT VERDICT"], stopReason: "stop" },
				{ content: ["CHANGED VERDICT"], stopReason: "stop" },
			],
		});
		const advisorMock = createMockModel({
			responses: [
				{
					content: [
						{
							type: "toolCall",
							name: "advise",
							arguments: { note: "Fixture verdict confirmed", severity },
						},
					],
				},
				{ content: [], stopReason: "stop" },
			],
		});
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
			extensionRunner: extensionRunner as never,
		});
		return { session, sessionManager, mock, advisorMock };
	}

	function advisorCard(content: string) {
		return {
			customType: ADVISOR_TYPE,
			content,
			display: true,
			attribution: "agent" as const,
			details: { notes: [{ note: content, severity: "concern" as const }] },
		};
	}

	function isAdvisorCard(message: AgentMessage): message is AgentMessage & { role: "custom"; content: string } {
		return message.role === "custom" && (message as { customType?: string }).customType === ADVISOR_TYPE;
	}

	function userMessageText(messages: AgentMessage[]): string[] {
		const out: string[] = [];
		for (const message of messages) {
			if (message.role !== "user") continue;
			const content = message.content;
			if (typeof content === "string") {
				out.push(content);
			} else {
				for (const part of content) if (part.type === "text") out.push(part.text);
			}
		}
		return out;
	}

	function capturePersistedAdvice(sessionManager: SessionManager): string[] {
		const persisted: string[] = [];
		sessionManager.onEntryAppended = entry => {
			if (entry.type === "custom_message" && entry.customType === ADVISOR_TYPE) {
				persisted.push(typeof entry.content === "string" ? entry.content : JSON.stringify(entry.content));
			}
		};
		return persisted;
	}

	it("preserves a final-yield blocker without starting a hidden post-yield turn", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5")!;
		const mock = createMockModel({
			responses: [
				createYieldMockResponse({ data: "FINAL RESULT" }),
				{ content: ["must not run"], stopReason: "stop" },
			],
		});
		const advisorMock = createMockModel({
			responses: [
				{
					content: [
						{
							type: "toolCall",
							name: "advise",
							arguments: { note: "Final yield needs correction", severity: "blocker" },
						},
					],
				},
				{ content: [], stopReason: "stop" },
			],
		});
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [createMockYieldTool()] },
			streamFn: mock.stream,
		});
		const sessionManager = SessionManager.inMemory();
		const settings = Settings.isolated({
			"advisor.syncBacklog": "1",
			"compaction.enabled": false,
			"retry.enabled": false,
		});
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
		expect(session.setAdvisorEnabled(true)).toBe(true);
		await session.prompt("yield the final result");
		expect(await session.waitForAdvisorCatchup(1000)).toBe(true);

		expect(advisorMock.calls).toHaveLength(2);
		expect(mock.calls).toHaveLength(1);
		const advisorCards = session.agent.state.messages.filter(isAdvisorCard);
		expect(advisorCards).toHaveLength(1);
		expect(advisorCards[0].content).toContain("Final yield needs correction");
	});

	it("preserves a late advisor concern after a terminal answer without waking the primary", async () => {
		const { session, sessionManager, mock, advisorMock } = await createCompletedAdvisorSession();
		const persisted = capturePersistedAdvice(sessionManager);

		await session.prompt("read five fixture files and answer with exactly one line");
		await session.waitForIdle();
		expect(mock.calls.length).toBe(1);

		expect(session.setAdvisorEnabled(true)).toBe(true);
		const advisor = session.getAdvisorAgent();
		if (!advisor) throw new Error("Expected advisor agent to be live");

		await advisor.prompt("inspect the completed turn");
		await session.waitForIdle();

		const advisorCards = session.agent.state.messages.filter(isAdvisorCard);
		expect(advisorCards).toHaveLength(1);
		expect(persisted.at(-1)).toContain("Fixture verdict confirmed");
		expect(advisorMock.calls.length).toBeGreaterThanOrEqual(1);
		expect(mock.calls.length).toBe(1);
	});

	it("waits for preserved advisor card hooks and persistence before reporting catch-up", async () => {
		const hookStarted = Promise.withResolvers<void>();
		const releaseHook = Promise.withResolvers<void>();
		const extensionRunner: AdvisorTestExtensionRunner = {
			hasHandlers: eventType => eventType === "message_end",
			emitBeforeAgentStart: async () => undefined,
			emit: async event => {
				if (event.type !== "message_end" || !event.message || !isAdvisorCard(event.message)) return;
				hookStarted.resolve();
				await releaseHook.promise;
			},
		};
		const { session, sessionManager, mock } = await createCompletedAdvisorSession("concern", extensionRunner);
		const persisted = capturePersistedAdvice(sessionManager);

		expect(session.setAdvisorEnabled(true)).toBe(true);
		await session.prompt("answer with exactly one line");
		await hookStarted.promise;

		expect(await session.waitForAdvisorCatchup(0)).toBe(false);
		expect(persisted).toEqual([]);

		let catchupSettled = false;
		const catchup = session.waitForAdvisorCatchup(1000).then(caughtUp => {
			catchupSettled = true;
			return caughtUp;
		});
		await Promise.resolve();
		expect(catchupSettled).toBe(false);
		expect(persisted).toEqual([]);

		releaseHook.resolve();
		expect(await catchup).toBe(true);
		expect(persisted.at(-1)).toContain("Fixture verdict confirmed");
		expect(mock.calls).toHaveLength(1);
	});

	it("waits for preserved advisor card start hooks before reporting catch-up", async () => {
		const hookStarted = Promise.withResolvers<void>();
		const releaseHook = Promise.withResolvers<void>();
		const extensionRunner: AdvisorTestExtensionRunner = {
			hasHandlers: eventType => eventType === "message_start",
			emitBeforeAgentStart: async () => undefined,
			emit: async event => {
				if (event.type !== "message_start" || !event.message || !isAdvisorCard(event.message)) return;
				hookStarted.resolve();
				await releaseHook.promise;
			},
		};
		const { session, mock } = await createCompletedAdvisorSession("concern", extensionRunner);

		expect(session.setAdvisorEnabled(true)).toBe(true);
		await session.prompt("answer with exactly one line");
		await hookStarted.promise;

		let catchupSettled = false;
		const catchup = session.waitForAdvisorCatchup(1000).then(caughtUp => {
			catchupSettled = true;
			return caughtUp;
		});
		await Promise.resolve();
		expect(catchupSettled).toBe(false);

		releaseHook.resolve();
		expect(await catchup).toBe(true);
		expect(mock.calls).toHaveLength(1);
	});

	it("steers a late advisor blocker after a terminal answer so the primary corrects it", async () => {
		const { session, mock } = await createCompletedAdvisorSession("blocker");

		await session.prompt("read five fixture files and answer with exactly one line");
		await session.waitForIdle();
		expect(mock.calls.length).toBe(1);

		expect(session.setAdvisorEnabled(true)).toBe(true);
		const advisor = session.getAdvisorAgent();
		if (!advisor) throw new Error("Expected advisor agent to be live");

		await advisor.prompt("inspect the completed turn");
		await session.waitForIdle();

		expect(mock.calls.length).toBe(2);
	});

	it("preserves another late advisor concern after an existing advisor card", async () => {
		const { session, mock } = await createCompletedAdvisorSession();

		await session.prompt("answer with exactly one line");
		await session.waitForIdle();
		session.agent.state.messages.push({
			role: "custom",
			...advisorCard("first late concern"),
			timestamp: Date.now(),
		});
		expect(session.setAdvisorEnabled(true)).toBe(true);
		const advisor = session.getAdvisorAgent();
		if (!advisor) throw new Error("Expected advisor agent to be live");

		await advisor.prompt("inspect the completed turn");
		await session.waitForIdle();

		expect(session.agent.state.messages.filter(isAdvisorCard)).toHaveLength(2);
		expect(mock.calls.length).toBe(1);
	});

	it("preserves late advice after terminal text with provider metadata blocks", async () => {
		const { session, mock } = await createCompletedAdvisorSession();

		await session.prompt("answer with exactly one line");
		await session.waitForIdle();
		const answer = session.agent.state.messages.at(-1);
		if (answer?.role !== "assistant") throw new Error("Expected terminal assistant answer");
		answer.content.push(
			{ type: "redactedThinking", data: "opaque provider reasoning" },
			{ type: "fallback", from: { model: "first" }, to: { model: "second" } },
		);
		expect(session.setAdvisorEnabled(true)).toBe(true);
		const advisor = session.getAdvisorAgent();
		if (!advisor) throw new Error("Expected advisor agent to be live");

		await advisor.prompt("inspect the completed turn");
		await session.waitForIdle();

		expect(session.agent.state.messages.filter(isAdvisorCard)).toHaveLength(1);
		expect(mock.calls.length).toBe(1);
	});

	it("preserves an advisor concern steered before the user interrupt, without auto-resuming", async () => {
		const { session, sessionManager, mock, streamStarted } = await createParkedSession();
		const persisted = capturePersistedAdvice(sessionManager);

		const running = session.prompt("do the thing");
		await streamStarted;

		// Advisor raises an interrupting concern mid-run: it lands in the steering queue.
		await session.sendCustomMessage(advisorCard("breaks the build"), { deliverAs: "steer", triggerTurn: true });
		expect(session.agent.peekSteeringQueue().some(isAdvisorCard)).toBe(true);

		await session.abort({ reason: USER_INTERRUPT_LABEL });
		await session.waitForIdle();

		// Pulled out of the auto-continue path and re-recorded as a visible/persisted card.
		expect(session.agent.peekSteeringQueue()).toEqual([]);
		expect(session.agent.state.messages.filter(isAdvisorCard)).toHaveLength(1);
		expect(persisted).toEqual(["breaks the build"]);
		// No advisor-driven resume: only the original (aborted) turn called the model.
		expect(mock.calls.length).toBe(1);

		await running.catch(() => {});
	});

	it("reclaims an advisor concern parked during abort cleanup so it is not lost", async () => {
		const { session, sessionManager, mock, streamStarted } = await createParkedSession();
		const persisted = capturePersistedAdvice(sessionManager);

		const running = session.prompt("do the thing");
		await streamStarted;

		// A suppressed delivery arriving while the turn is still streaming parks the
		// concern hidden in #pendingNextTurnMessages (the mid-abort race window).
		await session.sendCustomMessage(advisorCard("parked mid-abort"), { deliverAs: "nextTurn", triggerTurn: false });
		expect(session.agent.state.messages.filter(isAdvisorCard)).toHaveLength(0);
		expect(persisted).toEqual([]);

		await session.abort({ reason: USER_INTERRUPT_LABEL });
		await session.waitForIdle();

		// Reclaimed and surfaced as a visible/persisted card once the agent settles.
		expect(session.agent.state.messages.filter(isAdvisorCard)).toHaveLength(1);
		expect(persisted).toEqual(["parked mid-abort"]);
		expect(mock.calls.length).toBe(1);

		await running.catch(() => {});
	});

	it("keeps advisor auto-resume for a non-user (internal) abort", async () => {
		const { session, mock, streamStarted } = await createParkedSession([{ content: ["resumed after advice"] }]);

		const running = session.prompt("do the thing");
		await streamStarted;

		await session.sendCustomMessage(advisorCard("keep going"), { deliverAs: "steer", triggerTurn: true });
		expect(session.agent.peekSteeringQueue().some(isAdvisorCard)).toBe(true);

		// Internal abort (no USER_INTERRUPT_LABEL): the advisor card is NOT extracted;
		// it stays in the queue and drives a normal auto-continue turn.
		await session.abort();
		await session.waitForIdle();
		await running.catch(() => {});

		expect(session.agent.peekSteeringQueue()).toEqual([]);
		expect(mock.calls.length).toBe(2);
	});

	it("reclaims a stranded advisor steer on settle while suppressed, instead of auto-resuming the stopped run", async () => {
		// Residual edge exposed once interrupting advice is steered (not parked) into a
		// resumed streaming run: a concern can land in the steer queue past the loop's
		// final boundary poll and strand. The steer queue otherwise bypasses the
		// suppression latch in #canAutoContinueForFollowUp, so the idle settle would
		// auto-resume the run the user stopped. The settle drain must instead reclaim the
		// stranded advisor steer as visible advice. (A non-user abort is used purely as a
		// deterministic settle trigger — it neither extracts advisor cards nor clears the
		// latch — standing in for the natural #endInFlight settle after the resumed turn.)
		const { session, sessionManager, mock, streamStarted } = await createParkedSession([
			{ content: ["must not auto-resume"] },
		]);
		const persisted = capturePersistedAdvice(sessionManager);

		const running = session.prompt("do the thing");
		await streamStarted;

		// User interrupt latches suppression.
		await session.abort({ reason: USER_INTERRUPT_LABEL });
		await session.waitForIdle();
		await running.catch(() => {});
		expect(mock.calls.length).toBe(1);

		// A concern strands in the steer queue (steered past the resumed turn's last poll).
		session.agent.steer({
			role: "custom",
			customType: ADVISOR_TYPE,
			content: "stranded tail concern",
			display: true,
			attribution: "agent",
			details: { notes: [{ note: "stranded tail concern", severity: "concern" }] },
			timestamp: Date.now(),
		} as AgentMessage);
		expect(session.agent.peekSteeringQueue().some(isAdvisorCard)).toBe(true);

		// Settle while suppression is still in effect.
		await session.abort();
		await session.waitForIdle();

		// Reclaimed as visible/persisted advice; the steer queue is emptied and NO
		// advisor-only auto-resume turn ran (model still called exactly once).
		expect(session.agent.peekSteeringQueue()).toEqual([]);
		expect(session.agent.state.messages.filter(isAdvisorCard)).toHaveLength(1);
		expect(persisted).toEqual(["stranded tail concern"]);
		expect(mock.calls.length).toBe(1);
	});

	it("resumes a queued user steer stranded behind a preserved advisor card", async () => {
		// Reported bug: typing a message during a run (queued as a steer) then pressing
		// enter again (empty-submit interrupt) recorded the advisor card but stranded the
		// user message — nothing resumed the run. The preserved advisor card is the
		// trailing `custom` message, which #canAutoContinueForFollowUp must look past.
		const { session, sessionManager, mock, streamStarted } = await createParkedSession([
			{ content: ["resumed on the steer"] },
		]);
		const persisted = capturePersistedAdvice(sessionManager);

		const running = session.prompt("do the thing");
		await streamStarted;

		await session.sendCustomMessage(advisorCard("breaks the build"), { deliverAs: "steer", triggerTurn: true });
		await session.prompt("also rename the helper", { streamingBehavior: "steer" });

		await session.abort({ reason: USER_INTERRUPT_LABEL });
		await session.waitForIdle();
		await running.catch(() => {});

		// Advisor card preserved as a visible/persisted card AND the user steer delivered
		// in exactly one resume turn (no spurious extra call).
		expect(session.agent.state.messages.filter(isAdvisorCard)).toHaveLength(1);
		expect(persisted).toEqual(["breaks the build"]);
		expect(session.agent.peekSteeringQueue()).toEqual([]);
		expect(mock.calls.length).toBe(2);
		expect(userMessageText(session.agent.state.messages)).toContain("also rename the helper");
	});

	it("leaves a queued user follow-up queued behind a preserved advisor card", async () => {
		// Same stranding, but the user message was queued as a follow-up (Ctrl+Enter).
		// Only steering resumes safely behind a preserved advisor card: agentLoopContinue
		// injects steering before the next model call, keeping the request tail valid. A
		// follow-up would instead resume by continuing from the advisor card (which converts
		// to `developer`) as the tail — a provider-invalid request — so it is NOT auto-run.
		// It stays queued for the next explicit user resume.
		const { session, sessionManager, mock, streamStarted } = await createParkedSession([
			{ content: ["must not run"] },
		]);
		const persisted = capturePersistedAdvice(sessionManager);

		const running = session.prompt("do the thing");
		await streamStarted;

		await session.sendCustomMessage(advisorCard("missing a guard"), { deliverAs: "steer", triggerTurn: true });
		await session.prompt("then add the test", { streamingBehavior: "followUp" });

		await session.abort({ reason: USER_INTERRUPT_LABEL });
		await session.waitForIdle();
		await running.catch(() => {});

		// Advisor preserved as a visible/persisted card; the follow-up stays queued and
		// drives no resume (only the original, aborted turn ever called the model).
		expect(session.agent.state.messages.filter(isAdvisorCard)).toHaveLength(1);
		expect(persisted).toEqual(["missing a guard"]);
		expect(userMessageText([...session.agent.peekFollowUpQueue()])).toContain("then add the test");
		expect(userMessageText(session.agent.state.messages)).not.toContain("then add the test");
		expect(mock.calls.length).toBe(1);
	});

	it("wakes a turn for an IRC aside stranded across a user interrupt", async () => {
		const { session, mock, streamStarted } = await createParkedSession([{ content: ["replying to peer"] }]);
		const running = session.prompt("do the thing");
		await streamStarted;
		// IRC arrives mid-turn → queued as a non-interrupting aside.
		await session.deliverIrcMessage({ id: "m1", from: "peer", to: "me", body: "ping", ts: Date.now() } as IrcMessage);
		// The user interrupt skips the loop's final aside poll, stranding the aside with no loop to
		// drain it. The settle drain must wake a turn so the peer still gets a response.
		await session.abort({ reason: USER_INTERRUPT_LABEL });
		await session.waitForIdle();
		await running.catch(() => {});

		const sawIrc = session.agent.state.messages.some(
			m => m.role === "custom" && (m as { customType?: string }).customType === "irc:incoming",
		);
		expect(sawIrc).toBe(true);
		expect(mock.calls.length).toBe(2);
	});

	it("stops an idle IRC wake after a terminal yield", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 model to exist");
		let providerCalls = 0;
		const mock = createMockModel({
			handler: () => {
				providerCalls++;
				if (providerCalls > 1) {
					throw new Error("terminal yield must not start a second provider call");
				}
				return createYieldMockResponse({ data: { ok: true } });
			},
		});
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [createMockYieldTool()] },
			streamFn: mock.stream,
		});
		const sessionManager = SessionManager.inMemory();
		const settings = Settings.isolated({ "compaction.enabled": false });
		const authStorage = await AuthStorage.create(":memory:");
		authStorages.push(authStorage);
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
		session = new AgentSession({ agent, sessionManager, settings, modelRegistry });
		const msg: IrcMessage = { id: "m-yield", from: "peer", to: "me", body: "status?", ts: Date.now() };

		const outcome = await session.deliverIrcMessage(msg);
		await session.waitForIdle();

		expect(outcome).toBe("woken");
		expect(providerCalls).toBe(1);
		expect(mock.calls.length).toBe(1);
	});

	it("flushes an accepted IRC aside on dispose instead of dropping it", async () => {
		const { session, streamStarted } = await createParkedSession();
		const running = session.prompt("do the thing");
		await streamStarted;
		await session.deliverIrcMessage({ id: "m1", from: "peer", to: "me", body: "ping", ts: Date.now() } as IrcMessage);
		// Dispose mid-flight persists the accepted aside to the transcript rather than dropping it.
		session.beginDispose();
		const sawIrc = session.agent.state.messages.some(
			m => m.role === "custom" && (m as { customType?: string }).customType === "irc:incoming",
		);
		expect(sawIrc).toBe(true);
		running.catch(() => {});
	});

	it("responds to a stranded IRC aside while keeping a blocked follow-up queued", async () => {
		const { session, mock, streamStarted } = await createParkedSession([{ content: ["replying to peer"] }]);
		const running = session.prompt("do the thing");
		await streamStarted;
		// The user queues a follow-up (Ctrl+Enter) and an IRC ping lands as an aside...
		await session.prompt("then add the test", { streamingBehavior: "followUp" });
		await session.deliverIrcMessage({ id: "m2", from: "peer", to: "me", body: "ping", ts: Date.now() } as IrcMessage);
		// ...then the user interrupts. The IRC must still get a response, but the user's queued
		// follow-up must NOT auto-run (seam #5) even though the IRC wake turn leaves a valid tail.
		await session.abort({ reason: USER_INTERRUPT_LABEL });
		await session.waitForIdle();
		await running.catch(() => {});

		const sawIrc = session.agent.state.messages.some(
			m => m.role === "custom" && (m as { customType?: string }).customType === "irc:incoming",
		);
		expect(sawIrc).toBe(true);
		expect(userMessageText([...session.agent.peekFollowUpQueue()])).toContain("then add the test");
		expect(userMessageText(session.agent.state.messages)).not.toContain("then add the test");
		expect(mock.calls.length).toBe(2);
	});
});
