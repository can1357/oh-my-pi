import { workerHostEntry } from "@oh-my-pi/pi-utils/worker-host";
import { FILE_WRITE_WORKER_ARG } from "../cli/worker-selectors";

export interface FileWriteIoRequest {
	id: number;
	dst: string;
	/** Omit to check for a held file without writing (before routing an editor write). */
	content?: string;
}

export interface FileWriteIoResult {
	id: number;
	error?: { message: string; stack?: string } & NodeJS.ErrnoException;
}

let worker: Worker | undefined;
let nextId = 0;
const pending = new Map<number, PromiseWithResolvers<void>>();

function ensureWorker(): Worker {
	if (worker) return worker;
	const entry = workerHostEntry();
	const thread = entry
		? new Worker(entry, { type: "module", argv: [FILE_WRITE_WORKER_ARG] })
		: new Worker(new URL("./file-write-worker.ts", import.meta.url).href, { type: "module" });
	thread.addEventListener("message", (event: MessageEvent<FileWriteIoResult>) => {
		const { id, error } = event.data;
		const request = pending.get(id);
		if (!request) return;
		pending.delete(id);
		if (pending.size === 0) thread.unref();
		if (error) request.reject(Object.assign(new Error(error.message), error));
		else request.resolve();
	});
	const died = (error: Error) => {
		if (worker !== thread) return;
		worker = undefined;
		for (const request of pending.values()) request.reject(error);
		pending.clear();
	};
	thread.addEventListener("error", (event: ErrorEvent) => {
		event.preventDefault();
		died(event.error instanceof Error ? event.error : new Error(event.message));
	});
	thread.addEventListener("close", () => died(new Error("file write worker exited unexpectedly")));
	worker = thread;
	return thread;
}

async function requestIo(dst: string, content?: string): Promise<void> {
	const thread = ensureWorker();
	if (pending.size === 0) thread.ref();
	const id = nextId++;
	const request = Promise.withResolvers<void>();
	pending.set(id, request);
	thread.postMessage({ id, dst, content } satisfies FileWriteIoRequest);
	return request.promise;
}

/** The check and Bun's small-file write fast path both issue synchronous syscalls. */
export function writeLocalFile(dst: string, content: string): Promise<void> {
	return requestIo(dst, content);
}

export function assertLocalFileNotHeldOpen(dst: string): Promise<void> {
	return requestIo(dst);
}
