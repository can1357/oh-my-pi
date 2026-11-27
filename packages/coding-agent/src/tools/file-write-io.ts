import { untilAborted } from "@oh-my-pi/pi-utils/abortable";
import { TempDir } from "@oh-my-pi/pi-utils/temp";
import { workerHostEntry } from "@oh-my-pi/pi-utils/worker-host";
import { FILE_WRITE_WORKER_ARG } from "../cli/worker-selectors";
import { type FileWriteIoRequest, type FileWriteIoResult, FileWriteState } from "./file-write-protocol";

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
		if (error) request.reject(Object.assign(new Error(error.message), error));
		else request.resolve();
	});
	const died = (error: Error) => {
		if (worker !== thread) return;
		worker = undefined;
		for (const request of pending.values()) request.reject(error);
		pending.clear();
		thread.unref();
	};
	thread.addEventListener("error", (event: ErrorEvent) => {
		event.preventDefault();
		died(event.error instanceof Error ? event.error : new Error(event.message));
	});
	thread.addEventListener("close", () => died(new Error("file write worker exited unexpectedly")));
	worker = thread;
	return thread;
}

async function requestIo(dst: string, content?: string, signal?: AbortSignal): Promise<void> {
	signal?.throwIfAborted();
	const thread = ensureWorker();
	if (pending.size === 0) thread.ref();
	const id = nextId++;
	const request = Promise.withResolvers<void>();
	pending.set(id, request);
	const state = signal ? new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)) : undefined;
	const onAbort = () => {
		// A started syscall cannot be revoked. Only reject here when the worker
		// has not claimed the mutation; otherwise its result still owns settlement.
		if (
			state &&
			Atomics.compareExchange(state, 0, FileWriteState.Queued, FileWriteState.Cancelled) === FileWriteState.Queued
		) {
			request.reject(signal?.reason);
		}
	};
	signal?.addEventListener("abort", onAbort, { once: true });
	try {
		thread.postMessage({ id, dst, content, state } satisfies FileWriteIoRequest);
		await request.promise;
	} finally {
		signal?.removeEventListener("abort", onAbort);
		if (pending.delete(id) && pending.size === 0 && worker === thread) thread.unref();
	}
}

/** The check and Bun's small-file write fast path both issue synchronous syscalls. */
export function writeLocalFile(dst: string, content: string, signal?: AbortSignal): Promise<void> {
	return requestIo(dst, content, signal);
}

export function assertLocalFileNotHeldOpen(dst: string, signal?: AbortSignal): Promise<void> {
	return requestIo(dst, undefined, signal);
}

/** Installed CLI probe: start the bundled worker and verify its output on disk. */
export async function smokeTestFileWriteWorker(): Promise<void> {
	const deadline = AbortSignal.timeout(10_000);
	await untilAborted(deadline, async () => {
		await using dir = await TempDir.create("@omp-file-write-smoke-");
		const dst = dir.join("probe.txt");
		const expected = "omp file write worker smoke\n";
		await writeLocalFile(dst, expected, deadline);
		if ((await Bun.file(dst).text()) !== expected) {
			throw new Error("file write worker smoke: unexpected file contents");
		}
	});
}
