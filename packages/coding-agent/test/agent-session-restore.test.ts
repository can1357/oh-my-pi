import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Message, Model } from "@oh-my-pi/pi-ai";
import { createMockModel, type MockHandler, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import {
	createInterruptedToolResults,
	createInterruptedTurnAbortMessage,
	INTERRUPTED_TURN_ERROR,
} from "@oh-my-pi/pi-coding-agent/session/exit-diagnostics";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { postmortem, TempDir } from "@oh-my-pi/pi-utils";

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

	/** A session reopened from `persisted` as `--resume` builds it, its model answering from `responses`. */
	function reopen(
		model: Model,
		persisted: Message[],
		tools: AgentTool[],
		responses: MockResponse[],
		evalToolSession?: ToolSession,
	) {
		const sessionManager = SessionManager.inMemory();
		for (const message of persisted) sessionManager.appendMessage(message);
		return open(model, sessionManager, tools, responses, evalToolSession);
	}

	/** A session over `sessionManager`'s transcript, its model answering from `responses`. */
	function open(
		model: Model,
		sessionManager: SessionManager,
		tools: AgentTool[],
		responses: MockHandler[],
		evalToolSession?: ToolSession,
	) {
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

	it("goes on with a request its owner's shutdown cut off, not with one a normal quit stopped", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled Anthropic test model to exist");
		const stops: Array<{ label: string; stop: (session: AgentSession) => Promise<void>; restored: boolean }> = [
			// Lifecycle teardown of a running revived agent: the dispose itself cuts the request off.
			{ label: "process-exit dispose", stop: s => s.dispose({ reason: postmortem.Reason.EXIT }), restored: true },
			// Task executor on manager shutdown: the run aborts first, then its session is released.
			{
				label: "shutdown abort, then process-exit dispose",
				stop: async s => {
					await s.abort({ reason: INTERRUPTED_TURN_ERROR });
					await s.dispose({ reason: postmortem.Reason.EXIT });
				},
				restored: true,
			},
			{ label: "normal quit", stop: s => s.dispose(), restored: false },
		];
		for (const [index, { label, stop, restored }] of stops.entries()) {
			const sessionManager = SessionManager.create(tempDir.path(), path.join(tempDir.path(), `shutdown-${index}`));
			const requested = Promise.withResolvers<void>();
			const first = open(
				model,
				sessionManager,
				[],
				[
					() => {
						requested.resolve();
						return { delayMs: 60_000, content: ["never streamed"] };
					},
				],
			).session;
			const running = first.prompt("work").catch(() => {});
			await requested.promise;
			await stop(first);
			await running;
			session = undefined;

			const file = sessionManager.getSessionFile();
			if (!file) throw new Error("Expected a persisted session file");
			const { session: second, mock } = open(
				model,
				await SessionManager.open(file),
				[],
				[{ content: ["done after restore"], stopReason: "stop" }],
			);
			expect({ label, restored: await second.restoreInterruptedTurn() }).toEqual({ label, restored });
			await second.waitForIdle();
			expect({ label, calls: mock.calls.length }).toEqual({ label, calls: restored ? 1 : 0 });
			await second.dispose();
			session = undefined;
		}
	});

	it("goes on again with a restored turn a second shutdown cut off", async () => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled Anthropic test model to exist");
		let started = Promise.withResolvers<void>();
		const hang: AgentTool<typeof probeSchema> = {
			name: "probe",
			label: "Probe",
			description: "Probe tool",
			parameters: probeSchema,
			async execute(_toolCallId, _params, signal) {
				started.resolve();
				const aborted = Promise.withResolvers<void>();
				signal?.addEventListener("abort", () => aborted.resolve(), { once: true });
				await aborted.promise;
				throw new Error("probe aborted");
			},
		};
		const sessionManager = SessionManager.create(tempDir.path(), path.join(tempDir.path(), "shutdown-twice"));
		const file = sessionManager.getSessionFile();
		if (!file) throw new Error("Expected a persisted session file");
		const first = open(
			model,
			sessionManager,
			[hang as AgentTool],
			[{ content: [{ type: "toolCall", name: "probe", arguments: { value: "again" } }] }],
		).session;
		const running = first.prompt("run the probe").catch(() => {});
		await started.promise;
		await first.dispose({ reason: postmortem.Reason.EXIT });
		await running;

		// The restored turn replays the cut-off call (a scheduled continuation), and the next shutdown cuts it off too.
		started = Promise.withResolvers<void>();
		const second = open(model, await SessionManager.open(file), [hang as AgentTool], []).session;
		await expect(second.restoreInterruptedTurn()).resolves.toBe(true);
		await started.promise;
		await second.dispose({ reason: postmortem.Reason.EXIT });

		const executed: string[] = [];
		const { session: third, mock } = open(
			model,
			await SessionManager.open(file),
			[probeTool(executed)],
			[{ content: ["done after restore"], stopReason: "stop" }],
		);
		await expect(third.restoreInterruptedTurn()).resolves.toBe(true);
		await third.waitForIdle();
		expect(executed).toEqual(["again"]);
		expect(mock.calls.length).toBe(1);
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
