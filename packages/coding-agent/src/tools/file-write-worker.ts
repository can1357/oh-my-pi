import { parentPort } from "node:worker_threads";
import { assertNotHeldOpen } from "@oh-my-pi/pi-utils/held-file";
import { consumeWorkerInbox } from "@oh-my-pi/pi-utils/worker-host";
import { type FileWriteIoRequest, type FileWriteIoResult, FileWriteState } from "./file-write-protocol";

if (!parentPort) throw new Error("file write worker: missing parentPort");
const port = parentPort;

async function write({ id, dst, content, state }: FileWriteIoRequest): Promise<void> {
	if (state && Atomics.load(state, 0) === FileWriteState.Cancelled) return;
	let result: FileWriteIoResult;
	try {
		// Same process as the caller: the guard checks the process's SQLite locks.
		assertNotHeldOpen(dst);
		if (content !== undefined) {
			// The guard can itself block in metadata I/O. Claim the mutation only
			// once it finishes, so cancellation still wins during that check.
			if (
				state &&
				Atomics.compareExchange(state, 0, FileWriteState.Queued, FileWriteState.Started) !== FileWriteState.Queued
			) {
				return;
			}
			await Bun.write(dst, content);
		}
		result = { id };
	} catch (cause) {
		const error: NodeJS.ErrnoException = cause instanceof Error ? cause : new Error(String(cause));
		// Structured clone drops system-error fields the permission broker needs.
		result = {
			id,
			error: {
				name: error.name,
				message: error.message,
				stack: error.stack,
				code: error.code,
				errno: error.errno,
				path: error.path,
				syscall: error.syscall,
			},
		};
	}
	port.postMessage(result);
}

const handle = (data: unknown) => void write(data as FileWriteIoRequest);
const inbox = consumeWorkerInbox();
if (inbox) inbox.bind(handle);
else port.on("message", handle);
