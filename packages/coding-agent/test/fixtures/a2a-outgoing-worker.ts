/**
 * Subagent worker entry for the outgoing-registry tests: the real link wiring
 * of `subagent-worker-entry` with the A2A outgoing service plus a probe that
 * drives the worker's installed registry proxy.
 */
import { MessagePort, parentPort } from "node:worker_threads";
import { type OutgoingRequest, OutgoingRequests } from "../../src/a2a/outgoing-requests";
import { isThreadId, setCurrentThreadId } from "../../src/thread/identity";
import { loadedModulesChangedSince } from "../../src/thread/code-skew";
import type { SubagentWorkerInit, SubagentWorkerReady, WorkerThreadLink } from "../../src/thread/protocol";
import { type RpcFrame, RpcLink } from "../../src/thread/rpc";
import type { ThreadService } from "../../src/thread/services";
import { a2aOutgoingThreadService } from "../../src/thread/services/a2a-outgoing";

/** Operations the test drives on the worker's installed registry proxy. */
export interface OutgoingProbe {
	threadId(): Promise<string>;
	register(request: OutgoingRequest): Promise<void>;
	wait(messageId: string): Promise<string>;
	/** Park a wait the test can abort, without awaiting it. */
	beginCancellableWait(messageId: string): Promise<void>;
	abortWait(messageId: string): Promise<void>;
	/** pending, rejected, or resolved — does not re-enter the wait RPC. */
	waitState(messageId: string): Promise<"missing" | "pending" | "rejected" | "resolved">;
	hasOwner(ownerId: string): Promise<boolean>;
}

/** Test-only boot globals of the probe service. */
export interface OutgoingProbeGlobals {
	ready(probe: OutgoingProbe): void;
}

const port = parentPort;
if (!port) throw new Error("fixture must run in a worker");

const controllers = new Map<string, AbortController>();
const states = new Map<string, "pending" | "rejected" | "resolved">();
let threadName = "";

const probe: OutgoingProbe = {
	threadId: async () => threadName,
	register: request => OutgoingRequests.global().register(request),
	wait: messageId => OutgoingRequests.global().wait(messageId),
	beginCancellableWait: async messageId => {
		const controller = new AbortController();
		controllers.set(messageId, controller);
		states.set(messageId, "pending");
		const pending = OutgoingRequests.global().wait(messageId, controller.signal);
		pending.then(
			() => states.set(messageId, "resolved"),
			() => states.set(messageId, "rejected"),
		);
	},
	abortWait: async messageId => {
		const controller = controllers.get(messageId);
		if (!controller) throw new Error(`no cancellable wait ${messageId}`);
		controller.abort();
	},
	waitState: async messageId => states.get(messageId) ?? "missing",
	hasOwner: async ownerId => OutgoingRequests.global().hasOwner(ownerId),
};

function isProbeGlobals(value: unknown): value is OutgoingProbeGlobals {
	return typeof value === "object" && value !== null && typeof Reflect.get(value, "ready") === "function";
}

const probeService: ThreadService = {
	name: "a2a-outgoing-probe",
	boot(globals) {
		if (!isProbeGlobals(globals)) throw new Error("probe globals missing");
		globals.ready(probe);
	},
};

const services: readonly ThreadService[] = [a2aOutgoingThreadService, probeService];

function isInit(value: unknown): value is SubagentWorkerInit {
	return (
		typeof value === "object" &&
		value !== null &&
		Reflect.get(value, "type") === "subagent-worker-init" &&
		isThreadId(Reflect.get(value, "threadId")) &&
		Reflect.get(value, "replyPort") instanceof MessagePort &&
		Reflect.get(value, "counter") instanceof SharedArrayBuffer &&
		typeof Reflect.get(value, "mainStartedAt") === "number"
	);
}

function isFrame(value: unknown): value is RpcFrame {
	return typeof value === "object" && value !== null && typeof Reflect.get(value, "t") === "string";
}

let frameHandler: ((frame: RpcFrame) => void) | undefined;

port.on("message", (message: unknown) => {
	if (!frameHandler) {
		if (!isInit(message)) return;
		threadName = message.threadId;
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
