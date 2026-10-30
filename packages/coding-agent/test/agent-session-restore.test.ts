import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Message, Model } from "@oh-my-pi/pi-ai";
import { createMockModel, type MockHandler } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import {
	createInterruptedToolResults,
	createInterruptedTurnAbortMessage,
	SESSION_EXIT_CUSTOM_TYPE,
	type SessionExitData,
} from "@oh-my-pi/pi-coding-agent/session/exit-diagnostics";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { TempDir } from "@oh-my-pi/pi-utils";

const zeroUsage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistant(model: Model, fields: Partial<AssistantMessage>): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: zeroUsage,
		stopReason: "stop",
		timestamp: Date.now(),
		...fields,
	};
}

const probeSchema = type({ value: "string" });

/** A `probe` tool recording each run's `value` in `executed`. */
function probeTool(executed: string[]): AgentTool {
	const tool: AgentTool<typeof probeSchema, { value: string }> = {
		name: "probe",
		label: "Probe",
		description: "Probe tool",
		parameters: probeSchema,
		async execute(_toolCallId, params) {
			executed.push(params.value);
			return { content: [{ type: "text", text: `ok:${params.value}` }], details: params };
		},
	};
	return tool as AgentTool;
}

/**
 * A `probe` recording each run's `value` in `executed`, whose first run calls `onStuck`
 * and then never finishes on its own: it ends only when its turn is aborted.
 */
function stuckOnceTool(executed: string[], onStuck: () => void): AgentTool {
	const tool: AgentTool<typeof probeSchema, { value: string }> = {
		name: "probe",
		label: "Probe",
		description: "Probe tool",
		parameters: probeSchema,
		async execute(_toolCallId, params, signal) {
			executed.push(params.value);
			if (executed.length === 1) {
				const { promise, reject } = Promise.withResolvers<never>();
				signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
				onStuck();
				await promise;
			}
			return { content: [{ type: "text", text: `ok:${params.value}` }], details: params };
		},
	};
	return tool as AgentTool;
}

/** `persisted` with the records resume-time exit recovery (sdk.ts) closes its cut-off turn with. */
function closedByExitRecovery(persisted: Message[]): Message[] {
	const manager = SessionManager.inMemory();
	for (const message of persisted) manager.appendMessage(message);
	const branch = manager.getBranch();
	const abort = createInterruptedTurnAbortMessage(branch, undefined, { assumeExit: true });
	if (!abort) throw new Error("Expected an unfinished turn to close");
	return [...persisted, ...createInterruptedToolResults(branch), abort];
}

describe("AgentSession.restoreInterruptedTurn (omp --restore)", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let session: AgentSession | undefined;

	beforeAll(async () => {
		tempDir = TempDir.createSync("@pi-restore-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.keys.setRuntime("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterEach(async () => {
		await session?.dispose();
		session = undefined;
	});

	afterAll(() => {
		authStorage.close();
		tempDir.removeSync();
	});

	/**
	 * A session reopened from `persisted` (messages and `session_exit` records, in order)
	 * as `--resume` builds it, its model answering from `responses`. `sessionManager`
	 * receives `persisted` (default: in memory).
	 */
	function reopen(
		model: Model,
		persisted: Array<Message | SessionExitData>,
		tools: AgentTool[],
		responses: MockHandler[],
		evalToolSession?: ToolSession,
		sessionManager = SessionManager.inMemory(),
	) {
		for (const entry of persisted) {
			if ("role" in entry) sessionManager.appendMessage(entry);
			else sessionManager.appendCustomEntry(SESSION_EXIT_CUSTOM_TYPE, entry);
		}
		const mock = createMockModel({ responses });
		const agent = new Agent({
			getApiKey: model => `${model.provider}-test-key`,
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools,
				messages: sessionManager.buildSessionContext().messages,
			},
			streamFn: mock.stream,
		});
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": false, "retry.enabled": false }),
			modelRegistry,
			evalToolSession,
		});
		session.subscribe(() => {});
		return { session, mock };
	}

	/** What `live` wrote to its session file, as `reopen` takes it: its branch's messages and exit records. */
	async function written(live: AgentSession): Promise<Array<Message | SessionExitData>> {
		const file = live.sessionManager.getSessionFile();
		if (!file) throw new Error("Expected the session to have a file");
		const manager = await SessionManager.open(file, path.dirname(file));
		return manager.getBranch().flatMap((entry): Array<Message | SessionExitData> => {
			if (entry.type === "message") return [entry.message as Message];
			if (entry.type === "custom" && entry.customType === SESSION_EXIT_CUSTOM_TYPE) {
				return [entry.data as SessionExitData];
			}
			return [];
		});
	}

	it("goes on with a turn a crash cut off mid tool call, running the cut-off call again", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled Anthropic test model to exist");
		const executed: string[] = [];
		// The process died while `probe` ran: no tool result, no session_exit record.
		const { session, mock } = reopen(
			model,
			[
				{ role: "user", content: "run the probe", timestamp: Date.now() },
				assistant(model, {
					content: [{ type: "toolCall", id: "call_1", name: "probe", arguments: { value: "again" } }],
					stopReason: "toolUse",
				}),
			],
			[probeTool(executed)],
			[{ content: ["done after restore"], stopReason: "stop" }],
		);

		await expect(session.restoreInterruptedTurn()).resolves.toBe(true);
		await session.waitForIdle();

		expect(executed).toEqual(["again"]);
		expect(mock.calls.length).toBe(1);
		const last = session.agent.state.messages.at(-1);
		expect(last?.role === "assistant" && last.content).toContainEqual({ type: "text", text: "done after restore" });
	});

	it("goes on with a reply /restart cut off, but not one a plain exit or a later answer left", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled Anthropic test model to exist");
		const prompt: Message = { role: "user", content: "write the summary", timestamp: Date.now() };
		const exit = (fields: Partial<SessionExitData>): SessionExitData => ({
			reason: "restart",
			kind: "normal",
			recordedAt: new Date().toISOString(),
			...fields,
		});
		// Dispose records the exit before it aborts the turn, so the cut-off reply follows it.
		const cutReply = assistant(model, {
			content: [{ type: "text", text: "Here is the sum" }],
			stopReason: "aborted",
			errorMessage: "Request was aborted",
		});

		const restorable: Array<Array<Message | SessionExitData>> = [
			[prompt, exit({ restartedMidTurn: true }), cutReply],
			// Dispose ran out of time before the cut-off reply reached the file.
			[prompt, exit({ restartedMidTurn: true })],
		];
		for (const persisted of restorable) {
			const restarted = reopen(model, persisted, [], [{ content: ["the summary"], stopReason: "stop" }]);
			await expect(restarted.session.restoreInterruptedTurn()).resolves.toBe(true);
			await restarted.session.waitForIdle();
			expect(restarted.mock.calls.length).toBe(1);
			const last = restarted.session.agent.state.messages.at(-1);
			expect(last?.role === "assistant" && last.content).toContainEqual({ type: "text", text: "the summary" });
			await restarted.session.dispose();
		}

		const leftAsIs: Array<Array<Message | SessionExitData>> = [
			// An idle-time exit (or a /quit) recorded before the user's own interrupt.
			[prompt, exit({ reason: "dispose" }), cutReply],
			// A later process already answered a newer prompt.
			[
				prompt,
				exit({ restartedMidTurn: true }),
				cutReply,
				{ role: "user", content: "never mind", timestamp: Date.now() },
				assistant(model, { content: [{ type: "text", text: "ok" }] }),
			],
			// The user interrupted the restored reply before the process died.
			[
				prompt,
				exit({ restartedMidTurn: true }),
				cutReply,
				assistant(model, { stopReason: "aborted", errorMessage: "Interrupted by user" }),
			],
		];
		for (const persisted of leftAsIs) {
			const { session, mock } = reopen(model, persisted, [], []);
			await expect(session.restoreInterruptedTurn()).resolves.toBe(false);
			expect(mock.calls.length).toBe(0);
			await session.dispose();
		}
		session = undefined;
	});

	it("records a turn /restart cuts off, a first reply or a later tool call, so the relaunch goes on with it", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled Anthropic test model to exist");
		const executed: string[] = [];
		const history: Message[] = [
			{ role: "user", content: "say hi", timestamp: Date.now() },
			assistant(model, { content: [{ type: "text", text: "hi" }] }),
		];
		const cutOff: Array<{ name: string; history: Message[]; respond: (started: () => void) => MockHandler }> = [
			{
				// No reply has landed yet when the restart cuts the first one off.
				name: "first reply",
				history: [],
				respond: started => () => {
					started();
					return { content: ["never sent"], delayMs: 60_000 };
				},
			},
			{
				// The stuck probe reports the start.
				name: "tool call in a later turn",
				history,
				respond: () => ({
					content: [{ type: "toolCall", id: "call_1", name: "probe", arguments: { value: "slow" } }],
				}),
			},
		];
		for (const scenario of cutOff) {
			const started = Promise.withResolvers<void>();
			const live = reopen(
				model,
				scenario.history,
				[stuckOnceTool(executed, started.resolve)],
				[scenario.respond(started.resolve)],
				undefined,
				SessionManager.create(tempDir.path(), path.join(tempDir.path(), scenario.name)),
			);
			const prompted = Promise.withResolvers<void>();
			live.session.subscribe(event => {
				if (event.type === "message_end" && event.message.role === "user") prompted.resolve();
			});
			const turn = live.session.prompt("go on").catch(() => false);
			// The restart comes once the prompt is in the transcript and the turn is under way.
			await Promise.all([started.promise, prompted.promise]);
			await live.session.settleInFlightMessagePersistence();
			await live.session.dispose({ reason: "restart" });
			await turn;
			expect({ scenario: scenario.name, cut: live.session.restartCutTurnOff }).toEqual({
				scenario: scenario.name,
				cut: true,
			});

			const relaunched = reopen(
				model,
				await written(live.session),
				[stuckOnceTool(executed, () => {})],
				[{ content: ["went on"], stopReason: "stop" }],
			);
			await expect(relaunched.session.restoreInterruptedTurn()).resolves.toBe(true);
			await relaunched.session.waitForIdle();
			const last = relaunched.session.agent.state.messages.at(-1);
			expect(last?.role === "assistant" && last.content).toContainEqual({ type: "text", text: "went on" });
			await relaunched.session.dispose();
		}

		// A restart between turns cuts nothing off: the relaunch resumes.
		const idle = reopen(
			model,
			history,
			[],
			[],
			undefined,
			SessionManager.create(tempDir.path(), path.join(tempDir.path(), "idle")),
		);
		await idle.session.dispose({ reason: "restart" });
		expect(idle.session.restartCutTurnOff).toBe(false);
		const resumed = reopen(model, await written(idle.session), [], []);
		await expect(resumed.session.restoreInterruptedTurn()).resolves.toBe(false);
		await resumed.session.dispose();
		session = undefined;
	});

	it("goes on with a turn exit recovery closed when the eval state snapshot follows it (#16195)", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled Anthropic test model to exist");
		const executed: string[] = [];
		const evalToolSession: ToolSession = {
			cwd: tempDir.path(),
			hasUI: false,
			settings: Settings.isolated(),
			getSessionFile: () => null,
			getSessionSpawns: () => null,
			getEvalSessionId: () => "restore-eval-state",
		};
		// Eval history makes the reopened session persist an eval state snapshot right
		// after the turn the previous process's exit cut off and resume recovery closed.
		const { session, mock } = reopen(
			model,
			closedByExitRecovery([
				{ role: "user", content: "eval something", timestamp: Date.now() },
				assistant(model, {
					content: [{ type: "toolCall", id: "call_eval", name: "eval", arguments: { code: "1" } }],
					stopReason: "toolUse",
				}),
				{
					role: "toolResult",
					toolCallId: "call_eval",
					toolName: "eval",
					content: [{ type: "text", text: "1" }],
					isError: false,
					timestamp: Date.now(),
				},
				assistant(model, { content: [{ type: "text", text: "evaluated" }] }),
				{ role: "user", content: "run the probe", timestamp: Date.now() },
				assistant(model, {
					content: [{ type: "toolCall", id: "call_1", name: "probe", arguments: { value: "again" } }],
					stopReason: "toolUse",
				}),
			]),
			[probeTool(executed)],
			[{ content: ["done after restore"], stopReason: "stop" }],
			evalToolSession,
		);
		const tail = session.sessionManager.getBranch().at(-1);
		expect(tail?.type === "custom_message" && tail.customType).toBe("eval-state-context");
		// The idle "F5 to Retry" row sees the closed turn through the snapshot too.
		expect(session.hasAbortedToolCallTail).toBe(true);

		await expect(session.restoreInterruptedTurn()).resolves.toBe(true);
		await session.waitForIdle();

		expect(executed).toEqual(["again"]);
		expect(mock.calls.length).toBe(1);
		const last = session.agent.state.messages.at(-1);
		expect(last?.role === "assistant" && last.content).toContainEqual({ type: "text", text: "done after restore" });
	});

	it("leaves a turn the user interrupted, and one that finished, as they are", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled Anthropic test model to exist");
		const interrupted: Message[] = [
			{ role: "user", content: "run the probe", timestamp: Date.now() },
			assistant(model, {
				content: [{ type: "toolCall", id: "call_1", name: "probe", arguments: { value: "x" } }],
				stopReason: "toolUse",
			}),
			{
				role: "toolResult",
				toolCallId: "call_1",
				toolName: "probe",
				content: [{ type: "text", text: "Execution interrupted" }],
				isError: true,
				timestamp: Date.now(),
			},
			assistant(model, { stopReason: "aborted", errorMessage: "Interrupted by user" }),
		];
		const finished: Message[] = [
			{ role: "user", content: "say hi", timestamp: Date.now() },
			assistant(model, { content: [{ type: "text", text: "hi" }] }),
		];
		for (const persisted of [interrupted, finished]) {
			const { session, mock } = reopen(model, persisted, [], []);
			await expect(session.restoreInterruptedTurn()).resolves.toBe(false);
			expect(mock.calls.length).toBe(0);
			await session.dispose();
		}
		session = undefined;
	});
});
