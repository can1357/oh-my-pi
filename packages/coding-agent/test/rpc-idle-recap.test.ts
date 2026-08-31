import { afterEach, describe, expect, it, vi } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { RpcIdleRecapController } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-idle-recap";
import type { RpcRecapUpdateFrame } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";
import type { AgentSession, AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";

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
	options: { enabled?: boolean; runEphemeralTurn?: AgentSession["runEphemeralTurn"] } = {},
): AgentSession {
	const runEphemeralTurn =
		options.runEphemeralTurn ??
		vi.fn(async () => ({
			replyText: "Auth is implemented and verified. Next: publish the change.",
			assistantMessage: createAssistantMessage(),
		}));
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
		sessionId: "session-1",
		sessionName: "Fix authentication",
		getGoalModeState: () => undefined,
		getTodoPhases: () => [{ name: "Work", tasks: [{ content: "Publish the change", status: "pending" }] }],
		runEphemeralTurn,
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
	it("emits a typed recap update and exposes it for state resync", async () => {
		vi.useFakeTimers();
		const frames: RpcRecapUpdateFrame[] = [];
		const controller = new RpcIdleRecapController(createSession(), frame => frames.push(frame));

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

		controller.handleSessionEvent({ type: "agent_start" });
		expect(frames.at(-1)).toEqual({ type: "recap_update", recap: null });
		expect(controller.latestRecap).toBeUndefined();
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
		const controller = new RpcIdleRecapController(createSession({ runEphemeralTurn }), frame => frames.push(frame));

		controller.handleSessionEvent(agentEnd());
		vi.advanceTimersByTime(1_000);
		await flushMicrotasks();
		controller.resetForSessionChange();
		expect(signal?.aborted).toBe(true);

		deferred.resolve({ replyText: "stale recap", assistantMessage: createAssistantMessage() });
		await flushMicrotasks();
		expect(frames).toEqual([]);
		controller.dispose();
	});
});
