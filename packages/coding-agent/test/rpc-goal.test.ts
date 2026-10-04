import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { RpcClient } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";
import { RpcGoalController, type RpcGoalSession } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-goal";
import {
	isRpcSessionSettled,
	RpcSessionSettleWatcher,
	type RpcSettleSession,
	watchedScheduledTurnProbe,
} from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-session-settle";
import type { RpcSessionState } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";
import type { AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { GoalModeState } from "@oh-my-pi/pi-coding-agent/goals/state";
import { removeWithRetries, withTimeout } from "@oh-my-pi/pi-utils";

function nextMacrotask(): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setImmediate(resolve);
	return promise;
}

/**
 * The rejection of a request to the RPC child. Settled before `expect` sees it:
 * `expect(pending).rejects` against a live child-process request can stall until the
 * request times out (observed with Bun 1.4.2 on Windows).
 */
async function rejectionOf(request: Promise<unknown>): Promise<unknown> {
	return await request.then(
		() => new Error("expected the request to fail"),
		(error: unknown) => error,
	);
}

describe("RPC goal command", () => {
	let client: RpcClient | undefined;
	let directory: string | undefined;

	afterEach(async () => {
		await client?.stop();
		client = undefined;
		if (directory) await removeWithRetries(directory);
		directory = undefined;
	});

	async function start(options: {
		continuation: boolean;
		script?: "complete" | "idle" | "slow";
		plan?: boolean;
		persist?: boolean;
	}): Promise<RpcClient> {
		directory = await fs.mkdtemp(path.join(os.tmpdir(), "omp-rpc-goal-"));
		client = new RpcClient({
			command: [process.execPath, path.join(import.meta.dir, "fixtures", "goal-rpc-agent.ts")],
			cwd: directory,
			env: {
				PI_CODING_AGENT_DIR: directory,
				PI_NO_TITLE: "1",
				GOAL_RPC_CONTINUATION: options.continuation ? "1" : "0",
				GOAL_RPC_SCRIPT: options.script ?? "complete",
				GOAL_RPC_PLAN: options.plan ? "1" : "0",
				GOAL_RPC_PERSIST: options.persist ? "1" : "0",
			},
		});
		await client.start();
		return client;
	}

	test("get is a read without a model call; create activates the goal tool without prompting", async () => {
		const rpc = await start({ continuation: false });
		expect(await rpc.goal("get")).toEqual({ goal: null, state: null });
		expect((await rpc.getState()).goal).toBeNull();

		const created = await rpc.goal("create", { objective: "  ship it  ", tokenBudget: 5000 });
		expect(created.goal).toMatchObject({ objective: "ship it", status: "active", tokenBudget: 5000 });
		expect(created.state).toMatchObject({ enabled: true, mode: "active" });

		const state = await rpc.getState();
		expect(state.goal?.goal.objective).toBe("ship it");
		expect(state.dumpTools?.map(tool => tool.name)).toContain("goal");
		// Continuation is off: nothing ran, so no model turn happened.
		expect(state.messageCount).toBe(0);
		expect(state.isStreaming).toBe(false);
	}, 30_000);

	test("plan mode refuses create and resume", async () => {
		const rpc = await start({ continuation: true, plan: true });
		const refused = await rejectionOf(rpc.goal("create", { objective: "not while planning" }));
		expect(refused).toMatchObject({ command: "goal", message: "Exit plan mode before starting a goal." });
		const state = await rpc.getState();
		expect(state.goal).toBeNull();
		expect(state.messageCount).toBe(0);
	}, 30_000);

	test("continuation stops after a turn with no progress and the goal stays active", async () => {
		const rpc = await start({ continuation: true, script: "idle" });
		const settled = Promise.withResolvers<void>();
		const unsubscribe = rpc.onSessionSettled(() => settled.resolve());
		try {
			await rpc.goal("create", { objective: "loop forever" });
			await withTimeout(settled.promise, 15_000, "No-progress continuation never settled");
		} finally {
			unsubscribe();
		}
		const state = await rpc.getState();
		expect(state.goal?.goal.status).toBe("active");
		expect(state.isSettled).toBe(true);
		const continuations = (await rpc.getMessages()).filter(
			message => message.role === "custom" && message.customType === "goal-continuation",
		);
		expect(continuations).toHaveLength(1);
	}, 30_000);

	test("create refuses a second goal, a paused goal, and invalid input; pause/resume/drop restore tools", async () => {
		const rpc = await start({ continuation: false });
		const refused = { command: "goal" };
		expect(await rejectionOf(rpc.goal("create", { objective: "   " }))).toMatchObject(refused);
		expect(await rejectionOf(rpc.goal("create", { objective: "x", tokenBudget: 0 }))).toMatchObject(refused);
		expect(await rejectionOf(rpc.goal("resume"))).toMatchObject(refused);

		const toolsBefore = (await rpc.getState()).dumpTools?.map(tool => tool.name) ?? [];
		expect(toolsBefore).not.toContain("goal");
		await rpc.goal("create", { objective: "first" });
		expect(await rejectionOf(rpc.goal("create", { objective: "second" }))).toMatchObject(refused);

		const paused = await rpc.goal("pause");
		expect(paused.goal?.status).toBe("paused");
		expect((await rpc.getState()).dumpTools?.map(tool => tool.name)).toEqual(toolsBefore);
		expect(await rejectionOf(rpc.goal("create", { objective: "second" }))).toMatchObject(refused);

		const resumed = await rpc.goal("resume");
		expect(resumed.goal).toMatchObject({ objective: "first", status: "active" });
		expect((await rpc.getState()).dumpTools?.map(tool => tool.name)).toContain("goal");

		const dropped = await rpc.goal("drop");
		expect(dropped.goal).toBeNull();
		expect((await rpc.getState()).dumpTools?.map(tool => tool.name)).toEqual(toolsBefore);
		expect((await rpc.goal("create", { objective: "again" })).goal?.status).toBe("active");
	}, 30_000);

	test("with rpc continuation opted in, create drives turns until the agent completes the goal", async () => {
		const rpc = await start({ continuation: true });
		const updates: Array<string | undefined> = [];
		const settled = Promise.withResolvers<void>();
		const unsubscribe = rpc.onSessionEvent(event => {
			if (event.type === "goal_updated") updates.push(event.state?.goal.status ?? "none");
		});
		const unsubscribeSettled = rpc.onSessionSettled(() => settled.resolve());
		try {
			await rpc.goal("create", { objective: "finish the task" });
			await withTimeout(settled.promise, 15_000, "Goal continuation never settled");
		} finally {
			unsubscribe();
			unsubscribeSettled();
		}
		expect(updates).toContain("complete");
		const state = await rpc.getState();
		expect(state.goal).toBeNull();
		expect(state.isSettled).toBe(true);
		expect(state.dumpTools?.map(tool => tool.name)).not.toContain("goal");
		const messages = await rpc.getMessages();
		const continuations = messages.filter(
			message => message.role === "custom" && message.customType === "goal-continuation",
		);
		// One continuation after create, and a second after that turn yielded unfinished.
		expect(continuations).toHaveLength(2);
		// The goal tool, not a text prompt, completed it.
		expect(
			messages.some(
				message =>
					message.role === "toolResult" &&
					message.toolName === "goal" &&
					JSON.stringify(message.content).includes("complete"),
			),
		).toBe(true);
	}, 30_000);

	test("host abort of a continuation turn pauses the goal and starts no further goal turn", async () => {
		const rpc = await start({ continuation: true, script: "slow" });
		let agentStarts = 0;
		const started = Promise.withResolvers<void>();
		const unsubscribe = rpc.onSessionEvent(event => {
			if (event.type === "agent_start") {
				agentStarts++;
				started.resolve();
			}
		});
		let state: RpcSessionState;
		try {
			await rpc.goal("create", { objective: "long task" });
			await withTimeout(started.promise, 10_000, "Continuation turn never started");
			await rpc.abort();
			// A continuation escaping the abort is admitted synchronously one macrotask after
			// the aborted run's agent_end; this later round-trip would observe it as busy.
			state = await rpc.getState();
		} finally {
			unsubscribe();
		}
		expect(agentStarts).toBe(1);
		expect(state.goal?.goal.status).toBe("paused");
		expect(state.isStreaming).toBe(false);
		expect(state.isSettled).toBe(true);
	}, 30_000);

	test("a new session leaves the previous session's goal, goal tool and continuation behind", async () => {
		const rpc = await start({ continuation: true, script: "idle" });
		const toolsBefore = (await rpc.getState()).dumpTools?.map(tool => tool.name) ?? [];
		const firstSettle = Promise.withResolvers<void>();
		const unsubscribe = rpc.onSessionSettled(() => firstSettle.resolve());
		try {
			await rpc.goal("create", { objective: "belongs to the first session" });
			await withTimeout(firstSettle.promise, 15_000, "First session never settled");
		} finally {
			unsubscribe();
		}
		expect((await rpc.newSession()).cancelled).toBe(false);
		const state = await rpc.getState();
		expect(state.goal).toBeNull();
		expect(state.dumpTools?.map(tool => tool.name)).toEqual(toolsBefore);
		// A turn in the new session must not pick up the old objective's continuation.
		await rpc.promptAndWait("hello in the second session");
		const s2 = await rpc.getState();
		expect(s2.isSettled).toBe(true);
		const continuations = (await rpc.getMessages()).filter(
			message => message.role === "custom" && message.customType === "goal-continuation",
		);
		expect(continuations).toEqual([]);
		expect((await rpc.goal("create", { objective: "second session goal" })).goal?.status).toBe("active");
	}, 30_000);

	test("an extension command that starts a new session leaves the goal behind; navigation within the session keeps it", async () => {
		const rpc = await start({ continuation: false });
		await rpc.goal("create", { objective: "survives in-session navigation" });

		await rpc.promptAndWait("/goaltest-navigate-here");
		const kept = await rpc.getState();
		expect(kept.goal?.goal).toMatchObject({ objective: "survives in-session navigation", status: "active" });
		expect(kept.dumpTools?.map(tool => tool.name)).toContain("goal");

		await rpc.promptAndWait("/goaltest-new-session");
		const fresh = await rpc.getState();
		expect(fresh.goal).toBeNull();
		expect(fresh.dumpTools?.map(tool => tool.name)).not.toContain("goal");
	}, 30_000);

	async function branchAt(rpc: RpcClient, text: string): Promise<void> {
		const entry = (await rpc.getBranchMessages()).find(message => message.text === text);
		if (!entry) throw new Error(`No branch message "${text}"`);
		expect((await rpc.branch(entry.entryId)).cancelled).toBe(false);
	}

	async function untilSettled(rpc: RpcClient, label: string, action: () => Promise<unknown>): Promise<void> {
		const settled = Promise.withResolvers<void>();
		const unsubscribe = rpc.onSessionSettled(() => settled.resolve());
		try {
			await action();
			await withTimeout(settled.promise, 15_000, `${label} never settled`);
		} finally {
			unsubscribe();
		}
	}

	test("branching within the process keeps an active goal active", async () => {
		const rpc = await start({ continuation: false, script: "idle", persist: true });
		await rpc.promptAndWait("first");
		await rpc.goal("create", { objective: "survives a branch" });
		await rpc.promptAndWait("second");
		await rpc.promptAndWait("third");
		await branchAt(rpc, "third");

		const state = await rpc.getState();
		expect(state.goal?.goal).toMatchObject({ objective: "survives a branch", status: "active" });
		expect(state.goal?.enabled).toBe(true);
		expect(state.dumpTools?.map(tool => tool.name)).toContain("goal");
		const { entries } = await rpc.getEntries();
		// The branch journaled no pause.
		expect(entries.flatMap(entry => (entry.type === "mode_change" ? [entry.mode] : []))).toEqual(["goal"]);
	}, 30_000);

	test("with rpc continuation opted in, the goal continues in the branch", async () => {
		const rpc = await start({ continuation: true, script: "idle", persist: true });
		await untilSettled(rpc, "First prompt", () => rpc.promptAndWait("first"));
		// Each goal turn makes no progress, so one continuation follows create and each host prompt.
		await untilSettled(rpc, "Goal create", () => rpc.goal("create", { objective: "continues in the branch" }));
		await untilSettled(rpc, "Second prompt", () => rpc.promptAndWait("second"));
		// The branch keeps "first" and the create's continuation, and drops "second" and its continuation.
		await untilSettled(rpc, "Branch", () => branchAt(rpc, "second"));

		const state = await rpc.getState();
		expect(state.goal?.goal.status).toBe("active");
		expect(state.isSettled).toBe(true);
		const continuations = (await rpc.getMessages()).filter(
			message => message.role === "custom" && message.customType === "goal-continuation",
		);
		expect(continuations).toHaveLength(2);
	}, 30_000);

	test("an extension session change aborts the detached run's prompt; the command's own result is unaffected", async () => {
		const rpc = await start({ continuation: false, script: "slow" });
		const results = new Map<string, string>();
		const unsubscribe = rpc.onPromptResult(result => {
			if (result.id) results.set(result.id, result.status);
		});
		const started = Promise.withResolvers<void>();
		const unsubscribeEvents = rpc.onEvent(event => {
			if (event.type === "agent_start") started.resolve();
		});
		try {
			const first = await rpc.prompt("first, stalls");
			await withTimeout(started.promise, 10_000, "First run never started");
			// The command then starts a run of its own in the new session.
			await rpc.promptAndWait("/goaltest-new-session hello from the new session");
			// The detached run never yields; its prompt must still be closed, as aborted.
			await withTimeout(
				(async () => {
					while (!results.has(first)) await Bun.sleep(20);
				})(),
				10_000,
				"The detached run's prompt was never reported",
			);
			expect(results.get(first)).toBe("aborted");
			const state = await rpc.getState();
			expect(state.isSettled).toBe(true);
		} finally {
			unsubscribe();
			unsubscribeEvents();
		}
		expect([...results.values()].filter(status => status !== "aborted")).toEqual(["completed"]);
	}, 30_000);

	test("an extension navigation during a live run leaves that run's prompt to complete normally", async () => {
		const rpc = await start({ continuation: false, script: "slow" });
		const results = new Map<string, string>();
		const unsubscribe = rpc.onPromptResult(result => {
			if (result.id) results.set(result.id, result.status);
		});
		const started = Promise.withResolvers<void>();
		const unsubscribeEvents = rpc.onEvent(event => {
			if (event.type === "agent_start") started.resolve();
		});
		try {
			const first = await rpc.prompt("first, stalls");
			await withTimeout(started.promise, 10_000, "First run never started");
			// Navigation does not stop the run, so it must not close the run's prompt.
			await rpc.promptAndWait("/goaltest-navigate-here");
			expect(results.has(first)).toBe(false);
			await withTimeout(
				(async () => {
					while (!results.has(first)) await Bun.sleep(50);
				})(),
				20_000,
				"The running prompt was never reported",
			);
			expect(results.get(first)).toBe("completed");
		} finally {
			unsubscribe();
			unsubscribeEvents();
		}
	}, 40_000);

	test("an extension reload detaches the live run and closes its prompt as aborted", async () => {
		const rpc = await start({ continuation: false, script: "slow", persist: true });
		const results = new Map<string, string>();
		const unsubscribe = rpc.onPromptResult(result => {
			if (result.id) results.set(result.id, result.status);
		});
		const started = Promise.withResolvers<void>();
		const unsubscribeEvents = rpc.onEvent(event => {
			if (event.type === "agent_start") started.resolve();
		});
		try {
			const first = await rpc.prompt("first, stalls");
			await withTimeout(started.promise, 10_000, "First run never started");
			await rpc.promptAndWait("/goaltest-reload");
			await withTimeout(
				(async () => {
					while (!results.has(first)) await Bun.sleep(20);
				})(),
				5_000,
				"The detached run's prompt was never reported",
			);
			expect(results.get(first)).toBe("aborted");
			expect((await rpc.getState()).isSettled).toBe(true);
		} finally {
			unsubscribe();
			unsubscribeEvents();
		}
	}, 30_000);

	test("prompt_result reports the session unsettled when a goal continuation follows the prompt", async () => {
		const rpc = await start({ continuation: true, script: "idle" });
		const firstSettle = Promise.withResolvers<void>();
		const unsubscribeSettled = rpc.onSessionSettled(() => firstSettle.resolve());
		const results = new Map<string, boolean>();
		const unsubscribeResults = rpc.onPromptResult(result => {
			if (result.id) results.set(result.id, result.sessionSettled);
		});
		try {
			await rpc.goal("create", { objective: "keep going" });
			// The first continuation makes no progress, so the loop stops and the session settles.
			await withTimeout(firstSettle.promise, 15_000, "Initial continuation never settled");
			const events = await rpc.promptAndWait("host input re-arms the goal");
			expect(events.some(event => event.type === "agent_end")).toBe(true);
		} finally {
			unsubscribeSettled();
			unsubscribeResults();
		}
		// The host prompt re-armed continuation; a goal turn follows it, so the prompt's
		// own result must not claim the session settled.
		expect([...results.values()]).toEqual([false]);
	}, 30_000);
});

describe("RpcGoalController continuation gate", () => {
	const agentEnd = { type: "agent_end", messages: [], isTerminal: true } as unknown as AgentSessionEvent;
	const hostInput = { type: "message_start", message: { role: "user", content: [] } } as unknown as AgentSessionEvent;

	function fakeSession(admit: (customType: string) => Promise<boolean>) {
		let goalState: GoalModeState | undefined = {
			enabled: true,
			mode: "active",
			goal: {
				id: "g1",
				objective: "o",
				status: "active",
				tokensUsed: 0,
				timeUsedSeconds: 0,
				createdAt: 0,
				updatedAt: 0,
			},
		};
		let idle = Promise.withResolvers<void>();
		idle.resolve();
		const journal: string[] = [];
		let tools: string[] = ["read"];
		let journaledGoal = false;
		let resumed = Promise.withResolvers<void>();
		resumed.resolve();
		let threadResumes = 0;
		const preservedActive: boolean[] = [];
		const transcript = { id: "t1" };
		const session = {
			settings: Settings.isolated({ "goal.continuationModes": ["rpc"] }),
			// Provider-facing id pinned by the host: must not be used to detect a session change.
			sessionId: "pinned-provider-id",
			sessionManager: {
				getSessionId: () => transcript.id,
				buildSessionContext: () =>
					journaledGoal
						? {
								mode: "goal_paused",
								modeData: {
									goal: {
										id: "j1",
										objective: "journaled",
										status: "paused",
										tokensUsed: 0,
										timeUsedSeconds: 0,
										createdAt: 0,
										updatedAt: 0,
									},
								},
							}
						: { mode: "none" },
				appendModeChange: (mode: string) => journal.push(`${transcript.id}:mode:${mode}`),
				appendCustomEntry: (type: string) => journal.push(`${transcript.id}:${type}`),
			},
			isDisposed: false,
			isSessionTransitioning: false,
			isStreaming: false,
			hasAdmittedSubmission: false,
			queuedMessageCount: 0,
			hasPendingAsyncWork: () => false,
			settleAsyncWork: async () => {},
			getPlanModeState: () => undefined,
			getGoalModeState: () => goalState,
			setGoalModeState: (state: GoalModeState | undefined) => {
				goalState = state;
			},
			getEnabledToolNames: () => [...tools],
			setActiveToolsByName: async (names: string[]) => {
				tools = [...names];
			},
			getTodoPhases: () => [],
			goalRuntime: {
				buildContinuationPrompt: () => "continue",
				clearAccounting: () => {},
				onThreadResumed: async (options?: { preserveActiveGoal?: boolean }) => {
					threadResumes++;
					preservedActive.push(options?.preserveActiveGoal === true);
					await resumed.promise;
					return goalState;
				},
				createGoal: async ({ objective }: { objective: string }): Promise<GoalModeState> => ({
					enabled: true,
					mode: "active",
					goal: {
						id: "g2",
						objective,
						status: "active",
						tokensUsed: 0,
						timeUsedSeconds: 0,
						createdAt: 0,
						updatedAt: 0,
					},
				}),
			},
			promptCustomMessage: (message: { customType: string }) => admit(message.customType),
			waitForIdle: () => idle.promise,
		};
		let dropped = 0;
		const controller = new RpcGoalController(session as unknown as RpcGoalSession, () => dropped++);
		return {
			session,
			controller,
			journal,
			transcript,
			goalState: () => goalState,
			tools: () => tools,
			threadResumes: () => threadResumes,
			/** `preserveActiveGoal` of each `onThreadResumed` call, in order. */
			preservedActive: () => preservedActive,
			journalGoal: () => {
				journaledGoal = true;
			},
			holdResume: () => {
				resumed = Promise.withResolvers<void>();
			},
			releaseResume: () => resumed.resolve(),
			dropped: () => dropped,
			/** Hold waitForIdle until {@link release}. */
			hold: () => {
				idle = Promise.withResolvers<void>();
			},
			release: () => idle.resolve(),
		};
	}

	test("a continuation decided before the session closes is never admitted after it", async () => {
		const admitted: string[] = [];
		const { session, controller } = fakeSession(async customType => {
			admitted.push(customType);
			return true;
		});

		controller.observe(agentEnd);
		expect(controller.continuationPending).toBe(true);
		session.isDisposed = true;
		await nextMacrotask();
		expect(admitted).toEqual([]);
		expect(controller.continuationPending).toBe(false);

		// A host abort closes the gate before the aborted run's agent_end arrives.
		session.isDisposed = false;
		controller.stopForHostAbort();
		controller.observe(agentEnd);
		await nextMacrotask();
		expect(admitted).toEqual([]);

		// Host input re-arms it; the next yield continues exactly once.
		controller.observe(hostInput);
		controller.observe(agentEnd);
		controller.observe(agentEnd);
		await nextMacrotask();
		expect(admitted).toEqual(["goal-continuation"]);
	});

	test("a host abort of a continuation turn that ran a tool admits no further continuation", async () => {
		const admitted: string[] = [];
		const { controller } = fakeSession(async customType => {
			admitted.push(customType);
			return true;
		});
		const toolTurnEnd = {
			type: "agent_end",
			isTerminal: true,
			messages: [
				{ role: "assistant", content: [{ type: "toolCall", id: "t1", name: "read", arguments: { path: "a" } }] },
				{ role: "toolResult", toolName: "read", content: [{ type: "text", text: "x" }], isError: false },
			],
		} as unknown as AgentSessionEvent;

		// A yield admits continuation #1, so the next run is a continuation turn.
		controller.observe(agentEnd);
		await nextMacrotask();
		expect(admitted).toEqual(["goal-continuation"]);

		// The host aborts that turn after it ran a tool (new activity); its agent_end follows.
		controller.stopForHostAbort();
		controller.observe(toolTurnEnd);
		await nextMacrotask();
		expect(controller.continuationPending).toBe(false);
		expect(admitted).toEqual(["goal-continuation"]);
	});

	test("a turn that was not a continuation re-arms after a no-progress stop, but never after a host abort", async () => {
		const admitted: string[] = [];
		const { controller } = fakeSession(async customType => {
			admitted.push(customType);
			return true;
		});
		// Continuation #1 makes no progress, so continuation stops.
		controller.observe(agentEnd);
		await nextMacrotask();
		controller.observe(agentEnd);
		await nextMacrotask();
		expect(admitted).toEqual(["goal-continuation"]);
		expect(controller.continuationPending).toBe(false);

		// A turn nobody prompted (a delivery or job wake) ends: as in the TUI, the goal continues.
		controller.observe(agentEnd);
		await nextMacrotask();
		expect(admitted).toEqual(["goal-continuation", "goal-continuation"]);

		// After a host abort, such a turn does not re-arm; only host input does.
		controller.stopForHostAbort();
		controller.observe(agentEnd);
		controller.observe(agentEnd);
		await nextMacrotask();
		expect(admitted).toEqual(["goal-continuation", "goal-continuation"]);
		controller.observe(hostInput);
		controller.observe(agentEnd);
		await nextMacrotask();
		expect(admitted).toEqual(["goal-continuation", "goal-continuation", "goal-continuation"]);
	});

	test("a rejected continuation does not claim the next run as its own", async () => {
		let calls = 0;
		const { controller } = fakeSession(async () => {
			calls++;
			if (calls === 1) throw new Error("Agent is busy");
			return true;
		});

		controller.observe(agentEnd);
		await nextMacrotask();
		await nextMacrotask();
		expect(calls).toBe(1);
		// Another source's run ends without tool activity. It is not a continuation turn,
		// so it must not count as "no progress" and stop the goal loop.
		controller.observe(agentEnd);
		await nextMacrotask();
		expect(calls).toBe(2);
	});

	test("a continuation that finds the session busy or is refused releases settlement", async () => {
		let result = true;
		const admitted: string[] = [];
		const { session, controller, dropped } = fakeSession(async customType => {
			admitted.push(customType);
			return result;
		});

		// Another turn was admitted while the continuation waited: dropped, settle re-checked.
		session.hasAdmittedSubmission = true;
		controller.observe(agentEnd);
		await nextMacrotask();
		expect(admitted).toEqual([]);
		expect(dropped()).toBe(1);

		// Mid-transition: dropped the same way.
		session.hasAdmittedSubmission = false;
		session.isSessionTransitioning = true;
		controller.observe(agentEnd);
		await nextMacrotask();
		expect(admitted).toEqual([]);
		expect(dropped()).toBe(2);

		// Admitted but the session refuses to start it: no run follows, so settlement is released.
		session.isSessionTransitioning = false;
		result = false;
		controller.observe(agentEnd);
		await nextMacrotask();
		await nextMacrotask();
		expect(admitted).toEqual(["goal-continuation"]);
		expect(dropped()).toBe(3);
		expect(controller.continuationPending).toBe(false);
	});

	test("a change that stays in the same session holds, then resumes the goal without settling in between", async () => {
		const admitted: string[] = [];
		const { controller, hold, release, dropped } = fakeSession(async customType => {
			admitted.push(customType);
			return true;
		});

		hold();
		controller.observe(agentEnd);
		await controller.beginSessionChange();
		// The change may be cancelled and the goal resumed: still reported as pending.
		expect(controller.continuationPending).toBe(true);
		release();
		await nextMacrotask();
		// A run that yields during the change (for example while a before-switch hook waits) is held too.
		controller.observe(agentEnd);
		await nextMacrotask();
		expect(admitted).toEqual([]);
		const droppedDuringChange = dropped();

		// Same session afterwards (cancelled, or navigation within it): the goal resumes exactly once.
		await controller.endSessionChange();
		await nextMacrotask();
		expect(admitted).toEqual(["goal-continuation"]);
		expect(controller.continuationPending).toBe(false);
		// Settlement is re-checked only once the change has ended.
		expect(dropped()).toBeGreaterThan(droppedDuringChange);
	});

	test("a transcript switch is detected even when the host pins the provider session id", async () => {
		const admitted: string[] = [];
		const { controller, transcript, goalState } = fakeSession(async customType => {
			admitted.push(customType);
			return true;
		});
		await controller.beginSessionChange();
		transcript.id = "t2";
		await controller.endSessionChange();
		await nextMacrotask();
		// The old goal is left behind, and nothing continues it in the new transcript.
		expect(goalState()).toBeUndefined();
		expect(admitted).toEqual([]);
	});

	test("a goal completed while a switch is pending is journaled in its own session", async () => {
		const { session, controller, transcript, journal } = fakeSession(async () => true);
		await controller.beginSessionChange();
		// The goal tool completes the goal while a before-switch hook is still pending; the records
		// are journaled synchronously at that yield, before the switch can commit.
		const current = session.getGoalModeState();
		session.setGoalModeState(current && { ...current, enabled: false, mode: "exiting", reason: "completed" });
		controller.observe(agentEnd);
		// The switch commits before any queued exit work could run.
		transcript.id = "t2";
		await controller.settled();
		await controller.endSessionChange();
		expect(journal).toEqual(["t1:mode:none", "t1:goal-completed"]);
	});

	test("a session change with no goal turn to hold does not withhold settlement", async () => {
		const { session, controller } = fakeSession(async () => true);
		session.setGoalModeState(undefined);
		await controller.beginSessionChange();
		expect(controller.continuationPending).toBe(false);
		await controller.endSessionChange();
	});

	test("a goal created while a session change is in progress is held, not reported settled", async () => {
		const admitted: string[] = [];
		const { session, controller } = fakeSession(async customType => {
			admitted.push(customType);
			return true;
		});
		session.setGoalModeState(undefined);
		await controller.beginSessionChange();
		expect(controller.continuationPending).toBe(false);
		await controller.handle({ op: "create", objective: "during the change" });
		expect(controller.continuationPending).toBe(true);
		await nextMacrotask();
		expect(admitted).toEqual([]);
		await controller.endSessionChange();
		await nextMacrotask();
		expect(admitted).toEqual(["goal-continuation"]);
	});

	test("a pending goal turn reported during a change is always closed by session_settled", async () => {
		const frames: string[] = [];
		const { session, controller, transcript } = fakeSession(async () => true);
		session.setGoalModeState(undefined);
		// Same wiring as rpc-mode: the probe marks the watcher active whenever it reports pending.
		// The same probe rpc-mode wires: every "pending" answer marks the watcher active.
		const ref: { watcher?: RpcSessionSettleWatcher } = {};
		const probe = watchedScheduledTurnProbe(
			() => controller.continuationPending,
			() => ref.watcher,
		);
		const watcher = new RpcSessionSettleWatcher(
			session as unknown as ConstructorParameters<typeof RpcSessionSettleWatcher>[0],
			frame => frames.push(frame.type),
			probe,
		);
		ref.watcher = watcher;
		await controller.beginSessionChange();
		await controller.handle({ op: "create", objective: "held during the change" });
		expect(isRpcSessionSettled(session as unknown as RpcSettleSession, probe)).toBe(false);
		// The change switches away, so the held turn is abandoned and nothing will run.
		transcript.id = "t2";
		await controller.endSessionChange();
		await watcher.check();
		expect(isRpcSessionSettled(session as unknown as RpcSettleSession, probe)).toBe(true);
		expect(frames).toEqual(["session_settled"]);
	});

	test("a change that overlaps a running reconcile reconciles after it, never alongside it", async () => {
		const f = fakeSession(async () => true);
		f.session.setGoalModeState(undefined);
		f.journalGoal();
		// Change A switches t1 -> t2; its reconcile stalls inside onThreadResumed.
		f.holdResume();
		await f.controller.beginSessionChange();
		f.transcript.id = "t2";
		const endA = f.controller.endSessionChange();
		await nextMacrotask();
		expect(f.threadResumes()).toBe(1);
		// Change B begins and ends in the same transcript while A is still running.
		await f.controller.beginSessionChange();
		const endB = f.controller.endSessionChange();
		await nextMacrotask();
		// B queued a reconcile behind A instead of running one concurrently.
		expect(f.threadResumes()).toBe(1);
		f.releaseResume();
		await endA;
		await endB;
		await f.controller.settled();
		for (let i = 0; i < 5; i++) await nextMacrotask();
		expect(f.threadResumes()).toBe(2);
		// The pre-goal tool set was captured without the goal tool.
		expect(f.tools()).toEqual(["read", "goal"]);
		// When the goal later completes, exactly the pre-goal tools come back.
		const current = f.session.getGoalModeState();
		f.session.setGoalModeState(current && { ...current, enabled: false, mode: "exiting", reason: "completed" });
		f.controller.observe(agentEnd);
		await f.controller.settled();
		expect(f.tools()).toEqual(["read"]);
	});

	test("settled() waits for a reattach queued behind a running one", async () => {
		const f = fakeSession(async () => true);
		f.session.setGoalModeState(undefined);
		f.journalGoal();
		f.holdResume();
		// An extension change's reconcile is running (stalled in onThreadResumed).
		await f.controller.beginSessionChange();
		f.transcript.id = "t2";
		const endExtension = f.controller.endSessionChange();
		await nextMacrotask();
		// A host command's change ends meanwhile: its reattach is queued, not awaited.
		await f.controller.beginSessionChange();
		f.transcript.id = "t3";
		await f.controller.endSessionChange();
		let settled = false;
		const done = f.controller.settled().then(() => {
			settled = true;
		});
		await nextMacrotask();
		expect(settled).toBe(false);
		f.releaseResume();
		await endExtension;
		await done;
		expect(f.threadResumes()).toBe(2);
	});

	test("the startup reattach lets the runtime pause an active goal; an in-process change preserves it", async () => {
		const f = fakeSession(async () => true);
		f.journalGoal();
		await f.controller.reconcile();
		await f.controller.beginSessionChange();
		f.transcript.id = "t2";
		await f.controller.endSessionChange();
		await f.controller.settled();
		expect(f.preservedActive()).toEqual([false, true]);
	});

	test("a change that detached a continuation turn does not count the next turn as a continuation", async () => {
		const admitted: string[] = [];
		const { controller } = fakeSession(async customType => {
			admitted.push(customType);
			return true;
		});
		// A yield admits continuation #1.
		controller.observe(agentEnd);
		await nextMacrotask();
		expect(admitted).toEqual(["goal-continuation"]);

		// A reload reopens the same transcript and detaches that turn: its terminal agent_end never comes.
		await controller.beginSessionChange();
		await controller.endSessionChange({ detachedRun: true });
		await nextMacrotask();
		// The goal resumes with continuation #2, which makes no progress, so continuation stops.
		expect(admitted).toEqual(["goal-continuation", "goal-continuation"]);
		controller.observe(agentEnd);
		await nextMacrotask();
		expect(admitted).toHaveLength(2);

		// A turn nobody prompted ends. It is not a continuation (#1 was detached), so as after
		// any no-progress stop the goal continues.
		controller.observe(agentEnd);
		await nextMacrotask();
		expect(admitted).toEqual(["goal-continuation", "goal-continuation", "goal-continuation"]);
	});
});
