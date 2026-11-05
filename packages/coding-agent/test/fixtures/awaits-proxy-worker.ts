/**
 * Subagent worker entry for the awaits-proxy test: the real link wiring of
 * `subagent-worker-entry` with only the identity and agents services, plus a
 * probe service that drives `holdOwnedJobs` and a real `WaitTool` against the
 * worker's registry proxy, so a failed main-side subscription is observed
 * through the actual RPC path rather than a local spy.
 */
import { MessagePort, parentPort } from "node:worker_threads";
import { AsyncJobManager } from "../../src/async/job-manager";
import { Settings } from "../../src/config/settings";
import { closeDaemonClients } from "../../src/launch/client";
import { holdOwnedJobs } from "../../src/registry/agent-awaits";
import { AgentRegistry } from "../../src/registry/agent-registry";
// Loads the cyclic service graph before the isolated service imports below.
import "../../src/session/agent-session";
import { loadedModulesChangedSince } from "../../src/thread/code-skew";
import { isThreadId, setCurrentThreadId } from "../../src/thread/identity";
import type { SubagentWorkerInit, SubagentWorkerReady, WorkerThreadLink } from "../../src/thread/protocol";
import { type RpcFrame, RpcLink } from "../../src/thread/rpc";
import type { ThreadService } from "../../src/thread/services";
import { agentsThreadService } from "../../src/thread/services/agents";
import { identityThreadService } from "../../src/thread/services/identity";
import type { ToolSession } from "../../src/tools";
import { WaitTool } from "../../src/tools/wait";

/** Operations the test drives on the worker. */
export interface AwaitsProxyProbe {
	/** Register a running job owned by `Main` and run by `Child`. */
	startJob(): Promise<void>;
	/** Call `holdOwnedJobs` for `Main`; returns its error, if any, and who waits on `Child`. */
	acquire(): Promise<{ error: string; waiters: string[] }>;
	/** Open a registry subscription that succeeds, as any later caller would. */
	subscribeAgain(): Promise<void>;
	/** Who waits on `Child` now. */
	waiters(): Promise<string[]>;
	/** The child's own `wait({ timeout })`, through the real tool. */
	childIdleText(timeoutSeconds?: number): Promise<string>;
	/**
	 * The same call with the launch broker enabled against `cwd`, so the wait
	 * runs its owned-service refresh against that project's broker token.
	 */
	childIdleTextWithBroker(cwd: string, timeoutSeconds: number): Promise<string>;
	/** Finish the job and drop everything this probe holds. */
	close(): Promise<void>;
}

/** Test-only boot globals of the probe service. */
export interface AwaitsProxyProbeGlobals {
	ready(probe: AwaitsProxyProbe): void;
}

const port = parentPort;
if (!port) throw new Error("fixture must run in a worker");

const manager = new AsyncJobManager({ onJobComplete: () => {} });
const childRun = Promise.withResolvers<string>();
let unsubscribe: (() => void) | undefined;

function childSession(opts: { cwd?: string; launch?: boolean } = {}): ToolSession {
	return {
		cwd: opts.cwd ?? process.cwd(),
		settings: Settings.isolated({ "launch.enabled": opts.launch ?? false }),
		agentRegistry: AgentRegistry.global(),
		asyncJobManager: manager,
		getAgentId: () => "Child",
	} as unknown as ToolSession;
}

async function idleText(session: ToolSession, timeoutSeconds: number): Promise<string> {
	const result = await new WaitTool(session).execute("child-idle", { timeout: timeoutSeconds });
	const first = result.content[0];
	return first?.type === "text" ? (first.text ?? "") : "";
}

const probe: AwaitsProxyProbe = {
	startJob: async () => {
		manager.register("task", "Child", async () => childRun.promise, {
			id: "Child",
			agentId: "Child",
			ownerId: "Main",
		});
	},
	acquire: async () => {
		let error = "";
		try {
			holdOwnedJobs(AgentRegistry.global(), manager, "Main");
		} catch (failure) {
			error = String(failure);
		}
		return { error, waiters: AgentRegistry.global().awaits.waitersOn("Child") };
	},
	subscribeAgain: async () => {
		unsubscribe = AgentRegistry.global().onChange(() => {});
	},
	waiters: async () => AgentRegistry.global().awaits.waitersOn("Child"),
	childIdleText: async (timeoutSeconds = 1) => idleText(childSession(), timeoutSeconds),
	childIdleTextWithBroker: async (cwd, timeoutSeconds) =>
		idleText(childSession({ cwd, launch: true }), timeoutSeconds),
	close: async () => {
		await closeDaemonClients();
		unsubscribe?.();
		childRun.resolve("done");
		await manager.dispose({ timeoutMs: 1_000 });
	},
};

function isProbeGlobals(value: unknown): value is AwaitsProxyProbeGlobals {
	return typeof value === "object" && value !== null && typeof Reflect.get(value, "ready") === "function";
}

const probeService: ThreadService = {
	name: "awaits-proxy-probe",
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
