import { parentPort } from "node:worker_threads";
import { assertNotHeldOpen } from "@oh-my-pi/pi-utils/held-file";
import { consumeWorkerInbox } from "@oh-my-pi/pi-utils/worker-host";
import type { FileWriteIoRequest, FileWriteIoResult } from "./file-write-io";

if (!parentPort) throw new Error("file write worker: missing parentPort");
const port = parentPort;

async function write({ id, dst, content }: FileWriteIoRequest): Promise<void> {
	let result: FileWriteIoResult;
	try {
		// Same process as the caller: the guard checks the process's SQLite locks.
		assertNotHeldOpen(dst);
		if (content !== undefined) await Bun.write(dst, content);
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
