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

/** Rendezvous points of a stop pass held open while a wake turn overlaps it. */
interface OverlapGates {
	/** The first stop pass's handler is consulting. */
	stopEntered: PromiseWithResolvers<void>;
	/** The overlapping wake turn's model reply was served. */
	wakeYielded: PromiseWithResolvers<void>;
	/** Lets the first pass's handler answer. */
	releaseStop: PromiseWithResolvers<void>;
}

function createOverlapGates(): OverlapGates {
	return {
		stopEntered: Promise.withResolvers<void>(),
		wakeYielded: Promise.withResolvers<void>(),
		releaseStop: Promise.withResolvers<void>(),
	};
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
		if (args.failWakeAfterTurn) {
			const prompt = agent.prompt.bind(agent);
			let failed = false;
			agent.prompt = async (input: string | AgentMessage | AgentMessage[]) => {
				await (typeof input === "string" ? prompt(input) : prompt(input));
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
			toolRegistry: new Map([["yield", yieldTool]]),
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

	it("never lets a newer wake that is still settling publish a refused wake's continuation", async () => {
		const manager = new AsyncJobManager({});
		AsyncJobManager.setInstance(manager);
		const gate = Promise.withResolvers<string>();
		const stopEntered = Promise.withResolvers<void>();
		const releaseStop = Promise.withResolvers<void>();
		const secondWakeRan = Promise.withResolvers<void>();
		const refusalOutcome = Promise.withResolvers<void>();
		const run = await setup({
			manager,
			responses: [
				yieldCall("REFUSED-PAYLOAD"),
				() => {
					secondWakeRan.resolve();
					return { content: ["second wake reply"] };
				},
				// Whichever turn runs third: a refusal's continuation yields, anything else is prose.
				context => {
					if (!JSON.stringify(context.messages).includes("keep going"))
						return { content: ["noted the job result"] };
					refusalOutcome.resolve();
					return yieldCall("CONTINUATION-PAYLOAD");
				},
				{ content: ["noted the job result"] },
			],
			onStop: async (event, callIndex) => {
				if (callIndex > 1) return event.stop_hook_active ? { decision: "block", reason: "keep going" } : undefined;
				// The newer wake's turn ends while this job runs, so its observation stays open, settling.
				manager.register("bash", "bg build", ({ signal }) => untilAborted(signal, gate.promise).then(() => "ok"), {
					id: "bg-job",
					ownerId: AGENT_ID,
				});
				stopEntered.resolve();
				await releaseStop.promise;
				return { decision: "block", reason: "keep going" };
			},
		});
		run.eventBus.on(TASK_SUBAGENT_LIFECYCLE_CHANNEL, data => {
			if (toLifecycleFrame(data).status === "failed") refusalOutcome.resolve();
		});

		await deliverWake(run.session, "m1");
		await stopEntered.promise;
		await deliverWake(run.session, "m2");
		await secondWakeRan.promise;
		await run.session.waitForIdle();
		// The newer wake's turn has ended and its observation is still open. The
		// refusal now either starts a continuation or fails the refused wake.
		releaseStop.resolve();
		await refusalOutcome.promise;
		gate.resolve("BUILD GREEN");
		await run.session.waitForIrcReplies();
		await run.session.waitForIdle();
		await manager.waitForAll();

		// The newer wake owns the session: the refusal could not be answered, so no
		// continuation ran and no other observation judged or published its yield.
		const artifact = (await Bun.file(run.artifact).exists()) ? await Bun.file(run.artifact).text() : "";
		expect(artifact).not.toContain("REFUSED-PAYLOAD");
		expect(artifact).not.toContain("CONTINUATION-PAYLOAD");
		expect(run.stopEvents).toHaveLength(1);
		expect(run.mock.calls.map(call => JSON.stringify(call.context.messages)).join("\n")).not.toContain("keep going");
		expect(run.lifecycle.map(frame => frame.status)).toContain("failed");
	});

	it("drops an older wake's yield its handler allows only after a newer wake published", async () => {
		const stopEntered = Promise.withResolvers<void>();
		const releaseStop = Promise.withResolvers<void>();
		const newerPublished = Promise.withResolvers<void>();
		const run = await setup({
			responses: [yieldCall("OLDER-PAYLOAD"), yieldCall("NEWER-PAYLOAD")],
			onStop: async (_event, callIndex) => {
				// The newer wake's own pass allows at once.
				if (callIndex > 1) return undefined;
				stopEntered.resolve();
				await releaseStop.promise;
				return undefined;
			},
		});
		run.eventBus.on(TASK_SUBAGENT_LIFECYCLE_CHANNEL, data => {
			if (toLifecycleFrame(data).status === "completed") newerPublished.resolve();
		});

		await deliverWake(run.session, "m1");
		await stopEntered.promise;
		// The older pass is still consulting when the newer wake runs, yields and publishes.
		await deliverWake(run.session, "m2");
		await newerPublished.promise;
		expect(await Bun.file(run.artifact).text()).toContain("NEWER-PAYLOAD");
		releaseStop.resolve();
		await run.session.waitForIrcReplies();
		await run.session.waitForIdle();

		// The older handler allowed a candidate its observation no longer owns:
		// publishing it would overwrite the newer wake's result with a stale one.
		const artifact = await Bun.file(run.artifact).text();
		expect(artifact).toContain("NEWER-PAYLOAD");
		expect(artifact).not.toContain("OLDER-PAYLOAD");
		expect(run.lifecycle.map(frame => frame.status)).toContain("aborted");
	});

	it("stops a settling continuation from observing a newer wake's turn", async () => {
		const manager = new AsyncJobManager({});
		AsyncJobManager.setInstance(manager);
		const gate = Promise.withResolvers<string>();
		const continuationRan = Promise.withResolvers<void>();
		const newerWakeRan = Promise.withResolvers<void>();
		const run = await setup({
			manager,
			responses: [
				yieldCall("REFUSED-PAYLOAD"),
				() => {
					continuationRan.resolve();
					return yieldCall("CONTINUATION-PAYLOAD");
				},
				() => {
					newerWakeRan.resolve();
					return yieldCall("NEWER-PAYLOAD");
				},
				// The delivered job result's turn.
				{ content: ["noted the job result"] },
			],
			onStop: (_event, callIndex) => {
				if (callIndex > 1) return undefined;
				// Still running when the continuation's turn ends, so the continuation keeps settling.
				manager.register("bash", "bg build", ({ signal }) => untilAborted(signal, gate.promise).then(() => "ok"), {
					id: "bg-job",
					ownerId: AGENT_ID,
				});
				return { decision: "block", reason: "keep going" };
			},
		});

		await deliverWake(run.session, "m1");
		await continuationRan.promise;
		await run.session.waitForIdle();
		await deliverWake(run.session, "m2");
		await newerWakeRan.promise;
		await run.session.waitForIdle();
		gate.resolve("BUILD GREEN");
		await run.session.waitForIrcReplies();
		await run.session.waitForIdle();
		await manager.waitForAll();

		// The continuation's pass judged its own yield, not the newer wake's (which
		// never reached its monitor). The newer wake took the session meanwhile, so
		// the allowed continuation is dropped rather than published over that turn.
		expect(run.stopEvents.map(event => event.stop_hook_active)).toEqual([false, true]);
		const artifact = await Bun.file(run.artifact).text();
		expect(artifact).not.toContain("CONTINUATION-PAYLOAD");
		expect(artifact).not.toContain("REFUSED-PAYLOAD");
		expect(run.lifecycle.map(frame => frame.status)).toContain("aborted");
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

	// The stop pass of a driven run (initial or resumed) shares the kept-alive session with IRC
	// wakes: while its handlers consult, the child is idle and a peer message starts a turn that
	// the run's monitor, still attached, records. These pin that such a turn is never published
	// on a verdict that was about the candidate it replaced.
	describe("a driven run overlapped by a wake turn", () => {
		async function driveThroughWake(target: AgentSession, eventBus: EventBus, gates: OverlapGates) {
			const turn = runSubagentFollowUpTurn({
				id: AGENT_ID,
				agent: wakeAgent,
				message: "do the work",
				artifactsDir: tempDir.path(),
				eventBus,
			});
			await gates.stopEntered.promise;
			// The old candidate's handlers are still consulting; a wake turn yields a newer one.
			await deliverWake(target, "m1");
			await gates.wakeYielded.promise;
			await target.waitForIdle();
			gates.releaseStop.resolve();
			return await turn;
		}

		const wakeYield =
			(gates: OverlapGates): MockHandler =>
			() => {
				gates.wakeYielded.resolve();
				return yieldCall("WAKE-PAYLOAD");
			};

		it("judges the candidate a wake turn recorded while handlers were consulting the old one", async () => {
			const gates = createOverlapGates();
			const run = await setup({
				driven: true,
				responses: [yieldCall("OLD-PAYLOAD"), wakeYield(gates)],
				onStop: async (_event, callIndex) => {
					if (callIndex !== 1) return undefined;
					gates.stopEntered.resolve();
					await gates.releaseStop.promise;
					return undefined;
				},
			});

			const result = await driveThroughWake(run.session, run.eventBus, gates);

			// The first verdict was about OLD-PAYLOAD. WAKE-PAYLOAD may only be published after a
			// second pass saw the wake turn's transcript.
			expect(result.output).toContain("WAKE-PAYLOAD");
			expect(run.stopEvents).toHaveLength(2);
			expect(JSON.stringify(run.stopEvents[1]?.messages)).toContain("WAKE-PAYLOAD");
			expect(await Bun.file(run.artifact).text()).toContain("WAKE-PAYLOAD");
		});

		it("honors a refusal of the candidate the wake turn recorded", async () => {
			const gates = createOverlapGates();
			const run = await setup({
				driven: true,
				responses: [yieldCall("OLD-PAYLOAD"), wakeYield(gates), yieldCall("REPLACEMENT")],
				onStop: async (_event, callIndex) => {
					if (callIndex === 1) {
						gates.stopEntered.resolve();
						await gates.releaseStop.promise;
						return undefined;
					}
					return callIndex === 2 ? { decision: "block", reason: "redo the wake answer" } : undefined;
				},
			});

			const result = await driveThroughWake(run.session, run.eventBus, gates);

			expect(result.output).toContain("REPLACEMENT");
			expect(result.output).not.toContain("WAKE-PAYLOAD");
			expect(run.stopEvents.map(event => event.stop_hook_active)).toEqual([false, false, true]);
			const artifact = await Bun.file(run.artifact).text();
			expect(artifact).toContain("REPLACEMENT");
			expect(artifact).not.toContain("WAKE-PAYLOAD");
		});

		it("voids a refusal of the replaced candidate without spending the run's continuation state", async () => {
			const gates = createOverlapGates();
			const run = await setup({
				driven: true,
				responses: [yieldCall("OLD-PAYLOAD"), wakeYield(gates), yieldCall("CONTINUATION")],
				onStop: async (_event, callIndex) => {
					if (callIndex !== 1) return undefined;
					gates.stopEntered.resolve();
					await gates.releaseStop.promise;
					return { decision: "block", reason: "stale refusal" };
				},
			});

			const result = await driveThroughWake(run.session, run.eventBus, gates);

			// No continuation ran for a verdict on a candidate nobody would publish, and the pass that
			// judged the wake turn's candidate was not told this run had already been refused once.
			expect(run.mock.calls.map(call => JSON.stringify(call.context.messages)).join("\n")).not.toContain(
				"stale refusal",
			);
			expect(run.stopEvents.map(event => event.stop_hook_active)).toEqual([false, false]);
			expect(result.output).toContain("WAKE-PAYLOAD");
		});
	});
});
