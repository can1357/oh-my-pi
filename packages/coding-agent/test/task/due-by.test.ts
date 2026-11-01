/**
 * Contracts: the due-by of a dispatched subagent, seen from the agents above it.
 *
 * A dispatcher names when it expects a child's result (`dueMinutes`). The
 * clock runs outside the owner's turn, because an owner inside a blocking
 * `task` call reads nothing until the call returns.
 *
 * 1. A hung background child: its idle owner's model is told at the due-by,
 *    not before, and the child keeps running; its result still arrives.
 * 2. A hung blocking child whose owner is a subagent: the owner cannot read,
 *    so at twice the due-by the owner's own dispatcher is told, with the
 *    owner named as blocked; the owner never sees a notice gone stale.
 * 3. The same for a top-level owner: its owner is the person, told by a UI
 *    warning.
 * 4. A child that finishes before its due-by produces no notice anywhere.
 * 5. A child that fails loudly is reported as today, with no due-by notice.
 * 6. With the notices turned off (`task.dueMinutes: 0`), cancelling a child
 *    leaves no unhandled rejection to take the host down.
 * 7. Cancelling a blocking call stops its clock at once, even while the
 *    cancelled child is still winding down.
 * 8. An id is a name, not an identity. An ancestor removed and replaced
 *    after dispatch by an unrelated agent under the same id is skipped: the
 *    escalation reaches the original live agent above it. An owner replaced
 *    the same way is never told; the escalation still goes up the chain.
 * 9. A child started speculatively, while its call still streams, is on the
 *    clock from its start, and adoption by the finished call adds no second
 *    clock.
 * 10. A notice reaches the conversation that dispatched the work. A dispatcher
 *    whose session replaced its conversation since (`/new`, a switch to
 *    another transcript) is skipped like a replaced one, whether the notice
 *    fires after the change or was queued before it and read after. A fork
 *    continues the conversation and is still told.
 * 11. With no recorded dispatcher live, the person is warned at a main session
 *    only while it is the one recorded at dispatch.
 * 12. A session given its own agent registry is told: the clock runs on the
 *    registry the dispatching session uses.
 * 13. `proc://` shows a running subagent's due-by, and says when one has none
 *    (a turn a message started).
 *
 * Due-bys here are a fraction of a second and the clock runs on real timers:
 * the session's idle flush and the agent loop's interrupt poll, which carry
 * the notice to the model, run on the same real clock, so faking timers
 * would change the delivery path under test.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import type { AgentToolCall, SpeculativeOperationSink } from "@oh-my-pi/pi-agent-core";
import * as path from "node:path";
import { setImmediate } from "node:timers/promises";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Context } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { ProcProtocolHandler } from "@oh-my-pi/pi-coding-agent/internal-urls/proc-protocol";
import { parseInternalUrl } from "@oh-my-pi/pi-coding-agent/internal-urls/parse";
import { type AgentKind, AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { AgentSession, type AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TaskTool } from "@oh-my-pi/pi-coding-agent/task";
import type { TaskLaunchSession } from "@oh-my-pi/pi-coding-agent/task/speculative-launch";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import * as executorModule from "@oh-my-pi/pi-coding-agent/task/executor";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import type { SingleResult } from "@oh-my-pi/pi-tui/tools/task";
import { TempDir } from "@oh-my-pi/pi-utils";

const OWNER_NOTICE = "is taking longer than you said";
const ESCALATION = "is taking more than twice as long as";
const DUE_MINUTES = 0.005; // 300 ms
const DUE_MS = DUE_MINUTES * 60_000;
const TEST_TIMEOUT_MS = 20_000;
/**
 * For the cases that must produce no notice: a child that settles at once
 * still takes several hundred milliseconds to settle on a loaded machine,
 * which would pass the 300 ms due-by legitimately.
 */
const SLACK_DUE_MINUTES = 0.04; // 2.4 s
const SLACK_DUE_MS = SLACK_DUE_MINUTES * 60_000;

const zeroUsage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
} satisfies AssistantMessage["usage"];

/** Owner-visible record of one agent: every model request, and the UI notices of its session. */
interface Observed {
	session: AgentSession;
	task: TaskTool;
	/** The tool session its task tool runs in. */
	toolSession: ToolSession;
	contexts: Context[];
	notices: Array<Extract<AgentSessionEvent, { type: "notice" }>>;
	/** Resolves with the request time once a model request contains `needle`. */
	seen(needle: string): Promise<number>;
	saw(needle: string): boolean;
	/** Resolves once a UI notice contains `needle`. */
	warned(needle: string): Promise<void>;
	/** How many messages of the latest model request contain `needle`. */
	count(needle: string): number;
}

function aborted(signal: AbortSignal | undefined): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	if (!signal || signal.aborted) resolve();
	else signal.addEventListener("abort", () => resolve(), { once: true });
	return promise;
}

function childResult(id: string, agent: string, overrides: Partial<SingleResult> = {}): SingleResult {
	return {
		index: 0,
		id,
		agent,
		agentSource: "bundled",
		task: "t",
		assignment: "Work.",
		exitCode: 0,
		output: "CHILD_DONE",
		stderr: "",
		truncated: false,
		durationMs: 1,
		tokens: 0,
		requests: 1,
		...overrides,
	};
}

describe("subagent due-by", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let manager: AsyncJobManager;
	const sessions: AgentSession[] = [];
	/** Releases the hung child; the test resolves it before teardown. */
	let child: PromiseWithResolvers<SingleResult>;
	let childStarted: PromiseWithResolvers<AbortSignal | undefined>;

	beforeEach(async () => {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		tempDir = TempDir.createSync("@pi-due-by-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		authStorage.keys.setRuntime("openai", "openai-test-key");
		manager = new AsyncJobManager({});
		child = Promise.withResolvers<SingleResult>();
		childStarted = Promise.withResolvers<AbortSignal | undefined>();
		vi.spyOn(discoveryModule, "discoverAgents").mockResolvedValue({
			agents: [
				{ name: "task", description: "Background worker", systemPrompt: "Work.", source: "bundled" },
				{ name: "gate", description: "Blocking gate", systemPrompt: "Gate.", source: "bundled", blocking: true },
			],
			projectAgentsDir: null,
		});
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
			childStarted.resolve(options.signal);
			const result = await child.promise;
			return { ...result, id: options.id ?? result.id, agent: options.agent.name };
		});
	});

	afterEach(async () => {
		child.resolve(childResult("Late", "task"));
		vi.restoreAllMocks();
		for (const session of sessions.splice(0)) await session.dispose();
		await manager.dispose({ timeoutMs: 1_000 });
		authStorage.close();
		tempDir.removeSync();
		AsyncJobManager.resetForTests();
		AgentLifecycleManager.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
	});

	/** A real agent session whose first model turn makes `dispatch` its task call. */
	async function agent(options: {
		id: string;
		kind: AgentKind;
		parentId?: string;
		dispatch?: Record<string, unknown>;
		settings?: Record<string, unknown>;
		/** Registry the session and its task tool use; the process-global one by default. */
		registry?: AgentRegistry;
		/** Keep the transcript on disk, so the session can fork or switch away from it. */
		persist?: boolean;
		/** Every model response waits for this before it streams. */
		hold?: Promise<void>;
	}): Promise<Observed> {
		const model = createMockModel({ provider: "openai", id: "gpt-test" }).model;
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"todo.enabled": false,
			"launch.enabled": false,
			"async.enabled": true,
			"task.batch": false,
			...options.settings,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);
		const registry = options.registry ?? AgentRegistry.global();
		const toolSession = {
			cwd: tempDir.path(),
			hasUI: false,
			settings,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			getAgentId: () => options.id,
			agentRegistry: registry,
			asyncJobManager: manager,
		} as unknown as ToolSession;
		const task = await TaskTool.create(toolSession);
		const contexts: Context[] = [];
		const waiters: Array<{ needle: string; resolve: (at: number) => void }> = [];
		const agentCore = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [task as unknown as AgentTool], messages: [] },
			convertToLlm,
			streamFn: (_model, context) => {
				contexts.push(context);
				const text = JSON.stringify(context.messages);
				for (const waiter of waiters.splice(0)) {
					if (text.includes(waiter.needle)) waiter.resolve(Date.now());
					else waiters.push(waiter);
				}
				const dispatching = contexts.length === 1 && options.dispatch !== undefined;
				const message: AssistantMessage = {
					role: "assistant",
					content: dispatching
						? [{ type: "toolCall", id: `${options.id}-task`, name: "task", arguments: options.dispatch! }]
						: [{ type: "text", text: "ok" }],
					api: model.api,
					provider: model.provider,
					model: model.id,
					usage: zeroUsage,
					stopReason: dispatching ? "toolUse" : "stop",
					timestamp: Date.now(),
				};
				const stream = new AssistantMessageEventStream();
				queueMicrotask(async () => {
					await options.hold;
					stream.push({ type: "start", partial: message });
					stream.push({ type: "done", reason: dispatching ? "toolUse" : "stop", message });
				});
				return stream;
			},
		});
		const session = new AgentSession({
			agent: agentCore,
			sessionManager: options.persist
				? SessionManager.create(tempDir.path(), path.join(tempDir.path(), "sessions"))
				: SessionManager.inMemory(tempDir.path()),
			settings,
			modelRegistry: new ModelRegistry(authStorage),
			toolRegistry: new Map([["task", task as unknown as AgentTool]]),
			agentId: options.id,
			agentRegistry: registry,
			asyncJobManager: manager,
		});
		sessions.push(session);
		registry.register({
			id: options.id,
			displayName: options.id,
			kind: options.kind,
			parentId: options.parentId,
			session,
		});
		const notices: Observed["notices"] = [];
		session.subscribe(event => {
			if (event.type === "notice") notices.push(event);
		});
		return {
			session,
			task,
			toolSession,
			contexts,
			notices,
			seen: needle => {
				const { promise, resolve } = Promise.withResolvers<number>();
				if (contexts.some(context => JSON.stringify(context.messages).includes(needle))) resolve(Date.now());
				else waiters.push({ needle, resolve });
				return promise;
			},
			saw: needle => contexts.some(context => JSON.stringify(context.messages).includes(needle)),
			warned: needle => {
				const { promise, resolve } = Promise.withResolvers<void>();
				if (notices.some(notice => notice.message.includes(needle))) resolve();
				session.subscribe(event => {
					if (event.type === "notice" && event.message.includes(needle)) resolve();
				});
				return promise;
			},
			count: needle =>
				(contexts.at(-1)?.messages ?? []).filter(message => JSON.stringify(message).includes(needle)).length,
		};
	}

	const dispatch = (agentType: "task" | "gate", name: string, dueMinutes = DUE_MINUTES) => ({
		name,
		agent: agentType,
		task: "Work.",
		solutionSpace: "one fix: given",
		dueMinutes,
	});

	it(
		"tells an idle owner at the due-by that a hung background child is taking longer, and stops nothing",
		async () => {
			const owner = await agent({ id: "Main", kind: "main", dispatch: dispatch("task", "Hung") });
			const dispatchedAt = Date.now();
			const run = owner.session.prompt("dispatch");
			const childSignal = await childStarted.promise;
			await run;

			const toldAt = await owner.seen(OWNER_NOTICE);
			expect(toldAt - dispatchedAt).toBeGreaterThanOrEqual(DUE_MS);
			const notice = owner.contexts.find(context => JSON.stringify(context.messages).includes(OWNER_NOTICE))!;
			expect(JSON.stringify(notice.messages)).toContain("`Hung` (task)");
			expect(JSON.stringify(notice.messages)).toContain("Nothing was stopped");
			// The person at this top-level session is next in line.
			expect(JSON.stringify(notice.messages)).toContain("the person running this session is told");
			expect(childSignal?.aborted).toBe(false);
			expect(manager.getJob("Hung")?.status).toBe("running");

			// The work was not discarded: its result still reaches the owner.
			child.resolve(childResult("Hung", "task", { output: "HUNG_CHILD_RESULT" }));
			await owner.seen("HUNG_CHILD_RESULT");
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"escalates to the owner's dispatcher at twice the due-by while the owner is blocked in the call",
		async () => {
			const boss = await agent({ id: "Boss", kind: "main" });
			const lead = await agent({ id: "Lead", kind: "sub", parentId: "Boss", dispatch: dispatch("gate", "Gate") });
			const dispatchedAt = Date.now();
			const run = lead.session.prompt("dispatch");
			await childStarted.promise;

			const escalatedAt = await boss.seen(ESCALATION);
			expect(escalatedAt - dispatchedAt).toBeGreaterThanOrEqual(2 * DUE_MS);
			const escalation = JSON.stringify(boss.contexts.at(-1)!.messages);
			expect(escalation).toContain("`Gate` (gate), dispatched by `Lead`");
			expect(escalation).toContain("`Lead` is inside the call that waits for it");
			expect(escalation).toContain("Nothing was stopped");
			// Lead is inside the blocking call: its model has made no request since dispatching.
			expect(lead.contexts).toHaveLength(1);

			child.resolve(childResult("Gate", "gate", { output: "GATE_RESULT" }));
			await run;
			await lead.session.waitForIdle();
			// The call returned with the result; the notice queued for Lead while it
			// was blocked described a child that has since finished, so it is dropped.
			expect(lead.saw("GATE_RESULT")).toBe(true);
			expect(lead.saw(OWNER_NOTICE)).toBe(false);
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"warns the person at a blocked top-level owner at twice the due-by",
		async () => {
			const owner = await agent({ id: "Main", kind: "main", dispatch: dispatch("gate", "Gate") });
			const run = owner.session.prompt("dispatch");
			await childStarted.promise;

			const { promise: warned, resolve } = Promise.withResolvers<void>();
			owner.session.subscribe(event => {
				if (event.type === "notice" && event.message.includes(ESCALATION)) resolve();
			});
			if (!owner.notices.some(notice => notice.message.includes(ESCALATION))) await warned;
			const warning = owner.notices.find(notice => notice.message.includes(ESCALATION))!;
			expect(warning.level).toBe("warning");
			expect(warning.message).toContain("`Main` is inside the call that waits for it");
			expect(owner.contexts).toHaveLength(1);

			child.resolve(childResult("Gate", "gate"));
			await run;
			await owner.session.waitForIdle();
			expect(owner.saw(OWNER_NOTICE)).toBe(false);
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"produces no notice for a child that finishes before its due-by",
		async () => {
			const boss = await agent({ id: "Boss", kind: "main" });
			const lead = await agent({
				id: "Lead",
				kind: "sub",
				parentId: "Boss",
				dispatch: dispatch("task", "Quick", SLACK_DUE_MINUTES),
			});
			child.resolve(childResult("Quick", "task", { output: "QUICK_RESULT" }));
			const dispatchedAt = Date.now();
			await lead.session.prompt("dispatch");
			await lead.seen("QUICK_RESULT");
			// Wait past both stages of the clock (real time, see the file header).
			await Bun.sleep(Math.max(0, dispatchedAt + 2 * SLACK_DUE_MS + 500 - Date.now()));
			await lead.session.waitForIdle();
			for (const observed of [boss, lead]) {
				expect(observed.saw(OWNER_NOTICE)).toBe(false);
				expect(observed.saw(ESCALATION)).toBe(false);
				expect(observed.notices).toEqual([]);
			}
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"reports a loudly failing child as before, with no due-by notice",
		async () => {
			const owner = await agent({
				id: "Main",
				kind: "main",
				dispatch: dispatch("task", "Broken", SLACK_DUE_MINUTES),
			});
			child.resolve(childResult("Broken", "task", { exitCode: 1, error: "LOUD_FAILURE", output: "" }));
			const dispatchedAt = Date.now();
			await owner.session.prompt("dispatch");
			// Today's loud path: the owner reads the failed result as a background-job notice.
			await owner.seen('<task-result id=\\"Broken\\" agent=\\"task\\" status=\\"failed (exit 1)\\"');
			expect(manager.getJob("Broken")?.status).toBe("failed");
			await Bun.sleep(Math.max(0, dispatchedAt + 2 * SLACK_DUE_MS + 500 - Date.now()));
			await owner.session.waitForIdle();
			expect(owner.saw(OWNER_NOTICE)).toBe(false);
			expect(owner.notices.filter(notice => notice.message.includes(ESCALATION))).toEqual([]);
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"leaves no unhandled rejection when a child is cancelled with the notices turned off",
		async () => {
			const rejections: unknown[] = [];
			const onRejection = (reason: unknown) => rejections.push(reason);
			process.on("unhandledRejection", onRejection);
			try {
				const { dueMinutes: _stated, ...unstated } = dispatch("task", "Quiet");
				const owner = await agent({
					id: "Main",
					kind: "main",
					dispatch: unstated,
					settings: { "task.dueMinutes": 0 },
				});
				await owner.session.prompt("dispatch");
				await childStarted.promise;
				expect(manager.cancel("Quiet")).toBe(true);
				// Unhandled rejections are reported once the microtask queue drains.
				await setImmediate();
				await setImmediate();
				child.resolve(childResult("Quiet", "task"));
				await manager.getJob("Quiet")?.promise;
				await setImmediate();
				expect(rejections).toEqual([]);
				expect(manager.getJob("Quiet")?.status).toBe("cancelled");
				expect(owner.saw(OWNER_NOTICE)).toBe(false);
			} finally {
				process.off("unhandledRejection", onRejection);
			}
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"stops the clock when a blocking call is cancelled, while its child is still winding down",
		async () => {
			const boss = await agent({ id: "Boss", kind: "main" });
			const lead = await agent({ id: "Lead", kind: "sub", parentId: "Boss", dispatch: dispatch("gate", "Gate") });
			const run = lead.session.prompt("dispatch").catch(() => {});
			const childSignal = await childStarted.promise;
			const stopping = lead.session.abort();
			await aborted(childSignal);
			// The mocked child ignores the abort and has not returned; wait past
			// both stages of the clock (real time, see the file header).
			await Bun.sleep(2 * DUE_MS + 500);
			expect(boss.saw(ESCALATION)).toBe(false);
			expect(boss.notices).toEqual([]);
			expect(lead.notices.filter(notice => notice.message.includes(ESCALATION))).toEqual([]);
			child.resolve(childResult("Gate", "gate"));
			await stopping;
			await run;
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"skips a replacement that reuses a removed ancestor's id, then escalates to the live original ancestor",
		async () => {
			const boss = await agent({ id: "Boss", kind: "main" });
			const registry = AgentRegistry.global();
			registry.register({ id: "Mid", displayName: "Mid", kind: "sub", parentId: "Boss", session: null });
			const lead = await agent({ id: "Lead", kind: "sub", parentId: "Mid", dispatch: dispatch("gate", "Gate") });
			const run = lead.session.prompt("dispatch");
			await childStarted.promise;
			registry.unregister("Mid");
			// Same id, different lifetime: the new Mid must never receive Lead's
			// old escalation. It happens to use Other's live session here.
			const replacement = await agent({ id: "Other", kind: "main" });
			registry.register({
				id: "Mid",
				displayName: "Replacement Mid",
				kind: "sub",
				parentId: "Other",
				session: replacement.session,
			});

			const recipient = await Promise.race([
				boss.seen(ESCALATION).then(() => "Boss"),
				replacement.seen(ESCALATION).then(() => "replacement"),
			]);
			expect(recipient).toBe("Boss");
			expect(boss.contexts).toHaveLength(1);
			expect(JSON.stringify(boss.contexts.at(-1)!.messages)).toContain("dispatched by `Lead`");
			expect(replacement.saw(ESCALATION)).toBe(false);
			expect(lead.notices.filter(notice => notice.message.includes(ESCALATION))).toEqual([]);
			child.resolve(childResult("Gate", "gate"));
			await run;
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"never tells a replacement that reuses the owner's id, and escalates to the owner's live dispatcher",
		async () => {
			const boss = await agent({ id: "Boss", kind: "main" });
			const lead = await agent({ id: "Lead", kind: "sub", parentId: "Boss", dispatch: dispatch("task", "Slow") });
			await lead.session.prompt("dispatch");
			await childStarted.promise;
			const registry = AgentRegistry.global();
			registry.unregister("Lead");
			const replacement = await agent({ id: "Other", kind: "main" });
			registry.register({
				id: "Lead",
				displayName: "Replacement Lead",
				kind: "sub",
				parentId: "Other",
				session: replacement.session,
			});

			const recipient = await Promise.race([
				boss.seen(ESCALATION).then(() => "Boss"),
				replacement.seen(OWNER_NOTICE).then(() => "replacement"),
			]);
			expect(recipient).toBe("Boss");
			const escalation = JSON.stringify(boss.contexts.at(-1)!.messages);
			expect(escalation).toContain("dispatched by `Lead`");
			expect(escalation).toContain("so no notice was queued for it");
			expect(replacement.saw(OWNER_NOTICE)).toBe(false);
			expect(lead.saw(OWNER_NOTICE)).toBe(false);
			child.resolve(childResult("Slow", "task"));
			await manager.getJob("Slow")?.promise;
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"names the agent the escalation will reach, and says the owner's notice was queued, not read",
		async () => {
			const boss = await agent({ id: "Boss", kind: "main" });
			const lead = await agent({ id: "Lead", kind: "sub", parentId: "Boss", dispatch: dispatch("task", "Slow") });
			await lead.session.prompt("dispatch");
			await childStarted.promise;

			await lead.seen(OWNER_NOTICE);
			expect(JSON.stringify(lead.contexts.at(-1)!.messages)).toContain(
				"the nearest live agent above you is told (now `Boss`)",
			);
			await boss.seen(ESCALATION);
			const escalation = JSON.stringify(boss.contexts.at(-1)!.messages);
			expect(escalation).toContain("A notice for `Lead` was queued at");
			expect(escalation).not.toContain("was told");
			child.resolve(childResult("Slow", "task", { output: "SLOW_RESULT" }));
			await lead.seen("SLOW_RESULT");
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"starts the clock of a speculatively launched child at its launch, and adoption adds no second clock",
		async () => {
			const owner = await agent({ id: "Main", kind: "main", settings: { "task.batch": true } });
			const sink: SpeculativeOperationSink = {
				maxInFlight: 2,
				admit: async () => undefined,
				authorizeLaunch: async () => ({ allowed: true }),
				close: () => {},
			};
			const toolCall: AgentToolCall = { type: "toolCall", id: "spec-tc", name: "task", arguments: {} };
			const args = { context: "ctx", tasks: [dispatch("task", "Spec")] };
			const launch = (await owner.task.speculation.stream?.open({
				coordinator: sink,
				parentToolCallId: toolCall.id,
			})) as TaskLaunchSession | undefined;
			if (!launch) throw new Error("expected a task launch session");
			const launchedAt = Date.now();
			// The item has closed; the call itself is still streaming.
			const json = JSON.stringify(args);
			launch.update(toolCall, json.slice(0, json.length - 2));
			await childStarted.promise;

			const toldAt = await owner.seen(OWNER_NOTICE);
			expect(toldAt - launchedAt).toBeGreaterThanOrEqual(DUE_MS);
			launch.finalize({ toolCall, args });
			await owner.task.execute(toolCall.id, args);
			expect(executorModule.runSubprocess).toHaveBeenCalledTimes(1);
			// Past both stages of any clock adoption might have started.
			await Bun.sleep(2 * DUE_MS + 500);
			await owner.session.waitForIdle();
			expect(owner.count(OWNER_NOTICE)).toBe(1);
			expect(owner.notices.filter(notice => notice.message.includes(ESCALATION))).toHaveLength(1);
			child.resolve(childResult("Spec", "task"));
			await manager.getJob("Spec")?.promise;
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"never escalates into the new conversation a dispatcher started with /new after dispatching",
		async () => {
			const boss = await agent({ id: "Boss", kind: "main" });
			const lead = await agent({
				id: "Lead",
				kind: "sub",
				parentId: "Boss",
				dispatch: dispatch("gate", "Gate", SLACK_DUE_MINUTES),
			});
			const run = lead.session.prompt("dispatch");
			await childStarted.promise;
			expect(await boss.session.newSession()).toBe(true);

			// The conversation that asked for the work is gone, so no dispatcher above `Lead` is live.
			const recipient = await Promise.race([
				boss.seen(ESCALATION).then(() => "Boss's new conversation"),
				lead.warned(ESCALATION).then(() => "the person"),
			]);
			expect(recipient).toBe("the person");
			expect(boss.saw(ESCALATION)).toBe(false);
			child.resolve(childResult("Gate", "gate"));
			await run;
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"never escalates into an unrelated transcript a dispatcher switched to after dispatching",
		async () => {
			const boss = await agent({ id: "Boss", kind: "main", persist: true });
			await boss.session.prompt("old conversation");
			const other = SessionManager.create(tempDir.path(), path.join(tempDir.path(), "other"));
			other.appendMessage({ role: "user", content: "UNRELATED_CONVERSATION", timestamp: Date.now() });
			const otherFile = other.getSessionFile()!;
			await other.ensureOnDisk();
			await other.close();
			const lead = await agent({
				id: "Lead",
				kind: "sub",
				parentId: "Boss",
				dispatch: dispatch("gate", "Gate", SLACK_DUE_MINUTES),
			});
			const run = lead.session.prompt("dispatch");
			await childStarted.promise;
			expect(await boss.session.switchSession(otherFile)).toBe(true);

			const recipient = await Promise.race([
				boss.seen(ESCALATION).then(() => "the unrelated transcript"),
				lead.warned(ESCALATION).then(() => "the person"),
			]);
			expect(recipient).toBe("the person");
			expect(boss.saw(ESCALATION)).toBe(false);
			child.resolve(childResult("Gate", "gate"));
			await run;
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"drops an escalation queued for a conversation that /new replaced before it was read",
		async () => {
			const boss = await agent({ id: "Boss", kind: "main" });
			const lead = await agent({ id: "Lead", kind: "sub", parentId: "Boss", dispatch: dispatch("gate", "Gate") });
			const deliver = boss.session.notifySubagentOverdue.bind(boss.session);
			const queued = Promise.withResolvers<void>();
			// The clock addresses the escalation to Boss's conversation; /new replaces it before Boss reads it.
			vi.spyOn(boss.session, "notifySubagentOverdue").mockImplementation(entry => {
				void boss.session.newSession().then(() => {
					deliver(entry);
					queued.resolve();
				});
			});
			const run = lead.session.prompt("dispatch");
			await childStarted.promise;
			await queued.promise;
			await boss.session.prompt("FIRST_OF_THE_NEW_CONVERSATION", { streamingBehavior: "steer" });
			await boss.session.waitForIdle();

			expect(boss.saw("FIRST_OF_THE_NEW_CONVERSATION")).toBe(true);
			expect(boss.saw(ESCALATION)).toBe(false);
			child.resolve(childResult("Gate", "gate"));
			await run;
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"keeps escalating to a dispatcher that forked its conversation, since the fork goes on with it",
		async () => {
			const boss = await agent({ id: "Boss", kind: "main", persist: true });
			await boss.session.prompt("before the fork");
			const lead = await agent({
				id: "Lead",
				kind: "sub",
				parentId: "Boss",
				dispatch: dispatch("gate", "Gate", SLACK_DUE_MINUTES),
			});
			const run = lead.session.prompt("dispatch");
			await childStarted.promise;
			expect(await boss.session.fork()).toBe(true);

			const recipient = await Promise.race([
				boss.seen(ESCALATION).then(() => "Boss"),
				lead.warned(ESCALATION).then(() => "the person"),
			]);
			expect(recipient).toBe("Boss");
			child.resolve(childResult("Gate", "gate"));
			await run;
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"never warns a main session registered after dispatch under the main session's id",
		async () => {
			await agent({ id: "Main", kind: "main" });
			const lead = await agent({ id: "Lead", kind: "sub", parentId: "Main", dispatch: dispatch("gate", "Gate") });
			const run = lead.session.prompt("dispatch");
			await childStarted.promise;
			AgentRegistry.global().unregister("Main");
			const replacement = await agent({ id: "Main", kind: "main" });

			const recipient = await Promise.race([
				replacement.warned(ESCALATION).then(() => "the replacement Main"),
				lead.warned(ESCALATION).then(() => "Lead's own session"),
			]);
			expect(recipient).toBe("Lead's own session");
			expect(replacement.notices).toEqual([]);
			expect(replacement.contexts).toEqual([]);
			child.resolve(childResult("Gate", "gate"));
			await run;
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"tells the dispatcher's dispatcher in a session given its own agent registry",
		async () => {
			const registry = new AgentRegistry();
			try {
				const boss = await agent({ id: "Boss", kind: "main", registry });
				const lead = await agent({
					id: "Lead",
					kind: "sub",
					parentId: "Boss",
					registry,
					dispatch: dispatch("gate", "Gate"),
				});
				const run = lead.session.prompt("dispatch");
				await childStarted.promise;

				// Telling nobody has no event to wait for: bound the wait at ten times the
				// escalation's due time, so that failure is an assertion, not a timeout.
				const told = await Promise.race([
					boss.seen(ESCALATION).then(() => true),
					Bun.sleep(20 * DUE_MS).then(() => false),
				]);
				expect(told).toBe(true);
				child.resolve(childResult("Gate", "gate"));
				await run;
			} finally {
				registry.dueBy.dispose();
			}
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"shows in proc:// a dispatched subagent's due-by, and that a subagent woken by a message has none",
		async () => {
			const main = await agent({
				id: "Main",
				kind: "main",
				dispatch: dispatch("task", "Slow", SLACK_DUE_MINUTES),
			});
			await main.session.prompt("dispatch");
			await childStarted.promise;
			// A turn a message starts runs with no clock: no dispatcher said when to expect it.
			const finish = Promise.withResolvers<void>();
			const peer = await agent({ id: "Peer", kind: "sub", parentId: "Main", hold: finish.promise });
			executorModule.attachIrcWakeTurnMonitor(peer.session, {
				id: "Peer",
				agent: { name: "task", description: "test", systemPrompt: "Work.", source: "bundled" },
			});
			await peer.session.deliverIrcMessage({
				id: "wake",
				from: "Other",
				to: "Peer",
				body: "KEEP_WORKING",
				ts: Date.now(),
			});
			await peer.seen("KEEP_WORKING");
			expect(peer.session.isStreaming).toBe(true);

			const listing = await new ProcProtocolHandler().resolve(parseInternalUrl("proc://"), {
				session: main.toolSession,
			});
			const rows = listing.content.split("\n");
			expect(rows.find(row => row.startsWith("Slow "))).toMatch(/ — due by \d{4}-\d\d-\d\dT\d\d:\d\dZ$/);
			expect(rows.find(row => row.startsWith("Peer "))).toMatch(/ — no due-by$/);
			finish.resolve();
			await peer.session.waitForIdle();
			child.resolve(childResult("Slow", "task"));
			await manager.getJob("Slow")?.promise;
		},
		TEST_TIMEOUT_MS,
	);
});
