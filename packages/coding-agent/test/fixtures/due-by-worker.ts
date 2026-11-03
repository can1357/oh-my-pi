/**
 * Subagent worker entry for the due-by thread tests: the real link wiring of
 * `subagent-worker-entry` with the identity and agents services, plus a probe
 * service that drives real `AgentSession`s homed on this worker and arms the
 * main thread's due-by clock from here, as a `task` call on this worker does.
 */
import { MessagePort, parentPort } from "node:worker_threads";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import { AgentRegistry } from "../../src/registry/agent-registry";
import { AgentSession } from "../../src/session/agent-session";
import { AuthStorage } from "../../src/session/auth-storage";
import { convertToLlm } from "../../src/session/messages";
import { SessionManager } from "../../src/session/session-manager";
import type { DueByAddress } from "../../src/task/due-by-address";
import { loadedModulesChangedSince } from "../../src/thread/code-skew";
import { isThreadId, setCurrentThreadId } from "../../src/thread/identity";
import type { SubagentWorkerInit, SubagentWorkerReady, WorkerThreadLink } from "../../src/thread/protocol";
import { type RpcFrame, RpcLink } from "../../src/thread/rpc";
import type { ThreadService } from "../../src/thread/services";
import { agentsThreadService } from "../../src/thread/services/agents";
import { identityThreadService } from "../../src/thread/services/identity";

/** Operations the test drives on the worker. */
export interface DueByProbe {
	/** Build a real session (mock model) and register it as `id`, a subagent of `parentId`. */
	open(id: string, parentId: string): Promise<void>;
	/** Run a prompt on the local session to completion. */
	prompt(id: string, text: string): Promise<void>;
	/** The provider-bound context of every model request the local session sent, as JSON. */
	requests(id: string): Promise<string[]>;
	/** This session's own address for a dispatch made now (leaf, no tool call). */
	address(id: string): Promise<DueByAddress>;
	/**
	 * Arm the due-by clock from this worker for `childId`, dispatched by the
	 * local session `ownerId`, through the worker's registry proxy.
	 */
	arm(childId: string, ownerId: string, dueMs: number): Promise<void>;
	/** Settle the run of `childId` armed here. */
	settle(childId: string): Promise<void>;
}

/** Test-only boot globals of the probe service. */
export interface DueByProbeGlobals {
	ready(probe: DueByProbe): void;
}

const port = parentPort;
if (!port) throw new Error("fixture must run in a worker");

const sessions = new Map<string, { session: AgentSession; requests: string[] }>();
const runs = new Map<string, () => void>();

function local(id: string): { session: AgentSession; requests: string[] } {
	const entry = sessions.get(id);
	if (!entry) throw new Error(`no local session ${id}`);
	return entry;
}

const probe: DueByProbe = {
	open: async (id, parentId) => {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("bundled model missing");
		const requests: string[] = [];
		const mock = createMockModel({
			handler: context => {
				requests.push(JSON.stringify(context.messages));
				return { content: ["Done"] };
			},
		});
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [] },
			convertToLlm,
			streamFn: mock.stream,
		});
		const authStorage = await AuthStorage.create(":memory:");
		authStorage.keys.setRuntime("anthropic", "test-key");
		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated(),
			modelRegistry: new ModelRegistry(authStorage),
			agentId: id,
		});
		sessions.set(id, { session, requests });
		const registry = AgentRegistry.global();
		registry.register({ id, displayName: id, kind: "sub", parentId, session, sessionFile: null, status: "idle" });
		registry.syncSessionStatus(id, session);
	},
	prompt: async (id, text) => {
		await local(id).session.prompt(text);
	},
	requests: async id => [...local(id).requests],
	address: async id => ({ entryId: local(id).session.sessionManager.getLeafId(), toolCallId: undefined }),
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
};

function isProbeGlobals(value: unknown): value is DueByProbeGlobals {
	return typeof value === "object" && value !== null && typeof Reflect.get(value, "ready") === "function";
}

const probeService: ThreadService = {
	name: "due-by-probe",
	boot(globals) {
		if (!isProbeGlobals(globals)) throw new Error("probe globals missing");
		globals.ready(probe);
	},
};

const services: readonly ThreadService[] = [identityThreadService, agentsThreadService, probeService];

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
