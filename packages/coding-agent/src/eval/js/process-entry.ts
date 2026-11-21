import { type RejectionInterceptor, WorkerCore } from "./worker-core";
import type { WorkerInbound, WorkerOutbound } from "./worker-protocol";

/**
 * Start the JavaScript evaluator inside a subprocess transport: Bun IPC for the
 * `__omp_worker_js_eval_process` selector, stdio frames for the sandbox-contained
 * `__omp_worker_js_eval_stdio` selector.
 */
export function startJsEvalProcess(
	transport: {
		send(message: WorkerOutbound): void;
		onMessage(handler: (message: WorkerInbound) => void): () => void;
	},
	interceptUnhandledRejections: RejectionInterceptor,
): void {
	new WorkerCore(
		{
			send: message => transport.send(message),
			onMessage: handler => transport.onMessage(handler),
			// The parent owns process lifetime and kills the subprocess after the
			// WorkerCore `closed` acknowledgement has crossed the transport.
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
