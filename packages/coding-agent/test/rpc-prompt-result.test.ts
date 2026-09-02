import { describe, expect, test } from "bun:test";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import {
	RpcExtensionUserMessageTracker,
	RpcPromptResults,
	reportPromptResult,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-prompt-results";
import type { ExtensionActions } from "../src/extensibility/extensions/types";
import { initializeExtensions } from "../src/modes/runtime-init";
import type { AgentSession, AgentSessionEvent } from "../src/session/agent-session";

/** Prompt results for a fake session whose streaming state the test drives. */
function createHarness() {
	const frames: object[] = [];
	const session = {
		isStreaming: false,
		hasAdmittedSubmission: false,
		queuedMessageCount: 0,
		hasPendingAsyncWork: () => false,
	};
	const results = new RpcPromptResults(session, frame => frames.push(frame));
	return { frames, session, results };
}

/**
 * prompt_result frames are deferred one macrotask behind the command response: the
 * first hop drains the prompt's microtask chain, the second runs the deferred writes.
 */
async function flushFrames(): Promise<void> {
	for (let hop = 0; hop < 2; hop++) {
		const { promise, resolve } = Promise.withResolvers<void>();
		setImmediate(resolve);
		await promise;
	}
}

function assistant(fields: Record<string, unknown>): AgentMessage {
	return {
		role: "assistant",
		content: [],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
		stopReason: "stop",
		timestamp: 0,
		...fields,
	} as unknown as AgentMessage;
}

function agentEnd(messages: AgentMessage[], isTerminal?: boolean): AgentSessionEvent {
	return { type: "agent_end", messages, ...(isTerminal === undefined ? {} : { isTerminal }) };
}

const agentStart: AgentSessionEvent = { type: "agent_start" };

describe("RpcPromptResults", () => {
	test("reports a joined prompt only at the terminal agent_end, not a non-terminal settle", async () => {
		const { frames, session, results } = createHarness();
		session.isStreaming = true;
		const ticket = results.begin("req_1");
		results.settle(ticket);

		results.observe(agentEnd([assistant({ stopReason: "toolUse" })], false));
		await flushFrames();
		expect(frames).toEqual([]);

		results.observe(agentStart);
		session.isStreaming = false;
		results.observe(agentEnd([assistant({ stopReason: "stop" })]));
		await flushFrames();
		expect(frames).toEqual([
			{ type: "prompt_result", id: "req_1", agentInvoked: true, status: "completed", sessionSettled: true },
		]);
	});

	test("reports the prompt's own run when a stale terminal agent_end arrives after acceptance", async () => {
		const { frames, results } = createHarness();
		const ticket = results.begin("req_2");
		// The previous prompt's run fails and settles after req_2 was accepted.
		results.observe(agentEnd([assistant({ stopReason: "error", errorMessage: "old failure" })]));
		results.observe(agentStart);
		results.observe(agentEnd([assistant({ stopReason: "stop" })]));
		results.settle(ticket);
		await flushFrames();

		expect(frames).toEqual([
			{ type: "prompt_result", id: "req_2", agentInvoked: true, status: "completed", sessionSettled: true },
		]);
	});

	test("waits for the continuation when the prompt resolves idle after a non-terminal settle", async () => {
		const { frames, results } = createHarness();
		const ticket = results.begin("req_3");
		results.observe(agentStart);
		results.observe(agentEnd([assistant({ stopReason: "stop" })], false));
		results.settle(ticket);
		await flushFrames();
		expect(frames).toEqual([]);

		results.observe(agentStart);
		results.observe(agentEnd([assistant({ stopReason: "aborted" })]));
		await flushFrames();
		expect(frames).toEqual([
			{ type: "prompt_result", id: "req_3", agentInvoked: true, status: "aborted", sessionSettled: true },
		]);
	});

	test("reports at the agent's yield while background work can still wake the session", async () => {
		const { frames, session, results } = createHarness();
		const ticket = results.begin("req_bg");
		results.observe(agentStart);
		// The turn is complete but an async job will deliver and resume the session.
		session.hasPendingAsyncWork = () => true;
		results.observe({
			type: "agent_end",
			messages: [assistant({ stopReason: "stop" })],
			isTerminal: false,
			yielded: true,
		});
		results.settle(ticket);
		await flushFrames();

		expect(frames).toEqual([
			{ type: "prompt_result", id: "req_bg", agentInvoked: true, status: "completed", sessionSettled: false },
		]);
	});

	test("reports aborted when the prompt settles without any run (abort won before dispatch)", async () => {
		const { frames, results } = createHarness();
		results.settle(results.begin("req_4"));
		await flushFrames();

		expect(frames).toEqual([
			{ type: "prompt_result", id: "req_4", agentInvoked: true, status: "aborted", sessionSettled: true },
		]);
	});

	test("reports provider failures without OMP-local diagnostics and classifies retryability", async () => {
		const { frames, session, results } = createHarness();
		session.isStreaming = true;
		// Still streaming when the results are written: the session is not settled.
		results.settle(results.begin("req_bad"));
		results.observe(
			agentEnd([
				assistant({
					stopReason: "error",
					errorStatus: 400,
					errorMessage:
						"400 invalid_request_error: messages.0: bad block\nraw-http-request=/home/u/.omp/logs/x.json",
				}),
			]),
		);
		results.settle(results.begin("req_busy"));
		results.observe(
			agentEnd([
				assistant({ stopReason: "error", errorStatus: 529, errorMessage: "529 overloaded_error: Overloaded" }),
			]),
		);
		await flushFrames();

		expect(frames).toEqual([
			{
				type: "prompt_result",
				id: "req_bad",
				agentInvoked: true,
				status: "error",
				sessionSettled: false,
				error: {
					message: "400 invalid_request_error: messages.0: bad block",
					provider: "anthropic",
					model: "claude-sonnet-4-5",
					httpStatus: 400,
					retryable: false,
				},
			},
			{
				type: "prompt_result",
				id: "req_busy",
				agentInvoked: true,
				status: "error",
				sessionSettled: false,
				error: {
					message: "529 overloaded_error: Overloaded",
					provider: "anthropic",
					model: "claude-sonnet-4-5",
					httpStatus: 529,
					retryable: true,
				},
			},
		]);
	});

	test("reports an interrupted prompt's own aborted run, not the replacement run still streaming", async () => {
		const { frames, session, results } = createHarness();
		const interrupted = results.begin("req_old");
		results.observe(agentStart);
		results.observe(agentEnd([assistant({ stopReason: "aborted" })]));
		const replacement = results.begin("req_new");
		results.observe(agentStart);
		session.isStreaming = true;
		// The interrupted prompt's promise resolves only after the replacement run began.
		results.settle(interrupted);
		results.settle(replacement);
		session.isStreaming = false;
		results.observe(agentEnd([assistant({ stopReason: "stop" })]));
		await flushFrames();

		expect(frames).toEqual([
			{ type: "prompt_result", id: "req_old", agentInvoked: true, status: "aborted", sessionSettled: true },
			{ type: "prompt_result", id: "req_new", agentInvoked: true, status: "completed", sessionSettled: true },
		]);
	});

	test("aborts every open prompt on a session transition", async () => {
		const { frames, session, results } = createHarness();
		session.isStreaming = true;
		results.settle(results.begin("req_queued"));
		const running = results.begin("req_running");
		results.observe(agentStart);
		results.abortOpen();
		// The detached run never publishes its terminal; the running prompt resolves afterwards.
		session.isStreaming = false;
		results.settle(running);
		results.observe(agentEnd([assistant({ stopReason: "stop" })]));
		await flushFrames();

		expect(frames).toEqual([
			{ type: "prompt_result", id: "req_queued", agentInvoked: true, status: "aborted", sessionSettled: true },
			{ type: "prompt_result", id: "req_running", agentInvoked: true, status: "aborted", sessionSettled: true },
		]);
	});

	test("writes prompt_result after output queued synchronously with the settle", async () => {
		const frames: object[] = [];
		const results = new RpcPromptResults(
			{ isStreaming: false, hasAdmittedSubmission: false, queuedMessageCount: 0, hasPendingAsyncWork: () => false },
			frame => frames.push(frame),
		);
		results.completeLocal(results.begin("req_6"));
		frames.push({ type: "response", id: "req_6" });
		await flushFrames();

		expect(frames).toEqual([
			{ type: "response", id: "req_6" },
			{ type: "prompt_result", id: "req_6", agentInvoked: false, status: "completed", sessionSettled: true },
		]);
	});
});

describe("reportPromptResult", () => {
	test("completes locally when the prompt resolves without agent work", async () => {
		const { frames, results } = createHarness();
		const trackedPrompt = new RpcExtensionUserMessageTracker().watchPrompt(() => Promise.resolve(false));

		reportPromptResult({
			ticket: results.begin("req_1"),
			prompt: trackedPrompt.prompt,
			results,
			onError: error => {
				throw error;
			},
			hasExtensionAgentMessageTask: trackedPrompt.hasAgentMessageTask,
		});
		await flushFrames();

		expect(frames).toEqual([
			{ type: "prompt_result", id: "req_1", agentInvoked: false, status: "completed", sessionSettled: true },
		]);
	});

	test("waits for the run when an extension command schedules agent work", async () => {
		const { frames, session, results } = createHarness();
		const extensionUserMessages = new RpcExtensionUserMessageTracker();
		const trackedPrompt = extensionUserMessages.watchPrompt(() => {
			extensionUserMessages.markAgentMessageTask();
			return Promise.resolve(false);
		});

		const ticket = results.begin("req_1");
		session.isStreaming = true;
		reportPromptResult({
			ticket,
			prompt: trackedPrompt.prompt,
			results,
			onError: error => {
				throw error;
			},
			hasExtensionAgentMessageTask: trackedPrompt.hasAgentMessageTask,
		});
		await flushFrames();
		expect(frames).toEqual([]);

		results.observe(agentStart);
		session.isStreaming = false;
		results.observe(agentEnd([assistant({ stopReason: "stop" })]));
		await flushFrames();
		expect(frames).toEqual([
			{ type: "prompt_result", id: "req_1", agentInvoked: true, status: "completed", sessionSettled: true },
		]);
	});

	test("ignores extension user messages scheduled before the watched prompt", async () => {
		const { frames, results } = createHarness();
		const extensionUserMessages = new RpcExtensionUserMessageTracker();
		extensionUserMessages.markAgentMessageTask();
		const trackedPrompt = extensionUserMessages.watchPrompt(() => Promise.resolve(false));

		reportPromptResult({
			ticket: results.begin("req_1"),
			prompt: trackedPrompt.prompt,
			results,
			onError: error => {
				throw error;
			},
			hasExtensionAgentMessageTask: trackedPrompt.hasAgentMessageTask,
		});
		await flushFrames();

		expect(frames).toEqual([
			{ type: "prompt_result", id: "req_1", agentInvoked: false, status: "completed", sessionSettled: true },
		]);
	});

	test("prompt_result follows the extension-send outcome", async () => {
		const cases: Array<{
			name: string;
			send: (actions: ExtensionActions) => void;
			session: Record<string, unknown>;
			startsTurn: boolean;
		}> = [
			{
				// `false` means sendCustomMessage provably started no turn (e.g. idle plan-mode fold).
				name: "aside that starts no turn",
				send: actions =>
					actions.sendMessage(
						{ customType: "test", content: "context", display: true, details: "context", attribution: "agent" },
						{ deliverAs: "aside" },
					),
				session: { sendCustomMessage: async () => false },
				startsTurn: false,
			},
			{
				name: "aside that starts a turn",
				send: actions =>
					actions.sendMessage(
						{ customType: "test", content: "context", display: true, details: "context", attribution: "agent" },
						{ deliverAs: "aside" },
					),
				session: { sendCustomMessage: async () => true },
				startsTurn: true,
			},
			{
				name: "sendUserMessage that succeeds",
				send: actions => actions.sendUserMessage("start work"),
				session: { sendUserMessage: async () => {} },
				startsTurn: true,
			},
			{
				name: "sendUserMessage that rejects",
				send: actions => actions.sendUserMessage("start work"),
				session: {
					sendUserMessage: async () => {
						throw new Error("missing model");
					},
				},
				startsTurn: false,
			},
		];

		for (const testCase of cases) {
			let extensionActions: ExtensionActions | undefined;
			const extensionUserMessages = new RpcExtensionUserMessageTracker();
			const session = {
				extensionRunner: {
					initialize: (actions: ExtensionActions) => {
						extensionActions = actions;
					},
					onError: () => {},
					emit: async () => {},
				},
				discoverStartupSkillPaths: async () => {},
				...testCase.session,
			} as unknown as AgentSession;
			await initializeExtensions(session, {
				reportSendError: () => {},
				reportRuntimeError: error => {
					throw error.error;
				},
				trackAgentInvokingMessage: task => {
					extensionUserMessages.trackAgentMessageTask(task);
				},
			});

			const { frames, results } = createHarness();
			const ticket = results.begin(testCase.name);
			const trackedPrompt = extensionUserMessages.watchPrompt(() => {
				if (!extensionActions) throw new Error("extensions not initialized");
				testCase.send(extensionActions);
				return Promise.resolve(false);
			});
			reportPromptResult({
				ticket,
				prompt: trackedPrompt.prompt,
				results,
				onError: error => {
					throw error;
				},
				hasExtensionAgentMessageTask: trackedPrompt.hasAgentMessageTask,
				waitForExtensionAgentMessageTasks: trackedPrompt.waitForAgentMessageTasks,
			});
			if (testCase.startsTurn) {
				results.observe(agentStart);
				results.observe(agentEnd([assistant({ stopReason: "stop" })]));
			}
			await flushFrames();

			expect(frames).toEqual([
				{
					type: "prompt_result",
					id: testCase.name,
					agentInvoked: testCase.startsTurn,
					status: "completed",
					sessionSettled: true,
				},
			]);
		}
	});

	test("reports a rejected prompt through onError and a failed prompt_result", async () => {
		const { frames, results } = createHarness();
		const reported: Error[] = [];

		reportPromptResult({
			ticket: results.begin("req_1"),
			prompt: Promise.reject(new Error("No model selected.")),
			results,
			onError: error => reported.push(error),
		});
		await flushFrames();

		expect(reported.map(error => error.message)).toEqual(["No model selected."]);
		expect(frames).toEqual([
			{
				type: "prompt_result",
				id: "req_1",
				agentInvoked: false,
				status: "error",
				sessionSettled: true,
				error: { message: "No model selected.", retryable: false },
			},
		]);
	});
});

describe("initializeExtensions markAgentInvokingMessage", () => {
	test("marks triggerTurn extension custom messages as agent work", async () => {
		let extensionActions: ExtensionActions | undefined;
		let markCount = 0;
		let sentOptions: { triggerTurn?: boolean } | undefined;
		const session = {
			extensionRunner: {
				initialize: (actions: ExtensionActions) => {
					extensionActions = actions;
				},
				onError: () => {},
				emit: async () => {},
			},
			discoverStartupSkillPaths: async () => {},
			sendCustomMessage: async (_message: unknown, options?: { triggerTurn?: boolean }) => {
				sentOptions = options;
				return true;
			},
		} as unknown as AgentSession;

		await initializeExtensions(session, {
			reportSendError: (_action, error) => {
				throw error;
			},
			reportRuntimeError: error => {
				throw error.error;
			},
			markAgentInvokingMessage: () => {
				markCount += 1;
			},
		});
		extensionActions?.sendMessage(
			{
				customType: "test",
				content: "context",
				display: true,
				details: "context",
				attribution: "user",
			},
			{ triggerTurn: true },
		);
		// markAgentInvokingMessage now fires off the tracked send's resolution (gated on the
		// boolean result) rather than synchronously, so let it settle.
		await Promise.resolve();
		await Promise.resolve();

		expect(markCount).toBe(1);
		expect(sentOptions).toEqual({ triggerTurn: true });
	});
});

describe("initializeExtensions invokingTask rejection safety", () => {
	test("does not crash the process when an extension send starts no turn outside any active prompt scope", async () => {
		let extensionActions: ExtensionActions | undefined;
		const extensionUserMessages = new RpcExtensionUserMessageTracker();
		const session = {
			extensionRunner: {
				initialize: (actions: ExtensionActions) => {
					extensionActions = actions;
				},
				onError: () => {},
				emit: async () => {},
			},
			discoverStartupSkillPaths: async () => {},
			// Mirrors AgentSession.sendCustomMessage's contract: `false` iff no turn started,
			// e.g. an idle steer superseded by a concurrent turn's preflight generation check.
			sendCustomMessage: async () => false,
		} as unknown as AgentSession;

		await initializeExtensions(session, {
			reportSendError: () => {},
			reportRuntimeError: () => {},
			// Wired exactly like RPC mode: trackAgentInvokingMessage delegates to the tracker,
			// which only attaches a handler to the task while a prompt scope is active
			// (`#activePromptScopes`). No `watchPrompt` call below, so that set is empty.
			trackAgentInvokingMessage: task => {
				extensionUserMessages.trackAgentMessageTask(task);
			},
		});

		const unhandled: unknown[] = [];
		const onUnhandled = (reason: unknown) => unhandled.push(reason);
		process.on("unhandledRejection", onUnhandled);
		try {
			if (!extensionActions) throw new Error("extensions not initialized");
			// No active prompt scope: a controller idle wake calling an extension action
			// directly (not inside an RPC prompt) hits this exact path.
			extensionActions.sendMessage(
				{ customType: "test", content: "context", display: true, details: "context", attribution: "agent" },
				{ deliverAs: "aside" },
			);
			await Promise.resolve();
			await Promise.resolve();
			await Promise.resolve();
			await Promise.resolve();
		} finally {
			process.off("unhandledRejection", onUnhandled);
		}

		expect(unhandled).toEqual([]);
	});
});
