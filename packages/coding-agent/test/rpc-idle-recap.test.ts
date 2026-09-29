import { afterEach, describe, expect, it, vi } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { RpcIdleRecapController } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-idle-recap";
import { cfgRecapEnabled } from "@oh-my-pi/pi-coding-agent/modes/settings";
import type { RpcRecapUpdateFrame } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";
import type { AgentSession, AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";

function createAssistantMessage(): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "done" }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: {
			input: 200,
			output: 10,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 210,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

function createSession(
	options: {
		enabled?: boolean;
		runEphemeralTurn?: AgentSession["runEphemeralTurn"];
		recordRecap?: (recap: string) => void;
	} = {},
): AgentSession {
	const runEphemeralTurn =
		options.runEphemeralTurn ??
		vi.fn(async () => ({
			replyText: "Auth is implemented and verified.\n\nNext: publish the change.",
			assistantMessage: createAssistantMessage(),
		}));
	const sessionManager = SessionManager.inMemory();
	sessionManager.appendMessage({ role: "user", content: "Fix authentication", timestamp: Date.now() });
	sessionManager.appendMessage(createAssistantMessage());
	if (options.recordRecap) vi.spyOn(sessionManager, "recordRecap").mockImplementation(options.recordRecap);
	return {
		isDisposed: false,
		isStreaming: false,
		isCompacting: false,
		settings: Settings.isolated({
			"recap.enabled": options.enabled ?? true,
			"recap.idleSeconds": 1,
		}),
		model: { provider: "anthropic", id: "claude-sonnet-4-5" },
		messages: [createAssistantMessage()],
		// Pinned provider id (--provider-session-id): constant across switches, unlike the persisted id.
		sessionId: "pinned-provider-session",
		sessionFile: "/sessions/a.jsonl",
		sessionName: "Fix authentication",
		getGoalModeState: () => undefined,
		getTodoPhases: () => [{ name: "Work", tasks: [{ content: "Publish the change", status: "pending" }] }],
		runEphemeralTurn,
		sessionManager,
	} as unknown as AgentSession;
}

async function flushMicrotasks(): Promise<void> {
	for (let index = 0; index < 10; index++) await Promise.resolve();
}

function agentEnd(): AgentSessionEvent {
	return { type: "agent_end", messages: [createAssistantMessage()], isTerminal: true };
}

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

describe("RPC idle recap", () => {
	it("emits a typed recap update, journals it, and exposes it for state resync", async () => {
		vi.useFakeTimers();
		const frames: RpcRecapUpdateFrame[] = [];
		const recordRecap = vi.fn();
		const controller = new RpcIdleRecapController(createSession({ recordRecap }), frame => frames.push(frame));

		controller.handleSessionEvent(agentEnd());
		vi.advanceTimersByTime(1_000);
		await flushMicrotasks();

		expect(frames).toEqual([
			{
				type: "recap_update",
				recap: {
					text: "Auth is implemented and verified. Next: publish the change.",
					trigger: "idle",
					timestamp: expect.any(Number),
				},
			},
		]);
		expect(controller.latestRecap).toEqual(frames[0]?.recap ?? undefined);
		expect(recordRecap).toHaveBeenCalledWith("Auth is implemented and verified.\n\nNext: publish the change.");

		controller.handleSessionEvent({ type: "agent_start" });
		expect(frames.at(-1)).toEqual({ type: "recap_update", recap: null });
		expect(controller.latestRecap).toBeUndefined();
		controller.dispose();
	});

	it("hides the recap from state resync once the session switched without an RPC command", async () => {
		vi.useFakeTimers();
		const session = createSession();
		const controller = new RpcIdleRecapController(session, () => {});

		controller.handleSessionEvent(agentEnd());
		vi.advanceTimersByTime(1_000);
		await flushMicrotasks();
		expect(controller.latestRecap?.text).toBe("Auth is implemented and verified. Next: publish the change.");

		// Extension-driven switches (ctx.newSession/switchSession) bypass rpc-mode's reset hooks.
		Object.defineProperty(session.sessionManager, "getSessionId", { value: () => "session-2" });
		expect(controller.latestRecap).toBeUndefined();
		controller.dispose();
	});

	it("drops a pending recap when the session switched without an RPC command before the timer fired", async () => {
		vi.useFakeTimers();
		const runEphemeralTurn = vi.fn(async () => ({
			replyText: "wrong session",
			assistantMessage: createAssistantMessage(),
		}));
		const recordRecap = vi.fn();
		const session = createSession({ runEphemeralTurn, recordRecap });
		const frames: RpcRecapUpdateFrame[] = [];
		const controller = new RpcIdleRecapController(session, frame => frames.push(frame));

		controller.handleSessionEvent(agentEnd());
		Object.defineProperty(session.sessionManager, "getSessionId", { value: () => "session-2" });
		vi.advanceTimersByTime(1_000);
		await flushMicrotasks();

		expect(runEphemeralTurn).not.toHaveBeenCalled();
		expect(recordRecap).not.toHaveBeenCalled();
		expect(frames).toEqual([]);
		controller.dispose();
	});

	it("does not schedule recap generation when the setting is disabled", async () => {
		vi.useFakeTimers();
		const runEphemeralTurn = vi.fn(async () => ({
			replyText: "unused",
			assistantMessage: createAssistantMessage(),
		}));
		const frames: RpcRecapUpdateFrame[] = [];
		const controller = new RpcIdleRecapController(createSession({ enabled: false, runEphemeralTurn }), frame =>
			frames.push(frame),
		);

		controller.handleSessionEvent(agentEnd());
		vi.advanceTimersByTime(1_000);
		await flushMicrotasks();

		expect(runEphemeralTurn).not.toHaveBeenCalled();
		expect(frames).toEqual([]);
		controller.dispose();
	});

	it("skips a pending recap when the setting is disabled before the timer fires", async () => {
		vi.useFakeTimers();
		const runEphemeralTurn = vi.fn(async () => ({
			replyText: "unused",
			assistantMessage: createAssistantMessage(),
		}));
		const session = createSession({ runEphemeralTurn });
		const controller = new RpcIdleRecapController(session, () => {});

		controller.handleSessionEvent(agentEnd());
		cfgRecapEnabled.override(session.settings, false);
		vi.advanceTimersByTime(1_000);
		await flushMicrotasks();

		expect(runEphemeralTurn).not.toHaveBeenCalled();
		controller.dispose();
	});

	it("aborts an in-flight recap when the session changes", async () => {
		vi.useFakeTimers();
		const deferred = Promise.withResolvers<{
			replyText: string;
			assistantMessage: AssistantMessage;
		}>();
		let signal: AbortSignal | undefined;
		const runEphemeralTurn = vi.fn((args: { promptText: string; signal?: AbortSignal }) => {
			signal = args.signal;
			return deferred.promise;
		}) as AgentSession["runEphemeralTurn"];
		const frames: RpcRecapUpdateFrame[] = [];
		const recordRecap = vi.fn();
		const controller = new RpcIdleRecapController(createSession({ runEphemeralTurn, recordRecap }), frame =>
			frames.push(frame),
		);

		controller.handleSessionEvent(agentEnd());
		vi.advanceTimersByTime(1_000);
		await flushMicrotasks();
		controller.resetForSessionChange();
		expect(signal?.aborted).toBe(true);

		deferred.resolve({ replyText: "stale recap", assistantMessage: createAssistantMessage() });
		await flushMicrotasks();
		expect(frames).toEqual([]);
		expect(recordRecap).not.toHaveBeenCalled();
		controller.dispose();
	});

	// Extension switches and tree navigation bypass rpc-mode's hooks; the recap's position is the only guard.
	for (const [label, switchSession] of [
		[
			"a new persisted id",
			(session: AgentSession) => {
				Object.defineProperty(session.sessionManager, "getSessionId", { value: () => "session-2" });
			},
		],
		[
			"a copied file sharing the header id",
			(session: AgentSession) => {
				Object.defineProperty(session, "sessionFile", { value: "/sessions/copy-of-a.jsonl" });
			},
		],
		[
			"an earlier point of the same session tree",
			(session: AgentSession) => {
				const [root] = session.sessionManager.getBranch();
				session.sessionManager.branch(root!.id);
			},
		],
	] as const) {
		it(`discards an in-flight recap after an out-of-band switch to ${label}`, async () => {
			vi.useFakeTimers();
			const deferred = Promise.withResolvers<{ replyText: string; assistantMessage: AssistantMessage }>();
			const runEphemeralTurn = vi.fn(() => deferred.promise) as AgentSession["runEphemeralTurn"];
			const recordRecap = vi.fn();
			const session = createSession({ runEphemeralTurn, recordRecap });
			const frames: RpcRecapUpdateFrame[] = [];
			const controller = new RpcIdleRecapController(session, frame => frames.push(frame));

			controller.handleSessionEvent(agentEnd());
			vi.advanceTimersByTime(1_000);
			await flushMicrotasks();
			expect(runEphemeralTurn).toHaveBeenCalled();
			switchSession(session);

			deferred.resolve({ replyText: "previous session recap", assistantMessage: createAssistantMessage() });
			await flushMicrotasks();
			expect(frames).toEqual([]);
			expect(recordRecap).not.toHaveBeenCalled();
			controller.dispose();
		});
	}

	it("cancel() drops a pending recap but keeps the current one", async () => {
		vi.useFakeTimers();
		const runEphemeralTurn = vi.fn(async () => ({
			replyText: "Auth is implemented and verified.",
			assistantMessage: createAssistantMessage(),
		}));
		const controller = new RpcIdleRecapController(createSession({ runEphemeralTurn }), () => {});

		controller.handleSessionEvent(agentEnd());
		vi.advanceTimersByTime(1_000);
		await flushMicrotasks();
		controller.handleSessionEvent(agentEnd());
		controller.cancel();
		vi.advanceTimersByTime(1_000);
		await flushMicrotasks();

		expect(runEphemeralTurn).toHaveBeenCalledTimes(1);
		expect(controller.latestRecap?.text).toBe("Auth is implemented and verified.");
		controller.dispose();
	});

	it("keeps a recap across appended entries but hides it once navigation leaves its branch", async () => {
		vi.useFakeTimers();
		const session = createSession();
		const controller = new RpcIdleRecapController(session, () => {});

		controller.handleSessionEvent(agentEnd());
		vi.advanceTimersByTime(1_000);
		await flushMicrotasks();
		const [root, reply] = session.sessionManager.getBranch();
		session.sessionManager.appendLabelChange(reply!.id, "checkpoint");
		expect(controller.latestRecap?.text).toBe("Auth is implemented and verified. Next: publish the change.");

		session.sessionManager.branch(root!.id);
		expect(controller.latestRecap).toBeUndefined();
		controller.dispose();
	});
});
