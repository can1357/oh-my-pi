/**
 * `subagent_stop` on autonomous IRC wake turns, driven through a REAL
 * AgentSession (mock model, real extension runner, real turn-observer plumbing).
 *
 * The wake observer finishes after the session settled the turn, so the stop
 * pass re-drives the session from there. A fake session cannot show that a
 * nested prompt from the observer is safe — that it neither re-triggers the
 * observer nor races the session's settle — so these tests pin it end to end.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { scheduler } from "node:timers/promises";
import { cfgCompactionKeepRecentTokens } from "@oh-my-pi/pi-coding-agent/session/context-settings";
import { cfgRetryBaseDelayMs } from "@oh-my-pi/pi-coding-agent/session/settings";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentMessage, type AgentTool, TurnGateRefusedError } from "@oh-my-pi/pi-agent-core";
import { createMockModel, type MockHandler, type MockResponse } from "@oh-my-pi/pi-ai/providers/mock";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { ExtensionRuntime, loadExtensionFromFactory } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import type { SubagentStopEvent, SubagentStopEventResult } from "@oh-my-pi/pi-coding-agent/extensibility/shared-events";
import type { ExtensionContext } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import { initializeExtensions } from "@oh-my-pi/pi-coding-agent/modes/runtime-init";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { AgentSession, type StopPassHold } from "@oh-my-pi/pi-coding-agent/session/agent-session";
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
			ctx: ExtensionContext,
		) => SubagentStopEventResult | undefined | Promise<SubagentStopEventResult | undefined>;
		/** Owner async-job manager the session owns; the wake turn's owner jobs live here. */
		manager?: AsyncJobManager;
		/** Registry parent of the woken agent; waking it as that parent opens the wake job the parent waits on. */
		parentId?: string;
		/** Wall-clock cap on the wake turn, ms. */
		maxRuntimeMs?: number;
		/** Soft request budget of the wake turn (0 = none): stops its free-running turn at 1.5x. */
		softRequestBudget?: number;
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
		/** Turn automatic retry off, so a provider error leaves the turn for a manual retry. */
		disableAutoRetry?: boolean;
		/** Check usage health before each turn, a real await in every turn's setup. */
		usageAwareFallback?: boolean;
		/** Park every compaction pass in its `session_before_compact` hook until `gate`, and resolve `entered` on arrival. */
		holdCompaction?: { gate: Promise<void>; entered: PromiseWithResolvers<void> };
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
				pi.on("subagent_stop", async (event, ctx) => {
					stopEvents.push(event);
					return args.onStop(event, stopEvents.length, ctx);
				});
				pi.on("session_before_compact", async () => {
					args.holdCompaction?.entered.resolve();
					await args.holdCompaction?.gate;
					return { cancel: true };
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
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"todo.enabled": false,
			...(args.disableAutoRetry ? { "retry.enabled": false } : {}),
			...(args.usageAwareFallback ? { "retry.usageAwareFallback": true } : {}),
		});
		if (args.holdCompaction) cfgCompactionKeepRecentTokens.set(settings, 1);
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
				softRequestBudget: args.softRequestBudget,
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

		it.each(["error", "aborted"] as const)(
			"ends an owner wake as failed instead of offering again a refusal's continuation that ended on %s",
			async stopReason => {
				const run = await setup({
					structured: false,
					parentId: "Parent",
					disableAutoRetry: true,
					responses: [
						{ content: ["REFUSED-REPLY"] },
						// The continuation's partial text still counts as the monitor's report turn.
						{ content: ["PARTIAL-REPLY"], stopReason, errorMessage: "provider exploded" },
						{ content: ["would be a third request"] },
						{ content: ["would be a fourth request"] },
					],
					// An always-block handler: only a failed continuation can end the pass.
					onStop: (_event, callIndex) => (callIndex <= 3 ? { decision: "block", reason: "not done" } : undefined),
				});

				await deliverWake(run.session, "m1", "Parent");
				await run.session.waitForIrcReplies();
				await run.session.waitForIdle();

				// One verdict, one continuation: the failed reply is never offered a second time.
				expect(run.stopEvents).toHaveLength(1);
				expect(run.mock.calls).toHaveLength(2);
				expect(await Bun.file(run.artifact).exists()).toBe(false);
				expect(run.lifecycle.at(-1)?.status).toBe("failed");
			},
		);

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

		it("fails, publishing nothing, an owner wake whose refusal charged it into its request budget stop", async () => {
			const run = await setup({
				structured: false,
				parentId: "Parent",
				// Budget 1 stops the turn at 1.5 requests, which the refused reply's own cost reaches.
				softRequestBudget: 1,
				responses: [{ content: ["REFUSED-REPLY"] }, { content: ["UNOFFERED-REPLY"] }],
				onStop: () => ({ decision: "block", reason: "not done" }),
			});

			await deliverWake(run.session, "m1", "Parent");
			await run.session.waitForIrcReplies();
			await run.session.waitForIdle();

			// A refusal cannot be continued once the budget stop fired, so the turn fails instead of publishing it.
			expect(run.stopEvents).toHaveLength(1);
			expect(run.lifecycle.at(-1)?.status).not.toBe("completed");
			expect(await Bun.file(run.artifact).exists()).toBe(false);
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

		// A bare resume needs an earlier user turn to pick back up.
		run.session.agent.appendMessage({ role: "user", content: "earlier user turn", timestamp: Date.now() });
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

	it("does not start a continuation whose pass a user cancelled before its dispatch", async () => {
		const run = await setup({
			driven: true,
			responses: [{ content: ["answer to the user"] }],
			onStop: () => undefined,
		});
		const hold = run.session.holdForStopPass();

		// The user's prompt cancels the pass while the continuation's prompt is still in setup.
		const continuation = hold.prompt("CANCELLED-CONTINUATION", {
			attribution: "agent",
			synthetic: true,
			runCommands: false,
			throwOnDrop: true,
		});
		const userTurn = run.session.promptCustomMessage({
			customType: "user-note",
			content: "user says hi",
			display: true,
			attribution: "user",
		});
		await expect(continuation).rejects.toThrow();
		hold.release();
		await userTurn;
		await run.session.waitForIdle();

		// Only the user's turn reached the model.
		expect(run.mock.calls).toHaveLength(1);
		expect(JSON.stringify(run.mock.calls[0]?.context.messages)).not.toContain("CANCELLED-CONTINUATION");
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

	it("cancels a held stop pass when the user retries the turn, instead of letting its verdict cover the retry", async () => {
		const stopEntered = Promise.withResolvers<void>();
		const releaseStop = Promise.withResolvers<void>();
		const run = await setup({
			disableAutoRetry: true,
			responses: [
				// A section, then a provider error: the idle turn is retryable while its sections are judged.
				sectionCall("findings", "OLD-SECTION"),
				{ content: [], stopReason: "error", errorMessage: "provider exploded" },
				yieldCall("REPLACEMENT"),
			],
			onStop: async (event, callIndex) => {
				if (callIndex !== 1) return undefined;
				stopEntered.resolve();
				// Pending until the user's retry cancels the pass, or the test releases it.
				const cancelled = Promise.withResolvers<void>();
				event.signal.addEventListener("abort", () => cancelled.resolve(), { once: true });
				await Promise.race([releaseStop.promise, cancelled.promise]);
				return undefined;
			},
		});

		await deliverWake(run.session, "m1");
		await stopEntered.promise;
		expect(await run.session.retry()).toBe(true);
		await run.session.waitForIdle();
		releaseStop.resolve();
		await run.session.waitForIrcReplies();
		await run.session.waitForIdle();

		// The first verdict judged the old sections only: the retry's yield is a new candidate with its own pass.
		expect(run.stopEvents).toHaveLength(2);
		expect(await Bun.file(run.artifact).text()).toContain("REPLACEMENT");
	});

	/** Usage preflight health lookups park on `gate`: the real await a turn's setup spends before it dispatches. */
	function parkPreflight() {
		const gate = Promise.withResolvers<void>();
		const entered = Promise.withResolvers<void>();
		vi.spyOn(authStorage.health, "model").mockImplementation(async () => {
			entered.resolve();
			await gate.promise;
			return { state: "healthy", accounts: [] };
		});
		return { gate, entered };
	}

	describe("a turn whose setup outlasted a stop-pass hold taken after its hold check", () => {
		it("parks an idle aside for the hold's release instead of starting its turn inside the held pass", async () => {
			const preflight = parkPreflight();
			const run = await setup({
				driven: true,
				usageAwareFallback: true,
				responses: [{ content: ["handled the aside"] }],
				onStop: () => undefined,
			});

			const sent = run.session.sendCustomMessage(
				{ customType: "ext-aside", content: "extension aside", display: false },
				{ deliverAs: "aside" },
			);
			await preflight.entered.promise;
			// A wake's observation takes its hold while the aside's setup is still awaiting.
			const hold = run.session.holdForStopPass();
			preflight.gate.resolve();
			await sent;

			expect(run.mock.calls).toHaveLength(0);
			hold.release();
			await run.session.waitForIrcReplies();
			await run.session.waitForIdle();
			// The hold's release wakes for the parked aside: it is delayed, not lost.
			expect(run.mock.calls).toHaveLength(1);
			expect(JSON.stringify(run.mock.calls[0]?.context.messages)).toContain("extension aside");
		});

		it("drops an agent prompt rather than dispatching it inside the held pass", async () => {
			const preflight = parkPreflight();
			const run = await setup({
				driven: true,
				usageAwareFallback: true,
				responses: [{ content: ["never asked"] }],
				onStop: () => undefined,
			});

			const prompted = run.session.prompt("AGENT-PROMPT", {
				attribution: "agent",
				synthetic: true,
				throwOnDrop: true,
			});
			await preflight.entered.promise;
			const hold = run.session.holdForStopPass();
			preflight.gate.resolve();

			await expect(prompted).rejects.toThrow();
			expect(run.mock.calls).toHaveLength(0);
			hold.release();
		});

		it("hands back, without cancelling the pass, an agent-attributed prompt that is a user-role message", async () => {
			const preflight = parkPreflight();
			const run = await setup({
				driven: true,
				usageAwareFallback: true,
				responses: [{ content: ["never asked"] }],
				onStop: () => undefined,
			});

			// The executor's assignment: not synthetic, so a user-role message, but attributed to the agent.
			const prompted = run.session.prompt("AGENT-ASSIGNMENT", { attribution: "agent", throwOnDrop: true });
			await preflight.entered.promise;
			const hold = run.session.holdForStopPass();
			preflight.gate.resolve();

			await expect(prompted).rejects.toThrow();
			expect(hold.signal.aborted).toBe(false);
			expect(run.mock.calls).toHaveLength(0);
			hold.release();
		});

		it("cancels the pass for a user retry whose continuation was scheduled before the hold", async () => {
			const run = await setup({
				driven: true,
				disableAutoRetry: true,
				usageAwareFallback: true,
				responses: [{ content: [], stopReason: "error", errorMessage: "provider exploded" }, yieldCall("RETRIED")],
				onStop: () => undefined,
			});
			vi.spyOn(authStorage.health, "model").mockResolvedValue({ state: "healthy", accounts: [] });
			await run.session.prompt("first try");
			await run.session.waitForIdle();
			const preflight = parkPreflight();

			expect(await run.session.retry()).toBe(true);
			await preflight.entered.promise;
			// The pass starts after the retry passed its own hold check, while its continuation is still in setup.
			const hold = run.session.holdForStopPass();
			// A cancelled pass drops its candidate and releases afterwards, as the executor's does.
			hold.signal.addEventListener("abort", () => queueMicrotask(() => hold.release()), { once: true });
			preflight.gate.resolve();
			await run.session.waitForIdle();

			expect(hold.signal.aborted).toBe(true);
			expect(run.mock.calls).toHaveLength(2);
			hold.release();
		});

		it("skips a queued-message drain until the hold's release re-requests it", async () => {
			const preflight = parkPreflight();
			const answered = Promise.withResolvers<void>();
			const run = await setup({
				driven: true,
				usageAwareFallback: true,
				responses: [
					() => {
						answered.resolve();
						return { content: ["answered the queued message"] };
					},
				],
				onStop: () => undefined,
			});

			await run.session.sendUserMessage("QUEUED", { deliverAs: "steer" });
			await preflight.entered.promise;
			const hold = run.session.holdForStopPass();
			preflight.gate.resolve();
			await run.session.waitForIdle();

			expect(run.mock.calls).toHaveLength(0);
			hold.release();
			await answered.promise;
			await run.session.waitForIdle();
			expect(JSON.stringify(run.mock.calls[0]?.context.messages)).toContain("QUEUED");
		});

		it("keeps a follow-up's monitor off the holder's turn when the hold was taken while the follow-up installed its contract", async () => {
			const run = await setup({
				driven: true,
				responses: [yieldCall("HOLDER-YIELD"), yieldCall("FOLLOW-UP-YIELD")],
				onStop: () => undefined,
			});
			const holdTaken = Promise.withResolvers<StopPassHold>();
			const install = run.session.setWorkPoolYieldItems.bind(run.session);
			let held = false;
			vi.spyOn(run.session, "setWorkPoolYieldItems").mockImplementation(async items => {
				await install(items);
				if (held) return;
				held = true;
				// A wake's observation takes its hold while the follow-up is still installing its contract.
				holdTaken.resolve(run.session.holdForStopPass());
			});

			const followUp = runSubagentFollowUpTurn({
				id: AGENT_ID,
				agent: wakeAgent,
				message: "do more",
				artifactsDir: tempDir.path(),
			});
			const hold = await holdTaken.promise;
			// Real delay: the follow-up's attach-and-park is a chain of internal awaits no event marks; the
			// holder's continuation must start after it, as the pass's refusal continuation would.
			await Bun.sleep(20);
			await hold.prompt("continue", { attribution: "agent", synthetic: true, runCommands: false });
			hold.release();
			const result = await followUp;

			// The holder's yield belongs to the holder's pass; the follow-up's result is its own turn's.
			expect(result.output).toContain("FOLLOW-UP-YIELD");
			expect(result.extractedToolData?.yield).toHaveLength(1);
		});
	});

	describe("a hidden next-turn message that a stop-pass hold keeps from starting its turn", () => {
		const payloadOf = (call: { context: { messages: unknown } } | undefined): string =>
			JSON.stringify(call?.context.messages);
		const streaming = async (target: AgentSession): Promise<void> => {
			for (let tick = 0; !target.agent.state.isStreaming && tick < 100; tick++) await scheduler.yield();
		};

		it("runs it once the hold releases when it was queued during the holder's streaming continuation", async () => {
			const continuationGate = Promise.withResolvers<void>();
			const hiddenRan = Promise.withResolvers<void>();
			const run = await setup({
				driven: true,
				responses: [
					async () => {
						await continuationGate.promise;
						return { content: ["continuation done"] };
					},
					() => {
						hiddenRan.resolve();
						return { content: ["hidden turn ran"] };
					},
				],
				onStop: () => undefined,
			});
			const hold = run.session.holdForStopPass();
			const continuation = hold.prompt("continue", { attribution: "agent", synthetic: true, runCommands: false });
			await streaming(run.session);

			await run.session.sendCustomMessage(
				{ customType: "ext-next", content: "NEXT-TURN-PAYLOAD", display: false },
				{ deliverAs: "nextTurn", triggerTurn: true },
			);
			await scheduler.yield();
			continuationGate.resolve();
			await continuation;
			expect(run.mock.calls).toHaveLength(1);
			hold.release();
			await hiddenRan.promise;
			await run.session.waitForIdle();

			// The message was held back, not dropped: it ran as its own turn after the pass published.
			expect(run.mock.calls).toHaveLength(2);
			expect(payloadOf(run.mock.calls[1])).toContain("NEXT-TURN-PAYLOAD");
		});

		it("does not start it inside a hold taken while it waited behind a running turn, and runs it after the release", async () => {
			const turnGate = Promise.withResolvers<void>();
			const hiddenRan = Promise.withResolvers<void>();
			const run = await setup({
				driven: true,
				responses: [
					async () => {
						await turnGate.promise;
						return { content: ["first turn done"] };
					},
					() => {
						hiddenRan.resolve();
						return { content: ["hidden turn ran"] };
					},
				],
				onStop: () => undefined,
			});
			const first = run.session.prompt("first");
			await streaming(run.session);
			await run.session.sendCustomMessage(
				{ customType: "ext-next", content: "NEXT-TURN-PAYLOAD", display: false },
				{ deliverAs: "nextTurn", triggerTurn: true },
			);
			// Its prompt is now retrying behind the running turn.
			await scheduler.yield();
			// The turn's observer takes its hold as the turn ends.
			const hold = run.session.holdForStopPass();
			turnGate.resolve();
			await first;
			await scheduler.yield();

			expect(run.mock.calls).toHaveLength(1);
			hold.release();
			await hiddenRan.promise;
			await run.session.waitForIdle();
			expect(run.mock.calls).toHaveLength(2);
			expect(payloadOf(run.mock.calls[1])).toContain("NEXT-TURN-PAYLOAD");
		});

		it("keeps, in order, every message it and the prompt it handed back had taken", async () => {
			const turnGate = Promise.withResolvers<void>();
			const hiddenRan = Promise.withResolvers<void>();
			const run = await setup({
				driven: true,
				usageAwareFallback: true,
				responses: [
					async () => {
						await turnGate.promise;
						return { content: ["first turn done"] };
					},
					() => {
						hiddenRan.resolve();
						return { content: ["hidden turn ran"] };
					},
				],
				onStop: () => undefined,
			});
			vi.spyOn(authStorage.health, "model").mockResolvedValue({ state: "healthy", accounts: [] });
			const first = run.session.prompt("first");
			await streaming(run.session);
			const preflight = parkPreflight();
			await run.session.sendCustomMessage(
				{ customType: "ext-first", content: "FIRST-PAYLOAD", display: false },
				{ deliverAs: "nextTurn", triggerTurn: true },
			);
			await preflight.entered.promise;
			// Queued while the hidden turn's setup is parked: the turn takes it next, then is handed back.
			await run.session.sendCustomMessage(
				{ customType: "ext-second", content: "SECOND-PAYLOAD", display: false },
				{ deliverAs: "nextTurn" },
			);
			preflight.gate.resolve();
			await scheduler.yield();
			const hold = run.session.holdForStopPass();
			turnGate.resolve();
			await first;
			await scheduler.yield();

			expect(run.mock.calls).toHaveLength(1);
			hold.release();
			await hiddenRan.promise;
			await run.session.waitForIdle();
			const hiddenTurn = payloadOf(run.mock.calls[1]);
			expect(hiddenTurn).toContain("FIRST-PAYLOAD");
			expect(hiddenTurn).toContain("SECOND-PAYLOAD");
			expect(hiddenTurn.indexOf("FIRST-PAYLOAD")).toBeLessThan(hiddenTurn.indexOf("SECOND-PAYLOAD"));
		});

		it("is not run after an abort cancelled the turn the hold had deferred", async () => {
			const continuationGate = Promise.withResolvers<void>();
			const run = await setup({
				driven: true,
				responses: [
					async () => {
						await continuationGate.promise;
						return { content: ["continuation done"] };
					},
					{ content: ["must not run"] },
				],
				onStop: () => undefined,
			});
			const hold = run.session.holdForStopPass();
			const continuation = hold.prompt("continue", { attribution: "agent", synthetic: true, runCommands: false });
			const settled = continuation.then(
				() => undefined,
				() => undefined,
			);
			await streaming(run.session);
			await run.session.sendCustomMessage(
				{ customType: "ext-next", content: "NEXT-TURN-PAYLOAD", display: false },
				{ deliverAs: "nextTurn", triggerTurn: true },
			);
			await scheduler.yield();

			await run.session.abort();
			continuationGate.resolve();
			await settled;
			hold.release();
			await run.session.waitForIdle();
			await scheduler.yield();

			expect(run.mock.calls).toHaveLength(1);
		});

		it("runs it after a structured refusal's continuation yields and the executor stops that settled turn", async () => {
			const continuationStarted = Promise.withResolvers<void>();
			const continuationGate = Promise.withResolvers<void>();
			const run = await setup({
				responses: [
					yieldCall("REFUSED-PAYLOAD"),
					async () => {
						continuationStarted.resolve();
						await continuationGate.promise;
						return yieldCall("REPLACEMENT");
					},
					{ content: ["hidden turn ran"] },
				],
				onStop: (_event, callIndex) => (callIndex === 1 ? { decision: "block", reason: "keep going" } : undefined),
			});

			await deliverWake(run.session, "m1");
			await continuationStarted.promise;
			// Queued while the refusal's continuation streams: the pass holds the session, so the turn waits for it.
			await run.session.sendCustomMessage(
				{ customType: "ext-next", content: "NEXT-TURN-PAYLOAD", display: false },
				{ deliverAs: "nextTurn", triggerTurn: true },
			);
			await scheduler.yield();
			// The continuation's terminal yield ends the settled turn through an internal session abort.
			continuationGate.resolve();
			await run.session.waitForIrcReplies();
			await run.session.waitForIdle();
			for (let tick = 0; run.mock.calls.length < 3 && tick < 200; tick++) await scheduler.yield();

			// Judged and published first, then the deferred message ran as its own turn.
			expect(await Bun.file(run.artifact).text()).toContain("REPLACEMENT");
			expect(run.mock.calls).toHaveLength(3);
			expect(JSON.stringify(run.mock.calls[2]?.context.messages)).toContain("NEXT-TURN-PAYLOAD");
		});
	});

	describe("a submission that waits out a stop-pass hold and is aborted meanwhile", () => {
		// Their setup awaits only already-settled promises, so after one event-loop turn they are parked on the hold.
		it("drops an agent prompt instead of starting its turn once the hold releases", async () => {
			const run = await setup({ driven: true, responses: [{ content: ["never asked"] }], onStop: () => undefined });
			const hold = run.session.holdForStopPass();
			const prompted = run.session.prompt("AGENT-PROMPT", {
				attribution: "agent",
				synthetic: true,
				throwOnDrop: true,
			});
			const outcome = prompted.then(
				() => undefined,
				(error: unknown) => error,
			);
			await scheduler.yield();

			await run.session.abort();
			hold.release();

			// The drop surfaces as a rejection (throwOnDrop), and no turn ran.
			expect(await outcome).toBeInstanceOf(Error);
			expect(run.mock.calls).toHaveLength(0);
		});

		it("drops an agent custom prompt instead of starting its turn once the hold releases", async () => {
			const run = await setup({ driven: true, responses: [{ content: ["never asked"] }], onStop: () => undefined });
			const hold = run.session.holdForStopPass();
			const prompted = run.session.promptCustomMessage({
				customType: "agent-prompt",
				content: "AGENT-CUSTOM-PROMPT",
				display: false,
				attribution: "agent",
			});
			await scheduler.yield();

			await run.session.abort();
			hold.release();

			expect(await prompted).toBe(false);
			expect(run.mock.calls).toHaveLength(0);
		});

		it("records a turn-triggering custom message without its turn once the hold releases", async () => {
			const run = await setup({ driven: true, responses: [{ content: ["never asked"] }], onStop: () => undefined });
			const hold = run.session.holdForStopPass();
			const sent = run.session.sendCustomMessage(
				{ customType: "agent-note", content: "AGENT-NOTE", display: false, attribution: "agent" },
				{ triggerTurn: true },
			);
			await scheduler.yield();

			await run.session.abort();
			hold.release();
			await sent;
			await run.session.waitForIdle();

			expect(run.mock.calls).toHaveLength(0);
			expect(JSON.stringify(run.session.messages)).toContain("AGENT-NOTE");
		});

		it("still runs an agent prompt when only the internal stop of a settled turn landed during the wait", async () => {
			const run = await setup({ driven: true, responses: [{ content: ["asked"] }], onStop: () => undefined });
			const hold = run.session.holdForStopPass();
			const prompted = run.session.prompt("AGENT-PROMPT", { attribution: "agent", synthetic: true });
			await scheduler.yield();

			// The executor stops a turn that already yielded: the session goes on, so this is no cancellation.
			await run.session.abort({ turnStop: true });
			hold.release();
			await prompted;
			await run.session.waitForIdle();

			expect(run.mock.calls).toHaveLength(1);
			expect(JSON.stringify(run.mock.calls[0]?.context.messages)).toContain("AGENT-PROMPT");
		});

		it("still starts a turn-triggering custom message when only the internal stop of a settled turn landed during the wait", async () => {
			const run = await setup({ driven: true, responses: [{ content: ["asked"] }], onStop: () => undefined });
			const hold = run.session.holdForStopPass();
			const sent = run.session.sendCustomMessage(
				{ customType: "agent-note", content: "AGENT-NOTE", display: false, attribution: "agent" },
				{ triggerTurn: true },
			);
			await scheduler.yield();

			await run.session.abort({ turnStop: true });
			hold.release();
			await sent;
			await run.session.waitForIdle();

			expect(run.mock.calls).toHaveLength(1);
		});
	});

	it("keeps a follow-up that lost its prompt race to a wake off the wake's stop pass until the pass publishes", async () => {
		const stopEntered = Promise.withResolvers<void>();
		const releaseStop = Promise.withResolvers<void>();
		const run = await setup({
			driven: true,
			parentId: "Parent",
			responses: [yieldCall("WAKE-YIELD"), yieldCall("WAKE-REPLACEMENT"), yieldCall("FOLLOW-UP-YIELD")],
			onStop: async (_event, callIndex) => {
				if (callIndex !== 1) return undefined;
				stopEntered.resolve();
				await releaseStop.promise;
				return { decision: "block", reason: "keep going" };
			},
		});
		attachIrcWakeTurnMonitor(run.session, { id: AGENT_ID, agent: wakeAgent, artifactsDir: tempDir.path() });
		// The owner's wake takes the session between the follow-up's ownership check and its first prompt.
		const prompt = run.session.prompt.bind(run.session);
		let raced = false;
		vi.spyOn(run.session, "prompt").mockImplementation(async (text, options) => {
			if (!raced && text === "do more") {
				raced = true;
				await deliverWake(run.session, "m1", "Parent");
				for (let tick = 0; !run.session.agent.state.isStreaming && tick < 100; tick++) await scheduler.yield();
			}
			return prompt(text, options);
		});

		const followUp = runSubagentFollowUpTurn({
			id: AGENT_ID,
			agent: wakeAgent,
			message: "do more",
			artifactsDir: tempDir.path(),
		});
		await stopEntered.promise;
		releaseStop.resolve();
		const result = await followUp;

		// The wake's refused turn ended in a replacement yield; it belongs to the wake, not to the follow-up.
		expect(result.error).toBeUndefined();
		expect(result.extractedToolData?.yield).toHaveLength(1);
		expect(result.output).toContain("FOLLOW-UP-YIELD");
		expect(result.output).not.toContain("WAKE-REPLACEMENT");
	});

	describe("a stop pass whose session is interrupted", () => {
		it("starts no continuation when the session is aborted while a handler is still judging", async () => {
			const stopEntered = Promise.withResolvers<void>();
			const releaseStop = Promise.withResolvers<void>();
			const run = await setup({
				responses: [yieldCall("UNCONFIRMED-PAYLOAD"), yieldCall("UNWANTED-CONTINUATION")],
				onStop: async () => {
					stopEntered.resolve();
					await releaseStop.promise;
					return { decision: "block", reason: "keep going" };
				},
			});

			await deliverWake(run.session, "m1");
			await stopEntered.promise;
			await run.session.abort();
			releaseStop.resolve();
			await run.session.waitForIrcReplies();
			await run.session.waitForIdle();

			// The late `block` verdict came after the cancellation finished: it must not start a provider turn.
			expect(run.stopEvents).toHaveLength(1);
			expect(run.mock.calls).toHaveLength(1);
			expect(await Bun.file(run.artifact).exists()).toBe(false);
			expect(run.lifecycle.map(frame => frame.status)).toContain("aborted");
			expect(run.lifecycle.map(frame => frame.status)).not.toContain("failed");
		});

		it("starts no continuation when the handler itself interrupts through the extension's ctx.abort()", async () => {
			const run = await setup({
				responses: [yieldCall("UNCONFIRMED-PAYLOAD"), yieldCall("UNWANTED-CONTINUATION")],
				onStop: async (_event, _callIndex, ctx) => {
					await ctx.abort();
					return { decision: "block", reason: "keep going" };
				},
			});
			// The same wiring a running session gets: ctx.abort() is session.abort({ reason: USER_INTERRUPT_LABEL }).
			await initializeExtensions(run.session, { reportSendError: () => {}, reportRuntimeError: () => {} });

			await deliverWake(run.session, "m1");
			await run.session.waitForIrcReplies();
			await run.session.waitForIdle();

			expect(run.stopEvents).toHaveLength(1);
			expect(run.mock.calls).toHaveLength(1);
			expect(await Bun.file(run.artifact).exists()).toBe(false);
			expect(run.lifecycle.map(frame => frame.status)).toContain("aborted");
		});

		it("cancels the holds for an interrupt, but not for a turn-stop or a manual compaction's startup abort", async () => {
			const run = await setup({ driven: true, responses: [{ content: ["unused"] }], onStop: () => undefined });
			const hold = run.session.holdForStopPass();

			await run.session.abort({ turnStop: true });
			expect(hold.signal.aborted).toBe(false);
			await run.session.abort({ goalReason: "internal", preserveCompaction: true });
			expect(hold.signal.aborted).toBe(false);
			await run.session.abort();
			expect(hold.signal.aborted).toBe(true);
			hold.release();
		});

		it("runs a user skill prompt that cancels the pass while a continuation is running, instead of dropping it", async () => {
			const continuationStarted = Promise.withResolvers<void>();
			const run = await setup({
				driven: true,
				responses: [
					// The holder's continuation: a provider call that only the user's cancel ends.
					() => {
						continuationStarted.resolve();
						return { ...yieldCall("UNJUDGED-CONTINUATION"), delayMs: 60_000 };
					},
					{ content: ["answered the user"] },
				],
				onStop: () => undefined,
			});
			const hold = run.session.holdForStopPass();
			const continuation = hold.prompt("continue", { attribution: "agent", synthetic: true, runCommands: false });
			// The executor releases the hold once the cancelled pass has dropped its candidate.
			const released = continuation.then(
				() => hold.release(),
				() => hold.release(),
			);
			await continuationStarted.promise;

			// A user-invoked prompt waits for the hold before it looks at the session, so it reaches it while the
			// continuation is still running: its cancel stops that turn, which is not a cancellation of the prompt.
			const skill = await run.session.promptCustomMessage({
				customType: "skill-prompt",
				content: "USER-SKILL",
				display: true,
				attribution: "user",
			});
			await released;
			await run.session.waitForIdle();

			expect(skill).toBe(true);
			expect(hold.signal.aborted).toBe(true);
			expect(run.mock.calls).toHaveLength(2);
			expect(JSON.stringify(run.mock.calls[1]?.context.messages)).toContain("USER-SKILL");
		});
	});

	describe("a follow-up whose monitor must not observe another owner's turns", () => {
		const followUpOptions = () => ({
			id: AGENT_ID,
			agent: wakeAgent,
			message: "do more",
			artifactsDir: tempDir.path(),
		});

		it("does not attach across the wait for a hold a wake took while the follow-up's prompt was being sent", async () => {
			const run = await setup({
				driven: true,
				responses: [yieldCall("HOLDER-YIELD"), yieldCall("FOLLOW-UP-YIELD")],
				onStop: () => undefined,
			});
			const holdTaken = Promise.withResolvers<StopPassHold>();
			const prompt = run.session.prompt.bind(run.session);
			vi.spyOn(run.session, "prompt").mockImplementation(async (text, options) => {
				if (text === "do more") {
					// A wake's observation takes its hold after the follow-up passed its ownership waits, while its
					// prompt is on the way in: the prompt waits the hold out instead of losing a race.
					holdTaken.resolve(run.session.holdForStopPass());
				}
				return prompt(text, options);
			});

			const followUp = runSubagentFollowUpTurn(followUpOptions());
			const hold = await holdTaken.promise;
			// The holder's refusal continuation runs while the follow-up's prompt is parked behind the hold.
			await hold.prompt("continue", { attribution: "agent", synthetic: true, runCommands: false });
			hold.release();
			const result = await followUp;

			// The holder's yield belongs to the holder's pass: the follow-up's result is its own turn's alone.
			expect(result.error).toBeUndefined();
			expect(result.extractedToolData?.yield).toHaveLength(1);
			expect(result.output).toContain("FOLLOW-UP-YIELD");
			expect(result.output).not.toContain("HOLDER-YIELD");
		});

		it("detaches when a hold taken during prompt setup hands the prompt back, until its retry is admitted", async () => {
			const healthy = { state: "healthy" as const, accounts: [] };
			const preflightEntered = Promise.withResolvers<void>();
			const preflightGate = Promise.withResolvers<void>();
			const run = await setup({
				driven: true,
				usageAwareFallback: true,
				responses: [yieldCall("HOLDER-YIELD"), yieldCall("FOLLOW-UP-YIELD")],
				onStop: () => undefined,
			});
			// Only the follow-up's first prompt parks in its setup; the holder's continuation passes straight through.
			vi.spyOn(authStorage.health, "model")
				.mockImplementationOnce(async () => {
					preflightEntered.resolve();
					await preflightGate.promise;
					return healthy;
				})
				.mockResolvedValue(healthy);
			const handedBack = Promise.withResolvers<void>();
			const prompt = run.session.prompt.bind(run.session);
			vi.spyOn(run.session, "prompt").mockImplementation((text, options) => {
				const sent = prompt(text, options);
				if (text === "do more") sent.catch(() => handedBack.resolve());
				return sent;
			});

			const followUp = runSubagentFollowUpTurn(followUpOptions());
			await preflightEntered.promise;
			// The prompt is admitted and in setup when a wake's observation takes its hold: the prompt is handed back.
			const hold = run.session.holdForStopPass();
			preflightGate.resolve();
			await handedBack.promise;
			// The holder's continuation runs while the follow-up backs off, with its monitor admitted once already.
			await hold.prompt("continue", { attribution: "agent", synthetic: true, runCommands: false });
			hold.release();
			const result = await followUp;

			expect(result.error).toBeUndefined();
			expect(result.extractedToolData?.yield).toHaveLength(1);
			expect(result.output).toContain("FOLLOW-UP-YIELD");
		});
	});

	describe("a follow-up that does not own the session yet", () => {
		const followUpOptions = () => ({
			id: AGENT_ID,
			agent: wakeAgent,
			message: "do more",
			artifactsDir: tempDir.path(),
		});
		const item = { id: "batch#1", index: 0 };
		const healthy = { state: "healthy" as const, accounts: [] };

		/** A mock response that records how many pooled yield items the session holds when the model is called. */
		const recordingItems = (seen: number[], response: MockResponse): MockHandler => {
			return () => {
				seen.push(session?.getWorkPoolYieldItems().length ?? -1);
				return response;
			};
		};

		/** Parks the first usage preflight (the follow-up's prompt setup) until `gate` opens; the holder's passes through. */
		const parkFirstPreflight = (entered: PromiseWithResolvers<void>, gate: PromiseWithResolvers<void>): void => {
			vi.spyOn(authStorage.health, "model")
				.mockImplementationOnce(async () => {
					entered.resolve();
					await gate.promise;
					return healthy;
				})
				.mockResolvedValue(healthy);
		};

		it("does not install its pooled yield contract before its prompt is admitted past a hold", async () => {
			const seen: number[] = [];
			const run = await setup({
				driven: true,
				responses: [
					recordingItems(seen, yieldCall("HOLDER-YIELD")),
					recordingItems(seen, yieldCall("FOLLOW-UP-YIELD")),
				],
				onStop: () => undefined,
			});
			const holdTaken = Promise.withResolvers<StopPassHold>();
			const prompt = run.session.prompt.bind(run.session);
			vi.spyOn(run.session, "prompt").mockImplementation(async (text, options) => {
				// A wake's observation takes its hold after the follow-up passed its ownership waits, on its way
				// into the session: the prompt waits the hold out.
				if (text === "do more") holdTaken.resolve(run.session.holdForStopPass());
				return prompt(text, options);
			});

			const followUp = runSubagentFollowUpTurn({ ...followUpOptions(), workPoolYieldItems: [item] });
			const hold = await holdTaken.promise;
			// The holder's refusal continuation runs while the follow-up is parked behind the hold.
			await hold.prompt("continue", { attribution: "agent", synthetic: true, runCommands: false });
			hold.release();
			const result = await followUp;

			// The continuation ran under the contract it held; the follow-up's turn under its own.
			expect(seen).toEqual([0, 1]);
			expect(result.error).toBeUndefined();
			expect(result.output).toContain("FOLLOW-UP-YIELD");
			expect(result.output).not.toContain("HOLDER-YIELD");
		});

		it("runs a holder's continuation that overlaps its prompt setup instead of failing it as busy", async () => {
			const preflightEntered = Promise.withResolvers<void>();
			const preflightGate = Promise.withResolvers<void>();
			const run = await setup({
				driven: true,
				usageAwareFallback: true,
				responses: [yieldCall("HOLDER-YIELD"), yieldCall("FOLLOW-UP-YIELD")],
				onStop: () => undefined,
			});
			parkFirstPreflight(preflightEntered, preflightGate);

			const followUp = runSubagentFollowUpTurn(followUpOptions());
			await preflightEntered.promise;
			// The prompt is in its setup, in flight though the agent runs nothing, when a wake's observation takes its
			// hold and a fast verdict sends the refusal's continuation in.
			const hold = run.session.holdForStopPass();
			const continuation = hold.prompt("continue", {
				attribution: "agent",
				synthetic: true,
				runCommands: false,
				throwOnDrop: true,
			});
			preflightGate.resolve();
			// The overlapping setup is the one handed back: the holder's continuation waits for it and runs.
			await expect(continuation).resolves.toBe(true);
			hold.release();
			const result = await followUp;

			expect(run.mock.calls).toHaveLength(2);
			expect(result.error).toBeUndefined();
			expect(result.extractedToolData?.yield).toHaveLength(1);
			expect(result.output).toContain("FOLLOW-UP-YIELD");
			expect(result.output).not.toContain("HOLDER-YIELD");
		});

		it("puts its pooled yield contract back when a hold hands its prompt back, before the holder's continuation runs", async () => {
			const seen: number[] = [];
			const preflightEntered = Promise.withResolvers<void>();
			const preflightGate = Promise.withResolvers<void>();
			const run = await setup({
				driven: true,
				usageAwareFallback: true,
				responses: [
					recordingItems(seen, yieldCall("HOLDER-YIELD")),
					recordingItems(seen, yieldCall("FOLLOW-UP-YIELD")),
				],
				onStop: () => undefined,
			});
			parkFirstPreflight(preflightEntered, preflightGate);

			const followUp = runSubagentFollowUpTurn({ ...followUpOptions(), workPoolYieldItems: [item] });
			await preflightEntered.promise;
			// Admitted, the prompt owns the turn: its contract is in.
			expect(run.session.getWorkPoolYieldItems()).toHaveLength(1);
			const hold = run.session.holdForStopPass();
			const continuation = hold.prompt("continue", { attribution: "agent", synthetic: true, runCommands: false });
			preflightGate.resolve();
			await continuation;
			hold.release();
			const result = await followUp;

			// Handed back, the prompt left the session as it found it, so the continuation ran under the contract it
			// held; the retried prompt then ran under its own.
			expect(seen).toEqual([0, 1]);
			expect(result.error).toBeUndefined();
			expect(result.output).toContain("FOLLOW-UP-YIELD");
			expect(result.output).not.toContain("HOLDER-YIELD");
		});
	});
	describe("a stop-pass holder whose run is cancelled", () => {
		it("refuses a continuation once the run's abort signal fires", async () => {
			const run = await setup({ driven: true, responses: [{ content: ["UNWANTED"] }], onStop: () => undefined });
			const controller = new AbortController();
			const hold = run.session.holdForStopPass(controller.signal);

			controller.abort();

			expect(hold.signal.aborted).toBe(true);
			await expect(
				hold.prompt("CONTINUE", { attribution: "agent", synthetic: true, runCommands: false, throwOnDrop: true }),
			).rejects.toThrow();
			expect(run.mock.calls).toHaveLength(0);
			hold.release();
		});

		it("starts no continuation when the run is cancelled while the refusal's prompt waits out maintenance", async () => {
			const manager = new AsyncJobManager({});
			AsyncJobManager.setInstance(manager);
			const compaction = Promise.withResolvers<void>();
			const compactionEntered = Promise.withResolvers<void>();
			const run = await setup({
				manager,
				parentId: "Parent",
				holdCompaction: { gate: compaction.promise, entered: compactionEntered },
				responses: [yieldCall("REFUSED-PAYLOAD"), yieldCall("UNWANTED-CONTINUATION")],
				onStop: (_event, callIndex) => {
					if (callIndex !== 1) return undefined;
					// Idle compaction is in flight when the refusal's continuation sets up its prompt.
					void run.session.runIdleCompaction();
					return { decision: "block", reason: "keep going" };
				},
			});

			// The refusal's continuation has been handed to the hold, and is parked behind the compaction.
			const continuationPrompted = Promise.withResolvers<void>();
			const takeHold = run.session.holdForStopPass.bind(run.session);
			vi.spyOn(run.session, "holdForStopPass").mockImplementation(runSignal => {
				const hold = takeHold(runSignal);
				const prompt = hold.prompt;
				return {
					...hold,
					prompt: (text, options) => {
						continuationPrompted.resolve();
						return prompt(text, options);
					},
				};
			});

			await deliverWake(run.session, "m1", "Parent");
			await continuationPrompted.promise;
			const wakeJob = manager.getJob(AGENT_ID);
			// The wake job's cancellation (the parent's, a runtime limit or a teardown) aborts the run.
			manager.cancel(AGENT_ID);
			compaction.resolve();
			await wakeJob?.promise.catch(() => undefined);
			await run.session.waitForIrcReplies();
			await run.session.waitForIdle();

			expect(run.mock.calls).toHaveLength(1);
			expect(await Bun.file(run.artifact).exists()).toBe(false);
		});
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

	it("fails, rather than publishes unjudged, a wake yield an owner job's result superseded and prose answered", async () => {
		const manager = new AsyncJobManager({});
		AsyncJobManager.setInstance(manager);
		const gate = Promise.withResolvers<string>();
		const run = await setup({
			manager,
			responses: [
				() => {
					// The owner job finishes while the yield turn is still in flight.
					gate.resolve("BUILD GREEN");
					return yieldCall("STALE-PAYLOAD");
				},
				// The delivered job result's turn: prose, no fresh yield.
				{ content: ["noted the job result"] },
			],
			onStop: () => ({ decision: "block", reason: "not done" }),
		});
		manager.register("bash", "bg build", ({ signal }) => untilAborted(signal, gate.promise).then(() => "build ok"), {
			id: "bg-job",
			ownerId: AGENT_ID,
		});

		await wake(run.session);

		// The yield predates the job's result, so handlers can no longer judge it; an always-block
		// handler must not be bypassed by publishing it anyway.
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

	it("wakes for a peer message parked behind a hold once the hold an interrupt cancelled releases", async () => {
		const run = await setup({ driven: true, responses: [{ content: ["peer reply"] }], onStop: () => undefined });
		const hold = run.session.holdForStopPass();
		await deliverWake(run.session, "m1");
		expect(run.mock.calls).toHaveLength(0);

		await run.session.abort();
		hold.release();
		await run.session.waitForIrcReplies();
		await run.session.waitForIdle();

		// The interrupt cancelled the pass, not the peer's message: it still gets its turn.
		expect(run.mock.calls).toHaveLength(1);
	});

	describe("a turn that would change a held candidate under the verdict", () => {
		it("refuses an un-gated agent.continue() while a stop pass holds the session", async () => {
			const run = await setup({ driven: true, responses: [{ content: ["UNGATED"] }], onStop: () => undefined });
			run.session.agent.appendMessage({ role: "user", content: "earlier", timestamp: Date.now() });
			const hold = run.session.holdForStopPass();

			await expect(run.session.agent.continue()).rejects.toBeInstanceOf(TurnGateRefusedError);
			expect(run.mock.calls).toHaveLength(0);
			hold.release();
		});

		it("holds the automatic retry of a failed turn until the handlers judging the session return a verdict", async () => {
			let hold: StopPassHold | undefined;
			const run = await setup({
				driven: true,
				responses: [
					() => {
						// Handlers start judging the session while the turn that will be retried still streams.
						hold = run.session.holdForStopPass();
						hold.consult();
						return { content: [], stopReason: "error", errorMessage: "503 service unavailable" };
					},
					{ content: ["retried"] },
				],
				onStop: () => undefined,
			});
			// Backoff of 1 ms: without the hold the retry reaches the model within the polling below.
			cfgRetryBaseDelayMs.set(run.session.settings, 1);
			const retryScheduled = Promise.withResolvers<void>();
			run.session.subscribe(event => {
				if (event.type === "auto_retry_start") retryScheduled.resolve();
			});

			const prompted = run.session.prompt("first", { attribution: "agent" });
			await retryScheduled.promise;
			for (let tick = 0; run.mock.calls.length < 2 && tick < 200; tick++) await scheduler.yield();
			expect(run.mock.calls).toHaveLength(1);
			hold?.release();
			await prompted;
			await run.session.waitForIdle();

			expect(run.mock.calls).toHaveLength(2);
		});
	});
});
