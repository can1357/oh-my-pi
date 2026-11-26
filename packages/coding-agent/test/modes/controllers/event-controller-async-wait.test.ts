/**
 * A model loop can stop while the run waits on outside work it started: the
 * session emits `agent_pause { yielded: true }` and only a background-job
 * result, a child agent or a peer message can resume the run.
 *
 * Contracts:
 *  1. The run is still on: program status stays `working`, and the working row
 *     names the awaited jobs and child agents — not the last tool call's
 *     intent — until a woken loop takes the row back.
 *  2. Ending the wait (Esc → `stopAwaitingAsyncWork`) interrupts the session;
 *     the run's following `agent_end` tears down as user-interrupted (status
 *     idle, no completion toast) and says which jobs keep running.
 *  3. End to end on a real session: a job that finishes after the wait was
 *     ended lands in context and does not start a model turn.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EventController } from "@oh-my-pi/pi-coding-agent/modes/controllers/event-controller";
import { AgentSession, type AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { WakeSources } from "@oh-my-pi/pi-coding-agent/session/agent-session-events";
import type { AsyncJobSnapshot } from "@oh-my-pi/pi-coding-agent/session/agent-session-types";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { USER_INTERRUPT_LABEL } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import * as runStatus from "@oh-my-pi/pi-coding-agent/utils/run-status";
import * as titleGenerator from "@oh-my-pi/pi-coding-agent/utils/title-generator";
import * as terminalSession from "@oh-my-pi/pi-tui/driver/session";
import { initTheme } from "../../../src/ui/theme/service";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInteractiveModeContext } from "../../helpers/interactive-mode-context";

type AgentPause = Extract<AgentSessionEvent, { type: "agent_pause" }>;
type AgentEnd = Extract<AgentSessionEvent, { type: "agent_end" }>;

beforeAll(() => {
	initTheme();
});

beforeEach(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	vi.spyOn(titleGenerator, "setTerminalTitleState").mockImplementation(() => {});
});

afterEach(() => {
	vi.restoreAllMocks();
	resetSettingsForTest();
});

function yieldedMessages(): AssistantMessage[] {
	return [
		{
			role: "assistant",
			content: [{ type: "text", text: "started the job" }],
			stopReason: "stop",
			usage: { inputTokens: 0, outputTokens: 0 },
			timestamp: Date.now(),
		} as unknown as AssistantMessage,
	];
}

function yieldedPause(): AgentPause {
	return { type: "agent_pause", messages: yieldedMessages(), yielded: true, awaiting: true };
}

/** The run's `agent_end` after the user ended the wait: it carries the last loop's normal yield. */
function runEnd(): AgentEnd {
	return { type: "agent_end", messages: yieldedMessages() };
}

function runningJobs(ids: readonly string[]): AsyncJobSnapshot {
	return {
		running: ids.map(id => ({ id, type: "bash", status: "running", label: `job ${id}`, startTime: 0 })),
		recent: [],
		delivery: { queued: 0, inFlight: 0, deliveredRecently: 0 },
	} as unknown as AsyncJobSnapshot;
}

/** Stub session paused on outside work; `cancel(id)` drops one job without a wake, `end()` closes the run. */
function makeAwaitingContext(jobIds: string[], agentIds: string[] = []) {
	const jobs = [...jobIds];
	const agents = [...agentIds];
	let runActive = true;
	let streaming = false;
	const abort = vi.fn(async (_options?: { reason?: string }) => {});
	const ctx = createInteractiveModeContext({
		sessionManager: { getSessionName: () => "test-session" },
		session: {
			get isRunActive() {
				return runActive;
			},
			get isStreaming() {
				return streaming;
			},
			get wakeSources(): WakeSources | undefined {
				if (jobs.length === 0 && agents.length === 0) return undefined;
				return { jobs: [...jobs], agents: [...agents], queued: false };
			},
			getAsyncJobSnapshot: () => runningJobs(jobs),
			abort,
		},
	});
	return {
		ctx,
		abort,
		cancel: (id: string) => {
			jobs.splice(jobs.indexOf(id), 1);
		},
		wake: () => {
			streaming = true;
		},
		end: () => {
			runActive = false;
			streaming = false;
		},
	};
}

/** What the working row shows now, as the loader reads it on a tick. */
function rowLabel(setWorkingMessage: { mock: { calls: unknown[][] } }): string | undefined {
	const message = setWorkingMessage.mock.calls.at(-1)?.[0];
	if (typeof message === "function") return message();
	return typeof message === "string" ? message : undefined;
}

describe("EventController — run paused on outside work", () => {
	it("keeps program status working and names the awaited jobs and agents, then hands the row back to a woken loop", async () => {
		const { ctx, wake } = makeAwaitingContext(["bg_1", "bg_2"], ["Scout"]);
		const report = vi.spyOn(runStatus, "setRunStatus").mockImplementation(() => {});
		const setWorkingMessage = vi.spyOn(ctx, "setWorkingMessage");
		const ensureWorkingRow = vi.spyOn(ctx, "ensureWorkingRow");
		const markActivityEnd = vi.spyOn(ctx.statusLine, "markActivityEnd");
		const controller = new EventController(ctx);

		await controller.handleEvent({ type: "agent_start" });
		report.mockClear();
		await controller.handleEvent(yieldedPause());

		// The run goes on: nothing reports a settled status or tears the run down.
		expect(report).not.toHaveBeenCalled();
		expect(markActivityEnd).not.toHaveBeenCalled();
		expect(ensureWorkingRow).toHaveBeenCalled();
		const label = rowLabel(setWorkingMessage);
		expect(label).toContain("bg_1");
		expect(label).toContain("bg_2");
		expect(label).toContain("Scout");
		expect(controller.isAwaitingAsyncWork()).toBe(true);

		// A job result woke the run: the row must not keep claiming it waits.
		wake();
		await controller.handleEvent({ type: "agent_start" });
		expect(setWorkingMessage).toHaveBeenLastCalledWith();
		expect(controller.isAwaitingAsyncWork()).toBe(false);
	});

	it("drops a job cancelled without a wake from the row on the next tick", async () => {
		// `/jobs kill bg_1` enqueues no wake, so no pause or agent_start refreshes
		// the row; a label built once at the pause kept naming the dead job.
		const { ctx, cancel } = makeAwaitingContext(["bg_1", "bg_2"]);
		const setWorkingMessage = vi.spyOn(ctx, "setWorkingMessage");
		const controller = new EventController(ctx);
		await controller.handleEvent(yieldedPause());
		expect(rowLabel(setWorkingMessage)).toContain("bg_1");

		cancel("bg_1");

		const label = rowLabel(setWorkingMessage);
		expect(label).not.toContain("bg_1");
		expect(label).toContain("bg_2");
		expect(label).not.toContain("2 background jobs");
	});

	it("ends the wait with a user interrupt; the run's agent_end tears down as interrupted while its jobs keep running", async () => {
		const { ctx, abort, end } = makeAwaitingContext(["bg_1"]);
		const report = vi.spyOn(runStatus, "setRunStatus").mockImplementation(() => {});
		const markActivityEnd = vi.spyOn(ctx.statusLine, "markActivityEnd");
		const notify = vi.spyOn(terminalSession, "notifyTerminal").mockImplementation(() => {});
		const controller = new EventController(ctx);
		const predict = vi.spyOn(controller.composerPrediction, "request");
		await controller.handleEvent(yieldedPause());
		expect(markActivityEnd).not.toHaveBeenCalled();

		await controller.stopAwaitingAsyncWork();
		expect(abort).toHaveBeenCalledWith({ reason: USER_INTERRUPT_LABEL });

		// The session ends the paused run right away.
		end();
		await controller.handleEvent(runEnd());

		expect(report).toHaveBeenLastCalledWith({ state: "idle" });
		expect(markActivityEnd).toHaveBeenCalledTimes(1);
		expect(controller.isAwaitingAsyncWork()).toBe(false);
		// The user stopped it on purpose: no "Complete" toast, no prediction.
		expect(notify).not.toHaveBeenCalled();
		expect(predict).not.toHaveBeenCalled();
		// It says what is still running, since its result will now arrive silently.
		expect(ctx.showStatus).toHaveBeenCalledWith("Stopped waiting · 1 background job still running (/jobs)");
	});

	it("does not mount the wait row for a yielded pause nothing outside can resume", async () => {
		const { ctx } = makeAwaitingContext([]);
		const setWorkingMessage = vi.spyOn(ctx, "setWorkingMessage");
		const controller = new EventController(ctx);
		await controller.handleEvent(yieldedPause());
		expect(controller.isAwaitingAsyncWork()).toBe(false);
		expect(setWorkingMessage).not.toHaveBeenCalled();
	});
});

describe("EventController — ending the wait on a real session", () => {
	let tempDir: TempDir | undefined;
	let session: AgentSession | undefined;
	let manager: AsyncJobManager | undefined;
	let authStorage: AuthStorage | undefined;
	const gates: Array<PromiseWithResolvers<string>> = [];

	afterEach(async () => {
		for (const gate of gates.splice(0)) gate.resolve("done");
		await session?.dispose();
		manager?.cancelAll();
		await manager?.dispose();
		authStorage?.close();
		await tempDir?.remove();
		session = undefined;
		manager = undefined;
		authStorage = undefined;
		tempDir = undefined;
	});

	it("folds a job result that lands after the wait was ended into context without starting a turn", async () => {
		tempDir = TempDir.createSync("@pi-async-wait-esc-");
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected built-in anthropic model to exist");
		const mock = createMockModel({
			responses: [{ content: ["job started"], stopReason: "stop" }],
			handler: () => ({ content: ["woke up after the job"], stopReason: "stop" }),
		});
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			streamFn: mock.stream,
		});
		const sessionManager = SessionManager.inMemory(tempDir.path());
		authStorage = await AuthStorage.create(":memory:");
		authStorage.keys.setRuntime("anthropic", "test-key");
		manager = new AsyncJobManager({});
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": false, "retry.enabled": false }),
			modelRegistry: new ModelRegistry(authStorage, tempDir.join("models.yml")),
			agentId: "Main",
			asyncJobManager: manager,
		});
		const gate = Promise.withResolvers<string>();
		gates.push(gate);
		manager.register("bash", "sleep 150", async () => await gate.promise, { ownerId: "Main" });

		const ctx = createInteractiveModeContext({ session, sessionManager });
		const controller = new EventController(ctx);
		const events: AgentSessionEvent[] = [];
		session.subscribe(event => {
			events.push(event);
			void controller.dispatchSessionEvent(event);
		});
		await session.prompt("start the long job");
		await session.waitForIdle();
		expect(events.some(event => event.type === "agent_pause" && event.yielded)).toBe(true);
		expect(events.some(event => event.type === "agent_end")).toBe(false);
		expect(mock.calls.length).toBe(1);
		expect(controller.isAwaitingAsyncWork()).toBe(true);

		await controller.stopAwaitingAsyncWork();
		await session.waitForRunEnd();
		// Let the dispatched `agent_end` finish its teardown.
		await controller.runSerialized(async () => {});
		expect(session.isRunActive).toBe(false);
		expect(events.filter(event => event.type === "agent_end")).toHaveLength(1);
		expect(ctx.showStatus).toHaveBeenCalledWith(expect.stringContaining("1 background job"));

		gate.resolve("JOB_FINISHED");
		await manager.waitForAll();
		await manager.drainDeliveries();
		await session.waitForRunEnd();

		expect(mock.calls.length).toBe(1);
		const results = session.agent.state.messages.filter(
			message => "customType" in message && message.customType === "async-result",
		);
		expect(results).toHaveLength(1);
	});
});
