/**
 * Subagent host worker bootstrap.
 *
 * Loaded inside a Bun worker spawned by `SubagentWorker` (`./subagent-worker`),
 * either through the CLI host selector (`__omp_worker_subagent`, which installs
 * a buffering inbox before importing this module) or directly as a module URL
 * (tests, SDK embedding). The first message is the raw
 * {@link SubagentWorkerInit}; everything after it is an RPC frame.
 *
 * Its first import routes every log record to main (`./worker-log-install`)
 * before the rest of its graph evaluates. Like the CLI's network bootstrap, it
 * then installs PI_PROXY handling on this realm's `globalThis.fetch` (each
 * worker realm has its own), before any service can make a request.
 *
 * This module only wires the link: thread identity, every service's worker
 * hooks, and the `boot`/`ping` handlers. It deliberately performs no
 * process-level side effects (title, signal or exit hooks): the process
 * belongs to the main thread.
 */
import "./worker-log-install";
import { MessagePort, parentPort } from "node:worker_threads";
import { installGlobalProxyFetch } from "@oh-my-pi/pi-ai/utils/proxy";
import { logger } from "@oh-my-pi/pi-utils";
import { consumeWorkerInbox } from "@oh-my-pi/pi-utils/worker-host";
import { loadedModulesChangedSince } from "./code-skew";
import { isThreadId, setCurrentThreadId } from "./identity";
import type { SubagentWorkerInit, SubagentWorkerReady, WorkerThreadLink } from "./protocol";
import { type RpcFrame, RpcLink } from "./rpc";
import { THREAD_SERVICES } from "./services/index";
import { warmUpSubagentWorker } from "./worker-warm-up";

installGlobalProxyFetch();

if (!parentPort) throw new Error("subagent-worker-entry: missing parentPort");
const port = parentPort;

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

// Log, then let Bun's default handling end the worker; the main side observes
// the exit, closes the link, and fails every agent homed here.
globalThis.addEventListener("error", event => {
	logger.error("Uncaught error in subagent worker", {
		err: event instanceof ErrorEvent ? (event.error ?? event.message) : event,
	});
});
globalThis.addEventListener("unhandledrejection", event => {
	logger.error("Unhandled rejection in subagent worker", { err: Reflect.get(event, "reason") });
});

let frameHandler: ((frame: RpcFrame) => void) | undefined;
let started = false;

function start(init: SubagentWorkerInit): void {
	setCurrentThreadId(init.threadId);
	const link: WorkerThreadLink = new RpcLink(
		{
			send: frame => port.postMessage(frame),
			listen: handler => {
				frameHandler = handler;
				return () => {
					if (frameHandler === handler) frameHandler = undefined;
				};
			},
		},
		{ name: `${init.threadId}↔main`, sync: { port: init.replyPort, counter: new Int32Array(init.counter) } },
	);
	for (const service of THREAD_SERVICES) service.installWorker?.(link);
	link.handle("boot", async globals => {
		for (const service of THREAD_SERVICES) await service.boot?.(globals[service.name], link);
	});
	link.handle("ping", nonce => link.callSync("ping", nonce));
	link.handle("warmUp", options => warmUpSubagentWorker(options));
	// Every module the link and its services use is loaded by now, so this covers the thread protocol.
	const ready: SubagentWorkerReady = {
		type: "subagent-worker-ready",
		changedModules: loadedModulesChangedSince(init.mainStartedAt),
	};
	port.postMessage(ready);
}

function dispatch(message: unknown): void {
	if (!started) {
		if (!isInit(message)) {
			logger.warn("Subagent worker dropped a message received before init");
			return;
		}
		started = true;
		start(message);
		return;
	}
	if (!isFrame(message)) {
		logger.warn("Subagent worker dropped a non-RPC message");
		return;
	}
	if (frameHandler) frameHandler(message);
}

// The CLI host buffered pre-spawn messages (it imports this module
// dynamically); loaded directly, this synchronous listener wins Bun's flush.
const inbox = consumeWorkerInbox();
if (inbox) inbox.bind(dispatch);
else port.on("message", dispatch);
