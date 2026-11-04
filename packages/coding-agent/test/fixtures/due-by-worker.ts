/**
 * Subagent worker entry for the due-by thread tests: the real link wiring of
 * `subagent-worker-entry` with the identity, agents and async-jobs services,
 * plus a probe service that drives real `AgentSession`s homed on this worker:
 * prompting them, arming the main thread's due-by clock from here, and
 * dispatching through a real `TaskTool` (its child run stubbed until the test
 * releases it), as a `task` call on this worker does.
 */
import { vi } from "bun:test";
import * as path from "node:path";
import { MessagePort, parentPort } from "node:worker_threads";
import { Agent, type AgentTool } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import { parseInternalUrl } from "../../src/internal-urls/parse";
import { ProcProtocolHandler } from "../../src/internal-urls/proc-protocol";
import { AgentRegistry } from "../../src/registry/agent-registry";
import { AgentSession } from "../../src/session/agent-session";
import { AuthStorage } from "../../src/session/auth-storage";
import { convertToLlm } from "../../src/session/messages";
import { SessionManager } from "../../src/session/session-manager";
import { TaskTool } from "../../src/task";
import type { DueByAddress } from "../../src/task/due-by-address";
import * as executorModule from "../../src/task/executor";
import { loadedModulesChangedSince } from "../../src/thread/code-skew";
import { setWorkerMainLink } from "../../src/thread/executor-routing";
import { isThreadId, setCurrentThreadId } from "../../src/thread/identity";
import type { SubagentWorkerInit, SubagentWorkerReady, WorkerThreadLink } from "../../src/thread/protocol";
import { type RpcFrame, RpcLink } from "../../src/thread/rpc";
import type { ThreadService } from "../../src/thread/services";
import { agentsThreadService } from "../../src/thread/services/agents";
import { asyncJobsThreadService } from "../../src/thread/services/async-jobs";
import { identityThreadService } from "../../src/thread/services/identity";
import type { ToolSession } from "../../src/tools";

/** How a probe session's model requests behave. */
export interface DueByProbeSessionOptions {
	/** A pre-request callback holds a request carrying a due-by notice this long. */
	holdBeforeModelMs?: number;
	/** The provider blocks this worker's thread this long on a request carrying a due-by notice. */
	blockInProviderMs?: number;
	/** Persist the transcript under this directory (needed for tree navigation). */
	persistDir?: string;
}

/** Operations the test drives on the worker. */
export interface DueByProbe {
	/** Build a real session (mock model, a real `task` tool) and register it as `id`, a subagent of `parentId`. */
	open(id: string, parentId: string, options?: DueByProbeSessionOptions): Promise<void>;
	/** Run a prompt on the local session to completion. */
	prompt(id: string, text: string): Promise<void>;
	/** The provider-bound context of every model request the local session sent, as JSON. */
	requests(id: string): Promise<string[]>;
	/** This session's own address for a dispatch made now (leaf, no tool call). */
	address(id: string): Promise<DueByAddress>;
	/** Append a marker entry to the local session's transcript; returns its id. */
	appendCutPoint(id: string): Promise<string>;
	/**
	 * Arm the due-by clock from this worker for `childId`, dispatched by the
	 * local session `ownerId`, through the worker's registry proxy.
	 */
	arm(childId: string, ownerId: string, dueMs: number): Promise<void>;
	/** Settle the run of `childId` armed here. */
	settle(childId: string): Promise<void>;
	/** Dispose the local session, then ask main to show a person notice standing on it. */
	notifyPersonOnDisposed(id: string): Promise<boolean>;
	/**
	 * Dispatch `childName` through the local session's real `task` tool as a
	 * background job; report what this worker sees as soon as `execute`
	 * returns: the clock's due-by for it and the `proc://` listing.
	 */
	dispatchAndLook(id: string, childName: string, dueMinutes: number): Promise<{ dueAt?: number; proc: string }>;
	/**
	 * Write a `task` call into a turn on `branchFrom`, dispatch it, and move the
	 * conversation to a sibling branch of `branchFrom` in the same step, before
	 * anything the main thread calls back can run.
	 */
	dispatchThenBranchAway(id: string, childName: string, dueMinutes: number, branchFrom: string): Promise<void>;
	/** Let every stubbed child run finish. */
	releaseChildren(): Promise<void>;
}

/** Test-only boot globals of the probe service. */
export interface DueByProbeGlobals {
	ready(probe: DueByProbe): void;
	jobManager?: ToolSession["asyncJobManager"];
}

const port = parentPort;
if (!port) throw new Error("fixture must run in a worker");

const NOTICE_TEXT = "is taking longer than you said";

interface LocalSession {
	session: AgentSession;
	requests: string[];
	taskTool: TaskTool;
	toolSession: ToolSession;
}

const sessions = new Map<string, LocalSession>();
const runs = new Map<string, () => void>();
let childGate = Promise.withResolvers<void>();
let workerJobManager: ToolSession["asyncJobManager"];

function local(id: string): LocalSession {
	const entry = sessions.get(id);
	if (!entry) throw new Error(`no local session ${id}`);
	return entry;
}

const zeroUsage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const probe: DueByProbe = {
	open: async (id, parentId, options) => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("bundled model missing");
		const requests: string[] = [];
		const mock = createMockModel({ handler: () => ({ content: ["Done"] }) });
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"todo.enabled": false,
			"launch.enabled": false,
			"async.enabled": true,
			"task.batch": false,
		});
		const authStorage = await AuthStorage.create(":memory:");
		authStorage.keys.setRuntime("anthropic", "test-key");
		const registry = AgentRegistry.global();
		const persistDir = options?.persistDir;
		const sessionManager = persistDir
			? SessionManager.create(persistDir, path.join(persistDir, `sessions-${id}`))
			: SessionManager.inMemory();
		const toolSession: ToolSession = {
			cwd: persistDir ?? "/tmp",
			hasUI: false,
			settings,
			getSessionFile: () => sessionManager.getSessionFile() ?? null,
			getSessionSpawns: () => "*",
			getAgentId: () => id,
			agentRegistry: registry,
			asyncJobManager: workerJobManager,
		};
		const taskTool = await TaskTool.create(toolSession);
		const rawTool: AgentTool = {
			name: taskTool.name,
			label: taskTool.label,
			description: taskTool.description,
			parameters: taskTool.parameters,
			execute: (toolCallId, params, signal, onUpdate) => taskTool.execute(toolCallId, params, signal, onUpdate),
		};
		const blockMs = options?.blockInProviderMs;
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [rawTool] },
			convertToLlm,
			streamFn: (streamModel, context, streamOptions) => {
				const serialized = JSON.stringify(context.messages);
				requests.push(serialized);
				// After the hand-off: this thread cannot answer the main thread until it returns.
				if (blockMs && serialized.includes(NOTICE_TEXT)) Bun.sleepSync(blockMs);
				return mock.stream(streamModel, context, streamOptions);
			},
		});
		const holdMs = options?.holdBeforeModelMs;
		if (holdMs) {
			agent.addBeforeModelCall(async context => {
				if (JSON.stringify(context.messages).includes(NOTICE_TEXT)) await Bun.sleep(holdMs);
			});
		}
		const session = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry: new ModelRegistry(authStorage),
			toolRegistry: new Map([["task", rawTool]]),
			agentId: id,
			asyncJobManager: workerJobManager,
		});
		sessions.set(id, { session, requests, taskTool, toolSession });
		registry.register({
			id,
			displayName: id,
			kind: "sub",
			parentId,
			session,
			sessionFile: sessionManager.getSessionFile() ?? null,
			status: "idle",
		});
		registry.syncSessionStatus(id, session);
	},
	prompt: async (id, text) => {
		await local(id).session.prompt(text);
	},
	requests: async id => [...local(id).requests],
	address: async id => ({ entryId: local(id).session.sessionManager.getLeafId(), toolCallId: undefined }),
	appendCutPoint: async id => local(id).session.sessionManager.appendCustomEntry("cut-point"),
	arm: async (childId, ownerId, dueMs) => {
		const settled = Promise.withResolvers<void>();
		runs.set(childId, () => settled.resolve());
		AgentRegistry.global().dueBy.arm(
			{
				childId,
				ownerId,
				ownerAddress: { entryId: local(ownerId).session.sessionManager.getLeafId(), toolCallId: undefined },
				agent: "task",
				dispatchedAt: Date.now(),
				dueMs,
				stated: true,
			},
			{ settled: settled.promise, signal: new AbortController().signal },
		);
	},
	settle: async childId => {
		runs.get(childId)?.();
	},
	notifyPersonOnDisposed: async id => {
		const { session } = local(id);
		await session.dispose();
		return AgentRegistry.global().notifyPerson(
			{ level: "warning", message: "DISPOSED_HOST", source: "subagent-overdue" },
			[{ session }],
		);
	},
	dispatchAndLook: async (id, childName, dueMinutes) => {
		const { taskTool, toolSession } = local(id);
		childGate = Promise.withResolvers<void>();
		await taskTool.execute("worker-task", {
			name: childName,
			agent: "task",
			task: "Work.",
			solutionSpace: "one fix: given",
			dueMinutes,
		});
		const dueAt = AgentRegistry.global().dueBy.dueAt(childName);
		const listing = await new ProcProtocolHandler().resolve(parseInternalUrl("proc://"), { session: toolSession });
		return { dueAt, proc: listing.content };
	},
	dispatchThenBranchAway: async (id, childName, dueMinutes, branchFrom) => {
		const { session, taskTool } = local(id);
		childGate = Promise.withResolvers<void>();
		const manager = session.sessionManager;
		manager.branch(branchFrom);
		const sibling = manager.appendCustomEntry("sibling-branch");
		manager.branch(branchFrom);
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("bundled model missing");
		const params = { name: childName, agent: "task", task: "Work.", solutionSpace: "closed", dueMinutes };
		manager.appendMessage({
			role: "assistant",
			content: [{ type: "toolCall", id: "worker-branch-task", name: "task", arguments: params }],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: zeroUsage,
			stopReason: "toolUse",
			timestamp: Date.now(),
		});
		session.agent.replaceMessages(manager.buildSessionContext().messages);
		await taskTool.execute("worker-branch-task", params);
		// Same step: nothing the main thread calls back has run yet.
		manager.branch(sibling);
		session.agent.replaceMessages(manager.buildSessionContext().messages);
	},
	releaseChildren: async () => {
		childGate.resolve();
	},
};

vi.spyOn(executorModule, "runSubprocess").mockImplementation(async options => {
	await childGate.promise;
	return {
		index: 0,
		id: options.id ?? "child",
		agent: options.agent.name,
		agentSource: "bundled",
		task: "t",
		assignment: "Work.",
		exitCode: 0,
		output: "DONE",
		stderr: "",
		truncated: false,
		durationMs: 1,
		tokens: 0,
		requests: 1,
	};
});

function isProbeGlobals(value: unknown): value is DueByProbeGlobals {
	return typeof value === "object" && value !== null && typeof Reflect.get(value, "ready") === "function";
}

const probeService: ThreadService = {
	name: "due-by-probe",
	installWorker(link) {
		setWorkerMainLink(link);
	},
	boot(globals) {
		if (!isProbeGlobals(globals)) throw new Error("probe globals missing");
		workerJobManager = globals.jobManager;
		globals.ready(probe);
	},
};

const services: readonly ThreadService[] = [
	identityThreadService,
	agentsThreadService,
	asyncJobsThreadService,
	probeService,
];

function isInit(value: unknown): value is SubagentWorkerInit {
	return (
		typeof value === "object" &&
		value !== null &&
		Reflect.get(value, "type") === "subagent-worker-init" &&
		isThreadId(Reflect.get(value, "threadId")) &&
		Reflect.get(value, "replyPort") instanceof MessagePort &&
		Reflect.get(value, "counter") instanceof SharedArrayBuffer
	);
}

function isFrame(value: unknown): value is RpcFrame {
	return typeof value === "object" && value !== null && typeof Reflect.get(value, "t") === "string";
}

let frameHandler: ((frame: RpcFrame) => void) | undefined;

port.on("message", (message: unknown) => {
	if (!frameHandler) {
		if (!isInit(message)) return;
		setCurrentThreadId(message.threadId);
		const link: WorkerThreadLink = new RpcLink(
			{
				send: frame => port.postMessage(frame),
				listen: handler => {
					frameHandler = handler;
					return () => {
						frameHandler = undefined;
					};
				},
			},
			{
				name: `${message.threadId}↔main`,
				sync: { port: message.replyPort, counter: new Int32Array(message.counter) },
			},
		);
		for (const service of services) service.installWorker?.(link);
		link.handle("boot", async globals => {
			for (const service of services) await service.boot?.(globals[service.name], link);
		});
		link.handle("ping", nonce => nonce);
		const ready: SubagentWorkerReady = {
			type: "subagent-worker-ready",
			changedModules: loadedModulesChangedSince(message.mainStartedAt),
		};
		port.postMessage(ready);
		return;
	}
	if (isFrame(message)) frameHandler(message);
});
