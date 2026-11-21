/**
 * The single path of a subagent worker's log records to the main thread.
 *
 * The main thread owns the process log file (`omp.<DATE>.<PID>.log`, shared by
 * every thread) and the out-of-band sinks (`registerLogSink`, e.g. the OTLP
 * exporter). A worker never opens the file: from the first module its entry
 * evaluates ({@link installWorkerLogPort}), the worker's logger posts every
 * record (scoped `withContext` fields merged in) as a raw
 * {@link SubagentWorkerLog} message on `parentPort`. The main side handles those
 * from spawn, before the RPC link exists ({@link receiveWorkerLog}): it tags
 * each record with the worker's `thread` id and writes it with its original
 * timestamp (`logger.emitForeign`). Records and RPC frames share the port, so
 * they arrive in send order; once the logger thread service connects a flush
 * ({@link WorkerLogPort.connectFlush}), `logger.flush()` in the worker blocks
 * until main wrote every record posted before it.
 */
import { logger } from "@oh-my-pi/pi-utils";
import type { ThreadId } from "./identity";

/** Raw message a subagent worker posts on `parentPort` for each log record. */
export interface SubagentWorkerLog {
	readonly type: "subagent-worker-log";
	readonly event: logger.LogEvent;
}

/** Port surface the forwarder posts on (`parentPort`). */
interface LogMessagePort {
	postMessage(message: unknown): void;
}

/** A worker's log forwarder: posts every record on the parent port. */
export class WorkerLogPort implements logger.LogForwarder {
	readonly #port: LogMessagePort;
	#flush: (() => void) | undefined;

	constructor(port: LogMessagePort) {
		this.#port = port;
	}

	/** Post one record; ordered with every earlier record and RPC frame. */
	emit(event: logger.LogEvent): void {
		const message: SubagentWorkerLog = { type: "subagent-worker-log", event };
		this.#port.postMessage(message);
	}

	/** Block until main wrote every record posted so far; a no-op until {@link connectFlush}. */
	flush(): void {
		this.#flush?.();
	}

	/** Install the synchronous main-side flush (a call over the same port, so it follows every posted record). */
	connectFlush(flush: () => void): void {
		this.#flush = flush;
	}
}

let installed: WorkerLogPort | undefined;

/** Worker thread: route every later record of this thread to main through `port`; idempotent. */
export function installWorkerLogPort(port: LogMessagePort): WorkerLogPort {
	if (!installed) {
		installed = new WorkerLogPort(port);
		logger.setLogForwarder(installed);
	}
	return installed;
}

/** The forwarder {@link installWorkerLogPort} installed on this thread, if any. */
export function workerLogPort(): WorkerLogPort | undefined {
	return installed;
}

const LOG_LEVELS: Record<logger.LogLevel, true> = { error: true, warn: true, info: true, debug: true };

function isLogEvent(value: unknown): value is logger.LogEvent {
	if (typeof value !== "object" || value === null) return false;
	const level: unknown = Reflect.get(value, "level");
	const context: unknown = Reflect.get(value, "context");
	return (
		typeof level === "string" &&
		Object.hasOwn(LOG_LEVELS, level) &&
		typeof Reflect.get(value, "message") === "string" &&
		Reflect.get(value, "timestamp") instanceof Date &&
		(context === undefined || (typeof context === "object" && context !== null))
	);
}

/** Whether `value` is a raw {@link SubagentWorkerLog} message. */
export function isSubagentWorkerLog(value: unknown): value is SubagentWorkerLog {
	return (
		typeof value === "object" &&
		value !== null &&
		Reflect.get(value, "type") === "subagent-worker-log" &&
		isLogEvent(Reflect.get(value, "event"))
	);
}

/** Main thread: write a worker's log record to main's transports and sinks, tagged with `thread`. */
export function receiveWorkerLog(thread: ThreadId, message: SubagentWorkerLog): void {
	const { event } = message;
	logger.emitForeign({ ...event, context: { ...event.context, thread } });
}
