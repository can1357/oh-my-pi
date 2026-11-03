/**
 * Contracts: the due-by of a dispatched subagent, seen from the agents above it.
 *
 * A dispatcher names when it expects a child's result (`dueMinutes`). The
 * clock runs outside the owner's turn, because an owner inside a blocking
 * `task` call reads nothing until the call returns.
 *
 * Invariant under test: a notice addressed to a dispatch is delivered to a
 * session exactly when that session's live conversation (its branch, back to
 * the nearest context reset) still holds the entry the address is anchored
 * to — the dispatching tool-call entry once the transcript carries it, until
 * then the leaf the recipient was at when the work was dispatched (an
 * ancestor, which made no recorded dispatch, always uses that leaf). While a
 * recipient is mid-transition, delivery waits for it to settle and re-checks;
 * a notice with no such session is a surfaced loss, never a misdelivery, and
 * the two-notice bound (one owner, one escalation) holds.
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
 * 10. A notice reaches the conversation that dispatched the work, found by
 *    membership: the recipient's live branch still holds the dispatching tool
 *    call. Both stages are taken over every transition that can move a
 *    conversation: a full fork, a partial fork that keeps or cuts the
 *    dispatch, navigating the tree away and back, `/new`, a switch to another
 *    transcript and back, a park and disk revival, a Vibe kill and reopen,
 *    and a replacement under a reused id. A dispatcher that replaced its
 *    conversation no longer holds the address and is skipped, whether the
 *    notice fires after the change or was queued before it and read after; a
 *    fork keeps every entry, so it still holds the call and is still told.
 * 11. With no recorded dispatcher live, the person is warned at a main session
 *    only while its branch still holds the leaf recorded at dispatch.
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
import { Agent, type AgentTool, agentPauseGate } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Context } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { MCPManager } from "@oh-my-pi/pi-coding-agent/mcp/manager";
import type { CreateAgentSessionResult } from "@oh-my-pi/pi-coding-agent/sdk";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import { ProcProtocolHandler } from "@oh-my-pi/pi-coding-agent/internal-urls/proc-protocol";
import { parseInternalUrl } from "@oh-my-pi/pi-coding-agent/internal-urls/parse";
import { type AgentKind, AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { AgentSession, type AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TaskTool } from "@oh-my-pi/pi-coding-agent/task";
import { createPersistedSubagentReviverFactory } from "@oh-my-pi/pi-coding-agent/task/persisted-revive";
import { VibeSessionRegistry } from "@oh-my-pi/pi-coding-agent/vibe/runtime";
import type { TaskLaunchSession } from "@oh-my-pi/pi-coding-agent/task/speculative-launch";
import { NOTICE_DEADLINE_MS, SUBAGENT_OVERDUE_MESSAGE_TYPE } from "@oh-my-pi/pi-coding-agent/task/due-by";
import { SessionFocusController } from "@oh-my-pi/pi-coding-agent/modes/controllers/session-focus-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import * as discoveryModule from "@oh-my-pi/pi-coding-agent/task/discovery";
import * as executorModule from "@oh-my-pi/pi-coding-agent/task/executor";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import type { SingleResult } from "@oh-my-pi/pi-tui/tools/task";
import { TempDir } from "@oh-my-pi/pi-utils";

const OWNER_NOTICE = "is taking longer than you said";
/** The same notice for a dispatch that named no due-by and took `task.dueMinutes`. */
const DEFAULT_NOTICE = "is taking longer than the default due-by";
const ESCALATION = "is taking more than twice as long as";
/** The warning a person gets when a notice reached no agent at all. */
const LOST_NOTICE = "and no agent was told";
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
/**
 * For the cases whose recipient is killed or parked and rebuilt from disk
 * before the due-by: reopening a transcript and its runtime takes far longer
 * than a notice, and a recipient that is not back yet is a loss, not a test.
 */
const REVIVAL_DUE_MINUTES = 0.1; // 6 s
const REVIVAL_DUE_MS = REVIVAL_DUE_MINUTES * 60_000;

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

	/** Parent transcripts of the Vibe workers a test spawned, closed with it. */
	const vibeParents: SessionManager[] = [];

	beforeEach(async () => {
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		VibeSessionRegistry.resetGlobalForTests();
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
		for (const parent of vibeParents.splice(0)) await parent.close();
		await manager.dispose({ timeoutMs: 1_000 });
		authStorage.close();
		tempDir.removeSync();
		AsyncJobManager.resetForTests();
		MCPManager.resetForTests();
		VibeSessionRegistry.resetGlobalForTests();
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
		/** Supply a transcript directly (a reopened on-disk session, a Vibe worker's own file). */
		sessionManager?: SessionManager;
		/** Skip registry registration, for a revival that registers its own ref. */
		register?: boolean;
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
			sessionManager:
				options.sessionManager ??
				(options.persist
					? SessionManager.create(tempDir.path(), path.join(tempDir.path(), "sessions"))
					: SessionManager.inMemory(tempDir.path())),
			settings,
			modelRegistry: new ModelRegistry(authStorage),
			toolRegistry: new Map([["task", task as unknown as AgentTool]]),
			agentId: options.id,
			asyncJobManager: manager,
		});
		sessions.push(session);
		if (options.register !== false) {
			registry.register({
				id: options.id,
				displayName: options.id,
				kind: options.kind,
				parentId: options.parentId,
				session,
				sessionFile: session.sessionManager.getSessionFile(),
			});
		}
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
			await boss.session.prompt("BOSS_CONVERSATION");
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
			await boss.session.prompt("BOSS_CONVERSATION");
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
			expect(boss.count(ESCALATION)).toBe(1);
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
			await boss.session.prompt("BOSS_CONVERSATION");
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
			await boss.session.prompt("BOSS_CONVERSATION");
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
			// The conversation that launches it: the dispatching call is still
			// streaming when the clock arms, so the notice is addressed to the leaf
			// this turn leaves, and moves onto the call once the turn writes it.
			await owner.session.prompt("before the launch");
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
			await boss.session.prompt("BOSS_CONVERSATION");
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
			await boss.session.prompt("BOSS_CONVERSATION");
			const lead = await agent({ id: "Lead", kind: "sub", parentId: "Boss", dispatch: dispatch("gate", "Gate") });
			const deliver = boss.session.notifySubagentOverdue.bind(boss.session);
			const queued = Promise.withResolvers<void>();
			// The clock addresses the escalation to Boss's conversation; /new replaces it before Boss reads it.
			vi.spyOn(boss.session, "notifySubagentOverdue").mockImplementation(async entry => {
				await boss.session.newSession();
				const receipt = deliver(entry);
				queued.resolve();
				return receipt;
			});
			const run = lead.session.prompt("dispatch");
			await childStarted.promise;
			await queued.promise;
			await boss.session.prompt("FIRST_OF_THE_NEW_CONVERSATION", { streamingBehavior: "steer" });
			await boss.session.waitForIdle();

			expect(boss.saw("FIRST_OF_THE_NEW_CONVERSATION")).toBe(true);
			expect(boss.saw(ESCALATION)).toBe(false);
			// Dropped from the queue is still an end: the person is told it reached nobody.
			await lead.warned(LOST_NOTICE);
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
				await boss.session.prompt("BOSS_CONVERSATION");
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

	it(
		"restores the original conversation's escalation identity after switching away and back",
		async () => {
			const boss = await agent({ id: "Boss", kind: "main", persist: true });
			await boss.session.prompt("ORIGINAL_CONVERSATION");
			const originalFile = boss.session.sessionManager.getSessionFile()!;
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
			expect(await boss.session.switchSession(originalFile, { keepModel: true })).toBe(true);

			const recipient = await Promise.race([
				boss.seen(ESCALATION).then(() => "Boss's restored original conversation"),
				lead.warned(ESCALATION).then(() => "the person"),
			]);
			expect(recipient).toBe("Boss's restored original conversation");
			child.resolve(childResult("Gate", "gate"));
			await run;
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"does not warn the main session's target transcript while its switch is in progress",
		async () => {
			const main = await agent({ id: "Main", kind: "main", persist: true });
			await main.session.prompt("ORIGINAL_CONVERSATION");
			const other = SessionManager.create(tempDir.path(), path.join(tempDir.path(), "other"));
			other.appendMessage({ role: "user", content: "UNRELATED_CONVERSATION", timestamp: Date.now() });
			const otherFile = other.getSessionFile()!;
			await other.ensureOnDisk();
			await other.close();
			// A parked recorded ancestor with no parent makes the escalation fall back to the main session.
			AgentRegistry.global().register({
				id: "Mid",
				displayName: "Mid",
				kind: "sub",
				status: "parked",
				session: null,
			});
			const lead = await agent({ id: "Lead", kind: "sub", parentId: "Mid", dispatch: dispatch("gate", "Gate") });
			const enteredRefresh = Promise.withResolvers<void>();
			const releaseRefresh = Promise.withResolvers<void>();
			const refresh = main.session.refreshBaseSystemPrompt.bind(main.session);
			vi.spyOn(main.session, "refreshBaseSystemPrompt").mockImplementation(async () => {
				enteredRefresh.resolve();
				await releaseRefresh.promise;
				return refresh();
			});
			const run = lead.session.prompt("dispatch");
			await childStarted.promise;
			const switching = main.session.switchSession(otherFile);
			await enteredRefresh.promise;

			// The timer fires while Main already holds the target transcript but has not committed it.
			const recipient = await Promise.race([
				main.warned(ESCALATION).then(() => "Main's target transcript"),
				lead.warned(ESCALATION).then(() => "Lead's own session"),
			]);
			expect(recipient).toBe("Lead's own session");
			expect(main.notices.filter(notice => notice.message.includes(ESCALATION))).toEqual([]);
			releaseRefresh.resolve();
			expect(await switching).toBe(true);
			child.resolve(childResult("Gate", "gate"));
			await run;
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"does not escalate to a transcript branch that excludes the dispatch",
		async () => {
			const boss = await agent({ id: "Boss", kind: "main", persist: true });
			await boss.session.prompt("BRANCH_POINT");
			const branchPoint = boss.session.sessionManager
				.getEntries()
				.find(entry => entry.type === "message" && entry.message.role === "user")?.id;
			if (!branchPoint) throw new Error("Expected a branch point");
			const lead = await agent({
				id: "Lead",
				kind: "sub",
				parentId: "Boss",
				dispatch: dispatch("gate", "Gate", SLACK_DUE_MINUTES),
			});
			const run = lead.session.prompt("dispatch");
			await childStarted.promise;
			expect((await boss.session.branch(branchPoint)).cancelled).toBe(false);

			const recipient = await Promise.race([
				boss.seen(ESCALATION).then(() => "the branched conversation"),
				lead.warned(ESCALATION).then(() => "the person"),
			]);
			expect(recipient).toBe("the person");
			child.resolve(childResult("Gate", "gate"));
			await run;
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"drops an escalation queued before a transcript branch replaces the conversation",
		async () => {
			const boss = await agent({ id: "Boss", kind: "main", persist: true });
			await boss.session.prompt("BRANCH_POINT");
			const branchPoint = boss.session.sessionManager
				.getEntries()
				.find(entry => entry.type === "message" && entry.message.role === "user")?.id;
			if (!branchPoint) throw new Error("Expected a branch point");
			const lead = await agent({ id: "Lead", kind: "sub", parentId: "Boss", dispatch: dispatch("gate", "Gate") });
			const deliver = boss.session.notifySubagentOverdue.bind(boss.session);
			const branched = Promise.withResolvers<void>();
			vi.spyOn(boss.session, "notifySubagentOverdue").mockImplementation(async entry => {
				await boss.session.branch(branchPoint);
				const receipt = deliver(entry);
				branched.resolve();
				return receipt;
			});
			const run = lead.session.prompt("dispatch");
			await childStarted.promise;
			await branched.promise;
			await boss.session.prompt("FIRST_OF_THE_BRANCH", { streamingBehavior: "steer" });
			await boss.session.waitForIdle();

			expect(boss.saw("FIRST_OF_THE_BRANCH")).toBe(true);
			expect(boss.saw(ESCALATION)).toBe(false);
			await lead.warned(LOST_NOTICE);
			child.resolve(childResult("Gate", "gate"));
			await run;
		},
		TEST_TIMEOUT_MS,
	);

	/** A second on-disk transcript a session can switch to, holding one unrelated message. */
	async function makeOther(label: string): Promise<string> {
		const other = SessionManager.create(tempDir.path(), path.join(tempDir.path(), label));
		other.appendMessage({ role: "user", content: label, timestamp: Date.now() });
		await other.ensureOnDisk();
		const file = other.getSessionFile()!;
		await other.close();
		return file;
	}

	it(
		"fires the owner notice from a positive configured default due-by when the call names none",
		async () => {
			const { dueMinutes: _dropped, ...unstated } = dispatch("task", "Defaulted");
			const owner = await agent({
				id: "Main",
				kind: "main",
				dispatch: unstated,
				settings: { "task.dueMinutes": DUE_MINUTES },
			});
			const dispatchedAt = Date.now();
			await owner.session.prompt("dispatch");
			await childStarted.promise;

			// An unstated due-by names the default in the notice, not "you said".
			const toldAt = await owner.seen(DEFAULT_NOTICE);
			expect(toldAt - dispatchedAt).toBeGreaterThanOrEqual(DUE_MS);
			expect(owner.saw(OWNER_NOTICE)).toBe(false);
			const notice = owner.contexts.find(context => JSON.stringify(context.messages).includes(DEFAULT_NOTICE))!;
			expect(JSON.stringify(notice.messages)).toContain("set `dueMinutes` when you dispatch it");
			child.resolve(childResult("Defaulted", "task", { output: "DEFAULT_RESULT" }));
			await owner.seen("DEFAULT_RESULT");
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"delivers both notices once after a full fork that spans the due-by and the escalation",
		async () => {
			const owner = await agent({ id: "Main", kind: "main", persist: true, dispatch: dispatch("task", "ForkHung") });
			await owner.session.prompt("dispatch");
			await childStarted.promise;
			const entered = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const realFork = owner.session.sessionManager.fork.bind(owner.session.sessionManager);
			vi.spyOn(owner.session.sessionManager, "fork").mockImplementation(async () => {
				entered.resolve();
				await release.promise;
				return realFork();
			});
			const transition = owner.session.fork();
			await entered.promise;
			// Hold the fork across both deadlines (real time, see the file header).
			await Bun.sleep(2 * DUE_MS + 500);
			release.resolve();
			expect(await transition).toBe(true);

			await owner.seen(OWNER_NOTICE);
			await owner.warned(ESCALATION);
			await owner.session.waitForIdle();
			// The fork continues the conversation, so both notices land, each once.
			expect(owner.count(OWNER_NOTICE)).toBe(1);
			expect(owner.notices.filter(notice => notice.message.includes(ESCALATION))).toHaveLength(1);
			child.resolve(childResult("ForkHung", "task"));
			await manager.getJob("ForkHung")?.promise;
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"never escalates into a conversation a dispatcher forked and then replaced with /new",
		async () => {
			const main = await agent({ id: "Main", kind: "main", persist: true });
			await main.session.prompt("original");
			const lead = await agent({
				id: "Lead",
				kind: "sub",
				parentId: "Main",
				dispatch: dispatch("gate", "Gate", SLACK_DUE_MINUTES),
			});
			const run = lead.session.prompt("dispatch");
			await childStarted.promise;
			expect(await main.session.fork()).toBe(true);
			expect(await main.session.newSession()).toBe(true);

			const recipient = await Promise.race([
				main.seen(ESCALATION).then(() => "Main's replaced conversation"),
				lead.warned(ESCALATION).then(() => "the person"),
			]);
			expect(recipient).toBe("the person");
			expect(main.saw(ESCALATION)).toBe(false);
			child.resolve(childResult("Gate", "gate"));
			await run;
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"delivers the owner notice after navigating away from and back to the dispatch leaf",
		async () => {
			const owner = await agent({
				id: "Main",
				kind: "main",
				persist: true,
				dispatch: dispatch("task", "NavHung", SLACK_DUE_MINUTES),
			});
			await owner.session.prompt("dispatch");
			await childStarted.promise;
			const sm = owner.session.sessionManager;
			const dispatchLeaf = sm.getLeafId()!;
			const userEntry = sm.getEntries().find(entry => entry.type === "message" && entry.message.role === "user")!.id;
			// Away from the dispatch (its leaf leaves the branch), then back to it.
			expect((await owner.session.navigateTree(userEntry)).cancelled).toBe(false);
			expect((await owner.session.navigateTree(dispatchLeaf)).cancelled).toBe(false);
			expect(sm.getLeafId()).toBe(dispatchLeaf);

			await owner.seen(OWNER_NOTICE);
			expect(JSON.stringify(owner.contexts.at(-1)!.messages)).toContain("`NavHung` (task)");
			child.resolve(childResult("NavHung", "task", { output: "NAV_RESULT" }));
			await owner.seen("NAV_RESULT");
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"escalates to an ancestor of a nested dispatch after it navigates away and back",
		async () => {
			let lead: Observed | undefined;
			vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
				if (options.id === "Lead") {
					lead = await agent({
						id: "Lead",
						kind: "sub",
						parentId: "Main",
						dispatch: dispatch("gate", "Grandchild", SLACK_DUE_MINUTES),
					});
					await lead.session.prompt("dispatch Grandchild");
					return childResult("Lead", "task");
				}
				childStarted.resolve(options.signal);
				return { ...(await child.promise), id: options.id!, agent: options.agent.name };
			});
			const main = await agent({ id: "Main", kind: "main", persist: true, dispatch: dispatch("task", "Lead", 10) });
			await main.session.prompt("dispatch Lead");
			await childStarted.promise;
			const sm = main.session.sessionManager;
			const dispatchLeaf = sm.getLeafId()!;
			const userEntry = sm.getEntries().find(entry => entry.type === "message" && entry.message.role === "user")!.id;
			expect((await main.session.navigateTree(userEntry)).cancelled).toBe(false);
			expect((await main.session.navigateTree(dispatchLeaf)).cancelled).toBe(false);

			const got = await Promise.race([
				main.seen(ESCALATION).then(() => "Main model"),
				lead!.warned(ESCALATION).then(() => "Lead UI only"),
				Bun.sleep(10_000).then(() => "nobody"),
			]);
			expect(got).toBe("Main model");
			child.resolve(childResult("Grandchild", "gate"));
			await manager.getJob("Lead")?.promise;
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"never delivers to a replacement under the owner's id while the original is detached",
		async () => {
			const owner = await agent({ id: "Main", kind: "main", persist: true, dispatch: dispatch("task", "Slow") });
			await owner.session.prompt("dispatch");
			await childStarted.promise;
			const registry = AgentRegistry.global();
			const original = registry.get("Main")!;
			registry.detachSession("Main", original);
			registry.setStatus("Main", "parked", original);
			const replacement = await agent({ id: "Main", kind: "main" });

			const got = await Promise.race([
				replacement.seen(OWNER_NOTICE).then(() => "replacement model"),
				replacement.warned(ESCALATION).then(() => "replacement UI"),
				Bun.sleep(2 * DUE_MS + 500).then(() => "nobody"),
			]);
			expect(got).toBe("nobody");
			expect(replacement.saw(OWNER_NOTICE)).toBe(false);
			// The person at the window is told it reached nobody; its model is not.
			const warnings = replacement.notices.map(notice => notice.message);
			expect(warnings.length).toBeGreaterThan(0);
			expect(warnings.every(message => message.includes(LOST_NOTICE))).toBe(true);
			child.resolve(childResult("Slow", "task"));
			await manager.getJob("Slow")?.promise;
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"never delivers an escalation to a dispatcher revived onto the transcript it did not dispatch from",
		async () => {
			const boss = await agent({ id: "Boss", kind: "sub", parentId: "Main", persist: true });
			await boss.session.prompt("A_ORIGINAL");
			await boss.session.flushToDisk();
			const registry = AgentRegistry.global();
			const ref = registry.get("Boss")!;
			const fileA = ref.sessionFile!;
			const fileB = await makeOther("B_UNRELATED");
			expect(await boss.session.switchSession(fileB)).toBe(true);
			await boss.session.prompt("B_DISPATCH_CONTEXT");
			await boss.session.flushToDisk();
			registry.setStatus("Boss", "idle", ref);
			let revived: Observed | undefined;
			const lifecycle = AgentLifecycleManager.global();
			lifecycle.adopt(
				"Boss",
				{
					idleTtlMs: 0,
					revive: async () => {
						revived = await agent({
							id: "Boss",
							kind: "sub",
							register: false,
							sessionManager: await SessionManager.open(ref.sessionFile!),
						});
						return revived.session;
					},
				},
				ref,
			);
			const lead = await agent({
				id: "Lead",
				kind: "sub",
				parentId: "Boss",
				dispatch: dispatch("gate", "Gate", SLACK_DUE_MINUTES),
			});
			const run = lead.session.prompt("dispatch");
			await childStarted.promise;
			await lifecycle.park("Boss");
			await lifecycle.ensureLive("Boss");
			expect(revived!.session.sessionFile).toBe(fileA);

			const got = await Promise.race([
				revived!.seen(ESCALATION).then(() => "unrelated A model"),
				lead.warned(ESCALATION).then(() => "the person"),
				Bun.sleep(10_000).then(() => "nobody"),
			]);
			expect(got).not.toBe("unrelated A model");
			child.resolve(childResult("Gate", "gate"));
			await run;
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"still escalates to a dispatcher revived from disk onto the transcript it dispatched from",
		async () => {
			const boss = await agent({ id: "Boss", kind: "sub", parentId: "Main", persist: true });
			await boss.session.prompt("A_ORIGINAL");
			await boss.session.flushToDisk();
			const registry = AgentRegistry.global();
			const ref = registry.get("Boss")!;
			registry.setStatus("Boss", "idle", ref);
			let revived: Observed | undefined;
			const lifecycle = AgentLifecycleManager.global();
			lifecycle.adopt(
				"Boss",
				{
					idleTtlMs: 0,
					revive: async () => {
						revived = await agent({
							id: "Boss",
							kind: "sub",
							register: false,
							sessionManager: await SessionManager.open(ref.sessionFile!),
						});
						return revived.session;
					},
				},
				ref,
			);
			const lead = await agent({
				id: "Lead",
				kind: "sub",
				parentId: "Boss",
				dispatch: dispatch("gate", "Gate", SLACK_DUE_MINUTES),
			});
			const run = lead.session.prompt("dispatch");
			await childStarted.promise;
			await lifecycle.park("Boss");
			const live = await lifecycle.ensureLive("Boss");
			expect(await live.fork()).toBe(true);

			const got = await Promise.race([
				revived!.seen(ESCALATION).then(() => "boss model"),
				lead.warned(ESCALATION).then(() => "the person"),
				Bun.sleep(10_000).then(() => "nobody"),
			]);
			expect(got).toBe("boss model");
			child.resolve(childResult("Gate", "gate"));
			await run;
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"produces exactly one owner notice and one escalation, and no more as time passes",
		async () => {
			const owner = await agent({ id: "Main", kind: "main", dispatch: dispatch("task", "Bound") });
			const queued = vi.spyOn(owner.session, "notifySubagentOverdue");
			const start = performance.now();
			await owner.session.prompt("dispatch");
			await childStarted.promise;
			await owner.seen(OWNER_NOTICE);
			await owner.warned(ESCALATION);
			for (const multiple of [4, 12, 24]) {
				await Bun.sleep(Math.max(0, start + multiple * DUE_MS - performance.now()));
				await owner.session.waitForIdle();
				expect(owner.count(OWNER_NOTICE)).toBe(1);
				expect(owner.notices.filter(notice => notice.message.includes(ESCALATION))).toHaveLength(1);
				expect(
					queued.mock.calls.filter(([entry]) => entry.childId === "Bound" && entry.stage === "owner").length,
				).toBe(1);
			}
			child.resolve(childResult("Bound", "task"));
			await manager.getJob("Bound")?.promise;
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"stops the clock of a dispatcher's own child when a partial fork cancels it, keeping the call",
		async () => {
			const owner = await agent({
				id: "Main",
				kind: "main",
				persist: true,
				dispatch: dispatch("task", "PartHung"),
			});
			await owner.session.prompt("dispatch");
			const signal = await childStarted.promise;
			const sm = owner.session.sessionManager;
			const before = sm.getSessionFile();
			const dispatchEntry = sm
				.getEntries()
				.find(entry => entry.type === "message" && entry.message.role === "assistant")!.id;
			// Cut at the dispatching call: the new transcript still holds it, but a
			// partial fork cancels the dispatcher's own background jobs with it.
			expect(await owner.session.fork(dispatchEntry)).toBe(true);
			expect(owner.session.sessionManager.getSessionFile()).not.toBe(before);
			expect(owner.session.sessionManager.getBranch().some(entry => entry.id === dispatchEntry)).toBe(true);
			await aborted(signal);

			const got = await Promise.race([
				owner.seen(OWNER_NOTICE).then(() => "the forked conversation"),
				owner.warned(ESCALATION).then(() => "its UI"),
				Bun.sleep(2 * DUE_MS + 800).then(() => "nobody"),
			]);
			expect(got).toBe("nobody");
			await owner.session.waitForIdle();
			expect(owner.saw(OWNER_NOTICE)).toBe(false);
			expect(owner.notices).toEqual([]);
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"never escalates into a partial fork that cut the dispatcher's conversation away",
		async () => {
			const boss = await agent({ id: "Boss", kind: "main", persist: true });
			await boss.session.prompt("BRANCH_POINT");
			const cut = boss.session.sessionManager
				.getEntries()
				.find(entry => entry.type === "message" && entry.message.role === "user")!.id;
			const lead = await agent({
				id: "Lead",
				kind: "sub",
				parentId: "Boss",
				dispatch: dispatch("gate", "Gate", SLACK_DUE_MINUTES),
			});
			const run = lead.session.prompt("dispatch");
			await childStarted.promise;
			// Forked below the conversation that asked for the work: the new transcript
			// ends before it, so Boss no longer holds the address.
			expect(await boss.session.fork(cut)).toBe(true);

			const recipient = await Promise.race([
				boss.seen(ESCALATION).then(() => "the cut fork"),
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
		"never tells the conversation a dispatcher replaced with /new, and warns nobody in it",
		async () => {
			// The /new must land before the due-by: with 300 ms, a loaded machine let the
			// escalation reach the conversation the test is about to replace.
			const owner = await agent({
				id: "Main",
				kind: "main",
				dispatch: dispatch("task", "NewHung", SLACK_DUE_MINUTES),
			});
			await owner.session.prompt("dispatch");
			await childStarted.promise;
			expect(await owner.session.newSession()).toBe(true);
			await owner.session.prompt("FIRST_OF_THE_NEW_CONVERSATION");

			const got = await Promise.race([
				owner.seen(OWNER_NOTICE).then(() => "the new conversation"),
				owner.warned(ESCALATION).then(() => "its UI"),
				Bun.sleep(2 * SLACK_DUE_MS + 800).then(() => "nobody"),
			]);
			expect(got).toBe("nobody");
			await owner.session.waitForIdle();
			expect(owner.saw("FIRST_OF_THE_NEW_CONVERSATION")).toBe(true);
			expect(owner.saw(OWNER_NOTICE)).toBe(false);
			// `/new` cancels the dispatcher's own background jobs, so the child goes
			// with the conversation and there is no notice left to lose.
			expect(owner.notices).toEqual([]);
			child.resolve(childResult("NewHung", "task"));
			await manager.getJob("NewHung")?.promise;
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"never tells the unrelated transcript a dispatcher switched to, before or after switching back",
		async () => {
			// The switch must land before the due-by (see the /new case above).
			const owner = await agent({
				id: "Main",
				kind: "main",
				persist: true,
				dispatch: dispatch("task", "SwapHung", SLACK_DUE_MINUTES),
			});
			await owner.session.prompt("dispatch");
			await childStarted.promise;
			const originalFile = owner.session.sessionManager.getSessionFile()!;
			const otherFile = await makeOther("B_UNRELATED");
			expect(await owner.session.switchSession(otherFile)).toBe(true);

			// Both deadlines pass while the unrelated transcript is the live one.
			const got = await Promise.race([
				owner.seen(OWNER_NOTICE).then(() => "the unrelated transcript"),
				owner.warned(ESCALATION).then(() => "its UI"),
				Bun.sleep(2 * SLACK_DUE_MS + 800).then(() => "nobody"),
			]);
			expect(got).toBe("nobody");
			// Switching back restores the conversation, not a notice already lost.
			expect(await owner.session.switchSession(originalFile, { keepModel: true })).toBe(true);
			await owner.session.prompt("BACK_ON_THE_ORIGINAL");
			await owner.session.waitForIdle();
			expect(owner.saw("BACK_ON_THE_ORIGINAL")).toBe(true);
			expect(owner.saw(OWNER_NOTICE)).toBe(false);
			// The switch cancelled the child with the conversation it was dispatched from.
			expect(owner.notices).toEqual([]);
			child.resolve(childResult("SwapHung", "task"));
			await manager.getJob("SwapHung")?.promise;
		},
		TEST_TIMEOUT_MS,
	);

	/**
	 * The production cold-revive path: `AgentLifecycleManager` asks the real
	 * persisted-subagent reviver which transcript comes back, and only the
	 * session construction is replaced — by one of this file's observable
	 * sessions, over the transcript that reviver reopened. Returns the revived
	 * agent once the revival has run.
	 */
	function coldRevival(id: string): () => Observed {
		MCPManager.setInstance({
			getTools: () => [],
			addToolsChangedListener: () => () => {},
		} as unknown as MCPManager);
		let revived: Observed | undefined;
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(async options => {
			const sessionManager = options?.sessionManager;
			if (!sessionManager) throw new Error("expected the reviver to reopen the agent's transcript");
			revived = await agent({ id, kind: "sub", register: false, sessionManager });
			return { session: revived.session } as CreateAgentSessionResult;
		});
		AgentLifecycleManager.global().setPersistedSubagentReviverFactory(
			createPersistedSubagentReviverFactory({
				session: {
					sessionManager: { getCwd: () => tempDir.path(), getArtifactManager: () => undefined },
					sessionFile: path.join(tempDir.path(), "parent.jsonl"),
					effectiveExtensionRoots: { explicit: [], mode: "merge", configured: [], configuredLevel: "user" },
					preparedExtensions: undefined,
					getSessionAgents: () => [],
				} as unknown as AgentSession,
				authStorage,
				modelRegistry: new ModelRegistry(authStorage),
				settings: Settings.isolated(),
				enableLsp: false,
			}),
			() => 0,
		);
		return () => {
			if (!revived) throw new Error("expected the cold revival to have run");
			return revived;
		};
	}

	/**
	 * A Vibe worker spawned the real way: its parent's spawn, the lifecycle
	 * events, the kill and the reopen are production. Only the worker's own turn
	 * is replaced, by one of this file's sessions on the worker's own transcript.
	 */
	async function vibeWorker(options: {
		/** The task call the worker's turn makes, if it dispatches at all. */
		dispatch?: Record<string, unknown>;
		prompt: string;
	}): Promise<{ id: string; parent: ToolSession; worker: Observed }> {
		const parentManager = SessionManager.create(tempDir.path(), path.join(tempDir.path(), "vibe"));
		parentManager.appendMessage({ role: "user", content: "vibe", timestamp: Date.now() });
		await parentManager.ensureOnDisk();
		vibeParents.push(parentManager);
		const parent = {
			cwd: tempDir.path(),
			hasUI: false,
			settings: Settings.isolated({ "launch.enabled": false }),
			sessionManager: parentManager,
			asyncJobManager: manager,
			getAgentId: () => "Main",
			getSessionId: () => parentManager.getSessionId(),
			getSessionFile: () => parentManager.getSessionFile(),
			getArtifactsDir: () => parentManager.getSessionFile()!.slice(0, -6),
			taskDepth: 0,
			enableLsp: false,
		} as unknown as ToolSession;
		let worker: Observed | undefined;
		vi.spyOn(executorModule, "runSubprocess").mockImplementation(async spawned => {
			// The worker's own turn is the first; everything it dispatches is the hung child.
			if (worker) {
				childStarted.resolve(spawned.signal);
				return { ...(await child.promise), id: spawned.id ?? "child", agent: spawned.agent.name };
			}
			const file = path.join(spawned.artifactsDir!, `${spawned.id}.jsonl`);
			const sessionManager = await SessionManager.open(file, undefined, undefined, {
				initialCwd: tempDir.path(),
				parentSession: parentManager.getSessionFile()!,
				suppressBreadcrumb: true,
			});
			sessionManager.appendSessionInit({ systemPrompt: ["test"], task: "work", tools: ["read"], agent: "task" });
			worker = await agent({
				id: spawned.id!,
				kind: "sub",
				parentId: "Main",
				register: false,
				sessionManager,
				dispatch: options.dispatch,
			});
			AgentRegistry.global().register({
				id: spawned.id!,
				displayName: spawned.id!,
				kind: "sub",
				parentId: "Main",
				status: "idle",
				session: worker.session,
				sessionFile: file,
			});
			await worker.session.prompt(options.prompt);
			await worker.session.flushToDisk();
			return childResult(spawned.id!, spawned.agent.name);
		});
		const spawn = await VibeSessionRegistry.global().spawn(parent, { cli: "fast", name: "Worker", prompt: "work" });
		await manager.getJob(spawn.jobId)?.promise;
		if (!worker) throw new Error("expected the worker's turn to have run");
		return { id: spawn.id, parent, worker };
	}

	it(
		"tells a killed Vibe worker about its overdue child once the reopen brings its transcript back",
		async () => {
			const { id, parent, worker } = await vibeWorker({
				dispatch: dispatch("task", "VibeChild", REVIVAL_DUE_MINUTES),
				prompt: "dispatch",
			});
			await childStarted.promise;
			const file = worker.session.sessionFile;
			// A second child of the same `task` call, run by work the kill does not
			// stop; its due-by was recorded while the worker was live.
			const sibling = Promise.withResolvers<void>();
			AgentRegistry.global().dueBy.arm(
				{
					childId: "Sibling",
					ownerId: id,
					toolCallId: `${id}-task`,
					agent: "task",
					dispatchedAt: Date.now(),
					dueMs: REVIVAL_DUE_MS,
					stated: true,
					speculative: false,
				},
				{ settled: sibling.promise, signal: new AbortController().signal },
			);
			const revived = coldRevival(id);
			await VibeSessionRegistry.global().kill(parent, id);
			expect(AgentRegistry.global().get(id)?.status).toBe("aborted");
			// A kill stops the worker; the reopen is the same worker on the same transcript.
			const back = await AgentLifecycleManager.global().ensureLive(id);
			expect(back.sessionFile).toBe(file);

			await revived().seen(OWNER_NOTICE);
			expect(JSON.stringify(revived().contexts.at(-1)!.messages)).toContain("`Sibling` (task)");
			expect(worker.saw(OWNER_NOTICE)).toBe(false);
			sibling.resolve();
			child.resolve(childResult("VibeChild", "task"));
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"escalates to a killed Vibe worker reopened from its transcript, rather than to the person",
		async () => {
			const { id, parent, worker } = await vibeWorker({ prompt: "WORKER_CONVERSATION" });
			const lead = await agent({
				id: "Lead",
				kind: "sub",
				parentId: id,
				dispatch: dispatch("gate", "Gate", SLACK_DUE_MINUTES),
			});
			const run = lead.session.prompt("dispatch");
			await childStarted.promise;
			const revived = coldRevival(id);
			await VibeSessionRegistry.global().kill(parent, id);
			expect(await AgentLifecycleManager.global().ensureLive(id)).toBe(revived().session);

			const got = await Promise.race([
				revived()
					.seen(ESCALATION)
					.then(() => "the reopened worker"),
				lead.warned(ESCALATION).then(() => "the person"),
			]);
			expect(got).toBe("the reopened worker");
			expect(worker.saw(ESCALATION)).toBe(false);
			child.resolve(childResult("Gate", "gate"));
			await run;
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"tells a dispatcher the disk reviver brought back onto the transcript it dispatched from",
		async () => {
			const boss = await agent({
				id: "Boss",
				kind: "sub",
				parentId: "Main",
				persist: true,
				dispatch: dispatch("task", "DiskHung", REVIVAL_DUE_MINUTES),
			});
			boss.session.sessionManager.appendSessionInit({
				systemPrompt: ["test"],
				task: "work",
				tools: ["read"],
				agent: "task",
			});
			await boss.session.prompt("dispatch");
			await childStarted.promise;
			await boss.session.flushToDisk();
			const registry = AgentRegistry.global();
			const ref = registry.get("Boss")!;
			const file = ref.sessionFile!;
			// A second child of the same `task` call, run by work the park does not stop.
			const sibling = Promise.withResolvers<void>();
			registry.dueBy.arm(
				{
					childId: "Sibling",
					ownerId: "Boss",
					toolCallId: "Boss-task",
					agent: "task",
					dispatchedAt: Date.now(),
					dueMs: REVIVAL_DUE_MS,
					stated: true,
					speculative: false,
				},
				{ settled: sibling.promise, signal: new AbortController().signal },
			);
			const revived = coldRevival("Boss");
			// Parked with its transcript and nothing adopted in memory: the disk
			// reviver owns what comes back.
			registry.detachSession("Boss", ref);
			registry.setStatus("Boss", "parked", ref);
			await boss.session.dispose();
			expect((await AgentLifecycleManager.global().ensureLive("Boss")).sessionFile).toBe(file);

			await revived().seen(OWNER_NOTICE);
			expect(JSON.stringify(revived().contexts.at(-1)!.messages)).toContain("`Sibling` (task)");
			expect(boss.saw(OWNER_NOTICE)).toBe(false);
			sibling.resolve();
			child.resolve(childResult("DiskHung", "task"));
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"never tells a branch that cut away the call its launch was written into, and says so",
		async () => {
			const release = Promise.withResolvers<void>();
			const args = { context: "ctx", tasks: [dispatch("task", "LatePinned", SLACK_DUE_MINUTES)] };
			const owner = await agent({
				id: "Main",
				kind: "main",
				persist: true,
				dispatch: args,
				hold: release.promise,
				settings: { "task.batch": true },
			});
			// The turn that will carry the call is streaming: the clock can only
			// address the leaf this conversation is at.
			const prompting = owner.session.prompt("dispatch a streamed task");
			while (owner.contexts.length === 0) await setImmediate();
			const sm = owner.session.sessionManager;
			const leaf = sm.getLeafId()!;
			const sink: SpeculativeOperationSink = {
				maxInFlight: 2,
				admit: async () => undefined,
				authorizeLaunch: async () => ({ allowed: true }),
				close: () => {},
			};
			const toolCall: AgentToolCall = { type: "toolCall", id: "Main-task", name: "task", arguments: {} };
			const launch = (await owner.task.speculation.stream?.open({
				coordinator: sink,
				parentToolCallId: toolCall.id,
			})) as TaskLaunchSession | undefined;
			if (!launch) throw new Error("expected a task launch session");
			const json = JSON.stringify(args);
			launch.update(toolCall, json.slice(0, json.length - 2));
			await childStarted.promise;
			// A point between the leaf the launch was addressed to and the call the
			// turn has still to write.
			const betweenLeafAndCall = sm.appendCustomEntry("review-cut-point");
			launch.finalize({ toolCall, args });
			release.resolve();
			await prompting;
			const call = sm.getEntries().find(entry => entry.type === "message" && entry.message.role === "assistant")!.id;
			expect(executorModule.runSubprocess).toHaveBeenCalledTimes(1);
			// Back to that point: the dispatch-time leaf is still on the branch, the
			// written call is not, so the conversation no longer holds the dispatch.
			expect((await owner.session.navigateTree(betweenLeafAndCall)).cancelled).toBe(false);
			expect(sm.getBranch().some(entry => entry.id === leaf)).toBe(true);
			expect(sm.getBranch().some(entry => entry.id === call)).toBe(false);

			await owner.warned(LOST_NOTICE);
			expect(owner.saw(OWNER_NOTICE)).toBe(false);
			child.resolve(childResult("LatePinned", "task"));
			await manager.getJob("LatePinned")?.promise;
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"holds a queued notice through a fork rather than dropping it, and delivers it once after",
		async () => {
			const owner = await agent({
				id: "Main",
				kind: "main",
				persist: true,
				dispatch: dispatch("task", "QueuedFork"),
			});
			const entered = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const realFork = owner.session.sessionManager.fork.bind(owner.session.sessionManager);
			vi.spyOn(owner.session.sessionManager, "fork").mockImplementation(async () => {
				entered.resolve();
				await release.promise;
				return realFork();
			});
			let transition: Promise<boolean> | undefined;
			const deliver = owner.session.notifySubagentOverdue.bind(owner.session);
			// The fork starts in the tick the notice is queued, so every flush that
			// reads the queue from here runs while the branch is between transcripts.
			vi.spyOn(owner.session, "notifySubagentOverdue").mockImplementation(entry => {
				const receipt = deliver(entry);
				transition ??= owner.session.fork();
				return receipt;
			});
			await owner.session.prompt("dispatch");
			await childStarted.promise;
			await entered.promise;
			expect(owner.session.yieldQueue.has(SUBAGENT_OVERDUE_MESSAGE_TYPE)).toBe(true);
			// A delivery boundary crossed mid-fork must hold the notice, not consume it.
			await owner.session.yieldQueue.flush("idle");
			expect(owner.session.yieldQueue.has(SUBAGENT_OVERDUE_MESSAGE_TYPE)).toBe(true);
			release.resolve();
			expect(await transition!).toBe(true);

			await owner.seen(OWNER_NOTICE);
			await owner.session.waitForIdle();
			expect(owner.count(OWNER_NOTICE)).toBe(1);
			child.resolve(childResult("QueuedFork", "task"));
			await manager.getJob("QueuedFork")?.promise;
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"gives up on a transition that never settles and surfaces the loss within the bound",
		async () => {
			const owner = await agent({
				id: "Main",
				kind: "main",
				persist: true,
				dispatch: dispatch("task", "StuckFork"),
			});
			await owner.session.prompt("dispatch");
			await childStarted.promise;
			const entered = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const realFork = owner.session.sessionManager.fork.bind(owner.session.sessionManager);
			vi.spyOn(owner.session.sessionManager, "fork").mockImplementation(async () => {
				entered.resolve();
				await release.promise;
				return realFork();
			});
			const transition = owner.session.fork();
			await entered.promise;

			const got = await Promise.race([
				owner.warned(LOST_NOTICE).then(() => "the person"),
				Bun.sleep(NOTICE_DEADLINE_MS + 5_000).then(() => "nobody, still waiting"),
			]);
			expect(got).toBe("the person");
			expect(owner.saw(OWNER_NOTICE)).toBe(false);
			release.resolve();
			expect(await transition).toBe(true);
			child.resolve(childResult("StuckFork", "task"));
			await manager.getJob("StuckFork")?.promise;
		},
		NOTICE_DEADLINE_MS + 20_000,
	);

	/**
	 * Every end of one notice, however it ended: read by the conversation it was
	 * addressed to, or surfaced to the person as a warning. A delivery is the
	 * first model request of `requests` that carries the notice, and every copy
	 * of it inside that request counts, so a duplicated notice is two ends; a
	 * warning is each matching entry of `warnings`, the person-facing surface
	 * the test watches. Exactly one per stage is the contract: zero is a silent
	 * loss, two is a double end.
	 */
	function endsOf(
		childId: string,
		stage: "owner" | "escalation",
		requests: readonly Observed[],
		warnings: readonly { message: string }[],
	): number {
		const delivered = stage === "owner" ? OWNER_NOTICE : ESCALATION;
		const lostStage = stage === "owner" ? "running past the due-by" : "running past twice the due-by";
		const named = `\`${childId}\``;
		const carries = (text: string) => text.includes(delivered) && text.includes(named);
		let ends = 0;
		for (const observed of requests) {
			const first = observed.contexts.find(context => carries(JSON.stringify(context.messages)));
			if (first) ends += first.messages.filter(message => carries(JSON.stringify(message))).length;
		}
		for (const { message } of warnings) {
			if (!message.includes(named)) continue;
			if (stage === "escalation" && message.includes(delivered)) ends++;
			else if (message.includes(LOST_NOTICE) && message.includes(lostStage)) ends++;
		}
		return ends;
	}

	/**
	 * The person's window: one event consumer, whichever agent the view shows.
	 * `until` resolves once the window has shown what `done` waits for.
	 */
	function windowOn(main: AgentSession): {
		ctx: InteractiveModeContext;
		notices: () => Array<Extract<AgentSessionEvent, { type: "notice" }>>;
		until: (done: () => boolean) => Promise<void>;
	} {
		const events: AgentSessionEvent[] = [];
		const waiters: Array<() => void> = [];
		const record = (event: AgentSessionEvent) => {
			events.push(event);
			for (const wake of waiters.splice(0)) wake();
		};
		const ctx = {
			session: main,
			unsubscribe: main.subscribe(record),
			eventController: {
				handleEvent: async (event: AgentSessionEvent) => record(event),
				resetTranscriptAnchors() {},
				restorePendingToolResults() {},
				markViewIdle() {},
			},
			statusLine: { setSession() {} },
			clearTransientSessionUi() {},
			renderInitialMessages: async () => {},
			reloadTodos: async () => {},
			updatePendingMessagesDisplay() {},
			updateEditorBorderColor() {},
			syncIdleMaintenanceView() {},
			ui: { requestRender() {} },
			showStatus() {},
		} as unknown as InteractiveModeContext;
		return {
			ctx,
			notices: () =>
				events.filter(
					(event): event is Extract<AgentSessionEvent, { type: "notice" }> =>
						event.type === "notice" && event.source === SUBAGENT_OVERDUE_MESSAGE_TYPE,
				),
			until: async done => {
				while (!done()) {
					const { promise, resolve } = Promise.withResolvers<void>();
					waiters.push(resolve);
					await promise;
				}
			},
		};
	}

	it(
		"ends each notice exactly once through a fork, a navigation and a stuck request",
		async () => {
			const boss = await agent({ id: "Boss", kind: "main", persist: true });
			await boss.session.prompt("before");
			const cut = boss.session.sessionManager.getLeafId()!;
			await boss.session.prompt("the conversation the work is dispatched from");
			const dispatchLeaf = boss.session.sessionManager.getLeafId()!;
			const lead = await agent({
				id: "Lead",
				kind: "sub",
				parentId: "Boss",
				persist: true,
				dispatch: dispatch("task", "Phases", SLACK_DUE_MINUTES),
			});
			// Fork: the owner notice falls due while the owner's fork is in flight.
			const entered = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const realFork = lead.session.sessionManager.fork.bind(lead.session.sessionManager);
			vi.spyOn(lead.session.sessionManager, "fork").mockImplementation(async () => {
				entered.resolve();
				await release.promise;
				return realFork();
			});
			await lead.session.prompt("dispatch");
			await childStarted.promise;
			const forking = lead.session.fork();
			await entered.promise;
			// The due-by runs on the real clock (see the file header): hold the fork past it.
			await Bun.sleep(SLACK_DUE_MS + 400);
			release.resolve();
			expect(await forking).toBe(true);
			await lead.seen(OWNER_NOTICE);
			// Navigation: the escalation's recipient leaves the dispatch and comes back.
			expect((await boss.session.navigateTree(cut)).cancelled).toBe(false);
			expect((await boss.session.navigateTree(dispatchLeaf)).cancelled).toBe(false);
			// Stuck request: the recipient's request that carries the escalation is
			// held in preparation past the bound, so no request carrying it is sent.
			const held = Promise.withResolvers<void>();
			const unhold = Promise.withResolvers<void>();
			const removeGate = boss.session.agent.addBeforeModelCall(async context => {
				if (!JSON.stringify(context.messages).includes(ESCALATION)) return;
				held.resolve();
				await unhold.promise;
			});
			try {
				await held.promise;
				const got = await Promise.race([
					// No main session here: the owner's own subscribers stand in for the person.
					lead.warned(LOST_NOTICE).then(() => "the person, inside the bound"),
					Bun.sleep(NOTICE_DEADLINE_MS + 5_000).then(() => "nobody: the notice counted as read"),
				]);
				expect(got).toBe("the person, inside the bound");
			} finally {
				unhold.resolve();
				removeGate();
			}
			await boss.session.waitForIdle();
			await lead.session.waitForIdle();

			const warnings = [...lead.notices, ...boss.notices];
			expect(endsOf("Phases", "owner", [lead, boss], warnings)).toBe(1);
			// The bound ended it: the released request goes out without it.
			expect(boss.saw(ESCALATION)).toBe(false);
			expect(endsOf("Phases", "escalation", [lead, boss], warnings)).toBe(1);
			child.resolve(childResult("Phases", "task"));
			await manager.getJob("Phases")?.promise;
		},
		NOTICE_DEADLINE_MS + 25_000,
	);

	it(
		"ends a notice exactly once when the conversation it was queued for navigates away",
		async () => {
			const boss = await agent({ id: "Boss", kind: "main", persist: true });
			await boss.session.prompt("before");
			const cut = boss.session.sessionManager.getLeafId()!;
			await boss.session.prompt("the dispatch-time conversation");
			const lead = await agent({
				id: "Lead",
				kind: "sub",
				parentId: "Boss",
				dispatch: dispatch("gate", "Navigated", SLACK_DUE_MINUTES),
			});
			const deliver = boss.session.notifySubagentOverdue.bind(boss.session);
			const moved = Promise.withResolvers<void>();
			// Phase: queued, then the recipient's conversation moves off the address.
			vi.spyOn(boss.session, "notifySubagentOverdue").mockImplementation(entry => {
				const receipt = deliver(entry);
				void boss.session.navigateTree(cut).then(() => moved.resolve());
				return receipt;
			});
			const run = lead.session.prompt("dispatch");
			await childStarted.promise;
			await moved.promise;
			await boss.session.yieldQueue.flush("idle");
			await lead.warned(LOST_NOTICE);
			await boss.session.waitForIdle();

			expect(boss.saw(ESCALATION)).toBe(false);
			expect(endsOf("Navigated", "escalation", [boss, lead], [...boss.notices, ...lead.notices])).toBe(1);
			child.resolve(childResult("Navigated", "gate"));
			await run;
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"never lets an earlier turn's repeat of a tool call id anchor the current dispatch",
		async () => {
			const owner = await agent({
				id: "Main",
				kind: "main",
				persist: true,
				dispatch: dispatch("task", "Repeated", SLACK_DUE_MINUTES),
			});
			const sm = owner.session.sessionManager;
			// A finished dispatch of an earlier turn, under the id this harness reuses.
			sm.appendMessage({ role: "user", content: "historical dispatch", timestamp: Date.now() });
			const model = createMockModel({ provider: "openai", id: "gpt-test" }).model;
			const oldCall = sm.appendMessage({
				role: "assistant",
				content: [{ type: "toolCall", id: "Main-task", name: "task", arguments: dispatch("task", "Old") }],
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: zeroUsage,
				stopReason: "toolUse",
				timestamp: Date.now(),
			});
			sm.appendMessage({
				role: "toolResult",
				toolCallId: "Main-task",
				toolName: "task",
				content: [{ type: "text", text: "Old finished" }],
				isError: false,
				timestamp: Date.now(),
			});
			const historicalLeaf = sm.appendCustomEntry("historical-complete");
			owner.session.agent.replaceMessages(sm.buildSessionContext().messages);
			await owner.session.prompt("dispatch again");
			await childStarted.promise;
			const currentCall = sm
				.getEntries()
				.findLast(
					entry =>
						entry.type === "message" &&
						entry.message.role === "assistant" &&
						entry.message.content.some(part => part.type === "toolCall" && part.id === "Main-task"),
				)!.id;
			expect(currentCall).not.toBe(oldCall);
			// Back to the finished dispatch: the old call is on the branch, this one is not.
			expect((await owner.session.navigateTree(historicalLeaf)).cancelled).toBe(false);
			expect(sm.getBranch().some(entry => entry.id === oldCall)).toBe(true);
			expect(sm.getBranch().some(entry => entry.id === currentCall)).toBe(false);

			await owner.warned(LOST_NOTICE);
			expect(owner.saw(OWNER_NOTICE)).toBe(false);
			expect(endsOf("Repeated", "owner", [owner], owner.notices)).toBe(1);
			child.resolve(childResult("Repeated", "task"));
			await manager.getJob("Repeated")?.promise;
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"never lets an earlier turn's repeat of a tool call id anchor a dispatch launched while its call streams",
		async () => {
			const release = Promise.withResolvers<void>();
			const args = { context: "ctx", tasks: [dispatch("task", "RepeatedSpec", SLACK_DUE_MINUTES)] };
			const owner = await agent({
				id: "Main",
				kind: "main",
				persist: true,
				dispatch: args,
				hold: release.promise,
				settings: { "task.batch": true },
			});
			const sm = owner.session.sessionManager;
			const model = createMockModel({ provider: "openai", id: "gpt-test" }).model;
			// A finished dispatch of an earlier turn, under the id the streamed call reuses.
			sm.appendMessage({ role: "user", content: "historical dispatch", timestamp: Date.now() });
			const oldCall = sm.appendMessage({
				role: "assistant",
				content: [{ type: "toolCall", id: "Main-task", name: "task", arguments: dispatch("task", "Old") }],
				api: model.api,
				provider: model.provider,
				model: model.id,
				usage: zeroUsage,
				stopReason: "toolUse",
				timestamp: Date.now(),
			});
			sm.appendMessage({
				role: "toolResult",
				toolCallId: "Main-task",
				toolName: "task",
				content: [{ type: "text", text: "Old finished" }],
				isError: false,
				timestamp: Date.now(),
			});
			const historicalLeaf = sm.appendCustomEntry("historical-complete");
			owner.session.agent.replaceMessages(sm.buildSessionContext().messages);
			const prompting = owner.session.prompt("dispatch again, streamed");
			while (owner.contexts.length === 0) await setImmediate();
			const sink: SpeculativeOperationSink = {
				maxInFlight: 2,
				admit: async () => undefined,
				authorizeLaunch: async () => ({ allowed: true }),
				close() {},
			};
			const toolCall: AgentToolCall = { type: "toolCall", id: "Main-task", name: "task", arguments: {} };
			const launch = (await owner.task.speculation.stream?.open({
				coordinator: sink,
				parentToolCallId: toolCall.id,
			})) as TaskLaunchSession;
			try {
				// The child starts while the call still streams: nothing of it is written yet.
				const json = JSON.stringify(args);
				launch.update(toolCall, json.slice(0, json.length - 2));
				await childStarted.promise;
				launch.finalize({ toolCall, args });
				release.resolve();
				await prompting;
				const currentCall = sm
					.getEntries()
					.findLast(
						entry =>
							entry.type === "message" &&
							entry.message.role === "assistant" &&
							entry.message.content.some(part => part.type === "toolCall" && part.id === "Main-task"),
					)!.id;
				expect(currentCall).not.toBe(oldCall);
				expect((await owner.session.navigateTree(historicalLeaf)).cancelled).toBe(false);
				expect(sm.getBranch().some(entry => entry.id === oldCall)).toBe(true);
				expect(sm.getBranch().some(entry => entry.id === currentCall)).toBe(false);

				const got = await Promise.race([
					owner.warned(LOST_NOTICE).then(() => "a loss warning"),
					owner.seen(OWNER_NOTICE).then(() => "the notice, in a conversation without the dispatch"),
				]);
				expect(got).toBe("a loss warning");
				await owner.session.waitForIdle();
				expect(owner.saw(OWNER_NOTICE)).toBe(false);
				expect(endsOf("RepeatedSpec", "owner", [owner], owner.notices)).toBe(1);
			} finally {
				release.resolve();
				child.resolve(childResult("RepeatedSpec", "task"));
				await manager.getJob("RepeatedSpec")?.promise;
				await prompting;
			}
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"surfaces a loss to the window exactly once while the person is looking at another agent",
		async () => {
			const main = await agent({
				id: "Main",
				kind: "main",
				persist: true,
				dispatch: dispatch("task", "Focused", SLACK_DUE_MINUTES),
			});
			await main.session.prompt("dispatch");
			await childStarted.promise;
			const worker = await agent({ id: "Worker", kind: "sub", parentId: "Main" });
			await worker.session.prompt("another conversation");
			const window = windowOn(main.session);
			const registry = AgentRegistry.global();
			const controller = new SessionFocusController(window.ctx, registry, () => new AgentLifecycleManager(registry));
			try {
				await controller.focusAgent("Worker");
				// Main's conversation moves off the dispatch, so both stages are lost.
				const cut = main.session.sessionManager
					.getEntries()
					.find(entry => entry.type === "message" && entry.message.role === "user")!.id;
				expect((await main.session.navigateTree(cut)).cancelled).toBe(false);
				await window.until(() =>
					window.notices().some(notice => notice.message.includes("running past twice the due-by")),
				);

				expect(main.saw(OWNER_NOTICE)).toBe(false);
				expect(endsOf("Focused", "owner", [main, worker], window.notices())).toBe(1);
				expect(endsOf("Focused", "escalation", [main, worker], window.notices())).toBe(1);
			} finally {
				controller.dispose();
				window.ctx.unsubscribe?.();
			}
			child.resolve(childResult("Focused", "task"));
			await manager.getJob("Focused")?.promise;
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"brings an escalation the person receives to the window exactly once, from a subagent's dispatch",
		async () => {
			const main = await agent({ id: "Main", kind: "main", persist: true });
			await main.session.prompt("before dispatch");
			const cut = main.session.sessionManager.getLeafId()!;
			await main.session.prompt("the conversation the owner was dispatched from");
			const viewer = await agent({ id: "Viewer", kind: "sub", parentId: "Main" });
			await viewer.session.prompt("the conversation the person looks at");
			const window = windowOn(main.session);
			const registry = AgentRegistry.global();
			const controller = new SessionFocusController(window.ctx, registry, () => new AgentLifecycleManager(registry));
			const owner = await agent({
				id: "Owner",
				kind: "sub",
				parentId: "Main",
				dispatch: dispatch("task", "Fallback", SLACK_DUE_MINUTES),
			});
			try {
				await controller.focusAgent("Viewer");
				await owner.session.prompt("dispatch child");
				// Main no longer holds the dispatch-time conversation, so the
				// escalation falls back to the person above the owner itself.
				expect((await main.session.navigateTree(cut)).cancelled).toBe(false);
				const got = await Promise.race([
					window
						.until(() => window.notices().some(notice => notice.message.includes(ESCALATION)))
						.then(() => "the window"),
					owner.warned(ESCALATION).then(() => "only the owner's session, which the window does not show"),
				]);
				expect(got).toBe("the window");

				expect(endsOf("Fallback", "escalation", [main, owner, viewer], window.notices())).toBe(1);
				// The window is the one surface: no session shows it as well.
				expect(owner.notices.filter(notice => notice.message.includes(ESCALATION))).toHaveLength(0);
				expect(main.saw(ESCALATION)).toBe(false);
			} finally {
				controller.dispose();
				window.ctx.unsubscribe?.();
				child.resolve(childResult("Fallback", "task"));
				await manager.getJob("Fallback")?.promise;
			}
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"spends one bound on a notice, queued time included, and surfaces the loss inside it",
		async () => {
			const owner = await agent({
				id: "Main",
				kind: "main",
				persist: true,
				dispatch: dispatch("task", "HeldQueue"),
			});
			const entered = Promise.withResolvers<void>();
			const release = Promise.withResolvers<void>();
			const realFork = owner.session.sessionManager.fork.bind(owner.session.sessionManager);
			vi.spyOn(owner.session.sessionManager, "fork").mockImplementation(async () => {
				entered.resolve();
				await release.promise;
				return realFork();
			});
			let transition: Promise<boolean> | undefined;
			const deliver = owner.session.notifySubagentOverdue.bind(owner.session);
			// Queued, then held by a transition that outlasts the bound.
			vi.spyOn(owner.session, "notifySubagentOverdue").mockImplementation(entry => {
				const receipt = deliver(entry);
				transition ??= owner.session.fork();
				return receipt;
			});
			await owner.session.prompt("dispatch");
			await childStarted.promise;
			await entered.promise;

			const got = await Promise.race([
				owner.warned(LOST_NOTICE).then(() => "the person, inside the bound"),
				Bun.sleep(NOTICE_DEADLINE_MS + 5_000).then(() => "nobody, still queued"),
			]);
			expect(got).toBe("the person, inside the bound");
			expect(owner.saw(OWNER_NOTICE)).toBe(false);
			release.resolve();
			expect(await transition!).toBe(true);
			await owner.session.waitForIdle();
			// The bound ended it: the fork settling cannot deliver it a second time.
			expect(owner.saw(OWNER_NOTICE)).toBe(false);
			expect(endsOf("HeldQueue", "owner", [owner], owner.notices)).toBe(1);
			child.resolve(childResult("HeldQueue", "task"));
			await manager.getJob("HeldQueue")?.promise;
		},
		NOTICE_DEADLINE_MS + 25_000,
	);

	it(
		"never delivers a notice already built for a request once its bound has passed",
		async () => {
			const release = Promise.withResolvers<void>();
			const owner = await agent({ id: "Main", kind: "main", hold: release.promise });
			const prompting = owner.session.prompt("streaming while the child starts");
			while (owner.contexts.length === 0) await setImmediate();
			await owner.task.execute("manual-task", dispatch("task", "Built"));
			await childStarted.promise;
			while (!owner.session.yieldQueue.has(SUBAGENT_OVERDUE_MESSAGE_TYPE)) await setImmediate();
			// The loop builds the notice into its next request, then the process
			// pauses before that request is sent, past the bound.
			const built = Promise.withResolvers<void>();
			const drain = owner.session.yieldQueue.drainLazy.bind(owner.session.yieldQueue);
			vi.spyOn(owner.session.yieldQueue, "drainLazy").mockImplementation(() =>
				drain().map(thunk => () => {
					const message = thunk();
					if (message?.role === "custom" && message.customType === SUBAGENT_OVERDUE_MESSAGE_TYPE) {
						agentPauseGate.pause();
						built.resolve();
					}
					return message;
				}),
			);
			try {
				release.resolve();
				await built.promise;
				await owner.warned(LOST_NOTICE);
				agentPauseGate.resume();
				await prompting;
				await owner.session.waitForIdle();
				expect(owner.saw(OWNER_NOTICE)).toBe(false);
				expect(endsOf("Built", "owner", [owner], owner.notices)).toBe(1);
			} finally {
				agentPauseGate.resume();
				release.resolve();
				child.resolve(childResult("Built", "task"));
				await manager.getJob("Built")?.promise;
				await prompting;
			}
		},
		NOTICE_DEADLINE_MS + 20_000,
	);

	it(
		"counts a notice read only once a request carrying it is sent, not while its request is prepared",
		async () => {
			const owner = await agent({ id: "Main", kind: "main", dispatch: dispatch("task", "Preflight") });
			const held = Promise.withResolvers<void>();
			const unhold = Promise.withResolvers<void>();
			const shown: AgentSessionEvent[] = [];
			owner.session.subscribe(event => {
				if (
					event.type === "message_end" &&
					event.message.role === "custom" &&
					event.message.customType === SUBAGENT_OVERDUE_MESSAGE_TYPE
				) {
					shown.push(event);
				}
			});
			const removeGate = owner.session.agent.addBeforeModelCall(async context => {
				if (!JSON.stringify(context.messages).includes(OWNER_NOTICE)) return;
				held.resolve();
				await unhold.promise;
			});
			try {
				await owner.session.prompt("dispatch child");
				await held.promise;
				const got = await Promise.race([
					owner.warned(LOST_NOTICE).then(() => "the person, inside the bound"),
					Bun.sleep(NOTICE_DEADLINE_MS + 5_000).then(() => "nobody: the notice counted as read"),
				]);
				expect(got).toBe("the person, inside the bound");
			} finally {
				unhold.resolve();
				removeGate();
			}
			await owner.session.waitForIdle();
			// The released preparation sends no request with it, and the transcript never shows it.
			expect(owner.saw(OWNER_NOTICE)).toBe(false);
			expect(shown).toHaveLength(0);
			expect(endsOf("Preflight", "owner", [owner], owner.notices)).toBe(1);
			child.resolve(childResult("Preflight", "task"));
			await manager.getJob("Preflight")?.promise;
		},
		NOTICE_DEADLINE_MS + 20_000,
	);

	/** The owner-stage receipt of `owner`'s next due-by notice: how the queue ended it. */
	function ownerReceipt(owner: Observed): Promise<"delivered" | "discarded"> {
		const ended = Promise.withResolvers<"delivered" | "discarded">();
		const notify = owner.session.notifySubagentOverdue.bind(owner.session);
		vi.spyOn(owner.session, "notifySubagentOverdue").mockImplementation(entry => {
			const receipt = notify(entry);
			if (entry.stage === "owner") {
				void receipt.then(
					() => ended.resolve("delivered"),
					() => ended.resolve("discarded"),
				);
			}
			return receipt;
		});
		return ended.promise;
	}

	it(
		"never counts a notice read when a callback after the gates stops its request from being sent",
		async () => {
			const owner = await agent({ id: "Main", kind: "main", dispatch: dispatch("task", "Metadata") });
			let failing = false;
			// Metadata is resolved after every pre-request gate and after credentials.
			owner.session.agent.setMetadataResolver(() => {
				if (failing) throw new Error("metadata failure");
				return undefined;
			});
			const removeGate = owner.session.agent.addBeforeModelCall(context => {
				if (JSON.stringify(context.messages).includes(OWNER_NOTICE)) failing = true;
			});
			const receipt = ownerReceipt(owner);
			try {
				await owner.session.prompt("dispatch child");
				expect(await receipt).toBe("discarded");
				await owner.warned(LOST_NOTICE);
				await owner.session.waitForIdle();
				expect(owner.saw(OWNER_NOTICE)).toBe(false);
				expect(endsOf("Metadata", "owner", [owner], owner.notices)).toBe(1);
			} finally {
				removeGate();
				owner.session.agent.setMetadataResolver(undefined);
				child.resolve(childResult("Metadata", "task"));
				await manager.getJob("Metadata")?.promise;
			}
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"never counts a notice read by a request a pre-request callback took it out of",
		async () => {
			const owner = await agent({ id: "Main", kind: "main", dispatch: dispatch("task", "Removed") });
			const removeGate = owner.session.agent.addBeforeModelCall(context => {
				context.messages = context.messages.filter(message => !JSON.stringify(message).includes(OWNER_NOTICE));
			});
			const receipt = ownerReceipt(owner);
			try {
				await owner.session.prompt("dispatch child");
				expect(await receipt).toBe("discarded");
				await owner.warned(LOST_NOTICE);
				await owner.session.waitForIdle();
				expect(owner.saw(OWNER_NOTICE)).toBe(false);
				expect(endsOf("Removed", "owner", [owner], owner.notices)).toBe(1);
				// The warning names the cause: the conversation is still there, no request carried it.
				const warning = owner.notices.find(notice => notice.message.includes(LOST_NOTICE))!.message;
				expect(warning).toContain("no request that carried the notice was sent");
				expect(warning).not.toContain("the conversation that dispatched it is gone");
			} finally {
				removeGate();
				child.resolve(childResult("Removed", "task"));
				await manager.getJob("Removed")?.promise;
			}
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"holds a notice to its bound by the clock, even when a blocked event loop delays its timer",
		async () => {
			const owner = await agent({ id: "Main", kind: "main", dispatch: dispatch("task", "Blocked") });
			const removeGate = owner.session.agent.addBeforeModelCall(context => {
				// A synchronous callback (a storage lock, a heavy extension) blocks the
				// whole event loop past the bound, so the bound's own timer cannot run
				// before the request continues. This needs the real platform clock.
				if (JSON.stringify(context.messages).includes(OWNER_NOTICE)) Bun.sleepSync(NOTICE_DEADLINE_MS + 1_000);
			});
			const receipt = ownerReceipt(owner);
			try {
				await owner.session.prompt("dispatch child");
				expect(await receipt).toBe("discarded");
				await owner.warned(LOST_NOTICE);
				await owner.session.waitForIdle();
				expect(owner.saw(OWNER_NOTICE)).toBe(false);
				expect(endsOf("Blocked", "owner", [owner], owner.notices)).toBe(1);
				const warning = owner.notices.find(notice => notice.message.includes(LOST_NOTICE))!.message;
				expect(warning).toContain("no request carrying the notice reached a model within");
			} finally {
				removeGate();
				child.resolve(childResult("Blocked", "task"));
				await manager.getJob("Blocked")?.promise;
			}
		},
		NOTICE_DEADLINE_MS + 20_000,
	);

	it("shows a person notice at the window once, and nowhere else, until the window is disposed", async () => {
		const main = await agent({ id: "Main", kind: "main" });
		await main.session.prompt("main");
		const registry = AgentRegistry.global();
		const window = windowOn(main.session);
		const controller = new SessionFocusController(window.ctx, registry, () => new AgentLifecycleManager(registry));
		registry.notifyPerson(
			{ level: "warning", message: "WINDOW_OPEN", source: SUBAGENT_OVERDUE_MESSAGE_TYPE },
			main.session,
		);
		controller.dispose();
		window.ctx.unsubscribe?.();
		registry.notifyPerson(
			{ level: "warning", message: "WINDOW_GONE", source: SUBAGENT_OVERDUE_MESSAGE_TYPE },
			main.session,
		);
		expect(window.notices().map(notice => notice.message)).toEqual(["WINDOW_OPEN"]);
		expect(main.notices.map(notice => notice.message)).toEqual(["WINDOW_GONE"]);
	});
});
