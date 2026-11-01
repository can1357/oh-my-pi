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
 *
 * Due-bys here are a fraction of a second and the clock runs on real timers:
 * the session's idle flush and the agent loop's interrupt poll, which carry
 * the notice to the model, run on the same real clock, so faking timers
 * would change the delivery path under test.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Context } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { AssistantMessageEventStream } from "@oh-my-pi/pi-ai/utils/event-stream";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentLifecycleManager } from "@oh-my-pi/pi-coding-agent/registry/agent-lifecycle";
import { type AgentKind, AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { AgentSession, type AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TaskTool } from "@oh-my-pi/pi-coding-agent/task";
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
	contexts: Context[];
	notices: Array<Extract<AgentSessionEvent, { type: "notice" }>>;
	/** Resolves with the request time once a model request contains `needle`. */
	seen(needle: string): Promise<number>;
	saw(needle: string): boolean;
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
	}): Promise<Observed> {
		const model = createMockModel({ provider: "openai", id: "gpt-test" }).model;
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"todo.enabled": false,
			"launch.enabled": false,
			"async.enabled": true,
			"task.batch": false,
		});
		settings.setModelRole("default", `${model.provider}/${model.id}`);
		const registry = AgentRegistry.global();
		const task = await TaskTool.create({
			cwd: tempDir.path(),
			hasUI: false,
			settings,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			getAgentId: () => options.id,
			agentRegistry: registry,
			asyncJobManager: manager,
		} as unknown as ToolSession);
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
				queueMicrotask(() => {
					stream.push({ type: "start", partial: message });
					stream.push({ type: "done", reason: dispatching ? "toolUse" : "stop", message });
				});
				return stream;
			},
		});
		const session = new AgentSession({
			agent: agentCore,
			sessionManager: SessionManager.inMemory(tempDir.path()),
			settings,
			modelRegistry: new ModelRegistry(authStorage),
			toolRegistry: new Map([["task", task as unknown as AgentTool]]),
			agentId: options.id,
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
			contexts,
			notices,
			seen: needle => {
				const { promise, resolve } = Promise.withResolvers<number>();
				if (contexts.some(context => JSON.stringify(context.messages).includes(needle))) resolve(Date.now());
				else waiters.push({ needle, resolve });
				return promise;
			},
			saw: needle => contexts.some(context => JSON.stringify(context.messages).includes(needle)),
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
			const lead = await agent({ id: "Lead", kind: "sub", parentId: "Boss", dispatch: dispatch("task", "Quick") });
			child.resolve(childResult("Quick", "task", { output: "QUICK_RESULT" }));
			await lead.session.prompt("dispatch");
			await lead.seen("QUICK_RESULT");
			// Wait past both stages of the clock (real time, see the file header).
			await Bun.sleep(2 * DUE_MS + 500);
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
			const owner = await agent({ id: "Main", kind: "main", dispatch: dispatch("task", "Broken") });
			child.resolve(childResult("Broken", "task", { exitCode: 1, error: "LOUD_FAILURE", output: "" }));
			await owner.session.prompt("dispatch");
			// Today's loud path: the owner reads the failed result as a background-job notice.
			await owner.seen('<task-result id=\\"Broken\\" agent=\\"task\\" status=\\"failed (exit 1)\\"');
			expect(manager.getJob("Broken")?.status).toBe("failed");
			await Bun.sleep(2 * DUE_MS + 500);
			await owner.session.waitForIdle();
			expect(owner.saw(OWNER_NOTICE)).toBe(false);
			expect(owner.notices.filter(notice => notice.message.includes(ESCALATION))).toEqual([]);
		},
		TEST_TIMEOUT_MS,
	);
});
