/**
 * `subagent_stop` on autonomous IRC wake turns, driven through a REAL
 * AgentSession (mock model, real extension runner, real turn-observer plumbing).
 *
 * The wake observer finishes after the session settled the turn, so the stop
 * pass re-drives the session from there. A fake session cannot show that a
 * nested prompt from the observer is safe — that it neither re-triggers the
 * observer nor races the session's settle — so these tests pin it end to end.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { createMockModel, type MockHandler, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ExtensionRuntime, loadExtensionFromFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import type { SubagentStopEvent, SubagentStopEventResult } from "@oh-my-pi/pi-coding-agent/extensibility/shared-events";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { attachIrcWakeTurnMonitor } from "@oh-my-pi/pi-coding-agent/task/executor";
import { TASK_SUBAGENT_LIFECYCLE_CHANNEL, type AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { isRecord, TempDir } from "@oh-my-pi/pi-utils";
import type { IrcMessage } from "@oh-my-pi/pi-tui/tools/irc";

const AGENT_ID = "WakeAgent";

const wakeAgent: AgentDefinition = {
	name: "task",
	description: "test",
	systemPrompt: "test",
	source: "bundled",
};

/** A stand-in `yield` tool: the executor monitor only reads its result details. */
const yieldTool: AgentTool = {
	name: "yield",
	label: "Yield",
	description: "Submit the final result",
	parameters: type({ data: "string" }),
	execute: async (_id, params) => {
		const data = isRecord(params) ? params.data : undefined;
		return { content: [{ type: "text", text: "Result submitted." }], details: { status: "success", data } };
	},
};

const yieldCall = (data: string): MockResponse => ({
	content: [{ type: "toolCall", name: "yield", arguments: { data } }],
});

/** Lifecycle frames the monitor publishes; only the fields these tests read. */
interface LifecycleFrame {
	status?: string;
}

function toLifecycleFrame(data: unknown): LifecycleFrame {
	return { status: isRecord(data) && typeof data.status === "string" ? data.status : undefined };
}

describe("IRC wake turn subagent_stop (real session)", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession | undefined;

	beforeEach(async () => {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		tempDir = TempDir.createSync("@pi-wake-subagent-stop-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorage.keys.setRuntime("openai", "openai-test-key");
	});

	afterEach(async () => {
		await session?.dispose();
		session = undefined;
		authStorage.close();
		tempDir.removeSync();
		AsyncJobManager.resetForTests();
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
	});

	async function setup(args: {
		responses: MockHandler[];
		onStop: (
			event: SubagentStopEvent,
			callIndex: number,
		) => SubagentStopEventResult | undefined | Promise<SubagentStopEventResult | undefined>;
	}) {
		const stopEvents: SubagentStopEvent[] = [];
		const lifecycle: LifecycleFrame[] = [];
		const eventBus = new EventBus();
		eventBus.on(TASK_SUBAGENT_LIFECYCLE_CHANNEL, data => lifecycle.push(toLifecycleFrame(data)));
		const modelRegistry = new ModelRegistry(authStorage);
		const sessionManager = SessionManager.inMemory(tempDir.path());
		const runtime = new ExtensionRuntime();
		const extension = await loadExtensionFromFactory(
			pi => {
				pi.on("subagent_stop", async event => {
					stopEvents.push(event);
					return args.onStop(event, stopEvents.length);
				});
			},
			tempDir.path(),
			eventBus,
			runtime,
			"wake-stop-hook",
		);
		const extensionRunner = new ExtensionRunner([extension], runtime, tempDir.path(), sessionManager, modelRegistry);
		const mock = createMockModel({ provider: "openai", id: "gpt-test", responses: args.responses });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model: mock.model, systemPrompt: ["Test"], tools: [yieldTool], messages: [] },
			convertToLlm,
			streamFn: mock.stream,
		});
		const settings = Settings.isolated({ "compaction.enabled": false, "todo.enabled": false });
		settings.setModelRole("default", `${mock.model.provider}/${mock.model.id}`);
		session = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry,
			toolRegistry: new Map([["yield", yieldTool]]),
			agentId: AGENT_ID,
			extensionRunner,
		});
		attachIrcWakeTurnMonitor(session, {
			id: AGENT_ID,
			agent: wakeAgent,
			eventBus,
			parentSessionId: "parent-session-1",
			parentSessionFile: "/parent/session.jsonl",
			artifactsDir: tempDir.path(),
		});
		return { session, mock, stopEvents, lifecycle, artifact: path.join(tempDir.path(), `${AGENT_ID}.md`) };
	}

	async function deliverWake(target: AgentSession, id: string): Promise<void> {
		await target.deliverIrcMessage({ id, from: "peer", to: AGENT_ID, body: "status?", ts: Date.now() } as IrcMessage);
	}

	async function wake(target: AgentSession): Promise<void> {
		await deliverWake(target, "m1");
		await target.waitForIrcReplies();
		await target.waitForIdle();
	}

	it("offers the wake turn's yield, re-drives the session on a refusal, and publishes only the replacement", async () => {
		const run = await setup({
			responses: [yieldCall("REFUSED-PAYLOAD"), yieldCall("replacement")],
			onStop: (_event, callIndex) => (callIndex === 1 ? { decision: "block", reason: "keep going" } : undefined),
		});

		await wake(run.session);

		expect(run.stopEvents.map(event => event.stop_hook_active)).toEqual([false, true]);
		expect(run.stopEvents[0]).toMatchObject({
			agent_id: AGENT_ID,
			agent_type: "task",
			parent_session_id: "parent-session-1",
			parent_session_file: "/parent/session.jsonl",
		});
		// Two model requests: the wake turn and the one continuation. A third would
		// be the observer re-triggering itself or the parked turn running on.
		expect(run.mock.calls).toHaveLength(2);
		expect(JSON.stringify(run.mock.calls[1]?.context.messages)).toContain("keep going");
		// The observer started once: the continuation is not a new observation.
		expect(run.lifecycle.filter(frame => frame.status === "started")).toHaveLength(1);
		const artifact = await Bun.file(run.artifact).text();
		expect(artifact).toContain("replacement");
		expect(artifact).not.toContain("REFUSED-PAYLOAD");
	});

	it("accepts the wake turn's yield once, with no extra turn, when handlers allow it", async () => {
		const run = await setup({ responses: [yieldCall("first answer")], onStop: () => undefined });

		await wake(run.session);

		expect(run.stopEvents).toHaveLength(1);
		expect(run.mock.calls).toHaveLength(1);
		expect(await Bun.file(run.artifact).text()).toContain("first answer");
	});

	it("fails the wake turn instead of publishing a refused yield the continuation never replaced", async () => {
		const run = await setup({
			// The continuation answers in prose and does not yield again.
			responses: [yieldCall("REFUSED-PAYLOAD"), { content: ["I am done."] }],
			onStop: () => ({ decision: "block", reason: "not done" }),
		});

		await wake(run.session);

		expect(run.stopEvents).toHaveLength(1);
		expect(run.mock.calls).toHaveLength(2);
		expect(await Bun.file(run.artifact).exists()).toBe(false);
		expect(run.lifecycle.at(-1)?.status).toBe("failed");
	});

	it("fails closed when a newer wake took the session while handlers were consulting", async () => {
		const stopEntered = Promise.withResolvers<void>();
		const releaseStop = Promise.withResolvers<void>();
		const secondWakeRunning = Promise.withResolvers<void>();
		const releaseSecondWake = Promise.withResolvers<void>();
		const run = await setup({
			responses: [
				yieldCall("REFUSED-PAYLOAD"),
				async () => {
					secondWakeRunning.resolve();
					await releaseSecondWake.promise;
					return { content: ["second wake reply"] };
				},
			],
			onStop: async () => {
				stopEntered.resolve();
				await releaseStop.promise;
				return { decision: "block", reason: "keep going" };
			},
		});

		await deliverWake(run.session, "m1");
		await stopEntered.promise;
		// The first wake's turn is settled and its monitor detached: the session is
		// idle, so a second wake starts its own turn while the first pass consults.
		await deliverWake(run.session, "m2");
		await secondWakeRunning.promise;
		releaseStop.resolve();
		releaseSecondWake.resolve();
		await run.session.waitForIrcReplies();
		await run.session.waitForIdle();

		// The continuation could not start on the busy session and never reached the
		// model; the refused payload was not published by either observation.
		expect(run.mock.calls).toHaveLength(2);
		expect(JSON.stringify(run.mock.calls[1]?.context.messages)).not.toContain("keep going");
		expect(run.stopEvents).toHaveLength(1);
		expect(await Bun.file(run.artifact).exists()).toBe(false);
		expect(run.lifecycle.map(frame => frame.status)).toContain("failed");
	});
});
