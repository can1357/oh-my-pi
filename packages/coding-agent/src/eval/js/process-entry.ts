import * as fs from "node:fs";
import * as path from "node:path";
import { type RejectionInterceptor, WorkerCore } from "./worker-core";
import {
	JS_EVAL_OUTBOX_ENV,
	type ProcessWorkerOutbound,
	type WorkerInbound,
	type WorkerOutbound,
} from "./worker-protocol";

/** Start the JavaScript evaluator inside a subprocess IPC transport. */
export function startJsEvalProcess(
	transport: {
		send(message: ProcessWorkerOutbound): void;
		onMessage(handler: (message: WorkerInbound) => void): () => void;
	},
	interceptUnhandledRejections: RejectionInterceptor,
): void {
	const outbox = process.env[JS_EVAL_OUTBOX_ENV];
	if (!outbox) throw new Error("JS eval process output directory is missing");
	delete process.env[JS_EVAL_OUTBOX_ENV];
	let sequence = 0;
	new WorkerCore(
		{
			send: (message: WorkerOutbound) => {
				if (message.type !== "text" && message.type !== "display") {
					transport.send(message);
					return;
				}
				// A killed process can lose its pending process.send queue. Publish
				// complete output synchronously, then use IPC only as a notification.
				const id = ++sequence;
				const filename = path.join(outbox, `${id}.json`);
				const pending = `${filename}.tmp`;
				fs.writeFileSync(pending, JSON.stringify(message));
				fs.renameSync(pending, filename);
				transport.send({ type: "output-ready", sequence: id });
			},
			onMessage: handler => transport.onMessage(handler),
			// The parent owns process lifetime and kills the subprocess after the
			// WorkerCore `closed` acknowledgement has crossed IPC.
			close: () => {},
		},
		{
			mode: "isolated",
			// The subprocess inherits the agent's cwd (or the package root under
			// the `bun test` fallback of `resolveWorkerSpawnCmd`); mirror the
			// session cwd so cell code using relative paths or spawning children
			// resolves against the session's project. Worker threads cannot pass
			// this — `process.chdir` is unavailable there.
			chdir: cwd => process.chdir(cwd),
			interceptUnhandledRejections,
		},
	);
}
