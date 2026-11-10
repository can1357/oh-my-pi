import { MessagePort, parentPort } from "node:worker_threads";
import {
	IncomingRequests,
	type IncomingRequestLease,
	type IncomingRequestMatch,
} from "../../src/a2a/incoming-requests";
import type { A2aIncomingRequest } from "../../src/a2a/rpc";
import { loadedModulesChangedSince } from "../../src/thread/code-skew";
import { isThreadId, setCurrentThreadId } from "../../src/thread/identity";
import type { SubagentWorkerInit, SubagentWorkerReady, WorkerThreadLink } from "../../src/thread/protocol";
import { type RpcFrame, RpcLink } from "../../src/thread/rpc";
import type { ThreadService } from "../../src/thread/services";
import { a2aIncomingThreadService } from "../../src/thread/services/a2a-incoming";

export interface IncomingProbe {
	note(request: A2aIncomingRequest): Promise<void>;
	consume(match: IncomingRequestMatch): Promise<IncomingRequestLease | undefined>;
	confirm(leaseId: string): Promise<boolean>;
	release(leaseId: string): Promise<boolean>;
	discard(match: IncomingRequestMatch): Promise<void>;
	list(to?: string): Promise<A2aIncomingRequest[]>;
}

export interface IncomingProbeGlobals {
	ready(probe: IncomingProbe): void;
}

const port = parentPort;
if (!port) throw new Error("fixture must run in a worker");

const probe: IncomingProbe = {
	note: request => IncomingRequests.global().note(request),
	consume: match => IncomingRequests.global().consume(match),
	confirm: leaseId => IncomingRequests.global().confirm(leaseId),
	release: leaseId => IncomingRequests.global().release(leaseId),
	discard: match => IncomingRequests.global().discard(match),
	list: to => IncomingRequests.global().list(to),
};
const probeService: ThreadService = {
	name: "a2a-incoming-probe",
	boot(globals) {
		if (typeof globals !== "object" || globals === null || typeof Reflect.get(globals, "ready") !== "function") {
			throw new Error("probe globals missing");
		}
		(globals as IncomingProbeGlobals).ready(probe);
	},
};
const services: readonly ThreadService[] = [a2aIncomingThreadService, probeService];

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
				sync: {
					port: message.replyPort,
					counter: new Int32Array(message.counter),
				},
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
