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
import { Agent, type AgentMessage, type AgentTool } from "@oh-my-pi/pi-agent-core";
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
import { attachIrcWakeTurnMonitor, runSubagentFollowUpTurn } from "@oh-my-pi/pi-coding-agent/task/executor";
import { TASK_SUBAGENT_LIFECYCLE_CHANNEL, type AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import { YieldTool } from "@oh-my-pi/pi-coding-agent/tools/yield";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { isRecord, TempDir, untilAborted } from "@oh-my-pi/pi-utils";
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
	parameters: type({ data: "string", "type?": "string[]" }),
	execute: async (_id, params) => {
		const data = isRecord(params) ? params.data : undefined;
		const sectionType = isRecord(params) && Array.isArray(params.type) ? params.type : undefined;
		return {
			content: [{ type: "text", text: "Result submitted." }],
			details: { status: "success", data, ...(sectionType ? { type: sectionType } : {}) },
		};
	},
};

const yieldCall = (data: string): MockResponse => ({
	content: [{ type: "toolCall", name: "yield", arguments: { data } }],
});

/** An incremental section: recorded for the result, but it does not end the turn's work. */
const sectionCall = (label: string, data: string): MockResponse => ({
	content: [{ type: "toolCall", name: "yield", arguments: { type: [label], data } }],
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
		/** Owner async-job manager the session owns; the wake turn's owner jobs live here. */
		manager?: AsyncJobManager;
		/** Registry parent of the woken agent; waking it as that parent opens the wake job the parent waits on. */
		parentId?: string;
		/** Wall-clock cap on the wake turn, ms. */
		maxRuntimeMs?: number;
		/** Agent definition name reported as `agent_type`, when it differs from `wakeAgent.name`. */
		agentType?: string;
		/** Register the session live and leave it to `runSubagentFollowUpTurn` instead of observing it as a wake. */
		driven?: boolean;
		/** The wake turn's prompt rejects once the turn itself ran (a post-yield session failure). */
		failWakeAfterTurn?: boolean;
		/** `false` = a message-result child: no yield, its reply is the result. */
		structured?: boolean;
		/** Output schema; with it the session uses the real `YieldTool` instead of the stand-in. */
		outputSchema?: Record<string, unknown>;
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
		const sessionYieldTool: AgentTool = args.outputSchema
			? new YieldTool({
					cwd: tempDir.path(),
					hasUI: false,
					getSessionFile: () => null,
					getSessionSpawns: () => "*",
					settings: Settings.isolated(),
					outputSchema: args.outputSchema,
				})
			: yieldTool;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model: mock.model, systemPrompt: ["Test"], tools: [sessionYieldTool], messages: [] },
			convertToLlm,
			streamFn: mock.stream,
		});
		if (args.failWakeAfterTurn) {
			const prompt = agent.prompt.bind(agent);
			let failed = false;
			agent.prompt = async (input: string | AgentMessage | AgentMessage[]) => {
				// `prompt` dispatches on the input shape at runtime; the cast only picks an overload.
				await prompt(input as AgentMessage[]);
				if (failed) return;
				failed = true;
				throw new Error("post-yield turn failure");
			};
		}
		const settings = Settings.isolated({ "compaction.enabled": false, "todo.enabled": false });
		settings.setModelRole("default", `${mock.model.provider}/${mock.model.id}`);
		session = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry,
			toolRegistry: new Map([["yield", sessionYieldTool]]),
			agentId: AGENT_ID,
			extensionRunner,
			ownedAsyncJobManager: args.manager,
		});
		if (args.parentId || args.driven) {
			AgentRegistry.global().register({
				id: AGENT_ID,
				displayName: AGENT_ID,
				kind: "sub",
				parentId: args.parentId,
				session,
				status: "idle",
			});
		}
		// A driven session has no wake observer yet, like a first run before its attach.
		if (!args.driven) {
			attachIrcWakeTurnMonitor(session, {
				id: AGENT_ID,
				agent: wakeAgent,
				eventBus,
				parentSessionId: "parent-session-1",
				parentSessionFile: "/parent/session.jsonl",
				artifactsDir: tempDir.path(),
				maxRuntimeMs: args.maxRuntimeMs,
				agentType: args.agentType,
				structured: args.structured,
				outputSchema: args.outputSchema,
			});
		}
		return { session, mock, stopEvents, lifecycle, eventBus, artifact: path.join(tempDir.path(), `${AGENT_ID}.md`) };
	}

	async function deliverWake(target: AgentSession, id: string, from = "peer"): Promise<void> {
		await target.deliverIrcMessage({ id, from, to: AGENT_ID, body: "status?", ts: Date.now() } as IrcMessage);
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

	it("reports the restored definition name as agent_type when the wake definition carries a ref label", async () => {
		const run = await setup({
			responses: [yieldCall("answer")],
			onStop: () => undefined,
			agentType: "reviewer",
		});

		await wake(run.session);

		expect(run.stopEvents).toHaveLength(1);
		expect(run.stopEvents[0]?.agent_type).toBe("reviewer");
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

	it("offers a yield the wake turn latched before the turn failed, instead of publishing it unjudged", async () => {
		const run = await setup({
			failWakeAfterTurn: true,
			responses: [yieldCall("REFUSED-PAYLOAD"), yieldCall("replacement")],
			onStop: (_event, callIndex) => (callIndex === 1 ? { decision: "block", reason: "keep going" } : undefined),
		});

		await wake(run.session);

		expect(run.stopEvents).toHaveLength(2);
		const artifact = await Bun.file(run.artifact).text();
		expect(artifact).toContain("replacement");
		expect(artifact).not.toContain("REFUSED-PAYLOAD");
	});

	it("offers sections a wake turn recorded before answering in prose, instead of publishing them unjudged", async () => {
		const run = await setup({
			// A section, then prose: no terminal yield, yet the sections are what finalization publishes.
			responses: [sectionCall("findings", "SECTION-PAYLOAD"), { content: ["done for now"] }, { content: ["still"] }],
			onStop: () => ({ decision: "block", reason: "not done" }),
		});

		await wake(run.session);

		expect(run.stopEvents).toHaveLength(1);
		expect(await Bun.file(run.artifact).exists()).toBe(false);
		expect(run.lifecycle.at(-1)?.status).toBe("failed");
	});

	describe("a structured:false child", () => {
		it("offers its reply to an owner wake before publishing it as the result", async () => {
			const run = await setup({
				structured: false,
				parentId: "Parent",
				responses: [{ content: ["REFUSED-REPLY"] }, { content: ["replacement reply"] }],
				onStop: (_event, callIndex) => (callIndex === 1 ? { decision: "block", reason: "keep going" } : undefined),
			});

			await deliverWake(run.session, "m1", "Parent");
			await run.session.waitForIrcReplies();
			await run.session.waitForIdle();

			expect(run.stopEvents.map(event => event.stop_hook_active)).toEqual([false, true]);
			const artifact = await Bun.file(run.artifact).text();
			expect(artifact).toContain("replacement reply");
			expect(artifact).not.toContain("REFUSED-REPLY");
		});

		it("fails an owner wake whose refused reply no continuation replaced", async () => {
			const run = await setup({
				structured: false,
				parentId: "Parent",
				responses: [{ content: ["REFUSED-REPLY"] }, { content: [""] }],
				onStop: () => ({ decision: "block", reason: "not done" }),
			});

			await deliverWake(run.session, "m1", "Parent");
			await run.session.waitForIrcReplies();
			await run.session.waitForIdle();

			expect(run.stopEvents).toHaveLength(1);
			expect(await Bun.file(run.artifact).exists()).toBe(false);
			expect(run.lifecycle.at(-1)?.status).toBe("failed");
		});

		it("does not offer a peer relay, which is not a result", async () => {
			const run = await setup({
				structured: false,
				parentId: "Parent",
				responses: [{ content: ["status is fine"] }],
				onStop: () => ({ decision: "block", reason: "not done" }),
			});

			await wake(run.session);

			expect(run.stopEvents).toHaveLength(0);
			expect(run.mock.calls).toHaveLength(1);
		});

		it("offers its reply to a focused user's prompt before publishing it as the result", async () => {
			const run = await setup({
				structured: false,
				parentId: "Parent",
				responses: [{ content: ["REFUSED-REPLY"] }, { content: ["replacement reply"] }],
				onStop: (_event, callIndex) => (callIndex === 1 ? { decision: "block", reason: "keep going" } : undefined),
			});

			// The focused-session input path: a plain user prompt on the idle child.
			await run.session.prompt("go on");
			await run.session.waitForIrcReplies();
			await run.session.waitForIdle();

			expect(run.stopEvents.map(event => event.stop_hook_active)).toEqual([false, true]);
			const artifact = await Bun.file(run.artifact).text();
			expect(artifact).toContain("replacement reply");
			expect(artifact).not.toContain("REFUSED-REPLY");
		});

		it("offers its reply to a parent follow-up it consumed during a peer wake", async () => {
			const peerTurnRunning = Promise.withResolvers<void>();
			const releasePeerTurn = Promise.withResolvers<void>();
			const run = await setup({
				structured: false,
				parentId: "Parent",
				responses: [
					async () => {
						peerTurnRunning.resolve();
						await releasePeerTurn.promise;
						return { content: ["peer answer"] };
					},
					// The parent's steer entered the turn: this reply is the result it asked for.
					{ content: ["REFUSED-REPLY"] },
					{ content: ["replacement reply"] },
				],
				onStop: (_event, callIndex) => (callIndex === 1 ? { decision: "block", reason: "keep going" } : undefined),
			});

			await deliverWake(run.session, "m1", "peer");
			await peerTurnRunning.promise;
			await deliverWake(run.session, "m2", "Parent");
			releasePeerTurn.resolve();
			await run.session.waitForIrcReplies();
			await run.session.waitForIdle();

			expect(run.stopEvents.map(event => event.stop_hook_active)).toEqual([false, true]);
			const artifact = await Bun.file(run.artifact).text();
			expect(artifact).toContain("replacement reply");
			expect(artifact).not.toContain("REFUSED-REPLY");
		});

		it("does not offer an owner wake's reply that ended on a provider error", async () => {
			const run = await setup({
				structured: false,
				parentId: "Parent",
				responses: [{ content: ["PARTIAL-REPLY"], stopReason: "error" }],
				onStop: () => ({ decision: "block", reason: "not done" }),
			});

			await deliverWake(run.session, "m1", "Parent");
			await run.session.waitForIrcReplies();
			await run.session.waitForIdle();

			expect(run.stopEvents).toHaveLength(0);
			expect(run.mock.calls).toHaveLength(1);
		});

		it("does not offer an owner wake's reply whose turn then failed", async () => {
			const run = await setup({
				structured: false,
				parentId: "Parent",
				failWakeAfterTurn: true,
				responses: [{ content: ["UNPUBLISHED-REPLY"] }],
				onStop: () => ({ decision: "block", reason: "not done" }),
			});

			await deliverWake(run.session, "m1", "Parent");
			await run.session.waitForIrcReplies();
			await run.session.waitForIdle();

			expect(run.stopEvents).toHaveLength(0);
			expect(run.mock.calls).toHaveLength(1);
		});
	});

	it("holds a newer wake until the refused wake's continuation is judged and published", async () => {
		const stopEntered = Promise.withResolvers<void>();
		const releaseStop = Promise.withResolvers<void>();
		const run = await setup({
			responses: [
				yieldCall("REFUSED-PAYLOAD"),
				yieldCall("CONTINUATION-PAYLOAD"),
				{ content: ["second wake reply"] },
			],
			onStop: async (_event, callIndex) => {
				if (callIndex > 1) return undefined;
				stopEntered.resolve();
				await releaseStop.promise;
				return { decision: "block", reason: "keep going" };
			},
		});

		await deliverWake(run.session, "m1");
		await stopEntered.promise;
		// The pass holds the idle child: the newer wake parks instead of taking the session.
		// Delivery routes the wake before it resolves, so the park is already decided here.
		await deliverWake(run.session, "m2");
		expect(run.mock.calls).toHaveLength(1);
		releaseStop.resolve();
		await run.session.waitForIrcReplies();
		await run.session.waitForIdle();

		// The continuation ran next and its yield was judged and published; only then did the newer wake run.
		expect(run.mock.calls).toHaveLength(3);
		expect(JSON.stringify(run.mock.calls[1]?.context.messages)).toContain("keep going");
		expect(run.stopEvents.map(event => event.stop_hook_active)).toEqual([false, true]);
		const artifact = await Bun.file(run.artifact).text();
		expect(artifact).toContain("CONTINUATION-PAYLOAD");
		expect(artifact).not.toContain("REFUSED-PAYLOAD");
	});

	it("stops a refusal continuation still running when the user resumes, and cancels the pass", async () => {
		const continuationStarted = Promise.withResolvers<void>();
		const run = await setup({
			responses: [
				yieldCall("REFUSED-PAYLOAD"),
				() => {
					continuationStarted.resolve();
					// A provider call that would outlast the test unless the turn is stopped.
					return { ...yieldCall("UNJUDGED-CONTINUATION"), delayMs: 60_000 };
				},
				{ content: ["resumed for the user"] },
			],
			onStop: () => ({ decision: "block", reason: "keep going" }),
		});

		await deliverWake(run.session, "m1");
		await continuationStarted.promise;
		await run.session.resume();
		await run.session.waitForIrcReplies();
		await run.session.waitForIdle();

		expect(run.stopEvents).toHaveLength(1);
		expect(await Bun.file(run.artifact).exists()).toBe(false);
		expect(run.lifecycle.map(frame => frame.status)).toContain("aborted");
		expect(run.lifecycle.map(frame => frame.status)).not.toContain("failed");
	});

	it("holds an extension's idle aside until the wake's result is published", async () => {
		const stopEntered = Promise.withResolvers<void>();
		const releaseStop = Promise.withResolvers<void>();
		let published: boolean | undefined;
		const run = await setup({
			responses: [
				yieldCall("WAKE-PAYLOAD"),
				async () => {
					published = await Bun.file(run.artifact).exists();
					return { content: ["handled the aside"] };
				},
			],
			onStop: async () => {
				stopEntered.resolve();
				await releaseStop.promise;
				return undefined;
			},
		});

		await deliverWake(run.session, "m1");
		await stopEntered.promise;
		const sent = run.session.sendCustomMessage(
			{ customType: "ext-aside", content: "extension aside", display: false },
			{ deliverAs: "aside" },
		);
		releaseStop.resolve();
		await sent;
		await run.session.waitForIrcReplies();
		await run.session.waitForIdle();

		expect(published).toBe(true);
		expect(await Bun.file(run.artifact).text()).toContain("WAKE-PAYLOAD");
	});

	it("fails a follow-up cancelled while it waits out a wake's stop pass, without running it", async () => {
		const stopEntered = Promise.withResolvers<void>();
		const releaseStop = Promise.withResolvers<void>();
		const run = await setup({
			driven: true,
			responses: [yieldCall("WAKE-PAYLOAD"), yieldCall("CANCELLED-FOLLOW-UP")],
			onStop: async () => {
				stopEntered.resolve();
				await releaseStop.promise;
				return undefined;
			},
		});
		attachIrcWakeTurnMonitor(run.session, { id: AGENT_ID, agent: wakeAgent, artifactsDir: tempDir.path() });

		await deliverWake(run.session, "m1");
		await stopEntered.promise;
		const controller = new AbortController();
		const followUp = runSubagentFollowUpTurn({
			id: AGENT_ID,
			agent: wakeAgent,
			message: "do more",
			signal: controller.signal,
			artifactsDir: tempDir.path(),
		});
		controller.abort();
		releaseStop.resolve();

		await expect(followUp).rejects.toThrow();
		await run.session.waitForIrcReplies();
		await run.session.waitForIdle();
		// The wake's judged yield is the result; the cancelled follow-up never reached the model.
		expect(run.mock.calls).toHaveLength(1);
		expect(await Bun.file(run.artifact).text()).toContain("WAKE-PAYLOAD");
	});

	it("lets a user prompt to the idle child cancel the pass, then runs the prompt", async () => {
		const stopEntered = Promise.withResolvers<void>();
		let handlerSawCancel = false;
		const run = await setup({
			responses: [yieldCall("UNJUDGED-PAYLOAD"), { content: ["hello, user"] }],
			onStop: async event => {
				stopEntered.resolve();
				const cancelled = Promise.withResolvers<void>();
				if (event.signal.aborted) cancelled.resolve();
				else event.signal.addEventListener("abort", () => cancelled.resolve(), { once: true });
				await cancelled.promise;
				handlerSawCancel = true;
				return { decision: "block", reason: "not done" };
			},
		});

		await deliverWake(run.session, "m1");
		await stopEntered.promise;
		await run.session.prompt("user says hi");
		await run.session.waitForIrcReplies();
		await run.session.waitForIdle();

		// The candidate was never judged: nothing is published, the wake turn is
		// cancelled rather than failed on a refusal, and the user's prompt ran after.
		expect(handlerSawCancel).toBe(true);
		expect(run.stopEvents).toHaveLength(1);
		expect(await Bun.file(run.artifact).exists()).toBe(false);
		expect(run.lifecycle.map(frame => frame.status)).toContain("aborted");
		expect(run.lifecycle.map(frame => frame.status)).not.toContain("failed");
		expect(run.mock.calls).toHaveLength(2);
		expect(JSON.stringify(run.mock.calls[1]?.context.messages)).toContain("user says hi");
	});

	it("cancels, unjudged, a wake that a newer wake superseded while its owner work settled", async () => {
		const manager = new AsyncJobManager({});
		AsyncJobManager.setInstance(manager);
		const gate = Promise.withResolvers<string>();
		const run = await setup({
			manager,
			responses: [
				yieldCall("OLDER-PAYLOAD"),
				{ content: ["newer wake reply"] },
				// The owner job's delivered result.
				{ content: ["noted the job result"] },
			],
			onStop: () => undefined,
		});
		// Owner background work keeps the first wake's observation open after its turn yielded.
		manager.register("bash", "bg build", ({ signal }) => untilAborted(signal, gate.promise).then(() => "ok"), {
			id: "bg-job",
			ownerId: AGENT_ID,
		});
		const olderEnded = Promise.withResolvers<string | undefined>();
		run.eventBus.on(TASK_SUBAGENT_LIFECYCLE_CHANNEL, data => {
			const status = toLifecycleFrame(data).status;
			if (status !== undefined && status !== "started") olderEnded.resolve(status);
		});

		try {
			await deliverWake(run.session, "m1");
			await run.session.waitForIdle();
			// The newer wake closes the still-settling observation before its pass could run.
			await deliverWake(run.session, "m2");

			expect(await olderEnded.promise).toBe("aborted");
			expect(run.stopEvents).toHaveLength(0);
			expect(await Bun.file(run.artifact).exists()).toBe(false);
		} finally {
			gate.resolve("ok");
			await run.session.waitForIrcReplies();
			await run.session.waitForIdle();
			await manager.waitForAll();
		}
	});

	it("judges a continuation's yield only after its owner async work quiesced", async () => {
		const manager = new AsyncJobManager({});
		AsyncJobManager.setInstance(manager);
		const gate = Promise.withResolvers<string>();
		const continuationYielded = Promise.withResolvers<void>();
		const run = await setup({
			manager,
			responses: [
				yieldCall("REFUSED-PAYLOAD"),
				() => {
					continuationYielded.resolve();
					return yieldCall("replacement");
				},
				// The delivered job result's turn: prose, no fresh yield.
				{ content: ["noted the job result"] },
			],
			onStop: (_event, callIndex) => {
				if (callIndex !== 1) return undefined;
				// The refusal's continuation will leave this job running when it yields.
				manager.register(
					"bash",
					"bg build",
					({ signal }) => untilAborted(signal, gate.promise).then(() => "build ok"),
					{
						id: "bg-job",
						ownerId: AGENT_ID,
					},
				);
				return { decision: "block", reason: "keep going" };
			},
		});

		const woken = wake(run.session);
		await continuationYielded.promise;
		// Leave the job running well past the continuation's turn, so only a settle
		// (not the turn merely ending) can carry the pass to the job's result.
		await Bun.sleep(200);
		expect(run.stopEvents).toHaveLength(1);
		gate.resolve("BUILD GREEN");
		await woken;

		// The replacement yield predates the job's result, so it was never judged
		// (judging it with the job pending would break "after owner work quiesced"),
		// and the result the settle delivered un-latched it: the turn fails closed.
		expect(run.stopEvents).toHaveLength(1);
		expect(await Bun.file(run.artifact).exists()).toBe(false);
		expect(run.lifecycle.at(-1)?.status).toBe("failed");
	});

	it("reports a wake turn cancelled while handlers were consulting as cancelled, not as a refusal", async () => {
		const manager = new AsyncJobManager({});
		AsyncJobManager.setInstance(manager);
		const stopEntered = Promise.withResolvers<void>();
		const run = await setup({
			manager,
			parentId: "Parent",
			maxRuntimeMs: 400,
			responses: [yieldCall("UNCONFIRMED-PAYLOAD")],
			onStop: async event => {
				stopEntered.resolve();
				// Hold the pass open until the wall-clock cap cancels the turn.
				const aborted = Promise.withResolvers<void>();
				if (event.signal.aborted) aborted.resolve();
				else event.signal.addEventListener("abort", () => aborted.resolve(), { once: true });
				await aborted.promise;
				return { decision: "block", reason: "not done" };
			},
		});

		await deliverWake(run.session, "m1", "Parent");
		await stopEntered.promise;
		const wakeJob = manager.getJob(AGENT_ID);
		await wakeJob?.promise;
		await run.session.waitForIrcReplies();
		await run.session.waitForIdle();

		expect(run.stopEvents).toHaveLength(1);
		// The job the parent waits on carries the turn's verdict.
		expect(wakeJob?.status).toBe("failed");
		expect(wakeJob?.errorText).toContain("Wake turn was cancelled");
		expect(wakeJob?.errorText).not.toContain("subagent_stop handler refused");
		expect(await Bun.file(run.artifact).exists()).toBe(false);
	});

	it("fails, rather than cancels, a wake turn whose unanswered refusal ended on an aborted turn", async () => {
		const run = await setup({
			// The continuation's turn itself ends aborted: no replacement yield, no cancel.
			responses: [yieldCall("REFUSED-PAYLOAD"), { content: ["cut off"], stopReason: "aborted" }],
			onStop: () => ({ decision: "block", reason: "not done" }),
		});

		await wake(run.session);

		expect(run.stopEvents).toHaveLength(1);
		expect(await Bun.file(run.artifact).exists()).toBe(false);
		// The refusal went unanswered: a failure, not an abort of the turn's work.
		expect(run.lifecycle.at(-1)?.status).toBe("failed");
	});

	it("runs a driven run's refusal continuation through its own hold", async () => {
		const run = await setup({
			driven: true,
			responses: [yieldCall("REFUSED-PAYLOAD"), yieldCall("REPLACEMENT")],
			onStop: (_event, callIndex) => (callIndex === 1 ? { decision: "block", reason: "keep going" } : undefined),
		});

		const result = await runSubagentFollowUpTurn({
			id: AGENT_ID,
			agent: wakeAgent,
			message: "do the work",
			artifactsDir: tempDir.path(),
			eventBus: run.eventBus,
		});

		expect(run.stopEvents.map(event => event.stop_hook_active)).toEqual([false, true]);
		expect(result.output).toContain("REPLACEMENT");
		expect(result.output).not.toContain("REFUSED-PAYLOAD");
	});

	it("holds an extension's turn-starting message until the wake's result is published", async () => {
		const releaseStop = Promise.withResolvers<void>();
		const stopEntered = Promise.withResolvers<void>();
		let published: boolean | undefined;
		const run = await setup({
			responses: [
				yieldCall("WAKE-PAYLOAD"),
				async () => {
					published = await Bun.file(run.artifact).exists();
					return { content: ["handled the extension message"] };
				},
			],
			onStop: async () => {
				stopEntered.resolve();
				await releaseStop.promise;
				return undefined;
			},
		});

		await deliverWake(run.session, "m1");
		await stopEntered.promise;
		const sent = run.session.sendCustomMessage(
			{ customType: "ext-note", content: "extension says hi", display: false },
			{ triggerTurn: true },
		);
		releaseStop.resolve();
		await sent;
		await run.session.waitForIrcReplies();
		await run.session.waitForIdle();

		// The extension's turn ran only after the judged yield was published.
		expect(run.mock.calls).toHaveLength(2);
		expect(published).toBe(true);
		expect(await Bun.file(run.artifact).text()).toContain("WAKE-PAYLOAD");
	});

	it("holds a parent wake that arrives while a driven run's handlers consult until the run publishes", async () => {
		const stopEntered = Promise.withResolvers<void>();
		const releaseStop = Promise.withResolvers<void>();
		const run = await setup({
			driven: true,
			parentId: "Parent",
			responses: [yieldCall("RUN-PAYLOAD"), { content: ["parent wake reply"] }],
			onStop: async () => {
				stopEntered.resolve();
				await releaseStop.promise;
				return undefined;
			},
		});

		const turn = runSubagentFollowUpTurn({
			id: AGENT_ID,
			agent: wakeAgent,
			message: "do the work",
			artifactsDir: tempDir.path(),
			eventBus: run.eventBus,
		});
		await stopEntered.promise;
		await deliverWake(run.session, "m1", "Parent");
		// The parent's message did not start a turn the run's monitor could take as its result.
		expect(run.mock.calls).toHaveLength(1);
		releaseStop.resolve();
		const result = await turn;
		await run.session.waitForIrcReplies();
		await run.session.waitForIdle();

		expect(result.output).toContain("RUN-PAYLOAD");
		expect(await Bun.file(run.artifact).text()).toContain("RUN-PAYLOAD");
		expect(run.stopEvents).toHaveLength(1);
		// Released after publishing, the parked wake got its own turn.
		expect(run.mock.calls).toHaveLength(2);
	});
});
