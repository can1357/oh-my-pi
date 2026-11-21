/**
 * Logger flush bridge between the main thread and subagent workers.
 *
 * Worker log records reach main through one path from the worker's first
 * evaluated module: raw messages on `parentPort` (`../worker-log`), written by
 * main with their original timestamp and the worker's `thread` tag. This
 * service adds the synchronous half: from `boot` on, `logger.flush()` in a
 * worker calls main's {@link MainLogSink.flush} over the link, which shares the
 * port with the records, so it returns once main wrote every record posted
 * before it.
 */
import { logger } from "@oh-my-pi/pi-utils";
import type { WorkerThreadLink } from "../protocol";
import type { RemoteObject, RpcMethod } from "../rpc";
import type { ThreadService } from "../services";
import { workerLogPort } from "../worker-log";

/** Exported-class kind of the main thread's log sink. */
export const LOG_SINK_KIND = "log-sink";

/** Methods of the main thread's log sink. */
export type LogSinkProtocol = {
	/** Write every record received so far (synchronous; backs a worker's `logger.flush()`). */
	flush: RpcMethod<[], void>;
};

/** Boot globals of {@link loggerThreadService}. */
export interface LoggerServiceGlobals {
	/** Main thread's log sink (a {@link RemoteLogSink} on the worker). */
	readonly sink: MainLogSink;
}

/** Main-thread log sink of worker records; crosses to workers by reference. */
export class MainLogSink {
	/** Write main's buffered records now. */
	flush(): void {
		logger.flush();
	}
}

const mainLogSink = new MainLogSink();

/** Worker-side proxy of the main thread's {@link MainLogSink}. */
export class RemoteLogSink {
	readonly #remote: RemoteObject<LogSinkProtocol>;

	constructor(remote: RemoteObject<LogSinkProtocol>) {
		this.#remote = remote;
	}

	/** Block until main wrote every record posted before this call. */
	flush(): void {
		this.#remote.callSync("flush");
	}
}

function isLoggerGlobals(value: unknown): value is { sink: unknown } {
	return typeof value === "object" && value !== null && "sink" in value;
}

/** Makes a worker's `logger.flush()` wait for main to write its records. */
export const loggerThreadService: ThreadService = {
	name: "logger",

	installMain(peer): void {
		peer.link.exportClass<MainLogSink, LogSinkProtocol>(
			LOG_SINK_KIND,
			(value): value is MainLogSink => value instanceof MainLogSink,
			{ flush: sink => sink.flush() },
		);
	},

	globals(): LoggerServiceGlobals {
		return { sink: mainLogSink };
	},

	installWorker(link: WorkerThreadLink): void {
		link.importClass<RemoteLogSink, LogSinkProtocol>(LOG_SINK_KIND, remote => new RemoteLogSink(remote));
	},

	boot(globals: unknown): void {
		const port = workerLogPort();
		if (!port) throw new Error("logger service: this worker's log port is not installed");
		if (!isLoggerGlobals(globals) || !(globals.sink instanceof RemoteLogSink)) {
			throw new Error("logger service: boot globals lack the main thread's log sink");
		}
		const sink = globals.sink;
		port.connectFlush(() => sink.flush());
	},
};
