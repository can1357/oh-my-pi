import { type MessagePort, parentPort } from "node:worker_threads";
import { logger } from "@oh-my-pi/pi-utils";
import { setCurrentThreadId } from "../../src/thread/identity";
import type { WorkerThreadLink } from "../../src/thread/protocol";
import { type RpcFrame, RpcLink } from "../../src/thread/rpc";
import { loggerThreadService } from "../../src/thread/services/logging";
import { installWorkerLogPort } from "../../src/thread/worker-log";

/** One record the probe logs. */
export interface ProbeRecord {
	level: "error" | "warn" | "info" | "debug";
	message: string;
	context?: Record<string, unknown>;
}

/** Worker-side operations the test drives; each crosses to main as an async function. */
export interface LoggerProbe {
	/** Log `records` in order, inside `withContext(scoped)` when given. */
	log(records: ProbeRecord[], scoped?: Record<string, unknown>): Promise<void>;
	/** Log an error record whose context holds an `Error`. */
	logError(message: string): Promise<void>;
	/** Run `logger.flush()` and report whether it returned. */
	flush(): Promise<boolean>;
}

/** Test-only boot globals next to the service's own. */
export interface LoggerTestGlobals {
	ready(probe: LoggerProbe): void;
}

function isTestGlobals(value: unknown): value is LoggerTestGlobals {
	return typeof value === "object" && value !== null && typeof Reflect.get(value, "ready") === "function";
}

function logAll(records: ProbeRecord[]): void {
	for (const record of records) logger[record.level](record.message, record.context);
}

const probe: LoggerProbe = {
	log: async (records, scoped) => {
		if (scoped) logger.withContext(scoped, () => logAll(records));
		else logAll(records);
	},
	logError: async message => {
		logger.error("probe failure", { error: new Error(message) });
	},
	flush: async () => {
		logger.flush();
		return true;
	},
};

const port = parentPort;
if (!port) throw new Error("fixture must run in a worker");
installWorkerLogPort(port);

port.once("message", (init: { sync: MessagePort; counter: SharedArrayBuffer }) => {
	setCurrentThreadId("w1");
	const link: WorkerThreadLink = new RpcLink(
		{
			send: frame => port.postMessage(frame),
			listen: handler => {
				const listener = (frame: RpcFrame): void => handler(frame);
				port.on("message", listener);
				return () => port.off("message", listener);
			},
		},
		{ name: "logger-fixture", sync: { port: init.sync, counter: new Int32Array(init.counter) } },
	);
	loggerThreadService.installWorker?.(link);
	// Logged before boot connects the flush: posted at once, ordered before later records.
	logger.info("before boot", { phase: "install" });
	link.handle("ping", nonce => nonce);
	link.handle("boot", async globals => {
		await loggerThreadService.boot?.(globals[loggerThreadService.name], link);
		const test = globals.test;
		if (!isTestGlobals(test)) throw new Error("logger fixture: missing test globals");
		await test.ready(probe);
	});
	port.postMessage({ ready: true });
});
